//! The connection's socket: a stream of `{u32 length, u16 message, u16 pad}`
//! headers each followed by that many bytes (`pkg/lisafs/sock.go`), with
//! descriptors riding the first `sendmsg` of a message as `SCM_RIGHTS`.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

/// `sockHeader`: payload length, message id, padding.
pub(crate) const HEADER_LEN: usize = 8;

/// A received message: its id, its payload and the descriptors it carried.
pub(crate) type Message = (u16, Vec<u8>, Vec<OwnedFd>);

/// The most descriptors one message carries (a `Channel` response has two).
const MAX_FDS: usize = 4;

/// One end of a lisafs connection socket.
#[derive(Debug)]
pub(crate) struct Sock {
    fd: OwnedFd,
}

impl Sock {
    pub(crate) fn new(fd: OwnedFd) -> Self {
        Self { fd }
    }

    #[cfg(test)]
    pub(crate) fn raw(&self) -> RawFd {
        self.fd.as_raw_fd()
    }

    /// Stops reads and writes on both ends, waking a thread blocked in
    /// [`Sock::recv`].
    pub(crate) fn shutdown(&self) {
        // SAFETY: a plain syscall on a descriptor we own.
        unsafe { libc::shutdown(self.fd.as_raw_fd(), libc::SHUT_RDWR) };
    }

    /// The next message, or `None` once the peer has closed. A payload over
    /// `max` is an error: the peer is not keeping to the protocol, and the
    /// caller drops the connection. Descriptors are kept only up to
    /// `want_fds`; any others are closed.
    pub(crate) fn recv(&self, max: u32, want_fds: usize) -> io::Result<Option<Message>> {
        let mut header = [0u8; HEADER_LEN];
        let mut fds = Vec::new();
        if !self.read_exact(&mut header, want_fds, &mut fds)? {
            return Ok(None);
        }
        let len = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let mid = u16::from_le_bytes([header[4], header[5]]);
        if len > max {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("a message of {len} bytes, over the limit of {max}"),
            ));
        }
        let mut payload = vec![0u8; len as usize];
        if !payload.is_empty() && !self.read_exact(&mut payload, 0, &mut Vec::new())? {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        Ok(Some((mid, payload, fds)))
    }

    /// Reads exactly `buf.len()` bytes. False when the peer closed before
    /// the first byte.
    fn read_exact(
        &self,
        buf: &mut [u8],
        want_fds: usize,
        fds: &mut Vec<OwnedFd>,
    ) -> io::Result<bool> {
        let mut got = 0;
        while got < buf.len() {
            let n = recv_some(self.fd.as_raw_fd(), &mut buf[got..], want_fds, fds)?;
            if n == 0 {
                if got == 0 {
                    return Ok(false);
                }
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            got += n;
        }
        Ok(true)
    }

    /// Sends one message, with `fds` attached to its first bytes.
    pub(crate) fn send(&self, mid: u16, payload: &[u8], fds: &[RawFd]) -> io::Result<()> {
        let len = u32::try_from(payload.len())
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut message = Vec::with_capacity(HEADER_LEN + payload.len());
        message.extend_from_slice(&len.to_le_bytes());
        message.extend_from_slice(&mid.to_le_bytes());
        message.extend_from_slice(&[0, 0]);
        message.extend_from_slice(payload);
        let mut sent = 0;
        let mut fds = fds;
        while sent < message.len() {
            let n = send_some(self.fd.as_raw_fd(), &message[sent..], fds)?;
            fds = &[];
            sent += n;
        }
        Ok(())
    }
}

/// One `recvmsg`, keeping up to `want_fds` descriptors.
fn recv_some(
    fd: RawFd,
    buf: &mut [u8],
    want_fds: usize,
    fds: &mut Vec<OwnedFd>,
) -> io::Result<usize> {
    let space = cmsg_space(MAX_FDS);
    let mut control = vec![0u8; space];
    loop {
        let mut iov = libc::iovec {
            iov_base: buf.as_mut_ptr().cast(),
            iov_len: buf.len(),
        };
        // SAFETY: zeroed is a valid msghdr; every pointer set below points
        // into a buffer that outlives the call.
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        // SAFETY: as above.
        let n = unsafe { libc::recvmsg(fd, &mut msg, libc::MSG_CMSG_CLOEXEC) };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        take_fds(&msg, want_fds, fds);
        return Ok(n as usize);
    }
}

/// Moves the `SCM_RIGHTS` descriptors of `msg` into `fds` (up to `want`
/// of them in all) and closes the rest.
fn take_fds(msg: &libc::msghdr, want: usize, fds: &mut Vec<OwnedFd>) {
    // SAFETY: walking the control buffer the kernel filled, with the
    // libc macros, and taking ownership of the descriptors it passed.
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                let data = libc::CMSG_DATA(cmsg);
                let bytes = (*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
                for i in 0..bytes / size_of::<RawFd>() {
                    let raw = std::ptr::read_unaligned(data.cast::<RawFd>().add(i));
                    let owned = OwnedFd::from_raw_fd(raw);
                    if fds.len() < want {
                        fds.push(owned);
                    }
                }
            }
            cmsg = libc::CMSG_NXTHDR(msg, cmsg);
        }
    }
}

/// The `SCM_RIGHTS` descriptors `msg` received, up to `want` of them;
/// the rest are closed.
pub fn take_rights(msg: &libc::msghdr, want: usize) -> Vec<OwnedFd> {
    let mut fds = Vec::new();
    take_fds(msg, want, &mut fds);
    fds
}

/// One `sendmsg` of `buf`, with `fds` attached.
fn send_some(fd: RawFd, buf: &[u8], fds: &[RawFd]) -> io::Result<usize> {
    let mut control = vec![
        0u8;
        if fds.is_empty() {
            0
        } else {
            cmsg_space(fds.len())
        }
    ];
    loop {
        let mut iov = libc::iovec {
            iov_base: buf.as_ptr() as *mut _,
            iov_len: buf.len(),
        };
        // SAFETY: zeroed is a valid msghdr; the pointers set below point
        // into buffers that outlive the call.
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        if !fds.is_empty() {
            fill_rights(&mut msg, &mut control, fds);
        }
        // SAFETY: as above.
        let n = unsafe { libc::sendmsg(fd, &msg, libc::MSG_NOSIGNAL) };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        return Ok(n as usize);
    }
}

/// Points `msg` at `control`, filled with one `SCM_RIGHTS` message
/// carrying `fds`.
pub fn fill_rights(msg: &mut libc::msghdr, control: &mut [u8], fds: &[RawFd]) {
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = control.len() as _;
    // SAFETY: `control` is `cmsg_space(fds.len())` bytes, room for one
    // header and the descriptors.
    unsafe {
        let cmsg = libc::CMSG_FIRSTHDR(msg);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN(size_of_val(fds) as u32) as _;
        let data = libc::CMSG_DATA(cmsg).cast::<RawFd>();
        for (i, fd) in fds.iter().enumerate() {
            std::ptr::write_unaligned(data.add(i), *fd);
        }
    }
}

pub fn cmsg_space(fds: usize) -> usize {
    // SAFETY: a size computation.
    unsafe { libc::CMSG_SPACE((fds * size_of::<RawFd>()) as u32) as usize }
}

/// A connected pair of `AF_UNIX` sockets of `kind`, close-on-exec.
pub(crate) fn socket_pair(kind: libc::c_int) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: `fds` has room for the two descriptors.
    let r = unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            kind | libc::SOCK_CLOEXEC,
            0,
            fds.as_mut_ptr(),
        )
    };
    if r < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both were just created and are ours.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}
