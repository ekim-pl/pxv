//! Linux ownership gateway. Specifications use private IPC; durable files retain only ownership evidence.
#![cfg(target_os = "linux")]
mod command;
mod error;
mod lease;
mod process;
mod protocol;
mod storage;
use crate::{
    command::{run_command, CommandSpec},
    error::failure,
    lease::Lease,
    process::terminate_descendants,
    protocol::{receive, send, Message, IPC_FD},
};
use serde_json::json;
use std::{
    fs::File,
    io::{self, BufReader},
    os::fd::FromRawFd,
    path::Path,
};
fn execute() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if informational(&args) {
        return Ok(());
    }
    let root = control_root(&args)?;
    prepare_kernel()?;
    let mut ipc = unsafe { File::from_raw_fd(IPC_FD) };
    let mut reader = BufReader::new(ipc.try_clone()?);
    let mut lease = acquire(root, &mut reader)?;
    if let Err(error) = announce_ready(&lease, &mut ipc) {
        return fail_operation(&mut lease, &mut ipc, error);
    }
    match serve(&mut lease, &mut reader, &mut ipc) {
        Ok(()) => Ok(()),
        Err(error) => fail_operation(&mut lease, &mut ipc, error),
    }
}
fn informational(args: &[String]) -> bool {
    if args.len() != 2 {
        return false;
    }
    match args[1].as_str() {
        "--version" => println!("pxv-supervisor 0.1.0"),
        "--build-info" => println!(
            "{}",
            json!({"target":if cfg!(all(target_arch="x86_64",target_env="musl")){"x86_64-unknown-linux-musl"}else{"unsupported"},"static":cfg!(target_feature="crt-static"),"protocol":1})
        ),
        _ => return false,
    }
    true
}
fn control_root(args: &[String]) -> io::Result<&Path> {
    if args.len() != 3 || args[1] != "--control-root" {
        return Err(failure(
            "Usage: pxv-supervisor --control-root PATH (private IPC on fd 3)",
        ));
    }
    Ok(Path::new(&args[2]))
}
fn prepare_kernel() -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(failure("Linux child-subreaper unavailable"));
    }
    let mut enabled: libc::c_int = 0;
    if unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut enabled, 0, 0, 0) } != 0
        || enabled != 1
    {
        return Err(failure("Linux child-subreaper could not be verified"));
    }
    let own = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as i32;
    if own < 0 {
        return Err(failure("Linux pidfds unavailable"));
    }
    unsafe {
        libc::close(own);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    Ok(())
}
fn acquire(root: &Path, reader: &mut BufReader<File>) -> io::Result<Lease> {
    match receive(reader)? {
        Some(Message::Acquire {
            device_key,
            transport_key,
            operation_id,
        }) => Lease::acquire(root, device_key, transport_key, operation_id, None),
        Some(Message::AcquireRecovery {
            device_key,
            transport_key,
            operation_id,
            previous_operation_id,
        }) => Lease::acquire(
            root,
            device_key,
            transport_key,
            operation_id,
            Some(previous_operation_id),
        ),
        _ => Err(failure("Lease acquisition required")),
    }
}
fn announce_ready(lease: &Lease, ipc: &mut File) -> io::Result<()> {
    send(ipc, &json!({"type":"ready","supervisor":lease.supervisor}))
}
fn serve(lease: &mut Lease, reader: &mut BufReader<File>, ipc: &mut File) -> io::Result<()> {
    loop {
        match receive(reader)? {
            Some(Message::Run {
                id,
                args,
                env,
                cwd,
                input,
                input_file,
                timeout_ms,
                expected_exit_codes,
            }) => run_command(
                lease,
                reader,
                ipc,
                CommandSpec {
                    id,
                    args,
                    env,
                    cwd,
                    input,
                    input_file,
                    timeout_ms,
                    expected_exit_codes,
                },
            )?,
            Some(Message::Finish { success }) => return finish_operation(lease, ipc, success),
            None => return Err(failure("Owner disconnected")),
            _ => return Err(failure("Unexpected ownership message")),
        }
    }
}
fn finish_operation(lease: &mut Lease, ipc: &mut File, success: bool) -> io::Result<()> {
    let clean = terminate_descendants(None);
    let complete = lease.finish(success, clean)?;
    send(
        ipc,
        &json!({"type":"finished","success":complete,"cleanup_proven":clean}),
    )
}
fn fail_operation(lease: &mut Lease, ipc: &mut File, error: io::Error) -> io::Result<()> {
    let clean = terminate_descendants(None);
    let _ = lease.finish(false, clean);
    let _ = send(ipc, &json!({"type":"error","message":error.to_string()}));
    Err(error)
}
fn main() {
    if let Err(error) = execute() {
        eprintln!("pxv-supervisor: {error}");
        std::process::exit(125);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        lease::{digest, safe_id},
        process::{children, identity, owned_descendant, parse_children, signal_pid},
        protocol::{default_exit_codes, valid_exit_codes},
    };
    #[test]
    fn rejects_path_injection() {
        assert!(!safe_id("../x"));
        assert!(!digest("../../file"));
        assert!(safe_id("run-123"));
        assert!(digest(&"a".repeat(64)));
    }
    #[test]
    fn binds_live_process_identity() {
        let first = identity(std::process::id() as i32).unwrap();
        assert_eq!(first, identity(first.pid).unwrap());
        assert!(!first.boot_id.is_empty());
        assert!(!first.start_ticks.is_empty());
    }
    #[test]
    fn rejects_unknown_protocol_fields() {
        assert!(serde_json::from_value::<Message>(
            json!({"type":"finish", "success":true,"env":"secret"})
        )
        .is_err());
        assert!(serde_json::from_value::<Message>(json!({
            "type":"recover", "device_key":"a".repeat(64), "transport_key":"b".repeat(64),
            "operation_id":"old-run", "device_recovery_acknowledged":true
        }))
        .is_err());
    }
    #[test]
    fn child_enumeration_fails_closed() {
        assert_eq!(parse_children("12 34\n").unwrap(), vec![12, 34]);
        assert_eq!(parse_children("").unwrap(), Vec::<i32>::new());
        for invalid in ["12 invalid 34", "0", "-1", "2147483648"] {
            assert!(parse_children(invalid).is_err());
        }
        assert!(children(-1).is_err());
    }
    #[test]
    fn never_signals_supervisor_or_unrelated_ancestors() {
        assert!(!owned_descendant(std::process::id() as i32).unwrap());
        assert!(!owned_descendant(unsafe { libc::getppid() }).unwrap());
        assert!(!owned_descendant(-1).unwrap());
        signal_pid(std::process::id() as i32, libc::SIGKILL).unwrap();
    }
    #[test]
    fn validates_expected_normal_exit_codes() {
        assert!(valid_exit_codes(&default_exit_codes()));
        assert!(valid_exit_codes(&[0, 255]));
        for invalid in [
            vec![],
            vec![0, 0],
            vec![-1],
            vec![256],
            vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
        ] {
            assert!(!valid_exit_codes(&invalid));
        }
    }
}
