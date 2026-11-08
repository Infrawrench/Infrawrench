//! `iwci serve`: the runner as an HTTP service.
//!
//! Every route but `/healthz` needs `Authorization: Bearer <key>`, the key
//! being `IWCI_SERVER_KEY`. The server is meant to sit behind a load
//! balancer with others like it: nothing a client needs later lives only on
//! one runner. Run reports and billing records go to the shared object
//! store, and so do job caches, so any runner can answer for any owner. A
//! runner that is full says so with `429` and `Retry-After`, and the
//! balancer (or the caller) tries another.
//!
//! | Route | Does |
//! |-------|------|
//! | `GET /healthz` | `200 ok`, unauthenticated, for load balancers |
//! | `GET /v1/capacity` | slots, memory and active runs |
//! | `POST /v1/runs[?wait=true]` | runs a [`RunRequest`]; `202` with an id, or the result when waiting |
//! | `GET /v1/runs/{id}[?owner=]` | a run's state and report |
//! | `GET /v1/runs/{id}/logs` | the run's log as Server-Sent Events: everything so far, then live until it ends |
//! | `POST /v1/prepare` | warms the clone, installs and tools for a request, runs nothing |
//! | `GET /v1/storage/{owner}[?quota=]` | the owner's cache storage, per repository |
//! | `GET /v1/usage/{owner}[?month=YYYY-MM]` | the owner's billed usage for a month |

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use iwci_store::RepoId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tiny_http::{Header, Method, Request, Response};

use crate::adapters::caches::storage_usage;
use crate::runner::{PipelineOutput, RunRequest, Runner, Usage, now_secs};
use crate::schedule::Status;

/// Bodies are a request and maybe a pipeline file: small.
const MAX_BODY: usize = 1 << 20;
/// What a full runner tells the caller to wait before trying again.
const RETRY_AFTER_SECS: u64 = 10;
/// Finished runs kept in memory for `GET /v1/runs/{id}`; older ones are
/// read back from the store with `?owner=`.
const KEEP_FINISHED: usize = 1000;

pub struct Server {
    runner: Arc<Runner>,
    key: Vec<u8>,
    runs: Mutex<HashMap<String, RunEntry>>,
    logs: Mutex<HashMap<String, Arc<LogHub>>>,
    order: Mutex<Vec<String>>,
    active: AtomicUsize,
}

#[derive(Debug, Clone, Serialize)]
struct RunEntry {
    id: String,
    owner: String,
    repo: String,
    state: &'static str,
    started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// One run's line in the bill, stored at
/// `usage/<owner>/<yyyy>/<mm>/<started>-<id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRecord {
    pub schema: u32,
    pub run_id: String,
    pub owner: String,
    pub repo_id: String,
    pub repo: String,
    pub commit: Option<String>,
    pub branch: Option<String>,
    pub event: String,
    pub started_at: u64,
    pub finished_at: u64,
    pub passed: bool,
    pub cpus: usize,
    pub jobs_per_cpu: usize,
    pub usage: Usage,
    pub jobs: Vec<JobUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobUsage {
    pub id: String,
    pub status: String,
    pub duration_ms: u64,
    pub memory_mib: u64,
}

/// A random id, from the kernel. The runner already only builds for Unix
/// (the git cache's file locks), so `/dev/urandom` is always there.
fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    }
    hex::encode(bytes)
}

/// Year and month of a Unix time, for the usage key layout.
fn year_month(secs: u64) -> (i64, u32) {
    // Civil date from days (Howard Hinnant's algorithm).
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn json_response(status: u16, body: &serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec_pretty(body).unwrap_or_default();
    Response::from_data(bytes)
        .with_status_code(status)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("valid header"),
        )
}

fn error(status: u16, message: impl Into<String>) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(status, &json!({ "error": message.into() }))
}

impl Server {
    pub fn new(runner: Runner, key: String) -> Result<Self, String> {
        if key.len() < 32 {
            return Err("IWCI_SERVER_KEY must be at least 32 characters".into());
        }
        if runner.slots.is_none() {
            return Err("the server needs shared job slots".into());
        }
        Ok(Self {
            runner: Arc::new(runner),
            key: key.into_bytes(),
            runs: Mutex::default(),
            logs: Mutex::default(),
            order: Mutex::default(),
            active: AtomicUsize::new(0),
        })
    }

