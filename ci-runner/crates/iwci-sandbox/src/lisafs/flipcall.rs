//! gVisor's flipcall (`pkg/flipcall`): a request/response channel over a
//! shared memory window, with control handed back and forth by a futex.
//!
//! The window starts with a 16-byte header, a connection state word and
//! the datagram's length, followed by the datagram. Whoever is "active"
//! may touch the datagram; it hands control over by swapping the state
//! word to the other side and waking it. The sandbox's kernel is the
//! client, which starts active; the runner is the server.
//!
//! The window is shared with an untrusted peer that may change it at any
//! time, so a received datagram is copied out once, and parsed from the
//! copy, never read twice in place.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// The packet header: state, datagram length, 8 reserved bytes.
pub(crate) const HEADER_BYTES: usize = 16;

// Connection states. The client is initially active, so it is 0.
const CLIENT_ACTIVE: u32 = 0;
const SERVER_ACTIVE: u32 = 1;
const SHUTDOWN: u32 = 2;

/// Why an endpoint stopped.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Stopped {
    /// One side shut the channel down.
    Shutdown,
    /// The peer broke the protocol (an unknown state, an oversized
    /// datagram); the channel is unusable.
    Broken,
}

pub(crate) fn page_size() -> usize {
    // SAFETY: a plain query.
    unsafe { libc::sysconf(libc::_SC_PAGESIZE) as usize }
}

/// A shared memory window: a sealed memfd and our mapping of it.
#[derive(Debug)]
pub(crate) struct Window {
    memfd: OwnedFd,
    base: *mut u8,
    len: usize,
}

// SAFETY: the mapping is plain shared memory; all access to it goes through
// atomics (the header) or explicit copies done by the active side.
unsafe impl Send for Window {}
// SAFETY: as above.
unsafe impl Sync for Window {}

impl Window {
    /// A new, zeroed window able to carry datagrams of `data_cap` bytes.
    pub(crate) fn create(data_cap: usize) -> io::Result<Self> {
        let page = page_size();
        let len = (HEADER_BYTES + data_cap).div_ceil(page) * page;
        // SAFETY: the name is a valid C string; the result is checked.
        let raw = unsafe {
            libc::memfd_create(
                c"flipcall_packet_windows".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: just created and ours.
        let memfd = unsafe { OwnedFd::from_raw_fd(raw) };
        // SAFETY: plain syscalls on a descriptor we own.
        unsafe {
            if libc::ftruncate(memfd.as_raw_fd(), len as libc::off_t) < 0 {
                return Err(io::Error::last_os_error());
            }
            // Neither side may shrink the file (which would fault the
            // other's mapping) or add seals of its own.
            if libc::fcntl(
                memfd.as_raw_fd(),
                libc::F_ADD_SEALS,
                libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL,
            ) < 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Self::map(memfd, 0, len)
    }

    /// Maps `len` bytes of `memfd` at `offset`.
    pub(crate) fn map(memfd: OwnedFd, offset: i64, len: usize) -> io::Result<Self> {
        if len < page_size() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // SAFETY: a fresh shared mapping of a file we hold; checked below.
        let base = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                memfd.as_raw_fd(),
                offset as libc::off_t,
            )
        };
        if base == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            memfd,
            base: base.cast(),
            len,
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn memfd(&self) -> RawFd {
        self.memfd.as_raw_fd()
    }

    fn word(&self, offset: usize) -> &AtomicU32 {
        // SAFETY: the mapping is at least a page, page aligned, and lives
        // as long as `self`; the two header words are only accessed
        // atomically.
        unsafe { &*self.base.add(offset).cast::<AtomicU32>() }
    }

    fn state(&self) -> &AtomicU32 {
        self.word(0)
    }

    fn data_len(&self) -> &AtomicU32 {
        self.word(4)
    }

    /// The most a datagram can hold.
    pub(crate) fn data_cap(&self) -> usize {
        self.len - HEADER_BYTES
    }

    /// Copies the first `len` bytes of the datagram out.
    pub(crate) fn read(&self, len: usize) -> Vec<u8> {
        let len = len.min(self.data_cap());
        let mut out = vec![0u8; len];
        // SAFETY: in bounds of the mapping; the peer may be writing to it
        // (it should not, while we are active), and whatever it wrote is
        // what we parse, from our own copy.
        unsafe {
            std::ptr::copy_nonoverlapping(self.base.add(HEADER_BYTES), out.as_mut_ptr(), len);
        }
        out
    }

    /// Writes `bytes` at the start of the datagram.
    pub(crate) fn write(&self, bytes: &[u8]) {
        let len = bytes.len().min(self.data_cap());
        // SAFETY: in bounds of the mapping.
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.base.add(HEADER_BYTES), len);
        }
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        // SAFETY: unmapping our own mapping, which nothing borrows past
        // `self`.
        unsafe { libc::munmap(self.base.cast(), self.len) };
    }
}

