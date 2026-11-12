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
//! | `GET /v1/capacity` | slots, memory (reserved by jobs, and the process's own), active runs, and what V8 out-of-memory has cost the process |
//! | `POST /v1/runs[?wait=true]` | runs a [`RunRequest`]; `202` with an id, or the result when waiting |
//! | `GET /v1/runs/{id}[?owner=]` | a run's state and report |
//! | `GET /v1/runs/{id}/logs` | the run's log as Server-Sent Events: everything so far, then live until it ends |
//! | `POST /v1/runs/{id}/cancel` | cancels a run on this runner, or some of its pipelines (`{ "pipelines": [file, ...] }`) |
//! | `POST /v1/concurrency` | the pipelines a request would run and each one's concurrency group, runs nothing |
//! | `POST /v1/prepare` | warms the clone, installs and tools for a request, runs nothing |
//! | `GET /v1/storage/{owner}[?quota=]` | the owner's storage (caches and downloads), per repository |
//! | `DELETE /v1/storage/{owner}/{repo-id}` | deletes one repository's caches (never its downloads), and says what went |
//! | `GET /v1/usage/{owner}[?month=YYYY-MM]` | the owner's billed usage for a month |
//! | `POST /v1/schedules/read` | a branch's `on.schedule` pipelines, with their crons and text, for the proxy that fires them |

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use iwci_store::RepoId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tiny_http::{Header, Method, Request, Response};

use crate::adapters::caches::{clear_repository, storage_usage};

#[path = "server_concurrency.rs"]
mod concurrency;
#[path = "server_lifecycle.rs"]
pub(crate) mod lifecycle;
#[path = "server_schedules.rs"]
mod schedules;

type Reply = Response<std::io::Cursor<Vec<u8>>>;
use crate::runner::{PipelineOutput, RunControl, RunRequest, Runner, Usage, now_secs};

/// Bodies are a request and maybe a pipeline file: small.
const MAX_BODY: usize = 1 << 20;
/// What a full runner tells the caller to wait before trying again.
const RETRY_AFTER_SECS: u64 = 10;
/// Finished runs kept in memory for `GET /v1/runs/{id}`; older ones are
/// read back from the store with `?owner=`.
const KEEP_FINISHED: usize = 1000;
/// How long a finished run keeps its report and log in memory. Past it the
/// report is read back from the store (the run's own owner names it), and
/// the log is gone, as it is on any other runner. A full Test pipeline's
/// report and log are about 20 MiB, which the last thousand runs held for
/// good (#1066).
const KEEP_REPORT_SECS: u64 = 5 * 60;
/// The current [`UsageRecord::schema`].
pub const USAGE_SCHEMA: u32 = 2;

pub struct Server {
    runner: Arc<Runner>,
    /// The last [`Runner::warm_published`], and when it finished.
    warm: Mutex<Option<(u64, crate::runner::WarmOutput)>>,
    /// Set when the server is going away (an update, SIGTERM, `POST
    /// /v1/drain`): no new runs, and the running ones finish.
    draining: std::sync::atomic::AtomicBool,
    /// Why it is draining, for `/v1/capacity`.
    drain_reason: Mutex<Option<String>>,
    /// Set when it drains to restart itself (`watch_v8_losses`), so a
    /// failed update does not take it out of draining.
    restarting: std::sync::atomic::AtomicBool,
    key: Vec<u8>,
    runs: Mutex<HashMap<String, RunEntry>>,
    logs: Mutex<HashMap<String, Arc<LogHub>>>,
    /// What cancels each run while it runs, by id.
    controls: Mutex<HashMap<String, Arc<RunControl>>>,
    order: Mutex<Vec<String>>,
    active: AtomicUsize,
    /// The host's memory and what the runner keeps of it outside the job
    /// budget, for `/v1/capacity` and the memory log (`crate::memory`).
    memory_host: Option<u64>,
    memory_reserve: Option<u64>,
}