    /// Serves until the process ends; one thread per request, because a
    /// `?wait=true` run holds its request for as long as the run takes.
    pub fn serve(self: Arc<Self>, listen: &str) -> Result<(), String> {
        let http = tiny_http::Server::http(listen).map_err(|e| format!("{listen}: {e}"))?;
        eprintln!("iwci serve: listening on {listen}");
        for request in http.incoming_requests() {
            let this = self.clone();
            std::thread::spawn(move || this.handle(request));
        }
        Ok(())
    }

    fn authorised(&self, request: &Request) -> bool {
        request.headers().iter().any(|h| {
            h.field.equiv("Authorization")
                && h.value
                    .as_str()
                    .strip_prefix("Bearer ")
                    .is_some_and(|k| constant_time_eq(k.trim().as_bytes(), &self.key))
        })
    }

    fn handle(self: &Arc<Self>, mut request: Request) {
        let url = request.url().to_string();
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let path = path.trim_end_matches('/').to_string();
        let query: HashMap<String, String> = query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let method = request.method().clone();

        let response = if method == Method::Get && path == "/healthz" {
            Response::from_string("ok").with_status_code(200).boxed()
        } else if !self.authorised(&request) {
            error(401, "missing or wrong bearer key").boxed()
        } else {
            let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            match (&method, segments.as_slice()) {
                (Method::Get, ["v1", "capacity"]) => json_response(200, &self.capacity()).boxed(),
                (Method::Post, ["v1", "runs"]) => match read_request(&mut request) {
                    Ok(req) => self
                        .start_run(req, query.get("wait").is_some_and(|w| w == "true"))
                        .boxed(),
                    Err(e) => error(400, e).boxed(),
                },
                (Method::Get, ["v1", "runs", id]) => {
                    self.run_status(id, query.get("owner")).boxed()
                }
                (Method::Get, ["v1", "runs", id, "logs"]) => {
                    match self.logs.lock().unwrap().get(*id).cloned() {
                        Some(hub) => Response::new(
                            tiny_http::StatusCode(200),
                            vec![
                                Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..])
                                    .expect("valid header"),
                                Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..])
                                    .expect("valid header"),
                            ],
                            Box::new(HubReader {
                                hub,
                                next: 0,
                                buf: Vec::new(),
                                at: 0,
                            }) as Box<dyn Read + Send>,
                            None,
                            None,
                        ),
                        None => error(404, "no live log for that run on this runner").boxed(),
                    }
                }
                (Method::Post, ["v1", "prepare"]) => match read_request(&mut request) {
                    Ok(req) => self.prepare(&req).boxed(),
                    Err(e) => error(400, e).boxed(),
                },
                (Method::Get, ["v1", "storage", owner]) => {
                    self.storage(owner, query.get("quota")).boxed()
                }
                (Method::Get, ["v1", "usage", owner]) => {
                    self.usage(owner, query.get("month")).boxed()
                }
                _ => error(404, format!("no route {method} {path}")).boxed(),
            }
        };
        let _ = request.respond(response);
    }

    fn capacity(&self) -> serde_json::Value {
        let slots = self.runner.slots.as_ref().expect("checked in new");
        json!({
            "cpus": self.runner.cpus,
            "jobs_per_cpu": self.runner.jobs_per_cpu,
            "slots_total": slots.total(),
            "slots_free": slots.free(),
            "runs_active": self.active.load(Ordering::SeqCst),
            "memory_total": self.runner.memory.as_ref().map(|m| m.total()),
            "memory_used": self.runner.memory.as_ref().map(|m| m.used()),
        })
    }

    fn full(&self) -> Response<std::io::Cursor<Vec<u8>>> {
        let mut body = self.capacity();
        body["error"] = json!("this runner is at capacity; retry later or on another runner");
        json_response(429, &body).with_header(
            Header::from_bytes(&b"Retry-After"[..], RETRY_AFTER_SECS.to_string().as_bytes())
                .expect("valid header"),
        )
    }

    /// Admits a run when a slot is free and fewer runs are active than
    /// there are slots (each run needs at least one).
    fn admit(&self) -> bool {
        let slots = self.runner.slots.as_ref().expect("checked in new");
        if slots.free() == 0 {
            return false;
        }
        self.active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < slots.total()).then_some(n + 1)
            })
            .is_ok()
    }

    fn start_run(
        self: &Arc<Self>,
        req: RunRequest,
        wait: bool,
    ) -> Response<std::io::Cursor<Vec<u8>>> {
        let owner = match req.owner() {
            Ok(o) => o,
            Err(e) => return error(400, e),
        };
        if let Err(e) = req.repo_id() {
            return error(400, e);
        }
        if !self.admit() {
            return self.full();
        }
        let id = random_id();
        let entry = RunEntry {
            id: id.clone(),
            owner: owner.as_str().to_string(),
            repo: req.repo.clone(),
            state: "running",
            started_at: now_secs(),
            finished_at: None,
            result: None,
            error: None,
        };
        self.remember(entry.clone());
        let hub = Arc::new(LogHub::default());
        self.logs.lock().unwrap().insert(id.clone(), hub.clone());

        // The run itself, on its own thread, so a `202` returns at once.
        let runner = self.runner.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let id_for_thread = id.clone();
        let this = self.clone();
        std::thread::spawn(move || {
            let sink = hub.clone();
            let logs: crate::schedule::LogFn = Arc::new(move |event| sink.push(&event));
            let outcome = runner.run_with_logs(&req, Some(logs));
            let entry = this.finish(&id_for_thread, &req, &owner, outcome);
            hub.close(&entry);
            this.active.fetch_sub(1, Ordering::SeqCst);
            let _ = done_tx.send(entry);
        });
        if wait {
            return match done_rx.recv() {
                Ok(entry) => json_response(200, &serde_json::to_value(entry).unwrap_or_default()),
                Err(_) => error(500, "the run ended without a result"),
            };
        }
        json_response(
            202,
            &json!({ "id": id, "state": "running", "url": format!("/v1/runs/{id}") }),
        )
    }

    /// Records a finished run: in memory, as a report in the store, and as
    /// a billing record.
    fn finish(
        &self,
        id: &str,
        req: &RunRequest,
        owner: &RepoId,
        outcome: Result<crate::runner::RunOutput, String>,
    ) -> RunEntry {
        let finished_at = now_secs();
        let started_at = self
            .runs
            .lock()
            .unwrap()
            .get(id)
            .map_or(finished_at, |e| e.started_at);
        let (result, error, record) = match outcome {
            Ok(output) => {
                let mut jobs = Vec::new();
                for p in &output.pipelines {
                    if let PipelineOutput::Ran { report, .. } = p {
                        for j in &report.jobs {
                            jobs.push(JobUsage {
                                id: j.id.clone(),
                                status: match &j.status {
                                    Status::Passed => "passed",
                                    Status::Failed { .. } => "failed",
                                    Status::Skipped { .. } => "skipped",
                                    Status::Error { .. } => "error",
                                }
                                .to_string(),
                                duration_ms: if j.execution.is_some() {
                                    j.duration_ms
                                } else {
                                    0
                                },
                                memory_mib: j.memory_mib,
                            });
                        }
                    }
                }
                let record = UsageRecord {
                    schema: 1,
                    run_id: id.to_string(),
                    owner: owner.as_str().to_string(),
                    repo_id: output.repo_id.clone(),
                    repo: req.repo.clone(),
                    commit: Some(output.commit.clone()),
                    branch: Some(output.branch.clone()),
                    event: req.event.clone().unwrap_or_else(|| "push".into()),
                    started_at,
                    finished_at,
                    passed: output.passed,
                    cpus: self.runner.cpus,
                    jobs_per_cpu: self.runner.jobs_per_cpu,
                    usage: output.usage.clone(),
                    jobs,
                };
                (serde_json::to_value(&output).ok(), None, record)
            }
            Err(e) => {
                let record = UsageRecord {
                    schema: 1,
                    run_id: id.to_string(),
                    owner: owner.as_str().to_string(),
                    repo_id: req
                        .repo_id()
                        .map(|r| r.as_str().to_string())
                        .unwrap_or_default(),
                    repo: req.repo.clone(),
                    commit: req.sha.clone(),
                    branch: req.branch.clone(),
                    event: req.event.clone().unwrap_or_else(|| "push".into()),
                    started_at,
                    finished_at,
                    passed: false,
                    cpus: self.runner.cpus,
                    jobs_per_cpu: self.runner.jobs_per_cpu,
                    usage: Usage::default(),
                    jobs: Vec::new(),
                };
                (None, Some(e), record)
            }
        };
        let (year, month) = year_month(started_at);
        let store = &self.runner.store;
        let usage_key = format!(
            "usage/{}/{year:04}/{month:02}/{started_at}-{id}.json",
            owner.as_str()
        );
        let mut problems = Vec::new();
        if let Err(e) = store.put(
            &usage_key,
            &serde_json::to_vec(&record).unwrap_or_default(),
            "application/json",
        ) {
            problems.push(format!("could not store the usage record: {e}"));
        }
        let entry = RunEntry {
            id: id.to_string(),
            owner: owner.as_str().to_string(),
            repo: req.repo.clone(),
            state: if error.is_some() { "error" } else { "finished" },
            started_at,
            finished_at: Some(finished_at),
            result,
            error: match (error, problems.is_empty()) {
                (Some(e), _) => Some(e),
                (None, false) => Some(problems.join("; ")),
                (None, true) => None,
            },
        };
        let report_key = format!("runs/{}/{id}.json", owner.as_str());
        let _ = store.put(
            &report_key,
            &serde_json::to_vec(&entry).unwrap_or_default(),
            "application/json",
        );
        self.remember(entry.clone());
        entry
    }

    fn remember(&self, entry: RunEntry) {
        let id = entry.id.clone();
        self.runs.lock().unwrap().insert(id.clone(), entry);
        let mut order = self.order.lock().unwrap();
        order.retain(|i| *i != id);
        order.push(id);
        while order.len() > KEEP_FINISHED {
            let oldest = order.remove(0);
            let mut runs = self.runs.lock().unwrap();
            if runs.get(&oldest).is_some_and(|e| e.state != "running") {
                runs.remove(&oldest);
                self.logs.lock().unwrap().remove(&oldest);
            } else {
                order.push(oldest);
                break;
            }
        }
    }

    fn run_status(&self, id: &str, owner: Option<&String>) -> Response<std::io::Cursor<Vec<u8>>> {
        if let Some(entry) = self.runs.lock().unwrap().get(id) {
            return json_response(200, &serde_json::to_value(entry).unwrap_or_default());
        }
        // Not on this runner, or long finished: the store has every
        // report, under its owner.
        let (Some(owner), true) = (
            owner,
            id.chars().all(|c| c.is_ascii_hexdigit()) && id.len() == 32,
        ) else {
            return error(404, "no such run here; pass ?owner= to look in the store");
        };
        let Ok(owner) = RepoId::new(owner) else {
            return error(400, "bad owner");
        };
        match self
            .runner
            .store
            .get(&format!("runs/{}/{id}.json", owner.as_str()))
        {
            Ok(Some(bytes)) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(v) => json_response(200, &v),
                Err(_) => error(500, "the stored report is damaged"),
            },
            Ok(None) => error(404, "no such run"),
            Err(e) => error(502, format!("store: {e}")),
        }
    }

    fn prepare(&self, req: &RunRequest) -> Response<std::io::Cursor<Vec<u8>>> {
        let slots = self.runner.slots.as_ref().expect("checked in new");
        // Preparing uses a slot like a job does: it unpacks and compiles.
        let Some(_slot) = slots.try_acquire() else {
            return self.full();
        };
        match self.runner.prepare(req) {
            Ok(out) => json_response(200, &serde_json::to_value(out).unwrap_or_default()),
            Err(e) => error(422, e),
        }
    }

    fn storage(&self, owner: &str, quota: Option<&String>) -> Response<std::io::Cursor<Vec<u8>>> {
        let Ok(owner) = RepoId::new(owner) else {
            return error(400, "bad owner");
        };
        let quota = match quota {
            Some(q) => match crate::runner::parse_quota(q) {
                Some(q) => Some(q),
                None => return error(400, "quota is bytes or a size such as 10GiB"),
            },
            None => self.runner.default_storage_quota,
        };
        match storage_usage(self.runner.store.as_ref(), &owner, quota) {
            Ok(usage) => json_response(200, &serde_json::to_value(usage).unwrap_or_default()),
            Err(e) => error(502, format!("store: {e}")),
        }
    }

    fn usage(&self, owner: &str, month: Option<&String>) -> Response<std::io::Cursor<Vec<u8>>> {
        let Ok(owner) = RepoId::new(owner) else {
            return error(400, "bad owner");
        };
        let (year, month) = match month {
            Some(m) => match m
                .split_once('-')
                .and_then(|(y, mo)| Some((y.parse::<i64>().ok()?, mo.parse::<u32>().ok()?)))
            {
                Some((y, mo)) if (1..=12).contains(&mo) => (y, mo),
                _ => return error(400, "month is YYYY-MM"),
            },
            None => year_month(now_secs()),
        };
        let prefix = format!("usage/{}/{year:04}/{month:02}/", owner.as_str());
        let keys = match self.runner.store.list(&prefix) {
            Ok(keys) => keys,
            Err(e) => return error(502, format!("store: {e}")),
        };
        let mut total = Usage::default();
        let mut repos: BTreeMap<String, Usage> = BTreeMap::new();
        let mut runs = 0u64;
        for key in keys {
            let Ok(Some(bytes)) = self.runner.store.get(&key) else {
                continue;
            };
            let Ok(record) = serde_json::from_slice::<UsageRecord>(&bytes) else {
                continue;
            };
            runs += 1;
            total.add(&record.usage);
            repos
                .entry(record.repo_id.clone())
                .or_default()
                .add(&record.usage);
        }
        json_response(
            200,
            &json!({
                "owner": owner.as_str(),
                "month": format!("{year:04}-{month:02}"),
                "runs": runs,
                "usage": total,
                "repos": repos,
            }),
        )
    }
}

