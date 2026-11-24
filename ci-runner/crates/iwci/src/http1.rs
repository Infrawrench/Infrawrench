//! HTTP/1.1 connections, each served on a thread of its own for as long as
//! it is open: what the runner's own servers (`iwci serve`'s API in
//! [`crate::server`] and Turborepo's cache in [`crate::turbo`]) are built
//! on.
//!
//! They used to run on tiny_http, whose connection pool starts a thread for
//! a new connection only when it sees none waiting. A worker that has been
//! woken but not yet run still counts as waiting, so of two connections
//! accepted together one could sit unread until some other connection
//! closed. A client that keeps keep-alive connections open (`turbo`, the
//! proxy in front of `iwci serve`) then waited for its own timeout: 30 s
//! for `turbo`, 20 s for the proxy's read of a run.
//!
//! What is here: reading a request head ([`read_head`]) and a body
//! ([`Body`]), and the bounds a server keeps to, a runner-wide [`Budget`]
//! and a cap of connections per client ([`Slots`]).

use std::collections::HashMap;
use std::io::{self, BufRead, Read};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// The longest request line and headers together.
pub const MAX_HEAD: u64 = 16 << 10;

/// A request line and its headers, before the body.
pub struct Head {
    pub method: String,
    pub target: String,
    /// `(1, 0)` or `(1, 1)`.
    pub version: (u8, u8),
    /// Whether the connection may carry another request after this one.
    pub keep_alive: bool,
    /// Names lowercased, values trimmed.
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        header_in(&self.headers, name)
    }

    /// How the body is framed: `None` when there is none.
    pub fn framing(&self) -> Result<Option<Framing>, &'static str> {
        if self
            .header("transfer-encoding")
            .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"))
        {
            return Ok(Some(Framing::Chunked));
        }
        match self.header("content-length") {
            None => Ok(None),
            Some(n) => match n.parse::<u64>() {
                Ok(0) => Ok(None),
                Ok(n) => Ok(Some(Framing::Length(n))),
                Err(_) => Err("not a length"),
            },
        }
    }

    /// Whether the client waits for `100 Continue` before sending a body.
    pub fn expects_continue(&self) -> bool {
        self.header("expect")
            .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
    }
}

pub fn header_in<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// Why a request head could not be read; the connection ends either way.
pub enum HeadError {
    /// The client closed or went quiet: nothing to answer.
    Gone,
    /// Malformed: the status to answer and why.
    Bad(u16, &'static str),
}

/// Reads one request head, `None` at a clean end of the connection.
pub fn read_head(reader: &mut impl BufRead) -> Result<Option<Head>, HeadError> {
    let mut lines = Vec::new();
    let mut read = 0u64;
    loop {
        let mut line = Vec::new();
        let n = reader
            .by_ref()
            .take(MAX_HEAD - read)
            .read_until(b'\n', &mut line)
            .map_err(|_| HeadError::Gone)?;
        if n == 0 {
            return if lines.is_empty() && read == 0 {
                Ok(None)
            } else {
                Err(HeadError::Gone)
            };
        }
        read += n as u64;
        if !line.ends_with(b"\n") {
            return Err(HeadError::Bad(400, "the request head is too long"));
        }
        let line = String::from_utf8(line).map_err(|_| HeadError::Bad(400, "not a request"))?;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            // Blank lines before a request line are allowed (RFC 9112 2.2).
            if lines.is_empty() {
                continue;
            }
            break;
        }
        lines.push(line.to_string());
    }
    let bad = || HeadError::Bad(400, "not a request");
    let mut request_line = lines[0].split(' ');
    let (Some(method), Some(target), Some(version), None) = (
        request_line.next(),
        request_line.next(),
        request_line.next(),
        request_line.next(),
    ) else {
        return Err(bad());
    };
    let mut headers = Vec::with_capacity(lines.len() - 1);
    for line in &lines[1..] {
        let (name, value) = line.split_once(':').ok_or_else(bad)?;
        if name.is_empty() || name.contains(char::is_whitespace) {
            return Err(bad());
        }
        headers.push((name.to_ascii_lowercase(), value.trim().to_string()));
    }
    let connection = header_in(&headers, "connection")
        .unwrap_or("")
        .to_ascii_lowercase();
    let (version, keep_alive) = match version {
        "HTTP/1.1" => ((1, 1), !connection.contains("close")),
        "HTTP/1.0" => ((1, 0), connection.contains("keep-alive")),
        _ => return Err(HeadError::Bad(505, "only HTTP/1.0 and 1.1")),
    };
    Ok(Some(Head {
        method: method.to_string(),
        target: target.to_string(),
        version,
        keep_alive,
        headers,
    }))
}

