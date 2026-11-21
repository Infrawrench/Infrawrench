//! Native programs a WASIX script runs, inside the job's sandbox.
//!
//! The script's shell finds a native program (`bun`) on `PATH` as a small
//! WASIX module, the trampoline (`trampoline.wat`), which asks this file
//! system, mounted at [`NATIVE_DIR`], to start the program:
//!
//! - writing a request (arguments, environment, working directory) to
//!   `spawn/<name>@<token>` and reading the file back starts `<name>` and
//!   gives the id of its session, or nothing when it could not be started.
//!   The token is the trampoline's own, at random: WASIX shares one open
//!   handle among every open of the same path, and a second open replaces
//!   it, so two programs started at once through one path took each
//!   other's request and answer, and the first was stopped as its handle
//!   was dropped;
//! - `<id>/in` is the program's standard input, `<id>/out` and `<id>/err`
//!   its output, which end when the program's do (or shortly after it
//!   exits, when something it left behind holds them open), and
//!   `<id>/status` reads, once it has exited, `<code>` or `s<signal>`.
//!
//! The trampoline carries its own standard streams to and from those, so
//! the program's output goes wherever the trampoline's would (a pipe to
//! another WASIX program, a file, the job's log), and it exits as the
//! program did. The program runs in a process group of its own; when the
//! trampoline goes (it was killed, its job ended), its `spawn/` file
//! closes and the group is stopped: `SIGTERM`, then `SIGKILL`.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use virtual_fs::{
    DirEntry, FileSystem, FsError, Metadata, OpenOptionsConfig, ReadDir, VirtualFile,
};

use crate::modes::{dir_meta, file_meta};

/// Where [`NativeControl`] is mounted.
pub(crate) const NATIVE_DIR: &str = "/proc/iwci/native";

/// How long a program's output is still read after it exits, for what it
/// wrote last, when something it started holds the output open.
const AFTER_EXIT: Duration = Duration::from_millis(200);

/// How much of a program's output is held for the trampoline before the
/// program has to wait for it to be read.
const OUTPUT_HELD: usize = 1 << 20;

/// How long a program whose trampoline went has to stop after `SIGTERM`.
const TERM_GRACE: Duration = Duration::from_secs(2);

/// The preload the runner gives an environment's `node` (wasix.rs), which
/// only the isolate has: it is taken out of `NODE_OPTIONS` for a native
/// program, and goes back in when the program runs a `node`.
fn without_node_preload(value: &str) -> String {
    let preload = format!("--require {}/preload.cjs", crate::wasix::NODE_SUPPORT_DIR);
    value.replace(&preload, "").trim().to_string()
}

/// A request, as the trampoline and the native shims (`shim.rs`) send it:
/// a header of five little-endian `u32`s (argument count, argument bytes,
/// variable count, variable bytes, working directory bytes), then the
/// arguments and variables, each NUL-terminated, then the working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Request {
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) cwd: String,
}

/// The most a request may be: what Linux allows a program's arguments and
/// environment, and a path.
pub(crate) const MAX_REQUEST: usize = 8 << 20;

impl Request {
    pub(crate) fn parse(bytes: &[u8]) -> Option<Request> {
        let word = |i: usize| -> Option<usize> {
            let b = bytes.get(i * 4..i * 4 + 4)?;
            Some(u32::from_le_bytes(b.try_into().ok()?) as usize)
        };
        let (argc, args_len, envc, env_len, cwd_len) =
            (word(0)?, word(1)?, word(2)?, word(3)?, word(4)?);
        let mut at = 20usize;
        let mut take = |len: usize| -> Option<&[u8]> {
            let end = at.checked_add(len)?;
            let slice = bytes.get(at..end)?;
            at = end;
            Some(slice)
        };
        let strings = |raw: &[u8], count: usize| -> Option<Vec<String>> {
            let mut out: Vec<String> = Vec::with_capacity(count);
            if !raw.is_empty() {
                let raw = raw.strip_suffix(&[0]).unwrap_or(raw);
                for part in raw.split(|b| *b == 0) {
                    out.push(String::from_utf8_lossy(part).into_owned());
                }
            }
            (out.len() == count).then_some(out)
        };
        let args = strings(take(args_len)?, argc)?;
        let env = strings(take(env_len)?, envc)?
            .into_iter()
            .map(|kv| match kv.split_once('=') {
                Some((k, v)) => (k.to_string(), v.to_string()),
                None => (kv, String::new()),
            })
            .collect();
        let cwd = String::from_utf8_lossy(take(cwd_len)?).into_owned();
        if args.is_empty() {
            return None;
        }
        Some(Request { args, env, cwd })
    }

    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut args = Vec::new();
        for a in &self.args {
            args.extend_from_slice(a.as_bytes());
            args.push(0);
        }
        let mut env = Vec::new();
        for (k, v) in &self.env {
            env.extend_from_slice(k.as_bytes());
            env.push(b'=');
            env.extend_from_slice(v.as_bytes());
            env.push(0);
        }
        let mut out = Vec::with_capacity(20 + args.len() + env.len() + self.cwd.len());
        for n in [
            self.args.len(),
            args.len(),
            self.env.len(),
            env.len(),
            self.cwd.len(),
        ] {
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
        out.extend_from_slice(&args);
        out.extend_from_slice(&env);
        out.extend_from_slice(self.cwd.as_bytes());
        out
    }
}

