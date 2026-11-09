//! Runs a [`Plan`]'s jobs.
//!
//! A job key becomes ready when every job it `needs` has finished. Then its
//! `paths:` filter and `if:` are checked, it is expanded (a matrix that
//! comes from another job's output is only known now), and its entries are
//! queued for the worker threads. Workspaces are built the first time a
//! job needs them, once each, so a job that is skipped never costs a clone
//! or an install.
//!
//! The scheduler knows nothing about git, package managers, R2 or Wasmer.
//! It reaches them through the four traits below, which `crate::adapters`
//! implements over the real crates and the tests implement with fakes, so
//! the ordering, skipping, output and change-policy rules are tested on
//! their own.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use iwci_spec::expr::{self, Name};
use iwci_spec::{
    Action, ChangePolicy, JobResult, JobTemplate, NeedsValues, Plan, PlannedJob, ToolRef,
    WorkspaceSpec,
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
}

pub trait Workspaces: Send + Sync {
    fn build(&self, spec: &WorkspaceSpec) -> Result<BuiltWorkspace, String>;
}

/// A tool or environment fetched and verified, opaque to the scheduler.
pub trait Tools: Send + Sync {
    type Tool: Send + Sync;
    fn resolve(&self, tool: &ToolRef) -> Result<Arc<Self::Tool>, String>;
}

pub struct Invocation<'a> {
    pub job: &'a PlannedJob,
    pub fs: &'a JobFs,
    /// The run's shared `/tmp/workflow`, the same one for every job.
    pub scratch: &'a JobFs,
    /// The job's own `env:` over the workspace's, over the runner's `IWCI_*`.
    pub env: Vec<(String, String)>,
    /// Receives output as it is written (`true` for stderr), when someone
    /// is following the run's logs.
    pub log: Option<OutputSink>,
}

/// Called with each chunk of a job's output; `true` means stderr.
pub type OutputSink = Arc<dyn Fn(bool, &[u8]) + Send + Sync>;

/// What a run's live log carries, in order.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "kebab-case")]
pub enum LogEvent {
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

fn status_word(status: &Status) -> &'static str {
    match status {
        Status::Passed => "passed",
        Status::Failed { .. } => "failed",
        Status::Skipped { .. } => "skipped",
        Status::Error { .. } => "error",
    }
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
    pub out_of_memory: bool,
}

