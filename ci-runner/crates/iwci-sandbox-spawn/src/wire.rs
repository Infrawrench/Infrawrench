//! Messages between the runner and the sandbox service: one `SOCK_SEQPACKET`
//! packet each, text, the first one carrying the Sentry's descriptors.
//!
//! - runner: `iwci-sandbox-spawn <protocol>`, then one `key=value` per
//!   line (`Boot`, and `cgroup=1` when the last descriptor is the job's
//!   cgroup directory), with the descriptors;
//! - service: `started <pid>` or `error <why>`;
//! - runner, at any time after: `kill` (or it closes the connection);
//! - service: `exit <wait status>`, then it closes the connection.
//!
//! `protocol` alone asks the service its protocol: `protocol <n>`.

use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

/// The most descriptors one message carries.
pub const MAX_FDS: usize = 64;

/// The largest message.
pub const MAX_MESSAGE: usize = 16 << 10;

/// Sends `bytes` as one packet, with `fds`.
pub fn send(sock: RawFd, bytes: &[u8], fds: &[RawFd]) -> io::Result<()> {
    if fds.len() > MAX_FDS || bytes.len() > MAX_MESSAGE {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut iov = libc::iovec {
        iov_base: bytes.as_ptr() as *mut _,
        iov_len: bytes.len(),
    };
    // SAFETY: CMSG_SPACE is a size computation.
    let space = unsafe { libc::CMSG_SPACE(std::mem::size_of_val(fds) as u32) } as usize;
    let mut control = vec![0u8; space.max(1)];
    // SAFETY: a zeroed msghdr is valid; every pointer set below outlives
    // the call.
    let mut msg: libc::msghdr = unsafe { zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    if !fds.is_empty() {
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        // SAFETY: the buffer has room for one header and `fds`.
        unsafe {
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of_val(fds) as u32) as _;
            std::ptr::copy_nonoverlapping(
                fds.as_ptr(),
                libc::CMSG_DATA(cmsg).cast::<RawFd>(),
                fds.len(),
            );
        }
    }
    loop {
        // SAFETY: `msg` is filled in above.
        let n = unsafe { libc::sendmsg(sock, &msg, libc::MSG_NOSIGNAL) };
        if n >= 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if e.kind() != io::ErrorKind::Interrupted {
            return Err(e);
        }
    }
}

/// One packet and the descriptors it carried; `None` at end of stream.
/// A packet or descriptor list that did not fit is an error, and any
/// descriptors that came with it are closed.
pub fn recv(sock: RawFd, flags: i32) -> io::Result<Option<(Vec<u8>, Vec<OwnedFd>)>> {
    let mut buf = vec![0u8; MAX_MESSAGE];
    let mut iov = libc::iovec {
        iov_base: buf.as_mut_ptr().cast(),
        iov_len: buf.len(),
    };
    // SAFETY: CMSG_SPACE is a size computation.
    let space = unsafe { libc::CMSG_SPACE((MAX_FDS * size_of::<RawFd>()) as u32) } as usize;
    let mut control = vec![0u8; space];
    // SAFETY: as in `send`.
    let mut msg: libc::msghdr = unsafe { zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = space as _;
    let n = loop {
        // SAFETY: `msg` points at buffers that outlive the call.
        let n = unsafe { libc::recvmsg(sock, &mut msg, libc::MSG_CMSG_CLOEXEC | flags) };
        if n >= 0 {
            break n as usize;
        }
        let e = io::Error::last_os_error();
        if e.kind() != io::ErrorKind::Interrupted {
            return Err(e);
        }
    };
    let mut fds = Vec::new();
    // SAFETY: walking the control messages the kernel wrote.
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                let data = libc::CMSG_DATA(cmsg).cast::<RawFd>();
                let len = (*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
                for i in 0..len / size_of::<RawFd>() {
                    fds.push(OwnedFd::from_raw_fd(std::ptr::read_unaligned(data.add(i))));
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
    }
    if msg.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "a message too large",
        ));
    }
    if n == 0 && fds.is_empty() {
        return Ok(None);
    }
    buf.truncate(n);
    Ok(Some((buf, fds)))
}

/// The uid of the peer of a connected Unix socket.
pub fn peer_uid(sock: &impl AsRawFd) -> io::Result<u32> {
    // SAFETY: zeroed is a valid ucred; the length matches it.
    let mut cred: libc::ucred = unsafe { zeroed() };
    let mut len = size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: reading our own socket's peer credentials into `cred`.
    let r = unsafe {
        libc::getsockopt(
            sock.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if r < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (OwnedFd, OwnedFd) {
        let mut fds = [0; 2];
        // SAFETY: `fds` has room for both ends.
        assert_eq!(
            unsafe {
                libc::socketpair(
                    libc::AF_UNIX,
                    libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                    0,
                    fds.as_mut_ptr(),
                )
            },
            0
        );
        // SAFETY: both were just made and are ours.
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    #[test]
    fn packets_carry_their_descriptors() {
        let (a, b) = pair();
        let null = std::fs::File::open("/dev/null").unwrap();
        send(
            a.as_raw_fd(),
            b"hello",
            &[null.as_raw_fd(), null.as_raw_fd()],
        )
        .unwrap();
        send(a.as_raw_fd(), b"bye", &[]).unwrap();
        let (bytes, fds) = recv(b.as_raw_fd(), 0).unwrap().unwrap();
        assert_eq!((bytes.as_slice(), fds.len()), (&b"hello"[..], 2));
        let (bytes, fds) = recv(b.as_raw_fd(), 0).unwrap().unwrap();
        assert_eq!((bytes.as_slice(), fds.len()), (&b"bye"[..], 0));
        drop(a);
        assert!(recv(b.as_raw_fd(), 0).unwrap().is_none());
        // SAFETY: a plain query.
        assert_eq!(peer_uid(&b).unwrap(), unsafe { libc::geteuid() });
    }
}
