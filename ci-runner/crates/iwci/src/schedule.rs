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

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use iwci_spec::expr::{self, Name};
use iwci_spec::{
    Action, ChangePolicy, JobResult, JobTemplate, NeedsValues, Plan, PlannedJob, ToolRef,
    WorkspaceSpec,
};
use iwci_vfs::{Change, JobFs, Snapshot, WriteBudget};
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
    /// The job's own `env:` over the workspace's, over the runner's `IWCI_*`.
    pub env: Vec<(String, String)>,
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
    fn execute(
        &self,
        tool: &T,
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
    pub duration_ms: u64,
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
}

/// The runner's memory limit, shared by every job.
///
/// A job reserves its `memory:` for its program before it starts, and only
/// starts when that fits; the bytes it then writes to its in-memory file
/// system are charged here as they are written, on top of the reservation.
/// So the jobs' program memory plus their files never exceed the total.
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

/// One job's file writes: held to its own `memory:` and charged to the
/// runner's budget, if there is one. Whatever is still charged when the job
/// is over goes back to the runner.
#[derive(Debug)]
struct JobBudget {
    cap: u64,
    used: AtomicU64,
    /// Which limit refused a write, if one did: [`REFUSED_BY_JOB`] or
    /// [`REFUSED_BY_RUNNER`].
    refused: AtomicU8,
    runner: Option<Arc<MemoryBudget>>,
}

const REFUSED_BY_JOB: u8 = 1;
const REFUSED_BY_RUNNER: u8 = 2;

impl WriteBudget for JobBudget {
    fn take(&self, bytes: u64) -> bool {
        let mine = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(bytes).filter(|&next| next <= self.cap)
            })
            .is_ok();
        if !mine {
            self.refused.store(REFUSED_BY_JOB, Ordering::SeqCst);
            return false;
        }
        if self.runner.as_ref().is_some_and(|r| !r.try_take(bytes)) {
            self.used.fetch_sub(bytes, Ordering::SeqCst);
            self.refused.store(REFUSED_BY_RUNNER, Ordering::SeqCst);
            return false;
        }
        true
    }

    fn give(&self, bytes: u64) {
        let given = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                Some(used.saturating_sub(bytes))
            })
            .map_or(0, |before| before.min(bytes));
        if let Some(runner) = &self.runner {
            runner.give(given);
        }
    }
}

impl Drop for JobBudget {
    fn drop(&mut self) {
        if let Some(runner) = &self.runner {
            runner.give(*self.used.get_mut());
        }
    }
}

/// How a finished job key went, for the keys that need it.
#[derive(Debug, Clone)]
struct Finished {
    result: JobResult,
    blocks: bool,
    outputs: BTreeMap<String, String>,
}

