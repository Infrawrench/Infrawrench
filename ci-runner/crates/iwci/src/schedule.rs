//! Runs a [`Plan`]'s jobs.
//!
//! A job key becomes ready when every job it `needs` has finished. Then its
//! `paths:` filter and `if:` are checked, it is expanded (a matrix that
//! comes from another job's output is only known now), and its entries are
//! queued for the worker threads, which start the queued job with the
//! longest chain of work still ahead of it first (see [`Rank`]), as last
//! time's durations estimate it. Workspaces are built the first time a
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
//!
//! A run may be shared with other runners: see [`Split`] and
//! the `split` module, which holds everything about it but the few places
//! below where a job is claimed, deferred or reported.
//!
//! A job that misses the task cache while another run computes the same
//! key waits for that run's entry rather than compute it too: see
//! [`InFlight`] and the `inflight` module.

use iwci_vm_proto::gitignore::GitIgnore;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

use iwci_spec::expr::{self, Name};
use iwci_spec::{
    Action, ChangePolicy, CloudSpec, DepSpec, JobAccess, JobResult, JobTemplate, NeedsValues, Plan,
    PlannedJob, PlannedService, ToolRef, WorkspaceSpec,
};
use iwci_vfs::{Change, Entry, JobFs, Snapshot, WriteBudget};
use serde::Serialize;

#[path = "schedule_split.rs"]
mod split;
pub use split::{Claim, Done, Helping, Joined, Kept, Seen, Split, Timing};

#[path = "schedule_scratch.rs"]
mod scratch;
use scratch::Published;
pub use scratch::{Layer, LayerEntry, Scratch, ScratchView, object_name as scratch_object_name};

#[path = "schedule_inflight.rs"]
mod inflight;
pub use inflight::{Ended, Holder, InFlight, InFlightTiming, Look, marker_id};

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
            install_scripts: false,
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
    locks: &'a LockIndexes,
}

/// A workspace's lockfiles as its task cache keys read them, one per
/// `deps:` entry, each parsed the first time a key needs it: a `packages:`
/// job is keyed on the part of its workspace's install its package can
/// resolve, not on the whole lockfile ([`lockfile_part`]).
struct LockIndexes {
    indexes: Vec<OnceLock<Option<LockIndex>>>,
    /// Each project's digest by `(deps index, project)`: a package has a
    /// job of every `packages:` key, and the walk is the same for each.
    digests: Mutex<HashMap<(usize, String), Option<Digest32>>>,
}

type Digest32 = [u8; 32];

enum LockIndex {
    Pnpm(iwci_deps::pnpm::KeyIndex),
    Bun(iwci_deps::bun::KeyIndex),
}

impl LockIndex {
    fn digest(&self, project: &str) -> Option<[u8; 32]> {
        match self {
            LockIndex::Pnpm(index) => Some(index.digest(project)),
            LockIndex::Bun(index) => index.digest(project),
        }
    }

    fn lockfile(&self) -> &'static str {
        match self {
            LockIndex::Pnpm(_) => "pnpm-lock.yaml",
            LockIndex::Bun(_) => "bun.lock",
        }
    }
}

impl LockIndexes {
    fn new(spec: &WorkspaceSpec) -> Self {
        Self {
            indexes: spec.deps.iter().map(|_| OnceLock::new()).collect(),
            digests: Mutex::new(HashMap::new()),
        }
    }

    /// [`LockIndex::digest`] of `spec.deps[index]` for `project`, worked
    /// out once per run, with the lockfile it stands for.
    fn digest(
        &self,
        index: usize,
        dep: &DepSpec,
        snapshot: &Snapshot,
        project: &str,
    ) -> Option<(&'static str, [u8; 32])> {
        let lock = self.get(index, dep, snapshot)?;
        let key = (index, project.to_string());
        if let Some(found) = self.digests.lock().unwrap().get(&key) {
            return found.map(|digest| (lock.lockfile(), digest));
        }
        // Outside the lock: two threads may both work one out, and agree.
        let digest = lock.digest(project);
        self.digests.lock().unwrap().insert(key, digest);
        digest.map(|digest| (lock.lockfile(), digest))
    }

    /// The index of `spec.deps[index]`, or `None` for an ecosystem without
    /// per-project parts and a lockfile that cannot be read that way (the
    /// install says why). It plans the install with the options the
    /// workspace adapter installs with (`adapters/workspace.rs`).
    fn get(&self, index: usize, dep: &DepSpec, snapshot: &Snapshot) -> Option<&LockIndex> {
        self.indexes
            .get(index)?
            .get_or_init(|| {
                let read = |path: &std::path::Path| snapshot.read(path).ok();
                let root = std::path::Path::new(&dep.dir);
                match dep.ecosystem {
                    iwci_spec::Ecosystem::Pnpm => {
                        let options = iwci_deps::pnpm::PnpmOptions {
                            only_importers: dep.only.clone(),
                            native: crate::adapters::workspace::native_platform(dep),
                            ..Default::default()
                        };
                        iwci_deps::pnpm::KeyIndex::new(&read, root, &options)
                            .ok()
                            .map(LockIndex::Pnpm)
                    }
                    iwci_spec::Ecosystem::Bun => {
                        let options = iwci_deps::bun::BunOptions {
                            native: crate::adapters::workspace::native_platform(dep),
                            ..Default::default()
                        };
                        iwci_deps::bun::KeyIndex::new(&read, root, &options)
                            .ok()
                            .map(LockIndex::Bun)
                    }
                    _ => None,
                }
            })
            .as_ref()
    }
}

impl LazyWorkspace<'_> {
    fn built(&self) -> &Result<BuiltWorkspace, String> {
        self.built.get_or_init(|| {
            let started = Instant::now();
            let built = self.workspaces.build(self.spec);
            // Every job of the workspace waits for this, in the runner's
            // log so a slow one is seen.
            eprintln!(
                "iwci: workspace {} built in {} ms",
                self.spec.key,
                started.elapsed().as_millis()
            );
            built
        })
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
    /// What `tool` resolves to, by content and without fetching it: the
    /// exact version a range picks and a digest that fixes every byte of it.
    /// A task cache key holds this rather than the `using:` text, so a
    /// version published under a range changes the key. It must agree with
    /// [`Tools::resolve`] for the rest of the run, as `StoreTools` does by
    /// memoising its listings per run.
    fn pin(&self, tool: &ToolRef) -> Result<String, String>;
    /// The caches `tool`'s environment keeps on its own (its manifest's
    /// `caches`); none for a tool.
    fn env_caches(&self, _tool: &Self::Tool) -> Vec<crate::env_cache::EnvCacheDecl> {
        Vec::new()
    }
    /// For a native tool (`builtin:bun`), which puts its job in a gVisor
    /// sandbox: what that sandbox takes beyond the job's `memory:`, which
    /// the job reserves too. `None` for anything else.
    fn sandbox_overhead(&self, _tool: &ToolRef) -> Option<u64> {
        None
    }
}

/// What a job reserves beyond its `memory:` for its sandbox, when one of
/// its `tools:` is native ([`Tools::sandbox_overhead`]).
fn sandbox_need<T: Tools>(tools: &T, job: &PlannedJob) -> Option<u64> {
    job.tools
        .iter()
        .filter_map(|t| tools.sandbox_overhead(t))
        .max()
}

pub struct Invocation<'a> {
    pub job: &'a PlannedJob,
    pub fs: &'a JobFs,
    /// The run's shared `/tmp/workflow`, the same one for every job, as
    /// this job sees it: in a split run, with what the other runners wrote.
    pub scratch: &'a ScratchView,
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
    /// Told what the job's programs hold of the runner's memory each time
    /// that passes the most they have held, when the job's reservation
    /// follows it ([`MemoryBudget`]); the executor hands it to the runtime.
    pub memory_watch: Option<iwci_runtime::MemoryWatch>,
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
    /// A cloud job is ready and waits for its executor to claim it
    /// (`POST /v1/runs/{id}/jobs/{job}/claim`); `job-started` follows the
    /// claim.
    JobExternal {
        job: String,
        name: String,
        cloud: CloudSpec,
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
        /// The runner that ran it, when another one did.
        #[serde(skip_serializing_if = "Option::is_none")]
        remote: Option<String>,
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
            remote: report.remote.clone(),
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

    /// Whether `data` holds one of the values, for bytes that cannot be
    /// rewritten: a file that would leave the runner whole or not at all.
    pub fn finds(&self, data: &[u8]) -> bool {
        self.values.iter().any(|value| {
            data.windows(value.len())
                .any(|window| window == value.as_bytes())
        })
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

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
#[serde(default)]
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
    /// The most memory its programs held at once, in bytes (iwci-runtime's
    /// `Outcome::peak_memory_bytes`). The report carries it, with the
    /// job's files, as [`JobReport::peak_memory_mib`].
    #[serde(skip)]
    pub peak_memory_bytes: u64,
    /// The most of the runner's memory its programs held at once, in bytes
    /// (iwci-runtime's `Outcome::held_memory_bytes`): a V8 heap counts for
    /// what it committed, not for the room it reserved. The report carries
    /// it, with the job's files, as [`JobReport::held_memory_mib`].
    #[serde(skip)]
    pub held_memory_bytes: u64,
    /// Why the job never started: one of its services exited, or was not
    /// ready in time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_failure: Option<String>,
    /// The job was stopped because its run was cancelled.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    /// The job ran in a gVisor sandbox (a native tool, `builtin:bun`):
    /// what the sandbox itself took and what it reserved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxUsage>,
    /// The job ran in a virtual machine (`platform: linux`):
    /// which, how long it took to start, and what it reserved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineUsage>,
}

/// What a job's virtual machine was and took.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct MachineUsage {
    /// `linux`.
    pub os: String,
    /// The image, as the machine's agent names it (`ubuntu-24.04`).
    pub image: String,
    /// `x86_64` or `aarch64`.
    pub arch: String,
    /// From starting the emulator to the agent answering.
    pub boot_ms: u64,
    /// Writing the job's files into it, and reading back what it left.
    pub transfer_ms: u64,
    /// What the runner reserved for it on top of the job's `memory:`.
    pub reserved_mib: u64,
    /// The CPU time the whole machine used, as the host saw it.
    pub cpu_ms: u64,
}

/// What a job's gVisor sandbox took besides the job: its peak and held
/// memory above are the job's own share, as for a WASIX job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct SandboxUsage {
    /// The sandbox's own memory (gVisor's kernel, the runner inside and
    /// the environment's packages), measured before the job's script
    /// started.
    pub overhead_mib: u64,
    /// What the runner reserved for it on top of the job's `memory:`, and
    /// bills with it.
    pub reserved_mib: u64,
    /// The CPU time the whole sandbox used, gVisor's kernel's included.
    pub cpu_ms: u64,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
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
    /// The whole vCPUs the job held while it ran (its `cpus:`, at most the
    /// runner's), for billing; `None` for a job that held its share of
    /// one, or never ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<u32>,
    /// The most memory the job held at once, to size its `memory:` by:
    /// the linear memories of its programs and services, the room its V8
    /// heaps had reserved, and the files it wrote, each at its own peak.
    /// 0 for a job that never ran, a task cache hit and a cloud job.
    #[serde(skip_serializing_if = "is_zero")]
    pub peak_memory_mib: u64,
    /// The most of the runner's memory the job held at once: as
    /// `peak_memory_mib`, but with each V8 heap at what it had committed
    /// rather than the room it had reserved, which for a Node job is two
    /// to five times as much. It is what the runner admits the job by the
    /// next time, when it admits by estimate ([`MemoryBudget`]); `memory:`
    /// is still sized from `peak_memory_mib`. 0 as that is.
    #[serde(skip_serializing_if = "is_zero")]
    pub held_memory_mib: u64,
    /// How long the job waited to start after it was ready (its `needs`
    /// finished and its task cache missed): for the runner's memory to
    /// have room for its `memory:`, then for a job slot.
    #[serde(skip_serializing_if = "is_zero")]
    pub queued_ms: u64,
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
    /// The connections, SSH keys and resources it names, by name only.
    #[serde(skip_serializing_if = "JobAccess::is_empty")]
    pub access: JobAccess,
    /// Set for a cloud job: where it ran and for how long.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud: Option<CloudRun>,
    /// The runner that ran it, when another runner of a split run did:
    /// this report is the one that runner made. The run that has it is
    /// billed for it like any other of its jobs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// Set on a task cache hit whose entry another run saved while this
    /// one waited for it, rather than compute the same key too: that run's
    /// id. `cached` is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waited_for: Option<String>,
    /// What it kept is not on this runner (a helper that could not be
    /// sent it), so the jobs that need it cannot run here.
    #[serde(skip)]
    pub elsewhere: bool,
}

/// Where a cloud job ran, as its report says.
#[derive(Debug, Clone, Serialize)]
pub struct CloudRun {
    #[serde(flatten)]
    pub spec: CloudSpec,
    /// What claimed it, as the executor named itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    /// From its claim to its end; 0 if it was never claimed. Billed as
    /// external time, not the runner's.
    pub claimed_ms: u64,
}

/// What a run may give its jobs beyond their pipeline: material the app
/// lends by name, whether the run is trusted (not a fork's pull request),
/// and where cloud jobs go.
#[derive(Clone, Default)]
pub struct RunAccess {
    pub lent: Arc<crate::lent::Lent>,
    pub trusted: bool,
    pub external: Option<Arc<dyn crate::external::External>>,
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

fn is_zero(n: &u64) -> bool {
    *n == 0
}

impl RunReport {
    pub fn passed(&self) -> bool {
        self.jobs.iter().all(|j| j.status.is_success())
    }
}

/// Where isolate jobs' files spill to: a directory on the runner's disk,
/// and how much of it one job may fill (`--spill-disk`).
#[derive(Debug, Clone)]
pub struct Spill {
    pub dir: std::path::PathBuf,
    pub disk_bytes: u64,
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
    /// What the app lends the run's jobs, and where cloud jobs go.
    pub access: RunAccess,
    /// How long the pipeline's jobs took last time and what they held,
    /// read before the run to order it (see [`Rank`]) and to say what each
    /// job reserves ([`MemoryBudget`]), and written after it; `None` orders
    /// by the shape of the plan alone and reserves every job's `memory:`.
    pub durations: Option<Arc<dyn Durations>>,
    /// What this run shares with other runners, when it is split across
    /// them.
    pub split: Option<Arc<dyn Split>>,
    /// The helper jobs running on this runner, every run's together, so
    /// its own runs can have their slots and memory back.
    pub helping: Option<Arc<Helping>>,
    /// Which task cache keys other runs are computing now, so that a job
    /// that missed waits for theirs rather than compute it too; `None`
    /// never waits.
    pub inflight: Option<Arc<dyn InFlight>>,
    /// The runner's virtual machines, for `platform: linux` jobs; `None`
    /// fails such jobs, saying so.
    pub machines: Option<Arc<dyn crate::machines::Machines>>,
    /// Where an isolate job's files go once they outgrow its memory
    /// (`--spill-disk`); `None` keeps them all in memory, held to `memory:`.
    pub spill: Option<Spill>,
    /// What points a job's build tools at the runner's remote cache for
    /// this run ([`crate::turbo`]), when it serves one: given to every job
    /// with a network that does not name a remote cache of its own, the
    /// token masked like a secret.
    pub remote_cache: Option<crate::turbo::JobEnv>,
}

impl Options {
    fn cancelled(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.is_cancelled())
    }