/// Reads `n` bytes and keeps none of them.
pub fn discard(reader: &mut impl BufRead, n: u64) -> io::Result<()> {
    let read = io::copy(&mut reader.by_ref().take(n), &mut io::sink())?;
    if read == n {
        Ok(())
    } else {
        Err(io::ErrorKind::UnexpectedEof.into())
    }
}

/// How a request's body is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    Length(u64),
    Chunked,
}

/// A request's body, read as it comes: from a `Content-Length`, or chunk
/// by chunk. Reading past its end reads nothing; what is left unread can
/// be let go ([`Body::finish`]) so the connection carries on.
pub struct Body<'r, R: BufRead> {
    reader: &'r mut R,
    state: BodyState,
}

enum BodyState {
    /// Bytes left of a `Content-Length` body, or of the current chunk.
    Length(u64),
    /// Bytes left of the current chunk; at 0, a chunk size line next.
    Chunk {
        left: u64,
        started: bool,
    },
    Done,
    /// Malformed: the connection cannot carry on.
    Broken,
}

impl<'r, R: BufRead> Body<'r, R> {
    pub fn new(reader: &'r mut R, framing: Option<Framing>) -> Self {
        let state = match framing {
            None | Some(Framing::Length(0)) => BodyState::Done,
            Some(Framing::Length(n)) => BodyState::Length(n),
            Some(Framing::Chunked) => BodyState::Chunk {
                left: 0,
                started: false,
            },
        };
        Self { reader, state }
    }

    /// Reads and lets go of what is left, up to `max` bytes: whether the
    /// body is now read to its end, so the connection may carry another
    /// request.
    pub fn finish(&mut self, max: u64) -> bool {
        let mut buf = [0u8; 16 << 10];
        let mut left = max;
        loop {
            match self.state {
                BodyState::Done => return true,
                BodyState::Broken => return false,
                _ => {}
            }
            if left == 0 {
                return false;
            }
            let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
            match self.read(&mut buf[..want]) {
                Ok(0) => return matches!(self.state, BodyState::Done),
                Ok(n) => left -= n as u64,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return false,
            }
        }
    }

    /// The next chunk's size, after the end of the one before.
    fn next_chunk(&mut self, started: bool) -> io::Result<u64> {
        let bad = || io::Error::new(io::ErrorKind::InvalidData, "not a chunk");
        if started {
            let mut end = [0u8; 2];
            self.reader.read_exact(&mut end)?;
            if &end != b"\r\n" {
                return Err(bad());
            }
        }
        let mut line = Vec::new();
        self.reader
            .by_ref()
            .take(1024)
            .read_until(b'\n', &mut line)?;
        let text = std::str::from_utf8(&line).map_err(|_| bad())?;
        let size = text
            .trim_end_matches(['\r', '\n'])
            .split(';')
            .next()
            .and_then(|n| u64::from_str_radix(n.trim(), 16).ok())
            .ok_or_else(bad)?;
        if size == 0 {
            // Trailers, up to the blank line.
            loop {
                let mut trailer = Vec::new();
                let n = self
                    .reader
                    .by_ref()
                    .take(MAX_HEAD)
                    .read_until(b'\n', &mut trailer)?;
                if n == 0 || trailer == b"\r\n" || trailer == b"\n" {
                    break;
                }
            }
        }
        Ok(size)
    }
}

