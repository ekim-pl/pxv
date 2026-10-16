//! Linux ownership gateway. Command specifications only travel over a private
//! inherited Unix socket. Durable files contain identities and receipts only.
#![cfg(target_os = "linux")]
use serde::{Deserialize, Serialize};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const IPC_FD: RawFd = 3;
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
const MAX_OUTPUT: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
struct Identity { pid: i32, start_ticks: String, boot_id: String, uid: u32 }

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Acquire { device_key: String, transport_key: String, operation_id: String },
    AcquireRecovery { device_key: String, transport_key: String, operation_id: String, previous_operation_id: String },
    Recover { device_key: String, transport_key: String, operation_id: String, device_recovery_acknowledged: bool },
    Run { id: String, args: Vec<String>, env: BTreeMap<String, String>, cwd: Option<String>, input: Option<String>, input_file: Option<String>, timeout_ms: u64, #[serde(default="default_exit_codes")] expected_exit_codes: Vec<i32> },
    Authorize { id: String },
    Cancel { id: String },
    Finish { success: bool },
}

fn failure(message: impl ToString) -> io::Error { io::Error::other(message.to_string()) }
fn default_exit_codes() -> Vec<i32> { vec![0] }
fn valid_exit_codes(codes: &[i32]) -> bool { !codes.is_empty() && codes.len()<=8 && codes.iter().enumerate().all(|(index,code)| (0..=255).contains(code) && !codes[..index].contains(code)) }

fn identity(pid: i32) -> io::Result<Identity> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let (_, rest) = stat.rsplit_once(") ").ok_or_else(|| failure("Invalid process identity"))?;
    let start_ticks = rest.split_whitespace().nth(19).ok_or_else(|| failure("Missing process start time"))?.to_owned();
    let uid = fs::metadata(format!("/proc/{pid}"))?.uid();
    Ok(Identity { pid, start_ticks, uid, boot_id: fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_owned() })
}

fn private_directory(path: &Path) -> io::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::getuid() } {
            return Err(failure("Control path must be an operator-owned real directory"));
        }
        if metadata.mode() & 0o077 != 0 { return Err(failure("Control directory must have private permissions (0700)")); }
        return Ok(());
    }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    fs::create_dir(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn durable(path: &Path, value: &Value) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| failure("No receipt parent"))?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(failure)?.as_nanos();
    let temporary = parent.join(format!(".{}-{nonce}.tmp", std::process::id()));
    let mut file = OpenOptions::new().create_new(true).write(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&temporary)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn send(ipc: &mut File, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *ipc, value)?;
    ipc.write_all(b"\n")?;
    ipc.flush()
}

fn receive(reader: &mut BufReader<File>) -> io::Result<Option<Message>> {
    let mut bytes = Vec::new();
    let read = reader.take((MAX_MESSAGE + 1) as u64).read_until(b'\n', &mut bytes)?;
    if read == 0 { return Ok(None); }
    if bytes.len() > MAX_MESSAGE || bytes.last() != Some(&b'\n') { return Err(failure("IPC message exceeds limit or is incomplete")); }
    serde_json::from_slice(&bytes).map(Some).map_err(failure)
}

fn poll_owner(reader: &BufReader<File>) -> io::Result<bool> {
    if !reader.buffer().is_empty() { return Ok(true); }
    let mut item = libc::pollfd { fd: reader.get_ref().as_raw_fd(), events: libc::POLLIN | libc::POLLHUP | libc::POLLERR, revents: 0 };
    let result = unsafe { libc::poll(&mut item, 1, 0) };
    if result < 0 { return Err(io::Error::last_os_error()); }
    Ok(result > 0)
}

fn safe_id(value: &str) -> bool { !value.is_empty() && value.len() <= 160 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') }
fn digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()) }

struct Lease {
    _locks: Vec<File>, reservations: Vec<PathBuf>, root: PathBuf,
    operation_id: String, device_key: String, transport_key: String,
    supervisor: Identity, uncertain: bool, mutated: bool, previous_operation_id: Option<String>,
}

