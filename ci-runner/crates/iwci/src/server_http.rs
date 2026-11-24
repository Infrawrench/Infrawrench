//! `iwci serve`'s connections: each served on a thread of its own for as
//! long as it is open ([`crate::http1`]), its requests answered in turn
//! by [`Server::handle`], whose answers are tiny_http's [`Response`]s, sent
//! as tiny_http sent them.
//!
//! The proxy keeps keep-alive connections open to the runner. On
//! tiny_http's connection pool one of them could go unread until another
//! closed (`crate::http1` has why), and the proxy's read of a run waited
//! out its 20 s timeout where the runner answers in a fifth of a second.
//!
//! Bounds:
//!
//! - [`MAX_CONNECTIONS`] connections at once; one past that is closed.
//! - Per client: a cloud job's machine, known by its claim token
//!   (`?claim=`), holds at most [`PER_CLAIM`] connections, and one without
//!   any credential [`PER_ANONYMOUS`] across all such; a request on one
//!   more is answered 429. The runner's key (the proxy) has only the
//!   runner-wide cap.
//! - The bodies the server reads whole (every JSON body, each at most
//!   `MAX_BODY`) are held to [`BUFFERED_BODIES`] across every connection;
//!   a request that finds no room within [`BODY_WAIT`] is answered 503
//!   with `Retry-After`. An artifact upload (`PUT .../artifacts?claim=`)
//!   streams through and holds none.

use std::io::{BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use tiny_http::{HTTPVersion, Header, Method, ResponseBox};

use super::{MAX_BODY, Server, error};
use crate::http1::{Body, Budget, HeadError, Held, Slot, Slots, accept_each, read_head};

/// Connections open at once.
pub(super) const MAX_CONNECTIONS: usize = 1024;
/// Connections one claim token (a cloud job's machine) may hold.
pub(super) const PER_CLAIM: usize = 16;
/// Connections without a credential, all of them together.
pub(super) const PER_ANONYMOUS: usize = 64;
/// Bytes of request bodies read whole, across every connection.
pub(super) const BUFFERED_BODIES: u64 = 256 << 20;
/// How long a request waits for room among [`BUFFERED_BODIES`].
pub(super) const BODY_WAIT: Duration = Duration::from_secs(10);
/// A connection that sends nothing for this long is closed.
const IDLE: Duration = Duration::from_secs(300);
/// A client that reads none of an answer for this long is let go. A live
/// log's stream writes as the run writes, so only a client that has stopped
/// reading meets it.
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);
/// What is read and let go of a body a handler left, so the connection
/// carries on; past it, the connection ends.
const MAX_DRAIN: u64 = 1 << 20;

/// What every connection shares.
pub(super) struct Bounds {
    claims: Slots,
    anonymous: Slots,
    buffered: Budget,
}

impl Bounds {
    pub(super) fn new() -> Self {
        Self::with(PER_CLAIM, PER_ANONYMOUS, BUFFERED_BODIES)
    }

    pub(super) fn with(per_claim: usize, anonymous: usize, buffered: u64) -> Self {
        Self {
            claims: Slots::new(per_claim),
            anonymous: Slots::new(anonymous),
            buffered: Budget::new(buffered),
        }
    }
}

/// One request as [`Server::handle`] reads it: tiny_http's methods, over a
/// body read as it comes.
pub(crate) struct Request<'r> {
    method: Method,
    url: String,
    headers: Vec<Header>,
    body: Body<'r, BufReader<TcpStream>>,
}

impl Request<'_> {
    pub(crate) fn method(&self) -> &Method {
        &self.method
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    pub(crate) fn headers(&self) -> &[Header] {
        &self.headers
    }

    pub(crate) fn as_reader(&mut self) -> &mut dyn Read {
        &mut self.body
    }
}

/// Which of [`Bounds`]' clients a request is.
enum Client<'a> {
    Claim(&'a str),
    Key,
    Anonymous,
}

fn client_of(target: &str, has_key: bool) -> Client<'_> {
    let query = target.split_once('?').map_or("", |(_, q)| q);
    match query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == "claim")
    {
        Some((_, token)) => Client::Claim(token),
        None if has_key => Client::Key,
        None => Client::Anonymous,
    }
}

fn send(
    out: &mut TcpStream,
    response: ResponseBox,
    version: (u8, u8),
    headers: &[Header],
    head_only: bool,
) -> bool {
    response
        .raw_print(
            &mut *out,
            HTTPVersion(version.0, version.1),
            headers,
            head_only,
            None,
        )
        .and_then(|()| out.flush())
        .is_ok()
}

