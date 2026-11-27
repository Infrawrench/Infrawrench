//! Turborepo's remote cache, served by the runner to the jobs it runs.
//!
//! `turbo` keeps the outputs of the tasks it runs under a hash of their
//! inputs, and with `TURBO_API`, `TURBO_TOKEN` and `TURBO_TEAM` set it
//! also reads and writes them over HTTP (`GET`/`PUT
//! {TURBO_API}/v8/artifacts/{hash}`, Turborepo's remote cache API). The
//! runner answers that API from a Unix socket of its own, which a job with
//! a network reaches as port [`PORT`] of its gateway
//! (`iwci_sandbox::net`, `Network::local`) and nothing else reaches: no
//! host port is opened. Every job of a run gets the three variables
//! ([`JobEnv`]), unless it sets any of them itself, so a repository
//! already using a remote cache of its own keeps it.
//!
//! Each run registers its caches under a token of its own
//! ([`RemoteCache::register`]), which is how a request finds the run it is
//! from; the token is masked like a secret and stops working when the run
//! ends. An artifact is stored as a `cache:` entry is, in the run's scope
//! ([`crate::adapters::caches`]): a pull request reads the default
//! branch's artifacts and writes its own, which no push to the default
//! branch reads, and they count against the owner's quota and are evicted
//! with the rest.
//!
//! Every connection has a thread of its own for as long as it is open.
//! `turbo` opens several keep-alive connections at once and leaves them
//! open between requests; on tiny_http's connection pool, which only
//! starts a thread when it sees none waiting, a connection accepted just
//! after another could go unread until some other connection closed,
//! which `turbo` only does at its 30 s timeout. A task whose lookup hung
//! like that was built again, and a build whose upload hung was never
//! kept, so the next run missed it too.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::http1::{
    Budget, HeadError, Held, MAX_HEAD, Slot, Slots, accept_each, header_in, read_head,
};

/// The gateway port a job reaches the cache on.
pub const PORT: u16 = 7410;
/// The gateway's address as a job sees it (`iwci_sandbox::net::GATEWAY_V4`).
pub const GATEWAY: &str = "10.0.2.2";
/// The team every job is told: the cache has one per run, so the name only
/// has to be there (`turbo` uses the remote cache only when it has one).
const TEAM: &str = "iwci";
/// The largest artifact taken. `turbo` warns about one refused and carries
/// on; its next run builds that task again.
pub const MAX_ARTIFACT: u64 = 200 << 20;
/// A tag (`x-artifact-tag`, the artifact's signature) is at most this long
/// in Turborepo's API.
const MAX_TAG: usize = 600;
/// Connections open at once; one past this is closed as it comes. Each
/// holds a thread, and a job's `turbo` opens a handful.
const MAX_CONNECTIONS: usize = 512;
/// Connections one run's token may hold open at once, so one job cannot
/// take every connection from the others. A request on one more is
/// answered 429.
const MAX_PER_TOKEN: usize = 64;
/// Bytes of artifacts held at once across every connection: request bodies
/// as they are read and kept, and artifacts read for an answer until it is
/// sent. A request waits [`BODY_WAIT`] for room, then is answered 503.
const BODY_BUDGET: u64 = 2 << 30;
const BODY_WAIT: Duration = Duration::from_secs(10);
/// Requests answered at once (the store's reads and writes), as the 16
/// workers of the tiny_http pool this replaced were.
const ANSWERING: u64 = 16;
/// A client that reads none of an answer for this long is let go.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// The largest body of anything but an artifact (a query, events).
const MAX_SMALL_BODY: u64 = 1 << 20;
/// A connection that sends nothing for this long is closed.
const IDLE: Duration = Duration::from_secs(300);
/// Hashes one `POST /v8/artifacts` may ask about.
const MAX_QUERY: usize = 256;

/// What a run's artifacts are kept in.
pub trait Artifacts: Send + Sync {
    /// The artifact saved under `hash` where this run reads, if any.
    fn get(&self, hash: &str) -> Result<Option<Artifact>, String>;
    /// Saves `artifact` under `hash` where this run writes.
    fn put(&self, hash: &str, artifact: &Artifact) -> Result<(), String>;
}

/// One task's outputs as `turbo` sent them: a compressed tarball, which is
/// kept as it came, with what `turbo` said about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub body: Vec<u8>,
    /// How long the task took (`x-artifact-duration`), which `turbo`
    /// reports as time saved.
    pub duration_ms: u64,
    /// The artifact's signature (`x-artifact-tag`), when the repository
    /// signs its artifacts.
    pub tag: Option<String>,
}