/// The most log a run keeps for followers; past it, output events are
/// dropped (one `truncated` event says so) and job events still flow.
const MAX_LOG_BYTES: usize = 8 << 20;

/// One run's log, as SSE frames: kept for whoever connects later, and
/// handed to whoever is connected now.
#[derive(Default)]
struct LogHub {
    state: Mutex<HubState>,
    changed: std::sync::Condvar,
}

#[derive(Default)]
struct HubState {
    frames: Vec<Vec<u8>>,
    bytes: usize,
    truncated: bool,
    done: bool,
}

fn frame(event: &str, data: &serde_json::Value) -> Vec<u8> {
    format!("event: {event}\ndata: {data}\n\n").into_bytes()
}

impl LogHub {
    fn push(&self, event: &crate::schedule::LogEvent) {
        let value = serde_json::to_value(event).unwrap_or_default();
        let name = value
            .get("event")
            .and_then(|e| e.as_str())
            .unwrap_or("log")
            .to_string();
        let bytes = frame(&name, &value);
        let mut state = self.state.lock().unwrap();
        let is_output = matches!(event, crate::schedule::LogEvent::Output { .. });
        if is_output && state.bytes + bytes.len() > MAX_LOG_BYTES {
            if !state.truncated {
                state.truncated = true;
                let note = frame("truncated", &json!({ "after_bytes": state.bytes }));
                state.frames.push(note);
            }
        } else {
            state.bytes += bytes.len();
            state.frames.push(bytes);
        }
        self.changed.notify_all();
    }

