//! Runs a [`Plan`]'s jobs.
//!
//! A job key becomes ready when every job it `needs` has finished. Then its
//! `paths:` filter and `if:` are checked, it is expanded (a matrix that
//! comes from another job's output is only known now), and its entries are
//! queued for the worker threads. Workspaces are built the first time a
//! job needs them, once each, so a job that is skipped never costs a clone
//! or an install.
//!
//! A `task-cache:` entry is looked up before it is queued, on threads of
//! its own (see [`LOOKUPS`]): a hit finishes there, and only a miss waits
//! for a slot and its memory.
//!
//! The scheduler knows nothing about git, package managers, R2 or Wasmer.
//! It reaches them through the four traits below, which `crate::adapters`
//! implements over the real crates and the tests implement with fakes, so
//! the ordering, skipping, output and change-policy rules are tested on
//! their own.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

use iwci_spec::expr::{self, Name};
use iwci_spec::{
    Action, ChangePolicy, JobResult, JobTemplate, NeedsValues, Plan, PlannedJob, PlannedService,
    ToolRef, WorkspaceSpec,
};
use iwci_vfs::{Change, Entry, JobFs, Snapshot, WriteBudget};
use serde::Serialize;

/// Where a job writes its outputs, as `$IWCI_OUTPUT` tells it.
pub const OUTPUT_PATH: &str = "/iwci/output";
/// More than this from one job is a mistake, not an output.
pub const MAX_OUTPUT_BYTES: usize = 1 << 20;

/// A workspace ready for jobs: the frozen file system, plus the
/// environment variables its installers set (`GOMODCACHE` and the like).
#[derive(Clone)]
pub struct BuiltWorkspace {
    pub snapshot: Snapshot,
    pub env: Vec<(String, String)>,
    /// Problems worth showing that did not stop the build (a skipped
    /// submodule, an unsupported git dependency).
    pub warnings: Vec<String>,
    /// One line per dependency install: whether it came from the cache.
    pub installs: Vec<String>,
    /// Directories an install put commands in (pip's console scripts),
    /// put first on a job's `PATH` whatever else sets it.
    pub path: Vec<String>,
}

pub trait Workspaces: Send + Sync {
    fn build(&self, spec: &WorkspaceSpec) -> Result<BuiltWorkspace, String>;

    /// The commit's files as `spec` clones them, installing nothing: what a
    /// task cache key reads, so a run whose jobs all hit never installs.
    fn checkout(&self, spec: &WorkspaceSpec) -> Result<Snapshot, String> {
        self.build(&WorkspaceSpec {
            deps: Vec::new(),
            ..spec.clone()
        })
        .map(|w| w.snapshot)
    }
}

/// One workspace of a run, built the first time a job needs it, and its
/// bare checkout, made the first time a task cache key needs it.
struct LazyWorkspace<'a> {
    spec: &'a WorkspaceSpec,
    workspaces: &'a dyn Workspaces,
    built: &'a OnceLock<Result<BuiltWorkspace, String>>,
    checkout: &'a OnceLock<Result<Snapshot, String>>,
}

impl LazyWorkspace<'_> {
    fn built(&self) -> &Result<BuiltWorkspace, String> {
        self.built.get_or_init(|| self.workspaces.build(self.spec))
    }

    fn files(&self) -> &Result<Snapshot, String> {
        self.checkout
            .get_or_init(|| self.workspaces.checkout(self.spec))
    }
}

/// A tool or environment fetched and verified, opaque to the scheduler.
pub trait Tools: Send + Sync {
    type Tool: Send + Sync;
    fn resolve(&self, tool: &ToolRef) -> Result<Arc<Self::Tool>, String>;
    /// The caches `tool`'s environment keeps on its own (its manifest's
    /// `caches`); none for a tool.
    fn env_caches(&self, _tool: &Self::Tool) -> Vec<crate::env_cache::EnvCacheDecl> {
        Vec::new()
    }
}

pub struct Invocation<'a> {
    pub job: &'a PlannedJob,
    pub fs: &'a JobFs,
    /// The run's shared `/tmp/workflow`, the same one for every job.
    pub scratch: &'a JobFs,
    /// The job's own `env:` over the workspace's, over the runner's `IWCI_*`.
    pub env: Vec<(String, String)>,
    /// The workspace's command directories, to go first on `PATH`.
    pub path: &'a [String],
    /// Receives output as it is written (`true` for stderr), when someone
    /// is following the run's logs.
    pub log: Option<OutputSink>,
    /// Set when the run is cancelled; the job is then stopped as its
    /// timeout would stop it.
    pub cancel: Option<iwci_runtime::Cancel>,
}

/// One of a job's `services:`, its tool resolved and its environment built.
pub struct ServiceRun<'a, T> {
    pub service: &'a PlannedService,
    pub tool: Arc<T>,
    /// The runner's variables (`CI`, `HOME`, `IWCI_COMMIT`, ...), then the
    /// service's own `env:`, secrets filled in. Nothing of the job's.
    pub env: Vec<(String, String)>,
}

/// Called with each chunk of a job's output; `true` means stderr.
pub type OutputSink = Arc<dyn Fn(bool, &[u8]) + Send + Sync>;

/// What a run's live log carries, in order.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "kebab-case")]
pub enum LogEvent {
    /// Sent first for each pipeline of a run: its jobs and what each waits
    /// for, so a client can draw the run before any job has finished.
    PipelineStarted {
        pipeline: String,
        jobs: Vec<PlannedNode>,
    },
    JobStarted {
        job: String,
        name: String,
    },
    /// One line of output, without its newline.
    Output {
        job: String,
        stream: &'static str,
        line: String,
    },
    JobFinished {
        job: String,
        status: String,
        duration_ms: u64,
        /// Replayed from the task cache rather than run.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        cached: bool,
    },
}

pub type LogFn = Arc<dyn Fn(LogEvent) + Send + Sync>;

/// One job key of a pipeline, as [`LogEvent::PipelineStarted`] lists it.
#[derive(Debug, Clone, Serialize)]
pub struct PlannedNode {
    pub key: String,
    pub name: String,
    pub needs: Vec<String>,
    /// The ids its entries will report under, or `None` while its matrix
    /// waits on another job's outputs.
    pub ids: Option<Vec<String>>,
}

impl PlannedNode {
    fn of(template: &JobTemplate) -> Self {
        let instances = template.instances.as_deref();
        PlannedNode {
            key: template.key.clone(),
            name: instances
                .and_then(|i| (i.len() == 1).then(|| i[0].display_name.clone()))
                .unwrap_or_else(|| template.key.clone()),
            needs: template.needs.clone(),
            ids: instances.map(|i| i.iter().map(|j| j.id.clone()).collect()),
        }
    }
}

fn status_word(status: &Status) -> &'static str {
    match status {
        Status::Passed => "passed",
        Status::Failed { .. } => "failed",
        Status::Skipped { .. } => "skipped",
        Status::Error { .. } => "error",
        Status::Cancelled { .. } => "cancelled",
    }
}

/// The word a report and the live log use for a status.
pub fn status_name(status: &Status) -> &'static str {
    status_word(status)
}

fn emit_finished(options: &Options, report: &JobReport) {
    if let Some(logs) = &options.logs {
        logs(LogEvent::JobFinished {
            job: report.id.clone(),
            status: status_word(&report.status).to_string(),
            duration_ms: report.duration_ms,
            cached: report.cached,
        });
    }
}

/// Splits a job's output into lines for the log, per stream, so a line
/// written in two chunks arrives as one event.
struct LineSink {
    job: String,
    logs: LogFn,
    mask: Arc<Masker>,
    pending: Mutex<[Vec<u8>; 2]>,
}

/// The shortest secret (or line of a multi-line secret) that is masked.
/// Shorter values would turn ordinary output into asterisks.
pub const MIN_MASKED: usize = 3;

/// Replaces the run's secret values with `***` in what a job prints, in
/// its report and in its outputs.
#[derive(Debug, Default)]
pub struct Masker {
    /// Longest first, so a secret that contains another is masked whole.
    values: Vec<String>,
}

impl Masker {
    pub fn new<'a>(secrets: impl IntoIterator<Item = &'a String>) -> Self {
        let mut values: Vec<String> = Vec::new();
        for secret in secrets {
            let pieces = std::iter::once(secret.as_str()).chain(secret.lines().map(str::trim));
            for piece in pieces {
                if piece.len() >= MIN_MASKED {
                    values.push(piece.to_string());
                }
            }
        }
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        values.dedup();
        Masker { values }
    }

    pub fn mask(&self, text: &str) -> String {
        let mut out = text.to_string();
        for value in &self.values {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), "***");
            }
        }
        out
    }
}