/// Whether `hash` is a name an artifact may be kept under: `turbo`'s are
/// hex, and nothing else may reach a store key.
pub fn valid_hash(hash: &str) -> bool {
    (1..=128).contains(&hash.len())
        && hash
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_tag(tag: &str) -> bool {
    tag.len() <= MAX_TAG
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=-_".contains(&b))
}

type Runs = Mutex<HashMap<String, Arc<dyn Artifacts>>>;

/// The bounds the server keeps to; [`Limits::default`] in the runner,
/// smaller in tests.
#[derive(Debug, Clone, Copy)]
struct Limits {
    connections: usize,
    per_token: usize,
    body_budget: u64,
    body_wait: Duration,
    answering: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: MAX_CONNECTIONS,
            per_token: MAX_PER_TOKEN,
            body_budget: BODY_BUDGET,
            body_wait: BODY_WAIT,
            answering: ANSWERING,
        }
    }
}

/// What every connection shares.
struct Shared {
    runs: Arc<Runs>,
    limits: Limits,
    /// Artifact bytes held ([`Limits::body_budget`]).
    bytes: Budget,
    /// Requests being answered ([`Limits::answering`]).
    answering: Budget,
    /// Open connections by the token they last carried.
    tokens: Slots,
}

/// The runner's remote cache server, on its Unix socket.
pub struct RemoteCache {
    runs: Arc<Runs>,
    socket: PathBuf,
    stop: Arc<AtomicBool>,
    #[cfg(test)]
    shared: Arc<Shared>,
}

impl RemoteCache {
    /// Serves the cache on a Unix socket at `socket`, replacing what an
    /// earlier runner left there. Only the runner's own user may connect.
    pub fn start(socket: &Path) -> Result<Self, String> {
        Self::start_with(socket, Limits::default())
    }

    fn start_with(socket: &Path, limits: Limits) -> Result<Self, String> {
        let _ = std::fs::remove_file(socket);
        let listener = UnixListener::bind(socket)
            .map_err(|e| format!("the remote cache at {}: {e}", socket.display()))?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("the remote cache at {}: {e}", socket.display()))?;
        }
        let runs: Arc<Runs> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared {
            runs: runs.clone(),
            limits,
            bytes: Budget::new(limits.body_budget),
            answering: Budget::new(limits.answering),
            tokens: Slots::new(limits.per_token),
        });
        let (accepting, stopping) = (shared.clone(), stop.clone());
        std::thread::Builder::new()
            .name("iwci-remote-cache".into())
            .spawn(move || {
                let serve: Arc<dyn Fn(UnixStream) + Send + Sync> =
                    Arc::new(move |stream| connection(&accepting, stream));
                accept_each(
                    listener.incoming(),
                    limits.connections,
                    &stopping,
                    "iwci-remote-cache-conn",
                    serve,
                );
            })
            .map_err(|e| format!("the remote cache: {e}"))?;
        Ok(Self {
            runs,
            socket: socket.to_path_buf(),
            stop,
            #[cfg(test)]
            shared,
        })
    }

    /// Where it listens, for the gateways that lead to it.
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Serves `artifacts` to the jobs of one run until the registration
    /// is dropped.
    pub fn register(&self, artifacts: Arc<dyn Artifacts>) -> Result<Registration, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| format!("no randomness: {e}"))?;
        let token = hex::encode(bytes);
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token.clone(), artifacts);
        Ok(Registration {
            token,
            runs: self.runs.clone(),
        })
    }
}

impl Drop for RemoteCache {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wakes the accepting thread, which then sees `stop`.
        let _ = UnixStream::connect(&self.socket);
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// A run's way into the cache; dropping it closes that way.
pub struct Registration {
    token: String,
    runs: Arc<Runs>,
}

impl Registration {
    /// What the run's jobs are given.
    pub fn job_env(&self) -> JobEnv {
        JobEnv {
            token: self.token.clone(),
        }
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.token);
    }
}

/// The variables that point a job's `turbo` at the run's cache.
#[derive(Debug, Clone)]
pub struct JobEnv {
    /// The run's token, which the run masks like a secret.
    pub token: String,
}

/// A job that sets any of these uses a remote cache of its own.
const OWN_CACHE: [&str; 5] = [
    "TURBO_API",
    "TURBO_TOKEN",
    "TURBO_TEAM",
    "TURBO_TEAMID",
    "TURBO_LOGIN",
];

impl JobEnv {
    pub fn vars(&self) -> Vec<(String, String)> {
        vec![
            ("TURBO_API".into(), format!("http://{GATEWAY}:{PORT}")),
            ("TURBO_TOKEN".into(), self.token.clone()),
            ("TURBO_TEAM".into(), TEAM.into()),
        ]
    }

    /// Adds the variables to a job's `env`, unless it already names a
    /// remote cache of its own.
    pub fn add_to(&self, env: &mut Vec<(String, String)>) {
        if env.iter().any(|(k, _)| OWN_CACHE.contains(&k.as_str())) {
            return;
        }
        env.extend(self.vars());
    }
}

/// One request, its body read whole.
struct Request {
    method: String,
    /// The path, without the query.
    path: String,
    /// Names lowercased.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        header_in(&self.headers, name)
    }
}

