//! Starting gVisor's kernel (the Sentry) ourselves.
//!
//! `runsc run` always starts gVisor's own gofer for the root file system,
//! which serves a host directory. The job's file system is in the runner's
//! memory, so the runner starts the Sentry the way `runsc` does inside
//! (`runsc/sandbox/sandbox.go`, `createSandboxProcess`), handing it the
//! runner's end of a lisafs connection (`--io-fds`) instead of a gofer's:
//!
//! - in new user, mount, PID, IPC, UTS and network namespaces
//!   (`iwci_sandbox_spawn`), as `nobody` mapped to the runner's user or,
//!   through the sandbox service, to the host user `iwci-sandbox`, with
//!   only the capabilities it needs to build its empty root
//!   (`CAP_SYS_ADMIN`, `CAP_SYS_CHROOT`, `CAP_SETPCAP`);
//!   `boot --setup-root` pivots into an empty read-only
//!   tmpfs and re-executes itself with no capabilities at all, then
//!   installs its seccomp filter before running anything of the job's;
//! - with the OCI spec, the control socket and the job's stdio passed as
//!   descriptors, and no host path the Sentry reads besides its own binary;
//! - started and waited on over the control socket (gVisor's `urpc`, JSON
//!   over a Unix socket), as `runsc start` and `runsc wait` do.
//!
//! These are internal interfaces of the pinned gVisor release: a different
//! release must be checked against them before it is pinned.

use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use iwci_sandbox_spawn::boot::Boot;
use iwci_sandbox_spawn::client::{self, Remote};
use iwci_sandbox_spawn::spawn::{Namespaces, spawn};
use serde_json::{Value, json};

/// gVisor's release, unpacked: `runsc` and `gvisor-bin/`.
#[derive(Debug, Clone)]
pub struct Release {
    pub dir: PathBuf,
    /// The socket of the service that starts the Sentry in its namespaces
    /// for the runner (`iwci_sandbox_spawn::service`), where the runner may
    /// not make user namespaces itself; it starts only its own pinned
    /// Sentry. Without one the runner starts the Sentry itself.
    pub service: Option<PathBuf>,
}

impl Release {
    fn sentry(&self) -> PathBuf {
        self.dir.join("gvisor-bin/gvisor_sentry")
    }

    fn proc_umounter(&self) -> PathBuf {
        self.dir.join("gvisor-bin/gvisor-proc-umounter")
    }
}

/// One sandbox to start.
#[derive(Debug, Clone)]
pub struct Config {
    /// The container id, `[A-Za-z0-9_.-]`.
    pub id: String,
    /// A private directory for the bundle and the control socket. Its path
    /// must leave room for a socket name (Unix socket paths are at most
    /// 107 bytes).
    pub state_dir: PathBuf,
    /// The job's process: arguments, `KEY=value` environment and working
    /// directory, as the sandbox sees them.
    pub args: Vec<String>,
    pub env: Vec<String>,
    pub cwd: String,
    /// gVisor's platform: `systrap` everywhere we run.
    pub platform: String,
    /// CPUs and memory the sandbox reports to the job.
    pub cpus: u32,
    pub memory_bytes: u64,
    /// Extra global flags for the Sentry (`--debug`, `--strace`, ...).
    pub extra_flags: Vec<String>,
    /// The cgroup the Sentry runs in (`crate::cgroup`), joined before it
    /// runs anything, so everything it does is counted there.
    pub cgroup: Option<PathBuf>,
}

/// A file system mounted in the sandbox besides its root: one more lisafs
/// connection, whose other end the runner serves.
#[derive(Debug)]
pub struct Mount {
    /// Where it appears, an absolute path.
    pub destination: String,
    /// The sandbox may not change it (the server refuses too).
    pub read_only: bool,
    /// The sandbox's end of the connection.
    pub gofer: OwnedFd,
}