/// A pipe whose write end says the program exited (`Session`).
fn exit_pipe() -> (Option<std::os::fd::OwnedFd>, Option<std::os::fd::OwnedFd>) {
    use std::os::fd::FromRawFd;
    let mut fds = [0; 2];
    // SAFETY: `fds` has room for both ends.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return (None, None);
    }
    // SAFETY: both were just created and are ours.
    unsafe {
        (
            Some(std::os::fd::OwnedFd::from_raw_fd(fds[0])),
            Some(std::os::fd::OwnedFd::from_raw_fd(fds[1])),
        )
    }
}

/// The trampoline for the native program `name`, compiled once.
pub(crate) fn trampoline(name: &str) -> Option<Arc<[u8]>> {
    static COMPILED: Mutex<Option<HashMap<String, Arc<[u8]>>>> = Mutex::new(None);
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.+".contains(&b))
    {
        return None;
    }
    let mut compiled = COMPILED.lock().unwrap_or_else(|e| e.into_inner());
    let map = compiled.get_or_insert_with(HashMap::new);
    if let Some(wasm) = map.get(name) {
        return Some(wasm.clone());
    }
    let spawn = format!("{}/spawn/{name}", &NATIVE_DIR[1..]);
    let wasm = assemble(spawn.as_bytes(), 1100, DYNAMIC)?;
    map.insert(name.to_string(), wasm.clone());
    Some(wasm)
}

/// Where a trampoline's argv, environment and working directory go
/// (`trampoline.wat`).
const DYNAMIC: usize = 135_168;

/// The longest path a WASIX process may execute natively.
const MAX_EXEC_PATH: usize = 4096;

/// The trampoline that runs the native program at `path`, which a WASIX
/// process in the sandbox asked to execute: it opens
/// `exec/<path>` under [`NATIVE_DIR`], and the program runs with the
/// caller's arguments (its `argv[0]` included), environment, directory
/// and standard streams, as a native tool's command does. `None` for a
/// path that is not absolute and normal, or longer than [`MAX_EXEC_PATH`].
pub(crate) fn exec_trampoline(path: &str) -> Option<Arc<[u8]>> {
    let path = exec_path(path)?;
    let spawn = format!("{}/exec{}", &NATIVE_DIR[1..], path.to_str()?);
    // The path, and the `@<token>` the trampoline adds to it, go where the
    // dynamic area would, which moves past them.
    let dynamic = (DYNAMIC + spawn.len() + 18).next_multiple_of(4096);
    assemble(spawn.as_bytes(), DYNAMIC, dynamic)
}

/// `path` as an absolute path with no `.`, `..` or empty parts, as the
/// native side reads it back (`NativeControl`).
fn exec_path(path: &str) -> Option<PathBuf> {
    if !path.starts_with('/') || path.len() > MAX_EXEC_PATH || path.contains('\0') {
        return None;
    }
    let mut out = PathBuf::from("/");
    for part in Path::new(path).components() {
        match part {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
            Component::Prefix(_) => return None,
        }
    }
    (out != Path::new("/")).then_some(out)
}

