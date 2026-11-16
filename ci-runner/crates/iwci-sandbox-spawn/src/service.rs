//! The sandbox service: starts one pinned Sentry in new namespaces for a
//! runner that may not make user namespaces itself, and watches it.
//!
//! systemd runs it as root, one instance per connection, from a socket
//! only the runner's group may connect to
//! (`iwci-sandbox-spawn.socket`, `Accept=yes`, `SOCK_SEQPACKET`), with the
//! connection as descriptor 3 (`LISTEN_FDS`):
//!
//! ```text
//! iwci-sandbox-spawn serve --peer <user> --sandbox-user <user> [--require-cgroup]
//! ```
//!
//! For one request ([`crate::wire`]) it
//!
//! - checks that the peer is `--peer` (`SO_PEERCRED`);
//! - reads a few `key=value` values ([`Boot`]) and the Sentry's
//!   descriptors, and checks them all; never a command line or an
//!   environment;
//! - takes the job's cgroup as a directory descriptor, which must be a
//!   cgroup v2 directory the peer owns (one of its delegated subtree);
//! - opens the Sentry and gVisor's proc unmounter at their pinned paths
//!   ([`SENTRY`]) and checks both against their pinned SHA-256: nothing else
//!   is ever started;
//! - builds the Sentry's whole command line itself, always
//!   `boot --setup-root`, which drops every capability before anything of
//!   the job's runs;
//! - starts it in new user, mount, PID, IPC, UTS and network namespaces as
//!   `nobody` there, which is the host user `--sandbox-user`
//!   (`iwci-sandbox`; refused if there is none), with no supplementary
//!   group, straight into the job's cgroup;
//! - becomes that user itself, for good, and answers `started <pid>`;
//! - waits: when the Sentry ends it answers `exit <status>`; when the
//!   runner says `kill` or goes away, it kills the Sentry (`pidfd` and
//!   `cgroup.kill`) first.
//!
//! Only a root peer may name another Sentry or add flags (`sentry=`,
//! `flag=`), which the tests use; the pins still apply.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use sha2::{Digest, Sha256};

use crate::boot::Boot;
use crate::spawn::{Namespaces, spawn_fd};
use crate::wire;

/// The service's file name.
pub const NAME: &str = "iwci-sandbox-spawn";

/// What the runner and the service agree on; a service of another
/// protocol is refused by the runner when it starts.
pub const PROTOCOL: &str = "3";

/// The only Sentry the service starts, and its SHA-256 on each
/// architecture: gVisor `release-20261109.0`, as
/// `infra/ci-runners/files/install.sh` installs it. A gVisor bump changes
/// these with the install script's pins.
pub const SENTRY: &str = match option_env!("IWCI_SANDBOX_SENTRY") {
    // Another place for the same release, fixed when the service is built
    // (a test install somewhere other than the runner hosts' path).
    Some(path) => path,
    None => "/opt/iwci/lib/gvisor-20261109.0/gvisor-bin/gvisor_sentry",
};

#[cfg(target_arch = "x86_64")]
const PINS: Pins = Pins {
    sentry: "2063b86b8dca211156a52a1f3b650cce961fb6710f1c520e1c5462dc8c0bd0bf",
    umounter: "b3bbbaef5ddc62084e5febd19d3acca14f3d42b2a25d8552fb40def699467019",
};
#[cfg(target_arch = "aarch64")]
const PINS: Pins = Pins {
    sentry: "14ec0071f5e4afa945620bfdfcffc472780982867439060ed460fdcf7434a321",
    umounter: "8ddecb8894b332be68e84faa073c073bbf1d6f046974d411fc02db03a73fde90",
};

struct Pins {
    sentry: &'static str,
    umounter: &'static str,
}

/// `statfs`'s magic for cgroup v2.
const CGROUP2_SUPER_MAGIC: i64 = 0x6367_7270;

/// How the service was started: `serve --peer <user> --sandbox-user <user>
/// [--require-cgroup]`.
#[derive(Debug, PartialEq, Eq)]
struct Options {
    peer: String,
    sandbox_user: String,
    /// Refuse a request without the job's cgroup, so that every Sentry
    /// lands in one (the runner hosts' unit).
    require_cgroup: bool,
}

/// The service's `main`.
pub fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("serve") => options(&args[1..]).and_then(|o| serve(&o)),
        _ => Err(
            "usage: iwci-sandbox-spawn serve --peer <user> --sandbox-user <user> [--require-cgroup]"
                .into(),
        ),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{NAME}: {e}");
            ExitCode::from(1)
        }
    }
}