/// Which side of the channel this endpoint is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Side {
    Server,
    /// Only the tests' client is one.
    #[cfg_attr(not(test), allow(dead_code))]
    Client,
}

/// One end of a flipcall channel.
#[derive(Debug)]
pub(crate) struct Endpoint {
    pub(crate) window: Window,
    active: u32,
    inactive: u32,
    shut: AtomicBool,
}

/// The connection handshake both sides exchange first: an empty JSON object.
const HANDSHAKE: &[u8] = b"{}\n";

impl Endpoint {
    pub(crate) fn new(window: Window, side: Side) -> Self {
        let (active, inactive) = match side {
            Side::Server => (SERVER_ACTIVE, CLIENT_ACTIVE),
            Side::Client => (CLIENT_ACTIVE, SERVER_ACTIVE),
        };
        Self {
            window,
            active,
            inactive,
            shut: AtomicBool::new(false),
        }
    }

    /// Server: waits for the client to connect, answers the handshake, and
    /// waits for the first request, whose length it returns.
    pub(crate) fn recv_first(&self) -> Result<usize, Stopped> {
        self.wait_until_active()?;
        self.received_len()?;
        self.window.write(HANDSHAKE);
        self.window
            .data_len()
            .store(HANDSHAKE.len() as u32, Ordering::Relaxed);
        self.hand_over()?;
        self.wait_until_active()?;
        self.received_len()
    }

    /// Client: the handshake (for the tests' client).
    #[cfg(test)]
    pub(crate) fn connect(&self) -> Result<(), Stopped> {
        self.window.write(HANDSHAKE);
        self.window
            .data_len()
            .store(HANDSHAKE.len() as u32, Ordering::Relaxed);
        self.hand_over()?;
        self.wait_until_active()?;
        self.received_len().map(|_| ())
    }

    /// Hands the peer a datagram of `len` bytes and waits for its reply,
    /// whose length it returns.
    pub(crate) fn send_recv(&self, len: usize) -> Result<usize, Stopped> {
        if len > self.window.data_cap() {
            return Err(Stopped::Broken);
        }
        self.window.data_len().store(len as u32, Ordering::Relaxed);
        self.hand_over()?;
        self.wait_until_active()?;
        self.received_len()
    }

    /// Shuts the channel down: a thread of ours waiting on it, and the
    /// peer, see it at once. Safe to call from any thread, any number of
    /// times.
    pub(crate) fn shutdown(&self) {
        self.shut.store(true, Ordering::SeqCst);
        self.window.state().swap(SHUTDOWN, Ordering::SeqCst);
        futex_wake(self.window.state(), i32::MAX);
    }

    fn received_len(&self) -> Result<usize, Stopped> {
        let len = self.window.data_len().load(Ordering::Relaxed) as usize;
        if len > self.window.data_cap() {
            return Err(Stopped::Broken);
        }
        Ok(len)
    }

