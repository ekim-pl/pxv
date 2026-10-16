use crate::{
    error::failure,
    process::{identity, Identity},
    storage::{durable, private_directory},
};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
};
pub(crate) fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub(crate) fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

pub(crate) struct Lease {
    _locks: Vec<File>,
    reservations: Vec<PathBuf>,
    root: PathBuf,
    pub(crate) operation_id: String,
    device_key: String,
    transport_key: String,
    pub(crate) supervisor: Identity,
    pub(crate) uncertain: bool,
    pub(crate) mutated: bool,
    previous_operation_id: Option<String>,
}

impl Lease {
    pub(crate) fn acquire(
        root: &Path,
        device_key: String,
        transport_key: String,
        operation_id: String,
        previous_operation_id: Option<String>,
    ) -> io::Result<Self> {
        validate_lease_ids(
            &device_key,
            &transport_key,
            &operation_id,
            previous_operation_id.as_deref(),
        )?;
        prepare_control(root)?;
        let (locks, reservations) = lock_resources(
            root,
            &device_key,
            &transport_key,
            previous_operation_id.is_some(),
        )?;
        let mut lease = Self {
            _locks: locks,
            reservations,
            root: root.to_path_buf(),
            operation_id,
            device_key,
            transport_key,
            supervisor: identity(std::process::id() as i32)?,
            uncertain: false,
            mutated: false,
            previous_operation_id,
        };
        lease.save_previous()?;
        lease.reserve()?;
        Ok(lease)
    }

    pub(crate) fn record(&self, status: &str) -> Value {
        json!({ "schema":1, "operation_id":self.operation_id, "previous_operation_id":self.previous_operation_id, "device_key":self.device_key, "transport_key":self.transport_key, "supervisor":self.supervisor, "status":status })
    }
    pub(crate) fn reserve(&mut self) -> io::Result<()> {
        for path in &self.reservations {
            durable(path, &self.record("reserved"))?;
        }
        Ok(())
    }
    pub(crate) fn receipt_path(&self, id: &str) -> PathBuf {
        self.root
            .join("receipts")
            .join(format!("{}-{id}.json", self.operation_id))
    }

    pub(crate) fn finish(
        &mut self,
        requested_success: bool,
        cleanup_proven: bool,
    ) -> io::Result<bool> {
        let success = requested_success && !self.uncertain && cleanup_proven;
        let record = self.completion_record(success, cleanup_proven);
        durable(&self.receipt_path("operation"), &record)?;
        if self.can_release(success, cleanup_proven) {
            remove_reservations(&self.root, &self.reservations)?;
        } else {
            self.persist_reservations(&record)?;
        }
        Ok(success)
    }
    fn completion_record(&self, success: bool, cleanup_proven: bool) -> Value {
        let mut record = self.record(if success {
            "completed"
        } else {
            "recovery_required"
        });
        record["cleanup_proven"] = json!(cleanup_proven);
        record["mutation_started"] = json!(self.mutated);
        record
    }
    fn can_release(&self, success: bool, cleanup_proven: bool) -> bool {
        success || (!self.mutated && self.previous_operation_id.is_none() && cleanup_proven)
    }
    fn persist_reservations(&self, record: &Value) -> io::Result<()> {
        for path in &self.reservations {
            durable(path, record)?;
        }
        Ok(())
    }
    fn save_previous(&self) -> io::Result<()> {
        if let Some(prior) = &self.previous_operation_id {
            let record = verify_recovery_records(
                &self.reservations,
                &self.device_key,
                &self.transport_key,
                prior,
            )?;
            durable(&self.receipt_path("previous-reservation"), &record)?;
        }
        Ok(())
    }
}

