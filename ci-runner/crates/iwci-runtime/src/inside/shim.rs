//! The other way round from `natives.rs`: a native program in the job's
//! sandbox running one of the environment's commands (Bun running `bash`,
//! `sh -c`, `node`, `git`, or a `#!/usr/bin/env node` script).
//!
//! Every command of the environment has a native stand-in on the sandbox's
//! `PATH` (`/bin`, `/usr/bin`): the runner's own binary under the command's
//! name, which [`client`] turns into a shim. It connects to the runner in
//! the sandbox over an abstract Unix socket, sends its arguments,
//! environment and working directory (`natives::Request`) with its three
//! standard descriptors, and the runner starts the command as a WASIX
//! process of the job with those as its standard streams. Signals the shim
//! gets are passed on; if the shim itself is killed, so is the command. The
//! shim exits as the command did.

use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use virtual_fs::{Pipe, VirtualFile};
use wasmer_wasix::WasiControlPlane;
use wasmer_wasix::os::task::TaskJoinHandle;
use wasmer_wasix::wasmer_wasix_types::wasi::Signal;

use super::natives::{MAX_REQUEST, Request};

/// The abstract socket name the runner listens on inside the sandbox. A
/// sandbox has a network namespace of its own, so the name is its own.
const SOCKET: &[u8] = b"iwci/shim";

/// Where the runner's binary is inside a sandbox (`sandbox.rs` puts it
/// there), and a file only a sandbox has.
pub(crate) const SANDBOX_RUNNER: &str = "/.iwci/bin/iwci";
pub(crate) const SANDBOX_MARKER: &str = "/.iwci/job/job.json";

/// Whether this process, the binary at `exe`, is the runner's inside a job's
/// sandbox, where `exists` says whether a path is a file.
fn is_sandbox_runner(exe: &std::path::Path, exists: impl Fn(&std::path::Path) -> bool) -> bool {
    exe == std::path::Path::new(SANDBOX_RUNNER) && exists(std::path::Path::new(SANDBOX_MARKER))
}

/// Whether the other end of `conn` is the sandbox's first process (the
/// runner inside), as this process's user.
fn peer_is_runner(conn: &OwnedFd) -> bool {
    // SAFETY: zeroed is a valid ucred; the length matches it.
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: reading our own socket's peer credentials into `cred`.
    let r = unsafe {
        libc::getsockopt(
            conn.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    // SAFETY: a plain query.
    r == 0 && cred.pid == 1 && cred.uid == unsafe { libc::getuid() }
}

/// The standard streams a shim handed over, as WASIX files.
pub(crate) struct Stdio {
    pub(crate) stdin: Box<dyn VirtualFile + Send + Sync + 'static>,
    pub(crate) stdout: Box<dyn VirtualFile + Send + Sync + 'static>,
    pub(crate) stderr: Box<dyn VirtualFile + Send + Sync + 'static>,
}

/// Starts a command for a shim: its handle and its control plane.
pub(crate) type Spawn<'a> =
    dyn Fn(Request, Stdio) -> crate::Result<(TaskJoinHandle, WasiControlPlane)> + Sync + 'a;

/// The commands shims started that are still running, by an id of their
/// own.
#[derive(Default)]
struct Trees {
    running: Mutex<Vec<(u64, WasiControlPlane)>>,
    next: std::sync::atomic::AtomicU64,
}

impl Trees {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(u64, WasiControlPlane)>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn add(&self, tree: WasiControlPlane) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.lock().push((id, tree));
        id
    }

    fn remove(&self, id: u64) {
        self.lock().retain(|(i, _)| *i != id);
    }
}

/// The runner's end: accepts shims until [`Server::stop`].
pub(crate) struct Server {
    listener: OwnedFd,
    stopping: Arc<AtomicBool>,
    trees: Arc<Trees>,
    /// Written on [`Server::stop`], to wake the accepting thread, which
    /// otherwise waits without waking (an idle job uses no CPU).
    wake: OwnedFd,
}

fn abstract_addr() -> (libc::sockaddr_un, libc::socklen_t) {
    // SAFETY: zeroed is a valid sockaddr_un.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (i, b) in SOCKET.iter().enumerate() {
        addr.sun_path[i + 1] = *b as libc::c_char;
    }
    let len = std::mem::size_of::<libc::sa_family_t>() + 1 + SOCKET.len();
    (addr, len as libc::socklen_t)
}