impl Lease {
    fn acquire(root: &Path, device_key: String, transport_key: String, operation_id: String, previous_operation_id: Option<String>) -> io::Result<Self> {
        if !digest(&device_key) || !digest(&transport_key) || !safe_id(&operation_id) { return Err(failure("Invalid lease identity")); }
        if previous_operation_id.as_ref().is_some_and(|value| !safe_id(value) || value == &operation_id) { return Err(failure("Invalid prior recovery operation identity")); }
        private_directory(root)?;
        for child in ["locks", "reservations", "receipts"] { private_directory(&root.join(child))?; }
        let mut keys = vec![format!("device-{device_key}"), format!("transport-{transport_key}")];
        keys.sort();
        let mut locks = Vec::new();
        let mut reservations = Vec::new();
        for key in &keys {
            let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(root.join("locks").join(format!("{key}.lock")))?;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(failure("Physical device or transport is busy")); }
            let reservation = root.join("reservations").join(format!("{key}.json"));
            if previous_operation_id.is_none() && fs::symlink_metadata(&reservation).is_ok() { return Err(failure("Device has unresolved recovery reservation")); }
            locks.push(file);
            reservations.push(reservation);
        }
        let previous = if let Some(ref prior) = previous_operation_id { Some(verify_recovery_records(&reservations, &device_key, &transport_key, prior)?) } else { None };
        let supervisor = identity(std::process::id() as i32)?;
        let mut lease = Self { _locks: locks, reservations, root: root.to_path_buf(), operation_id, device_key, transport_key, supervisor, uncertain: false, mutated: false, previous_operation_id };
        if let Some(record) = previous { durable(&lease.receipt_path("previous-reservation"), &record)?; }
        lease.reserve()?;
        Ok(lease)
    }

    fn record(&self, status: &str) -> Value { json!({ "schema":1, "operation_id":self.operation_id, "previous_operation_id":self.previous_operation_id, "device_key":self.device_key, "transport_key":self.transport_key, "supervisor":self.supervisor, "status":status }) }
    fn reserve(&mut self) -> io::Result<()> {
        for path in &self.reservations { durable(path, &self.record("reserved"))?; }
        Ok(())
    }
    fn receipt_path(&self, id: &str) -> PathBuf { self.root.join("receipts").join(format!("{}-{id}.json", self.operation_id)) }

    fn finish(&mut self, requested_success: bool, cleanup_proven: bool) -> io::Result<bool> {
        let success = requested_success && !self.uncertain && cleanup_proven;
        let mut record = self.record(if success { "completed" } else { "recovery_required" });
        record["cleanup_proven"] = json!(cleanup_proven);
        record["mutation_started"] = json!(self.mutated);
        durable(&self.receipt_path("operation"), &record)?;
        if success || (!self.mutated && self.previous_operation_id.is_none() && cleanup_proven) {
            for path in &self.reservations { fs::remove_file(path)?; }
            File::open(self.root.join("reservations"))?.sync_all()?;
        } else {
            for path in &self.reservations { durable(path, &record)?; }
        }
        Ok(success)
    }
}

fn verify_recovery_records(paths: &[PathBuf], device_key: &str, transport_key: &str, operation_id: &str) -> io::Result<Value> {
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_owned();
    let mut evidence = None;
    for path in paths {
        let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)?;
        if file.metadata()?.len() > 64 * 1024 { return Err(failure("Malformed recovery evidence retained")); }
        let record: Value = serde_json::from_reader(file.take(64 * 1024 + 1)).map_err(|_| failure("Malformed recovery evidence retained"))?;
        if record["schema"] != 1 || record["operation_id"] != operation_id || record["device_key"] != device_key || record["transport_key"] != transport_key { return Err(failure("Matching recovery reservation is unavailable")); }
        let previous: Identity = serde_json::from_value(record["supervisor"].clone()).map_err(|_| failure("Malformed recovery owner retained"))?;
        if boot == previous.boot_id {
            if identity(previous.pid).ok().as_ref() == Some(&previous) { return Err(failure("Native owner is still alive")); }
            if record["cleanup_proven"] != true { return Err(failure("Process cleanup is unproven; reboot the host before releasing this reservation")); }
        }
        if let Some(ref first) = evidence { if first != &record { return Err(failure("Conflicting recovery evidence retained")); } }
        evidence = Some(record);
    }
    evidence.ok_or_else(|| failure("Recovery evidence unavailable"))
}