    fn close(&self, entry: &RunEntry) {
        let passed = entry
            .result
            .as_ref()
            .and_then(|r| r.get("passed"))
            .and_then(|p| p.as_bool());
        let mut state = self.state.lock().unwrap();
        let end = frame(
            "run-finished",
            &json!({ "id": entry.id, "state": entry.state, "passed": passed, "error": entry.error }),
        );
        state.frames.push(end);
        state.done = true;
        self.changed.notify_all();
    }
}

/// Streams a hub's frames: the backlog first, then each new one as it
/// arrives, ending with the run. A reader that is waiting wakes at least
/// every 15 s to send an SSE comment, so proxies keep the stream open.
struct HubReader {
    hub: Arc<LogHub>,
    next: usize,
    buf: Vec<u8>,
    at: usize,
}

impl Read for HubReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.at >= self.buf.len() {
            let mut state = self.hub.state.lock().unwrap();
            if self.next < state.frames.len() {
                self.buf = state.frames[self.next..].concat();
                self.next = state.frames.len();
                self.at = 0;
                break;
            }
            if state.done {
                return Ok(0);
            }
            let (s, timeout) = self
                .hub
                .changed
                .wait_timeout(state, std::time::Duration::from_secs(15))
                .unwrap();
            state = s;
            if timeout.timed_out() && self.next >= state.frames.len() && !state.done {
                self.buf = b": keep-alive\n\n".to_vec();
                self.at = 0;
                break;
            }
        }
        let n = out.len().min(self.buf.len() - self.at);
        out[..n].copy_from_slice(&self.buf[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

fn read_request(request: &mut Request) -> Result<RunRequest, String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    if body.len() > MAX_BODY {
        return Err(format!("the body is over {MAX_BODY} bytes"));
    }
    let req: RunRequest = serde_json::from_slice(&body).map_err(|e| format!("body: {e}"))?;
    if req.sha.is_none() && req.branch.is_none() {
        return Err("give `sha`, `branch`, or both".into());
    }
    Ok(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn year_and_month_of_unix_times() {
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(1_793_491_200), (2026, 11));
        assert_eq!(year_month(1_709_164_800), (2024, 2)); // 2024-02-29
        assert_eq!(year_month(951_782_400), (2000, 2)); // 2000-02-29
    }

    #[test]
    fn keys_compare_in_constant_time_and_exactly() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