fn options(args: &[String]) -> Result<Options, String> {
    let mut peer = None;
    let mut user = None;
    let mut require_cgroup = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--require-cgroup" {
            require_cgroup = true;
            continue;
        }
        let value = it.next().ok_or(format!("{arg} needs a value"))?;
        match arg.as_str() {
            "--peer" => peer = Some(value.clone()),
            "--sandbox-user" => user = Some(value.clone()),
            _ => return Err(format!("unknown {arg}")),
        }
    }
    Ok(Options {
        peer: peer.ok_or("no --peer")?,
        sandbox_user: user.ok_or("no --sandbox-user")?,
        require_cgroup,
    })
}

/// The connection systemd passed (`LISTEN_FDS`, descriptor 3).
fn connection() -> Result<OwnedFd, String> {
    let fds: u32 = std::env::var("LISTEN_FDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .ok_or("not started by socket activation (no LISTEN_FDS)")?;
    let pid: u32 = std::env::var("LISTEN_PID")
        .ok()
        .and_then(|v| v.parse().ok())
        .ok_or("no LISTEN_PID")?;
    if fds != 1 || pid != std::process::id() {
        return Err("expected one connection, for this process".into());
    }
    // SAFETY: systemd's protocol: descriptor 3 is ours.
    let conn = unsafe { OwnedFd::from_raw_fd(3) };
    let mut ty = 0i32;
    let mut len = std::mem::size_of::<i32>() as libc::socklen_t;
    // SAFETY: reading our own socket's type.
    let r = unsafe {
        libc::getsockopt(
            conn.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut ty as *mut i32).cast(),
            &mut len,
        )
    };
    if r < 0 || ty != libc::SOCK_SEQPACKET {
        return Err("the connection is not a SOCK_SEQPACKET socket".into());
    }
    // Nothing else of the caller's reaches the Sentry.
    // SAFETY: closing descriptors this process does not use.
    unsafe { libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0) };
    Ok(conn)
}

/// How long a peer has to send its request, in seconds: an instance
/// waiting longer is one of the socket's few connections held for nothing.
const REQUEST_TIMEOUT: i32 = 10;

/// The most the whole start may take, request to `started` (hashing the
/// Sentry included): past it the instance ends, and the Sentry with it.
const START_DEADLINE: u32 = 60;

fn serve(options: &Options) -> Result<(), String> {
    let (peer, sandbox_user) = (options.peer.as_str(), options.sandbox_user.as_str());
    // SAFETY: SIGALRM's default action ends the process; nothing here
    // handles it.
    unsafe { libc::alarm(START_DEADLINE) };
    let conn = connection()?;
    let timeout = libc::timeval {
        tv_sec: REQUEST_TIMEOUT.into(),
        tv_usec: 0,
    };
    for option in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
        // SAFETY: setting an option on our own socket.
        unsafe {
            libc::setsockopt(
                conn.as_raw_fd(),
                libc::SOL_SOCKET,
                option,
                (&timeout as *const libc::timeval).cast(),
                std::mem::size_of::<libc::timeval>() as libc::socklen_t,
            )
        };
    }
    let reply = |text: &str| wire::send(conn.as_raw_fd(), text.as_bytes(), &[]);
    let started = (|| -> Result<Option<Started>, String> {
        // Read first, so that the answer reaches the peer whatever it is,
        // and then nothing of the request is used unless the peer is ours
        // (its descriptors are closed with it).
        let (bytes, fds) = wire::recv(conn.as_raw_fd(), 0)
            .map_err(|e| e.to_string())?
            .ok_or("no request")?;
        let allowed = user(peer)
            .map(|(uid, _)| uid)
            .ok_or(format!("no user {peer}"))?;
        let uid = wire::peer_uid(&conn).map_err(|e| e.to_string())?;
        if uid != allowed {
            return Err(format!("peer uid {uid} is not {peer}"));
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| "a request that is not UTF-8")?;
        let mut lines = text.lines();
        match lines.next().unwrap_or("") {
            "protocol" => {
                reply(&format!("protocol {PROTOCOL}")).map_err(|e| e.to_string())?;
                return Ok(None);
            }
            first if first == format!("{NAME} {PROTOCOL}") => {}
            first => {
                return Err(format!(
                    "protocol {first:?} is not this service's ({PROTOCOL})"
                ));
            }
        }
        let values: Vec<String> = lines.map(str::to_string).collect();
        if options.require_cgroup && !values.iter().any(|v| v == "cgroup=1") {
            return Err("no cgroup for the sandbox".into());
        }
        start(uid, sandbox_user, values, fds).map(Some)
    })();
    let started = match started {
        Ok(Some(started)) => started,
        Ok(None) => return Ok(()),
        Err(e) => {
            let _ = reply(&format!("error {e}"));
            return Err(e);
        }
    };
    reply(&format!("started {}", started.pid)).map_err(|e| e.to_string())?;
    // Started: from here the instance lives as long as the Sentry does.
    // SAFETY: cancelling our own alarm.
    unsafe { libc::alarm(0) };
    let status = watch(&conn, &started);
    let _ = reply(&format!("exit {status}"));
    Ok(())
}