    /// Why no more jobs start, if none do: the run was cancelled, or the
    /// runner holds its memory to restart ([`MemoryBudget::hold`]).
    fn stopped(&self) -> Option<&str> {
        self.held()
            .or_else(|| self.cancelled().then_some(CANCELLED_REASON))
    }

    fn held(&self) -> Option<&str> {
        self.memory.as_deref().and_then(MemoryBudget::held)
    }

    /// What a job the run's cancel stopped says: the restart that held
    /// the memory when there is one, since that is what cancels the runs
    /// it waits for.
    fn cancel_reason(&self) -> &str {
        self.held().unwrap_or(CANCELLED_REASON)
    }
}

/// What each job of a pipeline did when it last ran, by job id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct History {
    /// How long it took, in milliseconds.
    pub durations: BTreeMap<String, u64>,
    /// What it held of the runner's memory, in MiB
    /// ([`JobReport::held_memory_mib`], as [`remembered`] keeps it).
    pub held: BTreeMap<String, u64>,
}

/// How long each job of a pipeline took when it last ran and what it held,
/// kept between runs so that the next one can start the jobs at the head
/// of its longest chains first and reserve what its jobs are expected to
/// hold. Only ever a hint: a store that cannot be read orders by the plan's
/// shape and reserves every job's `memory:`, and one that cannot be written
/// is ignored.
pub trait Durations: Send + Sync {
    /// What is kept for the pipeline named `pipeline`, empty when nothing
    /// is.
    fn load_history(&self, pipeline: &str) -> History;
    fn save_history(&self, pipeline: &str, history: &History);
}

/// The runner's job slots: how many jobs may run at once across every run.
///
/// A vCPU is shared by `per_cpu` jobs (`--jobs-per-cpu`). Most CI work is
/// not CPU-bound all the way through (a job waits on its own subprocesses,
/// reads its snapshot, starts up), so a core interleaves several jobs
/// better than it runs one; the operating system time-slices them. Billing
/// charges each job its share, `1 / per_cpu` of a vCPU for its wall time.
/// That share rounded up, 1 (`per_cpu` is at least 1), is the CPU count
/// such a job is told (`iwci_runtime::Limits::told_cpus`), though it may
/// use whatever CPU time no other job wants.
///
/// A job with `cpus:` holds `cpus × per_cpu` slots instead, every slot of
/// that many vCPUs, and is billed for them. While it waits for them, no
/// other job takes a slot, so jobs of one slot coming and going cannot
/// keep it waiting for good; one such job gathers at a time.
#[derive(Debug)]
pub struct Slots {
    total: usize,
    per_cpu: usize,
    state: Mutex<SlotState>,
    freed: Condvar,
}

#[derive(Debug, Default)]
struct SlotState {
    used: usize,
    /// A job waits for more than one slot: the others wait behind it.
    gathering: bool,
}

impl Slots {
    /// `total` slots, each a whole vCPU.
    pub fn new(total: usize) -> Self {
        Self::for_cpus(total, 1)
    }

    /// `cpus` vCPUs, each shared by `per_cpu` jobs.
    pub fn for_cpus(cpus: usize, per_cpu: usize) -> Self {
        let per_cpu = per_cpu.max(1);
        Self {
            total: cpus.max(1) * per_cpu,
            per_cpu,
            state: Mutex::new(SlotState::default()),
            freed: Condvar::new(),
        }
    }

    pub fn total(&self) -> usize {
        self.total
    }

    pub fn in_use(&self) -> usize {
        self.lock().used
    }

    pub fn free(&self) -> usize {
        self.total - self.in_use()
    }

    /// The whole vCPUs the slots are.
    pub fn cpus(&self) -> u32 {
        u32::try_from(self.total / self.per_cpu)
            .unwrap_or(u32::MAX)
            .max(1)
    }

    /// The vCPUs a job asking for `cpus` holds here: all of the runner's
    /// when it asks for more than there are.
    pub fn held_cpus(&self, cpus: u32) -> u32 {
        cpus.clamp(1, self.cpus())
    }

    /// The slots a job holds: one, or every slot of its `cpus:`.
    pub fn for_job(&self, cpus: Option<u32>) -> usize {
        match cpus {
            None => 1,
            Some(n) => self.held_cpus(n) as usize * self.per_cpu,
        }
    }

    fn lock(&self) -> MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether a job waits to gather slots of its own.
    #[cfg(test)]
    pub(crate) fn gathering(&self) -> bool {
        self.lock().gathering
    }

    /// Waits for `n` slots (at most all of them).
    pub fn acquire(self: &Arc<Self>, n: usize) -> SlotGuard {
        let n = n.clamp(1, self.total);
        let mut state = self.lock();
        while state.gathering || (n == 1 && state.used >= self.total) {
            state = self.freed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        if state.used + n > self.total {
            // More than one slot, not free yet: the slots that come back
            // are this job's, so no job of one slot can keep it waiting.
            state.gathering = true;
            while state.used + n > self.total {
                state = self.freed.wait(state).unwrap_or_else(|e| e.into_inner());
            }
            state.gathering = false;
            // Whoever waited behind it looks again.
            self.freed.notify_all();
        }
        state.used += n;
        SlotGuard {
            slots: self.clone(),
            held: n,
        }
    }

    /// `n` slots (at most all of them) if they are free now and no job
    /// waits to gather slots of its own.
    pub fn try_acquire(self: &Arc<Self>, n: usize) -> Option<SlotGuard> {
        let n = n.clamp(1, self.total);
        let mut state = self.lock();
        if state.gathering || state.used + n > self.total {
            return None;
        }
        state.used += n;
        Some(SlotGuard {
            slots: self.clone(),
            held: n,
        })
    }
}

/// Held slots, given back on drop.
#[derive(Debug)]
pub struct SlotGuard {
    slots: Arc<Slots>,
    held: usize,
}

impl SlotGuard {
    /// How many slots it holds.
    pub fn held(&self) -> usize {
        self.held
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.slots.lock().used -= self.held;
        // Every waiter: a job gathering slots wants more than the one a
        // single wake would hand on.
        self.slots.freed.notify_all();
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
    /// The modes saved with them ([`iwci_vfs::JobFs::modes_of`]).
    pub modes: iwci_vfs::archive::ModeList,
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
    /// Saves `entries` and the modes recorded for their paths under `key`.
    fn save_with_modes(
        &self,
        key: &str,
        restore_keys: &[String],
        entries: &[iwci_vfs::Entry],
        modes: &[(std::path::PathBuf, u32)],
    ) -> Result<(), String>;
    /// Whether an entry is saved under exactly `key` where this run saves.
    fn has(&self, _key: &str) -> bool {
        false
    }
    /// Claims `key` for a save this job is about to make: `false` while
    /// another job of this runner is saving it, so the same files are not
    /// compressed and uploaded twice at once. The save releases it.
    fn claim(&self, _key: &str) -> bool {
        true
    }
    /// Saves `entries` with no modes (the durations record, tests).
    fn save(
        &self,
        key: &str,
        restore_keys: &[String],
        entries: &[iwci_vfs::Entry],
    ) -> Result<(), String> {
        self.save_with_modes(key, restore_keys, entries, &[])
    }
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
        // The clone's `.git` names the commit, so any glob that reached it
        // would change the key on every commit.
        for path in snapshot.list_files_skipping(root, |name| name == ".git") {
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
/// # Admitting by estimate
///
/// Jobs hold a sixth to a quarter of their `memory:` (a Node job's heaps
/// are charged for the room they may grow to, and a suite is sized for its
/// worst file), so a budget that reserves `memory:` queues jobs behind
/// memory nothing uses. A budget made with
/// [`MemoryBudget::admitting_by_estimate`] reserves instead what the job
/// is expected to hold: what it held the last times it ran
/// ([`JobReport::held_memory_mib`]) and half as much again
/// ([`estimated_reserve`]), never more than its `memory:`. A job with no
/// history reserves its `memory:`. Nothing about the job changes: it is
/// held to its `memory:` as before.
///
/// A job that comes to hold more than it reserved has its reservation
/// raised at once, to what it holds and a quarter more
/// ([`MemoryBudget::top_up`]), whether or not the budget has it: the job
/// is not paused. Pausing it would free nothing (it keeps what it holds),
/// would run its timeout and its stall check down while it did no work,
/// and has to happen where memory is asked for, inside a program growing
/// its memory or V8 collecting garbage, where a thread cannot wait; and
/// jobs that all passed their estimates together would each wait for the
/// others. So the budget goes over instead, and since it counts what was
/// taken, no job starts until enough have ended to bring it back under.
/// How far over it can go is bounded by the running jobs' `memory:`.
///
/// What the estimates cannot see is covered from the other side: no job
/// starts while the host is short of memory ([`Pressure`]), unless nothing
/// is running at all, so that a run always gets on.
///
/// One budget is shared by every run in the process (`iwci serve`), so a
/// run's queued job may be waiting for memory another run holds. Every run
/// using the budget is woken whenever any of them gives memory back.
///
/// Which of a run's ready jobs gets memory is [`MemoryBudget::admit`]'s to
/// say: the first in [`Rank`] order, and one behind it only when that does
/// not keep the first waiting.
#[derive(Debug)]
pub struct MemoryBudget {
    total: u64,
    used: AtomicU64,
    /// What running jobs hold and when each is expected to give it back,
    /// every run's together.
    leases: Mutex<Leases>,
    /// The memory asked for by jobs that are ready but not started, for
    /// `/v1/capacity`'s `memory_waiting`: the work a runner has admitted
    /// beyond what it holds.
    waiting: AtomicU64,
    /// The runs to wake when memory is given back.
    waiters: Mutex<Vec<Weak<Wake>>>,
    /// Why no job gets memory any more, once [`MemoryBudget::hold`] says.
    held: std::sync::OnceLock<String>,
    /// Set when jobs reserve what they are expected to hold rather than
    /// their `memory:`: what says the host is short of memory.
    estimates: Option<Arc<dyn Pressure>>,
}

/// Whether the host is short of memory, whatever a [`MemoryBudget`] has
/// lent: its available memory is low, or its programs are stalling on
/// memory. Read before a job is admitted by estimate.
pub trait Pressure: Send + Sync + std::fmt::Debug {
    fn short(&self) -> bool;
}

/// The least a job admitted by estimate reserves. A job holds more than
/// its report counts (its threads' stacks, its share of the runner's own
/// bookkeeping), and a job that held next to nothing last time is the one
/// whose estimate says least.
pub const MIN_RESERVE: u64 = 256 << 20;

/// What a job that held `held` bytes the last times it ran reserves when
/// the budget admits by estimate: half as much again, and at least
/// [`MIN_RESERVE`]. With every estimate right, jobs then hold two thirds
/// of what is reserved, which leaves a third of the budget for the ones
/// that are wrong before the budget has to go over.
pub fn estimated_reserve(held: u64) -> u64 {
    held.saturating_add(held / 2).max(MIN_RESERVE)
}

/// What to remember a job held, in MiB, given what was remembered and what
/// it held this time: this time's when that is more, and otherwise a
/// quarter of the way down to it. One light run (a suite that skipped its
/// slow files, a job that failed early) then does not lower what the next
/// run reserves by much, and a job that really shrank is believed over a
/// few runs.
pub fn remembered(before: u64, now: u64) -> u64 {
    if now >= before {
        now
    } else {
        before - (before - now) / 4
    }
}

impl MemoryBudget {
    pub fn new(total: u64) -> Self {
        Self {
            total,
            used: AtomicU64::new(0),
            leases: Mutex::default(),
            waiting: AtomicU64::new(0),
            waiters: Mutex::default(),
            held: std::sync::OnceLock::new(),
            estimates: None,
        }
    }

    /// A budget that admits jobs by what they are expected to hold (see
    /// the type), and starts none while `pressure` says the host is short
    /// of memory.
    pub fn admitting_by_estimate(mut self, pressure: Arc<dyn Pressure>) -> Self {
        self.estimates = Some(pressure);
        self
    }

    /// Whether jobs reserve what they are expected to hold.
    pub fn by_estimate(&self) -> bool {
        self.estimates.is_some()
    }

    /// Whether the host is short of memory, when the budget admits by
    /// estimate and so asks.
    pub fn short(&self) -> Option<bool> {
        self.estimates.as_ref().map(|p| p.short())
    }

    /// What a job with this `memory:` reserves, given what it is
    /// remembered to have held (in MiB), if anything is.
    fn reserve(&self, limit: u64, held_mib: Option<u64>) -> u64 {
        match held_mib {
            Some(mib) if self.by_estimate() => estimated_reserve(mib << 20).min(limit),
            _ => limit,
        }
    }

    /// Lends no more memory: every run sharing the budget starts no more
    /// jobs and reports the ones it has not started as cancelled, saying
    /// `reason`, while the jobs running go on. A server that has to restart
    /// holds it, so that its drain ends with the jobs running then, not
    /// with every job of every run it had admitted (#1135). The first
    /// reason is kept.
    pub fn hold(&self, reason: &str) {
        let _ = self.held.set(reason.to_string());
        self.wake_all();
    }

    /// Why the budget lends no more memory, once it is held.
    pub fn held(&self) -> Option<&str> {
        self.held.get().map(String::as_str)
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn used(&self) -> u64 {
        self.used.load(Ordering::SeqCst)
    }

    /// What the jobs queued in every run sharing the budget ask for (what
    /// each would reserve): ready to start, waiting for memory (or for one
    /// of their run's workers).
    pub fn waiting(&self) -> u64 {
        self.waiting.load(Ordering::SeqCst)
    }

    /// Takes `bytes` if they fit. Nothing says when they come back, so
    /// [`MemoryBudget::admit`] never counts on them.
    pub fn try_take(&self, bytes: u64) -> bool {
        self.used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(bytes).filter(|&next| next <= self.total)
            })
            .is_ok()
    }

    /// Starts one of a run's ready jobs, given in the order they should
    /// start in: the first one if its memory fits, and otherwise a later
    /// one that fits and does not keep the first waiting.
    ///
    /// Taking simply the first that fits starves a large job: every time
    /// a small one finishes, another small one behind it in the order fits
    /// what came back and the large one does not, so it waits until
    /// enough jobs happen to finish together, however far ahead in the
    /// order it is. On a runner with 25 GiB one of the Test pipeline's
    /// 6 GiB jobs waited 32 to 35 s that way in five runs of eight, and
    /// when it was web's tests, the longest job, the run took 115 s, not
    /// 103 to 108.
    ///
    /// So the first job that does not fit gets a claim on the memory
    /// coming back. From when each running job is expected to finish (every
    /// run's, since they share the budget) there is a moment by which the
    /// first job fits, and an amount left over once it has started then. A
    /// job behind it starts only if it is expected to be done by that
    /// moment, or fits in what is left over: either way the first job
    /// starts when it would have with nothing behind it. Only the first job
    /// is protected, as in EASY backfilling, so the rest still fill the
    /// memory it cannot use.
    ///
    /// Memory taken with [`MemoryBudget::try_take`] has no expected end.
    /// When the first job waits on that, nothing here can say when it
    /// fits, and the jobs behind it start as they fit.
    ///
    /// A budget that admits by estimate starts nothing while the host is
    /// short of memory and a job is running: the running jobs hold more
    /// than was expected of them, or something else on the host does, and
    /// another job would only add to it. With nothing running the first
    /// job starts whatever the host says, since no job's end would bring
    /// the next look. A budget that has gone over (jobs topped up past it)
    /// starts nothing either, until enough jobs have ended.
    fn admit(&self, asks: impl IntoIterator<Item = Ask>) -> Admission {
        let mut leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let mut asks = asks.into_iter().enumerate();
        let Some((_, first)) = asks.next() else {
            return Admission::Wait { held_back: false };
        };
        if !leases.running.is_empty() && self.short() == Some(true) {
            // Nothing wakes a run when the host has memory again.
            return Admission::Wait { held_back: true };
        }
        if let Some(lease) = self.lease(&mut leases, first, now, false) {
            return Admission::Start(0, lease);
        }
        let free = self.total.saturating_sub(self.used());
        let claim = leases.claim(now, free, first.bytes);
        let mut held_back = false;
        for (pos, ask) in asks {
            let allowed = claim.is_none_or(|(by, spare)| {
                ask.bytes <= spare || now.checked_add(ask.expected).is_some_and(|end| end <= by)
            });
            if !allowed {
                held_back |= ask.bytes <= free;
                continue;
            }
            if let Some(lease) = self.lease(&mut leases, ask, now, false) {
                return Admission::Start(pos, lease);
            }
        }
        Admission::Wait { held_back }
    }

    fn lease(
        &self,
        leases: &mut Leases,
        ask: Ask,
        now: Instant,
        spare: bool,
    ) -> Option<Arc<Lease>> {
        if !self.try_take(ask.bytes) {
            return None;
        }
        leases.next += 1;
        leases.running.push(Running {
            id: leases.next,
            bytes: ask.bytes,
            taken: now,
            expected: ask.expected,
            spare,
        });
        Some(Arc::new(Lease {
            id: leases.next,
            limit: ask.limit.max(ask.bytes),
            bytes: AtomicU64::new(ask.bytes),
        }))
    }

    /// Raises a running job's reservation when it holds `held` bytes and
    /// that is within an eighth of what it reserved: to what it holds and
    /// a quarter more, never past its `memory:`. The memory is taken
    /// whether or not the budget has it (see the type for why the job is
    /// not made to wait), so the budget may go over; [`MemoryBudget::admit`]
    /// then starts nothing until it is back under. A job that reserved its
    /// `memory:` has nothing to raise.
    fn top_up(&self, lease: &Lease, held: u64) {
        let near = |reserved: u64| held.saturating_add(held / 8) > reserved;
        let reserved = lease.bytes.load(Ordering::SeqCst);
        if reserved >= lease.limit || !near(reserved) {
            return;
        }
        let mut leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
        // Its job may have ended meanwhile, and given back what it had.
        let Some(running) = leases.running.iter_mut().find(|r| r.id == lease.id) else {
            return;
        };
        let reserved = lease.bytes.load(Ordering::SeqCst);
        let want = held.saturating_add(held / 4).min(lease.limit);
        if want <= reserved {
            return;
        }
        lease.bytes.store(want, Ordering::SeqCst);
        running.bytes = want;
        self.used.fetch_add(want - reserved, Ordering::SeqCst);
    }

    /// Starts one of a helper's ready jobs, given in the order they should
    /// start in, from memory nothing else wants: the first that fits now,
    /// and none at all while a job of one of this runner's own runs waits.
    /// A helper's job is never owed memory as the first job of a run is
    /// in [`MemoryBudget::admit`], and its lease counts there as memory
    /// that is back already: it is given up the moment one of this
    /// runner's own runs wants it (`split::reclaim_memory`), so a run's
    /// first job must not be passed over on the strength of it.
    ///
    /// Nor does it start while the host is short of memory, when the
    /// budget admits by estimate and so asks: with a job running, as in
    /// `admit`, and with none as well, since a helper's job is one this
    /// runner need not run at all.
    fn admit_spare(&self, asks: impl IntoIterator<Item = Ask>) -> Option<(usize, Arc<Lease>)> {
        let mut leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
        if self.waiting() > 0 || self.short() == Some(true) {
            return None;
        }
        let now = Instant::now();
        asks.into_iter()
            .enumerate()
            .find_map(|(pos, ask)| Some((pos, self.lease(&mut leases, ask, now, true)?)))
    }

    /// Gives a finished job's memory back and wakes every run waiting.
    ///
    /// The lease leaves the running list and its bytes leave `used` under
    /// the one lock [`MemoryBudget::admit`] reads both under. Given back
    /// after the lock was let go, a run that looked in between saw memory
    /// held that no running job would give back, so nothing protected the
    /// first job in its order and a smaller one behind it started instead.
    fn release(&self, lease: &Lease) {
        {
            let mut leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
            leases.running.retain(|r| r.id != lease.id);
            // Read under the lock a top-up holds, so none is lost.
            self.take_back(lease.bytes.load(Ordering::SeqCst));
        }
        self.wake_all();
    }

    /// Gives `bytes` back and wakes every run waiting for memory.
    pub fn give(&self, bytes: u64) {
        self.take_back(bytes);
        self.wake_all();
    }

    fn take_back(&self, bytes: u64) {
        let _ = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                Some(used.saturating_sub(bytes))
            });
    }

