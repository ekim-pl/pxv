use crate::error::failure;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read},
    os::unix::fs::MetadataExt,
    process::Child,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub(crate) struct Identity {
    pub(crate) pid: i32,
    pub(crate) start_ticks: String,
    pub(crate) boot_id: String,
    pub(crate) uid: u32,
}

pub(crate) fn identity(pid: i32) -> io::Result<Identity> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let (_, rest) = stat
        .rsplit_once(") ")
        .ok_or_else(|| failure("Invalid process identity"))?;
    let start_ticks = rest
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| failure("Missing process start time"))?
        .to_owned();
    let uid = fs::metadata(format!("/proc/{pid}"))?.uid();
    Ok(Identity {
        pid,
        start_ticks,
        uid,
        boot_id: fs::read_to_string("/proc/sys/kernel/random/boot_id")?
            .trim()
            .to_owned(),
    })
}

pub(crate) fn parse_children(value: &str) -> io::Result<Vec<i32>> {
    value
        .split_whitespace()
        .map(|value| {
            let pid = value
                .parse::<i32>()
                .map_err(|_| failure("Malformed native child enumeration"))?;
            if pid <= 0 {
                return Err(failure("Invalid native child identity"));
            }
            Ok(pid)
        })
        .collect()
}

pub(crate) fn children(pid: i32) -> io::Result<Vec<i32>> {
    parse_children(&fs::read_to_string(format!(
        "/proc/{pid}/task/{pid}/children"
    ))?)
}

pub(crate) fn descendant_pids(pid: i32, result: &mut Vec<i32>) -> io::Result<()> {
    for child in children(pid)? {
        // A descendant can exit during traversal. Other enumeration failures
        // cannot establish an empty process tree and must preserve the fence.
        if let Err(error) = descendant_pids(child, result) {
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error);
            }
        }
        result.push(child);
    }
    Ok(())
}

pub(crate) fn owned_descendant(mut pid: i32) -> io::Result<bool> {
    let supervisor = std::process::id() as i32;
    if pid == supervisor {
        return Ok(false);
    }
    for _ in 0..4096 {
        let Some(parent) = parent_pid(pid)? else {
            return Ok(false);
        };
        if parent == supervisor {
            return Ok(true);
        }
        if parent <= 1 {
            return Ok(false);
        }
        pid = parent;
    }
    Err(failure("Descendant ancestry exceeds safety bound"))
}

pub(crate) fn signal_pid(pid: i32, signal: i32) -> io::Result<()> {
    let Some(before) = existing_identity(pid)? else {
        return Ok(());
    };
    let Some(fd) = open_pidfd(pid)? else {
        return Ok(());
    };
    let owned = still_owned(pid, &before);
    if !matches!(owned, Ok(true)) {
        unsafe {
            libc::close(fd);
        }
        return owned.map(|_| ());
    }
    send_pidfd(fd, signal)
}

pub(crate) fn reap_adopted(exclude: Option<i32>) -> io::Result<()> {
    for pid in children(std::process::id() as i32)? {
        if Some(pid) != exclude {
            unsafe {
                libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
            }
        }
    }
    Ok(())
}

pub(crate) fn terminate_descendants(child: Option<&mut Child>) -> bool {
    let mut child = child;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut proven = true;
    while Instant::now() < deadline {
        let mut pids = Vec::new();
        if descendant_pids(std::process::id() as i32, &mut pids).is_err() {
            return false;
        }
        if pids.is_empty() {
            return proven;
        }
        for pid in &pids {
            // pidfds bind the kill to this process identity, including detached
            // double-fork descendants adopted through PR_SET_CHILD_SUBREAPER.
            if signal_pid(*pid, libc::SIGKILL).is_err() {
                proven = false;
            }
        }
        if let Some(process) = child.as_mut() {
            let _ = process.try_wait();
        }
        if reap_adopted(child.as_ref().map(|process| process.id() as i32)).is_err() {
            return false;
        }
        thread::sleep(Duration::from_millis(5));
    }
    false
}

pub(crate) fn capture(mut stream: impl Read + Send + 'static) -> JoinHandle<io::Result<String>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut block = [0; 16 * 1024];
        let mut overflow = false;
        loop {
            let length = stream.read(&mut block)?;
            if length == 0 {
                break;
            }
            if output.len() + length <= MAX_OUTPUT {
                output.extend_from_slice(&block[..length]);
            } else {
                overflow = true;
            }
        }
        if overflow {
            return Err(failure("Command output exceeded capture limit"));
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    })
}

fn parent_pid(pid: i32) -> io::Result<Option<i32>> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let parent = parse_parent(&stat)?;
    Ok(Some(parent))
}
fn existing_identity(pid: i32) -> io::Result<Option<Identity>> {
    match identity(pid) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn open_pidfd(pid: i32) -> io::Result<Option<i32>> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    if fd >= 0 {
        return Ok(Some(fd));
    }
    if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        return Ok(None);
    }
    Err(failure("pidfd_open unavailable; cleanup cannot be proven"))
}
fn still_owned(pid: i32, before: &Identity) -> io::Result<bool> {
    match existing_identity(pid)? {
        Some(after) if &after == before => owned_descendant(pid),
        _ => Ok(false),
    }
}
fn send_pidfd(fd: i32, signal: i32) -> io::Result<()> {
    let outcome = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd,
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    let error = io::Error::last_os_error();
    unsafe {
        libc::close(fd);
    }
    if outcome < 0 && error.raw_os_error() != Some(libc::ESRCH) {
        return Err(error);
    }
    Ok(())
}

fn parse_parent(stat: &str) -> io::Result<i32> {
    let (_, rest) = stat
        .rsplit_once(") ")
        .ok_or_else(|| failure("Invalid descendant identity"))?;
    let parent = rest
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| failure("Missing descendant parent"))?
        .parse::<i32>()
        .map_err(|_| failure("Malformed descendant parent"))?;
    Ok(parent)
}
