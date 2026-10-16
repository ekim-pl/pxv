use crate::{
    error::failure,
    lease::{safe_id, Lease},
    process::{capture, children, identity, reap_adopted, terminate_descendants},
    protocol::{poll_owner, receive, send, valid_exit_codes, Message, IPC_FD},
    storage::durable,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Write},
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    process::{Child, Command, ExitStatus, Stdio},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(crate) struct CommandSpec {
    pub(crate) id: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) cwd: Option<String>,
    pub(crate) input: Option<String>,
    pub(crate) input_file: Option<String>,
    pub(crate) timeout_ms: u64,
    pub(crate) expected_exit_codes: Vec<i32>,
}
impl CommandSpec {
    fn validate(&self, lease: &Lease) -> io::Result<()> {
        self.validate_arguments()?;
        if !valid_exit_codes(&self.expected_exit_codes) {
            return Err(failure("Invalid expected exit codes"));
        }
        if fs::symlink_metadata(lease.receipt_path(&self.id)).is_ok() {
            return Err(failure(
                "Native command ID was already used; refusing replay",
            ));
        }
        if self.input.is_some() && self.input_file.is_some() {
            return Err(failure("input and input_file are mutually exclusive"));
        }
        Ok(())
    }
    fn validate_arguments(&self) -> io::Result<()> {
        if !safe_id(&self.id)
            || self.args.is_empty()
            || self.args.iter().any(|arg| arg.contains('\0'))
            || self.timeout_ms == 0
            || self.timeout_ms > 86_400_000
        {
            return Err(failure("Invalid native command specification"));
        }
        validate_environment(&self.env)?;
        Ok(())
    }
    fn source(&self) -> io::Result<Option<File>> {
        let Some(path) = &self.input_file else {
            return Ok(None);
        };
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        if !file.metadata()?.is_file() {
            return Err(failure("Command input must be a regular file"));
        }
        Ok(Some(file))
    }
    fn input_bytes(&self) -> io::Result<Option<Vec<u8>>> {
        self.input
            .as_ref()
            .map(|value| {
                base64::engine::general_purpose::STANDARD
                    .decode(value)
                    .map_err(|_| failure("Invalid input encoding"))
            })
            .transpose()
    }
    fn command(&self, source: Option<File>) -> Command {
        let mut command = Command::new(&self.args[0]);
        command
            .args(&self.args[1..])
            .env_clear()
            .envs(&self.env)
            .stdin(source.map(Stdio::from).unwrap_or_else(Stdio::piped))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(directory) = &self.cwd {
            command.current_dir(directory);
        }
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                libc::close(IPC_FD);
                Ok(())
            });
        }
        command
    }
}