    fn wake_all(&self) {
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

/// A ready job asking [`MemoryBudget::admit`] for its memory.
#[derive(Debug, Clone, Copy)]
struct Ask {
    /// What it reserves: its `memory:`, or less when the budget admits by
    /// estimate ([`MemoryBudget::reserve`]).
    bytes: u64,
    /// Its `memory:`, the most its reservation is raised to.
    limit: u64,
    /// How long it is expected to hold them.
    expected: Duration,
}

/// What [`MemoryBudget::admit`] decided.
#[derive(Debug)]
enum Admission {
    /// The ask at this position starts, holding the lease until it ends.
    Start(usize, Arc<Lease>),
    /// Nothing starts now. `held_back` when a job that fits was kept
    /// waiting for the first one: time alone may let it start (the first
    /// job's moment moves as running jobs outlast what was expected of
    /// them), so the run looks again without waiting to be woken. Also
    /// when the host was short of memory, which ends without a wake.
    Wait { held_back: bool },
}

/// A running job's memory, to give back with [`MemoryBudget::release`].
#[derive(Debug)]
struct Lease {
    id: u64,
    /// The job's `memory:`.
    limit: u64,
    /// What it has reserved: what it asked for, and whatever
    /// [`MemoryBudget::top_up`] added since.
    bytes: AtomicU64,
}

/// What a running job holds, which its reservation follows when the budget
/// admitted it by estimate: its programs' memory, as the runtime reports
/// each new most of it, and its files, as it writes them. Each counts at
/// its own peak, as in the job's report.
#[derive(Debug)]
struct Gauge {
    budget: Arc<MemoryBudget>,
    lease: Arc<Lease>,
    program: AtomicU64,
    files: AtomicU64,
}

impl Gauge {
    fn program(&self, bytes: u64) {
        self.program.fetch_max(bytes, Ordering::SeqCst);
        self.settle();
    }

    fn files(&self, bytes: u64) {
        self.files.fetch_max(bytes, Ordering::SeqCst);
        self.settle();
    }

    fn settle(&self) {
        let held = self
            .program
            .load(Ordering::SeqCst)
            .saturating_add(self.files.load(Ordering::SeqCst));
        self.budget.top_up(&self.lease, held);
    }
}

#[derive(Debug)]
struct Running {
    id: u64,
    bytes: u64,
    taken: Instant,
    expected: Duration,
    /// A helper's job, which gives its memory up as soon as one of this
    /// runner's own runs asks: as good as back now.
    spare: bool,
}

impl Running {
    /// When its memory is expected back. A job that has outlasted what
    /// was expected of it is expected to go on for as long again as it has
    /// overrun: its estimate was wrong (a job with no history counts as the
    /// median), and the longer it has been wrong the less it says.
    fn ends(&self, now: Instant) -> Instant {
        if self.spare {
            return now;
        }
        let elapsed = now.saturating_duration_since(self.taken);
        now + self.expected.abs_diff(elapsed)
    }
}

#[derive(Debug, Default)]
struct Leases {
    next: u64,
    running: Vec<Running>,
}

impl Leases {
    /// When a job asking for `need` is expected to fit, with `free` now
    /// and the running jobs giving theirs back as they end, and what is
    /// left over once it has started then. `None` when what is expected
    /// back never adds up to it.
    fn claim(&self, now: Instant, free: u64, need: u64) -> Option<(Instant, u64)> {
        let mut ends: Vec<(Instant, u64)> = self
            .running
            .iter()
            .map(|r| (r.ends(now), r.bytes))
            .collect();
        ends.sort_unstable();
        let mut have = free;
        ends.into_iter().find_map(|(at, bytes)| {
            have = have.saturating_add(bytes);
            (have >= need).then(|| (at, have - need))
        })
    }
}

/// How often a run that held a job back for another looks again (see
/// [`Admission::Wait`]).
const HELD_BACK_RECHECK: Duration = Duration::from_millis(500);

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
        self.wait_at_most(guard, state, seen, None)
    }

    /// [`Wake::wait`], giving up after `limit` when there is one.
    fn wait_at_most<'a, T>(
        &self,
        guard: MutexGuard<'a, T>,
        state: &'a Mutex<T>,
        seen: u64,
        limit: Option<Duration>,
    ) -> MutexGuard<'a, T> {
        drop(guard);
        let until = limit.map(|limit| Instant::now() + limit);
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        while *count == seen {
            match until {
                None => count = self.changed.wait(count).unwrap_or_else(|e| e.into_inner()),
                Some(until) => {
                    let left = until.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    count = self
                        .changed
                        .wait_timeout(count, left)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            }
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
    /// The most `used` has been, for the job's report.
    peak: AtomicU64,
    refused: AtomicBool,
    /// Told what the job's files come to, when its reservation follows
    /// what it holds.
    gauge: Option<Arc<Gauge>>,
    /// The most of the job's files kept in memory, when the rest spill to
    /// disk ([`Spill`]): what of `used` counts as memory.
    resident_cap: Option<u64>,
}

impl JobBudget {
    /// What of `bytes` of files is in memory.
    fn in_memory(&self, bytes: u64) -> u64 {
        self.resident_cap.map_or(bytes, |cap| bytes.min(cap))
    }
}

impl WriteBudget for JobBudget {
    fn take(&self, bytes: u64) -> bool {
        let taken = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(bytes).filter(|&next| next <= self.cap)
            });
        if let Ok(before) = taken {
            self.peak.fetch_max(before + bytes, Ordering::SeqCst);
            if let Some(gauge) = &self.gauge {
                gauge.files(self.in_memory(before + bytes));
            }
        }
        let ok = taken.is_ok();
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
    /// Some of what it, or a job it needed, kept is not on this runner
    /// (a split run), so nothing that needs it can run here.
    elsewhere: bool,
    /// It, or a job it needed, read a secret or was lent something: what
    /// it left (artifacts, outputs) may carry that, so a job handed it
    /// does not run on a helper and sends its own artifacts nowhere.
    tainted: bool,
}

/// Which ready job starts first: the one with the most work still ahead of
/// it on its longest chain of dependents, so the chain that decides when
/// the run ends is never left waiting behind jobs nothing depends on. Then
/// the one more jobs wait on, then plan order and matrix order, so the
/// order is the same every time for the same plan and history.
///
/// It only orders one run's own jobs. Runs sharing a runner still share
/// its slots and memory as before: a run with long chains does not take
/// slots from another.
///
/// The order holds when memory is short too: the first job in it that
/// does not fit the runner's budget is not passed over by jobs that would
/// keep it waiting ([`MemoryBudget::admit`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Rank {
    /// The job's own estimate plus the longest of its dependents'.
    remaining_ms: u64,
    /// Every job that waits on it, directly or through others.
    dependents: usize,
    plan_order: std::cmp::Reverse<usize>,
    entry: std::cmp::Reverse<usize>,
}

/// What a job of `ranks` is expected to take when the history has nothing
/// at all for the pipeline: every job alike, so the longest chain is the
/// one with the most jobs on it.
const UNKNOWN_DURATION_MS: u64 = 1000;

/// A key's place in the start order, and how long a job of it is expected
/// to take when the history has no time for that job itself.
#[derive(Debug, Clone, Copy)]
struct Place {
    rank: Rank,
    expected_ms: u64,
}