struct State<'p> {
    /// Keys not yet activated.
    waiting: Vec<&'p JobTemplate>,
    finished: HashMap<String, Finished>,
    /// Expanded jobs ready to run.
    queue: Vec<(&'p JobTemplate, PlannedJob)>,
    /// Per activated key: entries still running and the reports so far.
    open: HashMap<String, (usize, Vec<JobReport>)>,
    running: usize,
    reports: HashMap<String, Vec<JobReport>>,
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

    std::thread::scope(|scope| {
        for _ in 0..options.parallelism.max(1) {
            scope.spawn(|| {
                loop {
                    let (template, job) = {
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
                                let next = s.queue.remove(pos);
                                s.running += 1;
                                break next;
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
                    let workspace = built[job.workspace]
                        .get_or_init(|| workspaces.build(&plan.workspaces[job.workspace]));
                    let report =
                        run_job(&job, plan, workspace, tools, executor, committer, options);
                    if let Some(budget) = &options.memory {
                        budget.give(job.memory_bytes);
                    }
                    let mut s = state.lock().unwrap();
                    s.running -= 1;
                    let entry = s.open.get_mut(&template.key).expect("activated");
                    entry.0 -= 1;
                    entry.1.push(report);
                    if entry.0 == 0 {
                        let (_, reports) = s.open.remove(&template.key).expect("activated");
                        finish(&mut s, template, reports);
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
            finish(s, template, vec![report]);
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
                finish(s, template, vec![report]);
            }
            Ok(jobs) if jobs.is_empty() => {
                let report = key_report(
                    template,
                    Status::Skipped {
                        reason: "its matrix is empty".into(),
                    },
                    false,
                );
                finish(s, template, vec![report]);
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
                finish(s, template, vec![report]);
            }
            Ok(jobs) => {
                s.open
                    .insert(template.key.clone(), (jobs.len(), Vec::new()));
                // The queue is a stack; push in reverse so entries start in
                // matrix order.
                for job in jobs.into_iter().rev() {
                    s.queue.push((template, job));
                }
            }
        }
    }
}

fn finish(s: &mut State<'_>, template: &JobTemplate, mut reports: Vec<JobReport>) {
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
    // Matrix entries finish in any order; report them in matrix order.
    if let Some(instances) = &template.instances {
        reports.sort_by_key(|r| {
            instances
                .iter()
                .position(|j| j.id == r.id)
                .unwrap_or(usize::MAX)
        });
    }
    s.finished.insert(
        template.key.clone(),
        Finished {
            result,
            blocks,
            outputs,
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
        duration_ms: 0,
        blocks,
    }
}

fn run_job<T: Tools>(
    job: &PlannedJob,
    plan: &Plan,
    workspace: &Result<BuiltWorkspace, String>,
    tools: &T,
    executor: &dyn Executor<T::Tool>,
    committer: &dyn Committer,
    options: &Options,
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
    let tool = match tools.resolve(&job.tool) {
        Ok(t) => t,
        Err(e) => return errored(job, format!("{}: {e}", job.tool), started.elapsed()),
    };

    // The job's files live in memory, so its writes are held to its
    // `memory:` too (and to the runner's budget), or a job could write its
    // way past any limit.
    let write_budget = Arc::new(JobBudget {
        cap: job.memory_bytes,
        used: AtomicU64::new(0),
        refused: AtomicU8::new(0),
        runner: options.memory.clone(),
    });
    let fs = workspace.snapshot.fork_limited(write_budget.clone());
    if let Err(e) = fs.write(OUTPUT_PATH, b"") {
        return errored(
            job,
            format!("could not create {OUTPUT_PATH}: {e}"),
            started.elapsed(),
        );
    }
    let mut env = options.base_env.clone();
    env.push(("IWCI_JOB".into(), job.id.clone()));
    env.push(("IWCI_OUTPUT".into(), OUTPUT_PATH.into()));
    merge_env(&mut env, &workspace.env);
    merge_env(&mut env, &job.env);

    let execution = match executor.execute(&tool, &job.action, Invocation { job, fs: &fs, env }) {
        Ok(e) => e,
        Err(e) => return errored(job, e, started.elapsed()),
    };

    let root = plan.workspaces[job.workspace]
        .clone
        .as_ref()
        .map(|c| c.into.clone());
    let changes = match &root {
        Some(root) if !matches!(job.changes, ChangePolicy::Ignore) => fs.changes(root),
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
        .and_then(|bytes| parse_outputs(&bytes, &job.outputs));

    let mut commit = None;
    let status = if execution.timed_out {
        Status::Failed {
            reason: format!("timed out after {}s", job.timeout.as_secs()),
        }
    } else if execution.out_of_memory {
        Status::Failed {
            reason: format!("ran out of its {} MiB of memory", job.memory_bytes >> 20),
        }
    } else if execution.exit_code != 0 && write_budget.refused.load(Ordering::SeqCst) != 0 {
        let whose = if write_budget.refused.load(Ordering::SeqCst) == REFUSED_BY_JOB {
            format!("its own {} MiB memory limit", job.memory_bytes >> 20)
        } else {
            "the runner's memory limit (--memory)".to_string()
        };
        Status::Failed {
            reason: format!(
                "exited with {} after a write was refused: the files it wrote used up {whose}",
                execution.exit_code
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
        duration_ms: millis(started.elapsed()),
        blocks,
    }
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
        duration_ms: millis(elapsed),
        blocks: true,
    }
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
#[path = "schedule_tests.rs"]
mod tests;
