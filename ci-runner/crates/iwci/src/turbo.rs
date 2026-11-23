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

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tiny_http::{Header, Method, Request, Response, Server};

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
/// Requests served at once: `turbo` uploads and downloads in parallel.
const WORKERS: usize = 16;
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

/// The runner's remote cache server, on its Unix socket.
pub struct RemoteCache {
    server: Arc<Server>,
    runs: Arc<Runs>,
    socket: PathBuf,
}

impl RemoteCache {
    /// Serves the cache on a Unix socket at `socket`, replacing what an
    /// earlier runner left there. Only the runner's own user may connect.
    pub fn start(socket: &Path) -> Result<Self, String> {
        let _ = std::fs::remove_file(socket);
        let server = Arc::new(
            Server::http_unix(socket)
                .map_err(|e| format!("the remote cache at {}: {e}", socket.display()))?,
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("the remote cache at {}: {e}", socket.display()))?;
        }
        let runs: Arc<Runs> = Arc::default();
        for _ in 0..WORKERS {
            let (server, runs) = (server.clone(), runs.clone());
            std::thread::Builder::new()
                .name("iwci-remote-cache".into())
                .spawn(move || {
                    while let Ok(request) = server.recv() {
                        serve(&runs, request);
                    }
                })
                .map_err(|e| format!("the remote cache: {e}"))?;
        }
        Ok(Self {
            server,
            runs,
            socket: socket.to_path_buf(),
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
        for _ in 0..WORKERS {
            self.server.unblock();
        }
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

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn h(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("a valid header")
}

fn json(status: u16, body: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(body.to_string().into_bytes())
        .with_status_code(status)
        .with_header(h("Content-Type", "application/json"))
}

/// An error in the shape Turborepo's API gives one.
fn error(status: u16, code: &str, message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    json(
        status,
        serde_json::json!({ "code": code, "message": message }),
    )
}

fn serve(runs: &Runs, mut request: Request) {
    let response = answer(runs, &mut request);
    let _ = request.respond(response);
}

fn answer(runs: &Runs, request: &mut Request) -> Response<std::io::Cursor<Vec<u8>>> {
    let token = header(request, "Authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    let artifacts = token.and_then(|t| {
        runs.lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(t)
            .cloned()
    });
    let Some(artifacts) = artifacts else {
        return error(
            401,
            "unauthorized",
            "not a token of a run on this runner, or its run has ended",
        );
    };
    let url = request.url().to_string();
    let path = url.split_once('?').map_or(url.as_str(), |(p, _)| p);
    let method = request.method().clone();
    match (&method, path) {
        (Method::Get, "/v8/artifacts/status") => {
            json(200, serde_json::json!({ "status": "enabled" }))
        }
        (Method::Post, "/v8/artifacts/events") => {
            // Hit and miss events, which nothing here records.
            let _ = std::io::copy(&mut request.as_reader().take(1 << 20), &mut std::io::sink());
            Response::from_data(Vec::new()).with_status_code(200)
        }
        (Method::Post, "/v8/artifacts") => query(artifacts.as_ref(), request),
        (_, p) if p.starts_with("/v8/artifacts/") => {
            let hash = &p["/v8/artifacts/".len()..];
            if !valid_hash(hash) {
                return error(400, "bad_request", "not an artifact hash");
            }
            match method {
                Method::Get | Method::Head => match artifacts.get(hash) {
                    Ok(Some(a)) => {
                        let mut response = Response::from_data(a.body)
                            .with_status_code(200)
                            .with_header(h("Content-Type", "application/octet-stream"))
                            .with_header(h("x-artifact-duration", &a.duration_ms.to_string()));
                        if let Some(tag) = &a.tag {
                            response = response.with_header(h("x-artifact-tag", tag));
                        }
                        response
                    }
                    Ok(None) => error(404, "not_found", "no such artifact"),
                    Err(e) => {
                        eprintln!("iwci: remote cache: reading {hash}: {e}");
                        error(500, "internal_error", "the artifact could not be read")
                    }
                },
                Method::Put => put(artifacts.as_ref(), hash, request),
                _ => error(405, "method_not_allowed", "not a method of this path"),
            }
        }
        _ => error(404, "not_found", "not a path of the remote cache"),
    }
}

fn put(
    artifacts: &dyn Artifacts,
    hash: &str,
    request: &mut Request,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let too_big = || {
        error(
            413,
            "payload_too_large",
            &format!("artifacts over {} MiB are not kept", MAX_ARTIFACT >> 20),
        )
    };
    if request
        .body_length()
        .is_some_and(|n| n as u64 > MAX_ARTIFACT)
    {
        return too_big();
    }
    let duration_ms = header(request, "x-artifact-duration")
        .and_then(|d| d.trim().parse().ok())
        .unwrap_or(0);
    let tag = header(request, "x-artifact-tag").map(str::to_string);
    if tag.as_deref().is_some_and(|t| !valid_tag(t)) {
        return error(400, "bad_request", "not an artifact tag");
    }
    let mut body = Vec::new();
    if request
        .as_reader()
        .take(MAX_ARTIFACT + 1)
        .read_to_end(&mut body)
        .is_err()
    {
        return error(400, "bad_request", "the artifact did not arrive whole");
    }
    if body.len() as u64 > MAX_ARTIFACT {
        return too_big();
    }
    let artifact = Artifact {
        body,
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
fn query(artifacts: &dyn Artifacts, request: &mut Request) -> Response<std::io::Cursor<Vec<u8>>> {
    #[derive(serde::Deserialize)]
    struct Query {
        hashes: Vec<String>,
    }
    let mut text = Vec::new();
    if request
        .as_reader()
        .take(1 << 20)
        .read_to_end(&mut text)
        .is_err()
    {
        return error(400, "bad_request", "the request did not arrive whole");
    }
    let Ok(asked) = serde_json::from_slice::<Query>(&text) else {
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
}
