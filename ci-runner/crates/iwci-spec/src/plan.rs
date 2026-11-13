//! The validated, expanded pipeline: what the orchestrator executes.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use serde::Serialize;

use crate::expr::Expr;

/// A parsed pipeline: one [`JobTemplate`] per job key, with every matrix
/// expanded and every expression substituted that can be before the run
/// starts.
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub name: String,
    pub triggers: Triggers,
    /// The pipeline's `concurrency:`, its group substituted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<Concurrency>,
    /// The distinct workspaces the jobs need, each built once per run.
    pub workspaces: Vec<WorkspaceSpec>,
    /// In file order.
    pub jobs: Vec<JobTemplate>,
    /// The most the run's shared `/tmp/workflow` holds (`scratch:`).
    pub scratch_bytes: u64,
    /// What every job declares, for expanding deferred jobs later.
    #[serde(skip)]
    pub(crate) decls: HashMap<String, crate::JobDecl>,
    #[serde(skip)]
    pub(crate) ctx: crate::Context,
}

impl Plan {
    /// The commit the plan was parsed for.
    pub fn context(&self) -> &crate::Context {
        &self.ctx
    }

    pub fn template(&self, key: &str) -> Option<&JobTemplate> {
        self.jobs.iter().find(|t| t.key == key)
    }

    /// An expanded job by id, among the jobs known before the run.
    pub fn job(&self, id: &str) -> Option<&PlannedJob> {
        self.static_jobs().find(|job| job.id == id)
    }

    /// Every job expanded at parse time, in file order. Jobs whose matrix
    /// or fields read another job's outputs are not here until
    /// [`Plan::instantiate`] expands them.
    pub fn static_jobs(&self) -> impl Iterator<Item = &PlannedJob> {
        self.jobs
            .iter()
            .filter_map(|t| t.instances.as_deref())
            .flatten()
    }

    /// Templates in an order where each comes after everything it needs.
    /// Validation has already ruled out cycles.
    pub fn topological_order(&self) -> Vec<&JobTemplate> {
        let mut done = std::collections::HashSet::new();
        let mut order = Vec::with_capacity(self.jobs.len());
        loop {
            let before = order.len();
            for t in &self.jobs {
                if !done.contains(t.key.as_str())
                    && t.needs.iter().all(|n| done.contains(n.as_str()))
                {
                    done.insert(t.key.as_str());
                    order.push(t);
                }
            }
            if order.len() == before {
                break;
            }
        }
        order
    }

    /// Expands `key` now that the jobs it needs have finished. For a job
    /// that was fully expanded at parse time this returns those jobs again.
    pub fn instantiate(
        &self,
        key: &str,
        needs: &NeedsValues,
    ) -> Result<Vec<PlannedJob>, crate::SpecErrors> {
        let template = self.template(key).ok_or_else(|| {
            crate::SpecErrors(vec![crate::SpecError {
                path: format!("jobs.{key}"),
                message: "no such job".into(),
            }])
        })?;
        if let Some(jobs) = &template.instances {
            return Ok(jobs.clone());
        }
        crate::instantiate(self, template, needs)
    }
}

/// At most one run of a repository per `group` is in progress. Groups
/// compare case-insensitively; this is the group as substituted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub struct Concurrency {
    pub group: String,
    pub cancel_in_progress: bool,
}

/// One job key of the file. A matrix job expands into several
/// [`PlannedJob`]s; a job whose matrix or fields read another job's outputs
/// expands only when those jobs finish.
#[derive(Debug, Clone, Serialize)]
pub struct JobTemplate {
    pub key: String,
    /// Job keys this one waits for. Naming a matrix job waits for every
    /// entry.
    pub needs: Vec<String>,
    /// The `if:` as written, for display.
    #[serde(rename = "if", skip_serializing_if = "Option::is_none")]
    pub condition_source: Option<String>,
    #[serde(skip)]
    pub condition: Option<Expr>,
    pub outputs: Vec<String>,
    pub workspace: usize,
    pub paths: Vec<String>,
    pub tool: ToolRef,
    /// `tools:`, the same for every expanded job.
    pub tools: Vec<ToolRef>,
    /// The expanded jobs, or `None` when they depend on `needs` outputs.
    pub instances: Option<Vec<PlannedJob>>,
    /// The workspace package of a job a `packages:` job became.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageRef>,
    /// `cloud:` as written, for a job that runs on a connected cloud
    /// account: `provider`, `kind` and `connection` are literal; the other
    /// fields may still hold `${{ matrix }}`, which each entry substitutes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud: Option<CloudSpec>,
    /// The connections, SSH keys and resources the job is lent, by name,
    /// for whoever dispatches the run to resolve before it starts.
    #[serde(skip_serializing_if = "JobAccess::is_empty")]
    pub access: JobAccess,
    #[serde(skip)]
    pub(crate) raw: Option<crate::raw::Job>,
}