/// Each key's place in the start order (see [`Rank`]; `entry` is filled in
/// per matrix entry), from how long each job took last time.
///
/// A job without history is expected to take the median of those with, or
/// [`UNKNOWN_DURATION_MS`] when there is none. A matrix key is as long as
/// its longest entry, since its entries run side by side.
fn ranks(plan: &Plan, history: &HashMap<String, u64>) -> HashMap<String, Place> {
    let index: HashMap<&str, usize> = plan
        .jobs
        .iter()
        .enumerate()
        .map(|(i, t)| (t.key.as_str(), i))
        .collect();
    let recorded = |t: &JobTemplate| -> Option<u64> {
        let from_ids = match &t.instances {
            Some(jobs) => jobs
                .iter()
                .filter_map(|j| history.get(&j.id))
                .max()
                .copied(),
            // A matrix set by another job: whatever its entries were called
            // last time.
            None => {
                let prefix = format!("{}[", t.key);
                history
                    .iter()
                    .filter(|(id, _)| id.starts_with(&prefix))
                    .map(|(_, ms)| *ms)
                    .max()
            }
        };
        from_ids.or_else(|| history.get(&t.key).copied())
    };
    let known: Vec<Option<u64>> = plan.jobs.iter().map(recorded).collect();
    let mut sorted: Vec<u64> = known.iter().flatten().copied().collect();
    sorted.sort_unstable();
    let fallback = sorted
        .get(sorted.len() / 2)
        .copied()
        .unwrap_or(UNKNOWN_DURATION_MS);
    let estimate: Vec<u64> = known.iter().map(|k| k.unwrap_or(fallback)).collect();

    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); plan.jobs.len()];
    for (i, t) in plan.jobs.iter().enumerate() {
        for need in &t.needs {
            if let Some(&n) = index.get(need.as_str()) {
                dependents[n].push(i);
            }
        }
    }
    // Longest remaining path, dependents first. `needs` has no cycles once
    // validated; one that slipped through is cut where it closes.
    fn remaining(
        i: usize,
        dependents: &[Vec<usize>],
        estimate: &[u64],
        memo: &mut [Option<u64>],
        visiting: &mut [bool],
    ) -> u64 {
        if let Some(r) = memo[i] {
            return r;
        }
        if visiting[i] {
            return 0;
        }
        visiting[i] = true;
        let mut longest = 0;
        for &d in &dependents[i] {
            longest = longest.max(remaining(d, dependents, estimate, memo, visiting));
        }
        visiting[i] = false;
        let r = estimate[i].saturating_add(longest);
        memo[i] = Some(r);
        r
    }
    let mut memo = vec![None; plan.jobs.len()];
    let mut visiting = vec![false; plan.jobs.len()];
    let mut out = HashMap::with_capacity(plan.jobs.len());
    for (i, t) in plan.jobs.iter().enumerate() {
        let remaining_ms = remaining(i, &dependents, &estimate, &mut memo, &mut visiting);
        // Everything downstream, each once.
        let mut seen = vec![false; plan.jobs.len()];
        let mut stack = dependents[i].clone();
        let mut count = 0;
        while let Some(d) = stack.pop() {
            if !std::mem::replace(&mut seen[d], true) {
                count += 1;
                stack.extend(&dependents[d]);
            }
        }
        out.insert(
            t.key.clone(),
            Place {
                rank: Rank {
                    remaining_ms,
                    dependents: count,
                    plan_order: std::cmp::Reverse(i),
                    entry: std::cmp::Reverse(0),
                },
                expected_ms: estimate[i],
            },
        );
    }
    out
}

/// Puts `item` into `list`, which is kept in ascending [`Rank`] order so
/// that the job to start next is the last one.
fn enqueue<T>(list: &mut Vec<(Rank, T)>, rank: Rank, item: T) {
    let at = list.partition_point(|(r, _)| *r < rank);
    list.insert(at, (rank, item));
}