/// What is sent back.
struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn with(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

fn json(status: u16, body: serde_json::Value) -> Reply {
    Reply {
        status,
        headers: vec![("Content-Type", "application/json".into())],
        body: body.to_string().into_bytes(),
    }
}

/// An error in the shape Turborepo's API gives one.
fn error(status: u16, code: &str, message: &str) -> Reply {
    json(
        status,
        serde_json::json!({ "code": code, "message": message }),
    )
}

/// No room in a budget within [`Limits::body_wait`].
fn busy() -> Reply {
    error(
        503,
        "service_unavailable",
        "the remote cache is busy; try again",
    )
    .with("Retry-After", "1")
}

fn too_big() -> Reply {
    error(
        413,
        "payload_too_large",
        &format!("artifacts over {} MiB are not kept", MAX_ARTIFACT >> 20),
    )
}

fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        505 => "HTTP Version Not Supported",
        _ => "",
    }
}

/// Writes `reply`, its body left out for a `HEAD` (its length still
/// given), saying `Connection: close` when the connection ends after it.
fn send(out: &mut impl Write, reply: &Reply, head_only: bool, close: bool) -> std::io::Result<()> {
    let mut text = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\n",
        reply.status,
        reason(reply.status),
        reply.body.len()
    );
    for (name, value) in &reply.headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    if close {
        text.push_str("Connection: close\r\n");
    }
    text.push_str("\r\n");
    let mut bytes = text.into_bytes();
    if !head_only {
        bytes.extend_from_slice(&reply.body);
    }
    out.write_all(&bytes)?;
    out.flush()
}

/// Why a request could not be read; the connection ends either way.
enum Unread {
    /// The client closed or went quiet: nothing to answer.
    Gone,
    /// Malformed, with what to answer.
    Bad(Reply),
    /// Read to its end, but with no room to keep it: answered 503, and
    /// the connection carries on.
    Busy,
}

/// Reads a body sent in chunks, refusing one of more than `limit` bytes,
/// taking each chunk's room in `held` before reading it.
fn read_chunked(
    reader: &mut impl BufRead,
    limit: u64,
    held: &mut Held<'_>,
    wait: Duration,
) -> Result<Vec<u8>, Unread> {
    let mut body = Vec::new();
    let mut refused = false;
    loop {
        let mut line = Vec::new();
        reader
            .by_ref()
            .take(1024)
            .read_until(b'\n', &mut line)
            .map_err(|_| Unread::Gone)?;
        let text = std::str::from_utf8(&line).map_err(|_| Unread::Gone)?;
        let size = text
            .trim_end_matches(['\r', '\n'])
            .split(';')
            .next()
            .and_then(|n| u64::from_str_radix(n.trim(), 16).ok())
            .ok_or(Unread::Bad(error(400, "bad_request", "not a chunk")))?;
        if size == 0 {
            // Trailers, up to the blank line.
            loop {
                let mut trailer = Vec::new();
                let n = reader
                    .by_ref()
                    .take(MAX_HEAD)
                    .read_until(b'\n', &mut trailer)
                    .map_err(|_| Unread::Gone)?;
                if n == 0 || trailer == b"\r\n" || trailer == b"\n" {
                    return if refused { Err(Unread::Busy) } else { Ok(body) };
                }
            }
        }
        if body.len() as u64 + size > limit {
            return Err(Unread::Bad(too_big()));
        }
        if refused || !held.grow(size, wait) {
            // Read and let go, so the client still gets its answer.
            refused = true;
            crate::http1::discard(reader, size + 2).map_err(|_| Unread::Gone)?;
            continue;
        }
        let at = body.len();
        body.resize(at + size as usize, 0);
        reader
            .read_exact(&mut body[at..])
            .map_err(|_| Unread::Gone)?;
        let mut end = [0u8; 2];
        reader.read_exact(&mut end).map_err(|_| Unread::Gone)?;
        if &end != b"\r\n" {
            return Err(Unread::Bad(error(400, "bad_request", "not a chunk")));
        }
    }
}

/// Serves one connection until the client closes it, asks to, goes quiet
/// for [`IDLE`], or sends what cannot be followed by another request.
fn connection(shared: &Shared, stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(IDLE));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    // The token this connection counts against.
    let mut slot = None;
    loop {
        let head = match read_head(&mut reader) {
            Ok(Some(head)) => head,
            Ok(None) | Err(HeadError::Gone) => return,
            Err(HeadError::Bad(status, message)) => {
                let code = if status == 505 {
                    "http_version_not_supported"
                } else {
                    "bad_request"
                };
                let _ = send(&mut out, &error(status, code, message), false, true);
                return;
            }
        };
        let head_only = head.method == "HEAD";
        let reply = match answer_head(shared, head, &mut reader, &mut out, &mut slot) {
            Ok((reply, keep_alive, held)) => {
                let sent = send(&mut out, &reply, head_only, !keep_alive);
                drop(held);
                if sent.is_err() || !keep_alive {
                    return;
                }
                continue;
            }
            Err(Unread::Gone) => return,
            Err(Unread::Bad(reply)) => reply,
            // Never left by `answer_head`, which answers it.
            Err(Unread::Busy) => busy(),
        };
        // The body was not read, so the next request's start is unknown.
        let _ = send(&mut out, &reply, head_only, true);
        return;
    }
}