impl LineSink {
    fn push(&self, stderr: bool, data: &[u8]) {
        let mut pending = self.pending.lock().unwrap();
        let buf = &mut pending[usize::from(stderr)];
        buf.extend_from_slice(data);
        while let Some(end) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=end).collect();
            self.emit(stderr, &line[..line.len() - 1]);
        }
        // A program that never prints a newline still shows up, in pieces.
        if buf.len() > 16 << 10 {
            let line = std::mem::take(buf);
            self.emit(stderr, &line);
        }
    }

    fn flush(&self) {
        let mut pending = self.pending.lock().unwrap();
        for stderr in [false, true] {
            let line = std::mem::take(&mut pending[usize::from(stderr)]);
            if !line.is_empty() {
                self.emit(stderr, &line);
            }
        }
    }

    fn emit(&self, stderr: bool, line: &[u8]) {
        (self.logs)(LogEvent::Output {
            job: self.job.clone(),
            stream: if stderr { "stderr" } else { "stdout" },
            line: self.mask.mask(&String::from_utf8_lossy(line)),
        });
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Execution {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// Seconds without output or CPU use after which the runner stopped
    /// the job as hung, when it did (iwci-runtime's stall check).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stalled_after: Option<u64>,
    pub out_of_memory: bool,
    /// Why the job never started: one of its services exited, or was not
    /// ready in time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_failure: Option<String>,
    /// The job was stopped because its run was cancelled.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
}

pub trait Executor<T>: Send + Sync {
    /// Runs `action` with `tool`. `path_tools` are the job's `tools:`,
    /// resolved, for an environment to offer as commands; `services` start
    /// before it and stop after it.
    fn execute(
        &self,
        tool: &T,
        path_tools: &[Arc<T>],
        services: &[ServiceRun<'_, T>],
        action: &Action,
        invocation: Invocation<'_>,
    ) -> Result<Execution, String>;
}

pub trait Committer: Send + Sync {
    /// Records `changes` as a commit on top of the run's commit and returns
    /// its id. `root` is the clone's guest path, which the commit strips.
    fn commit(&self, root: &str, changes: &[Change], message: &str) -> Result<String, String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Status {
    Passed,
    Failed {
        reason: String,
    },
    /// Not run. Whether that blocks the jobs that need it depends on why:
    /// see [`JobReport::blocks`].
    Skipped {
        reason: String,
    },
    /// The runner could not run it (a workspace that would not build, a
    /// tool that would not resolve, a matrix output that was not JSON).
    /// Counted as a failure.
    Error {
        message: String,
    },
    /// The run was cancelled (`POST /v1/runs/{id}/cancel`): stopped while
    /// it ran, as a timeout stops a job, or never started. Counted as a
    /// failure: what needs it is cancelled too.
    Cancelled {
        reason: String,
    },
}

/// Why a cancelled job, and every job after it, did not finish.
pub const CANCELLED_REASON: &str = "the run was cancelled";

impl Status {
    pub fn is_success(&self) -> bool {
        matches!(self, Status::Passed | Status::Skipped { .. })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobReport {
    pub id: String,
    pub name: String,
    pub tool: String,
    #[serde(flatten)]
    pub status: Status,
    pub execution: Option<Execution>,
    pub changes: Vec<ChangedFile>,
    /// Set when the job's changes were committed.
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub outputs: BTreeMap<String, String>,
    /// One line per `cache:` entry: what was restored and saved.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub caches: Vec<String>,
    /// The files it kept for people to download (`downloads:`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub downloads: Vec<DownloadedFile>,
    /// Things the job should know that are not failures, such as a secret
    /// it reads that the run does not have.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    pub duration_ms: u64,
    /// The memory the job reserved while it ran (its `memory:`), for
    /// billing; 0 for a job that never ran.
    pub memory_mib: u64,
    /// Not run: its `task-cache:` found a passing run with the same inputs,
    /// whose artifacts, outputs and log this report carries.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cached: bool,
    /// The job keys this one waited for (its `needs:`, as the plan expanded
    /// them), so a client can draw the run as a graph.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<String>,
    /// Whether jobs that need this one are held back by it: true for a
    /// failure and for a skip caused by a failure upstream, false for a
    /// skip by `paths:` or a false `if:`.
    #[serde(skip)]
    pub blocks: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunReport {
    pub pipeline: String,
    pub jobs: Vec<JobReport>,
    pub warnings: Vec<String>,
    /// How each dependency install of the workspaces that were built went.
    pub installs: Vec<String>,
    pub duration_ms: u64,
}

impl RunReport {
    pub fn passed(&self) -> bool {
        self.jobs.iter().all(|j| j.status.is_success())
    }
}

pub struct Options {
    /// Jobs running at once. Each is single-threaded wasm, so the host's
    /// core count is the natural ceiling.
    pub parallelism: usize,
    /// The commit's changed paths (relative to the repository root), when
    /// known, for `paths:` filters and `changed()`.
    pub changed_paths: Option<Vec<String>>,
    /// The runner's own variables, given to every job.
    pub base_env: Vec<(String, String)>,
    /// The memory every running job together may use, when the runner is
    /// given a limit (`--memory`). See [`MemoryBudget`].
    pub memory: Option<Arc<MemoryBudget>>,
    /// Where `cache:` entries are kept; `None` runs every job cold.
    pub caches: Option<Arc<dyn Caches>>,
    /// Where live log events go; `None` when nobody follows the run.
    pub logs: Option<LogFn>,
    /// Job slots shared with every other run in this process (the server's
    /// `--cpus` times `--jobs-per-cpu`); `None` limits only by `parallelism`.
    pub slots: Option<Arc<Slots>>,
    /// The run's secrets, for `env:` values that read
    /// `${{ secrets.<name> }}`, and masked wherever a job's output goes.
    pub secrets: BTreeMap<String, String>,
    /// Run every `task-cache:` job instead of replaying an entry: its key
    /// is still computed and a pass still saves under it, so the next run
    /// that reads the task cache benefits.
    pub skip_task_cache: bool,
    /// Where `downloads:` are kept; `None` keeps none, and a job that
    /// asks says so in its notes.
    pub downloads: Option<Arc<dyn Downloads>>,
    /// Set when this pipeline is cancelled: no job starts after it, running
    /// jobs are stopped, and every job that did not finish reports
    /// [`Status::Cancelled`].
    pub cancel: Option<iwci_runtime::Cancel>,
}

impl Options {
    fn cancelled(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.is_cancelled())
    }
}

/// The runner's job slots: how many jobs may run at once across every run.
///
/// A vCPU is shared by `jobs_per_cpu` jobs. Most CI work is not CPU-bound
/// all the way through (a job waits on its own subprocesses, reads its
/// snapshot, starts up), so a core interleaves several jobs better than it
/// runs one; the operating system time-slices them. Billing charges each
/// job its share, `1 / jobs_per_cpu` of a vCPU for its wall time.
#[derive(Debug)]
pub struct Slots {
    total: usize,
    used: Mutex<usize>,
    freed: Condvar,
}

impl Slots {
    pub fn new(total: usize) -> Self {
        Self {
            total: total.max(1),
            used: Mutex::new(0),
            freed: Condvar::new(),
        }
    }

    pub fn total(&self) -> usize {
        self.total
    }

    pub fn in_use(&self) -> usize {
        *self.used.lock().unwrap()
    }

    pub fn free(&self) -> usize {
        self.total - self.in_use()
    }

    /// Waits for a slot.
    pub fn acquire(self: &Arc<Self>) -> SlotGuard {
        let mut used = self.used.lock().unwrap();
        while *used >= self.total {
            used = self.freed.wait(used).unwrap();
        }
        *used += 1;
        SlotGuard(self.clone())
    }

    /// A slot if one is free now.
    pub fn try_acquire(self: &Arc<Self>) -> Option<SlotGuard> {
        let mut used = self.used.lock().unwrap();
        if *used >= self.total {
            return None;
        }
        *used += 1;
        Some(SlotGuard(self.clone()))
    }
}

/// A held slot, given back on drop.
#[derive(Debug)]
pub struct SlotGuard(Arc<Slots>);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        *self.0.used.lock().unwrap() -= 1;
        self.0.freed.notify_one();
    }
}

/// What a cache lookup found.
#[derive(Debug)]
pub struct Restored {
    /// The key that matched.
    pub key: String,
    /// Whether it was the job's own `key` rather than a `restore-keys`
    /// prefix; an exact hit is not saved again.
    pub exact: bool,
    pub entries: Vec<iwci_vfs::Entry>,
}

/// The store behind `cache:`. An implementation decides where entries live
/// and which a job may read and write (the run's repository and branch).
pub trait Caches: Send + Sync {
    /// The entry under `key`, or else the newest one saved under each of
    /// `restore_keys` in turn. `max_bytes` bounds what may be loaded.
    fn restore(
        &self,
        key: &str,
        restore_keys: &[String],
        max_bytes: u64,
    ) -> Result<Option<Restored>, String>;
    fn save(
        &self,
        key: &str,
        restore_keys: &[String],
        entries: &[iwci_vfs::Entry],
    ) -> Result<(), String>;
}

/// A file a job left under its `downloads:` paths, ready to keep: masked
/// already when it is text.
#[derive(Debug, Clone)]
pub struct PendingDownload {
    /// Relative to the clone when it is under it, else absolute.
    pub path: String,
    pub data: Vec<u8>,
    /// Text (UTF-8 without a NUL byte), whose secrets were masked.
    pub masked: bool,
}

/// One file a job kept for people to download, as its report lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct DownloadedFile {
    /// Relative to the clone when it is under it, else absolute.
    pub path: String,
    pub size: u64,
    /// Of the bytes stored, which for text are the masked ones.
    pub sha256: String,
    pub content_type: String,
    /// Unix seconds after which it is no longer served, and is deleted.
    pub expires_at: u64,
    /// The object it is stored as.
    pub key: String,
    /// A text file, with the run's secrets masked; `false` for a binary
    /// one, uploaded as it was.
    pub masked: bool,
}

/// Where `downloads:` go. An implementation decides the keys (the run's
/// owner, repository and id) and holds the uploads to its limits and the
/// owner's storage quota.
pub trait Downloads: Send + Sync {
    /// Keeps `files` of job `job` for `retention_secs`. Returns what it
    /// kept, and a line for each file it did not and why.
    fn upload(
        &self,
        job: &str,
        files: Vec<PendingDownload>,
        retention_secs: u64,
    ) -> (Vec<DownloadedFile>, Vec<String>);
}

/// Text, for masking: valid UTF-8 without a NUL byte. Anything else is
/// uploaded as it is.
pub fn is_text(data: &[u8]) -> bool {
    !data.contains(&0) && std::str::from_utf8(data).is_ok()
}

/// `hashFiles()`: a digest of the files under the clone matching `globs`,
/// by path and content, as the commit has them (before the job runs).
fn hash_files(snapshot: &Snapshot, root: Option<&str>, globs: &[String]) -> String {
    use sha2::Digest;
    let mut hash = sha2::Sha256::new();
    if let Some(root) = root {
        let matchers: Vec<globset::GlobMatcher> = globs
            .iter()
            .filter_map(|g| {
                globset::GlobBuilder::new(g)
                    .literal_separator(true)
                    .build()
                    .ok()
            })
            .map(|g| g.compile_matcher())
            .collect();
        let prefix = format!("{}/", root.trim_end_matches('/'));
        for path in snapshot.list_files(root) {
            let text = path.display().to_string();
            let Some(rel) = text.strip_prefix(&prefix) else {
                continue;
            };
            if matchers.iter().any(|m| m.is_match(rel)) {
                let content = snapshot.read(&path).unwrap_or_default();
                hash.update(rel.as_bytes());
                hash.update([0]);
                hash.update(sha2::Sha256::digest(&content));
            }
        }
    }
    hex::encode(&hash.finalize()[..16])
}

/// The runner's memory limit, shared by every job.
///
/// A job reserves its `memory:` before it starts, and only starts when
/// that fits. The reservation stands for the job's program and its files
/// together; each is also held to `memory:` inside the job (the program by
/// its linear memory limit, the files by its write budget).
/// The frozen workspace snapshots are not counted: they are built once
/// and shared, and their size depends only on the repository.
///
/// One budget is shared by every run in the process (`iwci serve`), so a
/// run's queued job may be waiting for memory another run holds. Every run
/// using the budget is woken whenever any of them gives memory back.
#[derive(Debug)]
pub struct MemoryBudget {
    total: u64,
    used: AtomicU64,
    /// The runs to wake when memory is given back.
    waiters: Mutex<Vec<Weak<Wake>>>,
}

impl MemoryBudget {
    pub fn new(total: u64) -> Self {
        Self {
            total,
            used: AtomicU64::new(0),
            waiters: Mutex::default(),
        }
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn used(&self) -> u64 {
        self.used.load(Ordering::SeqCst)
    }

    /// Takes `bytes` if they fit.
    pub fn try_take(&self, bytes: u64) -> bool {
        self.used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(bytes).filter(|&next| next <= self.total)
            })
            .is_ok()
    }

    /// Gives `bytes` back and wakes every run waiting for memory.
    pub fn give(&self, bytes: u64) {
        let _ = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                Some(used.saturating_sub(bytes))
            });
        let mut waiters = self.waiters.lock().unwrap_or_else(|e| e.into_inner());
        waiters.retain(|w| match w.upgrade() {
            Some(wake) => {
                wake.notify_all();
                true
            }
            None => false,
        });
    }

    /// Wakes `wake` whenever memory is given back, until it is dropped.
    fn watch(&self, wake: &Arc<Wake>) {
        let mut waiters = self.waiters.lock().unwrap_or_else(|e| e.into_inner());
        waiters.retain(|w| w.strong_count() > 0);
        waiters.push(Arc::downgrade(wake));
    }
}

