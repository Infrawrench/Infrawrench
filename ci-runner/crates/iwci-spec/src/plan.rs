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
    #[serde(skip)]
    pub(crate) raw: Option<crate::raw::Job>,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Ecosystem {
    Pnpm,
    Go,
    Cargo,
}

impl Ecosystem {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "pnpm" => Some(Ecosystem::Pnpm),
            "go" => Some(Ecosystem::Go),
            "cargo" => Some(Ecosystem::Cargo),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Ecosystem::Pnpm => "pnpm",
            Ecosystem::Go => "go",
            Ecosystem::Cargo => "cargo",
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
}

impl SecretEnv {
    /// The value, with each secret looked up by `secret`; a missing one is
    /// empty and its name is returned too.
    pub fn fill(&self, secret: impl Fn(&str) -> Option<String>) -> (String, Vec<String>) {
        let mut value = String::new();
        let mut missing = Vec::new();
        for part in &self.parts {
            match part {
                SecretPart::Text(t) => value.push_str(t),
                SecretPart::Secret(name) => match secret(name) {
                    Some(v) => value.push_str(&v),
                    None => missing.push(name.clone()),
                },
            }
        }
        (value, missing)
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
    Builtin { name: String, version: String },
    Repo { name: String, version: String },
    Env { name: String, version: String },
}

impl ToolRef {
    pub fn is_env(&self) -> bool {
        matches!(self, ToolRef::Env { .. })
    }

    pub fn name(&self) -> &str {
        match self {
            ToolRef::Builtin { name, .. }
            | ToolRef::Repo { name, .. }
            | ToolRef::Env { name, .. } => name,
        }
    }
}

impl std::fmt::Display for ToolRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolRef::Builtin { name, version } => write!(f, "builtin:{name}@{version}"),
            ToolRef::Repo { name, version } => write!(f, "repo:{name}@{version}"),
            ToolRef::Env { name, version } => write!(f, "env:{name}@{version}"),
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