/// A started (not yet running) sandbox.
#[derive(Debug)]
pub struct Sandbox {
    process: Process,
    id: String,
    control: PathBuf,
    /// The sandbox's end of its network link, handed over at start.
    link: Option<OwnedFd>,
    /// The answer to the one `Wait` call made once the job started, from
    /// the thread that waits for it: one call for the whole job, so waiting
    /// costs the sandbox nothing however long the job runs.
    waiter: Option<std::sync::mpsc::Receiver<io::Result<Value>>>,
}

/// The Sentry's process: the runner's own child, or one the sandbox service
/// started and watches.
#[derive(Debug)]
enum Process {
    Child { pid: libc::pid_t, reaped: bool },
    Service(Remote),
}

impl Process {
    fn pid(&self) -> libc::pid_t {
        match self {
            Self::Child { pid, .. } => *pid,
            Self::Service(remote) => remote.pid(),
        }
    }

    /// Its wait status, if it has ended (and was not collected before).
    fn try_wait(&mut self) -> Option<i32> {
        match self {
            Self::Child { pid, reaped } => {
                if *reaped {
                    return None;
                }
                let mut status = 0;
                // SAFETY: polling our own child.
                let r = unsafe { libc::waitpid(*pid, &mut status, libc::WNOHANG) };
                (r == *pid).then(|| {
                    *reaped = true;
                    status
                })
            }
            Self::Service(remote) => remote.try_wait().map(|s| s.unwrap_or(-1)),
        }
    }

    /// Waits for it: its wait status, if it was ours to collect.
    fn wait(&mut self) -> Option<i32> {
        match self {
            Self::Child { pid, reaped } => {
                if *reaped {
                    return None;
                }
                let mut status = 0;
                let r = loop {
                    // SAFETY: waiting on our own child.
                    let r = unsafe { libc::waitpid(*pid, &mut status, 0) };
                    if r >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                        break r;
                    }
                };
                *reaped = true;
                (r == *pid).then_some(status)
            }
            Self::Service(remote) => remote.wait(),
        }
    }

    /// Stops it at once and collects it.
    fn kill(&mut self) {
        match self {
            Self::Child { pid, reaped } => {
                if !*reaped {
                    // SAFETY: signalling our own child, which has not been
                    // reaped, so the pid is still its.
                    unsafe { libc::kill(*pid, libc::SIGKILL) };
                }
            }
            Self::Service(remote) => {
                remote.kill();
                return;
            }
        }
        self.wait();
    }
}

/// How long starting a sandbox may take before the runner gives up on it.
const START_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// The mount type that keeps gVisor's tmpfs off `/tmp`: see [`spec`].
const JOB_FS_TYPE: &str = "iwci-job-fs";

/// The OCI spec for `config`.
///
/// `/tmp` is listed as a mount of a type gVisor does not know. That type
/// is skipped when mounts are made, but its presence stops gVisor from
/// mounting a tmpfs of its own over an empty `/tmp` (`mountTmp` in
/// `runsc/boot/vfs.go`), so `/tmp` stays the job's, as under WASIX: what a
/// job writes there is counted against its memory and can be cached.
pub fn spec(config: &Config) -> Value {
    spec_with(config, &[])
}