/// Wakes a run's threads when what they wait for may have changed: the
/// run's own state, or memory any run gave back to a shared
/// [`MemoryBudget`].
///
/// The second comes from outside the run's state lock, so a condition
/// variable on that lock could lose it: a run that finds no memory free
/// and then waits would miss memory given back in between. Instead a
/// thread reads [`Wake::seen`] while it holds the state lock and before it
/// looks at anything, the budget included, and waits for the count to move
/// on from there. Every change after that read moves it.
#[derive(Debug, Default)]
struct Wake {
    count: Mutex<u64>,
    changed: Condvar,
}

impl Wake {
    fn seen(&self) -> u64 {
        *self.count.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn notify_all(&self) {
        *self.count.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.changed.notify_all();
    }

    /// Lets go of `guard`, waits for a change after `seen`, and takes
    /// `state` again.
    fn wait<'a, T>(
        &self,
        guard: MutexGuard<'a, T>,
        state: &'a Mutex<T>,
        seen: u64,
    ) -> MutexGuard<'a, T> {
        drop(guard);
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        while *count == seen {
            count = self.changed.wait(count).unwrap_or_else(|e| e.into_inner());
        }
        drop(count);
        state.lock().unwrap()
    }
}

/// One job's file writes, held to its own `memory:`.
///
/// They are not charged to the runner's budget as well: the job already
/// reserved its `memory:` there before it started, and that reservation is
/// the job's whole footprint as far as admission goes. Charging its files
/// on top would count them twice, and a runner whose reservations filled
/// the budget would refuse every job's first write.
#[derive(Debug)]
struct JobBudget {
    cap: u64,
    used: AtomicU64,
    refused: AtomicBool,
}

impl WriteBudget for JobBudget {
    fn take(&self, bytes: u64) -> bool {
        let ok = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(bytes).filter(|&next| next <= self.cap)
            })
            .is_ok();
        if !ok {
            self.refused.store(true, Ordering::SeqCst);
        }
        ok
    }

    fn give(&self, bytes: u64) {
        let _ = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                Some(used.saturating_sub(bytes))
            });
    }
}

/// How a finished job key went, for the keys that need it.
#[derive(Debug, Clone)]
struct Finished {
    result: JobResult,
    blocks: bool,
    outputs: BTreeMap<String, String>,
    /// What the key's `artifacts:` kept, every matrix entry's together.
    artifacts: Arc<Vec<Entry>>,
}

struct State<'p> {
    /// Keys not yet activated.
    waiting: Vec<&'p JobTemplate>,
    finished: HashMap<String, Finished>,
    /// Expanded `task-cache:` jobs whose entry has not been looked up yet.
    /// A hit finishes from here; anything else moves on to `queue`.
    lookups: Vec<(&'p JobTemplate, PlannedJob)>,
    /// Expanded jobs ready to run, each with what its lookup left it.
    queue: Vec<(&'p JobTemplate, PlannedJob, Lookup)>,
    /// Per activated key: entries still running and the reports so far.
    /// Started templates: their instances' ids in matrix order, the reports
    /// of those finished so far, and the artifacts they kept.
    open: HashMap<String, OpenKey>,
    /// Jobs running and lookups in flight.
    running: usize,
    reports: HashMap<String, Vec<JobReport>>,
    /// Set by the worker threads when they stop, so the lookup threads do.
    done: bool,
}

/// Task cache lookups in flight at once, per run. A lookup is a blocking
/// GET against the object store (a fifth of a second or so) and no work
/// for this machine, so the bound is not the core count: it is how many
/// connections one run should hold open to the store, and how many entries
/// it may have fetched but not yet counted against `scratch:`. Measured on
/// a 695-job run of hits against R2: 16 at once took 7.2 s, 32 took 4.4 s
/// and 64 took 2.8 s, each hit about 0.15 s throughout; 128 took 2.9 s
/// with each hit at 0.23 s, the store (or the runner's share of a CPU)
/// answering slower rather than more. `iwci-store` keeps as many idle
/// connections, or most lookups would open one.
pub const LOOKUPS: usize = 64;

/// What a task cache lookup leaves the job that then runs: the key to save
/// under once it passes, and the report's line saying why it ran.
#[derive(Default)]
struct Lookup {
    key: Option<String>,
    lines: Vec<String>,
}

/// How a task cache lookup went.
enum Looked {
    /// The job is finished: a hit, or a checkout that failed.
    Done(Box<JobReport>),
    /// A miss, or an entry that could not be used: the job runs.
    Run(Lookup),
}

/// A key whose entries are running.
struct OpenKey {
    /// Its instances' ids, in matrix order.
    order: Vec<String>,
    reports: Vec<JobReport>,
    /// What each finished entry kept, by its id.
    artifacts: Vec<(String, Vec<Entry>)>,
}

struct ConditionEnv<'a> {
    plan: &'a Plan,
    needs: &'a [String],
    finished: &'a HashMap<String, Finished>,
    changed_paths: Option<&'a [String]>,
}

impl expr::Env for ConditionEnv<'_> {
    fn name(&self, name: &Name) -> String {
        let ctx = self.plan.context();
        match name {
            Name::NeedsResult { job } => self
                .finished
                .get(job)
                .map_or("skipped", |f| f.result.as_str())
                .to_string(),
            Name::NeedsOutput { job, output } => self
                .finished
                .get(job)
                .and_then(|f| f.outputs.get(output).cloned())
                .unwrap_or_default(),
            Name::CommitSha => ctx.commit_sha.clone(),
            Name::CommitShortSha => ctx.commit_sha.chars().take(12).collect(),
            Name::CommitBranch => ctx.branch.clone(),
            Name::RepoId => ctx.repo_id.clone(),
            Name::Event => ctx.event.as_str().to_string(),
            Name::PipelineName => ctx.pipeline_name.clone(),
            Name::PullRequestNumber => ctx.pull_request_number(),
        }
    }

    fn all_needs_passed(&self) -> bool {
        self.needs
            .iter()
            .all(|n| self.finished.get(n).is_some_and(|f| !f.blocks))
    }

    fn changed(&self, globs: &[String]) -> bool {
        match self.changed_paths {
            None => true,
            Some(paths) => paths.iter().any(|p| {
                globs.iter().any(|g| {
                    globset::GlobBuilder::new(g)
                        .literal_separator(true)
                        .build()
                        .is_ok_and(|g| g.compile_matcher().is_match(p))
                })
            }),
        }
    }
}