fn recover(root: &Path, device_key: String, transport_key: String, operation_id: String, acknowledged: bool) -> io::Result<()> {
    if !acknowledged || !digest(&device_key) || !digest(&transport_key) || !safe_id(&operation_id) { return Err(failure("Explicit recovery acknowledgment and valid identities required")); }
    private_directory(root)?;
    for child in ["locks", "reservations", "receipts"] { private_directory(&root.join(child))?; }
    let mut keys = vec![format!("device-{device_key}"), format!("transport-{transport_key}")]; keys.sort();
    let mut locks = Vec::new();
    let mut paths = Vec::new();
    for key in keys {
        let file = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(root.join("locks").join(format!("{key}.lock")))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(failure("Native owner is still alive or recovery is busy")); }
        locks.push(file); paths.push(root.join("reservations").join(format!("{key}.json")));
    }
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_owned();
    let mut record = verify_recovery_records(&paths, &device_key, &transport_key, &operation_id)?;
    record["status"] = json!("recovered"); record["device_recovery_acknowledged"] = json!(true); record["resolution_boot_id"] = json!(boot);
    durable(&root.join("receipts").join(format!("{operation_id}-recovered.json")), &record)?;
    for path in paths { fs::remove_file(path)?; }
    File::open(root.join("reservations"))?.sync_all()?;
    Ok(())
}

fn parse_children(value: &str) -> io::Result<Vec<i32>> {
    value.split_whitespace().map(|value| {
        let pid = value.parse::<i32>().map_err(|_| failure("Malformed native child enumeration"))?;
        if pid <= 0 { return Err(failure("Invalid native child identity")); }
        Ok(pid)
    }).collect()
}

fn children(pid: i32) -> io::Result<Vec<i32>> {
    parse_children(&fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))?)
}

fn descendant_pids(pid: i32, result: &mut Vec<i32>) -> io::Result<()> {
    for child in children(pid)? {
        // A descendant can exit during traversal. Other enumeration failures
        // cannot establish an empty process tree and must preserve the fence.
        if let Err(error) = descendant_pids(child, result) {
            if error.kind() != io::ErrorKind::NotFound { return Err(error); }
        }
        result.push(child);
    }
    Ok(())
}

fn owned_descendant(mut pid: i32) -> io::Result<bool> {
    let supervisor = std::process::id() as i32;
    if pid == supervisor { return Ok(false); }
    for _ in 0..4096 {
        let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let (_, rest) = stat.rsplit_once(") ").ok_or_else(|| failure("Invalid descendant identity"))?;
        let parent = rest.split_whitespace().nth(1).ok_or_else(|| failure("Missing descendant parent"))?.parse::<i32>().map_err(|_| failure("Malformed descendant parent"))?;
        if parent == supervisor { return Ok(true); }
        if parent <= 1 { return Ok(false); }
        pid = parent;
    }
    Err(failure("Descendant ancestry exceeds safety bound"))
}

fn signal_pid(pid: i32, signal: i32) -> io::Result<()> {
    let before = match identity(pid) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    if fd < 0 {
        if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { return Ok(()); }
        return Err(failure("pidfd_open unavailable; cleanup cannot be proven"));
    }
    // Enumeration and pidfd_open are separate syscalls. Refuse a recycled PID
    // or a process outside our current descendant tree before signaling it.
    let owned = (|| -> io::Result<bool> {
        match identity(pid) {
            Ok(after) if after == before => owned_descendant(pid),
            Ok(_) => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    })();
    if !matches!(owned, Ok(true)) {
        unsafe { libc::close(fd); }
        return owned.map(|_| ());
    }
    let outcome = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd, signal, std::ptr::null::<libc::siginfo_t>(), 0) };
    let error = io::Error::last_os_error();
    unsafe { libc::close(fd); }
    if outcome < 0 && error.raw_os_error() != Some(libc::ESRCH) { return Err(error); }
    Ok(())
}

