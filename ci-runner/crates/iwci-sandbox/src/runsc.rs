//! Starting gVisor's kernel (the Sentry) ourselves.
//!
//! `runsc run` always starts gVisor's own gofer for the root file system,
//! which serves a host directory. The job's file system is in the runner's
//! memory, so the runner starts the Sentry the way `runsc` does inside
//! (`runsc/sandbox/sandbox.go`, `createSandboxProcess`), handing it the
//! runner's end of a lisafs connection (`--io-fds`) instead of a gofer's:
//!
//! - in new user, mount, PID, IPC, UTS and network namespaces, as
//!   `nobody` mapped to the runner's user, with only the capabilities it
//!   needs to build its empty root (`CAP_SYS_ADMIN`, `CAP_SYS_CHROOT`,
//!   `CAP_SETPCAP`); `boot --setup-root` pivots into an empty read-only
//!   tmpfs and re-executes itself with no capabilities at all, then
//!   installs its seccomp filter before running anything of the job's;
//! - with the OCI spec, the control socket and the job's stdio passed as
//!   descriptors, and no host path the Sentry reads besides its own binary;
//! - started and waited on over the control socket (gVisor's `urpc`, JSON
//!   over a Unix socket), as `runsc start` and `runsc wait` do.
//!
//! These are internal interfaces of the pinned gVisor release: a different
//! release must be checked against them before it is pinned.

use std::ffi::{CString, c_char, c_int, c_void};
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// gVisor's release, unpacked: `runsc` and `gvisor-bin/`.
#[derive(Debug, Clone)]
pub struct Release {
    pub dir: PathBuf,
    /// The program that starts the Sentry in its namespaces for the runner
    /// ([`crate::helper`]), when the runner may not create them itself: a
    /// host that keeps user namespaces from unprivileged programs lets this
    /// one, root-owned program create them, and nothing else. Without one
    /// the runner creates them itself.
    pub helper: Option<PathBuf>,
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
    pid: libc::pid_t,
    id: String,
    control: PathBuf,
    reaped: bool,
    /// The sandbox's end of its network link, handed over at start.
    link: Option<OwnedFd>,
    /// The answer to the one `Wait` call made once the job started, from
    /// the thread that waits for it: one call for the whole job, so waiting
    /// costs the sandbox nothing however long the job runs.
    waiter: Option<std::sync::mpsc::Receiver<io::Result<Value>>>,
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

    // What the Sentry gets, at fixed descriptor numbers from 3 up.
    let log_copy = dup(&log)?;
    let mut fds: Vec<OwnedFd> = vec![null.into(), dup(&log)?, log];
    let mut next = 3;
    let mut give = |fd: OwnedFd, fds: &mut Vec<OwnedFd>| {
        fds.push(fd);
        next += 1;
        next - 1
    };
    let spec_fd = give(spec_file.into(), &mut fds);
    let controller_fd = give(listener.into(), &mut fds);
    let mut io_fds = vec![give(gofer, &mut fds)];
    for mount in mounts {
        io_fds.push(give(mount.gofer, &mut fds));
    }
    let umounter_fd = give(umounter.into(), &mut fds);
    // The Sentry re-executes itself inside an empty root, where it can
    // open nothing: its logs go to a descriptor.
    let log_fd = give(log_copy, &mut fds);
    let [stdin, stdout, stderr] = stdio;
    let stdio_fds = [
        give(stdin, &mut fds),
        give(stdout, &mut fds),
        give(stderr, &mut fds),
    ];