pub(crate) fn verify_recovery_records(
    paths: &[PathBuf],
    device_key: &str,
    transport_key: &str,
    operation_id: &str,
) -> io::Result<Value> {
    let boot = boot_id()?;
    let mut evidence = None;
    for path in paths {
        let record = read_recovery_record(path)?;
        validate_record_ids(&record, device_key, transport_key, operation_id)?;
        verify_previous_owner(&record, &boot)?;
        compare_record(&evidence, &record)?;
        evidence = Some(record);
    }
    evidence.ok_or_else(|| failure("Recovery evidence unavailable"))
}

fn validate_lease_ids(
    device: &str,
    transport: &str,
    operation: &str,
    previous: Option<&str>,
) -> io::Result<()> {
    if !digest(device) || !digest(transport) || !safe_id(operation) {
        return Err(failure("Invalid lease identity"));
    }
    if previous.is_some_and(|value| !safe_id(value) || value == operation) {
        return Err(failure("Invalid prior recovery operation identity"));
    }
    Ok(())
}
fn prepare_control(root: &Path) -> io::Result<()> {
    private_directory(root)?;
    for child in ["locks", "reservations", "receipts"] {
        private_directory(&root.join(child))?;
    }
    Ok(())
}
fn lock_file(root: &Path, key: &str, recovery: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(!recovery)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join("locks").join(format!("{key}.lock")))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(failure(if recovery {
            "Native owner is still alive or recovery is busy"
        } else {
            "Physical device or transport is busy"
        }));
    }
    Ok(file)
}
fn lock_resources(
    root: &Path,
    device: &str,
    transport: &str,
    recovery: bool,
) -> io::Result<(Vec<File>, Vec<PathBuf>)> {
    let mut keys = [format!("device-{device}"), format!("transport-{transport}")];
    keys.sort();
    let mut locks = Vec::new();
    let mut paths = Vec::new();
    for key in keys {
        let file = lock_file(root, &key, recovery)?;
        let path = root.join("reservations").join(format!("{key}.json"));
        if !recovery && fs::symlink_metadata(&path).is_ok() {
            return Err(failure("Device has unresolved recovery reservation"));
        }
        locks.push(file);
        paths.push(path);
    }
    Ok((locks, paths))
}
fn remove_reservations(root: &Path, paths: &[PathBuf]) -> io::Result<()> {
    for path in paths {
        fs::remove_file(path)?;
    }
    File::open(root.join("reservations"))?.sync_all()
}
fn boot_id() -> io::Result<String> {
    Ok(fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_owned())
}
fn read_recovery_record(path: &Path) -> io::Result<Value> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if file.metadata()?.len() > 64 * 1024 {
        return Err(failure("Malformed recovery evidence retained"));
    }
    serde_json::from_reader(file.take(64 * 1024 + 1))
        .map_err(|_| failure("Malformed recovery evidence retained"))
}
fn validate_record_ids(
    record: &Value,
    device: &str,
    transport: &str,
    operation: &str,
) -> io::Result<()> {
    if record["schema"] != 1
        || record["operation_id"] != operation
        || record["device_key"] != device
        || record["transport_key"] != transport
    {
        return Err(failure("Matching recovery reservation is unavailable"));
    }
    Ok(())
}
fn verify_previous_owner(record: &Value, boot: &str) -> io::Result<()> {
    let previous: Identity = serde_json::from_value(record["supervisor"].clone())
        .map_err(|_| failure("Malformed recovery owner retained"))?;
    if boot != previous.boot_id {
        return Ok(());
    }
    if identity(previous.pid).ok().as_ref() == Some(&previous) {
        return Err(failure("Native owner is still alive"));
    }
    if record["cleanup_proven"] != true {
        return Err(failure(
            "Process cleanup is unproven; reboot the host before releasing this reservation",
        ));
    }
    Ok(())
}
fn compare_record(first: &Option<Value>, record: &Value) -> io::Result<()> {
    if first.as_ref().is_some_and(|value| value != record) {
        return Err(failure("Conflicting recovery evidence retained"));
    }
    Ok(())
}