struct State<'p> {
    /// Keys not yet activated.
    waiting: Vec<&'p JobTemplate>,
    finished: HashMap<String, Finished>,
    /// Expanded `task-cache:` jobs whose entry has not been looked up yet,
    /// in [`Rank`] order, the next one last. A hit finishes from here;
    /// anything else moves on to `queue`.
    /// One that waited for another run comes back here with what it
    /// waited for.
    lookups: Vec<(Rank, LookupEntry<'p>)>,
    /// Expanded jobs ready to run, each with what its lookup left it, in
    /// [`Rank`] order, the next one last.
    queue: Vec<(Rank, (&'p JobTemplate, PlannedJob, Lookup))>,
    /// Where each key's jobs go in `lookups` and `queue`.
    ranks: HashMap<String, Place>,
    /// How long each job took the last time the pipeline ran, by job id.
    history: HashMap<String, u64>,
    /// What each job is remembered to have held, in MiB, by job id.
    held: HashMap<String, u64>,
    /// [`sandbox_need`] with the run's tools.
    sandbox: &'p (dyn Fn(&PlannedJob) -> Option<u64> + Sync),
    /// Cloud jobs ready to hand over: no slot and no memory.
    external: Vec<(&'p JobTemplate, PlannedJob)>,
    /// Per activated key: entries still running and the reports so far.
    /// Started templates: their instances' ids in matrix order, the reports
    /// of those finished so far, and the artifacts they kept.
    open: HashMap<String, OpenKey>,
    /// Jobs running and lookups in flight.
    running: usize,
    reports: HashMap<String, Vec<JobReport>>,
    /// Set by the worker threads when they stop, so the lookup threads do.
    done: bool,
    /// What `queue` asks of the runner's budget.
    queued: Queued,
    /// Jobs of a split run that another runner has, or may have, by id;
    /// counted in `running` until that runner says how they went.
    remote: HashMap<String, split::RemoteJob<'p>>,
    /// Remote jobs another runner finished, waiting to be read in; counted
    /// in `running`.
    arrived: Vec<split::RemoteJob<'p>>,
    /// The keys whose jobs read a secret or are lent something.
    secretive: HashSet<String>,
    /// Task-cached jobs that missed while another run computes the same
    /// key, waiting for its entry; counted in `running`.
    awaiting: Vec<inflight::Awaiting<'p>>,
}

/// A job on its way to a task cache lookup.
type LookupEntry<'p> = (&'p JobTemplate, PlannedJob, Option<Box<inflight::Waited>>);

impl<'p> State<'p> {
    fn enqueue(&mut self, rank: Rank, mut entry: (&'p JobTemplate, PlannedJob, Lookup)) {
        entry.2.queued = Some(Instant::now());
        // The job's own last time, which a matrix key's rank (its longest
        // entry) does not say.
        let expected_ms = self.history.get(&entry.1.id).copied().unwrap_or_else(|| {
            self.ranks
                .get(&entry.0.key)
                .map_or(UNKNOWN_DURATION_MS, |p| p.expected_ms)
        });
        entry.2.expected = Duration::from_millis(expected_ms);
        entry.2.history_ms = self.history.get(&entry.1.id).copied();
        // Its `memory:`, or what it is expected to hold when the budget
        // admits by that and the job has run before; and a sandbox's own,
        // which it holds whatever the job does.
        entry.2.sandbox = (self.sandbox)(&entry.1);
        let limit = entry.1.memory_bytes;
        let job = match &self.queued.budget {
            Some(budget) => budget.reserve(limit, self.held.get(&entry.1.id).copied()),
            None => limit,
        };
        entry.2.reserve = job.saturating_add(entry.2.sandbox.unwrap_or(0));
        self.queued.add(entry.2.reserve);
        enqueue(&mut self.queue, rank, entry);
    }

    fn dequeue(&mut self, pos: usize) -> (&'p JobTemplate, PlannedJob, Lookup) {
        let (_, entry) = self.queue.remove(pos);
        self.queued.remove(entry.2.reserve);
        entry
    }
}

/// A run's share of [`MemoryBudget::waiting`]: what its queued jobs ask
/// for. Whatever is left when the run ends (a worker that panicked) is
/// taken off then, so a runner never reports work it no longer has.
struct Queued {
    budget: Option<Arc<MemoryBudget>>,
    bytes: u64,
}

impl Queued {
    fn add(&mut self, bytes: u64) {
        self.bytes += bytes;
        if let Some(budget) = &self.budget {
            budget.waiting.fetch_add(bytes, Ordering::SeqCst);
        }
    }

    fn remove(&mut self, bytes: u64) {
        self.bytes -= bytes;
        if let Some(budget) = &self.budget {
            budget.waiting.fetch_sub(bytes, Ordering::SeqCst);
        }
    }
}

impl Drop for Queued {
    fn drop(&mut self) {
        let bytes = self.bytes;
        self.remove(bytes);
    }
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
    /// When the job joined the queue, for [`JobReport::queued_ms`].
    queued: Option<Instant>,
    /// How long the job is expected to run, set when it joins the queue,
    /// for [`MemoryBudget::admit`].
    expected: Duration,
    /// Taken back from another runner of a split run: it runs here
    /// whatever its claim says.
    local: bool,
    /// What the job reserves of the runner's budget, set when it joins
    /// the queue ([`MemoryBudget::reserve`]).
    reserve: u64,
    /// Its reservation once it has one, for its run to keep up to what
    /// the job holds ([`Gauge`]).
    lease: Option<Arc<Lease>>,
    /// What it reserves beyond its `memory:` for its sandbox, when it has
    /// one ([`sandbox_need`]). Such a job runs on this runner only.
    sandbox: Option<u64>,
    /// It waited for another run computing its key already: it does not
    /// wait again.
    waited: bool,
    /// How long it took last time, when it has run before, set when it
    /// joins the queue: what its marker tells a run that would wait.
    history_ms: Option<u64>,
    /// The run whose marker it waited on and that is gone: a marker of
    /// that run is taken over as the job starts.
    replacing: Option<String>,
}

/// How a task cache lookup went.
enum Looked {
    /// The job is finished: a hit, or a checkout that failed.
    Done(Box<JobReport>),
    /// A miss, or an entry that could not be used: the job runs.
    Run(Lookup),
    /// A miss while another run computes the same key: the job waits.
    Wait(Box<inflight::Waiting>),
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
            Name::Input { name } => ctx.inputs.get(name).cloned().unwrap_or_default(),
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
    let locks: Vec<LockIndexes> = plan.workspaces.iter().map(LockIndexes::new).collect();
    let before = options
        .durations
        .as_ref()
        .map(|d| d.load_history(&plan.name))
        .unwrap_or_default();
    // Shared with other runners, when the run is and the pipeline asks.
    let sharing = split::Sharing::of(plan, options);
    let sharing = sharing.as_ref();
    let helper = sharing.is_some_and(|s| s.helper);
    let history: HashMap<String, u64> = before
        .durations
        .iter()
        .map(|(id, ms)| (id.clone(), *ms))
        .collect();
    // A virtual machine is reserved like a sandbox: its own overhead on
    // top of the job's `memory:`, and it stays with the runner that has
    // the run.
    let sandbox = |job: &PlannedJob| match &job.vm {
        Some(vm) => Some(options.machines.as_ref().map_or(0, |m| m.overhead(vm.os))),
        None => sandbox_need(tools, job),
    };
    let state = Mutex::new(State {
        sandbox: &sandbox,
        waiting: plan.jobs.iter().collect(),
        finished: HashMap::new(),
        lookups: Vec::new(),
        queue: Vec::new(),
        external: Vec::new(),
        ranks: ranks(plan, &history),
        history,
        held: before
            .held
            .iter()
            .map(|(id, mib)| (id.clone(), *mib))
            .collect(),
        open: HashMap::new(),
        running: 0,
        reports: HashMap::new(),
        done: false,
        queued: Queued {
            // What a helper has queued is not work this runner has taken
            // on: it starts only what its own runs leave room for.
            budget: options.memory.clone().filter(|_| !helper),
            bytes: 0,
        },
        remote: HashMap::new(),
        arrived: Vec::new(),
        secretive: HashSet::new(),
        awaiting: Vec::new(),
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
    // In a split run every runner keeps its own and sends the others what
    // its jobs write (`schedule_scratch.rs`).
    let scratch = Scratch::new(
        iwci_vfs::SnapshotBuilder::new()
            .freeze()
            .fork_limited(Arc::new(JobBudget {
                cap: plan.scratch_bytes,
                used: AtomicU64::new(0),
                peak: AtomicU64::new(0),
                refused: AtomicBool::new(false),
                gauge: None,
                resident_cap: None,
            })),
        sharing.is_some(),
    );
    let lent_values = options.access.lent.secret_values();
    let mask = Arc::new(Masker::new(
        options
            .secrets
            .values()
            .chain(lent_values.iter())
            .chain(options.remote_cache.iter().map(|r| &r.token)),
    ));
    let artifact_bytes = AtomicU64::new(0);
    let measured = Mutex::new(History::default());
    let shared = RunShared {
        scratch: &scratch,
        mask: &mask,
        artifact_bytes: &artifact_bytes,
        measured: &measured,
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
                    let (rank, template, job, waited, inherited) = {
                        let mut s = state.lock().unwrap();
                        loop {
                            let seen = wake.seen();
                            if let Some((rank, (template, job, waited))) = s.lookups.pop() {
                                s.running += 1;
                                let inherited =
                                    inherited_artifacts(plan, &template.key, &s.finished);
                                break (rank, template, job, waited, inherited);
                            }
                            if s.done {
                                return;
                            }
                            s = wake.wait(s, &state, seen);
                        }
                    };
                    if options.cancelled() {
                        let report = cancelled_report(&job, options.cancel_reason());
                        complete(&state, &wake, plan, options, template, report, Vec::new());
                        continue;
                    }
                    let workspace = LazyWorkspace {
                        spec: &plan.workspaces[job.workspace],
                        workspaces,
                        built: &built[job.workspace],
                        checkout: &checkouts[job.workspace],
                        locks: &locks[job.workspace],
                    };
                    let mut kept = Vec::new();
                    let looked = match waited {
                        // Back from waiting for another run: its entry.
                        Some(waited) => {
                            inflight::look_again(&job, plan, options, &shared, *waited, &mut kept)
                        }
                        None => look_up(
                            &job, plan, &workspace, tools, options, &shared, &inherited, &mut kept,
                        ),
                    };
                    match looked {
                        // A helper that could not even key the job says
                        // nothing about it: the primary's word is awaited.
                        Looked::Done(report) if helper && !report.cached => {
                            let mut s = state.lock().unwrap();
                            split::defer(
                                &mut s,
                                options,
                                split::RemoteJob {
                                    template,
                                    job,
                                    lookup: Lookup::default(),
                                    rank,
                                    holder: None,
                                    since: Instant::now(),
                                },
                            );
                        }
                        Looked::Done(report) => {
                            // A hit for a job a helper of this run ran is
                            // that helper's: its record says how it went.
                            let elsewhere = report
                                .cached
                                .then(|| sharing.and_then(|sh| sh.ran_elsewhere(&job)))
                                .flatten();
                            if let Some(holder) = elsewhere {
                                let mut s = state.lock().unwrap();
                                split::defer(
                                    &mut s,
                                    options,
                                    split::RemoteJob {
                                        template,
                                        job,
                                        lookup: Lookup::default(),
                                        rank,
                                        holder: Some(holder),
                                        since: Instant::now(),
                                    },
                                );
                            } else {
                                complete(&state, &wake, plan, options, template, *report, kept)
                            }
                        }
                        Looked::Run(lookup) => {
                            let mut s = state.lock().unwrap();
                            s.running -= 1;
                            s.enqueue(rank, (template, job, lookup));
                            drop(s);
                            wake.notify_all();
                        }
                        // Still counted in `running`, holding nothing else.
                        Looked::Wait(waiting) => {
                            let mut s = state.lock().unwrap();
                            inflight::wait(&mut s, options, template, job, rank, *waiting);
                            drop(s);
                            wake.notify_all();
                        }
                    }
                }
            });
        }
        // Jobs waiting for another run's task cache entry: one thread looks
        // at the store for all of them.
        if lookups && let Some(inflight) = options.inflight.as_deref() {
            scope.spawn(|| inflight::watch(inflight, &state, &wake, plan, options));
        }
        // A split run: one thread follows what the other runners write,
        // a few read in the jobs they finished, and a few the files they
        // wrote to `/tmp/workflow`. The first stops the last when it ends.
        if let Some(sharing) = sharing {
            scope.spawn(|| split::watch(sharing, &state, &wake, plan, options, &shared));
            for _ in 0..split::FETCHERS {
                scope.spawn(|| split::fetch(sharing, &state, &wake, plan, options, &shared));
            }
            for _ in 0..scratch::SCRATCH_FETCHERS {
                scope.spawn(|| scratch.fetch(sharing.split, plan.scratch_bytes));
            }
        }
        // Cloud jobs: each waits for its executor on a thread of its own,
        // with no slot and no memory, since nothing runs here.
        let cloud = plan.jobs.iter().any(|t| t.tool.is_cloud());
        for _ in 0..if cloud {
            crate::external::MAX_EXTERNAL
        } else {
            0
        } {
            scope.spawn(|| {
                loop {
                    let (template, job, inherited) = {
                        let mut s = state.lock().unwrap();
                        loop {
                            let seen = wake.seen();
                            if let Some((template, job)) = s.external.pop() {
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
                    let mut kept = Vec::new();
                    let report = if options.cancelled() {
                        cancelled_report(&job, options.cancel_reason())
                    } else {
                        run_external(&job, plan, options, &shared, inherited, &mut kept)
                    };
                    complete(&state, &wake, plan, options, template, report, kept);
                }
            });
        }
        for _ in 0..options.parallelism.max(1) {
            scope.spawn(|| {
                loop {
                    let (template, job, mut lookup, inherited, reserved, rank, slot, handed) = {
                        let mut s = state.lock().unwrap();
                        loop {
                            // Read before the budget is, so memory given
                            // back after this wakes the wait below.
                            let seen = wake.seen();
                            // The first job in `Rank` order when its memory
                            // fits the runner's budget, or one behind it that
                            // does not keep it waiting (`MemoryBudget::admit`);
                            // the reservation is held until it finishes.
                            // Without a budget, simply the first. A cancelled
                            // run's queued jobs, and every run's once the
                            // budget is held, are only reported, so they need
                            // no memory.
                            let mut held_back = false;
                            let cancelled = options.stopped().is_some();
                            // A helper's slot is taken with its job: it
                            // never waits for one.
                            let mut slot = None;
                            let fits = match &options.memory {
                                _ if cancelled => {
                                    s.queue.len().checked_sub(1).map(|pos| (pos, None))
                                }
                                // A helper starts only what this runner's
                                // own runs leave room for, and is never
                                // owed memory as the first job of a run is.
                                _ if helper => sharing
                                    .and_then(|sh| split::spare(sh, options, &s.queue, &mut slot)),
                                Some(budget) => {
                                    let asks = s.queue.iter().rev().map(|(_, (_, j, l))| Ask {
                                        bytes: l.reserve,
                                        limit: j
                                            .memory_bytes
                                            .saturating_add(l.sandbox.unwrap_or(0)),
                                        expected: l.expected,
                                    });
                                    match budget.admit(asks) {
                                        Admission::Start(nth, lease) => {
                                            Some((s.queue.len() - 1 - nth, Some(lease)))
                                        }
                                        Admission::Wait { held_back: held } => {
                                            held_back = held;
                                            None
                                        }
                                    }
                                }
                                None => s.queue.len().checked_sub(1).map(|pos| (pos, None)),
                            };
                            if let Some((pos, reserved)) = fits {
                                let rank = s.queue[pos].0;
                                let (template, job, lookup) = s.dequeue(pos);
                                s.running += 1;
                                let inherited =
                                    inherited_artifacts(plan, &template.key, &s.finished);
                                // Whether it starts with what a job that
                                // read a secret left.
                                let handed = template
                                    .needs
                                    .iter()
                                    .any(|n| s.finished.get(n).is_some_and(|f| f.tainted));
                                break (
                                    template, job, lookup, inherited, reserved, rank, slot, handed,
                                );
                            }
                            if !cancelled && !helper {
                                // Memory a helper job holds comes back for
                                // this runner's own run.
                                split::reclaim_memory(options, &s.queue);
                            }
                            if s.running == 0
                                && s.lookups.is_empty()
                                && s.queue.is_empty()
                                && s.external.is_empty()
                            {
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
                            // some back or holds it. A job that can never
                            // fit was turned away when it was activated.
                            // A job held back for the first in the order may
                            // start with time alone, so that is looked at
                            // again before long. A helper with jobs queued
                            // looks again by itself too: room its own runs
                            // leave wakes nobody.
                            let limit = if helper && !s.queue.is_empty() {
                                Some(split::SPARE_RECHECK)
                            } else {
                                held_back.then_some(HELD_BACK_RECHECK)
                            };
                            s = wake.wait_at_most(s, &state, seen, limit);
                        }
                    };
                    if let Some(reason) = options.stopped() {
                        if let (Some(lease), Some(budget)) = (&reserved, &options.memory) {
                            budget.release(lease);
                        }
                        let report = cancelled_report(&job, reason);
                        complete(&state, &wake, plan, options, template, report, Vec::new());
                        continue;
                    }
                    // Saved by another run while it queued: replayed, and
                    // what it was about to start with given back. Not in a
                    // split run, whose other runner's jobs are in the task
                    // cache too and come in through their claims.
                    let mut replayed = Vec::new();
                    if sharing.is_none()
                        && let Some(report) = inflight::landed_meanwhile(
                            &job,
                            plan,
                            options,
                            &shared,
                            &lookup,
                            &mut replayed,
                        )
                    {
                        drop(slot);
                        if let (Some(lease), Some(budget)) = (&reserved, &options.memory) {
                            budget.release(lease);
                        }
                        complete(&state, &wake, plan, options, template, report, replayed);
                        continue;
                    }
                    // Another run computing the same task cache key: this
                    // job waits for its entry instead, giving back the
                    // memory (and a helper's slot) it was about to start
                    // with. Otherwise this run's marker says it computes it.
                    let marker = match inflight::begin(options, &mut lookup) {
                        inflight::Begun::Run(marker) => marker,
                        inflight::Begun::Wait(holder) => {
                            drop(slot);
                            if let (Some(lease), Some(budget)) = (&reserved, &options.memory) {
                                budget.release(lease);
                            }
                            let waiting = inflight::Waiting {
                                key: lookup.key.clone().unwrap_or_default(),
                                holder,
                                lines: lookup.lines,
                            };
                            let mut s = state.lock().unwrap();
                            inflight::wait(&mut s, options, template, job, rank, waiting);
                            drop(s);
                            wake.notify_all();
                            continue;
                        }
                    };
                    // A helper's job can be stopped by itself, to give way,
                    // from the moment it holds a slot and memory.
                    let helped = helper
                        .then(|| {
                            split::helped(
                                options,
                                lookup.reserve,
                                slot.as_ref().map_or(1, SlotGuard::held),
                            )
                        })
                        .flatten();
                    // In a split run, whoever writes the job's claim runs
                    // it. A job another runner has stays in this run's
                    // graph until that runner says how it went.
                    if let Some(sharing) = sharing
                        && let Err(holder) = sharing.claim(&job, lookup.local)
                    {
                        // The runner that has the claim computes the key,
                        // unless its record says it is done already.
                        if let Some(marker) = marker {
                            let done = sharing.split.done(&job.id).ok().flatten().is_some();
                            marker.leave(done);
                        }
                        drop(helped);
                        drop(slot);
                        if let (Some(lease), Some(budget)) = (&reserved, &options.memory) {
                            budget.release(lease);
                        }
                        let mut s = state.lock().unwrap();
                        split::defer(
                            &mut s,
                            options,
                            split::RemoteJob {
                                template,
                                job,
                                lookup,
                                rank,
                                holder,
                                since: Instant::now(),
                            },
                        );
                        continue;
                    }
                    // Slots shared with every other run on this runner;
                    // held for the job's workspace build and its run: one,
                    // or those of its `cpus:`. One of this runner's own
                    // runs gets a helper job's.
                    let slot = slot.or_else(|| {
                        options
                            .slots
                            .as_ref()
                            .map(|slots| split::own_slot(options, slots, slots.for_job(job.cpus)))
                    });
                    // What it holds of its `cpus:`, which is what it is
                    // told it has and billed for: at most the runner's
                    // own vCPUs.
                    let mut job = job;
                    if let (Some(cpus), Some(slots)) = (job.cpus, &options.slots) {
                        job.cpus = Some(slots.held_cpus(cpus));
                    }
                    let cancel = helped
                        .as_ref()
                        .map(|h| h.cancel.clone())
                        .or_else(|| options.cancel.clone());
                    let queued_ms = lookup.queued.map_or(0, |at| millis(at.elapsed()));
                    let workspace = LazyWorkspace {
                        spec: &plan.workspaces[job.workspace],
                        workspaces,
                        built: &built[job.workspace],
                        checkout: &checkouts[job.workspace],
                        locks: &locks[job.workspace],
                    };
                    let mut kept = Vec::new();
                    let mut saved = None;
                    if let Some(sharing) = sharing {
                        sharing.running.fetch_add(1, Ordering::SeqCst);
                    }
                    lookup.lease = reserved.clone();
                    // `/tmp/workflow` as the job sees it. What a job whose
                    // files may carry a secret writes there never leaves
                    // this runner; a wait for another runner's file ends
                    // with the job.
                    let view = shared.scratch.view(
                        handed || !split::secret_free(&job),
                        cancel.clone(),
                        Some(
                            Instant::now()
                                + job.timeout.saturating_mul(2)
                                + Duration::from_secs(60),
                        ),
                    );
                    let began = millis(started.elapsed());
                    let mut report = run_job(
                        &job, plan, &workspace, tools, executor, committer, options, &shared,
                        &inherited, lookup, cancel, &mut kept, &mut saved, &view,
                    );
                    let ran = millis(started.elapsed());
                    report.queued_ms = queued_ms;
                    report.cpus = job.cpus;
                    if let Some(sharing) = sharing {
                        sharing.running.fetch_sub(1, Ordering::SeqCst);
                    }
                    drop(helped);
                    drop(slot);
                    if let (Some(lease), Some(budget)) = (&reserved, &options.memory) {
                        budget.release(lease);
                    }
                    // After its entry was saved, if it was: a run waiting
                    // for it reads the entry as soon as the marker goes.
                    let ended = inflight::ended(&report, saved.as_deref());
                    if let Some(sharing) = sharing {
                        // What it wrote to `/tmp/workflow`, for the jobs that
                        // need it on other runners.
                        let scratch = publish_scratch(sharing, &shared);
                        // A helper gives back a job whose files it could not
                        // send, one that wanted a file only the primary has,
                        // and any once it has dropped files unsent: the
                        // primary runs it with everything there.
                        let scratch_back = sharing.helper
                            && (scratch.is_err()
                                || view.withheld().is_some()
                                || view.kept_back()
                                || shared.scratch.spoiled());
                        if sharing.hands_back(&report) || scratch_back {
                            if let Some(marker) = marker {
                                marker.end(Ended::Stopped);
                            }
                            // Stopped, or not run at all: the primary
                            // takes it, and this run waits for its word.
                            sharing.hand_back(&job.id);
                            let mut s = state.lock().unwrap();
                            s.remote.insert(
                                job.id.clone(),
                                split::RemoteJob {
                                    template,
                                    job,
                                    lookup: Lookup::default(),
                                    rank,
                                    holder: None,
                                    since: Instant::now(),
                                },
                            );
                            continue;
                        }
                        sharing.publish(
                            &job,
                            &mut report,
                            &kept,
                            saved.as_deref(),
                            handed,
                            &mask,
                            scratch,
                        );
                    }
                    // Where a pipeline's time goes around its jobs, in the
                    // runner's log: from the pipeline's start.
                    eprintln!(
                        "iwci: pipeline {}: job {} queued {queued_ms} ms, ran from {began} to {ran} ms, reported at {} ms",
                        plan.name,
                        report.id,
                        millis(started.elapsed())
                    );
                    complete(&state, &wake, plan, options, template, report, kept);
                    // After its entry was saved, if it was, and after the
                    // jobs that need it here are on their way: a run
                    // waiting for it reads the entry once the marker goes,
                    // which happens in the background.
                    if let Some(marker) = marker {
                        marker.end(ended);
                    }
                }
            });
        }
    });

    let jobs_done = millis(started.elapsed());
    let mut state = state.into_inner().unwrap();
    let mut warnings: Vec<String> = Vec::new();
    let mut installs: Vec<String> = Vec::new();
    for ws in built.iter().filter_map(OnceLock::get).flatten() {
        warnings.extend(ws.warnings.iter().cloned());
        installs.extend(ws.installs.iter().cloned());
    }
    let jobs: Vec<JobReport> = plan
        .jobs
        .iter()
        .flat_map(|t| state.reports.remove(&t.key).unwrap_or_default())
        .collect();
    if let Some(durations) = &options.durations {
        let kept = merge_history(plan, &jobs, before, measured.into_inner().unwrap());
        if let Some(kept) = kept {
            durations.save_history(&plan.name, &kept);
        }
    }
    eprintln!(
        "iwci: pipeline {}: every job done at {jobs_done} ms, finished at {} ms",
        plan.name,
        millis(started.elapsed())
    );
    RunReport {
        pipeline: plan.name.clone(),
        jobs,
        warnings,
        installs,
        duration_ms: millis(started.elapsed()),
    }
}

/// What to keep for the next run's order and reservations: this run's
/// times over the ones read before it, and what its jobs held folded into
/// what was remembered ([`remembered`]), for the jobs the plan still has.
/// A job that did not run here (skipped, failed to start) keeps what it
/// had; a renamed or removed one is dropped. `None` when that is what is
/// kept already.
fn merge_history(
    plan: &Plan,
    reports: &[JobReport],
    before: History,
    measured: History,
) -> Option<History> {
    let mut ids: HashSet<&str> = reports.iter().map(|r| r.id.as_str()).collect();
    let mut dynamic = Vec::new();
    for t in &plan.jobs {
        ids.insert(&t.key);
        match &t.instances {
            Some(jobs) => ids.extend(jobs.iter().map(|j| j.id.as_str())),
            None => dynamic.push(format!("{}[", t.key)),
        }
    }
    let still = |id: &str| ids.contains(id) || dynamic.iter().any(|p| id.starts_with(p.as_str()));
    let keep = |map: &BTreeMap<String, u64>| -> BTreeMap<String, u64> {
        map.iter()
            .filter(|(id, _)| still(id))
            .map(|(id, n)| (id.clone(), *n))
            .collect()
    };
    let mut kept = History {
        durations: keep(&before.durations),
        held: keep(&before.held),
    };
    kept.durations.extend(measured.durations);
    for (id, mib) in measured.held {
        let was = kept.held.get(&id).copied().unwrap_or(0);
        kept.held.insert(id, remembered(was, mib));
    }
    (kept != before).then_some(kept)
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
    let sharing = split::Sharing::of(plan, options);
    let helper = sharing.as_ref().is_some_and(|s| s.helper);
    loop {
        let Some(pos) = s
            .waiting
            .iter()
            .position(|t| t.needs.iter().all(|n| s.finished.contains_key(n)))
        else {
            return;
        };
        let template = s.waiting.remove(pos);
        if let Some(reason) = options.stopped() {
            let report = key_report(
                template,
                Status::Cancelled {
                    reason: reason.into(),
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
            // A helper leaves a job too large for it to the primary.
            Ok(jobs)
                if !helper
                    && options.memory.as_ref().is_some_and(|b| {
                        jobs.iter().any(|j| {
                            j.memory_bytes.saturating_add((s.sandbox)(j).unwrap_or(0)) > b.total()
                        })
                    }) =>
            {
                let total = options.memory.as_ref().map_or(0, |b| b.total());
                let asks = jobs
                    .iter()
                    .map(|j| j.memory_bytes.saturating_add((s.sandbox)(j).unwrap_or(0)))
                    .max()
                    .unwrap_or(0);
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
                if jobs.iter().any(|j| !split::secret_free(j)) {
                    s.secretive.insert(template.key.clone());
                }
                let order = jobs.iter().map(|j| j.id.clone()).collect();
                s.open.insert(
                    template.key.clone(),
                    OpenKey {
                        order,
                        reports: Vec::new(),
                        artifacts: Vec::new(),
                    },
                );
                // Entries share their key's rank (`ranks` has every key of
                // the plan) and start in matrix order. Cloud jobs go to a
                // stack of their own, pushed in reverse for the same order.
                let rank = s.ranks[&template.key].rank;
                let mut cloud = Vec::new();
                for (i, job) in jobs.into_iter().enumerate() {
                    let rank = Rank {
                        entry: std::cmp::Reverse(i),
                        ..rank
                    };
                    // A job in a sandbox stays on the runner that has the
                    // run: a helper may not offer one. Nor one whose
                    // workspace runs install scripts, which takes a virtual
                    // machine the helper may not have.
                    if let Some(sharing) = sharing.as_ref().filter(|_| helper)
                        && (!split::runs_here(sharing, template, &job, &s.finished, options)
                            || (s.sandbox)(&job).is_some()
                            || plan.workspaces[job.workspace].install_scripts)
                    {
                        // Only the primary runs it; this run waits to hear
                        // how it went.
                        s.running += 1;
                        split::defer(
                            s,
                            options,
                            split::RemoteJob {
                                template,
                                job,
                                lookup: Lookup::default(),
                                rank,
                                holder: None,
                                since: Instant::now(),
                            },
                        );
                    } else if job.cloud.is_some() {
                        cloud.push((template, job));
                    } else if job.task_cache.is_some() && options.caches.is_some() {
                        enqueue(&mut s.lookups, rank, (template, job, None));
                    } else {
                        s.enqueue(rank, (template, job, Lookup::default()));
                    }
                }
                s.external.extend(cloud.into_iter().rev());
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
    let tainted = s.secretive.contains(&template.key)
        || template
            .needs
            .iter()
            .any(|n| s.finished.get(n).is_some_and(|f| f.tainted));
    let elsewhere = reports.iter().any(|r| r.elsewhere)
        || template
            .needs
            .iter()
            .any(|n| s.finished.get(n).is_some_and(|f| f.elsewhere));
    s.finished.insert(
        template.key.clone(),
        Finished {
            result,
            blocks,
            outputs,
            artifacts: Arc::new(artifacts),
            elsewhere,
            tainted,
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
        cpus: None,
        peak_memory_mib: 0,
        held_memory_mib: 0,
        queued_ms: 0,
        duration_ms: 0,
        blocks,
        cached: false,
        needs: template.needs.clone(),
        access: template.access.clone(),
        cloud: None,
        remote: None,
        waited_for: None,
        elsewhere: false,
    }
}

/// Sends what a job that just ended wrote to `/tmp/workflow`, a few times
/// if the store does not take it: this runner's layers that hold it, or
/// why it could not be sent. A helper that may send no more drops what
/// it has not sent.
fn publish_scratch(sharing: &split::Sharing<'_>, shared: &RunShared<'_>) -> Result<u64, String> {
    let mut last = String::new();
    for wait in [0u64, 50, 200] {
        std::thread::sleep(Duration::from_millis(wait));
        match shared
            .scratch
            .publish(sharing.split, shared.mask, sharing.scratch_cap)
        {
            Published::Nothing | Published::Layer(_) => return Ok(shared.scratch.layers()),
            Published::TooMuch => {
                shared.scratch.forget_unsent();
                sharing.unfit.store(true, Ordering::SeqCst);
                return Err(format!(
                    "more than the {} KiB this runner may send",
                    sharing.scratch_cap.div_ceil(1024)
                ));
            }
            Published::Failed(e) => last = e,
        }
    }
    Err(last)
}

/// What every job of one run shares.
struct RunShared<'a> {
    scratch: &'a Scratch,
    mask: &'a Arc<Masker>,
    /// Bytes of artifacts kept so far, held to the run's `scratch:` limit:
    /// both live in memory for the whole run.
    artifact_bytes: &'a AtomicU64,
    /// How long each job that ran took and what it held, by id, for
    /// [`Durations`]; a task cache hit counts as the run it replays.
    measured: &'a Mutex<History>,
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
#[allow(clippy::too_many_arguments)]
fn look_up<T: Tools>(
    job: &PlannedJob,
    plan: &Plan,
    workspace: &LazyWorkspace<'_>,
    tools: &T,
    options: &Options,
    shared: &RunShared<'_>,
    inherited: &[(String, Arc<Vec<Entry>>)],
    kept: &mut Vec<Entry>,
) -> Looked {
    let started = Instant::now();
    // What every tool and environment the job uses resolves to, by content.
    // One that does not resolve leaves the job unkeyed: it runs, fails at
    // the same resolution with the usual message, and saves nothing.
    let pins = match job_tools(job)
        .map(|t| tools.pin(t).map_err(|e| format!("{t}: {e}")))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(pins) => pins,
        Err(e) => {
            return Looked::Run(Lookup {
                key: None,
                lines: vec![format!("task cache: not read, {e}")],
                ..Lookup::default()
            });
        }
    };
    let key = match workspace.files() {
        Ok(files) => task_cache_key(job, plan, files, workspace.locks, &pins, inherited),
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
            ..Lookup::default()
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
        Ok(None) => {
            let line = format!("task cache `{}`: miss", short_key(&key));
            // Another run is computing it now: wait for its entry.
            if let Some(holder) = inflight::holder(options, &key) {
                return Looked::Wait(Box::new(inflight::Waiting {
                    key,
                    holder,
                    lines: vec![line],
                }));
            }
            lines.push(line)
        }
        Err(e) => lines.push(format!(
            "task cache `{}`: could not read the cache ({e}); running it",
            short_key(&key)
        )),
    }
    Looked::Run(Lookup {
        key: Some(key),
        lines,
        ..Lookup::default()
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
    cancel: Option<iwci_runtime::Cancel>,
    kept: &mut Vec<Entry>,
    saved_key: &mut Option<String>,
    scratch: &ScratchView,
) -> JobReport {
    let started = Instant::now();
    // The task cache was looked up before the job was queued (`look_up`);
    // it is not read again here, only saved to after a pass.
    let Lookup {
        key: task_key,
        lines: task_lines,
        lease,
        ..
    } = lookup;
    // What follows the job's memory when it reserved less than its
    // `memory:` (see [`MemoryBudget`]).
    let gauge = match (lease, &options.memory) {
        (Some(lease), Some(budget)) => Some(Arc::new(Gauge {
            budget: budget.clone(),
            lease,
            program: AtomicU64::new(0),
            files: AtomicU64::new(0),
        })),
        _ => None,
    };
    // What the app lent the job, checked before anything is built: a name
    // it did not supply, or refused, fails the job with the reason.
    let lent = match crate::lent::for_job(
        &options.access.lent,
        &job.access,
        options.access.trusted,
        &options.secrets,
        crate::runner::now_secs(),
        job.timeout,
    ) {
        Ok(lent) => lent,
        Err(reason) => return refused(job, shared.mask.mask(&reason), started.elapsed()),
    };
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
    // A job in a virtual machine has no tool on the runner: the machine's
    // image is its environment. A runner without such machines fails it
    // before anything is built for it.
    let tool = match &job.vm {
        Some(vm) => {
            if !options
                .machines
                .as_ref()
                .is_some_and(|m| m.platforms().contains(&vm.os))
            {
                return errored(job, crate::machines::missing(vm.os), started.elapsed());
            }
            None
        }
        None => match tools.resolve(&job.tool) {
            Ok(t) => Some(t),
            Err(e) => return errored(job, format!("{}: {e}", job.tool), started.elapsed()),
        },
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
    // way past any limit. With a spill directory (`--spill-disk`), only half
    // its `memory:` of them stays in memory, the least recently used
    // beyond that move to the runner's disk, and what it writes is held to
    // the disk allowance instead.
    let resident_cap = options.spill.as_ref().map(|_| job.memory_bytes / 2);
    let write_budget = Arc::new(JobBudget {
        cap: options.spill.as_ref().map_or(job.memory_bytes, |spill| {
            spill.disk_bytes.max(job.memory_bytes)
        }),
        used: AtomicU64::new(0),
        peak: AtomicU64::new(0),
        refused: AtomicBool::new(false),
        gauge: gauge.clone(),
        resident_cap,
    });
    let fs = match (&options.spill, resident_cap) {
        (Some(spill), Some(resident_max)) => workspace.snapshot.fork_spilling(
            write_budget.clone(),
            iwci_vfs::SpillConfig {
                dir: spill.dir.clone(),
                resident_max,
            },
        ),
        _ => workspace.snapshot.fork_limited(write_budget.clone()),
    };
    if let Err(e) = fs.create_for_job(OUTPUT_PATH) {
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
        let (entries, modes) = artifact_modes(entries);
        if let Err(e) = fs.apply(&entries) {
            return errored(
                job,
                format!("could not write the artifacts of `{from}`: {e}"),
                started.elapsed(),
            );
        }
        let job_modes = fs.modes();
        for (path, mode) in &modes {
            job_modes.set(path, *mode);
        }
        let files = entries
            .iter()
            .filter(|e| matches!(e, Entry::File { .. }))
            .count();
        artifact_notes.push(format!("artifacts: {files} file(s) from `{from}`"));
        restored.extend(entries.iter().map(|e| entry_path(e).to_path_buf()));
    }

    // Lent files: in this job's file system only, with their modes. They
    // are the job's inputs, never its changes, artifacts, downloads or
    // cache entries, and never inside the clone, where a commit could
    // take them.
    let mut lent_paths: HashSet<PathBuf> = HashSet::new();
    for (path, mode, data) in &lent.files {
        if let Some(root) = &root
            && path.starts_with(root)
        {
            return refused(
                job,
                format!(
                    "the lent file `{}` would be inside the clone ({root}), where it could be committed or kept",
                    path.display()
                ),
                started.elapsed(),
            );
        }
        let new_parent = path
            .parent()
            .filter(|p| *p != std::path::Path::new("/") && !workspace.snapshot.is_dir(p));
        if let Err(e) = fs.write(path, data) {
            return errored(
                job,
                format!("could not write the lent file `{}`: {e}", path.display()),
                started.elapsed(),
            );
        }
        let modes = fs.modes();
        modes.set(path, *mode);
        if let Some(parent) = new_parent {
            // A directory made for it (`~/.ssh`) is the job's alone, as
            // OpenSSH wants it.
            modes.set(parent, 0o700);
        }
        lent_paths.insert(path.clone());
        restored.insert(path.clone());
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
        let restoring = Instant::now();
        match options
            .caches
            .as_ref()
            .map(|c| c.restore(&key, &restore_keys, job.memory_bytes))
        {
            None => {}
            Some(Ok(Some(restored))) => match fs.apply(&restored.entries) {
                Ok(()) => {
                    fs.apply_modes(&restored.modes);
                    fs.set_restored_times(&restored.entries);
                    exact = restored.exact;
                    let took = seconds(restoring.elapsed());
                    cache_lines.push(if restored.exact {
                        format!("cache `{key}`: restored in {took}")
                    } else {
                        format!("cache `{key}`: restored `{}` in {took}", restored.key)
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
        // An entry under the exact key that did not restore (a runner of
        // another archive format wrote it) is one this job's save replaces;
        // otherwise an entry there at save time is a sibling's (below).
        let unreadable = !exact && options.caches.as_ref().is_some_and(|c| c.has(&key));
        cache_keys.push((key, restore_keys, exact, unreadable, cache.paths.clone()));
    }
    // The environment's own caches, which `env-cache:` can turn off: an
    // isolate's environment's, or a machine image's.
    let env_decls = match (&job.vm, &options.machines, &tool) {
        (Some(vm), Some(machines), _) => machines.env_caches(vm.os),
        (None, _, Some(tool)) => tools.env_caches(tool),
        _ => Vec::new(),
    };
    let env_caches: Vec<crate::env_cache::Active> = match &options.caches {
        Some(store) => env_decls
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
        _ => Vec::new(),
    };

    let mut env = options.base_env.clone();
    env.push(("IWCI_JOB".into(), job.id.clone()));
    env.push(("IWCI_OUTPUT".into(), OUTPUT_PATH.into()));
    env.push(("IWCI_SCRATCH".into(), iwci_spec::SCRATCH_PATH.into()));
    if let Some(cpus) = job.cpus {
        env.push(("IWCI_CPUS".into(), cpus.to_string()));
    }
    merge_env(&mut env, &workspace.env);
    merge_env(&mut env, &lent.env);
    merge_env(&mut env, &job.env);
    // Secrets last, read now so they are never part of the plan. A secret
    // the run does not have reads as empty, and the report says which; a
    // resource it was not lent fails the job.
    let mut notes = artifact_notes;
    notes.extend(lent.notes.iter().cloned());
    let mut secret_vars = Vec::new();
    for entry in &job.secret_env {
        let filled = entry.fill(
            |name| options.secrets.get(name).cloned(),
            |name, output| options.access.lent.output(name, output),
        );
        let (value, missing) = match filled {
            Ok(filled) => filled,
            Err(reason) => return refused(job, shared.mask.mask(&reason), started.elapsed()),
        };
        for name in missing {
            notes.push(format!(
                "secret `{name}` is not set for this run, so `{}` has it empty",
                entry.key
            ));
        }
        secret_vars.push((entry.key.clone(), value));
    }
    merge_env(&mut env, &secret_vars);
    // The runner's remote cache, which only a job with a network reaches.
    if let Some(cache) = &options.remote_cache
        && job.network
    {
        cache.add_to(&mut env);
    }

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
            let filled = entry.fill(
                |name| options.secrets.get(name).cloned(),
                |name, output| options.access.lent.output(name, output),
            );
            let (value, missing) = match filled {
                Ok(filled) => filled,
                Err(reason) => return refused(job, shared.mask.mask(&reason), started.elapsed()),
            };
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
    let executed = match (&job.vm, &tool, &options.machines) {
        (Some(vm), _, Some(machines)) => machines.run(crate::machines::MachineRun {
            job,
            vm,
            workspace: &workspace.snapshot,
            workspace_key: format!(
                "{}:{}",
                plan.context().commit_sha,
                plan.workspaces[job.workspace].key
            ),
            fs: &fs,
            scratch,
            env,
            cwd: job.cwd.clone(),
            collect: crate::machines::collect_paths(
                job,
                root.as_deref(),
                OUTPUT_PATH,
                options.caches.is_some(),
                &env_caches.iter().map(|c| c.path()).collect::<Vec<_>>(),
            ),
            log,
            cancel,
        }),
        (None, Some(tool), _) => executor.execute(
            tool,
            &path_tools,
            &services,
            &job.action,
            Invocation {
                job,
                fs: &fs,
                scratch,
                env,
                path: &workspace.path,
                log,
                cancel,
                memory_watch: gauge.map(|gauge| {
                    let watch: iwci_runtime::MemoryWatch =
                        Arc::new(move |bytes| gauge.program(bytes));
                    watch
                }),
            },
        ),
        // Checked when the tool was: a job in a machine on a runner
        // without machines never gets here.
        _ => Err(crate::machines::missing(
            job.vm.as_ref().map_or(iwci_spec::VmOs::Linux, |v| v.os),
        )),
    };
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
        Some(root) if !matches!(job.changes, ChangePolicy::Ignore) => {
            // What git ignores is no change to the repository either: a job
            // that installs `node_modules` or builds `target` changed
            // nothing, as `git status` would say. A file the clone had is
            // still one, whatever its rules say now.
            let rules = GitIgnore::new(root, |path: &str| fs.read(path).ok());
            let ignored = |c: &Change| {
                matches!(c, Change::Added { .. })
                    && c.path().to_str().is_some_and(|p| rules.ignored(p, false))
            };
            // The clone's `.git` is the runner's, not the repository's: a
            // `git status` that refreshes its index changed nothing.
            let git_dir = std::path::Path::new(root).join(".git");
            fs.changes(root)
                .into_iter()
                .filter(|c| {
                    !under_cache(c.path())
                        && !restored.contains(c.path())
                        && !ignored(c)
                        && !c.path().starts_with(&git_dir)
                })
                .collect()
        }
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
            reason: options.cancel_reason().into(),
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
            reason: match &options.spill {
                Some(_) => format!(
                    "exited with {} after a write was refused: the files it wrote used up its {} MiB of disk",
                    execution.exit_code,
                    write_budget.cap >> 20
                ),
                None => format!(
                    "exited with {} after a write was refused: the files it wrote used up its {} MiB memory limit",
                    execution.exit_code,
                    job.memory_bytes >> 20
                ),
            },
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
        let entries = with_modes(&fs, written_under(&fs, &job.artifacts, &restored));
        keep_artifacts(entries, plan, shared, &mut status, &mut notes, kept);
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

    // Save job caches only after a pass, and only when the job did not
    // start from an exact hit (that entry is already what it would save).
    if status == Status::Passed
        && let Some(store) = &options.caches
    {
        for (key, restore_keys, exact, unreadable, paths) in &cache_keys {
            if *exact {
                continue;
            }
            // A key is saved once: when another job of the run (a matrix
            // sharing a package store) saved it while this one ran, saving
            // it again would compress and upload the same files for nothing.
            if !*unreadable && store.has(key) {
                cache_lines.push(format!("cache `{key}`: already saved"));
                continue;
            }
            // Never a lent credential, whatever path the cache names.
            let entries: Vec<Entry> = fs
                .entries_under(paths)
                .into_iter()
                .filter(|e| !lent_paths.contains(entry_path(e)))
                .collect();
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
            if !store.claim(key) {
                cache_lines.push(format!("cache `{key}`: being saved by another job"));
                continue;
            }
            let saving = Instant::now();
            match store.save_with_modes(key, restore_keys, &entries, &fs.modes_of(&entries)) {
                Ok(()) => cache_lines.push(format!(
                    "cache `{key}`: saved {} KiB in {}",
                    bytes.div_ceil(1024),
                    seconds(saving.elapsed())
                )),
                Err(e) => cache_lines.push(format!("cache `{key}`: could not save ({e})")),
            }
        }
    }

    // Environment caches hold toolchains and packages keyed by version,
    // not test results: a job whose tests failed still filled them, and
    // saving them is what makes its next run warm. Only a script that ended
    // on its own counts: one stopped mid-write (timed out, stalled, out of
    // memory, a write refused, cancelled) may leave half an install behind,
    // which the next run would take for a whole one.
    let ended_on_its_own = !execution.cancelled
        && execution.service_failure.is_none()
        && !execution.timed_out
        && execution.stalled_after.is_none()
        && !execution.out_of_memory
        && !write_budget.refused.load(Ordering::SeqCst);
    if matches!(status, Status::Passed | Status::Failed { .. })
        && ended_on_its_own
        && let Some(store) = &options.caches
    {
        for active in &env_caches {
            crate::env_cache::save(store.as_ref(), active, &fs, &mut cache_lines);
        }
    }

    // How long it took, for the next run's order and for the task cache's
    // record, which a hit then counts as: the same number in both.
    let ran_ms = millis(started.elapsed());
    // Only what of its files was in memory counts toward what it held.
    let files_peak = write_budget.in_memory(write_budget.peak.load(Ordering::SeqCst));
    let peak_memory_mib = execution
        .peak_memory_bytes
        .saturating_add(files_peak)
        .div_ceil(1 << 20);
    let held_memory_mib = execution
        .held_memory_bytes
        .saturating_add(files_peak)
        .div_ceil(1 << 20);
    {
        let mut measured = shared.measured.lock().unwrap();
        measured.durations.insert(job.id.clone(), ran_ms);
        // A job that never got to run its program held nothing to go by.
        if held_memory_mib != 0 && execution.service_failure.is_none() {
            measured.held.insert(job.id.clone(), held_memory_mib);
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
            duration_ms: ran_ms,
            held_memory_mib: Some(held_memory_mib).filter(|&mib| mib != 0),
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
            Ok(()) => {
                *saved_key = Some(key.clone());
                format!(
                    "task cache `{}`: saved {} KiB",
                    short_key(key),
                    saved.div_ceil(1024)
                )
            }
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
        cpus: None,
        peak_memory_mib,
        held_memory_mib,
        queued_ms: 0,
        duration_ms: millis(started.elapsed()),
        blocks,
        cached: false,
        needs: Vec::new(),
        access: job.access.clone(),
        cloud: None,
        remote: None,
        waited_for: None,
        elsewhere: false,
    }
}

/// Keeps a passing job's artifacts for the jobs that need it, within the
/// run's `scratch:` limit (they stay in memory until the run ends), or
/// fails it.
fn keep_artifacts(
    entries: Vec<Entry>,
    plan: &Plan,
    shared: &RunShared<'_>,
    status: &mut Status,
    notes: &mut Vec<String>,
    kept: &mut Vec<Entry>,
) {
    let files = entries
        .iter()
        .filter(|e| {
            matches!(e, Entry::File { .. }) && entry_path(e) != std::path::Path::new(ARTIFACT_MODES)
        })
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
        *status = Status::Failed {
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

/// Hands a cloud job to the run's executor and waits for it: the runner
/// keeps it in the graph, the app runs it on a connected cloud account.
/// See [`crate::external`].
fn run_external(
    job: &PlannedJob,
    plan: &Plan,
    options: &Options,
    shared: &RunShared<'_>,
    inherited: Vec<(String, Arc<Vec<Entry>>)>,
    kept: &mut Vec<Entry>,
) -> JobReport {
    use crate::external::{End, ExternalJob, FinishStatus};
    let started = Instant::now();
    let spec = job.cloud.clone().expect("only cloud jobs are handed over");
    let with_cloud = |mut report: JobReport, executor, claimed: Option<Duration>| {
        report.memory_mib = 0;
        report.cloud = Some(CloudRun {
            spec: spec.clone(),
            executor,
            claimed_ms: claimed.map_or(0, millis),
        });
        report
    };
    if !options.access.trusted {
        return with_cloud(
            refused(job, crate::external::UNTRUSTED.into(), started.elapsed()),
            None,
            None,
        );
    }
    let Some(external) = &options.access.external else {
        return with_cloud(
            errored(
                job,
                "this runner hands cloud jobs to nothing (`iwci run`): they run when a run comes through `iwci serve`, whose executor claims them".into(),
                started.elapsed(),
            ),
            None,
            None,
        );
    };
    let lent = match crate::lent::for_job(
        &options.access.lent,
        &job.access,
        options.access.trusted,
        &options.secrets,
        crate::runner::now_secs(),
        job.timeout,
    ) {
        Ok(lent) => lent,
        Err(reason) => {
            return with_cloud(
                refused(job, shared.mask.mask(&reason), started.elapsed()),
                None,
                None,
            );
        }
    };
    let mut env = options.base_env.clone();
    env.push(("IWCI_JOB".into(), job.id.clone()));
    merge_env(&mut env, &lent.env);
    merge_env(&mut env, &job.env);
    let mut notes = lent.notes.clone();
    let mut secret_vars = Vec::new();
    for entry in &job.secret_env {
        let filled = entry.fill(
            |name| options.secrets.get(name).cloned(),
            |name, output| options.access.lent.output(name, output),
        );
        let (value, missing) = match filled {
            Ok(filled) => filled,
            Err(reason) => {
                return with_cloud(
                    refused(job, shared.mask.mask(&reason), started.elapsed()),
                    None,
                    None,
                );
            }
        };
        for name in missing {
            notes.push(format!(
                "secret `{name}` is not set for this run, so `{}` has it empty",
                entry.key
            ));
        }
        secret_vars.push((entry.key.clone(), value));
    }
    merge_env(&mut env, &secret_vars);
    // What the executor should treat as secret: everything lent the job's
    // own `env:` does not replace, and every value that reads a secret.
    let mut secret_keys: Vec<String> = lent
        .env
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !job.env.iter().any(|(own, _)| own == k))
        .chain(job.secret_env.iter().map(|e| e.key.clone()))
        .collect();
    secret_keys.sort();
    secret_keys.dedup();
    let script = match &job.action {
        Action::Script { script } => script.clone(),
        Action::Args { .. } => String::new(),
    };
    let sink = options.logs.as_ref().map(|logs| {
        logs(LogEvent::JobExternal {
            job: job.id.clone(),
            name: job.display_name.clone(),
            cloud: spec.clone(),
        });
        Arc::new(LineSink {
            job: job.id.clone(),
            logs: logs.clone(),
            mask: shared.mask.clone(),
            pending: Mutex::default(),
        })
    });
    let on_claim: Box<dyn Fn() + Send + Sync> = match &options.logs {
        Some(logs) => {
            let logs = logs.clone();
            let (id, name) = (job.id.clone(), job.display_name.clone());
            Box::new(move || {
                logs(LogEvent::JobStarted {
                    job: id.clone(),
                    name: name.clone(),
                })
            })
        }
        None => Box::new(|| {}),
    };
    let log: Option<OutputSink> = sink.clone().map(|sink| {
        let sink: OutputSink = Arc::new(move |stderr: bool, data: &[u8]| sink.push(stderr, data));
        sink
    });
    let room = plan
        .scratch_bytes
        .saturating_sub(shared.artifact_bytes.load(Ordering::SeqCst));
    let outcome = external.run(
        ExternalJob {
            id: job.id.clone(),
            name: job.display_name.clone(),
            cloud: spec.clone(),
            script,
            cwd: job.cwd.clone(),
            env,
            secret_keys,
            files: lent.files,
            timeout: job.timeout,
            outputs: job.outputs.clone(),
            artifacts: job.artifacts.clone(),
            changes: job.changes.clone(),
            clone: plan.workspaces[job.workspace].clone.clone(),
            inputs: inherited,
            max_artifact_bytes: room,
            on_claim,
            log,
        },
        options.cancel.as_ref(),
    );
    if let Some(sink) = &sink {
        sink.flush();
    }
    let mask = |t: &str| shared.mask.mask(t);
    let claimed = outcome.claimed_for;
    let mut execution = Execution {
        exit_code: 0,
        stdout: mask(&outcome.stdout),
        stderr: mask(&outcome.stderr),
        ..Default::default()
    };
    if outcome.truncated {
        notes.push(format!(
            "log: kept the first {} MiB of each stream",
            crate::external::MAX_LOG_BYTES >> 20
        ));
    }
    let mut outputs = BTreeMap::new();
    let mut changes = Vec::new();
    let mut status = match &outcome.end {
        End::Cancelled => {
            execution.cancelled = true;
            Status::Cancelled {
                reason: options.cancel_reason().into(),
            }
        }
        End::Lost(reason) => Status::Error {
            message: mask(reason),
        },
        End::TimedOut => {
            execution.timed_out = true;
            Status::Failed {
                reason: format!(
                    "timed out: no end {}s after it was claimed ({}s of `timeout:` and {}s to start a machine)",
                    job.timeout.as_secs() + crate::external::BOOT_SECS,
                    job.timeout.as_secs(),
                    crate::external::BOOT_SECS
                ),
            }
        }
        End::Finished(finish) => {
            execution.exit_code = finish.exit_code.unwrap_or(match finish.status {
                FinishStatus::Passed => 0,
                _ => 1,
            });
            execution.timed_out = finish.timed_out;
            changes = finish.changes.iter().map(|c| c.changed_file()).collect();
            let error = finish.error.as_deref().map(mask);
            match finish.status {
                FinishStatus::Error => Status::Error {
                    message: error.unwrap_or_else(|| "its executor could not run it".into()),
                },
                FinishStatus::Failed => Status::Failed {
                    reason: error.unwrap_or_else(|| {
                        if finish.timed_out {
                            format!("timed out after {}s", job.timeout.as_secs())
                        } else {
                            format!("exited with {}", execution.exit_code)
                        }
                    }),
                },
                FinishStatus::Passed => {
                    match parse_outputs(
                        finish.output.as_deref().unwrap_or_default().as_bytes(),
                        &job.outputs,
                    ) {
                        // Masked, as a local job's are: an output carrying a
                        // secret would pass it on.
                        Ok(read) => {
                            outputs = read.into_iter().map(|(k, v)| (k, mask(&v))).collect();
                            match (&job.changes, changes.is_empty()) {
                                (ChangePolicy::Fail, false) => Status::Failed {
                                    reason: format!(
                                        "changed {} file(s); run it locally and commit the result",
                                        changes.len()
                                    ),
                                },
                                _ => Status::Passed,
                            }
                        }
                        Err(e) => Status::Failed {
                            reason: format!("$IWCI_OUTPUT: {e}"),
                        },
                    }
                }
            }
        }
    };
    if status == Status::Passed && !job.artifacts.is_empty() {
        keep_artifacts(
            outcome.artifacts,
            plan,
            shared,
            &mut status,
            &mut notes,
            kept,
        );
    }
    let blocks = !status.is_success();
    JobReport {
        id: job.id.clone(),
        name: job.display_name.clone(),
        tool: job.tool.to_string(),
        status,
        execution: claimed.is_some().then_some(execution),
        changes,
        commit: None,
        outputs,
        caches: Vec::new(),
        downloads: Vec::new(),
        notes,
        duration_ms: millis(started.elapsed()),
        memory_mib: 0,
        cpus: None,
        peak_memory_mib: 0,
        held_memory_mib: 0,
        queued_ms: 0,
        blocks,
        cached: false,
        needs: Vec::new(),
        access: job.access.clone(),
        cloud: Some(CloudRun {
            spec,
            executor: outcome.executor.map(|e| mask(&e)),
            claimed_ms: claimed.map_or(0, millis),
        }),
        remote: None,
        waited_for: None,
        elsewhere: false,
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
    /// What the run held of the runner's memory
    /// ([`JobReport::held_memory_mib`]); absent from entries saved before
    /// the runner measured it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    held_memory_mib: Option<u64>,
}

fn short_key(key: &str) -> &str {
    let hash = key.rsplit('/').next().unwrap_or(key);
    &hash[..hash.len().min(12)]
}

/// Every tool and environment a job runs: its `using:`, its `tools:` and
/// its services', in that order.
fn job_tools(job: &PlannedJob) -> impl Iterator<Item = &ToolRef> {
    std::iter::once(&job.tool)
        .chain(&job.tools)
        .chain(job.services.iter().map(|s| &s.tool))
}

/// For a `packages:` job that runs in its package, the part of
/// `dep`'s lockfile that package can resolve, as `(lockfile name, digest)`,
/// to key it on in place of the whole file: pnpm, and Bun's isolated
/// linker. `None` keys it on the whole file: any other job, which may reach
/// every project from where it runs; Bun's hoisted linker and npm, which
/// put every project's packages where any project can import them; the ecosystems
/// whose projects `packages:` does not expand over (Go, Cargo, pip,
/// Composer); and a lockfile the
/// index cannot read (the install reports why).
fn lockfile_part(
    job: &PlannedJob,
    root: &str,
    index: usize,
    dep: &DepSpec,
    snapshot: &Snapshot,
    locks: &LockIndexes,
) -> Option<(&'static str, [u8; 32])> {
    let package = job.package.as_ref()?;
    let dir = if package.dir.is_empty() || package.dir == "." {
        root.to_string()
    } else {
        format!("{root}/{}", package.dir)
    };
    // A job that moves out of its package (`cwd:`) reaches what is there.
    let inside =
        |path: &str, dir: &str| path == dir || dir == "/" || path.starts_with(&format!("{dir}/"));
    if !inside(&job.cwd, &dir) || !inside(&dir, &dep.dir) {
        return None;
    }
    let project = match dir.strip_prefix(&dep.dir) {
        Some("") | None => ".".to_string(),
        Some(rest) => rest.trim_start_matches('/').to_string(),
    };
    locks.digest(index, dep, snapshot, &project)
}

/// The task cache key of a `task-cache:` job: everything that decides what
/// it does and what it reads. Its definition (tool, arguments or script,
/// environment, directory, what it keeps), what each of [`job_tools`]
/// resolves to (`pins`, from [`Tools::pin`], so a version published under
/// a range is a new key), its workspace's settings and lockfiles (for a
/// `packages:` job, of a pnpm or isolated Bun lockfile only what its
/// package can resolve: [`lockfile_part`]), the files its inputs match as the commit has them
/// (never under `node_modules`), and the artifacts it is handed, by
/// content, so a change to a package reaches every job downstream of it.
/// `None` for a job without one.
fn task_cache_key(
    job: &PlannedJob,
    plan: &Plan,
    snapshot: &Snapshot,
    locks: &LockIndexes,
    pins: &[String],
    inherited: &[(String, Arc<Vec<Entry>>)],
) -> Option<String> {
    use sha2::Digest;
    let spec = job.task_cache.as_ref()?;
    let ws = &plan.workspaces[job.workspace];
    let root = ws.clone.as_ref()?.into.clone();
    // A job that says it does not read what it is handed is keyed without
    // it, so an upstream change does not rerun it.
    let inherited = if spec.artifacts { inherited } else { &[] };
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
    // 2: keyed on what each tool resolves to as well as on its `using:`.
    hash.update(b"iwci task cache 2\0");
    hash.update(serde_json::to_vec(&definition).ok()?);
    hash.update(b"\0pins\0");
    for pin in pins {
        hash.update(pin.as_bytes());
        hash.update([0]);
    }
    for (index, dep) in ws.deps.iter().enumerate() {
        let part = lockfile_part(job, &root, index, dep, snapshot, locks);
        // Patch files, which `bun.lock` names without pinning their content.
        let bun_patches;
        let bundler_gemspecs;
        // What an npm install writes beyond the lockfile: the native
        // packages it puts WebAssembly builds in place of, which no lockfile
        // names, and (since 2) `node_modules/.bin`.
        if matches!(
            dep.ecosystem,
            iwci_spec::Ecosystem::Pnpm | iwci_spec::Ecosystem::Npm | iwci_spec::Ecosystem::Bun
        ) {
            hash.update(b"npm layout 2\0wasm builds\0");
            hash.update(iwci_deps::wasm_builds::key().as_bytes());
            hash.update([0]);
        }
        let names: Vec<&str> = match dep.ecosystem {
            iwci_spec::Ecosystem::Pnpm => vec!["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"],
            iwci_spec::Ecosystem::Npm => iwci_deps::npm::INPUT_FILES.to_vec(),
            iwci_spec::Ecosystem::Bun => {
                let lock = snapshot.read(format!("{}/bun.lock", dep.dir)).ok();
                bun_patches = iwci_deps::bun::patch_files(lock.as_deref());
                let patches = bun_patches.iter().map(String::as_str);
                iwci_deps::bun::INPUT_FILES
                    .into_iter()
                    .chain(patches)
                    .collect()
            }
            iwci_spec::Ecosystem::Go => vec!["go.mod", "go.sum"],
            iwci_spec::Ecosystem::Cargo => vec!["Cargo.lock"],
            iwci_spec::Ecosystem::Pip => match &dep.file {
                Some(file) => vec![file.as_str()],
                None => iwci_deps::pip::DEFAULT_FILES.to_vec(),
            },
            iwci_spec::Ecosystem::Composer => vec!["composer.lock", "composer.json"],
            iwci_spec::Ecosystem::Bundler => {
                // The extensions built for the job's Ruby, which the
                // install places beside the gems.
                hash.update(b"gem builds\0");
                hash.update(crate::gem_builds::key().as_bytes());
                hash.update([0]);
                // The gemspecs of `PATH` sources, which Bundler reads when
                // the bundle loads and the lock does not pin.
                let lock = iwci_deps::bundler::LOCKFILES
                    .iter()
                    .find_map(|name| snapshot.read(format!("{}/{name}", dep.dir)).ok());
                bundler_gemspecs = iwci_deps::bundler::path_gemspecs(lock.as_deref());
                iwci_deps::bundler::INPUT_FILES
                    .into_iter()
                    .chain(bundler_gemspecs.iter().map(String::as_str))
                    .collect()
            }
        };
        for name in names {
            let path = format!("{}/{name}", dep.dir);
            if let Some((lockfile, digest)) = &part
                && name == *lockfile
            {
                // Only what the job's package resolves of it.
                hash.update(path.as_bytes());
                hash.update(b"#package\0");
                hash.update(digest);
            } else if let Ok(content) = snapshot.read(&path) {
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
    if files.iter().any(|e| {
        entry_path(e) != std::path::Path::new(ARTIFACT_MODES)
            && !job.artifacts.iter().any(|a| entry_path(e).starts_with(a))
    }) {
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
    {
        let mut measured = shared.measured.lock().unwrap();
        measured
            .durations
            .insert(job.id.clone(), record.duration_ms);
        if let Some(mib) = record.held_memory_mib {
            measured.held.insert(job.id.clone(), mib);
        }
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
            peak_memory_bytes: 0,
            held_memory_bytes: 0,
            service_failure: None,
            cancelled: false,
            sandbox: None,
            machine: None,
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
        cpus: None,
        peak_memory_mib: 0,
        held_memory_mib: 0,
        queued_ms: 0,
        blocks: false,
        cached: true,
        needs: Vec::new(),
        access: job.access.clone(),
        cloud: None,
        remote: None,
        waited_for: None,
        elsewhere: false,
    })
}

/// Where a list of artifacts keeps the modes of its files (`<octal mode>
/// <path>` a line), which [`Entry`] does not carry: a program a job built
/// is still executable in the job it is handed to. Under `/iwci`, which no
/// job's artifacts can name; a list without one hands its files on as
/// they always were.
pub(crate) const ARTIFACT_MODES: &str = "/iwci/artifact-modes";

/// `entries` with a record of the modes `fs` has for its files, when any
/// has one.
fn with_modes(fs: &JobFs, mut entries: Vec<Entry>) -> Vec<Entry> {
    let modes = fs.modes();
    let mut text = String::new();
    for entry in &entries {
        if let Entry::File { path, .. } = entry
            && let Some(mode) = modes.get(path)
            && let Some(path) = path.to_str()
        {
            text.push_str(&format!("{mode:o} {path}\n"));
        }
    }
    if !text.is_empty() {
        entries.push(Entry::File {
            path: ARTIFACT_MODES.into(),
            data: text.into_bytes().into(),
        });
    }
    entries
}

/// The files of a list of artifacts, without its modes record, and the
/// modes it records, by path.
pub(crate) fn artifact_modes(entries: &[Entry]) -> (Vec<Entry>, Vec<(PathBuf, u32)>) {
    let mut files = Vec::with_capacity(entries.len());
    let mut modes = Vec::new();
    for entry in entries {
        match entry {
            Entry::File { path, data } if path == std::path::Path::new(ARTIFACT_MODES) => {
                for line in String::from_utf8_lossy(data).lines() {
                    if let Some((mode, path)) = line.split_once(' ')
                        && let Ok(mode) = u32::from_str_radix(mode, 8)
                        && let Ok(path) = iwci_vfs::normalise(path)
                    {
                        modes.push((path, mode & 0o7777));
                    }
                }
            }
            other => files.push(other.clone()),
        }
    }
    (files, modes)
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
/// A duration as a job's report gives one: `0.4 s`, `12.3 s`.
fn seconds(d: Duration) -> String {
    format!("{:.1} s", d.as_secs_f64())
}

fn merge_env(into: &mut Vec<(String, String)>, from: &[(String, String)]) {
    for (k, v) in from {
        into.retain(|(existing, _)| existing != k);
        into.push((k.clone(), v.clone()));
    }
}

/// A job of a cancelled run, or of a runner that holds its memory, that
/// never started.
fn cancelled_report(job: &PlannedJob, reason: &str) -> JobReport {
    let mut report = errored(job, String::new(), Duration::ZERO);
    report.status = Status::Cancelled {
        reason: reason.into(),
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
        cpus: None,
        peak_memory_mib: 0,
        held_memory_mib: 0,
        queued_ms: 0,
        duration_ms: millis(elapsed),
        blocks: true,
        cached: false,
        needs: Vec::new(),
        access: job.access.clone(),
        cloud: None,
        remote: None,
        waited_for: None,
        elsewhere: false,
    }
}

/// A job that never started because it was refused something it names (a
/// connection the app would not lend, a cloud job of an untrusted run).
fn refused(job: &PlannedJob, reason: String, elapsed: Duration) -> JobReport {
    let mut report = errored(job, String::new(), elapsed);
    report.status = Status::Failed { reason };
    report.memory_mib = 0;
    report
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
#[path = "schedule_tests.rs"]
mod tests;