fn busy() -> ResponseBox {
    error(503, "the runner is busy; try again")
        .with_header(Header::from_bytes(&b"Retry-After"[..], &b"1"[..]).expect("valid header"))
        .boxed()
}

impl Server {
    /// Serves `listener` until the process ends.
    pub(super) fn serve_on(self: Arc<Self>, listener: TcpListener) {
        let stop = AtomicBool::new(false);
        let serve: Arc<dyn Fn(TcpStream) + Send + Sync> =
            Arc::new(move |stream| self.connection(stream));
        accept_each(
            listener.incoming(),
            MAX_CONNECTIONS,
            &stop,
            "iwci-serve-conn",
            serve,
        );
    }

    /// Serves one connection until the client closes it, asks to, goes
    /// quiet for [`IDLE`], or leaves what cannot be followed by another
    /// request.
    fn connection(self: &Arc<Self>, stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(IDLE));
        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
        let _ = stream.set_nodelay(true);
        let Ok(mut out) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        // The place this connection holds among its client's.
        let mut slot: Option<Slot<'_>> = None;
        loop {
            let head = match read_head(&mut reader) {
                Ok(Some(head)) => head,
                Ok(None) | Err(HeadError::Gone) => return,
                Err(HeadError::Bad(status, message)) => {
                    send(&mut out, error(status, message).boxed(), (1, 1), &[], false);
                    return;
                }
            };
            let head_only = head.method == "HEAD";
            let version = head.version;
            let Ok(headers) = head
                .headers
                .iter()
                .map(|(k, v)| Header::from_bytes(k.as_bytes(), v.as_bytes()))
                .collect::<Result<Vec<_>, _>>()
            else {
                send(
                    &mut out,
                    error(400, "a header is not ASCII").boxed(),
                    version,
                    &[],
                    false,
                );
                return;
            };
            let framing = match head.framing() {
                Ok(framing) => framing,
                Err(why) => {
                    send(&mut out, error(400, why).boxed(), version, &headers, false);
                    return;
                }
            };
            let has_key = head.header("authorization").is_some();
            let slots = match client_of(&head.target, has_key) {
                Client::Claim(token) => Some((&self.bounds.claims, format!("claim:{token}"))),
                Client::Anonymous => Some((&self.bounds.anonymous, String::new())),
                Client::Key => None,
            };
            match slots {
                Some((_, ref client)) if slot.as_ref().is_some_and(|s| s.client() == client) => {}
                Some((slots, client)) => {
                    // Given back before the next is claimed.
                    drop(slot.take());
                    slot = slots.claim(&client);
                    if slot.is_none() {
                        let refused = error(429, "too many connections from this client")
                            .with_header(
                                Header::from_bytes(&b"Retry-After"[..], &b"1"[..])
                                    .expect("valid header"),
                            )
                            .boxed();
                        send(&mut out, refused, version, &headers, head_only);
                        return;
                    }
                }
                None => slot = None,
            }
            // Every body but an artifact upload is read whole by its
            // handler, up to `MAX_BODY`: room for that much first.
            let streams = head.method == "PUT"
                && matches!(client_of(&head.target, has_key), Client::Claim(_));
            let mut held = Held::none(&self.bounds.buffered);
            if let Some(framing) = framing
                && !streams
            {
                let want = match framing {
                    crate::http1::Framing::Length(n) => n.min(MAX_BODY as u64 + 1),
                    crate::http1::Framing::Chunked => MAX_BODY as u64 + 1,
                };
                if !held.grow(want, BODY_WAIT) {
                    let mut body = Body::new(&mut reader, Some(framing));
                    let carry_on = body.finish(MAX_DRAIN);
                    if !send(&mut out, busy(), version, &headers, head_only) || !carry_on {
                        return;
                    }
                    continue;
                }
            }
            if framing.is_some()
                && head.expects_continue()
                && out.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err()
            {
                return;
            }
            let Ok(method) = head.method.parse::<Method>() else {
                send(
                    &mut out,
                    error(400, "not a method").boxed(),
                    version,
                    &headers,
                    false,
                );
                return;
            };
            let mut request = Request {
                method,
                url: head.target,
                headers: headers.clone(),
                body: Body::new(&mut reader, framing),
            };
            let response = self.handle(&mut request);
            let carry_on = head.keep_alive && request.body.finish(MAX_DRAIN);
            drop(request);
            drop(held);
            if !send(&mut out, response, version, &headers, head_only) || !carry_on {
                return;
            }
        }
    }
}