/// The trampoline with its spawn path at `at` and its dynamic area at
/// `dynamic`.
fn assemble(spawn: &[u8], at: usize, dynamic: usize) -> Option<Arc<[u8]>> {
    let mut quoted = String::with_capacity(spawn.len());
    for &b in spawn {
        if b.is_ascii_graphic() && b != b'"' && b != b'\\' || b == b' ' {
            quoted.push(b as char);
        } else {
            quoted.push_str(&format!("\\{b:02x}"));
        }
    }
    let text = include_str!("trampoline.wat")
        .replace("@SPAWN_LEN@", &spawn.len().to_string())
        .replace("@SPAWN_AT@", &at.to_string())
        .replace("@DYNAMIC@", &dynamic.to_string())
        .replace("@SPAWN@", &quoted);
    Some(wat::parse_str(&text).ok()?.into())
}

/// One job's native programs and their sessions.
#[derive(Debug, Default)]
pub(crate) struct Natives {
    /// Command name to the program's path in the sandbox.
    programs: HashMap<String, PathBuf>,
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    next: AtomicU64,
    /// The CPUs the job is told it has (`Limits::told_cpus`), as the
    /// affinity each program starts with; `None` leaves the sandbox's.
    told_cpus: Option<u32>,
}

impl Natives {
    pub(crate) fn new(programs: impl IntoIterator<Item = (String, PathBuf)>) -> Self {
        Self {
            programs: programs.into_iter().collect(),
            ..Self::default()
        }
    }

    /// Starts each program on the first `cpus` of the sandbox's CPUs.
    pub(crate) fn telling_cpus(mut self, cpus: u32) -> Self {
        self.told_cpus = Some(cpus);
        self
    }

    /// The programs' names.
    pub(crate) fn names(&self) -> impl Iterator<Item = &str> {
        self.programs.keys().map(String::as_str)
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<Session>>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts the command `name`, or the program at `name` when it is a
    /// path (`exec/`, a native program a WASIX process executed).
    fn start(&self, name: &str, request: &Request) -> io::Result<u64> {
        let program = match name.starts_with('/') {
            true => Path::new(name),
            false => self
                .programs
                .get(name)
                .map(PathBuf::as_path)
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?,
        };
        let mut command = Command::new(program);
        command
            .arg0(&request.args[0])
            .args(&request.args[1..])
            .env_clear()
            .current_dir(&request.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        // The job's CPU count, where a native program asks for it: its
        // affinity, which `nproc`, Go's `runtime.NumCPU`, Rust's
        // `available_parallelism`, libuv (Node's `availableParallelism`) and
        // Bun's `navigator.hardwareConcurrency` read. gVisor keeps a mask
        // for what it reports and does not pin threads to it, so the
        // program may still use every CPU of the sandbox.
        if let Some(set) = self.told_cpus.and_then(told_affinity) {
            // SAFETY: only `sched_setaffinity`, which is async-signal-safe,
            // on a set made before the fork.
            unsafe {
                command.pre_exec(move || {
                    // Best effort: a program that keeps the sandbox's mask
                    // still runs.
                    libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set);
                    Ok(())
                });
            }
        }
        for (k, v) in &request.env {
            if k == "NODE_OPTIONS" {
                let options = without_node_preload(v);
                if !options.is_empty() {
                    command.env(k, options);
                }
            } else {
                command.env(k, v);
            }
        }
        let mut child = command.spawn()?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let session = Arc::new(Session::new(&mut child));
        let pid = child.id() as libc::pid_t;
        {
            let session = session.clone();
            std::thread::Builder::new()
                .name("iwci-native-wait".into())
                .spawn(move || {
                    let status = child.wait();
                    session.exited(status.ok());
                })?;
        }
        *session.pgid.lock().unwrap_or_else(|e| e.into_inner()) = Some(pid);
        self.sessions().insert(id, session);
        Ok(id)
    }

    fn session(&self, id: u64) -> Option<Arc<Session>> {
        self.sessions().get(&id).cloned()
    }

    fn close(&self, id: u64) {
        if let Some(session) = self.sessions().remove(&id) {
            session.stop(true);
        }
    }

    /// Stops every program still running: the job is over.
    pub(crate) fn stop_all(&self) {
        let sessions: Vec<Arc<Session>> = self.sessions().drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.stop(false);
        }
    }
}