fn reap_adopted(exclude: Option<i32>) -> io::Result<()> {
    for pid in children(std::process::id() as i32)? {
        if Some(pid) != exclude { unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG); } }
    }
    Ok(())
}

fn terminate_descendants(child: Option<&mut Child>) -> bool {
    let mut child = child;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut proven = true;
    while Instant::now() < deadline {
        let mut pids = Vec::new();
        if descendant_pids(std::process::id() as i32, &mut pids).is_err() { return false; }
        if pids.is_empty() { return proven; }
        for pid in &pids {
            // pidfds bind the kill to this process identity, including detached
            // double-fork descendants adopted through PR_SET_CHILD_SUBREAPER.
            if signal_pid(*pid, libc::SIGKILL).is_err() { proven = false; }
        }
        if let Some(process) = child.as_mut() { let _ = process.try_wait(); }
        if reap_adopted(child.as_ref().map(|process| process.id() as i32)).is_err() { return false; }
        thread::sleep(Duration::from_millis(5));
    }
    false
}

fn capture(mut stream: impl Read + Send + 'static) -> JoinHandle<io::Result<String>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut block = [0; 16 * 1024];
        let mut overflow = false;
        loop {
            let length = stream.read(&mut block)?;
            if length == 0 { break; }
            if output.len() + length <= MAX_OUTPUT { output.extend_from_slice(&block[..length]); } else { overflow = true; }
        }
        if overflow { return Err(failure("Command output exceeded capture limit")); }
        Ok(String::from_utf8_lossy(&output).into_owned())
    })
}