pub trait Executor<T>: Send + Sync {
    /// Runs `action` with `tool`. `path_tools` are the job's `tools:`,
    /// resolved, for an environment to offer as commands.
    fn execute(
        &self,
        tool: &T,
        path_tools: &[Arc<T>],
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
}

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
#[derive(Debug)]
pub struct MemoryBudget {
    total: u64,
    used: AtomicU64,
}

impl MemoryBudget {
    pub fn new(total: u64) -> Self {
        Self {
            total,
            used: AtomicU64::new(0),
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

    pub fn give(&self, bytes: u64) {
        let _ = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                Some(used.saturating_sub(bytes))
            });
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
    /// Expanded jobs ready to run.
    queue: Vec<(&'p JobTemplate, PlannedJob)>,
    /// Per activated key: entries still running and the reports so far.
    /// Started templates: their instances' ids in matrix order, the reports
    /// of those finished so far, and the artifacts they kept.
    open: HashMap<String, OpenKey>,
    running: usize,
    reports: HashMap<String, Vec<JobReport>>,
}

/// A key whose entries are running.
struct OpenKey {
    /// Its instances' ids, in matrix order.
    order: Vec<String>,
    reports: Vec<JobReport>,
    artifacts: Vec<Entry>,
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
    let built: Vec<OnceLock<Result<BuiltWorkspace, String>>> =
        plan.workspaces.iter().map(|_| OnceLock::new()).collect();
    let state = Mutex::new(State {
        waiting: plan.jobs.iter().collect(),
        finished: HashMap::new(),
        queue: Vec::new(),
        open: HashMap::new(),
        running: 0,
        reports: HashMap::new(),
    });
    let wake = Condvar::new();
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

    std::thread::scope(|scope| {
        for _ in 0..options.parallelism.max(1) {
            scope.spawn(|| {
                loop {
                    let (template, job, inherited) = {
                        let mut s = state.lock().unwrap();
                        loop {
                            // The newest job whose memory fits the runner's
                            // budget right now; the reservation is held until
                            // it finishes. Without a budget, simply the newest.
                            let fits = match &options.memory {
                                None => s.queue.len().checked_sub(1),
                                Some(budget) => s
                                    .queue
                                    .iter()
                                    .rposition(|(_, j)| budget.try_take(j.memory_bytes)),
                            };
                            if let Some(pos) = fits {
                                let (template, job) = s.queue.remove(pos);
                                s.running += 1;
                                let inherited =
                                    inherited_artifacts(plan, &template.key, &s.finished);
                                break (template, job, inherited);
                            }
                            if s.running == 0 {
                                // Nothing queued, nothing running: whatever is
                                // still waiting can never become ready. That
                                // takes a `needs` cycle, which validation
                                // rules out, so report rather than hang.
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
                                wake.notify_all();
                                return;
                            }
                            s = wake.wait(s).unwrap();
                        }
                    };
                    // A slot shared with every other run on this runner;
                    // held for the job's workspace build and its run.
                    let slot = options.slots.as_ref().map(|s| s.acquire());
                    let workspace = built[job.workspace]
                        .get_or_init(|| workspaces.build(&plan.workspaces[job.workspace]));
                    let mut kept = Vec::new();
                    let report = run_job(
                        &job, plan, workspace, tools, executor, committer, options, &shared,
                        &inherited, &mut kept,
                    );
                    drop(slot);
                    emit_finished(options, &report);
                    if let Some(budget) = &options.memory {
                        budget.give(job.memory_bytes);
                    }
                    let mut s = state.lock().unwrap();
                    s.running -= 1;
                    let entry = s.open.get_mut(&template.key).expect("activated");
                    entry.reports.push(report);
                    entry.artifacts.extend(kept);
                    if entry.reports.len() == entry.order.len() {
                        let OpenKey {
                            order,
                            mut reports,
                            artifacts,
                        } = s.open.remove(&template.key).expect("activated");
                        // Matrix entries finish in any order; report them in
                        // matrix order. The order comes from the instances
                        // that ran, since a matrix another job set has none
                        // on its template.
                        reports.sort_by_key(|r| {
                            order
                                .iter()
                                .position(|id| *id == r.id)
                                .unwrap_or(usize::MAX)
                        });
                        finish(&mut s, template, reports, artifacts);
                        activate(&mut s, plan, options);
                    }
                    drop(s);
                    wake.notify_all();
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

/// Moves every waiting key whose needs have all finished to the queue (or
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
                    s.queue.push((template, job));
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
    let result = if reports
        .iter()
        .any(|r| matches!(r.status, Status::Failed { .. } | Status::Error { .. }))
    {
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
        notes: Vec::new(),
        memory_mib: 0,
        duration_ms: 0,
        blocks,
        cached: false,
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

#[allow(clippy::too_many_arguments)]
fn run_job<T: Tools>(
    job: &PlannedJob,
    plan: &Plan,
    workspace: &Result<BuiltWorkspace, String>,
    tools: &T,
    executor: &dyn Executor<T::Tool>,
    committer: &dyn Committer,
    options: &Options,
    shared: &RunShared<'_>,
    inherited: &[(String, Arc<Vec<Entry>>)],
    kept: &mut Vec<Entry>,
) -> JobReport {
    let started = Instant::now();
    let workspace = match workspace {
        Ok(ws) => ws,
        Err(e) => {
            return errored(
                job,
                format!("workspace did not build: {e}"),
                started.elapsed(),
            );
        }
    };
    // A task-cached job whose inputs are what a passing run saw is not
    // run: that run's artifacts, outputs and log stand in for it. A miss,
    // or an entry that cannot be used, runs the job.
    let task_key = task_cache_key(job, plan, workspace, inherited);
    let mut task_lines = Vec::new();
    if let (Some(key), Some(store)) = (&task_key, &options.caches) {
        match store.restore(key, &[], plan.scratch_bytes + MAX_TASK_LOG) {
            Ok(Some(hit)) => {
                match replay(job, plan, options, shared, key, hit.entries, started, kept) {
                    Ok(report) => return report,
                    Err(e) => task_lines.push(format!(
                        "task cache `{}`: could not use the entry ({e}); running it",
                        short_key(key)
                    )),
                }
            }
            Ok(None) => task_lines.push(format!("task cache `{}`: miss", short_key(key))),
            Err(e) => task_lines.push(format!(
                "task cache `{}`: could not read the cache ({e}); running it",
                short_key(key)
            )),
        }
    }
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
        &job.action,
        Invocation {
            job,
            fs: &fs,
            scratch: shared.scratch,
            env,
            log,
        },
    );
    if let Some(sink) = &line_sink {
        sink.flush();
    }
    let execution = match executed {
        Ok(mut e) => {
            e.stdout = shared.mask.mask(&e.stdout);
            e.stderr = shared.mask.mask(&e.stderr);
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
    let mut status = if execution.timed_out {
        Status::Failed {
            reason: format!("timed out after {}s", job.timeout.as_secs()),
        }
    } else if execution.out_of_memory {
        Status::Failed {
            reason: format!("ran out of its {} MiB of memory", job.memory_bytes >> 20),
        }
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
        let wanted: Vec<&std::path::Path> = job
            .artifacts
            .iter()
            .map(|p| std::path::Path::new(p.as_str()))
            .collect();
        let written: HashSet<PathBuf> = fs
            .changes("/")
            .into_iter()
            .filter_map(|c| match c {
                Change::Added { path, .. } | Change::Modified { path, .. } => Some(path),
                Change::Deleted { .. } => None,
            })
            .filter(|p| wanted.iter().any(|w| p.starts_with(w)))
            .filter(|p| !restored.contains(p))
            .collect();
        let entries: Vec<Entry> = fs
            .entries_under(&job.artifacts)
            .into_iter()
            .filter(|e| matches!(e, Entry::File { path, .. } if written.contains(path)))
            .collect();
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
        notes,
        memory_mib: job.memory_bytes >> 20,
        duration_ms: millis(started.elapsed()),
        blocks,
        cached: false,
    }
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
    workspace: &BuiltWorkspace,
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
    };
    let snapshot = &workspace.snapshot;
    let mut hash = sha2::Sha256::new();
    let add_file = |hash: &mut sha2::Sha256, label: &str, content: &[u8]| {
        hash.update(label.as_bytes());
        hash.update([0]);
        hash.update(sha2::Sha256::digest(content));
    };
    hash.update(b"iwci task cache 1\0");
    hash.update(serde_json::to_vec(&definition).ok()?);
    for dep in &ws.deps {
        let names: &[&str] = match dep.ecosystem {
            iwci_spec::Ecosystem::Pnpm => &["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"],
            iwci_spec::Ecosystem::Go => &["go.mod", "go.sum"],
            iwci_spec::Ecosystem::Cargo => &["Cargo.lock"],
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
            out_of_memory: false,
        }),
        changes: Vec::new(),
        commit: None,
        outputs: record
            .outputs
            .into_iter()
            .map(|(k, v)| (k, shared.mask.mask(&v)))
            .collect(),
        caches: vec![format!("task cache `{}`: hit", short_key(key))],
        notes,
        duration_ms: millis(started.elapsed()),
        memory_mib: 0,
        blocks: false,
        cached: true,
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

/// Later entries replace earlier ones with the same key, keeping order.
fn merge_env(into: &mut Vec<(String, String)>, from: &[(String, String)]) {
    for (k, v) in from {
        into.retain(|(existing, _)| existing != k);
        into.push((k.clone(), v.clone()));
    }
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
        notes: Vec::new(),
        memory_mib: job.memory_bytes >> 20,
        duration_ms: millis(elapsed),
        blocks: true,
        cached: false,
    }
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
#[path = "schedule_tests.rs"]
mod tests;