/// The first `told` of the CPUs this process may run on, as an affinity
/// mask; `None` when that is all of them, or they cannot be read.
fn told_affinity(told: u32) -> Option<libc::cpu_set_t> {
    let size = std::mem::size_of::<libc::cpu_set_t>();
    // SAFETY: a `cpu_set_t` is plain bits; zeroed is the empty set.
    let mut current: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    // SAFETY: `current` is a whole `cpu_set_t` of `size` bytes.
    if unsafe { libc::sched_getaffinity(0, size, &mut current) } != 0 {
        return None;
    }
    // SAFETY: as above.
    let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    let mut kept = 0;
    let mut have = 0;
    for cpu in 0..libc::CPU_SETSIZE as usize {
        // SAFETY: `cpu` is under `CPU_SETSIZE`, the bits a set has.
        if unsafe { libc::CPU_ISSET(cpu, &current) } {
            have += 1;
            if kept < told.max(1) {
                // SAFETY: as above.
                unsafe { libc::CPU_SET(cpu, &mut set) };
                kept += 1;
            }
        }
    }
    (kept < have).then_some(set)
}

/// One running native program.
#[derive(Debug)]
struct Session {
    pgid: Mutex<Option<libc::pid_t>>,
    stdin: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    stdin_broken: Arc<std::sync::atomic::AtomicBool>,
    out: Arc<Output>,
    err: Arc<Output>,
    status: Mutex<Status>,
    /// Written once the program has exited, and never read, so that the
    /// output pumps wake for it without polling.
    exited_signal: Mutex<Option<std::os::fd::OwnedFd>>,
}

#[derive(Debug, Default)]
struct Status {
    /// `<code>` or `s<signal>`, once it has exited.
    text: Option<String>,
    wakers: Vec<Waker>,
}

impl Session {
    fn new(child: &mut Child) -> Self {
        let stdin_broken = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stdin = child.stdin.take().map(|mut pipe| {
            let (tx, rx) = mpsc::channel::<Vec<u8>>();
            let broken = stdin_broken.clone();
            let _ = std::thread::Builder::new()
                .name("iwci-native-in".into())
                .spawn(move || {
                    for chunk in rx {
                        if pipe.write_all(&chunk).is_err() {
                            broken.store(true, Ordering::Release);
                            return;
                        }
                    }
                });
            tx
        });
        let out = Arc::new(Output::default());
        let err = Arc::new(Output::default());
        let (exited_r, exited_w) = exit_pipe();
        if let Some(pipe) = child.stdout.take() {
            out.clone()
                .pump(pipe, exited_r.as_ref().and_then(|r| r.try_clone().ok()));
        }
        if let Some(pipe) = child.stderr.take() {
            err.clone().pump(pipe, exited_r);
        }
        Self {
            pgid: Mutex::new(None),
            stdin: Mutex::new(stdin),
            stdin_broken,
            out,
            err,
            status: Mutex::default(),
            exited_signal: Mutex::new(exited_w),
        }
    }

    fn exited(&self, status: Option<std::process::ExitStatus>) {
        let text = match status {
            Some(s) => match (s.code(), s.signal()) {
                (Some(code), _) => code.to_string(),
                (None, Some(signal)) => format!("s{signal}"),
                _ => "1".into(),
            },
            None => "1".into(),
        };
        let wakers = {
            let mut st = self.status.lock().unwrap_or_else(|e| e.into_inner());
            st.text = Some(text);
            std::mem::take(&mut st.wakers)
        };
        for w in wakers {
            w.wake();
        }
        self.out.program_exited();
        self.err.program_exited();
        if let Some(fd) = self
            .exited_signal
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let byte = 1u8;
            // SAFETY: one byte to our own pipe.
            unsafe { libc::write(fd.as_raw_fd(), (&byte as *const u8).cast(), 1) };
        }
    }

    fn has_exited(&self) -> bool {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .text
            .is_some()
    }

    /// Stops the program's process group: gently first when `gently`.
    fn stop(&self, gently: bool) {
        self.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
        if self.has_exited() {
            // What it started may still be running in its group.
            if let Some(pgid) = *self.pgid.lock().unwrap_or_else(|e| e.into_inner()) {
                // SAFETY: signalling a process group this session made.
                unsafe { libc::kill(-pgid, libc::SIGKILL) };
            }
            return;
        }
        let Some(pgid) = *self.pgid.lock().unwrap_or_else(|e| e.into_inner()) else {
            return;
        };
        if gently {
            // SAFETY: as above.
            unsafe { libc::kill(-pgid, libc::SIGTERM) };
            let _ = std::thread::Builder::new()
                .name("iwci-native-stop".into())
                .spawn(move || {
                    std::thread::sleep(TERM_GRACE);
                    // SAFETY: as above.
                    unsafe { libc::kill(-pgid, libc::SIGKILL) };
                });
        } else {
            // SAFETY: as above.
            unsafe { libc::kill(-pgid, libc::SIGKILL) };
        }
    }
}