/// Where a cloud job runs: `cloud:`, checked. Every field is substituted
/// in a [`PlannedJob`]; in a [`JobTemplate`] only the first three are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CloudSpec {
    pub provider: String,
    /// `vm`, `container`, `build`, `host` or `cluster`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<String>,
}

/// The kinds of machine a cloud job may ask for.
pub const CLOUD_KINDS: [&str; 5] = ["vm", "container", "build", "host", "cluster"];

/// One of a job's `connections:`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct ConnectionUse {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// What a job is lent, by name: every one is literal, so the app can check
/// and resolve them all before the run starts. Services' `env:` count too.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub struct JobAccess {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub connections: Vec<ConnectionUse>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ssh_keys: Vec<String>,
    /// `${{ resources.<name>.<output> }}`: each resource's outputs read.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub resources: BTreeMap<String, std::collections::BTreeSet<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub env_from: Vec<String>,
}

impl JobAccess {
    pub fn is_empty(&self) -> bool {
        self.connections.is_empty()
            && self.ssh_keys.is_empty()
            && self.resources.is_empty()
            && self.env_from.is_empty()
    }
}

/// Which workspace package a job runs for, when a `packages:` job made it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackageRef {
    /// The `packages:` job's own key.
    pub job: String,
    /// Relative to the clone.
    pub dir: String,
    pub name: String,
}

/// What a `task-cache:` job's key reads from the commit, besides the job
/// itself and the artifacts it is handed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskCacheSpec {
    /// Filter globs relative to the clone (`!` excludes, in order).
    pub inputs: Vec<String>,
}

impl JobTemplate {
    /// Whether a commit that changed `changed_paths` should run this job.
    /// Unknown paths always run it.
    pub fn affected_by(&self, changed_paths: Option<&[String]>) -> bool {
        match changed_paths {
            Some(paths) if !self.paths.is_empty() => paths
                .iter()
                .any(|p| crate::glob::filter_matches(&self.paths, p)),
            _ => true,
        }
    }

    /// Whether the job runs, given how the jobs it needs went.
    pub fn should_run(&self, env: &dyn crate::expr::Env) -> bool {
        crate::expr::should_run(self.condition.as_ref(), env)
    }
}

/// How a finished job went, as `needs.<job>.result` reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobResult {
    Success,
    Failure,
    Skipped,
}

impl JobResult {
    pub fn as_str(self) -> &'static str {
        match self {
            JobResult::Success => "success",
            JobResult::Failure => "failure",
            JobResult::Skipped => "skipped",
        }
    }
}

/// The results and outputs of finished jobs, by job key.
#[derive(Debug, Clone, Default)]
pub struct NeedsValues {
    pub results: HashMap<String, JobResult>,
    pub outputs: HashMap<String, BTreeMap<String, String>>,
}

impl NeedsValues {
    pub fn result(&self, job: &str) -> JobResult {
        self.results.get(job).copied().unwrap_or(JobResult::Skipped)
    }