/// [`spec`] with `mounts` as bind mounts after the system's, in order: the
/// Sentry asks for one lisafs connection per bind mount, after the root's.
fn spec_with(config: &Config, mounts: &[(&str, bool)]) -> Value {
    let caps = [
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_FOWNER",
        "CAP_FSETID",
        "CAP_KILL",
        "CAP_SETGID",
        "CAP_SETUID",
        "CAP_SETPCAP",
        "CAP_NET_BIND_SERVICE",
        "CAP_SYS_CHROOT",
        "CAP_MKNOD",
        "CAP_AUDIT_WRITE",
        "CAP_SETFCAP",
    ];
    let mut spec = json!({
        "ociVersion": "1.0.2",
        "process": {
            "terminal": false,
            "user": { "uid": 0, "gid": 0 },
            "args": config.args,
            "env": config.env,
            "cwd": config.cwd,
            "capabilities": {
                "bounding": caps,
                "effective": caps,
                "permitted": caps,
            },
            "rlimits": [{ "type": "RLIMIT_NOFILE", "hard": 1048576, "soft": 1048576 }],
            "noNewPrivileges": true,
        },
        "root": { "path": "rootfs", "readonly": false },
        "hostname": "iwci",
        "mounts": [
            { "destination": "/proc", "type": "proc", "source": "proc" },
            { "destination": "/dev", "type": "tmpfs", "source": "tmpfs",
              "options": ["nosuid", "strictatime", "mode=755", "size=65536k"] },
            { "destination": "/dev/pts", "type": "devpts", "source": "devpts",
              "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"] },
            { "destination": "/dev/shm", "type": "tmpfs", "source": "shm",
              "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"] },
            { "destination": "/sys", "type": "sysfs", "source": "sysfs",
              "options": ["nosuid", "noexec", "nodev", "ro"] },
            { "destination": "/tmp", "type": JOB_FS_TYPE, "source": "none" },
        ],
        "linux": {
            "namespaces": [
                { "type": "pid" }, { "type": "network" }, { "type": "ipc" },
                { "type": "uts" }, { "type": "mount" },
            ],
        },
    });
    if let Some(list) = spec["mounts"].as_array_mut() {
        for (destination, read_only) in mounts {
            list.push(json!({
                "destination": destination,
                "type": "bind",
                "source": destination,
                "options": [if *read_only { "ro" } else { "rw" }, "rbind"],
            }));
        }
    }
    spec
}

/// Starts the Sentry for `config` with `gofer` as the root file system's
/// lisafs connection and `stdio` as the job's standard streams. `log` is
/// the Sentry's own standard output and error. `link`, the sandbox's end
/// of a [`crate::net::Gateway`], is its network; without one it has only
/// its loopback. The job does not run until [`Sandbox::start`].
#[allow(clippy::too_many_arguments)]
pub fn boot(
    release: &Release,
    config: &Config,
    gofer: OwnedFd,
    stdio: [OwnedFd; 3],
    log: OwnedFd,
    link: Option<OwnedFd>,
) -> io::Result<Sandbox> {
    boot_with(release, config, gofer, Vec::new(), stdio, log, link)
}

/// [`boot`] with more file systems than the root, each over a lisafs
/// connection of its own.
#[allow(clippy::too_many_arguments)]
pub fn boot_with(
    release: &Release,
    config: &Config,
    gofer: OwnedFd,
    mounts: Vec<Mount>,
    stdio: [OwnedFd; 3],
    log: OwnedFd,
    link: Option<OwnedFd>,
) -> io::Result<Sandbox> {
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(&config.state_dir)?;
    let spec_path = config.state_dir.join("config.json");
    let listed: Vec<(&str, bool)> = mounts
        .iter()
        .map(|m| (m.destination.as_str(), m.read_only))
        .collect();
    fs::write(&spec_path, serde_json::to_vec(&spec_with(config, &listed))?)?;
    let spec_file = fs::File::open(&spec_path)?;
    let control = config.state_dir.join("control.sock");
    let _ = fs::remove_file(&control);
    let listener = UnixListener::bind(&control)?;
    let umounter = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH)
        .open(release.proc_umounter())?;
    let null = fs::File::open("/dev/null")?;

    // What the Sentry gets, at the numbers `Boot` lays out.
    let boot = Boot {
        id: config.id.clone(),
        state_dir: config.state_dir.clone(),
        platform: config.platform.clone(),
        network: link.is_some(),
        mounts: 1 + mounts.len(),
        cpus: config.cpus.max(1),
        memory: config.memory_bytes,
        flags: config.extra_flags.clone(),
    };
    boot.check().map_err(io::Error::other)?;
    let log_copy = dup(&log)?;
    let mut fds: Vec<OwnedFd> = vec![null.into(), dup(&log)?, log];
    fds.push(spec_file.into());
    fds.push(listener.into());
    fds.push(gofer);
    fds.extend(mounts.into_iter().map(|m| m.gofer));
    fds.push(umounter.into());
    // The Sentry re-executes itself inside an empty root, where it can
    // open nothing: its logs go to a descriptor.
    fds.push(log_copy);
    fds.extend(stdio);
    debug_assert_eq!(fds.len(), boot.descriptors());

    let sentry = release.sentry();
    let process = match &release.service {
        None => {
            let procs = match &config.cgroup {
                Some(dir) => Some(
                    fs::OpenOptions::new()
                        .write(true)
                        .open(dir.join("cgroup.procs"))?,
                ),
                None => None,
            };
            Process::Child {
                pid: spawn(
                    &sentry,
                    &boot.sentry_args(host_memory()),
                    &Boot::env(),
                    fds,
                    procs.as_ref(),
                    Namespaces::as_caller(),
                )?,
                reaped: false,
            }
        }
        // The service builds the Sentry's command line itself, and starts
        // only its pinned Sentry; a root runner (the tests) may name this
        // one, which the pins still hold to.
        Some(socket) => {
            // SAFETY: a plain query.
            let root = unsafe { libc::getuid() } == 0;
            let cgroup = match &config.cgroup {
                Some(dir) => Some(
                    fs::OpenOptions::new()
                        .read(true)
                        .custom_flags(libc::O_DIRECTORY)
                        .open(dir)?,
                ),
                None => None,
            };
            let raw: Vec<RawFd> = fds.iter().map(|f| f.as_raw_fd()).collect();
            let remote = client::start(
                socket,
                &boot,
                root.then_some(sentry.as_path()),
                &raw,
                cgroup.as_ref().map(|c| c.as_raw_fd()),
            )?;
            drop(fds);
            Process::Service(remote)
        }
    };
    Ok(Sandbox {
        process,
        id: config.id.clone(),
        control,
        link,
        waiter: None,
    })
}