fn socket() -> io::Result<OwnedFd> {
    // SAFETY: plain socket creation.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: just created and ours.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

impl Server {
    /// Listens for shims, starting each one's command with `spawn` on a
    /// thread of `scope`.
    pub(crate) fn start<'scope, 'env>(
        scope: &'scope std::thread::Scope<'scope, 'env>,
        spawn: &'scope Spawn<'env>,
        tokio: tokio::runtime::Handle,
    ) -> io::Result<Server> {
        let listener = socket()?;
        let (addr, len) = abstract_addr();
        // SAFETY: a valid address of `len` bytes.
        let bound = unsafe {
            libc::bind(
                listener.as_raw_fd(),
                (&addr as *const libc::sockaddr_un).cast(),
                len,
            )
        };
        // SAFETY: a bound socket of ours.
        if bound < 0 || unsafe { libc::listen(listener.as_raw_fd(), 64) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut pipe = [0; 2];
        // SAFETY: `pipe` has room for both ends.
        if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both were just created and are ours.
        let (woken, wake) =
            unsafe { (OwnedFd::from_raw_fd(pipe[0]), OwnedFd::from_raw_fd(pipe[1])) };
        let server = Server {
            listener,
            stopping: Arc::default(),
            trees: Arc::default(),
            wake,
        };
        let accepting = server.listener.as_raw_fd();
        let stopping = server.stopping.clone();
        let trees = server.trees.clone();
        std::thread::Builder::new()
            .name("iwci-shims".into())
            .spawn_scoped(scope, move || {
                let woken = woken;
                while !stopping.load(Ordering::Acquire) {
                    let mut fds = [
                        libc::pollfd {
                            fd: accepting,
                            events: libc::POLLIN,
                            revents: 0,
                        },
                        libc::pollfd {
                            fd: woken.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                    ];
                    // SAFETY: two valid pollfds.
                    if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } <= 0 || fds[0].revents == 0 {
                        continue;
                    }
                    // SAFETY: accepting on our listening socket.
                    let conn = unsafe {
                        libc::accept4(
                            accepting,
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                            libc::SOCK_CLOEXEC,
                        )
                    };
                    if conn < 0 {
                        continue;
                    }
                    // SAFETY: just accepted and ours.
                    let conn = unsafe { OwnedFd::from_raw_fd(conn) };
                    let trees = trees.clone();
                    let tokio = tokio.clone();
                    let stopping = stopping.clone();
                    let _ = std::thread::Builder::new()
                        .name("iwci-shim".into())
                        .spawn_scoped(scope, move || {
                            if !stopping.load(Ordering::Acquire) {
                                // The job's files are reached through the
                                // async runtime's I/O.
                                let _enter = tokio.enter();
                                serve(conn, spawn, &trees, &tokio, &stopping);
                            }
                        });
                }
            })?;
        Ok(server)
    }

    /// Stops accepting and kills every command a shim started that is
    /// still running.
    pub(crate) fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        let trees: Vec<(u64, WasiControlPlane)> = self.trees.lock().drain(..).collect();
        for (_, tree) in &trees {
            crate::wasix::for_each_process(tree, |p| p.signal_process(Signal::Sigkill));
        }
        let byte = 1u8;
        // SAFETY: one byte to our own pipe, and shutting down our own socket.
        unsafe {
            libc::write(self.wake.as_raw_fd(), (&byte as *const u8).cast(), 1);
            libc::shutdown(self.listener.as_raw_fd(), libc::SHUT_RDWR);
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Receives a request and the three descriptors that come with it.
fn receive(conn: &OwnedFd) -> io::Result<(Request, [OwnedFd; 3])> {
    let mut first = [0u8; 4];
    let mut control = vec![0u8; iwci_sandbox::lisafs::cmsg_space(3)];
    let mut iov = libc::iovec {
        iov_base: first.as_mut_ptr().cast(),
        iov_len: first.len(),
    };
    // SAFETY: zeroed is a valid msghdr; the buffers outlive the call.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = control.len() as _;
    // SAFETY: as above.
    let n = unsafe {
        libc::recvmsg(
            conn.as_raw_fd(),
            &mut msg,
            libc::MSG_CMSG_CLOEXEC | libc::MSG_WAITALL,
        )
    };
    if n != 4 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    let fds = iwci_sandbox::lisafs::take_rights(&msg, 3);
    let fds: [OwnedFd; 3] = fds
        .try_into()
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let len = u32::from_le_bytes(first) as usize;
    if len > MAX_REQUEST {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut body = vec![0u8; len];
    let mut stream = std::fs::File::from(conn.try_clone()?);
    stream.read_exact(&mut body)?;
    let request =
        Request::parse(&body).ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
    Ok((request, fds))
}

/// A WASIX file whose writes go straight to `fd`, as the program's own
/// would: a full pipe holds the writer up, and a closed one fails its
/// write. (A `virtual_fs::Pipe` read by a thread here could leave the
/// writer waiting for the pipe's lock while that thread waited for more.)
fn writer(fd: OwnedFd) -> Box<dyn VirtualFile + Send + Sync + 'static> {
    Box::new(FdWriter(fd))
}

#[derive(Debug)]
struct FdWriter(OwnedFd);

impl FdWriter {
    fn write_some(&self, buf: &[u8]) -> io::Result<usize> {
        loop {
            // SAFETY: writing bytes we hold to our own descriptor.
            let n = unsafe { libc::write(self.0.as_raw_fd(), buf.as_ptr().cast(), buf.len()) };
            if n >= 0 {
                return Ok(n as usize);
            }
            let e = io::Error::last_os_error();
            if e.kind() != io::ErrorKind::Interrupted {
                return Err(e);
            }
        }
    }
}

impl tokio::io::AsyncRead for FdWriter {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        _: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::task::Poll::Ready(Err(io::ErrorKind::PermissionDenied.into()))
    }
}

impl tokio::io::AsyncWrite for FdWriter {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        std::task::Poll::Ready(self.write_some(buf))
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

impl tokio::io::AsyncSeek for FdWriter {
    fn start_seek(self: std::pin::Pin<&mut Self>, _: io::SeekFrom) -> io::Result<()> {
        Err(io::Error::from_raw_os_error(libc::ESPIPE))
    }
    fn poll_complete(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<u64>> {
        std::task::Poll::Ready(Ok(0))
    }
}

impl VirtualFile for FdWriter {
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
        Err(virtual_fs::FsError::PermissionDenied)
    }
    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }
    fn poll_read_ready(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<usize>> {
        std::task::Poll::Ready(Ok(0))
    }
    fn poll_write_ready(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<usize>> {
        std::task::Poll::Ready(Ok(64 << 10))
    }
}

/// A WASIX file whose reads come from `fd`, through a thread.
fn reader(fd: OwnedFd) -> Box<dyn VirtualFile + Send + Sync + 'static> {
    let (mut tx, rx) = Pipe::new().split();
    let (nothing, _) = closed_pipe().split();
    let _ = std::thread::Builder::new()
        .name("iwci-shim-in".into())
        .spawn(move || {
            let mut input = std::fs::File::from(fd);
            let mut buf = vec![0u8; 64 << 10];
            loop {
                match input.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            tx.close();
        });
    Box::new(Pipe::combine(nothing, rx))
}

fn closed_pipe() -> Pipe {
    let mut pipe = Pipe::new();
    pipe.close();
    pipe
}

/// One shim: its command, run to its end.
fn serve(
    conn: OwnedFd,
    spawn: &Spawn<'_>,
    trees: &Trees,
    tokio: &tokio::runtime::Handle,
    stopping: &AtomicBool,
) {
    let answer = |text: &str| {
        let mut out = std::fs::File::from(match conn.try_clone() {
            Ok(fd) => fd,
            Err(_) => return,
        });
        let _ = out.write_all(text.as_bytes());
    };
    let Ok((request, [stdin, stdout, stderr])) = receive(&conn) else {
        answer("127");
        return;
    };
    let stdio = Stdio {
        stdin: reader(stdin),
        stdout: writer(stdout),
        stderr: writer(stderr),
    };
    let (mut handle, tree) = match spawn(request, stdio) {
        Ok(started) => started,
        Err(_) => {
            answer("127");
            return;
        }
    };
    let id = trees.add(tree.clone());
    // Signals from the shim, until it goes; then the command goes too.
    if let Ok(signals) = conn.try_clone() {
        let tree = tree.clone();
        let _ = std::thread::Builder::new()
            .name("iwci-shim-signals".into())
            .spawn(move || {
                let mut socket = std::fs::File::from(signals);
                let mut byte = [0u8; 1];
                while let Ok(1) = socket.read(&mut byte) {
                    if let Some(signal) = wasi_signal(byte[0]) {
                        crate::wasix::for_each_process(&tree, |p| p.signal_process(signal));
                    }
                }
                crate::wasix::for_each_process(&tree, |p| {
                    if p.try_join().is_none() {
                        p.signal_process(Signal::Sigkill)
                    }
                });
            });
    }
    // Until it ends; once the job is over and its commands were killed, a
    // few seconds more at most, so a command stuck in a host call cannot
    // hold the job's end up.
    let code = tokio.block_on(async {
        let mut finished = Box::pin(handle.wait_finished());
        let mut left = None;
        loop {
            if let Ok(code) = tokio::time::timeout(Duration::from_secs(1), &mut finished).await {
                break Some(code);
            }
            if stopping.load(Ordering::Acquire) {
                let left = left.get_or_insert(5u32);
                *left -= 1;
                if *left == 0 {
                    break None;
                }
            }
        }
    });
    let code = match code {
        Some(Ok(code)) => code.raw(),
        Some(Err(e)) => e.as_exit_code().map_or(1, |c| c.raw()),
        None => 137,
    };
    trees.remove(id);
    answer(&code.to_string());
    // SAFETY: shutting down our own connection, which ends the signal
    // reader.
    unsafe { libc::shutdown(conn.as_raw_fd(), libc::SHUT_RDWR) };
}

/// The WASI signal for a Linux signal number a shim forwards.
fn wasi_signal(linux: u8) -> Option<Signal> {
    Some(match linux {
        1 => Signal::Sighup,
        2 => Signal::Sigint,
        3 => Signal::Sigquit,
        10 => Signal::Sigusr1,
        12 => Signal::Sigusr2,
        15 => Signal::Sigterm,
        _ => return None,
    })
}

/// The signals a shim passes on.
const FORWARDED: [libc::c_int; 6] = [
    libc::SIGHUP,
    libc::SIGINT,
    libc::SIGQUIT,
    libc::SIGUSR1,
    libc::SIGUSR2,
    libc::SIGTERM,
];

/// The connection a shim's signal handler writes to.
static SHIM_SOCKET: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

extern "C" fn forward(signal: libc::c_int) {
    let fd = SHIM_SOCKET.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = signal as u8;
        // SAFETY: write(2) is async-signal-safe; one byte from the stack.
        unsafe { libc::write(fd, (&byte as *const u8).cast(), 1) };
    }
}

/// Runs this process as a shim, when it is one: started under a name other
/// than `iwci`'s inside a job's sandbox, where the runner listens. Its exit
/// code then; `None` for the runner's own command line.
pub fn client() -> Option<i32> {
    // Only the runner's binary at its place in a sandbox, which the kernel
    // names (not the caller), and only where the sandbox's marker is: the
    // runner anywhere else, under whatever name, is never a shim.
    let exe = std::fs::read_link("/proc/self/exe").ok()?;
    if !is_sandbox_runner(&exe, |p| p.is_file()) {
        return None;
    }
    let mut args: Vec<String> = std::env::args_os()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let argv0 = args.first()?.clone();
    let name = argv0.rsplit('/').next().unwrap_or(&argv0).to_string();
    if name.is_empty() || name == "iwci" || name.starts_with("iwci-") {
        return None;
    }
    let conn = socket().ok()?;
    let (addr, len) = abstract_addr();
    // SAFETY: a valid address of `len` bytes.
    let connected = unsafe {
        libc::connect(
            conn.as_raw_fd(),
            (&addr as *const libc::sockaddr_un).cast(),
            len,
        )
    };
    if connected < 0 {
        return None;
    }
    // Nothing is sent to anything but the sandbox's first process, the
    // runner inside, as the same user.
    if !peer_is_runner(&conn) {
        eprintln!("{name}: the job's runner is not what answered");
        return Some(127);
    }
    args[0] = argv0;
    let request = Request {
        args,
        env: std::env::vars_os()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect(),
        cwd: std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".into()),
    };
    let body = request.encode();
    if send(&conn, &body).is_err() {
        eprintln!("{name}: the job's runner did not take the command");
        return Some(127);
    }
    SHIM_SOCKET.store(conn.as_raw_fd(), Ordering::Relaxed);
    for signal in FORWARDED {
        // SAFETY: installing a handler that only writes one byte.
        unsafe { libc::signal(signal, forward as *const () as libc::sighandler_t) };
    }
    let mut reply = Vec::new();
    let mut socket = std::fs::File::from(conn);
    loop {
        let mut buf = [0u8; 32];
        match socket.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => reply.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&reply);
    Some(text.trim().parse().unwrap_or(1))
}

/// Sends the length and `body`, with this process's standard descriptors
/// on the first bytes.
fn send(conn: &OwnedFd, body: &[u8]) -> io::Result<()> {
    let len = (body.len() as u32).to_le_bytes();
    let fds: [RawFd; 3] = [0, 1, 2];
    let mut control = vec![0u8; iwci_sandbox::lisafs::cmsg_space(fds.len())];
    let mut iov = libc::iovec {
        iov_base: len.as_ptr() as *mut _,
        iov_len: len.len(),
    };
    // SAFETY: zeroed is a valid msghdr; the buffers outlive the call.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    iwci_sandbox::lisafs::fill_rights(&mut msg, &mut control, &fds);
    // SAFETY: as above.
    let n = unsafe { libc::sendmsg(conn.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) };
    if n != 4 {
        return Err(io::Error::last_os_error());
    }
    let mut stream = std::fs::File::from(conn.try_clone()?);
    stream.write_all(body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Only the runner's binary at its place in a sandbox, with the
    /// sandbox's marker, is ever a shim: never the runner on its host,
    /// under any name, nor a release being checked before it is run.
    #[test]
    fn only_the_runner_inside_a_sandbox_is_a_shim() {
        let marker = |p: &Path| p == Path::new(SANDBOX_MARKER);
        let none = |_: &Path| false;
        assert!(is_sandbox_runner(Path::new(SANDBOX_RUNNER), marker));
        assert!(!is_sandbox_runner(Path::new(SANDBOX_RUNNER), none));
        for exe in [
            "/opt/iwci/bin/iwci",
            "/opt/iwci/bin/.iwci-0.3.34.new",
            "/usr/bin/git",
            "/tmp/.iwci/bin/iwci",
            "/.iwci/bin/iwci-other",
        ] {
            assert!(!is_sandbox_runner(Path::new(exe), marker), "{exe}");
        }
    }

    /// Outside a sandbox, under a name that is not `iwci`, the shim never
    /// connects, even with something listening where a sandbox's runner
    /// would.
    #[test]
    fn outside_a_sandbox_nothing_connects() {
        let listener = socket().unwrap();
        let (addr, len) = abstract_addr();
        // SAFETY: a valid address of `len` bytes.
        let bound = unsafe {
            libc::bind(
                listener.as_raw_fd(),
                (&addr as *const libc::sockaddr_un).cast(),
                len,
            )
        };
        // Another test binary may hold the name; the check below still
        // holds for this process.
        if bound == 0 {
            // SAFETY: listening on our own bound socket.
            assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 4) }, 0);
        }
        // This test binary is not named `iwci`.
        assert_eq!(client(), None);
        if bound == 0 {
            // Nothing is waiting to be accepted.
            let mut fd = libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: polling our own socket, without waiting.
            let ready = unsafe { libc::poll(&mut fd, 1, 0) };
            assert_eq!(ready, 0, "a shim connected from outside a sandbox");
        }
    }
}