/// Reads the body of the request `head` begins and answers it, with
/// whether the connection may carry another request and the room the
/// answer's body holds until it is sent.
fn answer_head<'a>(
    shared: &'a Shared,
    head: crate::http1::Head,
    reader: &mut impl BufRead,
    out: &mut impl Write,
    slot: &mut Option<Slot<'a>>,
) -> Result<(Reply, bool, Held<'a>), Unread> {
    let runs = &shared.runs;
    let wait = shared.limits.body_wait;
    let path = head
        .target
        .split_once('?')
        .map_or(head.target.as_str(), |(p, _)| p)
        .to_string();
    // The token first, so nobody else's body is read at all.
    let token = header_in(&head.headers, "authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    let artifacts = token.and_then(|t| {
        runs.lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(t)
            .cloned()
    });
    let (Some(artifacts), Some(token)) = (artifacts, token) else {
        return Err(Unread::Bad(error(
            401,
            "unauthorized",
            "not a token of a run on this runner, or its run has ended",
        )));
    };
    if slot.as_ref().is_none_or(|s| s.client() != token) {
        // Given back before the next is claimed, so a connection that
        // changes token never holds two.
        *slot = None;
        *slot = shared.tokens.claim(token);
        if slot.is_none() {
            return Err(Unread::Bad(
                error(
                    429,
                    "too_many_connections",
                    &format!(
                        "a run may hold {} connections to the remote cache at once",
                        shared.tokens.per()
                    ),
                )
                .with("Retry-After", "1"),
            ));
        }
    }
    let limit = if head.method == "PUT" {
        MAX_ARTIFACT
    } else {
        MAX_SMALL_BODY
    };
    let chunked = header_in(&head.headers, "transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let length = match header_in(&head.headers, "content-length") {
        _ if chunked => None,
        None => Some(0),
        Some(n) => Some(
            n.parse::<u64>()
                .map_err(|_| Unread::Bad(error(400, "bad_request", "not a length")))?,
        ),
    };
    if length.is_some_and(|n| n > limit) {
        // Refused by its stated length, before any of it is read.
        return Err(Unread::Bad(if head.method == "PUT" {
            too_big()
        } else {
            error(413, "payload_too_large", "the request is too large")
        }));
    }
    // The body's room first, so no more is read than the budget holds.
    let mut held = Held::none(&shared.bytes);
    let room = length.is_none_or(|n| held.grow(n, wait));
    let wants_body = chunked || length.is_some_and(|n| n > 0);
    let expects =
        header_in(&head.headers, "expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue"));
    if wants_body && expects && !room {
        // It waits to be told to send, so it need not send at all.
        return Err(Unread::Bad(busy()));
    }
    if wants_body && expects {
        out.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .map_err(|_| Unread::Gone)?;
    }
    let body = match length {
        None => match read_chunked(reader, limit, &mut held, wait) {
            Ok(body) => body,
            Err(Unread::Busy) => return Ok((busy(), head.keep_alive, held)),
            Err(e) => return Err(e),
        },
        Some(n) if !room => {
            // No room for it: read and let go, so the client still gets
            // its answer and the connection its next request.
            crate::http1::discard(reader, n).map_err(|_| Unread::Gone)?;
            return Ok((busy(), head.keep_alive, held));
        }
        Some(n) => {
            let mut body = vec![0u8; n as usize];
            reader.read_exact(&mut body).map_err(|_| Unread::Gone)?;
            body
        }
    };
    let request = Request {
        method: head.method,
        path,
        headers: head.headers,
        body,
    };
    let mut answering = Held::none(&shared.answering);
    if !answering.grow(1, wait) {
        return Ok((busy(), head.keep_alive, Held::none(&shared.bytes)));
    }
    let reply = answer(artifacts.as_ref(), request);
    // The request's body is gone; the answer's (an artifact read) holds
    // room until it is sent.
    drop(held);
    let mut sending = Held::none(&shared.bytes);
    let reply = if sending.grow(reply.body.len() as u64, wait) {
        reply
    } else {
        busy()
    };
    drop(answering);
    Ok((reply, head.keep_alive, sending))
}