/// A program's stdout or stderr, read by a thread of its own and held
/// for the trampoline.
#[derive(Debug, Default)]
struct Output {
    state: Mutex<OutputState>,
    room: Condvar,
}

#[derive(Debug, Default)]
struct OutputState {
    held: VecDeque<u8>,
    ended: bool,
    exited_at: Option<Instant>,
    wakers: Vec<Waker>,
}

impl Output {
    fn lock(&self) -> std::sync::MutexGuard<'_, OutputState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wake(state: &mut OutputState) {
        for w in state.wakers.drain(..) {
            w.wake();
        }
    }

    fn program_exited(&self) {
        let mut state = self.lock();
        state.exited_at = Some(Instant::now());
        self.room.notify_all();
    }

    fn end(&self) {
        let mut state = self.lock();
        state.ended = true;
        Self::wake(&mut state);
        self.room.notify_all();
    }

    fn pump(
        self: Arc<Self>,
        pipe: impl Read + AsRawFd + Send + 'static,
        exited: Option<std::os::fd::OwnedFd>,
    ) {
        let _ = std::thread::Builder::new()
            .name("iwci-native-out".into())
            .spawn(move || {
                let mut pipe = pipe;
                let mut buf = vec![0u8; 64 << 10];
                loop {
                    // Wait for data; once the program has exited, only for
                    // a moment more if nothing comes.
                    let exited_at = self.lock().exited_at;
                    let mut fds = [
                        libc::pollfd {
                            fd: pipe.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                        libc::pollfd {
                            fd: exited.as_ref().map_or(-1, |e| e.as_raw_fd()),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                    ];
                    let (count, timeout) = match exited_at {
                        Some(at) => (
                            1,
                            AFTER_EXIT.saturating_sub(at.elapsed()).as_millis() as libc::c_int,
                        ),
                        None => (if exited.is_some() { 2 } else { 1 }, -1),
                    };
                    // SAFETY: `count` valid pollfds.
                    let ready = unsafe { libc::poll(fds.as_mut_ptr(), count, timeout) };
                    if ready == 0 {
                        break;
                    }
                    if ready < 0 {
                        if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                            continue;
                        }
                        break;
                    }
                    if fds[0].revents == 0 {
                        // The program exited: look again, with the time left.
                        continue;
                    }
                    let n = match pipe.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    };
                    let mut state = self.lock();
                    while state.held.len() >= OUTPUT_HELD && !state.ended {
                        state = self
                            .room
                            .wait_timeout(state, Duration::from_millis(100))
                            .map(|(s, _)| s)
                            .unwrap_or_else(|e| e.into_inner().0);
                    }
                    if state.ended {
                        // The reader went: nobody wants the rest.
                        break;
                    }
                    state.held.extend(&buf[..n]);
                    Self::wake(&mut state);
                }
                self.end();
            });
    }

    fn poll_read(&self, cx: &mut Context<'_>, out: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let mut state = self.lock();
        if !state.held.is_empty() {
            let n = state.held.len().min(out.remaining());
            let (a, b) = state.held.as_slices();
            let from_a = n.min(a.len());
            out.put_slice(&a[..from_a]);
            out.put_slice(&b[..n - from_a]);
            state.held.drain(..n);
            self.room.notify_all();
            return Poll::Ready(Ok(()));
        }
        if state.ended {
            return Poll::Ready(Ok(()));
        }
        state.wakers.push(cx.waker().clone());
        Poll::Pending
    }

    fn poll_ready(&self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let mut state = self.lock();
        if !state.held.is_empty() || state.ended {
            return Poll::Ready(Ok(state.held.len()));
        }
        state.wakers.push(cx.waker().clone());
        Poll::Pending
    }
}

/// The file system at [`NATIVE_DIR`]. See the module comment.
#[derive(Debug, Clone)]
pub(crate) struct NativeControl {
    natives: Arc<Natives>,
}

/// What a path of [`NativeControl`] names.
enum Target {
    Spawn(String),
    In(u64),
    Out(u64),
    Err(u64),
    Status(u64),
}

impl NativeControl {
    pub(crate) fn new(natives: Arc<Natives>) -> Self {
        Self { natives }
    }

