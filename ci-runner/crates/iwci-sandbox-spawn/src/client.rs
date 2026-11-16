//! The runner's end of the sandbox service ([`crate::service`]).

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;

use crate::boot::Boot;
use crate::service::{NAME, PROTOCOL};
use crate::wire;

/// A Sentry the service started and watches.
#[derive(Debug)]
pub struct Remote {
    conn: OwnedFd,
    pid: libc::pid_t,
    status: Option<Option<i32>>,
}

fn connect(socket: &Path) -> io::Result<OwnedFd> {
    // SAFETY: a plain socket call.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: just made and ours.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let bytes = socket.as_os_str().as_encoded_bytes();
    // SAFETY: a zeroed sockaddr_un is valid.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= addr.sun_path.len() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    addr.sun_family = libc::AF_UNIX as _;
    for (d, s) in addr.sun_path.iter_mut().zip(bytes) {
        *d = *s as _;
    }
    // SAFETY: a valid address.
    let r = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&addr as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if r < 0 {
        return Err(io::Error::new(
            io::Error::last_os_error().kind(),
            format!("{}: {}", socket.display(), io::Error::last_os_error()),
        ));
    }
    Ok(fd)
}

fn reply(conn: &OwnedFd, flags: i32) -> io::Result<Option<String>> {
    Ok(wire::recv(conn.as_raw_fd(), flags)?
        .map(|(bytes, _)| String::from_utf8_lossy(&bytes).into_owned()))
}

/// The service's protocol.
pub fn protocol(socket: &Path) -> io::Result<String> {
    let conn = connect(socket)?;
    wire::send(conn.as_raw_fd(), b"protocol", &[])?;
    match reply(&conn, 0)? {
        Some(r) => r
            .strip_prefix("protocol ")
            .map(str::to_string)
            .ok_or_else(|| io::Error::other(r)),
        None => Err(io::Error::other("the service closed the connection")),
    }
}

/// Asks the service at `socket` to start the Sentry for `boot`, with its
/// descriptors `fds` ([`Boot`]'s layout), in the cgroup `cgroup` (a
/// directory descriptor) if any. `sentry` names another Sentry, which only
/// a root runner may.
pub fn start(
    socket: &Path,
    boot: &Boot,
    sentry: Option<&Path>,
    fds: &[RawFd],
    cgroup: Option<RawFd>,
) -> io::Result<Remote> {
    let conn = connect(socket)?;
    let mut text = format!("{NAME} {PROTOCOL}\n");
    for v in boot.to_args() {
        text.push_str(&v);
        text.push('\n');
    }
    if let Some(sentry) = sentry {
        text.push_str(&format!("sentry={}\n", sentry.display()));
    }
    let mut all = fds.to_vec();
    if let Some(cgroup) = cgroup {
        text.push_str("cgroup=1\n");
        all.push(cgroup);
    }
    wire::send(conn.as_raw_fd(), text.as_bytes(), &all)?;
    match reply(&conn, 0)? {
        Some(r) => match r.strip_prefix("started ").and_then(|p| p.parse().ok()) {
            Some(pid) => Ok(Remote {
                conn,
                pid,
                status: None,
            }),
            None => Err(io::Error::other(format!(
                "the sandbox service: {}",
                r.strip_prefix("error ").unwrap_or(&r)
            ))),
        },
        None => Err(io::Error::other(
            "the sandbox service closed the connection",
        )),
    }
}

impl Remote {
    /// The Sentry's process id, in the host's PID namespace.
    pub fn pid(&self) -> libc::pid_t {
        self.pid
    }

    fn read(&mut self, flags: i32) -> Option<Option<i32>> {
        if let Some(status) = self.status {
            return Some(status);
        }
        let status = match reply(&self.conn, flags) {
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return None,
            Ok(Some(r)) => r.strip_prefix("exit ").and_then(|s| s.parse().ok()),
            Ok(None) | Err(_) => None,
        };
        self.status = Some(status);
        Some(status)
    }

    /// Its wait status, if it has ended: `Some(None)` when the service went
    /// without saying.
    pub fn try_wait(&mut self) -> Option<Option<i32>> {
        self.read(libc::MSG_DONTWAIT)
    }

    /// Waits for it to end: its wait status, if the service said.
    pub fn wait(&mut self) -> Option<i32> {
        self.read(0).flatten()
    }

    /// Stops it, and waits for the service to say it has.
    pub fn kill(&mut self) -> Option<i32> {
        if self.status.is_none() {
            let _ = wire::send(self.conn.as_raw_fd(), b"kill", &[]);
        }
        self.wait()
    }
}