/// Runs every job of `plan` and reports on each, in plan order.
pub fn run<T: Tools>(
    plan: &Plan,
    workspaces: &dyn Workspaces,
    tools: &T,
    executor: &dyn Executor<T::Tool>,
    committer: &dyn Committer,
    options: &Options,
) -> RunReport {
    let started = Instant::now();
    if let Some(logs) = &options.logs {
        logs(LogEvent::PipelineStarted {
            pipeline: plan.name.clone(),
            jobs: plan.jobs.iter().map(PlannedNode::of).collect(),
        });
    }
    let built: Vec<OnceLock<Result<BuiltWorkspace, String>>> =
        plan.workspaces.iter().map(|_| OnceLock::new()).collect();
    let checkouts: Vec<OnceLock<Result<Snapshot, String>>> =
        plan.workspaces.iter().map(|_| OnceLock::new()).collect();
    let state = Mutex::new(State {
        waiting: plan.jobs.iter().collect(),
        finished: HashMap::new(),
        lookups: Vec::new(),
        queue: Vec::new(),
        open: HashMap::new(),
        running: 0,
        reports: HashMap::new(),
        done: false,
    });
    let wake = Arc::new(Wake::default());
    if let Some(budget) = &options.memory {
        budget.watch(&wake);
    }
    if let Some(cancel) = &options.cancel {
        // Waiting workers and lookups wake at once to report what is left.
        let weak = Arc::downgrade(&wake);
        cancel.on_cancel(move || {
            if let Some(wake) = weak.upgrade() {
                wake.notify_all();
            }
        });
    }
    activate(&mut state.lock().unwrap(), plan, options);
    // One scratch directory for the whole run, held to `scratch:` as a
    // job's files are held to its `memory:`.
    let scratch = iwci_vfs::SnapshotBuilder::new()
        .freeze()
        .fork_limited(Arc::new(JobBudget {
            cap: plan.scratch_bytes,
            used: AtomicU64::new(0),
            refused: AtomicBool::new(false),
        }));
    let mask = Arc::new(Masker::new(options.secrets.values()));
    let artifact_bytes = AtomicU64::new(0);
    let shared = RunShared {
        scratch: &scratch,
        mask: &mask,
        artifact_bytes: &artifact_bytes,
    };

    // Lookup threads only for a plan that can have a task-cached job: one
    // whose matrix is not known yet may.
    let lookups = options.caches.is_some()
        && plan.jobs.iter().any(|t| {
            t.instances
                .as_ref()
                .is_none_or(|jobs| jobs.iter().any(|j| j.task_cache.is_some()))
        });

    std::thread::scope(|scope| {
        // Task cache lookups: no slot and no memory, since nothing runs. A
        // lookup in flight counts as `running`, so the workers wait for it.
        for _ in 0..if lookups { LOOKUPS } else { 0 } {
            scope.spawn(|| {
                loop {
                    let (template, job, inherited) = {
                        let mut s = state.lock().unwrap();
                        loop {
                            let seen = wake.seen();
                            if let Some((template, job)) = s.lookups.pop() {
                                s.running += 1;
                                let inherited =
                                    inherited_artifacts(plan, &template.key, &s.finished);
                                break (template, job, inherited);
                            }
                            if s.done {
                                return;
                            }
                            s = wake.wait(s, &state, seen);
                        }
                    };
                    if options.cancelled() {
                        let report = cancelled_report(&job);
                        complete(&state, &wake, plan, options, template, report, Vec::new());
                        continue;
                    }
                    let workspace = LazyWorkspace {
                        spec: &plan.workspaces[job.workspace],
                        workspaces,
                        built: &built[job.workspace],
                        checkout: &checkouts[job.workspace],
                    };
                    let mut kept = Vec::new();
                    match look_up(
                        &job, plan, &workspace, options, &shared, &inherited, &mut kept,
                    ) {
                        Looked::Done(report) => {
                            complete(&state, &wake, plan, options, template, *report, kept)
                        }
                        Looked::Run(lookup) => {
                            let mut s = state.lock().unwrap();
                            s.running -= 1;
                            s.queue.push((template, job, lookup));
                            drop(s);
                            wake.notify_all();
                        }
                    }
                }
            });
        }
        for _ in 0..options.parallelism.max(1) {
            scope.spawn(|| {
                loop {
                    let (template, job, lookup, inherited, reserved) = {
                        let mut s = state.lock().unwrap();
                        loop {
                            // Read before the budget is, so memory given
                            // back after this wakes the wait below.
                            let seen = wake.seen();
                            // The newest job whose memory fits the runner's
                            // budget right now; the reservation is held until
                            // it finishes. Without a budget, simply the newest.
                            // A cancelled run's queued jobs are only
                            // reported, so they need no memory.
                            let cancelled = options.cancelled();
                            let fits = match &options.memory {
                                _ if cancelled => s.queue.len().checked_sub(1),
                                None => s.queue.len().checked_sub(1),
                                Some(budget) => s
                                    .queue
                                    .iter()
                                    .rposition(|(_, j, _)| budget.try_take(j.memory_bytes)),
                            };
                            if let Some(pos) = fits {
                                let (template, job, lookup) = s.queue.remove(pos);
                                s.running += 1;
                                let inherited =
                                    inherited_artifacts(plan, &template.key, &s.finished);
                                let reserved = !cancelled && options.memory.is_some();
                                break (template, job, lookup, inherited, reserved);
                            }
                            if s.running == 0 && s.lookups.is_empty() && s.queue.is_empty() {
                                // Nothing queued, nothing running, nothing
                                // being looked up: whatever is
                                // still waiting can never become ready. That
                                // takes a `needs` cycle, which validation
                                // rules out, so report rather than hang.
                                // Every activated key has an entry queued,
                                // running or being looked up, so none is
                                // left out of the report here.
                                debug_assert!(s.open.is_empty());
                                let stuck: Vec<&JobTemplate> = std::mem::take(&mut s.waiting);
                                for t in stuck {
                                    let report = key_report(
                                        t,
                                        Status::Error {
                                            message: "its `needs` can never be satisfied".into(),
                                        },
                                        true,
                                    );
                                    s.reports.insert(t.key.clone(), vec![report]);
                                }
                                s.done = true;
                                wake.notify_all();
                                return;
                            }
                            // Something of this run's is running or being
                            // looked up, and wakes us when it finishes; or
                            // queued jobs wait for memory other runs hold,
                            // and the budget wakes us when any run gives
                            // some back. A job that can never fit was
                            // turned away when it was activated.
                            s = wake.wait(s, &state, seen);
                        }
                    };
                    if options.cancelled() {
                        if let (true, Some(budget)) = (reserved, &options.memory) {
                            budget.give(job.memory_bytes);
                        }
                        let report = cancelled_report(&job);
                        complete(&state, &wake, plan, options, template, report, Vec::new());
                        continue;
                    }
                    // A slot shared with every other run on this runner;
                    // held for the job's workspace build and its run.
                    let slot = options.slots.as_ref().map(|s| s.acquire());
                    let workspace = LazyWorkspace {
                        spec: &plan.workspaces[job.workspace],
                        workspaces,
                        built: &built[job.workspace],
                        checkout: &checkouts[job.workspace],
                    };
                    let mut kept = Vec::new();
                    let report = run_job(
                        &job, plan, &workspace, tools, executor, committer, options, &shared,
                        &inherited, lookup, &mut kept,
                    );
                    drop(slot);
                    if let (true, Some(budget)) = (reserved, &options.memory) {
                        budget.give(job.memory_bytes);
                    }
                    complete(&state, &wake, plan, options, template, report, kept);
                }
            });
        }
    });

    let mut state = state.into_inner().unwrap();
    let mut warnings: Vec<String> = Vec::new();
    let mut installs: Vec<String> = Vec::new();
    for ws in built.iter().filter_map(OnceLock::get).flatten() {
        warnings.extend(ws.warnings.iter().cloned());
        installs.extend(ws.installs.iter().cloned());
    }
    let jobs = plan
        .jobs
        .iter()
        .flat_map(|t| state.reports.remove(&t.key).unwrap_or_default())
        .collect();
    RunReport {
        pipeline: plan.name.clone(),
        jobs,
        warnings,
        installs,
        duration_ms: millis(started.elapsed()),
    }
}

/// Records one entry's report, from a run or from the task cache, and when
/// it was its key's last, finishes the key and activates what waited on it.
fn complete<'p>(
    state: &Mutex<State<'p>>,
    wake: &Wake,
    plan: &'p Plan,
    options: &Options,
    template: &'p JobTemplate,
    mut report: JobReport,
    kept: Vec<Entry>,
) {
    report.needs = template.needs.clone();
    emit_finished(options, &report);
    let mut s = state.lock().unwrap();
    s.running -= 1;
    let entry = s.open.get_mut(&template.key).expect("activated");
    entry.artifacts.push((report.id.clone(), kept));
    entry.reports.push(report);
    if entry.reports.len() == entry.order.len() {
        let OpenKey {
            order,
            mut reports,
            mut artifacts,
        } = s.open.remove(&template.key).expect("activated");
        // Matrix entries finish in any order; report them in
        // matrix order. The order comes from the instances
        // that ran, since a matrix another job set has none
        // on its template.
        let place = |id: &str| order.iter().position(|o| o == id).unwrap_or(usize::MAX);
        reports.sort_by_key(|r| place(&r.id));
        // Their artifacts too: the jobs downstream hash what they are
        // handed in this order, so the order they finished in (lookups
        // answer in any) must not reach a task cache key.
        artifacts.sort_by_key(|(id, _)| place(id));
        let artifacts = artifacts.into_iter().flat_map(|(_, kept)| kept).collect();
        finish(&mut s, template, reports, artifacts);
        activate(&mut s, plan, options);
    }
    drop(s);
    wake.notify_all();
}