/// How often the server checks its own memory, and how often it logs it
/// when nothing is wrong.
const MEMORY_CHECK_SECS: u64 = 30;
const MEMORY_LOG_EVERY: u32 = 20;

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
    /// Its report is in the store, under `runs/<owner>/<id>.json`.
    #[serde(skip)]
    stored: bool,
    /// Its report was let go of ([`KEEP_REPORT_SECS`]): read the store's.
    #[serde(skip)]
    forgotten: bool,
}

/// Lets go of the report and log of every run that finished at least
/// [`KEEP_REPORT_SECS`] before `now`. A report that could not be stored
/// stays, since nothing else has it.
fn forget_finished(
    runs: &mut HashMap<String, RunEntry>,
    logs: &mut HashMap<String, Arc<LogHub>>,
    now: u64,
) {
    for (id, entry) in runs.iter_mut() {
        let Some(finished_at) = entry.finished_at else {
            continue;
        };
        if now < finished_at.saturating_add(KEEP_REPORT_SECS) {
            continue;
        }
        logs.remove(id);
        if entry.stored && entry.result.take().is_some() {
            entry.forgotten = true;
        }
    }
}

/// One run's line in the bill, stored at
/// `usage/<owner>/<yyyy>/<mm>/<started>-<id>.json`. `schema` 2: a job's
/// `status` may be `cancelled`.
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