fn answer(artifacts: &dyn Artifacts, mut request: Request) -> Reply {
    let (method, path) = (request.method.clone(), request.path.clone());
    let method = method.as_str();
    match (method, path.as_str()) {
        ("GET", "/v8/artifacts/status") => json(200, serde_json::json!({ "status": "enabled" })),
        // Hit and miss events, which nothing here records.
        ("POST", "/v8/artifacts/events") => Reply {
            status: 200,
            headers: Vec::new(),
            body: Vec::new(),
        },
        ("POST", "/v8/artifacts") => query(artifacts, &request),
        (_, p) if p.starts_with("/v8/artifacts/") => {
            let hash = &p["/v8/artifacts/".len()..];
            if !valid_hash(hash) {
                return error(400, "bad_request", "not an artifact hash");
            }
            match method {
                "GET" | "HEAD" => match artifacts.get(hash) {
                    Ok(Some(a)) => {
                        let mut reply = Reply {
                            status: 200,
                            headers: Vec::new(),
                            body: a.body,
                        }
                        .with("Content-Type", "application/octet-stream")
                        .with("x-artifact-duration", a.duration_ms.to_string());
                        if let Some(tag) = a.tag {
                            reply = reply.with("x-artifact-tag", tag);
                        }
                        reply
                    }
                    Ok(None) => error(404, "not_found", "no such artifact"),
                    Err(e) => {
                        eprintln!("iwci: remote cache: reading {hash}: {e}");
                        error(500, "internal_error", "the artifact could not be read")
                    }
                },
                "PUT" => put(artifacts, hash, &mut request),
                _ => error(405, "method_not_allowed", "not a method of this path"),
            }
        }
        _ => error(404, "not_found", "not a path of the remote cache"),
    }
}

fn put(artifacts: &dyn Artifacts, hash: &str, request: &mut Request) -> Reply {
    let duration_ms = request
        .header("x-artifact-duration")
        .and_then(|d| d.trim().parse().ok())
        .unwrap_or(0);
    let tag = request.header("x-artifact-tag").map(str::to_string);
    if tag.as_deref().is_some_and(|t| !valid_tag(t)) {
        return error(400, "bad_request", "not an artifact tag");
    }
    let artifact = Artifact {
        body: std::mem::take(&mut request.body),
        duration_ms,
        tag,
    };
    match artifacts.put(hash, &artifact) {
        Ok(()) => json(202, serde_json::json!({ "urls": [] })),
        Err(e) => {
            eprintln!("iwci: remote cache: saving {hash}: {e}");
            error(500, "internal_error", "the artifact could not be saved")
        }
    }
}