    let mut args: Vec<String> = vec![
        "runsc-sandbox".into(),
        format!("--root={}", config.state_dir.display()),
        format!("--platform={}", config.platform),
        // With a link, the sandbox's stack gets an interface on it
        // (`crate::net`); without one, only its loopback.
        if link.is_some() {
            "--network=sandbox".into()
        } else {
            "--network=none".into()
        },
        "--file-access=exclusive".into(),
        // The other mounts are the runner's too, and nothing else changes
        // them while the sandbox runs; without it the Sentry cannot map
        // their files, so no program could be run from one.
        "--file-access-mounts=exclusive".into(),
        // No host file access at all: directfs would have the Sentry open
        // host files itself, through descriptors a gofer donates.
        "--directfs=false".into(),
        format!("--log-fd={log_fd}"),
        format!("--debug-log-fd={log_fd}"),
        format!("--panic-log-fd={log_fd}"),
    ];
    args.extend(config.extra_flags.iter().cloned());
    args.extend([
        "boot".into(),
        format!("--bundle={}", config.state_dir.display()),
        format!("--spec-fd={spec_fd}"),
        format!("--controller-fd={controller_fd}"),
        format!(
            "--io-fds={}",
            io_fds
                .iter()
                .map(|fd| fd.to_string())
                .collect::<Vec<_>>()
                .join(",")
        ),
        format!(
            "--gofer-mount-confs={}",
            vec!["lisafs:none"; io_fds.len()].join(",")
        ),
        format!(
            "--stdio-fds={},{},{}",
            stdio_fds[0], stdio_fds[1], stdio_fds[2]
        ),
        "--setup-root".into(),
        format!("--proc-umounter-fd={umounter_fd}"),
        format!("--cpu-num={}", config.cpus.max(1)),
        format!("--total-memory={}", config.memory_bytes),
        format!("--total-host-memory={}", host_memory()),
        "--attached".into(),
        config.id.clone(),
    ]);
    let env = vec!["GODEBUG=".to_string(), "TMPDIR=/tmp".to_string()];
    let sentry = release.sentry();
    let pid = match &release.helper {
        None => spawn(
            &sentry,
            &args,
            &env,
            fds,
            config.cgroup.as_deref(),
            Namespaces::New,
        )?,
        Some(helper) => {
            let mut through = crate::helper::args(&sentry, fds.len());
            through.extend(args);
            spawn(
                helper,
                &through,
                &env,
                fds,
                config.cgroup.as_deref(),
                Namespaces::Same,
            )?
        }
    };
    Ok(Sandbox {
        pid,
        id: config.id.clone(),
        control,
        reaped: false,
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
    /// The Sentry's process id, in the runner's PID namespace (the
    /// helper's, with a [`Release::helper`], whose only child it is).
    pub fn pid(&self) -> libc::pid_t {
        self.pid
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
        if self.reaped {
            return None;
        }
        let mut status = 0;
        // SAFETY: polling our own child.
        let r = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if r == self.pid {
            self.reaped = true;
            return Some(status);
        }
        None
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
        if !self.reaped {
            // SAFETY: signalling our own child, which has not been reaped,
            // so the pid is still its.
            unsafe { libc::kill(self.pid, libc::SIGKILL) };
        }
        self.reap();
    }

    /// Waits for the Sentry's process: its wait status, if it was ours to
    /// collect.
    fn reap(&mut self) -> Option<i32> {
        if self.reaped {
            return None;
        }
        let mut status = 0;
        let r = loop {
            // SAFETY: waiting on our own child.
            let r = unsafe { libc::waitpid(self.pid, &mut status, 0) };
            if r >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break r;
            }
        };
        self.reaped = true;
        (r == self.pid).then_some(status)
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

/// What the child needs, prepared before `clone` so that it allocates
/// nothing (it is a copy of a multi-threaded process).
struct Child {
    sync: RawFd,
    /// The binary, opened `O_PATH` by the runner: the child, once it is
    /// `nobody`, may not be able to reach it by path.
    exe: RawFd,
    argv: *const *const c_char,
    envp: *const *const c_char,
    /// (from, to) pairs; every `from` is above every `to`.
    fds: *const (RawFd, RawFd),
    nfds: usize,
    namespaces: Namespaces,
}

/// Where [`spawn`] starts its program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Namespaces {
    /// In new user, mount, PID, IPC, UTS and network namespaces, as the
    /// mapped `nobody` with [`CAPS`]: the Sentry.
    New,
    /// In the runner's own, as the runner: the helper, which makes them.
    Same,
}

/// The capabilities the Sentry starts with: what building its empty root
/// takes. It drops them all before it runs anything of the job's.
const CAPS: [u32; 3] = [
    21, // CAP_SYS_ADMIN
    18, // CAP_SYS_CHROOT
    8,  // CAP_SETPCAP
];

/// Starts `exe` with `fds` as its descriptors 0, 1, 2, ..., in
/// `namespaces`; its pid.
pub(crate) fn spawn(
    exe: &Path,
    args: &[String],
    env: &[String],
    fds: Vec<OwnedFd>,
    cgroup: Option<&Path>,
    namespaces: Namespaces,
) -> io::Result<libc::pid_t> {
    let exe_fd = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH)
        .open(exe)?;
    spawn_fd(exe_fd, args, env, fds, cgroup, namespaces)
}

/// [`spawn`] with the program already open (`O_PATH`).
pub(crate) fn spawn_fd(
    exe_fd: fs::File,
    args: &[String],
    env: &[String],
    fds: Vec<OwnedFd>,
    cgroup: Option<&Path>,
    namespaces: Namespaces,
) -> io::Result<libc::pid_t> {
    let cstr = |s: &[u8]| CString::new(s).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput));
    let args_c = args
        .iter()
        .map(|a| cstr(a.as_bytes()))
        .collect::<io::Result<Vec<_>>>()?;
    let env_c = env
        .iter()
        .map(|e| cstr(e.as_bytes()))
        .collect::<io::Result<Vec<_>>>()?;
    let mut argv: Vec<*const c_char> = args_c.iter().map(|a| a.as_ptr()).collect();
    argv.push(std::ptr::null());
    let mut envp: Vec<*const c_char> = env_c.iter().map(|e| e.as_ptr()).collect();
    envp.push(std::ptr::null());

    // Move every descriptor well above the numbers it is going to, so the
    // child's dup2s never overwrite one not yet moved, nor the program,
    // which it runs after them.
    let raise = |fd: RawFd| -> io::Result<OwnedFd> {
        // SAFETY: duplicating a descriptor we hold; checked below.
        let raw = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 512) };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: just created and ours.
        Ok(unsafe { OwnedFd::from_raw_fd(raw) })
    };
    let high: Vec<OwnedFd> = fds
        .iter()
        .map(|fd| raise(fd.as_raw_fd()))
        .collect::<io::Result<_>>()?;
    let exe_fd = raise(exe_fd.as_raw_fd())?;
    drop(fds);
    let pairs: Vec<(RawFd, RawFd)> = high
        .iter()
        .enumerate()
        .map(|(to, fd)| (fd.as_raw_fd(), to as RawFd))
        .collect();

    let mut sync = [0 as RawFd; 2];
    // SAFETY: `sync` has room for both ends.
    if unsafe { libc::pipe2(sync.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both were just created and are ours.
    let (sync_r, sync_w) =
        unsafe { (OwnedFd::from_raw_fd(sync[0]), OwnedFd::from_raw_fd(sync[1])) };

    let child = Child {
        sync: sync_r.as_raw_fd(),
        exe: exe_fd.as_raw_fd(),
        argv: argv.as_ptr(),
        envp: envp.as_ptr(),
        fds: pairs.as_ptr(),
        nfds: pairs.len(),
        namespaces,
    };
    let flags = match namespaces {
        Namespaces::New => {
            libc::CLONE_NEWUSER
                | libc::CLONE_NEWNS
                | libc::CLONE_NEWPID
                | libc::CLONE_NEWIPC
                | libc::CLONE_NEWUTS
                | libc::CLONE_NEWNET
        }
        Namespaces::Same => 0,
    };
    let mut stack = vec![0u8; 256 * 1024];
    // SAFETY: the stack grows down from its end, aligned to 16; `child`
    // and everything it points to outlive the call, and the child gets a
    // copy of this address space, not a share of it.
    let pid = unsafe {
        let top = stack.as_mut_ptr().add(stack.len());
        let top = top.sub(top as usize % 16);
        libc::clone(
            run_child,
            top.cast(),
            flags | libc::SIGCHLD,
            (&child as *const Child).cast_mut().cast(),
        )
    };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    drop(sync_r);
    // Into its cgroup while it still waits for its user to be mapped, so
    // it has run nothing outside it.
    let joined = match cgroup {
        Some(dir) => fs::write(dir.join("cgroup.procs"), pid.to_string()),
        None => Ok(()),
    };
    let mapped = joined
        .and_then(|()| match namespaces {
            Namespaces::New => map_user(pid),
            Namespaces::Same => Ok(()),
        })
        .and_then(|()| {
            let mut w = fs::File::from(sync_w);
            w.write_all(&[1])
        });
    if let Err(e) = mapped {
        // SAFETY: our own child; reaped right after.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        return Err(e);
    }
    drop(high);
    drop(exe_fd);
    Ok(pid)
}

/// Maps `nobody` in the child's user namespace to the runner's user (or,
/// when the runner is root, to the host's `nobody`, as `runsc` does).
fn map_user(pid: libc::pid_t) -> io::Result<()> {
    const NOBODY: u32 = 65534;
    // SAFETY: plain queries.
    let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
    let (uid, gid) = if uid == 0 {
        (NOBODY, NOBODY)
    } else {
        (uid, gid)
    };
    let proc = PathBuf::from(format!("/proc/{pid}"));
    fs::write(proc.join("setgroups"), "deny")?;
    fs::write(proc.join("uid_map"), format!("{NOBODY} {uid} 1\n"))?;
    fs::write(proc.join("gid_map"), format!("{NOBODY} {gid} 1\n"))?;
    Ok(())
}

/// The child, between `clone` and `execve`: system calls only.
extern "C" fn run_child(arg: *mut c_void) -> c_int {
    // SAFETY: `arg` is the parent's `Child`, at the same address in our
    // copy of its memory; everything below is a plain system call.
    unsafe {
        let child = &*(arg as *const Child);
        // Wait for the parent to map our user.
        let mut byte = 0u8;
        loop {
            let n = libc::read(child.sync, (&mut byte as *mut u8).cast(), 1);
            if n == 1 {
                break;
            }
            if n < 0 && *libc::__errno_location() == libc::EINTR {
                continue;
            }
            libc::_exit(120);
        }
        if child.namespaces == Namespaces::New {
            become_nobody();
        }
        // Gone with the runner.
        libc::prctl(
            libc::PR_SET_PDEATHSIG,
            libc::SIGKILL as libc::c_ulong,
            0,
            0,
            0,
        );
        libc::setsid();
        // What the runner ignores (a broken pipe) is not ignored here.
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
        let pairs = std::slice::from_raw_parts(child.fds, child.nfds);
        for &(from, to) in pairs {
            if libc::dup2(from, to) < 0 {
                libc::_exit(124);
            }
        }
        libc::syscall(
            libc::SYS_execveat,
            child.exe,
            c"".as_ptr(),
            child.argv,
            child.envp,
            libc::AT_EMPTY_PATH,
        );
        libc::_exit(127)
    }
}

/// In the new user namespace: becomes the mapped `nobody` (the runner's
/// own user is mapped to it unless the runner is root), keeping the
/// capabilities the namespace gave through the change, and makes the
/// Sentry's [`CAPS`] ambient so they survive `execve`.
///
/// # Safety
///
/// Only from [`run_child`]: system calls only.
unsafe fn become_nobody() {
    // SAFETY: plain system calls, as the caller's.
    unsafe {
        const NOBODY: libc::uid_t = 65534;
        libc::prctl(libc::PR_SET_KEEPCAPS, 1 as libc::c_ulong, 0, 0, 0);
        // The system calls, not the C library's wrappers, which are not
        // for a copy of a multi-threaded process.
        if libc::syscall(libc::SYS_setresgid, NOBODY, NOBODY, NOBODY) < 0
            || libc::syscall(libc::SYS_setresuid, NOBODY, NOBODY, NOBODY) < 0
        {
            libc::_exit(125);
        }
        // Keep the capabilities the Sentry needs across execve: they have
        // to be inheritable to be made ambient.
        let mut header = CapHeader {
            version: 0x2008_0522,
            pid: 0,
        };
        let mut data = [CapData::default(); 2];
        if libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) < 0 {
            libc::_exit(121);
        }
        for (cap_word, word) in data.iter_mut().enumerate() {
            word.effective = word.permitted;
            for cap in CAPS {
                if (cap / 32) as usize == cap_word {
                    word.inheritable |= 1 << (cap % 32);
                }
            }
        }
        if libc::syscall(libc::SYS_capset, &mut header, data.as_ptr()) < 0 {
            libc::_exit(122);
        }
        for cap in CAPS {
            if libc::prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_RAISE,
                cap as libc::c_ulong,
                0,
                0,
            ) < 0
            {
                libc::_exit(123);
            }
        }
    }
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}