/// Moves every waiting key whose needs have all finished to the queue, or
/// to the task cache lookups first when it has one (or
/// straight to finished, when it is skipped or cannot expand). Loops,
/// because finishing a skipped key can make the next one ready.
fn activate<'p>(s: &mut State<'p>, plan: &'p Plan, options: &Options) {
    loop {
        let Some(pos) = s
            .waiting
            .iter()
            .position(|t| t.needs.iter().all(|n| s.finished.contains_key(n)))
        else {
            return;
        };
        let template = s.waiting.remove(pos);
        if options.cancelled() {
            let report = key_report(
                template,
                Status::Cancelled {
                    reason: CANCELLED_REASON.into(),
                },
                true,
            );
            emit_finished(options, &report);
            finish(s, template, vec![report], Vec::new());
            continue;
        }
        let env = ConditionEnv {
            plan,
            needs: &template.needs,
            finished: &s.finished,
            changed_paths: options.changed_paths.as_deref(),
        };
        let skip = if !template.affected_by(options.changed_paths.as_deref()) {
            Some(("no changes under its `paths:`".to_string(), false))
        } else if template.should_run(&env) {
            None
        } else if !expr::Env::all_needs_passed(&env)
            && !template
                .condition
                .as_ref()
                .is_some_and(|c| c.mentions_status())
        {
            let failed = template
                .needs
                .iter()
                .find(|n| s.finished.get(*n).is_some_and(|f| f.blocks))
                .cloned()
                .unwrap_or_default();
            Some((format!("`{failed}` did not pass"), true))
        } else {
            Some(("its `if:` is false".to_string(), false))
        };
        if let Some((reason, blocks)) = skip {
            let report = key_report(template, Status::Skipped { reason }, blocks);
            emit_finished(options, &report);
            finish(s, template, vec![report], Vec::new());
            continue;
        }

        let values = NeedsValues {
            results: s
                .finished
                .iter()
                .map(|(k, f)| (k.clone(), f.result))
                .collect(),
            outputs: s
                .finished
                .iter()
                .map(|(k, f)| (k.clone(), f.outputs.clone()))
                .collect(),
        };
        match plan.instantiate(&template.key, &values) {
            Err(errors) => {
                let report = key_report(
                    template,
                    Status::Error {
                        message: errors.to_string(),
                    },
                    true,
                );
                emit_finished(options, &report);
                finish(s, template, vec![report], Vec::new());
            }
            Ok(jobs) if jobs.is_empty() => {
                let report = key_report(
                    template,
                    Status::Skipped {
                        reason: "its matrix is empty".into(),
                    },
                    false,
                );
                emit_finished(options, &report);
                finish(s, template, vec![report], Vec::new());
            }
            Ok(jobs)
                if options
                    .memory
                    .as_ref()
                    .is_some_and(|b| jobs.iter().any(|j| j.memory_bytes > b.total())) =>
            {
                let total = options.memory.as_ref().map_or(0, |b| b.total());
                let asks = jobs.iter().map(|j| j.memory_bytes).max().unwrap_or(0);
                let message = format!(
                    "asks for {} MiB of memory, more than the runner's whole limit of {} MiB (--memory)",
                    asks >> 20,
                    total >> 20
                );
                let report = key_report(template, Status::Error { message }, true);
                emit_finished(options, &report);
                finish(s, template, vec![report], Vec::new());
            }
            Ok(jobs) => {
                let order = jobs.iter().map(|j| j.id.clone()).collect();
                s.open.insert(
                    template.key.clone(),
                    OpenKey {
                        order,
                        reports: Vec::new(),
                        artifacts: Vec::new(),
                    },
                );
                // The queue is a stack; push in reverse so entries start in
                // matrix order.
                for job in jobs.into_iter().rev() {
                    if job.task_cache.is_some() && options.caches.is_some() {
                        s.lookups.push((template, job));
                    } else {
                        s.queue.push((template, job, Lookup::default()));
                    }
                }
            }
        }
    }
}

fn finish(
    s: &mut State<'_>,
    template: &JobTemplate,
    reports: Vec<JobReport>,
    artifacts: Vec<Entry>,
) {
    let blocks = reports.iter().any(|r| r.blocks);
    let result = if reports.iter().any(|r| {
        matches!(
            r.status,
            Status::Failed { .. } | Status::Error { .. } | Status::Cancelled { .. }
        )
    }) {
        JobResult::Failure
    } else if reports
        .iter()
        .all(|r| matches!(r.status, Status::Skipped { .. }))
    {
        JobResult::Skipped
    } else {
        JobResult::Success
    };
    // Outputs only exist on jobs without a matrix, so there is one report.
    let outputs = reports
        .first()
        .map(|r| r.outputs.clone())
        .unwrap_or_default();
    s.finished.insert(
        template.key.clone(),
        Finished {
            result,
            blocks,
            outputs,
            artifacts: Arc::new(artifacts),
        },
    );
    s.reports.insert(template.key.clone(), reports);
}

fn key_report(template: &JobTemplate, status: Status, blocks: bool) -> JobReport {
    JobReport {
        id: template.key.clone(),
        name: template
            .instances
            .as_ref()
            .and_then(|i| (i.len() == 1).then(|| i[0].display_name.clone()))
            .unwrap_or_else(|| template.key.clone()),
        tool: template.tool.to_string(),
        status,
        execution: None,
        changes: Vec::new(),
        commit: None,
        outputs: BTreeMap::new(),
        caches: Vec::new(),
        downloads: Vec::new(),
        notes: Vec::new(),
        memory_mib: 0,
        duration_ms: 0,
        blocks,
        cached: false,
        needs: template.needs.clone(),
    }
}

/// What every job of one run shares.
struct RunShared<'a> {
    scratch: &'a JobFs,
    mask: &'a Arc<Masker>,
    /// Bytes of artifacts kept so far, held to the run's `scratch:` limit:
    /// both live in memory for the whole run.
    artifact_bytes: &'a AtomicU64,
}