struct Started {
    pid: libc::pid_t,
    pidfd: OwnedFd,
    cgroup_kill: Option<fs::File>,
}

/// Checks the request and starts its Sentry.
fn start(
    peer: u32,
    sandbox_user: &str,
    values: Vec<String>,
    fds: Vec<OwnedFd>,
) -> Result<Started, String> {
    let with_cgroup = values.iter().any(|v| v == "cgroup=1");
    let values: Vec<String> = values.into_iter().filter(|v| v != "cgroup=1").collect();
    let (boot, sentry) = Boot::from_args(&values)?;
    if peer != 0 && (sentry.is_some() || !boot.flags.is_empty()) {
        return Err("only root names another Sentry or adds flags".into());
    }
    let n = boot.descriptors();
    if fds.len() != n + usize::from(with_cgroup) {
        return Err(format!(
            "{} descriptors for {} expected",
            fds.len(),
            n + usize::from(with_cgroup)
        ));
    }
    let mut fds = fds;
    let cgroup = if with_cgroup {
        Some(job_cgroup(fds.pop().expect("counted"), peer)?)
    } else {
        None
    };
    // Never root, whatever the user database says.
    let (uid, gid) = user(sandbox_user)
        .filter(|&(uid, gid)| uid != 0 && gid != 0)
        .ok_or(format!("no user {sandbox_user} other than root"))?;

    let sentry_path = sentry.unwrap_or_else(|| PathBuf::from(SENTRY));
    let umounter_path = sentry_path.with_file_name("gvisor-proc-umounter");
    let sentry_file = pinned(&sentry_path, PINS.sentry)?;
    let umounter = pinned(&umounter_path, PINS.umounter)?;
    // The unmounter goes where the Sentry looks for it, over whatever the
    // caller put there.
    fds[boot.umounter()] = reopen_path(&umounter)?;

    // No group of the caller's or this service's goes with the Sentry.
    // SAFETY: a plain system call; this process has one thread.
    if unsafe { libc::setgroups(0, std::ptr::null()) } < 0 {
        return Err(format!("dropping groups: {}", io::Error::last_os_error()));
    }
    let procs = match &cgroup {
        Some(dir) => Some(openat(dir, "cgroup.procs")?),
        None => None,
    };
    let cgroup_kill = match &cgroup {
        Some(dir) => Some(openat(dir, "cgroup.kill")?),
        None => None,
    };
    let pid = spawn_fd(
        sentry_file,
        &boot.sentry_args(host_memory()),
        &Boot::env(),
        fds,
        procs.as_ref(),
        Namespaces::New { uid, gid },
    )
    .map_err(|e| format!("starting the sandbox: {e}"))?;
    // SAFETY: our own child, not yet reaped.
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    let pidfd = if pidfd < 0 {
        let e = io::Error::last_os_error();
        // SAFETY: our own child.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        return Err(format!("pidfd_open: {e}"));
    } else {
        // SAFETY: just made and ours.
        unsafe { OwnedFd::from_raw_fd(pidfd as RawFd) }
    };
    become_user(uid, gid)?;
    Ok(Started {
        pid,
        pidfd,
        cgroup_kill,
    })
}