/// `POST /v8/artifacts`: what is known of each of a list of hashes.
fn query(artifacts: &dyn Artifacts, request: &Request) -> Reply {
    #[derive(serde::Deserialize)]
    struct Query {
        hashes: Vec<String>,
    }
    let Ok(asked) = serde_json::from_slice::<Query>(&request.body) else {
        return error(400, "bad_request", "expected {\"hashes\": [...]}");
    };
    if asked.hashes.len() > MAX_QUERY {
        return error(
            400,
            "bad_request",
            &format!("at most {MAX_QUERY} hashes at once"),
        );
    }
    let mut found = serde_json::Map::new();
    for hash in asked.hashes {
        let value = if !valid_hash(&hash) {
            serde_json::json!({ "error": { "message": "not an artifact hash" } })
        } else {
            match artifacts.get(&hash) {
                Ok(Some(a)) => {
                    let mut v = serde_json::json!({
                        "size": a.body.len(),
                        "taskDurationMs": a.duration_ms,
                    });
                    if let Some(tag) = a.tag {
                        v["tag"] = tag.into();
                    }
                    v
                }
                Ok(None) => serde_json::Value::Null,
                Err(_) => {
                    serde_json::json!({ "error": { "message": "the artifact could not be read" } })
                }
            }
        };
        found.insert(hash, value);
    }
    json(200, serde_json::Value::Object(found))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    #[derive(Default)]
    struct Memory(Mutex<HashMap<String, Artifact>>);

    impl Artifacts for Memory {
        fn get(&self, hash: &str) -> Result<Option<Artifact>, String> {
            Ok(self.0.lock().unwrap().get(hash).cloned())
        }
        fn put(&self, hash: &str, artifact: &Artifact) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(hash.to_string(), artifact.clone());
            Ok(())
        }
    }

    fn socket_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("iwci-rc-{}-{name}.sock", std::process::id()))
    }

    /// One HTTP/1.1 request over the socket: the status and the body.
    fn request(
        socket: &Path,
        method: &str,
        path: &str,
        token: Option<&str>,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut stream = UnixStream::connect(socket).unwrap();
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: cache\r\nConnection: close\r\n");
        if let Some(token) = token {
            head.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).unwrap();
        let split = reply
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("a response head");
        let head = String::from_utf8_lossy(&reply[..split]).to_string();
        let mut lines = head.lines();
        let status = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        (status, headers, reply[split + 4..].to_vec())
    }

    fn header_of<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn a_run_puts_and_gets_its_artifacts_with_their_duration_and_tag() {
        let socket = socket_path("roundtrip");
        let cache = RemoteCache::start(&socket).unwrap();
        let store = Arc::new(Memory::default());
        let run = cache.register(store.clone()).unwrap();
        let token = run.job_env().token;
        let t = Some(token.as_str());

        let (status, _, body) = request(&socket, "GET", "/v8/artifacts/status", t, &[], b"");
        assert_eq!(status, 200);
        assert_eq!(body, br#"{"status":"enabled"}"#);

        let (status, _, _) = request(
            &socket,
            "GET",
            "/v8/artifacts/0123abcd?slug=iwci",
            t,
            &[],
            b"",
        );
        assert_eq!(status, 404, "a miss");

        let (status, _, _) = request(
            &socket,
            "PUT",
            "/v8/artifacts/0123abcd?slug=iwci",
            t,
            &[
                ("x-artifact-duration", "1234"),
                ("x-artifact-tag", "c2lnbmF0dXJl"),
            ],
            b"tarball bytes",
        );
        assert_eq!(status, 202);
        let (status, headers, body) = request(
            &socket,
            "GET",
            "/v8/artifacts/0123abcd?slug=iwci",
            t,
            &[],
            b"",
        );
        assert_eq!(status, 200);
        assert_eq!(body, b"tarball bytes");
        assert_eq!(header_of(&headers, "x-artifact-duration"), Some("1234"));
        assert_eq!(header_of(&headers, "x-artifact-tag"), Some("c2lnbmF0dXJl"));
        assert_eq!(header_of(&headers, "content-length"), Some("13"));

        let (status, headers, body) =
            request(&socket, "HEAD", "/v8/artifacts/0123abcd", t, &[], b"");
        assert_eq!(status, 200);
        assert!(body.is_empty());
        assert_eq!(header_of(&headers, "x-artifact-duration"), Some("1234"));

        let (status, _, body) = request(
            &socket,
            "POST",
            "/v8/artifacts",
            t,
            &[("Content-Type", "application/json")],
            br#"{"hashes":["0123abcd","ffff"]}"#,
        );
        assert_eq!(status, 200);
        let found: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(found["0123abcd"]["size"], 13);
        assert_eq!(found["0123abcd"]["taskDurationMs"], 1234);
        assert!(found["ffff"].is_null());

        let (status, _, _) = request(&socket, "POST", "/v8/artifacts/events", t, &[], b"[]");
        assert_eq!(status, 200);
    }

    #[test]
    fn only_a_live_runs_token_reaches_its_artifacts() {
        let socket = socket_path("tokens");
        let cache = RemoteCache::start(&socket).unwrap();
        let a = Arc::new(Memory::default());
        let b = Arc::new(Memory::default());
        let run_a = cache.register(a.clone()).unwrap();
        let run_b = cache.register(b.clone()).unwrap();
        let (ta, tb) = (run_a.job_env().token, run_b.job_env().token);
        assert_ne!(ta, tb);

        let put =
            |token: Option<&str>| request(&socket, "PUT", "/v8/artifacts/aa", token, &[], b"x").0;
        assert_eq!(put(None), 401);
        assert_eq!(put(Some("not-a-token")), 401);
        assert_eq!(put(Some(&ta)), 202);
        assert!(a.0.lock().unwrap().contains_key("aa"));
        assert!(
            b.0.lock().unwrap().is_empty(),
            "one run's put is not another's"
        );
        let get =
            |token: &str| request(&socket, "GET", "/v8/artifacts/aa", Some(token), &[], b"").0;
        assert_eq!(get(&tb), 404);

        drop(run_a);
        assert_eq!(get(&ta), 401, "an ended run's token is refused");
        assert_eq!(get(&tb), 404);
    }

    #[test]
    fn bad_hashes_tags_and_oversized_artifacts_are_refused() {
        let socket = socket_path("refusals");
        let cache = RemoteCache::start(&socket).unwrap();
        let store = Arc::new(Memory::default());
        let run = cache.register(store.clone()).unwrap();
        let token = run.job_env().token;
        let t = Some(token.as_str());
        let (status, _, _) = request(&socket, "GET", "/v8/artifacts/..%2Fx", t, &[], b"");
        assert_eq!(status, 400);
        let (status, _, _) = request(
            &socket,
            "PUT",
            "/v8/artifacts/ab",
            t,
            &[("x-artifact-tag", "not a tag\u{7f}")],
            b"x",
        );
        assert_eq!(status, 400);
        // Refused by its stated length, before any of it is read.
        let mut stream = UnixStream::connect(&socket).unwrap();
        write!(
            stream,
            "PUT /v8/artifacts/ab HTTP/1.1\r\nHost: c\r\nConnection: close\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
            MAX_ARTIFACT + 1
        )
        .unwrap();
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        assert!(reply.starts_with("HTTP/1.1 413"), "{reply}");
        assert!(store.0.lock().unwrap().is_empty());
        let (status, _, _) = request(&socket, "GET", "/v2/teams", t, &[], b"");
        assert_eq!(status, 404);
    }

    #[test]
    fn a_job_with_a_remote_cache_of_its_own_keeps_it() {
        let env = JobEnv { token: "t".into() };
        let mut plain = vec![("CI".to_string(), "true".to_string())];
        env.add_to(&mut plain);
        assert!(plain.contains(&("TURBO_API".into(), "http://10.0.2.2:7410".into())));
        assert!(plain.contains(&("TURBO_TOKEN".into(), "t".into())));
        assert!(plain.contains(&("TURBO_TEAM".into(), "iwci".into())));
        let mut own = vec![("TURBO_TOKEN".to_string(), "vercel".to_string())];
        env.add_to(&mut own);
        assert_eq!(own, vec![("TURBO_TOKEN".to_string(), "vercel".to_string())]);
    }

    /// `turbo` opens several keep-alive connections at once and leaves
    /// them open between requests. Each must be answered while the others
    /// stay open: on tiny_http's own connection pool, a connection accepted
    /// just after another could wait, unread, until some other connection
    /// closed, which `turbo` only does after its 30 s timeout.
    #[test]
    fn connections_opened_together_are_all_answered_while_they_stay_open() {
        use std::io::BufRead;
        for round in 0..20 {
            let socket = socket_path(&format!("together-{round}"));
            let cache = RemoteCache::start(&socket).unwrap();
            let run = cache.register(Arc::new(Memory::default())).unwrap();
            let token = run.job_env().token;
            let barrier = Arc::new(std::sync::Barrier::new(12));
            let threads: Vec<_> = (0..12)
                .map(|_| {
                    let (socket, token, barrier) = (socket.clone(), token.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        let stream = UnixStream::connect(&socket).unwrap();
                        stream
                            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                            .unwrap();
                        let mut writer = stream.try_clone().unwrap();
                        write!(
                            writer,
                            "GET /v8/artifacts/status HTTP/1.1\r\nHost: c\r\nAuthorization: Bearer {token}\r\n\r\n"
                        )
                        .unwrap();
                        let mut status = String::new();
                        let answered = std::io::BufReader::new(stream)
                            .read_line(&mut status)
                            .is_ok_and(|n| n > 0);
                        // Kept open until every connection has its answer,
                        // as a client's pool keeps them.
                        barrier.wait();
                        drop(writer);
                        answered
                    })
                })
                .collect();
            let answered = threads
                .into_iter()
                .map(|t| t.join().unwrap())
                .filter(|a| *a)
                .count();
            assert_eq!(answered, 12, "round {round}: a connection was never read");
            drop(run);
            drop(cache);
        }
    }

    /// What `turbo`'s client does on one connection: several requests in
    /// turn, a `HEAD` (no body, its length still given), an upload sent in
    /// chunks after `Expect: 100-continue`, and the artifact read back.
    #[test]
    fn one_connection_carries_requests_in_turn_heads_and_chunked_uploads() {
        let socket = socket_path("keepalive");
        let cache = RemoteCache::start(&socket).unwrap();
        let store = Arc::new(Memory::default());
        let run = cache.register(store.clone()).unwrap();
        let token = run.job_env().token;
        let mut stream = UnixStream::connect(&socket).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        // A response: its status line, headers and the body its length gives.
        let reply = |reader: &mut std::io::BufReader<UnixStream>, head_only: bool| {
            use std::io::BufRead;
            let mut status = String::new();
            reader.read_line(&mut status).unwrap();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; if head_only { 0 } else { length }];
            reader.read_exact(&mut body).unwrap();
            (status.split(' ').nth(1).unwrap().to_string(), length, body)
        };
        let auth = format!("Authorization: Bearer {token}\r\n");

        write!(
            stream,
            "HEAD /v8/artifacts/ab HTTP/1.1\r\nHost: c\r\n{auth}\r\n"
        )
        .unwrap();
        assert_eq!(reply(&mut reader, true).0, "404");

        write!(
            stream,
            "PUT /v8/artifacts/ab HTTP/1.1\r\nHost: c\r\n{auth}x-artifact-duration: 7\r\nTransfer-Encoding: chunked\r\nExpect: 100-continue\r\n\r\n"
        )
        .unwrap();
        let (status, _, _) = reply(&mut reader, false);
        assert_eq!(status, "100");
        stream
            .write_all(b"3\r\ntar\r\n4;x=y\r\nball\r\n0\r\n\r\n")
            .unwrap();
        assert_eq!(reply(&mut reader, false).0, "202");
        assert_eq!(store.0.lock().unwrap()["ab"].body, b"tarball");

        write!(
            stream,
            "HEAD /v8/artifacts/ab HTTP/1.1\r\nHost: c\r\n{auth}\r\n"
        )
        .unwrap();
        assert_eq!(reply(&mut reader, true), ("200".to_string(), 7, Vec::new()));
        write!(
            stream,
            "GET /v8/artifacts/ab HTTP/1.1\r\nHost: c\r\n{auth}\r\n"
        )
        .unwrap();
        assert_eq!(
            reply(&mut reader, false),
            ("200".to_string(), 7, b"tarball".to_vec())
        );
    }

    /// A store whose writes take `delay`, so uploads overlap.
    struct Slow(Memory, std::time::Duration);

    impl Artifacts for Slow {
        fn get(&self, hash: &str) -> Result<Option<Artifact>, String> {
            self.0.get(hash)
        }
        fn put(&self, hash: &str, artifact: &Artifact) -> Result<(), String> {
            std::thread::sleep(self.1);
            self.0.put(hash, artifact)
        }
    }

    fn put_body(
        socket: &Path,
        token: &str,
        hash: &str,
        len: usize,
    ) -> (u16, Vec<(String, String)>) {
        let (status, headers, _) = request(
            socket,
            "PUT",
            &format!("/v8/artifacts/{hash}"),
            Some(token),
            &[],
            &vec![7u8; len],
        );
        (status, headers)
    }

    /// Jobs are not trusted with the runner's memory: however many
    /// uploads arrive at once, what is held of them stays in the budget,
    /// and each waits its turn rather than failing.
    #[test]
    fn concurrent_large_uploads_stay_within_the_body_budget() {
        let socket = socket_path("budget");
        let limits = Limits {
            body_budget: 1 << 20,
            body_wait: std::time::Duration::from_secs(20),
            ..Limits::default()
        };
        let cache = RemoteCache::start_with(&socket, limits).unwrap();
        let store = Arc::new(Slow(
            Memory::default(),
            std::time::Duration::from_millis(30),
        ));
        let run = cache.register(store.clone()).unwrap();
        let token = run.job_env().token;
        let threads: Vec<_> = (0..12)
            .map(|i| {
                let (socket, token) = (socket.clone(), token.clone());
                std::thread::spawn(move || put_body(&socket, &token, &format!("a{i}"), 300 << 10).0)
            })
            .collect();
        for t in threads {
            assert_eq!(t.join().unwrap(), 202);
        }
        assert_eq!(store.0.0.lock().unwrap().len(), 12);
        let peak = cache.shared.bytes.peak();
        assert!(peak <= 1 << 20, "held {peak} bytes at once");
        assert!(peak >= 300 << 10, "held {peak} bytes at once");
    }

    #[test]
    fn an_upload_with_no_room_in_time_is_answered_503() {
        let socket = socket_path("busy");
        let limits = Limits {
            body_budget: 1 << 20,
            body_wait: std::time::Duration::from_millis(100),
            ..Limits::default()
        };
        let cache = RemoteCache::start_with(&socket, limits).unwrap();
        let store = Arc::new(Slow(
            Memory::default(),
            std::time::Duration::from_millis(1500),
        ));
        let run = cache.register(store.clone()).unwrap();
        let token = run.job_env().token;
        let first = {
            let (socket, token) = (socket.clone(), token.clone());
            std::thread::spawn(move || put_body(&socket, &token, "first", 800 << 10).0)
        };
        std::thread::sleep(std::time::Duration::from_millis(400));
        let (status, headers) = put_body(&socket, &token, "second", 800 << 10);
        assert_eq!(status, 503);
        assert_eq!(header_of(&headers, "retry-after"), Some("1"));
        assert_eq!(first.join().unwrap(), 202);
        // Room again once the first is kept.
        assert_eq!(put_body(&socket, &token, "second", 800 << 10).0, 202);
    }

    /// One request and its answer on an open connection: the status.
    fn exchange(
        stream: &mut UnixStream,
        reader: &mut std::io::BufReader<UnixStream>,
        token: &str,
    ) -> String {
        use std::io::BufRead;
        write!(
            stream,
            "GET /v8/artifacts/status HTTP/1.1\r\nHost: c\r\nAuthorization: Bearer {token}\r\n\r\n"
        )
        .unwrap();
        let mut status = String::new();
        reader.read_line(&mut status).unwrap();
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = v.trim().parse().unwrap();
            }
        }
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).unwrap();
        status.split(' ').nth(1).unwrap_or_default().to_string()
    }

    fn open(socket: &Path) -> (UnixStream, std::io::BufReader<UnixStream>) {
        let stream = UnixStream::connect(socket).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let reader = std::io::BufReader::new(stream.try_clone().unwrap());
        (stream, reader)
    }

    #[test]
    fn a_token_past_its_connection_cap_is_refused_while_another_gets_through() {
        let socket = socket_path("per-token");
        let limits = Limits {
            per_token: 2,
            ..Limits::default()
        };
        let cache = RemoteCache::start_with(&socket, limits).unwrap();
        let a = cache.register(Arc::new(Memory::default())).unwrap();
        let b = cache.register(Arc::new(Memory::default())).unwrap();
        let (ta, tb) = (a.job_env().token, b.job_env().token);
        let (mut a1, mut r1) = open(&socket);
        let (mut a2, mut r2) = open(&socket);
        assert_eq!(exchange(&mut a1, &mut r1, &ta), "200");
        assert_eq!(exchange(&mut a2, &mut r2, &ta), "200");
        // Both still open: a third of the same run's is refused.
        let (mut a3, mut r3) = open(&socket);
        assert_eq!(exchange(&mut a3, &mut r3, &ta), "429");
        // Another run's still gets through, and so do the first two again.
        let (mut b1, mut rb) = open(&socket);
        assert_eq!(exchange(&mut b1, &mut rb, &tb), "200");
        assert_eq!(exchange(&mut a1, &mut r1, &ta), "200");
        // Once one closes, its place is the run's again.
        drop((a2, r2));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let (mut a4, mut r4) = open(&socket);
            if exchange(&mut a4, &mut r4, &ta) == "200" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the closed connection's place never came back"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}