pub(crate) fn run_command(
    lease: &mut Lease,
    reader: &mut BufReader<File>,
    ipc: &mut File,
    spec: CommandSpec,
) -> io::Result<()> {
    spec.validate(lease)?;
    let source = spec.source()?;
    let input = spec.input_bytes()?;
    let mut started = authorize(lease, reader, ipc, &spec)?;
    let mut child = spec.command(source).spawn()?;
    record_started(lease, &spec.id, &mut started, &mut child)?;
    let streams = CommandStreams::capture(&mut child, input)?;
    let mut completion = Completion::wait(&mut child, reader, &spec)?;
    completion.respond(lease, ipc, &spec, started, streams)
}
fn authorize(
    lease: &mut Lease,
    reader: &mut BufReader<File>,
    ipc: &mut File,
    spec: &CommandSpec,
) -> io::Result<Value> {
    let mut intent = json!({"schema":1,"operation_id":lease.operation_id,"command_id":spec.id,"supervisor":lease.supervisor,"status":"gated","expected_exit_codes":spec.expected_exit_codes});
    durable(&lease.receipt_path(&spec.id), &intent)?;
    send(ipc, &json!({"type":"gated","id":spec.id}))?;
    match receive(reader)? {
        Some(Message::Authorize { id }) if id == spec.id => {}
        _ => return Err(failure("Owner did not authorize native execution")),
    }
    lease.mutated = true;
    intent["status"] = json!("authorized");
    durable(&lease.receipt_path(&spec.id), &intent)?;
    Ok(intent)
}
fn record_started(
    lease: &Lease,
    id: &str,
    started: &mut Value,
    child: &mut Child,
) -> io::Result<()> {
    started["child"] = json!(identity(child.id() as i32)?);
    started["status"] = json!("running");
    if let Err(error) = durable(&lease.receipt_path(id), started) {
        terminate_descendants(Some(child));
        return Err(error);
    }
    Ok(())
}
struct CommandStreams {
    stdout: JoinHandle<io::Result<String>>,
    stderr: JoinHandle<io::Result<String>>,
}
impl CommandStreams {
    fn capture(child: &mut Child, input: Option<Vec<u8>>) -> io::Result<Self> {
        let stdout = capture(
            child
                .stdout
                .take()
                .ok_or_else(|| failure("Missing stdout"))?,
        );
        let stderr = capture(
            child
                .stderr
                .take()
                .ok_or_else(|| failure("Missing stderr"))?,
        );
        if let Some(mut stdin) = child.stdin.take() {
            let input = input.unwrap_or_default();
            thread::spawn(move || {
                let _ = stdin.write_all(&input);
            });
        }
        Ok(Self { stdout, stderr })
    }
    fn collect(self, clean: bool) -> io::Result<(io::Result<String>, io::Result<String>)> {
        Ok((
            collect_stream(self.stdout, clean, "stdout worker failed")?,
            collect_stream(self.stderr, clean, "stderr worker failed")?,
        ))
    }
}
fn collect_stream(
    stream: JoinHandle<io::Result<String>>,
    clean: bool,
    message: &str,
) -> io::Result<io::Result<String>> {
    if !clean {
        return Ok(Err(failure("Process cleanup is unproven")));
    }
    stream.join().map_err(|_| failure(message))
}
struct Completion {
    status: Option<ExitStatus>,
    interrupted: bool,
    owner_lost: bool,
    cleanup_proven: bool,
}
impl Completion {
    fn wait(
        child: &mut Child,
        reader: &mut BufReader<File>,
        spec: &CommandSpec,
    ) -> io::Result<Self> {
        let deadline = Instant::now() + Duration::from_millis(spec.timeout_ms);
        let mut state = Self {
            status: None,
            interrupted: false,
            owner_lost: false,
            cleanup_proven: true,
        };
        loop {
            if state.finished(child)? {
                break;
            }
            if Instant::now() >= deadline {
                state.interrupted = true;
            } else {
                state.poll_owner(reader, &spec.id)?;
            }
            if state.interrupted {
                state.cleanup_proven = terminate_descendants(Some(child));
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        if state.status.is_none() {
            state.status = child.try_wait()?;
        }
        Ok(state)
    }
    fn finished(&mut self, child: &mut Child) -> io::Result<bool> {
        if self.status.is_none() {
            self.status = child.try_wait()?;
        }
        let exclude = if self.status.is_none() {
            Some(child.id() as i32)
        } else {
            None
        };
        reap_adopted(exclude)?;
        Ok(self.status.is_some() && children(std::process::id() as i32)?.is_empty())
    }
    fn poll_owner(&mut self, reader: &mut BufReader<File>, id: &str) -> io::Result<()> {
        if !poll_owner(reader)? {
            return Ok(());
        }
        self.interrupted = true;
        self.owner_lost =
            !matches!(receive(reader),Ok(Some(Message::Cancel{id:cancelled})) if cancelled==id);
        Ok(())
    }
    fn code(&self) -> i32 {
        if self.interrupted {
            124
        } else {
            self.status.and_then(|value| value.code()).unwrap_or(128)
        }
    }
    fn uncertain(&self, spec: &CommandSpec, code: i32) -> bool {
        self.interrupted
            || !self.status.is_some_and(|value| value.code().is_some())
            || !spec.expected_exit_codes.contains(&code)
            || !self.cleanup_proven
    }
    fn respond(
        &mut self,
        lease: &mut Lease,
        ipc: &mut File,
        spec: &CommandSpec,
        mut receipt: Value,
        streams: CommandStreams,
    ) -> io::Result<()> {
        let (output, errors) = streams.collect(self.cleanup_proven)?;
        if output.is_err() || errors.is_err() {
            self.interrupted = true;
        }
        let code = self.code();
        if self.uncertain(spec, code) {
            lease.uncertain = true;
        }
        self.persist(lease, &spec.id, &mut receipt, code)?;
        if self.owner_lost {
            return Err(failure("Owner disconnected; device remains fenced"));
        }
        send(
            ipc,
            &json!({"type":"result","id":spec.id,"code":code,"stdout":output.unwrap_or_default(),"stderr":errors.unwrap_or_default(),"cleanup_proven":self.cleanup_proven,"interrupted":self.interrupted}),
        )
    }
    fn persist(&self, lease: &Lease, id: &str, receipt: &mut Value, code: i32) -> io::Result<()> {
        receipt["status"] = json!("completed");
        receipt["code"] = json!(code);
        receipt["cleanup_proven"] = json!(self.cleanup_proven);
        receipt["interrupted"] = json!(self.interrupted);
        durable(&lease.receipt_path(id), receipt)
    }
}

fn validate_environment(env: &BTreeMap<String, String>) -> io::Result<()> {
    if env
        .iter()
        .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err(failure("Invalid native command specification"));
    }
    Ok(())
}