impl<R: BufRead> Read for Body<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            match self.state {
                BodyState::Done => return Ok(0),
                BodyState::Broken => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the request's body is malformed",
                    ));
                }
                BodyState::Length(0) => self.state = BodyState::Done,
                BodyState::Length(left) => {
                    let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
                    let n = self.reader.read(&mut buf[..want])?;
                    if n == 0 {
                        self.state = BodyState::Broken;
                        return Err(io::ErrorKind::UnexpectedEof.into());
                    }
                    self.state = BodyState::Length(left - n as u64);
                    return Ok(n);
                }
                BodyState::Chunk { left: 0, started } => match self.next_chunk(started) {
                    Ok(0) => self.state = BodyState::Done,
                    Ok(size) => {
                        self.state = BodyState::Chunk {
                            left: size,
                            started: true,
                        }
                    }
                    Err(e) => {
                        self.state = BodyState::Broken;
                        return Err(e);
                    }
                },
                BodyState::Chunk { left, started } => {
                    let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
                    let n = self.reader.read(&mut buf[..want])?;
                    if n == 0 {
                        self.state = BodyState::Broken;
                        return Err(io::ErrorKind::UnexpectedEof.into());
                    }
                    self.state = BodyState::Chunk {
                        left: left - n as u64,
                        started,
                    };
                    return Ok(n);
                }
            }
        }
    }
}

/// A count of something there is only so much of, taken and given back.
pub struct Budget {
    limit: u64,
    state: Mutex<Taken>,
    freed: Condvar,
}

#[derive(Default)]
struct Taken {
    held: u64,
    /// The most ever held at once, for the tests.
    peak: u64,
}

impl Budget {
    pub fn new(limit: u64) -> Self {
        Self {
            limit,
            state: Mutex::default(),
            freed: Condvar::new(),
        }
    }

    /// Takes `n` once there is room, waiting up to `wait`: false if there
    /// was none by then, or never could be.
    pub fn take(&self, n: u64, wait: Duration) -> bool {
        if n > self.limit {
            return false;
        }
        let deadline = Instant::now() + wait;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.held + n > self.limit {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            state = self
                .freed
                .wait_timeout(state, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        state.held += n;
        state.peak = state.peak.max(state.held);
        true
    }

    pub fn give(&self, n: u64) {
        if n == 0 {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.held = state.held.saturating_sub(n);
        drop(state);
        self.freed.notify_all();
    }

    #[cfg(test)]
    pub fn peak(&self) -> u64 {
        self.state.lock().unwrap().peak
    }
}

/// What a request holds of a [`Budget`], given back when it is dropped.
pub struct Held<'a> {
    budget: &'a Budget,
    n: u64,
}

impl<'a> Held<'a> {
    pub fn none(budget: &'a Budget) -> Self {
        Self { budget, n: 0 }
    }

    /// Takes `n` more ([`Budget::take`]).
    pub fn grow(&mut self, n: u64, wait: Duration) -> bool {
        let taken = self.budget.take(n, wait);
        if taken {
            self.n += n;
        }
        taken
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.budget.give(self.n);
    }
}

/// Connections open by client (a token, a credential), at most `per`
/// each.
pub struct Slots {
    per: usize,
    open: Mutex<HashMap<String, usize>>,
}

impl Slots {
    pub fn new(per: usize) -> Self {
        Self {
            per,
            open: Mutex::default(),
        }
    }

    pub fn per(&self) -> usize {
        self.per
    }

    /// One of `client`'s places, `None` when it holds them all.
    pub fn claim(&self, client: &str) -> Option<Slot<'_>> {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        let held = open.entry(client.to_string()).or_insert(0);
        if *held >= self.per {
            if *held == 0 {
                open.remove(client);
            }
            return None;
        }
        *held += 1;
        Some(Slot {
            slots: self,
            client: client.to_string(),
        })
    }
}

/// One of a client's places in [`Slots`], given back when dropped.
pub struct Slot<'a> {
    slots: &'a Slots,
    client: String,
}