/// Looks a `task-cache:` job up before it is queued. A job whose inputs
/// are what a passing run saw is not run: that run's artifacts, outputs
/// and log stand in for it. A miss, or an entry that cannot be used, runs
/// the job, which saves under the key computed here. The key reads the bare
/// checkout, so a hit never waits for the workspace's installs.
///
/// This holds no job slot and none of the job's `memory:`, which is what
/// lets a run look up many more entries at once than it may run jobs. Keep
/// it to the checkout, the key and the store.
fn look_up(
    job: &PlannedJob,
    plan: &Plan,
    workspace: &LazyWorkspace<'_>,
    options: &Options,
    shared: &RunShared<'_>,
    inherited: &[(String, Arc<Vec<Entry>>)],
    kept: &mut Vec<Entry>,
) -> Looked {
    let started = Instant::now();
    let key = match workspace.files() {
        Ok(files) => task_cache_key(job, plan, files, inherited),
        Err(e) => {
            return Looked::Done(Box::new(errored(
                job,
                format!("workspace did not build: {e}"),
                started.elapsed(),
            )));
        }
    };
    let (Some(key), Some(store)) = (key, &options.caches) else {
        return Looked::Run(Lookup::default());
    };
    if options.skip_task_cache {
        // Runs, and saves under the key as a miss would.
        let line = format!(
            "task cache `{}`: not read, this run skips the task cache",
            short_key(&key)
        );
        return Looked::Run(Lookup {
            key: Some(key),
            lines: vec![line],
        });
    }
    let mut lines = Vec::new();
    match store.restore(&key, &[], plan.scratch_bytes + MAX_TASK_LOG) {
        Ok(Some(hit)) => {
            match replay(job, plan, options, shared, &key, hit.entries, started, kept) {
                Ok(report) => return Looked::Done(Box::new(report)),
                Err(e) => lines.push(format!(
                    "task cache `{}`: could not use the entry ({e}); running it",
                    short_key(&key)
                )),
            }
        }
        Ok(None) => lines.push(format!("task cache `{}`: miss", short_key(&key))),
        Err(e) => lines.push(format!(
            "task cache `{}`: could not read the cache ({e}); running it",
            short_key(&key)
        )),
    }
    Looked::Run(Lookup {
        key: Some(key),
        lines,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_job<T: Tools>(
    job: &PlannedJob,
    plan: &Plan,
    workspace: &LazyWorkspace<'_>,
    tools: &T,
    executor: &dyn Executor<T::Tool>,
    committer: &dyn Committer,
    options: &Options,
    shared: &RunShared<'_>,
    inherited: &[(String, Arc<Vec<Entry>>)],
    lookup: Lookup,
    kept: &mut Vec<Entry>,
) -> JobReport {
    let started = Instant::now();
    // The task cache was looked up before the job was queued (`look_up`);
    // it is not read again here, only saved to after a pass.
    let Lookup {
        key: task_key,
        lines: task_lines,
    } = lookup;
    let workspace = match workspace.built() {
        Ok(ws) => ws,
        Err(e) => {
            return errored(
                job,
                format!("workspace did not build: {e}"),
                started.elapsed(),
            );
        }
    };
    let tool = match tools.resolve(&job.tool) {
        Ok(t) => t,
        Err(e) => return errored(job, format!("{}: {e}", job.tool), started.elapsed()),
    };
    let mut path_tools = Vec::with_capacity(job.tools.len());
    for t in &job.tools {
        match tools.resolve(t) {
            Ok(resolved) => path_tools.push(resolved),
            Err(e) => return errored(job, format!("tools: {t}: {e}"), started.elapsed()),
        }
    }
    let mut service_tools = Vec::with_capacity(job.services.len());
    for service in &job.services {
        match tools.resolve(&service.tool) {
            Ok(resolved) => service_tools.push(resolved),
            Err(e) => {
                return errored(
                    job,
                    format!("services: {}: {}: {e}", service.name, service.tool),
                    started.elapsed(),
                );
            }
        }
    }

    // The job's files live in memory, so its writes are held to its
    // `memory:` too (and to the runner's budget), or a job could write its
    // way past any limit.
    let write_budget = Arc::new(JobBudget {
        cap: job.memory_bytes,
        used: AtomicU64::new(0),
        refused: AtomicBool::new(false),
    });
    let fs = workspace.snapshot.fork_limited(write_budget.clone());
    if let Err(e) = fs.write(OUTPUT_PATH, b"") {
        return errored(
            job,
            format!("could not create {OUTPUT_PATH}: {e}"),
            started.elapsed(),
        );
    }
    let root = plan.workspaces[job.workspace]
        .clone
        .as_ref()
        .map(|c| c.into.clone());

    // What the jobs this one needs kept, oldest first, so a later job's
    // copy of a file wins. They are inputs, never this job's changes.
    let mut artifact_notes = Vec::new();
    let mut restored: HashSet<PathBuf> = HashSet::new();
    for (from, entries) in inherited {
        if let Err(e) = fs.apply(entries) {
            return errored(
                job,
                format!("could not write the artifacts of `{from}`: {e}"),
                started.elapsed(),
            );
        }
        let files = entries
            .iter()
            .filter(|e| matches!(e, Entry::File { .. }))
            .count();
        artifact_notes.push(format!("artifacts: {files} file(s) from `{from}`"));
        restored.extend(entries.iter().map(|e| entry_path(e).to_path_buf()));
    }

    // Restore caches before the job runs. A miss, or a store that cannot be
    // read, is a cold start, never a failure.
    let mut cache_lines = task_lines;
    let mut cache_keys = Vec::new();
    for cache in &job.caches {
        let hash = |globs: &[String]| hash_files(&workspace.snapshot, root.as_deref(), globs);
        let key = match iwci_spec::expand_hash_files(&cache.key, hash) {
            Ok(k) => k,
            Err(e) => return errored(job, format!("cache key: {e}"), started.elapsed()),
        };
        let restore_keys: Vec<String> = match cache
            .restore_keys
            .iter()
            .map(|k| {
                iwci_spec::expand_hash_files(k, |g| {
                    hash_files(&workspace.snapshot, root.as_deref(), g)
                })
            })
            .collect()
        {
            Ok(keys) => keys,
            Err(e) => return errored(job, format!("cache restore-keys: {e}"), started.elapsed()),
        };
        let mut exact = false;
        match options
            .caches
            .as_ref()
            .map(|c| c.restore(&key, &restore_keys, job.memory_bytes))
        {
            None => {}
            Some(Ok(Some(restored))) => match fs.apply(&restored.entries) {
                Ok(()) => {
                    exact = restored.exact;
                    cache_lines.push(if restored.exact {
                        format!("cache `{key}`: restored")
                    } else {
                        format!("cache `{key}`: restored `{}`", restored.key)
                    });
                }
                Err(e) => cache_lines.push(format!(
                    "cache `{key}`: could not restore ({e}); starting cold"
                )),
            },
            Some(Ok(None)) => cache_lines.push(format!("cache `{key}`: miss")),
            Some(Err(e)) => cache_lines.push(format!(
                "cache `{key}`: could not read the cache ({e}); starting cold"
            )),
        }
        cache_keys.push((key, restore_keys, exact, cache.paths.clone()));
    }
    // The environment's own caches, which `env-cache:` can turn off.
    let env_caches: Vec<crate::env_cache::Active> = match &options.caches {
        Some(store) => tools
            .env_caches(&tool)
            .into_iter()
            .filter(|c| job.env_cache.keeps(&c.name))
            .map(|c| {
                crate::env_cache::restore(
                    store.as_ref(),
                    c,
                    &job.id,
                    &fs,
                    job.memory_bytes,
                    &mut cache_lines,
                )
            })
            .collect(),
        None => Vec::new(),
    };

    let mut env = options.base_env.clone();
    env.push(("IWCI_JOB".into(), job.id.clone()));
    env.push(("IWCI_OUTPUT".into(), OUTPUT_PATH.into()));
    env.push(("IWCI_SCRATCH".into(), iwci_spec::SCRATCH_PATH.into()));
    merge_env(&mut env, &workspace.env);
    merge_env(&mut env, &job.env);
    // Secrets last, read now so they are never part of the plan. A secret
    // the run does not have reads as empty, and the report says which.
    let mut notes = artifact_notes;
    let mut secret_vars = Vec::new();
    for entry in &job.secret_env {
        let (value, missing) = entry.fill(|name| options.secrets.get(name).cloned());
        for name in missing {
            notes.push(format!(
                "secret `{name}` is not set for this run, so `{}` has it empty",
                entry.key
            ));
        }
        secret_vars.push((entry.key.clone(), value));
    }
    merge_env(&mut env, &secret_vars);

    // A service gets the runner's variables and its own, never the job's:
    // its secrets are its own `env:`'s, masked like the job's.
    let mut services = Vec::with_capacity(job.services.len());
    for (service, tool) in job.services.iter().zip(service_tools) {
        let mut service_env = options.base_env.clone();
        service_env.push(("IWCI_JOB".into(), job.id.clone()));
        service_env.push(("IWCI_SCRATCH".into(), iwci_spec::SCRATCH_PATH.into()));
        merge_env(&mut service_env, &service.env);
        let mut secrets = Vec::new();
        for entry in &service.secret_env {
            let (value, missing) = entry.fill(|name| options.secrets.get(name).cloned());
            for name in missing {
                notes.push(format!(
                    "secret `{name}` is not set for this run, so service `{}` has `{}` empty",
                    service.name, entry.key
                ));
            }
            secrets.push((entry.key.clone(), value));
        }
        merge_env(&mut service_env, &secrets);
        services.push(ServiceRun {
            service,
            tool,
            env: service_env,
        });
    }

    let line_sink = options.logs.as_ref().map(|logs| {
        logs(LogEvent::JobStarted {
            job: job.id.clone(),
            name: job.display_name.clone(),
        });
        Arc::new(LineSink {
            job: job.id.clone(),
            logs: logs.clone(),
            mask: shared.mask.clone(),
            pending: Mutex::default(),
        })
    });
    let log: Option<OutputSink> = line_sink.clone().map(|sink| {
        let sink: OutputSink = Arc::new(move |stderr: bool, data: &[u8]| sink.push(stderr, data));
        sink
    });
    let executed = executor.execute(
        &tool,
        &path_tools,
        &services,
        &job.action,
        Invocation {
            job,
            fs: &fs,
            scratch: shared.scratch,
            env,
            path: &workspace.path,
            log,
            cancel: options.cancel.clone(),
        },
    );
    if let Some(sink) = &line_sink {
        sink.flush();
    }
    let execution = match executed {
        Ok(mut e) => {
            e.stdout = shared.mask.mask(&e.stdout);
            e.stderr = shared.mask.mask(&e.stderr);
            e.service_failure = e.service_failure.map(|f| shared.mask.mask(&f));
            e
        }
        Err(e) => return errored(job, shared.mask.mask(&e), started.elapsed()),
    };

    // What is under a cache path is the cache's, not a change to the
    // repository: restoring `.tsbuildinfo` must not fail `changes: fail` or
    // land in a `changes: commit`.
    let cached: Vec<&str> = job
        .caches
        .iter()
        .flat_map(|c| c.paths.iter().map(String::as_str))
        .chain(env_caches.iter().map(|c| c.path()))
        .collect();
    let under_cache = |path: &std::path::Path| {
        cached
            .iter()
            .any(|c| path == std::path::Path::new(c) || path.starts_with(c))
    };
    let changes: Vec<Change> = match &root {
        Some(root) if !matches!(job.changes, ChangePolicy::Ignore) => fs
            .changes(root)
            .into_iter()
            .filter(|c| !under_cache(c.path()) && !restored.contains(c.path()))
            .collect(),
        _ => Vec::new(),
    };
    let changed: Vec<ChangedFile> = changes
        .iter()
        .map(|c| ChangedFile {
            path: c.path().display().to_string(),
            kind: match c {
                Change::Added { .. } => "added",
                Change::Modified { .. } => "modified",
                Change::Deleted { .. } => "deleted",
            },
        })
        .collect();

    let outputs = fs
        .read(OUTPUT_PATH)
        .map_err(|e| e.to_string())
        .and_then(|bytes| parse_outputs(&bytes, &job.outputs))
        // An output carrying a secret would pass it on to other jobs and
        // into the report, so it is masked like the job's output.
        .map(|outputs| {
            outputs
                .into_iter()
                .map(|(k, v)| (k, shared.mask.mask(&v)))
                .collect()
        });

    let mut commit = None;
    let memory = format!("ran out of its {} MiB of memory", job.memory_bytes >> 20);
    // A job that hangs once memory runs short (a worker that could not
    // start, waited for forever) says so beside the hang (#964).
    let and_memory = |reason: String| {
        if execution.out_of_memory {
            format!("{reason}, after it {memory}")
        } else {
            reason
        }
    };
    let mut status = if execution.cancelled {
        Status::Cancelled {
            reason: CANCELLED_REASON.into(),
        }
    } else if let Some(failure) = &execution.service_failure {
        // The job never started; the failure (masked above) names the
        // service.
        Status::Failed {
            reason: failure.clone(),
        }
    } else if execution.timed_out {
        Status::Failed {
            reason: and_memory(format!("timed out after {}s", job.timeout.as_secs())),
        }
    } else if let Some(secs) = execution.stalled_after {
        Status::Failed {
            reason: and_memory(stalled_reason(secs, job.timeout.as_secs())),
        }
    } else if execution.out_of_memory {
        Status::Failed { reason: memory }
    } else if execution.exit_code != 0 && write_budget.refused.load(Ordering::SeqCst) {
        Status::Failed {
            reason: format!(
                "exited with {} after a write was refused: the files it wrote used up its {} MiB memory limit",
                execution.exit_code,
                job.memory_bytes >> 20
            ),
        }
    } else if execution.exit_code != 0 {
        Status::Failed {
            reason: format!("exited with {}", execution.exit_code),
        }
    } else if let Err(e) = &outputs {
        Status::Failed {
            reason: format!("$IWCI_OUTPUT: {e}"),
        }
    } else {
        match (&job.changes, changes.is_empty()) {
            (ChangePolicy::Fail, false) => Status::Failed {
                reason: format!(
                    "changed {} file(s); run it locally and commit the result",
                    changes.len()
                ),
            },
            (ChangePolicy::Commit { message }, false) => {
                match committer.commit(root.as_deref().unwrap_or("/"), &changes, message) {
                    Ok(id) => {
                        commit = Some(id);
                        Status::Passed
                    }
                    Err(e) => Status::Error {
                        message: format!("could not commit its changes: {e}"),
                    },
                }
            }
            _ => Status::Passed,
        }
    };

    // Keep this job's artifacts for the jobs that need it: only after a
    // pass, without the files it was handed, and within the run's
    // `scratch:` limit, since they stay in memory until the run ends.
    if status == Status::Passed && !job.artifacts.is_empty() {
        // Only what the job wrote: files it added or changed under the
        // paths, not the checkout's own files there or the ones it was
        // handed. Parents are created when the files are written.
        // `changes` walks a directory, so a path naming one file would find
        // nothing: read every change once (only what the job wrote lives in
        // its upper layer) and keep those at or under an artifact path.
        let entries = written_under(&fs, &job.artifacts, &restored);
        let files = entries
            .iter()
            .filter(|e| matches!(e, Entry::File { .. }))
            .count();
        let bytes: u64 = entries
            .iter()
            .map(|e| match e {
                Entry::File { data, .. } => data.len() as u64,
                _ => 0,
            })
            .sum();
        let total = shared.artifact_bytes.fetch_add(bytes, Ordering::SeqCst) + bytes;
        if total > plan.scratch_bytes {
            shared.artifact_bytes.fetch_sub(bytes, Ordering::SeqCst);
            status = Status::Failed {
                reason: format!(
                    "its artifacts ({} KiB) would take the run past its `scratch:` limit of {} MiB",
                    bytes.div_ceil(1024),
                    plan.scratch_bytes >> 20
                ),
            };
        } else if files == 0 {
            notes.push("artifacts: nothing under its `artifacts:` paths".into());
        } else {
            notes.push(format!(
                "artifacts: kept {files} file(s), {} KiB",
                bytes.div_ceil(1024)
            ));
            *kept = entries;
        }
    }

    // Keep the job's downloads, when its outcome is one they are kept for.
    // Text is masked here, before anything leaves the job: a download is
    // one more way a job's text gets out.
    let mut downloads = Vec::new();
    if let Some(spec) = &job.downloads
        && spec.when.keeps(status == Status::Passed)
    {
        let files: Vec<PendingDownload> = written_under(&fs, &spec.paths, &restored)
            .into_iter()
            .filter_map(|e| match e {
                Entry::File { path, data } => Some((path, data)),
                _ => None,
            })
            .map(|(path, data)| {
                let shown = match &root {
                    Some(root) => path
                        .strip_prefix(root)
                        .map_or_else(|_| path.display().to_string(), |p| p.display().to_string()),
                    None => path.display().to_string(),
                };
                let text = is_text(&data);
                let data = if text {
                    let text = std::str::from_utf8(&data).expect("checked by is_text");
                    shared.mask.mask(text).into_bytes()
                } else {
                    data.to_vec()
                };
                PendingDownload {
                    path: shown,
                    data,
                    masked: text,
                }
            })
            .collect();
        if files.is_empty() {
            notes.push("downloads: nothing under its `downloads:` paths".into());
        } else if let Some(store) = &options.downloads {
            let count = files.len();
            let (kept, problems) = store.upload(&job.id, files, spec.retention_secs);
            let bytes: u64 = kept.iter().map(|f| f.size).sum();
            notes.push(format!(
                "downloads: kept {} of {count} file(s), {} KiB",
                kept.len(),
                bytes.div_ceil(1024)
            ));
            notes.extend(problems.into_iter().map(|p| format!("downloads: {p}")));
            downloads = kept;
        } else {
            notes.push("downloads: this runner keeps no downloads".into());
        }
    }

    // Save caches only after a pass, and only when the job did not start
    // from an exact hit (that entry is already what it would save).
    if status == Status::Passed
        && let Some(store) = &options.caches
    {
        for (key, restore_keys, exact, paths) in &cache_keys {
            if *exact {
                continue;
            }
            let entries = fs.entries_under(paths);
            if !entries
                .iter()
                .any(|e| matches!(e, iwci_vfs::Entry::File { .. }))
            {
                cache_lines.push(format!("cache `{key}`: nothing to save"));
                continue;
            }
            let bytes: usize = entries
                .iter()
                .map(|e| match e {
                    iwci_vfs::Entry::File { data, .. } => data.len(),
                    _ => 0,
                })
                .sum();
            match store.save(key, restore_keys, &entries) {
                Ok(()) => {
                    cache_lines.push(format!("cache `{key}`: saved {} KiB", bytes.div_ceil(1024)))
                }
                Err(e) => cache_lines.push(format!("cache `{key}`: could not save ({e})")),
            }
        }
        for active in &env_caches {
            crate::env_cache::save(store.as_ref(), active, &fs, &mut cache_lines);
        }
    }

    // Record a pass for the task cache: what it kept, its outputs and its
    // log, under the key of everything it read.
    if status == Status::Passed
        && let (Some(key), Some(store)) = (&task_key, &options.caches)
    {
        let record = TaskRecord {
            exit_code: execution.exit_code,
            stdout: execution.stdout.clone(),
            stderr: execution.stderr.clone(),
            outputs: outputs.clone().unwrap_or_default(),
            duration_ms: millis(started.elapsed()),
        };
        let mut entries = kept.clone();
        let saved: u64 = entries
            .iter()
            .map(|e| match e {
                Entry::File { data, .. } => data.len() as u64,
                _ => 0,
            })
            .sum();
        entries.push(Entry::File {
            path: TASK_RECORD.into(),
            data: serde_json::to_vec(&record).expect("serialisable").into(),
        });
        cache_lines.push(match store.save(key, &[], &entries) {
            Ok(()) => format!(
                "task cache `{}`: saved {} KiB",
                short_key(key),
                saved.div_ceil(1024)
            ),
            Err(e) => format!("task cache `{}`: could not save ({e})", short_key(key)),
        });
    }

    let blocks = !status.is_success();
    JobReport {
        id: job.id.clone(),
        name: job.display_name.clone(),
        tool: job.tool.to_string(),
        status,
        execution: Some(execution),
        changes: changed,
        commit,
        outputs: outputs.unwrap_or_default(),
        caches: cache_lines,
        downloads,
        notes,
        memory_mib: job.memory_bytes >> 20,
        duration_ms: millis(started.elapsed()),
        blocks,
        cached: false,
        needs: Vec::new(),
    }
}

/// The files a job wrote at or under `paths`: added or changed, not the
/// checkout's own files there and not the ones it was handed. `changes`
/// walks a directory, so a path naming one file would find nothing: read
/// the changes under each path's parent (only what the job wrote lives in
/// its upper layer) and keep those at or under a path. Not every change
/// from `/`: that would read the job's whole build cache too (#1083).
/// Parents are created when the files are written.
fn written_under(fs: &JobFs, paths: &[String], restored: &HashSet<PathBuf>) -> Vec<Entry> {
    let wanted: Vec<&std::path::Path> = paths
        .iter()
        .map(|p| std::path::Path::new(p.as_str()))
        .collect();
    let mut roots: Vec<&std::path::Path> = wanted.iter().map(|w| w.parent().unwrap_or(w)).collect();
    roots.sort();
    roots.dedup();
    let written: HashSet<PathBuf> = roots
        .iter()
        .flat_map(|root| fs.changes(root))
        .filter_map(|c| match c {
            Change::Added { path, .. } | Change::Modified { path, .. } => Some(path),
            Change::Deleted { .. } => None,
        })
        .filter(|p| wanted.iter().any(|w| p.starts_with(w)))
        .filter(|p| !restored.contains(p))
        .collect();
    fs.entries_under(paths)
        .into_iter()
        .filter(|e| matches!(e, Entry::File { path, .. } if written.contains(path)))
        .collect()
}

/// Where a task cache entry keeps the run it stands for, beside the
/// artifacts. Under `/iwci`, which no job's artifacts can name.
const TASK_RECORD: &str = "/iwci/task-cache.json";
/// Room for a task cache entry's log and outputs beyond its artifacts.
const MAX_TASK_LOG: u64 = 64 << 20;

#[derive(Serialize, serde::Deserialize)]
struct TaskRecord {
    exit_code: i32,
    stdout: String,
    stderr: String,
    outputs: BTreeMap<String, String>,
    duration_ms: u64,
}

fn short_key(key: &str) -> &str {
    let hash = key.rsplit('/').next().unwrap_or(key);
    &hash[..hash.len().min(12)]
}

/// The task cache key of a `task-cache:` job: everything that decides what
/// it does and what it reads. Its definition (tool, arguments or script,
/// environment, directory, what it keeps), its workspace's settings and
/// lockfiles, the files its inputs match as the commit has them (never
/// under `node_modules`), and the artifacts it is handed, by content, so a
/// change to a package reaches every job downstream of it. `None` for a
/// job without one.
fn task_cache_key(
    job: &PlannedJob,
    plan: &Plan,
    snapshot: &Snapshot,
    inherited: &[(String, Arc<Vec<Entry>>)],
) -> Option<String> {
    use sha2::Digest;
    let spec = job.task_cache.as_ref()?;
    let ws = &plan.workspaces[job.workspace];
    let root = ws.clone.as_ref()?.into.clone();
    #[derive(Serialize)]
    struct Definition<'a> {
        tool: &'a ToolRef,
        tools: &'a [ToolRef],
        action: &'a Action,
        cwd: &'a str,
        env: &'a [(String, String)],
        artifacts: &'a [String],
        outputs: &'a [String],
        network: bool,
        changes: &'a ChangePolicy,
        workspace: &'a WorkspaceSpec,
        inputs: &'a [String],
        // Left out when empty, so a job without services keeps its key.
        #[serde(skip_serializing_if = "<[_]>::is_empty")]
        services: &'a [PlannedService],
    }
    let definition = Definition {
        tool: &job.tool,
        tools: &job.tools,
        action: &job.action,
        cwd: &job.cwd,
        env: &job.env,
        artifacts: &job.artifacts,
        outputs: &job.outputs,
        network: job.network,
        changes: &job.changes,
        workspace: ws,
        inputs: &spec.inputs,
        services: &job.services,
    };
    let mut hash = sha2::Sha256::new();
    let add_file = |hash: &mut sha2::Sha256, label: &str, content: &[u8]| {
        hash.update(label.as_bytes());
        hash.update([0]);
        hash.update(sha2::Sha256::digest(content));
    };
    hash.update(b"iwci task cache 1\0");
    hash.update(serde_json::to_vec(&definition).ok()?);
    for dep in &ws.deps {
        let names: Vec<&str> = match dep.ecosystem {
            iwci_spec::Ecosystem::Pnpm => vec!["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"],
            iwci_spec::Ecosystem::Go => vec!["go.mod", "go.sum"],
            iwci_spec::Ecosystem::Cargo => vec!["Cargo.lock"],
            iwci_spec::Ecosystem::Pip => match &dep.file {
                Some(file) => vec![file.as_str()],
                None => iwci_deps::pip::DEFAULT_FILES.to_vec(),
            },
            iwci_spec::Ecosystem::Composer => vec!["composer.lock", "composer.json"],
        };
        for name in names {
            let path = format!("{}/{name}", dep.dir);
            if let Ok(content) = snapshot.read(&path) {
                add_file(&mut hash, &path, &content);
            }
        }
    }
    hash.update(b"\0inputs\0");
    let filter = iwci_spec::PathFilter::new(&spec.inputs);
    let (dirs, files) = filter.bases(&spec.inputs);
    let prefix = format!("{root}/");
    let mut matched = std::collections::BTreeSet::new();
    for dir in dirs {
        let base = if dir.is_empty() {
            root.clone()
        } else {
            format!("{root}/{dir}")
        };
        for path in snapshot.list_files_skipping(&base, |n| n == "node_modules" || n == ".git") {
            let text = path.display().to_string();
            if let Some(rel) = text.strip_prefix(&prefix)
                && filter.matches(rel)
            {
                matched.insert(rel.to_string());
            }
        }
    }
    for file in files {
        if snapshot.is_file(format!("{root}/{file}")) && filter.matches(&file) {
            matched.insert(file);
        }
    }
    for rel in &matched {
        let content = snapshot.read(format!("{root}/{rel}")).unwrap_or_default();
        add_file(&mut hash, rel, &content);
    }
    hash.update(b"\0artifacts\0");
    for (from, entries) in inherited {
        hash.update(from.as_bytes());
        hash.update([0]);
        for entry in entries.iter() {
            match entry {
                Entry::File { path, data } => {
                    add_file(&mut hash, &path.display().to_string(), data)
                }
                Entry::Dir { path } => {
                    hash.update(path.display().to_string().as_bytes());
                    hash.update(b"/\0");
                }
                Entry::Symlink { path, target } => {
                    hash.update(path.display().to_string().as_bytes());
                    hash.update(b" -> ");
                    hash.update(target.display().to_string().as_bytes());
                    hash.update([0]);
                }
            }
        }
    }
    Some(format!(
        "task/{}/{}",
        job.id,
        hex::encode(&hash.finalize()[..16])
    ))
}

/// A job's report from a task cache entry, its artifacts kept for the jobs
/// that need it as if it had run.
#[allow(clippy::too_many_arguments)]
fn replay(
    job: &PlannedJob,
    plan: &Plan,
    options: &Options,
    shared: &RunShared<'_>,
    key: &str,
    entries: Vec<Entry>,
    started: Instant,
    kept: &mut Vec<Entry>,
) -> Result<JobReport, String> {
    let (record, files): (Vec<Entry>, Vec<Entry>) = entries
        .into_iter()
        .partition(|e| entry_path(e) == std::path::Path::new(TASK_RECORD));
    let record = record
        .into_iter()
        .find_map(|e| match e {
            Entry::File { data, .. } => Some(data),
            _ => None,
        })
        .ok_or("the entry has no record of its run")?;
    let record: TaskRecord = serde_json::from_slice(&record).map_err(|e| e.to_string())?;
    if files
        .iter()
        .any(|e| !job.artifacts.iter().any(|a| entry_path(e).starts_with(a)))
    {
        // Only ever what the job kept: anything else is not this job's.
        return Err("the entry holds files outside the job's `artifacts:`".into());
    }
    let count = files
        .iter()
        .filter(|e| matches!(e, Entry::File { .. }))
        .count();
    let bytes: u64 = files
        .iter()
        .map(|e| match e {
            Entry::File { data, .. } => data.len() as u64,
            _ => 0,
        })
        .sum();
    let total = shared.artifact_bytes.fetch_add(bytes, Ordering::SeqCst) + bytes;
    if total > plan.scratch_bytes {
        shared.artifact_bytes.fetch_sub(bytes, Ordering::SeqCst);
        return Err("its artifacts would take the run past its `scratch:` limit".into());
    }
    let stdout = shared.mask.mask(&record.stdout);
    let stderr = shared.mask.mask(&record.stderr);
    if let Some(logs) = &options.logs {
        logs(LogEvent::JobStarted {
            job: job.id.clone(),
            name: job.display_name.clone(),
        });
        for (stream, text) in [("stdout", &stdout), ("stderr", &stderr)] {
            for line in text.lines() {
                logs(LogEvent::Output {
                    job: job.id.clone(),
                    stream,
                    line: line.to_string(),
                });
            }
        }
    }
    let mut notes = vec![format!(
        "task cache: nothing it reads changed since a run that passed in {:.1}s, so it did not run; that run's log is shown",
        record.duration_ms as f64 / 1000.0
    )];
    if count > 0 {
        notes.push(format!(
            "artifacts: kept {count} file(s), {} KiB, from the task cache",
            bytes.div_ceil(1024)
        ));
    }
    *kept = files;
    Ok(JobReport {
        id: job.id.clone(),
        name: job.display_name.clone(),
        tool: job.tool.to_string(),
        status: Status::Passed,
        execution: Some(Execution {
            exit_code: record.exit_code,
            stdout,
            stderr,
            timed_out: false,
            stalled_after: None,
            out_of_memory: false,
            service_failure: None,
            cancelled: false,
        }),
        changes: Vec::new(),
        commit: None,
        outputs: record
            .outputs
            .into_iter()
            .map(|(k, v)| (k, shared.mask.mask(&v)))
            .collect(),
        caches: vec![format!("task cache `{}`: hit", short_key(key))],
        downloads: Vec::new(),
        notes,
        duration_ms: millis(started.elapsed()),
        memory_mib: 0,
        blocks: false,
        cached: true,
        needs: Vec::new(),
    })
}

fn entry_path(entry: &Entry) -> &std::path::Path {
    match entry {
        Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => path,
    }
}

/// The artifacts a job of `key` starts with: those of every job it needs,
/// directly or through others, each once, dependencies before dependents.
fn inherited_artifacts(
    plan: &Plan,
    key: &str,
    finished: &HashMap<String, Finished>,
) -> Vec<(String, Arc<Vec<Entry>>)> {
    fn visit<'p>(plan: &'p Plan, key: &str, seen: &mut HashSet<&'p str>, order: &mut Vec<&'p str>) {
        let Some(template) = plan.jobs.iter().find(|t| t.key == key) else {
            return;
        };
        for need in &template.needs {
            if let Some(t) = plan.jobs.iter().find(|t| t.key == *need)
                && seen.insert(t.key.as_str())
            {
                visit(plan, &t.key, seen, order);
                order.push(t.key.as_str());
            }
        }
    }
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    visit(plan, key, &mut seen, &mut order);
    order
        .into_iter()
        .filter_map(|k| {
            let f = finished.get(k)?;
            (!f.artifacts.is_empty()).then(|| (k.to_string(), f.artifacts.clone()))
        })
        .collect()
}

/// Reads `$IWCI_OUTPUT` in the format CI systems commonly use for outputs:
/// `name=value` lines, and `name<<DELIM` ... `DELIM` for multi-line values.
/// A name the job did not declare is an error, so a typo fails here rather
/// than leaving a later job reading an empty string.
pub fn parse_outputs(
    bytes: &[u8],
    declared: &[String],
) -> Result<BTreeMap<String, String>, String> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(format!(
            "is {} bytes; the limit is {MAX_OUTPUT_BYTES}",
            bytes.len()
        ));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "is not UTF-8".to_string())?;
    let mut out = BTreeMap::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        let (name, value) = if let Some((name, delim)) = line.split_once("<<") {
            let mut value = Vec::new();
            loop {
                match lines.next() {
                    Some(l) if l == delim => break,
                    Some(l) => value.push(l),
                    None => {
                        return Err(format!(
                            "`{name}<<{delim}` is never closed by a `{delim}` line"
                        ));
                    }
                }
            }
            (name, value.join("\n"))
        } else if let Some((name, value)) = line.split_once('=') {
            (name, value.to_string())
        } else {
            return Err(format!(
                "`{line}` is neither `name=value` nor `name<<DELIMITER`"
            ));
        };
        if !declared.iter().any(|d| d == name) {
            let known = if declared.is_empty() {
                "the job declares none".to_string()
            } else {
                format!("declared: {}", declared.join(", "))
            };
            return Err(format!("`{name}` is not in the job's `outputs:` ({known})"));
        }
        out.insert(name.to_string(), value);
    }
    Ok(out)
}