fn host_memory() -> u64 {
    // SAFETY: plain queries.
    let (pages, size) = unsafe {
        (
            libc::sysconf(libc::_SC_PHYS_PAGES),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    (pages.max(0) as u64) * (size.max(0) as u64)
}

impl Sandbox {
    /// The Sentry's process id, in the runner's PID namespace.
    pub fn pid(&self) -> libc::pid_t {
        self.process.pid()
    }

    /// Configures the sandbox's network (loopback only) and starts the
    /// job's process.
    pub fn start(&mut self) -> io::Result<()> {
        self.configure_and_start()
            .map_err(|e| match self.exited() {
                Some(status) => {
                    io::Error::other(format!("{e} (the sandbox exited: {})", describe(status)))
                }
                None => e,
            })?;
        let (tx, rx) = std::sync::mpsc::channel();
        let control = self.control.clone();
        let id = self.id.clone();
        std::thread::Builder::new()
            .name("iwci-sandbox-wait".into())
            .spawn(move || {
                let _ = tx.send(call(
                    &control,
                    "containerManager.Wait",
                    json!(id),
                    &[],
                    None,
                ));
            })?;
        self.waiter = Some(rx);
        Ok(())
    }

    /// The sandbox's wait status, if it has exited.
    fn exited(&mut self) -> Option<i32> {
        self.process.try_wait()
    }

    fn configure_and_start(&self) -> io::Result<()> {
        let mut args = json!({
            "LoopbackLinks": [{
                "Name": "lo",
                "Multicast": false,
                "Addresses": [
                    { "Address": "127.0.0.1", "PrefixLen": 8 },
                    { "Address": "::1", "PrefixLen": 128 },
                ],
                "Routes": [
                    { "Destination": { "IP": "127.0.0.0", "Mask": "/wAAAA==" }, "Gateway": "", "MTU": 0 },
                    { "Destination": { "IP": "::1", "Mask": "/////////////////////w==" }, "Gateway": "", "MTU": 0 },
                ],
                "GVisorGRO": false,
            }],
        });
        let fds: Vec<RawFd> = self.link.iter().map(|l| l.as_raw_fd()).collect();
        if !fds.is_empty() {
            args["FDBasedLinks"] = json!([link_args()]);
            args["Defaultv4Gateway"] = json!({
                "Name": "eth0",
                "Route": {
                    "Destination": { "IP": "0.0.0.0", "Mask": mask(0, 4) },
                    "Gateway": crate::net::GATEWAY_V4.to_string(),
                    "MTU": 0,
                },
            });
            args["Defaultv6Gateway"] = json!({
                "Name": "eth0",
                "Route": {
                    "Destination": { "IP": "::", "Mask": mask(0, 16) },
                    "Gateway": crate::net::GATEWAY_V6.to_string(),
                    "MTU": 0,
                },
            });
        }
        self.call_full(
            "containerManager.SetNetworkArgs",
            args,
            &fds,
            Some(START_LIMIT),
        )?;
        self.call_full(
            "containerManager.StartRoot",
            json!(self.id),
            &[],
            Some(START_LIMIT),
        )?;
        Ok(())
    }

    /// Waits for the job's process to end: its wait status.
    pub fn wait(&mut self) -> io::Result<i32> {
        self.wait_for(None)?
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
    }

    /// [`Sandbox::wait`], giving up after `limit`: `None` if the job is
    /// still running, which the caller then stops (a timeout, a cancel, a
    /// drain).
    pub fn wait_for(&mut self, limit: Option<std::time::Duration>) -> io::Result<Option<i32>> {
        let deadline = limit.map(|l| std::time::Instant::now() + l);
        let Some(waiter) = self.waiter.take() else {
            return Err(io::Error::other("the sandbox was not started"));
        };
        loop {
            let step = match deadline {
                Some(at) => at
                    .saturating_duration_since(std::time::Instant::now())
                    .min(WAIT_STEP),
                None => WAIT_STEP,
            };
            match waiter.recv_timeout(step) {
                Ok(Ok(status)) => {
                    let status = status
                        .as_u64()
                        .ok_or_else(|| io::Error::other(format!("a wait status of {status}")))?;
                    self.reap();
                    return Ok(Some(status as i32));
                }
                // The Sentry itself went (killed for memory, or by a
                // signal) before it answered: its own wait status says how.
                Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Ok(Some(self.reap().unwrap_or(-1)));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Some(status) = self.exited() {
                return Ok(Some(status));
            }
            if deadline.is_some_and(|at| std::time::Instant::now() >= at) {
                self.waiter = Some(waiter);
                return Ok(None);
            }
        }
    }

    /// Stops the sandbox at once.
    pub fn kill(&mut self) {
        self.process.kill();
    }

    /// Waits for the Sentry's process: its wait status, if it was ours to
    /// collect.
    fn reap(&mut self) -> Option<i32> {
        self.process.wait()
    }

    fn call_full(
        &self,
        method: &str,
        arg: Value,
        fds: &[RawFd],
        limit: Option<std::time::Duration>,
    ) -> io::Result<Value> {
        call(&self.control, method, arg, fds, limit)
    }
}

/// One call to the Sentry's control server: its result. Descriptors
/// (urpc's `FilePayload`) ride the first bytes of the request; with a
/// `limit`, a call that takes longer fails.
fn call(
    control: &Path,
    method: &str,
    arg: Value,
    fds: &[RawFd],
    limit: Option<std::time::Duration>,
) -> io::Result<Value> {
    let mut stream = UnixStream::connect(control)?;
    stream.set_read_timeout(limit)?;
    let request = serde_json::to_vec(&json!({ "method": method, "arg": arg }))?;
    let mut sent = 0;
    if !fds.is_empty() {
        sent = send_with_fds(stream.as_raw_fd(), &request, fds)?;
    }
    stream.write_all(&request[sent..])?;
    let reply: Value = read_json(&mut stream)?;
    if reply.get("success").and_then(Value::as_bool) != Some(true) {
        let err = reply
            .get("err")
            .and_then(Value::as_str)
            .unwrap_or("no reason given");
        return Err(io::Error::other(format!("{method}: {err}")));
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

/// How often a wait looks at the Sentry's own process while it waits for
/// the job's answer.
const WAIT_STEP: std::time::Duration = std::time::Duration::from_millis(100);

fn describe(status: i32) -> String {
    if libc::WIFEXITED(status) {
        format!("exit {}", libc::WEXITSTATUS(status))
    } else if libc::WIFSIGNALED(status) {
        format!("signal {}", libc::WTERMSIG(status))
    } else {
        format!("status {status}")
    }
}

/// The sandbox's interface on its link: raw IP packets (no link-layer
/// address, so no Ethernet header), one per message, the gateway's prefix.
fn link_args() -> Value {
    use crate::net::{MTU, PREFIX_V4, PREFIX_V6, SANDBOX_V4, SANDBOX_V6};
    let v4_net = std::net::Ipv4Addr::from(u32::from(SANDBOX_V4) & (u32::MAX << (32 - PREFIX_V4)));
    let v6_net =
        std::net::Ipv6Addr::from(u128::from(SANDBOX_V6) & (u128::MAX << (128 - PREFIX_V6)));
    json!({
        "Name": "eth0",
        "InterfaceIndex": 0,
        "MTU": MTU,
        "Multicast": false,
        "Addresses": [
            { "Address": SANDBOX_V4.to_string(), "PrefixLen": PREFIX_V4 },
            { "Address": SANDBOX_V6.to_string(), "PrefixLen": PREFIX_V6 },
        ],
        "Routes": [
            { "Destination": { "IP": v4_net.to_string(), "Mask": mask(PREFIX_V4, 4) }, "Gateway": "", "MTU": 0 },
            { "Destination": { "IP": v6_net.to_string(), "Mask": mask(PREFIX_V6, 16) }, "Gateway": "", "MTU": 0 },
        ],
        "GSOMaxSize": 0,
        "GVisorGSOEnabled": false,
        "GVisorGRO": false,
        "TXChecksumOffload": false,
        "RXChecksumOffload": false,
        "LinkAddress": null,
        "QDisc": 0,
        "NumChannels": 1,
        "ProcessorsPerChannel": 0,
        // A socket pair, not a packet socket: nothing to ask the host.
        "IsPacket": [false],
        "PreConfigured": true,
        "IsProxy": false,
    })
}

/// A prefix as Go's `net.IPMask` marshals it: the mask's bytes, base64.
fn mask(prefix: u8, bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    for (i, b) in raw.iter_mut().enumerate() {
        let bits = (prefix as usize).saturating_sub(i * 8).min(8);
        *b = if bits == 0 { 0 } else { 0xffu8 << (8 - bits) };
    }
    base64(&raw)
}

fn base64(raw: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in raw.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Sends `bytes` with `fds` attached; how many bytes went.
fn send_with_fds(sock: RawFd, bytes: &[u8], fds: &[RawFd]) -> io::Result<usize> {
    let mut control = vec![0u8; crate::lisafs::cmsg_space(fds.len())];
    let mut iov = libc::iovec {
        iov_base: bytes.as_ptr() as *mut _,
        iov_len: bytes.len(),
    };
    // SAFETY: zeroed is a valid msghdr; it points at buffers that outlive
    // the call.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    crate::lisafs::fill_rights(&mut msg, &mut control, fds);
    // SAFETY: as above.
    let n = unsafe { libc::sendmsg(sock, &msg, libc::MSG_NOSIGNAL) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n as usize)
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Reads one JSON value off `stream` (urpc sends no length).
fn read_json(stream: &mut UnixStream) -> io::Result<Value> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 4096];
    loop {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&byte[..n]);
        let mut values = serde_json::Deserializer::from_slice(&buf).into_iter::<Value>();
        match values.next() {
            Some(Ok(value)) => return Ok(value),
            Some(Err(e)) if e.is_eof() => continue,
            Some(Err(e)) => return Err(e.into()),
            None => continue,
        }
    }
}

fn dup(fd: &OwnedFd) -> io::Result<OwnedFd> {
    fd.try_clone()
}
