use crate::error::failure;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, BufRead, BufReader, Read, Write},
    os::fd::AsRawFd,
};
pub(crate) const IPC_FD: i32 = 3;
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Message {
    Acquire {
        device_key: String,
        transport_key: String,
        operation_id: String,
    },
    AcquireRecovery {
        device_key: String,
        transport_key: String,
        operation_id: String,
        previous_operation_id: String,
    },
    Run {
        id: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        cwd: Option<String>,
        input: Option<String>,
        input_file: Option<String>,
        timeout_ms: u64,
        #[serde(default = "default_exit_codes")]
        expected_exit_codes: Vec<i32>,
    },
    Authorize {
        id: String,
    },
    Cancel {
        id: String,
    },
    Finish {
        success: bool,
    },
}

pub(crate) fn default_exit_codes() -> Vec<i32> {
    vec![0]
}
pub(crate) fn valid_exit_codes(codes: &[i32]) -> bool {
    !codes.is_empty()
        && codes.len() <= 8
        && codes
            .iter()
            .enumerate()
            .all(|(index, code)| (0..=255).contains(code) && !codes[..index].contains(code))
}

pub(crate) fn send(ipc: &mut File, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *ipc, value)?;
    ipc.write_all(b"\n")?;
    ipc.flush()
}

pub(crate) fn receive(reader: &mut BufReader<File>) -> io::Result<Option<Message>> {
    let mut bytes = Vec::new();
    let read = reader
        .take((MAX_MESSAGE + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if read == 0 {
        return Ok(None);
    }
    if bytes.len() > MAX_MESSAGE || bytes.last() != Some(&b'\n') {
        return Err(failure("IPC message exceeds limit or is incomplete"));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(failure)
}

pub(crate) fn poll_owner(reader: &BufReader<File>) -> io::Result<bool> {
    if !reader.buffer().is_empty() {
        return Ok(true);
    }
    let mut item = libc::pollfd {
        fd: reader.get_ref().as_raw_fd(),
        events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut item, 1, 0) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(result > 0)
}