    pub fn output(&self, job: &str, name: &str) -> Option<String> {
        self.outputs.get(job)?.get(name).cloned()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Triggers {
    pub push: Option<TriggerFilter>,
    pub pull_request: Option<TriggerFilter>,
    /// When scheduled runs happen, in UTC.
    pub schedule: Vec<crate::cron::Cron>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TriggerFilter {
    pub branches: Vec<String>,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Event {
    #[default]
    Push,
    PullRequest,
    Schedule,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Event::Push => "push",
            Event::PullRequest => "pull-request",
            Event::Schedule => "schedule",
        }
    }
}

impl Triggers {
    /// Whether any of the pipeline's schedules falls on `minute`.
    pub fn due(&self, minute: crate::cron::Minute) -> bool {
        self.schedule.iter().any(|c| c.matches(minute))
    }

    /// Whether an `event` on `branch` that changed `changed_paths` starts a
    /// run. `None` for the paths means they are not known (a first push, a
    /// force push), which never filters a run out.
    pub fn matches(&self, event: Event, branch: &str, changed_paths: Option<&[String]>) -> bool {
        let filter = match event {
            Event::Push => &self.push,
            Event::PullRequest => &self.pull_request,
            // A scheduled run was started because a schedule matched; it
            // has no branch or path filter of its own.
            Event::Schedule => return !self.schedule.is_empty(),
        };
        let Some(filter) = filter else {
            return false;
        };
        if !filter.branches.is_empty() && !crate::glob::filter_matches(&filter.branches, branch) {
            return false;
        }
        match changed_paths {
            Some(paths) if !filter.paths.is_empty() => paths
                .iter()
                .any(|p| crate::glob::filter_matches(&filter.paths, p)),
            _ => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceSpec {
    /// A hash of the clone and dependency settings: jobs with equal keys
    /// share a snapshot, and caches key on it.
    pub key: String,
    pub clone: Option<CloneSpec>,
    pub deps: Vec<DepSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CloneSpec {
    pub depth: CloneDepth,
    pub into: String,
    pub submodules: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloneDepth {
    Shallow(u32),
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DepSpec {
    pub ecosystem: Ecosystem,
    /// Absolute guest path of the lockfile's directory.
    pub dir: String,
    /// pnpm: limit the install to these importers' closure.
    pub only: Option<Vec<String>>,
    /// pip: the lock, relative to `dir`. Left out of the serialised form
    /// when unset, so workspaces that do not name one keep their keys.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Ecosystem {
    Pnpm,
    Go,
    Cargo,
    Pip,
    Composer,
}

impl Ecosystem {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "pnpm" => Some(Ecosystem::Pnpm),
            "go" => Some(Ecosystem::Go),
            "cargo" => Some(Ecosystem::Cargo),
            "pip" => Some(Ecosystem::Pip),
            "composer" => Some(Ecosystem::Composer),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Ecosystem::Pnpm => "pnpm",
            Ecosystem::Go => "go",
            Ecosystem::Cargo => "cargo",
            Ecosystem::Pip => "pip",
            Ecosystem::Composer => "composer",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlannedJob {
    /// The job key, plus the matrix values for an expanded job:
    /// `typescript[web]`, `test[linux,strict]`.
    pub id: String,
    /// The key the job was written under.
    pub key: String,
    pub display_name: String,
    pub matrix: BTreeMap<String, String>,
    pub tool: ToolRef,
    pub action: Action,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    /// `env:` values that read `${{ secrets.<name> }}`, filled in when the
    /// job starts so a secret never enters the plan or its report.
    pub secret_env: Vec<SecretEnv>,
    /// `tools:`: run by name from an `env:` job's script.
    pub tools: Vec<ToolRef>,
    /// Index into [`Plan::workspaces`].
    pub workspace: usize,
    pub changes: ChangePolicy,
    /// Names the job may write to `$IWCI_OUTPUT`.
    pub outputs: Vec<String>,
    #[serde(with = "duration_secs")]
    pub timeout: Duration,
    pub memory_bytes: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub caches: Vec<CacheSpec>,
    /// Which of its environment's own caches the job keeps (`env-cache:`).
    pub env_cache: EnvCachePolicy,
    /// Whether the job may reach the public internet (`network:`, default
    /// on). Its loopback is always there.
    #[serde(skip_serializing_if = "is_true")]
    pub network: bool,
    /// `artifacts:`: absolute, normalised guest paths whose files are handed
    /// to the jobs that need this one once it passes.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<String>,
    /// `downloads:`: files uploaded for people to download after the job.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads: Option<DownloadSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageRef>,
    /// `task-cache:`: skipped, with what a passing run kept, when nothing
    /// it reads has changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_cache: Option<TaskCacheSpec>,
    /// `services:` (with `workspace.services`), in the order they start.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<PlannedService>,
    /// Set for a job that runs on a connected cloud account: the runner
    /// hands it to the app instead of running it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud: Option<CloudSpec>,
    /// `connections:`, `ssh-keys:`, `env-from:` and the resources its
    /// `env:` values (and its services') read.
    #[serde(skip_serializing_if = "JobAccess::is_empty")]
    pub access: JobAccess,
}

/// A job's `downloads:`, checked: what it keeps, for how long, and after
/// which outcomes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DownloadSpec {
    /// Absolute, normalised guest paths, as `artifacts:` has them.
    pub paths: Vec<String>,
    /// How long the files are kept, in seconds.
    pub retention_secs: u64,
    pub when: DownloadWhen,
}

/// Which outcomes of a job keep its downloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadWhen {
    /// Only a job that passes (the default).
    Success,
    /// Only a job that fails: a test report, a crash dump.
    Failure,
    Always,
}

impl DownloadWhen {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "success" => Some(Self::Success),
            "failure" => Some(Self::Failure),
            "always" => Some(Self::Always),
            _ => None,
        }
    }

    /// Whether a job that `passed` (or did not) keeps its downloads.
    pub fn keeps(self, passed: bool) -> bool {
        match self {
            Self::Success => passed,
            Self::Failure => !passed,
            Self::Always => true,
        }
    }
}

/// A program the runner starts in the job's isolate before the job, and
/// stops when the job ends.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlannedService {
    /// Its key, which also resolves to the job's loopback.
    pub name: String,
    /// An `env:` (with a script) or a tool (with arguments).
    pub tool: ToolRef,
    pub action: Action,
    pub env: Vec<(String, String)>,
    /// `env:` values that read secrets, filled in when the job starts.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub secret_env: Vec<SecretEnv>,
    pub ready: Readiness,
}

/// When a service counts as ready, and how long the job waits for that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Readiness {
    pub check: ReadyCheck,
    #[serde(with = "duration_secs")]
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReadyCheck {
    /// As soon as it has started.
    Started,
    /// Something in the job listens on this port of the loopback. Nothing
    /// connects to find out.
    Port { port: u16 },
    /// A line of its output matches this regular expression.
    Log { pattern: String },
    /// This script, run in the service's environment, exits 0.
    Command { script: String },
}

/// An `env:` value with secrets in it: text (already substituted) and
/// secret names, joined when the job starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecretEnv {
    pub key: String,
    pub parts: Vec<SecretPart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretPart {
    Text(String),
    Secret(String),
    /// `${{ resources.<name>.<output> }}`: an infrastructure resource's
    /// output, lent to the run by the app. Never empty: a value the run was
    /// not given fails the job.
    Resource {
        name: String,
        output: String,
    },
}

impl SecretEnv {
    /// The value, with each secret looked up by `secret` (a missing one is
    /// empty and its name is returned too) and each resource output by
    /// `resource`, whose error (an output the run was not lent) is the
    /// job's failure.
    pub fn fill(
        &self,
        secret: impl Fn(&str) -> Option<String>,
        resource: impl Fn(&str, &str) -> Result<String, String>,
    ) -> Result<(String, Vec<String>), String> {
        let mut value = String::new();
        let mut missing = Vec::new();
        for part in &self.parts {
            match part {
                SecretPart::Text(t) => value.push_str(t),
                SecretPart::Secret(name) => match secret(name) {
                    Some(v) => value.push_str(&v),
                    None => missing.push(name.clone()),
                },
                SecretPart::Resource { name, output } => value.push_str(&resource(name, output)?),
            }
        }
        Ok((value, missing))
    }
}

/// Which of an environment's caches a job keeps (`env-cache:`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvCachePolicy {
    /// Every cache the environment declares (the default).
    #[default]
    All,
    /// None of them (`env-cache: false`).
    Off,
    /// Every one but these (`env-cache: { <name>: false }`).
    Except(Vec<String>),
}

impl EnvCachePolicy {
    /// Whether the job keeps the environment's cache `name`.
    pub fn keeps(&self, name: &str) -> bool {
        match self {
            EnvCachePolicy::All => true,
            EnvCachePolicy::Off => false,
            EnvCachePolicy::Except(off) => !off.iter().any(|n| n == name),
        }
    }
}

/// One `cache:` entry of a job, with every expression substituted except
/// `${{ hashFiles(...) }}`, which reads the commit and is filled in by
/// [`crate::expand_hash_files`] when the job runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CacheSpec {
    pub key: String,
    pub restore_keys: Vec<String>,
    /// Absolute, normalised guest paths.
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Action {
    /// Run the tool with these arguments.
    Args { args: Vec<String> },
    /// Run this script with the environment's shell.
    Script { script: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ToolRef {
    Builtin {
        name: String,
        version: String,
    },
    Repo {
        name: String,
        version: String,
    },
    Env {
        name: String,
        version: String,
    },
    /// A job with `cloud:`: no tool on the runner, the machine's image is
    /// its environment. Never resolved.
    Cloud {
        provider: String,
        #[serde(rename = "cloud-kind")]
        kind: String,
    },
}

impl ToolRef {
    pub fn is_env(&self) -> bool {
        matches!(self, ToolRef::Env { .. })
    }

    pub fn is_cloud(&self) -> bool {
        matches!(self, ToolRef::Cloud { .. })
    }

    pub fn name(&self) -> &str {
        match self {
            ToolRef::Builtin { name, .. }
            | ToolRef::Repo { name, .. }
            | ToolRef::Env { name, .. } => name,
            ToolRef::Cloud { provider, .. } => provider,
        }
    }
}

impl std::fmt::Display for ToolRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolRef::Builtin { name, version } => write!(f, "builtin:{name}@{version}"),
            ToolRef::Repo { name, version } => write!(f, "repo:{name}@{version}"),
            ToolRef::Env { name, version } => write!(f, "env:{name}@{version}"),
            ToolRef::Cloud { provider, kind } => write!(f, "cloud:{provider}/{kind}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ChangePolicy {
    Ignore,
    Fail,
    Commit { message: String },
}

mod duration_secs {
    use serde::Serializer;
    use std::time::Duration;

    pub fn serialize<S: Serializer>(d: &Duration, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(d.as_secs())
    }
}

fn is_true(value: &bool) -> bool {
    *value
}