/// Becomes `uid` and `gid` for good, with no supplementary group, and
/// checks none of it can be undone.
fn become_user(uid: u32, gid: u32) -> Result<(), String> {
    // SAFETY: plain system calls; this process has one thread.
    unsafe {
        if libc::setresgid(gid, gid, gid) < 0 || libc::setresuid(uid, uid, uid) < 0 {
            return Err(format!("becoming {uid}: {}", io::Error::last_os_error()));
        }
        let (mut r, mut e, mut s) = (0, 0, 0);
        libc::getresuid(&mut r, &mut e, &mut s);
        let uids = [r, e, s];
        libc::getresgid(&mut r, &mut e, &mut s);
        let gids = [r, e, s];
        let groups = libc::getgroups(0, std::ptr::null_mut());
        if uids != [uid; 3]
            || gids != [gid; 3]
            || groups != 0
            || libc::setuid(0) == 0
            || libc::setgid(0) == 0
        {
            libc::_exit(126);
        }
    }
    Ok(())
}

/// Waits for the Sentry, or for the runner to say `kill` or go: its wait
/// status.
fn watch(conn: &OwnedFd, started: &Started) -> i32 {
    loop {
        let mut fds = [
            libc::pollfd {
                fd: conn.as_raw_fd(),
                events: libc::POLLIN | libc::POLLRDHUP,
                revents: 0,
            },
            libc::pollfd {
                fd: started.pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: polling our own descriptors.
        let r = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
        if r < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            kill(started);
            break;
        }
        if fds[1].revents != 0 {
            break;
        }
        if fds[0].revents != 0 {
            // Anything from the runner, or its going, stops the sandbox.
            let _ = wire::recv(conn.as_raw_fd(), libc::MSG_DONTWAIT);
            kill(started);
            break;
        }
    }
    let mut status = 0;
    loop {
        // SAFETY: waiting on our own child.
        let r = unsafe { libc::waitpid(started.pid, &mut status, 0) };
        if r == started.pid {
            return status;
        }
        if r < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return -1;
        }
    }
}

fn kill(started: &Started) {
    // SAFETY: signalling our own child through its pidfd.
    unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            started.pidfd.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if let Some(mut f) = started.cgroup_kill.as_ref() {
        let _ = f.write_all(b"1");
    }
}

/// The job's cgroup: a cgroup v2 directory the peer owns, directly in a
/// `jobs/` directory the peer owns, in a subtree the peer owns (the
/// runner's delegated one: `<service>/jobs/<job>`). Never the runner's own
/// `runner/` leaf, nor `jobs/` itself, nor anyone else's cgroup.
fn job_cgroup(fd: OwnedFd, peer: u32) -> Result<OwnedFd, String> {
    let file = fs::File::from(fd);
    let peers = |dir: &fs::File| -> Result<(), String> {
        let meta = dir.metadata().map_err(|e| format!("the cgroup: {e}"))?;
        // SAFETY: a zeroed statfs is valid; filled by the call.
        let mut fs_info: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: querying our own descriptor.
        let r = unsafe { libc::fstatfs(dir.as_raw_fd(), &mut fs_info) };
        if r < 0 || !meta.is_dir() || fs_info.f_type as i64 != CGROUP2_SUPER_MAGIC {
            return Err("the cgroup is not a cgroup v2 directory".into());
        }
        if meta.uid() != peer {
            return Err("the cgroup is not the peer's".into());
        }
        Ok(())
    };
    peers(&file)?;
    let jobs = parent(&file)?;
    peers(&jobs)?;
    if name_of(&jobs).as_deref() != Some("jobs") {
        return Err("the cgroup is not one of the peer's jobs".into());
    }
    peers(&parent(&jobs)?)?;
    Ok(file.into())
}