use crate::runner::random_id;

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
            warm: Mutex::default(),
            draining: std::sync::atomic::AtomicBool::new(false),
            drain_reason: Mutex::default(),
            restarting: std::sync::atomic::AtomicBool::new(false),
            key: key.into_bytes(),
            runs: Mutex::default(),
            logs: Mutex::default(),
            controls: Mutex::default(),
            order: Mutex::default(),
            active: AtomicUsize::new(0),
            memory_host: None,
            memory_reserve: None,
        })
    }

    /// Says what the host has and what the runner keeps of it, for
    /// `/v1/capacity` and [`Server::watch_memory`].
    pub fn with_memory(mut self, host: Option<u64>, reserve: u64) -> Self {
        self.memory_host = host;
        self.memory_reserve = Some(reserve);
        self
    }

    /// The process's memory against the job budget, as one log line.
    fn memory_line(&self) -> Option<(String, bool)> {
        let me = crate::memory::process_memory()?;
        let reserved = self.runner.memory.as_ref().map_or(0, |m| m.used());
        let modules = self.runner.runtime.cache_stats().resident_bytes;
        // Jobs rarely use all they reserve, so this is the least the
        // runner itself holds.
        let own = me.anonymous.saturating_sub(reserved);
        let over = self.memory_reserve.is_some_and(|r| own > r);
        let heap = iwci_runtime::v8_heap_space();
        let line = format!(
            "iwci serve: memory: {} MiB resident ({} MiB anonymous), jobs reserve {} of {} MiB, V8 heaps {} of {} MiB, compiled modules {} MiB, host {} MiB, runner reserve {} MiB{}",
            me.resident >> 20,
            me.anonymous >> 20,
            reserved >> 20,
            self.runner.memory.as_ref().map_or(0, |m| m.total()) >> 20,
            heap.used >> 20,
            heap.total >> 20,
            modules >> 20,
            self.memory_host.unwrap_or(0) >> 20,
            self.memory_reserve.unwrap_or(0) >> 20,
            if over {
                "; the runner's own memory is over its reserve"
            } else {
                ""
            }
        );
        Some((line, over))
    }

    /// Every half minute, lets go of what no job uses (parsed packages,
    /// an old generation of compiled modules, finished runs' reports and
    /// logs, the allocator's free memory),
    /// then logs the process's memory against the job budget every ten
    /// minutes, and at once (at most once a minute) when the anonymous
    /// memory beyond what jobs have reserved passes `--memory-reserve`, so
    /// it is visible before the kernel acts (#1035).
    pub fn watch_memory(self: &Arc<Self>) {
        let server = self.clone();
        std::thread::Builder::new()
            .name("iwci-memory".into())
            .spawn(move || {
                let mut quiet = 0u32;
                let mut was_over = false;
                loop {
                    server.forget_finished();
                    server.runner.runtime.release_idle();
                    crate::memory::return_free_memory();
                    if let Some((line, over)) = server.memory_line() {
                        if quiet == 0 || (over && !was_over) {
                            eprintln!("{line}");
                            quiet = if over { 2 } else { MEMORY_LOG_EVERY };
                        }
                        was_over = over;
                    }
                    quiet = quiet.saturating_sub(1);
                    std::thread::sleep(std::time::Duration::from_secs(MEMORY_CHECK_SECS));
                }
            })
            .expect("spawning the memory thread");
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
                (Method::Post, ["v1", "runs", id, "cancel"]) => match read_cancel(&mut request) {
                    Ok(files) => self.cancel_run(id, files.as_deref()).boxed(),
                    Err(e) => error(400, e).boxed(),
                },
                (Method::Post, ["v1", "concurrency"]) => match read_request(&mut request) {
                    Ok(req) => self.concurrency(&req).boxed(),
                    Err(e) => error(400, e).boxed(),
                },
                (Method::Post, ["v1", "drain"]) => {
                    self.begin_drain("asked to by POST /v1/drain");
                    json_response(202, &self.capacity()).boxed()
                }
                (Method::Post, ["v1", "prepare"]) => match read_request(&mut request) {
                    Ok(req) => self.prepare(&req).boxed(),
                    Err(e) => error(400, e).boxed(),
                },
                (Method::Get, ["v1", "storage", owner]) => {
                    self.storage(owner, query.get("quota")).boxed()
                }
                (Method::Delete, ["v1", "storage", owner, repo]) => {
                    self.clear_storage(owner, repo).boxed()
                }
                (Method::Get, ["v1", "usage", owner]) => {
                    self.usage(owner, query.get("month")).boxed()
                }
                (Method::Post, ["v1", "schedules", "read"]) => match read_request_any(&mut request)
                {
                    Ok(req) => self.read_schedules(req).boxed(),
                    Err(e) => error(400, e).boxed(),
                },
                _ => error(404, format!("no route {method} {path}")).boxed(),
            }
        };
        let _ = request.respond(response);
    }

    fn capacity(&self) -> serde_json::Value {
        let slots = self.runner.slots.as_ref().expect("checked in new");
        let v8 = iwci_runtime::v8_losses();
        let heap = iwci_runtime::v8_heap_space();
        let process = crate::memory::process_memory();
        json!({
            "version": lifecycle::VERSION,
            "draining": self.draining.load(Ordering::SeqCst),
            "drain_reason": self.drain_reason.lock().unwrap().clone(),
            "cpus": self.runner.cpus,
            "jobs_per_cpu": self.runner.jobs_per_cpu,
            "slots_total": slots.total(),
            "slots_free": slots.free(),
            "runs_active": self.active.load(Ordering::SeqCst),
            "memory_total": self.runner.memory.as_ref().map(|m| m.total()),
            "memory_used": self.runner.memory.as_ref().map(|m| m.used()),
            // The process's own memory against that (#1035).
            "memory_host": self.memory_host,
            "memory_reserve": self.memory_reserve,
            "memory_resident": process.map(|p| p.resident),
            "memory_anonymous": process.map(|p| p.anonymous),
            "modules_resident": self.runner.runtime.cache_stats().resident_bytes,
            // What V8 out-of-memory has cost this process (#990).
            "v8_lost_isolates": v8.lost_isolates,
            "v8_parked_threads": v8.parked_threads,
            "v8_parked_worker_threads": v8.parked_worker_threads,
            "v8_lost_heap": v8.lost_heap,
            // The V8 heap space every Node job shares (#1063).
            "v8_heap_space_total": heap.total,
            "v8_heap_space_used": heap.used,
            "v8_heap_space_waits": heap.waits,
            "v8_heap_space_refusals": heap.refusals,
            "warm": self.warm.lock().unwrap().as_ref().map(|(at, w)| json!({
                "finished_at": at,
                "tools": w.warmed.len(),
                "problems": w.problems,
            })),
        })
    }

    /// Keeps every published builtin and environment downloaded and
    /// compiled: once now, then every `every`, in the background. Warming
    /// takes no job slot; it competes for the CPU like any other work, which
    /// is why it runs once per interval rather than continuously.
    pub fn keep_warm(self: &Arc<Self>, every: std::time::Duration) {
        let server = self.clone();
        std::thread::Builder::new()
            .name("iwci-warm".into())
            .spawn(move || {
                loop {
                    let started = std::time::Instant::now();
                    let out = server.runner.warm_published();
                    eprintln!(
                        "iwci serve: warmed {} builtins and environments in {:.1}s{}",
                        out.warmed.len(),
                        started.elapsed().as_secs_f64(),
                        if out.problems.is_empty() {
                            String::new()
                        } else {
                            format!("; problems: {}", out.problems.join("; "))
                        }
                    );
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_secs());
                    *server.warm.lock().unwrap() = Some((now, out));
                    std::thread::sleep(every);
                }
            })
            .expect("spawning the warming thread");
    }

    /// Packs cached installs that have gone unused for the runner's
    /// `--keep-installs-unpacked`: once now, then every `every`, in the
    /// background. Packing takes no job slot.
    pub fn keep_installs_compact(self: &Arc<Self>, every: std::time::Duration) {
        let server = self.clone();
        std::thread::Builder::new()
            .name("iwci-compact".into())
            .spawn(move || {
                loop {
                    let started = std::time::Instant::now();
                    let out = server.runner.layers.compact();
                    if out.packed > 0 || !out.problems.is_empty() {
                        eprintln!(
                            "iwci serve: packed {} unused installs in {:.1}s, freeing {} MiB{}",
                            out.packed,
                            started.elapsed().as_secs_f64(),
                            out.freed >> 20,
                            if out.problems.is_empty() {
                                String::new()
                            } else {
                                format!("; problems: {}", out.problems.join("; "))
                            }
                        );
                    }
                    std::thread::sleep(every);
                }
            })
            .expect("spawning the compacting thread");
    }

    fn full(&self) -> Response<std::io::Cursor<Vec<u8>>> {
        let mut body = self.capacity();
        body["error"] = if self.draining.load(Ordering::SeqCst) {
            json!("this runner is draining before an update or a stop; use another runner")
        } else {
            json!("this runner is at capacity; retry later or on another runner")
        };
        json_response(429, &body).with_header(
            Header::from_bytes(&b"Retry-After"[..], RETRY_AFTER_SECS.to_string().as_bytes())
                .expect("valid header"),
        )
    }

    /// Admits a run when a slot is free and fewer runs are active than
    /// there are slots (each run needs at least one).
    fn admit(&self) -> bool {
        let slots = self.runner.slots.as_ref().expect("checked in new");
        if slots.free() == 0 || self.draining.load(Ordering::SeqCst) {
            return false;
        }
        let admitted = self
            .active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < slots.total()).then_some(n + 1)
            })
            .is_ok();
        // A drain that started between the check and the increment must not
        // let this run in: the drain may already be waiting for zero.
        if admitted && self.draining.load(Ordering::SeqCst) {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        admitted
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
        let (id, done) = self.launch(req, owner);
        if wait {
            return match done.recv() {
                Ok(entry) => json_response(200, &serde_json::to_value(entry).unwrap_or_default()),
                Err(_) => error(500, "the run ended without a result"),
            };
        }
        json_response(
            202,
            &json!({ "id": id, "state": "running", "url": format!("/v1/runs/{id}") }),
        )
    }

    /// Starts an admitted run on its own thread and returns its id, and a
    /// channel that gets its entry when it ends. The admission is released
    /// when the run finishes.
    fn launch(
        self: &Arc<Self>,
        req: RunRequest,
        owner: RepoId,
    ) -> (String, std::sync::mpsc::Receiver<RunEntry>) {
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
            stored: false,
            forgotten: false,
        };
        self.remember(entry);
        let hub = Arc::new(LogHub::default());
        self.logs.lock().unwrap().insert(id.clone(), hub.clone());
        let control = Arc::new(RunControl::default());
        self.controls
            .lock()
            .unwrap()
            .insert(id.clone(), control.clone());
        let runner = self.runner.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let id_for_thread = id.clone();
        let this = self.clone();
        std::thread::spawn(move || {
            let sink = hub.clone();
            let logs: crate::schedule::LogFn = Arc::new(move |event| sink.push(&event));
            let outcome = runner.run_with_logs(&req, &id_for_thread, Some(logs), Some(control));
            let entry = this.finish(&id_for_thread, &req, &owner, outcome);
            // Finished and remembered: a cancel from now on answers that.
            this.controls.lock().unwrap().remove(&id_for_thread);
            hub.close(&entry);
            this.active.fetch_sub(1, Ordering::SeqCst);
            let _ = done_tx.send(entry);
        });
        (id, done_rx)
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
                                status: crate::schedule::status_name(&j.status).to_string(),
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
                    schema: USAGE_SCHEMA,
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
                    schema: USAGE_SCHEMA,
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
        let mut entry = RunEntry {
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
            stored: false,
            forgotten: false,
        };
        let report_key = format!("runs/{}/{id}.json", owner.as_str());
        entry.stored = store
            .put(
                &report_key,
                &serde_json::to_vec(&entry).unwrap_or_default(),
                "application/json",
            )
            .is_ok();
        self.remember(entry.clone());
        entry
    }

    /// See [`forget_finished`].
    fn forget_finished(&self) {
        let mut runs = self.runs.lock().unwrap();
        let mut logs = self.logs.lock().unwrap();
        forget_finished(&mut runs, &mut logs, now_secs());
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
        let mut forgotten_owner = None;
        if let Some(entry) = self.runs.lock().unwrap().get(id) {
            if entry.forgotten {
                forgotten_owner = Some(entry.owner.clone());
            } else {
                return self.entry_status(id, entry);
            }
        }
        // Not on this runner, or long finished: the store has every
        // report, under its owner.
        let (Some(owner), true) = (
            forgotten_owner.as_ref().or(owner),
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

    /// A run this runner still has in memory.
    fn entry_status(&self, id: &str, entry: &RunEntry) -> Response<std::io::Cursor<Vec<u8>>> {
        let mut value = serde_json::to_value(entry).unwrap_or_default();
        // A running run's jobs so far; a finished one has its report.
        if entry.state == "running"
            && let Some(hub) = self.logs.lock().unwrap().get(id)
            && let Some(map) = value.as_object_mut()
        {
            let progress = hub.state.lock().unwrap().progress.clone();
            map.insert(
                "progress".into(),
                serde_json::to_value(progress).unwrap_or_default(),
            );
        }
        json_response(200, &value)
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

    fn clear_storage(&self, owner: &str, repo: &str) -> Response<std::io::Cursor<Vec<u8>>> {
        let (Ok(owner), Ok(repo)) = (RepoId::new(owner), RepoId::new(repo)) else {
            return error(400, "bad owner or repository id");
        };
        match clear_repository(self.runner.store.as_ref(), &owner, &repo) {
            Ok(cleared) => json_response(200, &serde_json::to_value(cleared).unwrap_or_default()),
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
    progress: Progress,
}

/// Where a running run is, from its log events: each pipeline's plan and
/// every job's state so far. `GET /v1/runs/{id}` answers it while the run
/// is going, so a client that polls (the app's GitHub checks) follows the
/// jobs without holding the log open.
#[derive(Debug, Default, Clone, Serialize)]
struct Progress {
    pipelines: Vec<PipelineProgress>,
}

#[derive(Debug, Clone, Serialize)]
struct PipelineProgress {
    name: String,
    jobs: Vec<crate::schedule::PlannedNode>,
    /// By job id: `running`, or how it finished.
    states: std::collections::BTreeMap<String, JobProgress>,
}

#[derive(Debug, Clone, Serialize)]
struct JobProgress {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cached: bool,
}

impl Progress {
    fn apply(&mut self, event: &crate::schedule::LogEvent) {
        use crate::schedule::LogEvent;
        match event {
            LogEvent::PipelineStarted { pipeline, jobs } => self.pipelines.push(PipelineProgress {
                name: pipeline.clone(),
                jobs: jobs.clone(),
                states: Default::default(),
            }),
            LogEvent::JobStarted { job, .. } => {
                if let Some(p) = self.pipelines.last_mut() {
                    p.states.insert(
                        job.clone(),
                        JobProgress {
                            status: "running".into(),
                            duration_ms: None,
                            cached: false,
                        },
                    );
                }
            }
            LogEvent::JobFinished {
                job,
                status,
                duration_ms,
                cached,
            } => {
                if let Some(p) = self.pipelines.last_mut() {
                    p.states.insert(
                        job.clone(),
                        JobProgress {
                            status: status.clone(),
                            duration_ms: Some(*duration_ms),
                            cached: *cached,
                        },
                    );
                }
            }
            LogEvent::Output { .. } => {}
        }
    }
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
        state.progress.apply(event);
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
        let cancelled = entry
            .result
            .as_ref()
            .and_then(|r| r.get("cancelled"))
            .and_then(|c| c.as_bool())
            .unwrap_or(false);
        let mut state = self.state.lock().unwrap();
        let end = frame(
            "run-finished",
            &json!({
                "id": entry.id,
                "state": entry.state,
                "passed": passed,
                "cancelled": cancelled,
                "error": entry.error,
            }),
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

/// A cancel's body: nothing or `{}` for the whole run, or the pipeline
/// files to cancel.
fn read_cancel(request: &mut Request) -> Result<Option<Vec<String>>, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Body {
        #[serde(default)]
        pipelines: Option<Vec<String>>,
    }
    let mut body = Vec::new();
    request
        .as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    if body.len() > MAX_BODY {
        return Err(format!("the body is over {MAX_BODY} bytes"));
    }
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let body: Body = serde_json::from_slice(&body).map_err(|e| format!("body: {e}"))?;
    Ok(body.pipelines)
}

fn read_request(request: &mut Request) -> Result<RunRequest, String> {
    let req = read_request_any(request)?;
    if req.sha.is_none() && req.branch.is_none() {
        return Err("give `sha`, `branch`, or both".into());
    }
    Ok(req)
}

/// A request body, without requiring a commit or branch.
fn read_request_any(request: &mut Request) -> Result<RunRequest, String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    if body.len() > MAX_BODY {
        return Err(format!("the body is over {MAX_BODY} bytes"));
    }
    serde_json::from_slice(&body).map_err(|e| format!("body: {e}"))
}

#[cfg(test)]
mod tests {

    #[test]
    fn progress_follows_each_pipeline_and_its_jobs() {
        use crate::schedule::{LogEvent, PlannedNode};
        let mut p = Progress::default();
        let plan = |name: &str| LogEvent::PipelineStarted {
            pipeline: name.into(),
            jobs: vec![PlannedNode {
                key: "a".into(),
                name: "a".into(),
                needs: vec![],
                ids: Some(vec!["a".into()]),
            }],
        };
        p.apply(&plan("Test"));
        p.apply(&LogEvent::JobStarted {
            job: "a".into(),
            name: "a".into(),
        });
        p.apply(&LogEvent::Output {
            job: "a".into(),
            stream: "stdout",
            line: "hi".into(),
        });
        let running = serde_json::to_value(&p).unwrap();
        assert_eq!(running["pipelines"][0]["states"]["a"]["status"], "running");
        p.apply(&LogEvent::JobFinished {
            job: "a".into(),
            status: "passed".into(),
            duration_ms: 12,
            cached: true,
        });
        p.apply(&plan("Lint"));
        let value = serde_json::to_value(&p).unwrap();
        assert_eq!(
            value["pipelines"][0]["states"]["a"],
            serde_json::json!({ "status": "passed", "duration_ms": 12, "cached": true })
        );
        assert_eq!(value["pipelines"][1]["name"], "Lint");
        assert!(
            value["pipelines"][1]["states"]
                .as_object()
                .unwrap()
                .is_empty()
        );
    }
    use super::*;

    #[test]
    fn year_and_month_of_unix_times() {
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(1_793_491_200), (2026, 11));
        assert_eq!(year_month(1_709_164_800), (2024, 2)); // 2024-02-29
        assert_eq!(year_month(951_782_400), (2000, 2)); // 2000-02-29
    }

    #[test]
    fn a_finished_run_lets_go_of_its_report_and_log_once_stored() {
        let entry = |id: &str, finished_at: Option<u64>, stored: bool| RunEntry {
            id: id.into(),
            owner: "github.com-acme".into(),
            repo: "https://github.com/acme/web".into(),
            state: if finished_at.is_some() {
                "finished"
            } else {
                "running"
            },
            started_at: 1_000,
            finished_at,
            result: finished_at.map(|_| json!({ "passed": true, "output": "x".repeat(1 << 20) })),
            error: None,
            stored,
            forgotten: false,
        };
        let mut runs: HashMap<String, RunEntry> = [
            entry("old", Some(2_000), true),
            entry("unstored", Some(2_000), false),
            entry("recent", Some(2_000 + KEEP_REPORT_SECS), true),
            entry("running", None, false),
        ]
        .into_iter()
        .map(|e| (e.id.clone(), e))
        .collect();
        let mut logs: HashMap<String, Arc<LogHub>> = runs
            .keys()
            .map(|id| {
                let hub = Arc::new(LogHub::default());
                hub.push(&crate::schedule::LogEvent::Output {
                    job: "test".into(),
                    stream: "stdout",
                    line: "y".repeat(1 << 20),
                });
                (id.clone(), hub)
            })
            .collect();
        // A follower of a log that is let go of reads it to its end.
        let follower = logs["old"].clone();

        forget_finished(&mut runs, &mut logs, 2_000 + KEEP_REPORT_SECS - 1);
        assert!(runs.values().all(|e| !e.forgotten), "too soon");
        assert_eq!(logs.len(), 4);

        forget_finished(&mut runs, &mut logs, 2_000 + KEEP_REPORT_SECS);
        assert!(runs["old"].forgotten && runs["old"].result.is_none());
        assert!(!logs.contains_key("old") && !logs.contains_key("unstored"));
        // Nothing else has its report, so the runner keeps it.
        assert!(!runs["unstored"].forgotten && runs["unstored"].result.is_some());
        assert!(runs["recent"].result.is_some() && logs.contains_key("recent"));
        assert!(logs.contains_key("running"));
        assert_eq!(follower.state.lock().unwrap().frames.len(), 1);
        // What a finished run still holds is its state, not its report.
        let left = serde_json::to_vec(&runs["old"]).unwrap();
        assert!(left.len() < 512, "{} bytes", left.len());

        forget_finished(&mut runs, &mut logs, u64::MAX);
        assert!(runs["recent"].forgotten);
        assert_eq!(logs.keys().collect::<Vec<_>>(), ["running"]);
    }

    #[test]
    fn keys_compare_in_constant_time_and_exactly() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