    fn parts(path: &Path) -> Vec<&str> {
        path.components()
            .filter_map(|c| match c {
                Component::Normal(n) => n.to_str(),
                _ => None,
            })
            .collect()
    }

    /// `<name>` of a spawn file's `<name>@<token>`: the token is the
    /// trampoline's own (1 to 32 hex digits), so that two trampolines of
    /// one program never open the same path.
    fn untokened(file: &str) -> Option<&str> {
        let (name, token) = file.rsplit_once('@')?;
        ((1..=32).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit()))
            .then_some(name)
    }

    fn target(&self, path: &Path) -> Option<Target> {
        match Self::parts(path).as_slice() {
            ["spawn", file] => {
                let name = Self::untokened(file)?;
                self.natives
                    .programs
                    .contains_key(name)
                    .then(|| Target::Spawn(name.to_string()))
            }
            // A native program a WASIX process executes, by its path in
            // the sandbox (`exec_trampoline`), with the trampoline's token
            // after its last part.
            ["exec", dirs @ .., file] => {
                let file = Self::untokened(file)?;
                let path = if dirs.is_empty() {
                    format!("/{file}")
                } else {
                    format!("/{}/{file}", dirs.join("/"))
                };
                std::fs::metadata(&path)
                    .is_ok_and(|m| m.is_file())
                    .then_some(Target::Spawn(path))
            }
            [id, file] => {
                let id: u64 = id.parse().ok()?;
                self.natives.session(id)?;
                match *file {
                    "in" => Some(Target::In(id)),
                    "out" => Some(Target::Out(id)),
                    "err" => Some(Target::Err(id)),
                    "status" => Some(Target::Status(id)),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn is_dir(&self, path: &Path) -> bool {
        match Self::parts(path).as_slice() {
            [] | ["spawn"] | ["exec"] => true,
            ["exec", rest @ ..] => {
                std::fs::metadata(format!("/{}", rest.join("/"))).is_ok_and(|m| m.is_dir())
            }
            [id] => id
                .parse::<u64>()
                .ok()
                .and_then(|id| self.natives.session(id))
                .is_some(),
            _ => false,
        }
    }
}

impl FileSystem for NativeControl {
    fn readlink(&self, _: &Path) -> virtual_fs::Result<PathBuf> {
        Err(FsError::InvalidInput)
    }
    fn read_dir(&self, path: &Path) -> virtual_fs::Result<ReadDir> {
        let entries: Vec<DirEntry> = match Self::parts(path).as_slice() {
            [] => vec![DirEntry {
                path: Path::new("/spawn").to_path_buf(),
                metadata: Ok(dir_meta()),
            }],
            ["spawn"] => self
                .natives
                .names()
                .map(|name| DirEntry {
                    path: Path::new("/spawn").join(name),
                    metadata: Ok(file_meta()),
                })
                .collect(),
            _ if self.is_dir(path) => Vec::new(),
            _ => return Err(FsError::EntryNotFound),
        };
        Ok(ReadDir::new(entries))
    }
    fn create_dir(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn create_symlink(&self, _: &Path, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn hard_link(&self, _: &Path, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn remove_dir(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn rename<'a>(
        &'a self,
        _: &'a Path,
        _: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        Box::pin(async { Err(FsError::PermissionDenied) })
    }
    fn metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        if self.is_dir(path) {
            Ok(dir_meta())
        } else if self.target(path).is_some() {
            Ok(file_meta())
        } else {
            Err(FsError::EntryNotFound)
        }
    }
    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        self.metadata(path)
    }
    fn remove_file(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for NativeControl {
    fn open(
        &self,
        path: &Path,
        _conf: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        let Some(target) = self.target(path) else {
            return Err(if self.is_dir(path) {
                FsError::NotAFile
            } else {
                FsError::EntryNotFound
            });
        };
        let session = |id| self.natives.session(id).ok_or(FsError::EntryNotFound);
        let file = match target {
            Target::Spawn(name) => NativeFile::Spawn {
                natives: self.natives.clone(),
                name,
                request: Vec::new(),
                answer: None,
                id: None,
            },
            Target::In(id) => NativeFile::In(session(id)?),
            Target::Out(id) => NativeFile::Out(session(id)?),
            Target::Err(id) => NativeFile::Err(session(id)?),
            Target::Status(id) => NativeFile::Status {
                session: session(id)?,
                read: 0,
            },
        };
        Ok(Box::new(file))
    }
}

/// An open file of [`NativeControl`].
#[derive(Debug)]
enum NativeFile {
    Spawn {
        natives: Arc<Natives>,
        name: String,
        request: Vec<u8>,
        /// What reading gives, once the request was acted on.
        answer: Option<io::Cursor<Vec<u8>>>,
        id: Option<u64>,
    },
    In(Arc<Session>),
    Out(Arc<Session>),
    Err(Arc<Session>),
    Status {
        session: Arc<Session>,
        read: usize,
    },
}

impl Drop for NativeFile {
    fn drop(&mut self) {
        match self {
            // The trampoline went: so does its program.
            NativeFile::Spawn {
                natives,
                id: Some(id),
                ..
            } => natives.close(*id),
            NativeFile::In(session) => {
                session
                    .stdin
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
            }
            NativeFile::Out(session) => session.out.end(),
            NativeFile::Err(session) => session.err.end(),
            _ => {}
        }
    }
}

impl NativeFile {
    fn answer(&mut self) -> Option<&mut io::Cursor<Vec<u8>>> {
        let NativeFile::Spawn {
            natives,
            name,
            request,
            answer,
            id,
        } = self
        else {
            return None;
        };
        if answer.is_none() {
            let started = Request::parse(request)
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))
                .and_then(|r| natives.start(name, &r));
            *answer = Some(io::Cursor::new(match started {
                Ok(n) => {
                    *id = Some(n);
                    n.to_string().into_bytes()
                }
                Err(_) => Vec::new(),
            }));
            request.clear();
        }
        answer.as_mut()
    }
}

impl AsyncRead for NativeFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut *self {
            NativeFile::Spawn { .. } => {
                let answer = self.answer().expect("a spawn file");
                let n = Read::read(answer, buf.initialize_unfilled())?;
                buf.advance(n);
                Poll::Ready(Ok(()))
            }
            NativeFile::Out(session) => session.out.poll_read(cx, buf),
            NativeFile::Err(session) => session.err.poll_read(cx, buf),
            NativeFile::Status { session, read } => {
                let mut st = session.status.lock().unwrap_or_else(|e| e.into_inner());
                let Some(text) = &st.text else {
                    st.wakers.push(cx.waker().clone());
                    return Poll::Pending;
                };
                let rest = &text.as_bytes()[(*read).min(text.len())..];
                let n = rest.len().min(buf.remaining());
                buf.put_slice(&rest[..n]);
                *read += n;
                Poll::Ready(Ok(()))
            }
            NativeFile::In(_) => Poll::Ready(Err(io::ErrorKind::PermissionDenied.into())),
        }
    }
}

impl AsyncWrite for NativeFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut *self {
            NativeFile::Spawn {
                request, answer, ..
            } if answer.is_none() => {
                if request.len() + data.len() > MAX_REQUEST {
                    return Poll::Ready(Err(io::ErrorKind::InvalidInput.into()));
                }
                request.extend_from_slice(data);
                Poll::Ready(Ok(data.len()))
            }
            NativeFile::In(session) => {
                if session.stdin_broken.load(Ordering::Acquire) {
                    return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
                }
                let stdin = session.stdin.lock().unwrap_or_else(|e| e.into_inner());
                match stdin.as_ref().map(|tx| tx.send(data.to_vec())) {
                    Some(Ok(())) => Poll::Ready(Ok(data.len())),
                    _ => Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
                }
            }
            _ => Poll::Ready(Err(io::ErrorKind::PermissionDenied.into())),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for NativeFile {
    fn start_seek(self: Pin<&mut Self>, _: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }
    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for NativeFile {
    fn last_accessed(&self) -> u64 {
        0
    }
    fn last_modified(&self) -> u64 {
        0
    }
    fn created_time(&self) -> u64 {
        0
    }
    fn size(&self) -> u64 {
        0
    }
    fn set_len(&mut self, _: u64) -> virtual_fs::Result<()> {
        Ok(())
    }
    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn poll_read_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        match &mut *self {
            NativeFile::Out(session) => session.out.poll_ready(cx),
            NativeFile::Err(session) => session.err.poll_ready(cx),
            NativeFile::Status { session, read } => {
                let mut st = session.status.lock().unwrap_or_else(|e| e.into_inner());
                match &st.text {
                    Some(text) => Poll::Ready(Ok(text.len().saturating_sub(*read))),
                    None => {
                        st.wakers.push(cx.waker().clone());
                        Poll::Pending
                    }
                }
            }
            _ => Poll::Ready(Ok(4096)),
        }
    }
    fn poll_write_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(64 << 10))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_round_trips_and_a_bad_one_is_refused() {
        let request = Request {
            args: vec!["bun".into(), "test".into(), "a b".into()],
            env: vec![
                ("PATH".into(), "/usr/bin".into()),
                ("EMPTY".into(), String::new()),
            ],
            cwd: "/work/repo".into(),
        };
        let bytes = request.encode();
        assert_eq!(Request::parse(&bytes), Some(request));
        assert!(Request::parse(&bytes[..bytes.len() - 1]).is_none());
        assert!(Request::parse(&bytes[..10]).is_none());
        let mut lying = bytes.clone();
        lying[0] = 9;
        assert!(Request::parse(&lying).is_none());
        let mut huge = bytes;
        huge[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(Request::parse(&huge).is_none());
    }

    #[test]
    fn the_trampoline_assembles_for_a_name_and_not_for_a_path() {
        let wasm = trampoline("bun").unwrap();
        assert_eq!(&wasm[..4], b"\0asm");
        assert!(trampoline("../bun").is_none());
        assert!(trampoline("").is_none());
    }

    #[test]
    fn a_spawn_path_names_a_program_and_a_token_of_its_trampolines_own() {
        let control = NativeControl::new(Arc::new(Natives::new([(
            "bun".to_string(),
            PathBuf::from("/usr/local/bin/bun"),
        )])));
        let spawn = |path: &str| match control.target(Path::new(path)) {
            Some(Target::Spawn(name)) => Some(name),
            _ => None,
        };
        assert_eq!(spawn("/spawn/bun@0123456789abcdef"), Some("bun".into()));
        // Without a token, two trampolines would share one handle.
        assert_eq!(spawn("/spawn/bun"), None);
        assert_eq!(spawn("/spawn/bun@"), None);
        assert_eq!(spawn("/spawn/bun@xyz"), None);
        assert_eq!(spawn("/spawn/node@0123"), None);
    }

    /// A program a WASIX process executes by its path takes the token after
    /// its last part, which may itself hold an `@` (a pnpm store path).
    #[test]
    fn an_exec_path_names_a_file_and_a_token_of_its_trampolines_own() {
        let dir = std::env::temp_dir().join(format!("iwci-exec-{}@1.0.0", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("turbo@2");
        std::fs::write(&program, b"\x7fELF").unwrap();
        let control = NativeControl::new(Arc::new(Natives::new([])));
        let exec = |suffix: &str| match control
            .target(Path::new(&format!("/exec{}{suffix}", program.display())))
        {
            Some(Target::Spawn(path)) => Some(path),
            _ => None,
        };
        let path = program.display().to_string();
        assert_eq!(exec("@0123456789abcdef"), Some(path));
        assert_eq!(exec(""), None);
        assert_eq!(exec("@"), None);
        assert_eq!(exec("@xyz"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A native program starts on as many CPUs as the job is told it has,
    /// so `nproc` (its affinity) agrees with what WASIX tells the job's
    /// script; a job without `cpus:` is told 1 whatever the sandbox has.
    #[test]
    fn a_native_program_starts_on_the_cpus_the_job_is_told_it_has() {
        let dir = std::env::temp_dir().join(format!("iwci-told-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let have = std::thread::available_parallelism().map_or(1, |n| n.get());
        for told in [1, 2, 1024] {
            let out = dir.join(format!("nproc-{told}"));
            let natives = Natives::new([]).telling_cpus(told);
            let request = Request {
                args: vec![
                    "sh".into(),
                    "-c".into(),
                    format!("nproc > {}.part && mv {0}.part {0}", out.display()),
                ],
                env: vec![("PATH".into(), "/usr/bin:/bin".into())],
                cwd: "/".into(),
            };
            let id = natives.start("/bin/sh", &request).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !out.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            let seen: usize = std::fs::read_to_string(&out)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert_eq!(seen, (told as usize).min(have), "told {told}");
            natives.close(id);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_runners_node_preload_is_not_given_to_a_native_program() {
        let preload = format!("--require {}/preload.cjs", crate::wasix::NODE_SUPPORT_DIR);
        assert_eq!(without_node_preload(&preload), "");
        assert_eq!(
            without_node_preload(&format!("{preload} --max-old-space-size=100")),
            "--max-old-space-size=100"
        );
    }
}