/// The failure reason of a job the runtime stopped as hung: no output and
/// no CPU use for `secs`, before its `timeout` came.
fn stalled_reason(secs: u64, timeout: u64) -> String {
    let idle = if secs >= 60 && secs.is_multiple_of(60) {
        let minutes = secs / 60;
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    } else {
        format!("{secs}s")
    };
    format!(
        "stalled: no output and no CPU use for {idle}, so it was stopped before its {timeout}s timeout"
    )
}

/// Later entries replace earlier ones with the same key, keeping order.
fn merge_env(into: &mut Vec<(String, String)>, from: &[(String, String)]) {
    for (k, v) in from {
        into.retain(|(existing, _)| existing != k);
        into.push((k.clone(), v.clone()));
    }
}

/// A job of a cancelled run that never started.
fn cancelled_report(job: &PlannedJob) -> JobReport {
    let mut report = errored(job, String::new(), Duration::ZERO);
    report.status = Status::Cancelled {
        reason: CANCELLED_REASON.into(),
    };
    report.memory_mib = 0;
    report
}

fn errored(job: &PlannedJob, message: String, elapsed: Duration) -> JobReport {
    JobReport {
        id: job.id.clone(),
        name: job.display_name.clone(),
        tool: job.tool.to_string(),
        status: Status::Error { message },
        execution: None,
        changes: Vec::new(),
        commit: None,
        outputs: BTreeMap::new(),
        caches: Vec::new(),
        downloads: Vec::new(),
        notes: Vec::new(),
        memory_mib: job.memory_bytes >> 20,
        duration_ms: millis(elapsed),
        blocks: true,
        cached: false,
        needs: Vec::new(),
    }
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
#[path = "schedule_tests.rs"]
mod tests;
