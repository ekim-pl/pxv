//! Real private-IPC fault tests: filesystem failures cannot turn a completed child into a released device lease.
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::{
        fd::AsRawFd,
        unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    child: Child,
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}
impl Fixture {
    fn start() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pxv-native-receipts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let (owner, child_socket) = UnixStream::pair().unwrap();
        owner
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let fd = child_socket.as_raw_fd();
        let mut command = Command::new(env!("CARGO_BIN_EXE_pxv-supervisor"));
        command
            .args(["--control-root", root.to_str().unwrap()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(fd, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        drop(child_socket);
        let mut fixture = Self {
            root,
            child,
            reader: BufReader::new(owner.try_clone().unwrap()),
            writer: owner,
        };
        fixture.send(json!({"type":"acquire","device_key":"a".repeat(64),"transport_key":"b".repeat(64),"operation_id":"fault-run"}));
        assert_eq!(fixture.receive()["type"], "ready");
        fixture
    }
    fn send(&mut self, value: Value) {
        serde_json::to_writer(&mut self.writer, &value).unwrap();
        self.writer.write_all(b"\n").unwrap();
        self.writer.flush().unwrap();
    }
    fn receive(&mut self) -> Value {
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn submit(&mut self, args: Vec<String>) {
        self.send(json!({"type":"run","id":"command","args":args,"env":{},"cwd":null,"input":null,"input_file":null,"timeout_ms":5000}));
    }
    fn authorize(&mut self) {
        assert_eq!(self.receive()["type"], "gated");
        self.send(json!({"type":"authorize","id":"command"}));
    }
    fn break_receipts(&self) {
        let path = self.root.join("receipts");
        fs::remove_dir_all(&path).unwrap();
        fs::write(path, b"blocked receipt directory").unwrap();
    }
    fn wait_for_running_receipt(&self) {
        let path = self.root.join("receipts/fault-run-command.json");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let receipt: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            if receipt["status"] == "running" {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "Child never reached running receipt"
            );
            thread::sleep(Duration::from_millis(2));
        }
    }
    fn assert_fenced(&mut self) {
        assert_eq!(self.receive()["type"], "error");
        assert_eq!(self.child.wait().unwrap().code(), Some(125));
        assert_eq!(
            fs::read_dir(self.root.join("reservations"))
                .unwrap()
                .count(),
            2
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|value| (*value).to_owned()).collect()
}
#[test]
fn failed_gate_receipt_never_authorizes_a_child() {
    let mut fixture = Fixture::start();
    fixture.break_receipts();
    let marker = fixture.root.join("must-not-run");
    fixture.submit(vec![
        "/usr/bin/touch".into(),
        marker.to_string_lossy().into_owned(),
    ]);
    fixture.assert_fenced();
    assert!(!marker.exists());
}
#[test]
fn successful_command_does_not_release_fences_when_operation_receipt_fails() {
    let mut fixture = Fixture::start();
    fixture.submit(strings(&["/bin/true"]));
    fixture.authorize();
    let result = fixture.receive();
    assert_eq!(result["type"], "result");
    assert_eq!(result["code"], 0);
    assert_eq!(result["cleanup_proven"], true);
    fixture.break_receipts();
    fixture.send(json!({"type":"finish","success":true}));
    fixture.assert_fenced();
}
#[test]
fn mutated_command_receipt_failure_preserves_both_reservations() {
    let mut fixture = Fixture::start();
    let path = fixture.root.join("receipts");
    let release = fixture.root.join("release-child");
    let mutation = fixture.root.join("mutation-completed");
    // Positional arguments keep host paths out of shell interpolation.
    fixture.submit(vec![
        "/bin/sh".into(),
        "-c".into(),
        "remaining=500; while [ ! -f \"$1\" ]; do [ \"$remaining\" -gt 0 ] || exit 77; remaining=$((remaining - 1)); /bin/sleep 0.01; done; printf mutated > \"$2\"".into(),
        "receipt-fault".into(),
        release.to_string_lossy().into_owned(),
        mutation.to_string_lossy().into_owned(),
    ]);
    fixture.authorize();
    // Inject only after the running receipt is durable, while completion is gated.
    fixture.wait_for_running_receipt();
    fixture.break_receipts();
    fs::write(release, b"release").unwrap();
    fixture.assert_fenced();
    assert!(Path::new(&path).is_file());
    assert_eq!(fs::read(mutation).unwrap(), b"mutated");
}