impl Slot<'_> {
    pub fn client(&self) -> &str {
        &self.client
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut open = self.slots.open.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = open.get_mut(&self.client) {
            *held = held.saturating_sub(1);
            if *held == 0 {
                open.remove(&self.client);
            }
        }
    }
}

/// Gives every connection `incoming` accepts a thread of its own, named
/// `name`, running `serve`, up to `max` at once; one past that is closed
/// as it comes. Returns when `stop` is set and a connection arrives.
pub fn accept_each<S: Send + 'static>(
    incoming: impl Iterator<Item = io::Result<S>>,
    max: usize,
    stop: &AtomicBool,
    name: &str,
    serve: Arc<dyn Fn(S) + Send + Sync>,
) {
    let open = Arc::new(AtomicUsize::new(0));
    for stream in incoming {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let Ok(stream) = stream else {
            // Out of descriptors, say: not a spin while it lasts.
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if open.fetch_add(1, Ordering::SeqCst) >= max {
            open.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let (serve, held) = (serve.clone(), open.clone());
        let spawned = std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                serve(stream);
                held.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            open.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(bytes: &[u8], framing: Option<Framing>) -> (Vec<u8>, bool, Vec<u8>) {
        let mut reader = io::BufReader::new(bytes);
        let mut out = Vec::new();
        let mut b = Body::new(&mut reader, framing);
        let ok = b.read_to_end(&mut out).is_ok();
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        (out, ok, rest)
    }

    #[test]
    fn a_body_stops_at_its_end_and_leaves_the_next_request() {
        assert_eq!(
            body(b"helloGET /", Some(Framing::Length(5))),
            (b"hello".to_vec(), true, b"GET /".to_vec())
        );
        assert_eq!(
            body(
                b"3\r\ntar\r\n4;x=y\r\nball\r\n0\r\nX-T: 1\r\n\r\nGET /",
                Some(Framing::Chunked)
            ),
            (b"tarball".to_vec(), true, b"GET /".to_vec())
        );
        assert_eq!(body(b"GET /", None), (Vec::new(), true, b"GET /".to_vec()));
        // Cut short, or not chunks at all: an error, never more bytes.
        assert!(!body(b"hel", Some(Framing::Length(5))).1);
        assert!(!body(b"zz\r\nab\r\n", Some(Framing::Chunked)).1);
    }

    #[test]
    fn what_a_handler_left_unread_is_let_go_up_to_a_limit() {
        let mut reader = io::BufReader::new(&b"0123456789GET /"[..]);
        let mut b = Body::new(&mut reader, Some(Framing::Length(10)));
        let mut two = [0u8; 2];
        b.read_exact(&mut two).unwrap();
        assert!(b.finish(1 << 20));
        let mut rest = String::new();
        reader.read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "GET /");

        let mut reader = io::BufReader::new(&b"0123456789"[..]);
        let mut b = Body::new(&mut reader, Some(Framing::Length(10)));
        assert!(
            !b.finish(4),
            "more than the limit left: the connection ends"
        );
    }

    #[test]
    fn a_client_holds_at_most_its_places() {
        let slots = Slots::new(2);
        let a1 = slots.claim("a").unwrap();
        let _a2 = slots.claim("a").unwrap();
        assert!(slots.claim("a").is_none());
        let _b = slots.claim("b").unwrap();
        drop(a1);
        assert!(slots.claim("a").is_some());
    }

    #[test]
    fn a_budget_waits_for_room_and_gives_up_in_time() {
        let budget = Arc::new(Budget::new(10));
        assert!(budget.take(8, Duration::ZERO));
        assert!(!budget.take(3, Duration::from_millis(20)));
        assert!(
            !budget.take(11, Duration::from_secs(10)),
            "more than all of it"
        );
        let giver = {
            let budget = budget.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                budget.give(8);
            })
        };
        assert!(budget.take(3, Duration::from_secs(5)));
        giver.join().unwrap();
        assert_eq!(budget.peak(), 8);
    }
}