#[allow(clippy::too_many_arguments)]
fn run_command(lease: &mut Lease, reader: &mut BufReader<File>, ipc: &mut File, id: String, args: Vec<String>, env: BTreeMap<String,String>, cwd: Option<String>, input: Option<String>, input_file: Option<String>, timeout_ms: u64, expected_exit_codes: Vec<i32>) -> io::Result<()> {
    if !valid_exit_codes(&expected_exit_codes) { return Err(failure("Invalid expected exit codes")); }
    if !safe_id(&id) || args.is_empty() || args.iter().any(|arg| arg.contains('\0')) || timeout_ms == 0 || timeout_ms > 86_400_000 || env.iter().any(|(key,value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0')) { return Err(failure("Invalid native command specification")); }
    if fs::symlink_metadata(lease.receipt_path(&id)).is_ok() { return Err(failure("Native command ID was already used; refusing replay")); }
    if input.is_some() && input_file.is_some() { return Err(failure("input and input_file are mutually exclusive")); }
    let source = if let Some(path) = input_file {
        let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
        if !file.metadata()?.is_file() { return Err(failure("Command input must be a regular file")); }
        Some(file)
    } else { None };
    let input = input.map(|value| base64::engine::general_purpose::STANDARD.decode(value).map_err(|_| failure("Invalid input encoding"))).transpose()?;
    let intent = json!({ "schema":1, "operation_id":lease.operation_id, "command_id":id, "supervisor":lease.supervisor, "status":"gated", "expected_exit_codes":expected_exit_codes });
    durable(&lease.receipt_path(&id), &intent)?;
    send(ipc, &json!({"type":"gated", "id":id}))?;
    match receive(reader)? {
        Some(Message::Authorize { id: authorized }) if authorized == id => {},
        _ => return Err(failure("Owner did not authorize native execution")),
    }
    lease.mutated = true;
    let mut started = intent.clone(); started["status"] = json!("authorized");
    durable(&lease.receipt_path(&id), &started)?;
    let mut command = Command::new(&args[0]);
    command.args(&args[1..]).env_clear().envs(env).stdin(source.map(Stdio::from).unwrap_or_else(Stdio::piped)).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(directory) = cwd { command.current_dir(directory); }
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 { return Err(io::Error::last_os_error()); }
            // The private control socket must never leak into the native tool.
            libc::close(IPC_FD);
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let child_identity = identity(child.id() as i32)?;
    started["child"] = json!(child_identity); started["status"] = json!("running");
    if let Err(error) = durable(&lease.receipt_path(&id), &started) { terminate_descendants(Some(&mut child)); return Err(error); }
    let stdout = capture(child.stdout.take().ok_or_else(|| failure("Missing stdout"))?);
    let stderr = capture(child.stderr.take().ok_or_else(|| failure("Missing stderr"))?);
    if let Some(mut stdin) = child.stdin.take() {
        let input = input.unwrap_or_default();
        thread::spawn(move || { let _ = stdin.write_all(&input); });
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut status: Option<ExitStatus> = None;
    let mut interrupted = false;
    let mut owner_lost = false;
    let mut cleanup_proven = true;
    loop {
        if status.is_none() { status = child.try_wait()?; }
        reap_adopted(if status.is_none() { Some(child.id() as i32) } else { None })?;
        if status.is_some() && children(std::process::id() as i32)?.is_empty() { break; }
        if Instant::now() >= deadline {
            interrupted = true;
            cleanup_proven = terminate_descendants(Some(&mut child));
            break;
        }
        if poll_owner(reader)? {
            match receive(reader) {
                Ok(Some(Message::Cancel { id: cancelled })) if cancelled == id => { interrupted = true; },
                Ok(None) | Err(_) => { interrupted = true; owner_lost = true; },
                _ => { interrupted = true; owner_lost = true; },
            }
            if interrupted { cleanup_proven = terminate_descendants(Some(&mut child)); break; }
        }
        thread::sleep(Duration::from_millis(5));
    }
    if status.is_none() { status = child.try_wait()?; }
    let output = if cleanup_proven { stdout.join().map_err(|_| failure("stdout worker failed"))? } else { Err(failure("Process cleanup is unproven")) };
    let errors = if cleanup_proven { stderr.join().map_err(|_| failure("stderr worker failed"))? } else { Err(failure("Process cleanup is unproven")) };
    if output.is_err() || errors.is_err() { interrupted = true; }
    let normal_exit = status.is_some_and(|value| value.code().is_some());
    let code = if interrupted { 124 } else { status.and_then(|value| value.code()).unwrap_or(128) };
    if interrupted || !normal_exit || !expected_exit_codes.contains(&code) || !cleanup_proven { lease.uncertain = true; }
    let mut receipt = started;
    receipt["status"] = json!("completed"); receipt["code"] = json!(code);
    receipt["cleanup_proven"] = json!(cleanup_proven); receipt["interrupted"] = json!(interrupted);
    durable(&lease.receipt_path(&id), &receipt)?;
    if owner_lost { return Err(failure("Owner disconnected; device remains fenced")); }
    send(ipc, &json!({ "type":"result", "id":id, "code":code, "stdout":output.unwrap_or_default(), "stderr":errors.unwrap_or_default(), "cleanup_proven":cleanup_proven, "interrupted":interrupted }))
}

fn execute() -> io::Result<()> {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() == 2 && arguments[1] == "--version" { println!("pxv-supervisor 0.1.0"); return Ok(()); }
    if arguments.len() == 2 && arguments[1] == "--build-info" {
        println!("{}", json!({"target": if cfg!(all(target_arch="x86_64",target_env="musl")) { "x86_64-unknown-linux-musl" } else { "unsupported" }, "static":cfg!(target_feature="crt-static"),"protocol":1}));
        return Ok(());
    }
    if arguments.len() != 3 || arguments[1] != "--control-root" { return Err(failure("Usage: pxv-supervisor --control-root PATH (private IPC on fd 3)")); }
    // Fail closed before any gate can open on unsupported kernel facilities.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 { return Err(failure("Linux child-subreaper unavailable")); }
    let mut enabled: libc::c_int = 0;
    if unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut enabled, 0, 0, 0) } != 0 || enabled != 1 { return Err(failure("Linux child-subreaper could not be verified")); }
    let own = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as i32;
    if own < 0 { return Err(failure("Linux pidfds unavailable")); }
    unsafe { libc::close(own); libc::signal(libc::SIGPIPE, libc::SIG_IGN); }
    let mut ipc = unsafe { File::from_raw_fd(IPC_FD) };
    let mut reader = BufReader::new(ipc.try_clone()?);
    let mut lease = match receive(&mut reader)? {
        Some(Message::Acquire { device_key, transport_key, operation_id }) => Lease::acquire(Path::new(&arguments[2]), device_key, transport_key, operation_id, None)?,
        Some(Message::AcquireRecovery { device_key, transport_key, operation_id, previous_operation_id }) => Lease::acquire(Path::new(&arguments[2]), device_key, transport_key, operation_id, Some(previous_operation_id))?,
        Some(Message::Recover { device_key, transport_key, operation_id, device_recovery_acknowledged }) => {
            recover(Path::new(&arguments[2]), device_key, transport_key, operation_id, device_recovery_acknowledged)?;
            send(&mut ipc, &json!({"type":"recovered"}))?;
            return Ok(());
        }
        _ => return Err(failure("Lease acquisition required")),
    };
    if let Err(error) = send(&mut ipc, &json!({ "type":"ready", "supervisor":lease.supervisor })) {
        let clean = terminate_descendants(None); let _ = lease.finish(false, clean); return Err(error);
    }
    loop {
        let outcome = match receive(&mut reader) {
            Ok(Some(Message::Run { id, args, env, cwd, input, input_file, timeout_ms, expected_exit_codes })) => run_command(&mut lease, &mut reader, &mut ipc, id, args, env, cwd, input, input_file, timeout_ms, expected_exit_codes),
            Ok(Some(Message::Finish { success })) => {
                let clean = terminate_descendants(None);
                let complete = lease.finish(success, clean)?;
                send(&mut ipc, &json!({"type":"finished", "success":complete, "cleanup_proven":clean}))?;
                return Ok(());
            }
            Ok(None) => Err(failure("Owner disconnected")),
            Ok(_) => Err(failure("Unexpected ownership message")),
            Err(error) => Err(error),
        };
        if let Err(error) = outcome {
            let clean = terminate_descendants(None);
            let _ = lease.finish(false, clean);
            let _ = send(&mut ipc, &json!({"type":"error", "message":error.to_string()}));
            return Err(error);
        }
    }
}

fn main() {
    if let Err(error) = execute() {
        // All error messages are fixed or OS diagnostics; never print IPC data.
        eprintln!("pxv-supervisor: {error}");
        std::process::exit(125);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_path_injection() { assert!(!safe_id("../x")); assert!(!digest("../../file")); assert!(safe_id("run-123")); assert!(digest(&"a".repeat(64))); }
    #[test] fn binds_live_process_identity() { let first = identity(std::process::id() as i32).unwrap(); assert_eq!(first, identity(first.pid).unwrap()); assert!(!first.boot_id.is_empty()); assert!(!first.start_ticks.is_empty()); }
    #[test] fn rejects_unknown_protocol_fields() { assert!(serde_json::from_value::<Message>(json!({"type":"finish", "success":true,"env":"secret"})).is_err()); }
    #[test] fn child_enumeration_fails_closed() {
        assert_eq!(parse_children("12 34\n").unwrap(), vec![12,34]);
        assert_eq!(parse_children("").unwrap(), Vec::<i32>::new());
        for invalid in ["12 invalid 34", "0", "-1", "2147483648"] { assert!(parse_children(invalid).is_err()); }
        assert!(children(-1).is_err());
    }
    #[test] fn never_signals_supervisor_or_unrelated_ancestors() {
        assert!(!owned_descendant(std::process::id() as i32).unwrap());
        assert!(!owned_descendant(unsafe { libc::getppid() }).unwrap());
        assert!(!owned_descendant(-1).unwrap());
        signal_pid(std::process::id() as i32, libc::SIGKILL).unwrap();
    }
    #[test] fn validates_expected_normal_exit_codes() {
        assert!(valid_exit_codes(&default_exit_codes())); assert!(valid_exit_codes(&[0,255]));
        for invalid in [vec![],vec![0,0],vec![-1],vec![256],vec![0,1,2,3,4,5,6,7,8]] { assert!(!valid_exit_codes(&invalid)); }
    }
}