    /// Makes the peer active and wakes it.
    fn hand_over(&self) -> Result<(), Stopped> {
        match self.window.state().compare_exchange(
            self.active,
            self.inactive,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => {
                futex_wake(self.window.state(), 1);
                Ok(())
            }
            Err(SHUTDOWN) => Err(Stopped::Shutdown),
            Err(_) => Err(Stopped::Broken),
        }
    }

    fn wait_until_active(&self) -> Result<(), Stopped> {
        loop {
            let state = self.window.state().load(Ordering::SeqCst);
            if state == self.active {
                return Ok(());
            }
            if state == SHUTDOWN || self.shut.load(Ordering::SeqCst) {
                return Err(Stopped::Shutdown);
            }
            if state != self.inactive {
                return Err(Stopped::Broken);
            }
            futex_wait(self.window.state(), self.inactive);
        }
    }
}

// Shared (not private) futex operations: the word is in memory mapped by
// two processes.
fn futex_wait(word: &AtomicU32, expected: u32) {
    // SAFETY: `word` is a live, aligned u32; FUTEX_WAIT only reads it. An
    // EAGAIN (the value already changed) or EINTR just loops the caller.
    unsafe {
        libc::syscall(
            libc::SYS_futex,
            word.as_ptr(),
            libc::FUTEX_WAIT,
            expected,
            std::ptr::null::<libc::timespec>(),
        );
    }
}

fn futex_wake(word: &AtomicU32, count: i32) {
    // SAFETY: as above; FUTEX_WAKE does not touch the word.
    unsafe {
        libc::syscall(libc::SYS_futex, word.as_ptr(), libc::FUTEX_WAKE, count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn pair() -> (Arc<Endpoint>, Arc<Endpoint>) {
        let server = Window::create(page_size()).unwrap();
        // SAFETY: dup of a descriptor we own.
        let dup = unsafe { OwnedFd::from_raw_fd(libc::dup(server.memfd())) };
        let client = Window::map(dup, 0, server.len()).unwrap();
        (
            Arc::new(Endpoint::new(server, Side::Server)),
            Arc::new(Endpoint::new(client, Side::Client)),
        )
    }

    #[test]
    fn requests_and_replies_alternate_between_two_mappings() {
        let (server, client) = pair();
        let s = server.clone();
        let echo = std::thread::spawn(move || {
            let mut len = s.recv_first().unwrap();
            let mut served = 0;
            while len > 0 {
                let mut got = s.window.read(len);
                got.reverse();
                s.window.write(&got);
                served += 1;
                len = match s.send_recv(got.len()) {
                    Ok(len) => len,
                    Err(Stopped::Shutdown) => break,
                    Err(e) => panic!("{e:?}"),
                };
            }
            served
        });
        client.connect().unwrap();
        for word in [&b"abc"[..], b"hello", b"x"] {
            client.window.write(word);
            let n = client.send_recv(word.len()).unwrap();
            let mut want = word.to_vec();
            want.reverse();
            assert_eq!(client.window.read(n), want);
        }
        client.shutdown();
        assert_eq!(echo.join().unwrap(), 3);
    }

    #[test]
    fn a_shutdown_wakes_a_server_waiting_for_its_client() {
        let (server, _client) = pair();
        let s = server.clone();
        let waiting = std::thread::spawn(move || s.recv_first());
        std::thread::sleep(std::time::Duration::from_millis(50));
        server.shutdown();
        assert_eq!(waiting.join().unwrap(), Err(Stopped::Shutdown));
    }

    #[test]
    fn a_length_past_the_window_breaks_the_channel() {
        let (server, client) = pair();
        let s = server.clone();
        let serving = std::thread::spawn(move || s.recv_first());
        client.connect().unwrap();
        // A hostile client claims a datagram longer than the window.
        client.window.data_len().store(u32::MAX, Ordering::SeqCst);
        client.hand_over().unwrap();
        assert_eq!(serving.join().unwrap(), Err(Stopped::Broken));
    }
}