/// The directory above `dir`.
fn parent(dir: &fs::File) -> Result<fs::File, String> {
    // SAFETY: a relative name in a directory we hold.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c"..".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "the cgroup's parent: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: just opened and ours.
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

/// The last name of the directory `dir` is open on, as the kernel says.
fn name_of(dir: &fs::File) -> Option<String> {
    let path = fs::read_link(format!("/proc/self/fd/{}", dir.as_raw_fd())).ok()?;
    Some(path.file_name()?.to_str()?.to_string())
}

/// `name` in the directory `dir`, opened for writing, not following a link.
fn openat(dir: &OwnedFd, name: &str) -> Result<fs::File, String> {
    let c = std::ffi::CString::new(name).expect("no NUL");
    // SAFETY: a relative name in a directory we hold.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c.as_ptr(),
            libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(format!(
            "the cgroup's {name}: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: just opened and ours.
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

/// `path`, opened without following a link, if its SHA-256 is `pin`.
fn pinned(path: &Path, pin: &str) -> Result<fs::File, String> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let digest = sha256(&mut file).map_err(|e| format!("{}: {e}", path.display()))?;
    if digest != pin {
        return Err(format!(
            "{} is not the pinned gVisor release (SHA-256 {digest})",
            path.display()
        ));
    }
    Ok(file)
}

fn sha256(file: &mut fs::File) -> io::Result<String> {
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// An `O_PATH` descriptor of the file `file` is open on, as the Sentry
/// takes the unmounter.
fn reopen_path(file: &fs::File) -> Result<OwnedFd, String> {
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_CLOEXEC)
        .open(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map(OwnedFd::from)
        .map_err(|e| format!("reopening the unmounter: {e}"))
}

/// A user's uid and gid, from `/etc/passwd` (no name service), or a
/// number.
fn user(name: &str) -> Option<(u32, u32)> {
    if let Ok(uid) = name.parse::<u32>() {
        return Some((uid, uid));
    }
    user_in(&fs::read("/etc/passwd").ok()?, name)
}

fn user_in(passwd: &[u8], name: &str) -> Option<(u32, u32)> {
    passwd.split(|&b| b == b'\n').find_map(|line| {
        let mut f = line.split(|&b| b == b':');
        if OsStr::from_bytes(f.next()?) != OsStr::new(name) {
            return None;
        }
        f.next()?;
        let num = |b: &[u8]| std::str::from_utf8(b).ok()?.parse::<u32>().ok();
        Some((num(f.next()?)?, num(f.next()?)?))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn users_are_read_from_passwd() {
        let passwd = b"root:x:0:0:root:/root:/bin/bash\n\
            iwci:x:998:998::/var/lib/iwci:/usr/sbin/nologin\n\
            iwci-sandbox:x:997:996::/nonexistent:/usr/sbin/nologin\n\
            evil:x:0:0::/:/bin/sh\n";
        assert_eq!(user_in(passwd, "iwci-sandbox"), Some((997, 996)));
        assert_eq!(user_in(passwd, "iwci"), Some((998, 998)));
        assert_eq!(user_in(passwd, "evil"), Some((0, 0)));
        assert_eq!(user_in(passwd, "root"), Some((0, 0)));
        assert_eq!(user_in(passwd, "missing"), None);
        assert_eq!(
            user_in(b"iwci-sandbox-x:x:5:5::/:/\n", "iwci-sandbox"),
            None
        );
        assert_eq!(user("1234"), Some((1234, 1234)));
    }

    #[test]
    fn only_the_pinned_file_is_started() {
        let dir = std::env::temp_dir().join(format!("iwci-pin-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sentry");
        fs::write(&file, b"not gVisor").unwrap();
        assert!(pinned(&file, PINS.sentry).is_err());
        let digest = sha256(&mut fs::File::open(&file).unwrap()).unwrap();
        assert!(pinned(&file, &digest).is_ok());
        std::os::unix::fs::symlink(&file, dir.join("link")).unwrap();
        assert!(pinned(&dir.join("link"), &digest).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_cgroup_must_be_a_cgroup_directory_of_the_peers() {
        // Not on a cgroup file system.
        let dir: OwnedFd = fs::File::open(std::env::temp_dir()).unwrap().into();
        // SAFETY: a plain query.
        let me = unsafe { libc::geteuid() };
        assert!(job_cgroup(dir, me).is_err());
        // One of systemd's, not the peer's (unless the test runs as root,
        // which owns them all).
        if me != 0
            && let Ok(f) = fs::File::open("/sys/fs/cgroup")
        {
            assert!(job_cgroup(f.into(), me).is_err());
        }
    }

    #[test]
    fn the_users_are_both_required() {
        let s = |v: &[&str]| v.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert!(options(&s(&["--peer", "iwci"])).is_err());
        assert!(
            options(&s(&[
                "--peer",
                "iwci",
                "--sandbox-user",
                "x",
                "--other",
                "y"
            ]))
            .is_err()
        );
        assert_eq!(
            options(&s(&[
                "--peer",
                "iwci",
                "--sandbox-user",
                "iwci-sandbox",
                "--require-cgroup"
            ]))
            .unwrap(),
            Options {
                peer: "iwci".into(),
                sandbox_user: "iwci-sandbox".into(),
                require_cgroup: true,
            }
        );
    }
}
