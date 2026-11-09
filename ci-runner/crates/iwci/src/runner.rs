//! Running a commit's pipelines: what `iwci run` and `iwci serve` share.
//!
//! A [`Runner`] holds what outlives a run (the Wasmer runtime and its
//! compiled modules, the git, download and install caches, the object
//! store, the job slots and memory budget); a [`RunRequest`] says which
//! commit to run and for whom.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iwci_deps::cache::LayerCache;
use iwci_deps::fetch::Fetcher;
use iwci_git::{Auth, GitCache, Identity, RemoteCache};
use iwci_runtime::Runtime;
use iwci_spec::{Context, Event};
use iwci_store::{ObjectStore, RepoId, Resolved};
use iwci_vfs::SnapshotBuilder;
use serde::{Deserialize, Serialize};

use crate::adapters::caches::{StoreCaches, owner_from_url};
use crate::adapters::tools::{RuntimeExecutor, StoreTools};
use crate::adapters::workspace::{GitCommitter, GitWorkspaces};
use crate::schedule::{self, MemoryBudget, RunReport, Slots, Tools, Workspaces};

/// Where pipeline files live in a repository.
pub const PIPELINE_DIR: &str = ".infrawrench/ci";

pub struct Runner {
    pub runtime: Arc<Runtime>,
    pub store: Arc<dyn ObjectStore>,
    pub git: GitCache,
    pub fetcher: Arc<dyn Fetcher>,
    pub layers: Arc<LayerCache>,
    /// vCPUs, and how many jobs share each one.
    pub cpus: usize,
    pub jobs_per_cpu: usize,
    /// Shared by every run in the process (the server); `None` for a
    /// single `iwci run`, which is limited by `cpus` alone.
    pub slots: Option<Arc<Slots>>,
    pub memory: Option<Arc<MemoryBudget>>,
    pub author: Identity,
    /// The storage quota for an owner that a request does not set one for.
    pub default_storage_quota: Option<u64>,
}

/// One run: a repository at a commit or a branch.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct RunRequest {
    /// The clone URL.
    pub repo: String,
    /// The commit to run. Without one, `branch`'s head as it is now.
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// `push` (the default) or `pull-request`.
    #[serde(default)]
    pub event: Option<String>,
    /// The commit to diff against for `paths:` and `changed()`.
    #[serde(default)]
    pub base: Option<String>,
    /// Defaults to the repository's name from its URL.
    #[serde(default)]
    pub repo_id: Option<String>,
    /// Who storage and usage count against. Defaults to the organisation
    /// in the URL (`github.com-<org>`).
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
    /// A pipeline file's text, run instead of the repository's own.
    #[serde(default)]
    pub pipeline: Option<String>,
    /// The owner's storage quota, for a caller that knows the owner's
    /// plan: bytes, or a size such as `"10GiB"`. Overrides the runner's
    /// default for this run's saves.
    #[serde(default, deserialize_with = "size_or_bytes")]
    pub storage_quota: Option<u64>,
    /// A token for a private repository. Never stored or echoed.
    #[serde(default)]
    pub token: Option<String>,
    /// Secrets for `env:` values that read `${{ secrets.<name> }}`. Never
    /// stored, echoed or put in a plan; masked in output and reports.
    #[serde(default)]
    pub secrets: Secrets,
    /// Variables for `${{ vars.<name> }}`. Not secret.
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
    /// The ref `sha` is reachable from, when it is not `refs/heads/<branch>`:
    /// `refs/pull/12/head` for a pull request from a fork, whose commits only
    /// the base repository's pull ref carries.
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
}

/// A run's secrets. Its `Debug` lists names only, so logging a request
/// cannot print a value.
#[derive(Clone, Default, Deserialize)]
#[serde(transparent)]
pub struct Secrets(pub BTreeMap<String, String>);

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set().entries(self.0.keys()).finish()
    }
}

/// The most secrets, or variables, one run may carry.
pub const MAX_NAMED_VALUES: usize = 200;
/// The largest one secret or variable may be.
pub const MAX_NAMED_VALUE_BYTES: usize = 48 << 10;

/// Checks the names and sizes of a request's secrets or variables.
fn check_named(kind: &str, values: &BTreeMap<String, String>) -> Result<(), String> {
    if values.len() > MAX_NAMED_VALUES {
        return Err(format!(
            "{} {kind}; the limit is {MAX_NAMED_VALUES}",
            values.len()
        ));
    }
    for (name, value) in values {
        let ok = !name.is_empty()
            && name.len() <= 128
            && (name.as_bytes()[0].is_ascii_alphabetic() || name.as_bytes()[0] == b'_')
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !ok {
            return Err(format!("`{name}` is not a valid name for {kind}"));
        }
        if value.len() > MAX_NAMED_VALUE_BYTES || value.contains('\0') {
            return Err(format!(
                "{kind} `{name}` is over {} KiB or contains a NUL byte",
                MAX_NAMED_VALUE_BYTES >> 10
            ));
        }
    }
    Ok(())
}

/// A size given as a number of bytes or as text such as `10GiB`.
pub fn parse_quota(text: &str) -> Option<u64> {
    text.trim()
        .parse::<u64>()
        .ok()
        .or_else(|| iwci_spec::parse_size(text))
}

fn size_or_bytes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Size {
        Bytes(u64),
        Text(String),
    }
    match Option::<Size>::deserialize(d)? {
        None => Ok(None),
        Some(Size::Bytes(n)) => Ok(Some(n)),
        Some(Size::Text(t)) => parse_quota(&t).map(Some).ok_or_else(|| {
            serde::de::Error::custom(format!("`{t}` is not a size; use bytes or e.g. `10GiB`"))
        }),
    }
}

impl RunRequest {
    fn event(&self) -> Result<Event, String> {
        match self.event.as_deref() {
            None | Some("push") => Ok(Event::Push),
            Some("pull-request") => Ok(Event::PullRequest),
            Some("schedule") => Ok(Event::Schedule),
            Some(other) => Err(format!(
                "event is `push`, `pull-request` or `schedule`, not `{other}`"
            )),
        }
    }

    pub fn owner(&self) -> Result<RepoId, String> {
        let owner = self
            .owner
            .clone()
            .or_else(|| owner_from_url(&self.repo))
            .unwrap_or_else(|| "local".to_string());
        RepoId::new(&owner).map_err(|e| format!("owner: {e}"))
    }

    pub fn repo_id(&self) -> Result<RepoId, String> {
        let id = match &self.repo_id {
            Some(id) => id.clone(),
            None => {
                let name = self
                    .repo
                    .trim_end_matches('/')
                    .rsplit(['/', ':'])
                    .next()
                    .unwrap_or("repo");
                let name = name
                    .strip_suffix(".git")
                    .unwrap_or(name)
                    .to_ascii_lowercase();
                name.chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect()
            }
        };
        RepoId::new(&id).map_err(|e| format!("repo-id: {e}"))
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum PipelineOutput {
    Ran { file: String, report: RunReport },
    NotTriggered { file: String, name: String },
    Invalid { file: String, errors: Vec<String> },
}

/// What a run used, for billing. A job is charged for its wall time at
/// `1 / jobs_per_cpu` of a vCPU (the share of a core its slot is), and for
/// the memory it reserved over that time.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub jobs: u64,
    pub wall_seconds: f64,
    pub vcpu_seconds: f64,
    pub memory_gib_seconds: f64,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.jobs += other.jobs;
        self.wall_seconds += other.wall_seconds;
        self.vcpu_seconds += other.vcpu_seconds;
        self.memory_gib_seconds += other.memory_gib_seconds;
    }
}

#[derive(Debug, Serialize)]
pub struct RunOutput {
    pub commit: String,
    pub branch: String,
    pub owner: String,
    pub repo_id: String,
    pub passed: bool,
    pub pipelines: Vec<PipelineOutput>,
    pub usage: Usage,
    pub started_at: u64,
    pub finished_at: u64,
}

#[derive(Debug, Serialize)]
pub struct PrepareOutput {
    pub commit: String,
    pub pipelines: Vec<String>,
    pub installs: Vec<String>,
    pub tools: Vec<String>,
    pub problems: Vec<String>,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The commit being run, fetched, and the pieces resolved from a request.
struct Target {
    remote: RemoteCache,
    sha: String,
    branch: String,
    /// Where `sha` is fetched from.
    git_ref: String,
    auth: Option<Auth>,
    pipelines: Vec<(String, String)>,
    owner: RepoId,
    repo_id: RepoId,
    event: Event,
}

impl Runner {
    fn resolve(&self, req: &RunRequest) -> Result<Target, String> {
        check_named("secrets", &req.secrets.0)?;
        check_named("vars", &req.vars)?;
        let event = req.event()?;
        let owner = req.owner()?;
        let repo_id = req.repo_id()?;
        let auth = req
            .token
            .clone()
            .or_else(|| std::env::var("IWCI_GIT_TOKEN").ok())
            .map(Auth::token);
        let remote = self.git.remote(&req.repo).map_err(|e| e.to_string())?;
        let branch = req.branch.clone().unwrap_or_else(|| "main".to_string());
        let git_ref = fetch_ref(req.git_ref.as_deref(), &branch)?;
        let sha = match &req.sha {
            Some(sha) => {
                let sha = sha.to_ascii_lowercase();
                remote
                    .fetch_commit(
                        &sha,
                        iwci_git::Depth::Shallow(1),
                        auth.as_ref(),
                        Some(&git_ref),
                    )
                    .map_err(|e| format!("fetch {sha}: {e}"))?;
                sha
            }
            None => {
                remote
                    .fetch_branch(&branch, iwci_git::Depth::Shallow(1), auth.as_ref())
                    .map_err(|e| format!("fetch branch {branch}: {e}"))?
                    .commit
            }
        };
        let pipelines = match &req.pipeline {
            Some(text) => vec![("request".to_string(), text.clone())],
            None => read_pipelines(&remote, &sha)?,
        };
        Ok(Target {
            remote,
            sha,
            branch,
            git_ref,
            auth,
            pipelines,
            owner,
            repo_id,
            event,
        })
    }

    fn parts(
        &self,
        r: &Target,
        req: &RunRequest,
    ) -> (StoreTools, RuntimeExecutor, GitWorkspaces, GitCommitter) {
        let tools = StoreTools {
            catalog: iwci_store::Catalog::new(self.store.clone()),
            repo: r.repo_id.clone(),
        };
        let executor = RuntimeExecutor {
            runtime: self.runtime.clone(),
        };
        let workspaces = GitWorkspaces {
            remote: r.remote.clone(),
            commit: r.sha.clone(),
            auth: r.auth.clone(),
            ref_hint: Some(r.git_ref.clone()),
            fetcher: self.fetcher.clone(),
            layers: self.layers.clone(),
            threads: self.cpus,
        };
        let mut author = self.author.clone();
        author.time = now_secs() as i64;
        let committer = GitCommitter {
            remote: r.remote.clone(),
            head: r.sha.clone(),
            identity: author,
        };
        let _ = req;
        (tools, executor, workspaces, committer)
    }

    /// The commit a request resolves to and its pipeline files, without
    /// running anything; for reading a repository's schedules.
    pub fn branch_pipelines(
        &self,
        req: &RunRequest,
    ) -> Result<(String, Vec<(String, String)>), String> {
        let r = self.resolve(req)?;
        Ok((r.sha, r.pipelines))
    }

    /// Runs every pipeline of the requested commit that its event triggers.
    pub fn run(&self, req: &RunRequest) -> Result<RunOutput, String> {
        self.run_with_logs(req, None)
    }

    /// [`Runner::run`], sending live log events to `logs`.
    pub fn run_with_logs(
        &self,
        req: &RunRequest,
        logs: Option<schedule::LogFn>,
    ) -> Result<RunOutput, String> {
        let started_at = now_secs();
        let r = self.resolve(req)?;
        let changed_paths = match &req.base {
            Some(base) => {
                r.remote
                    .fetch_commit(base, iwci_git::Depth::Shallow(1), r.auth.as_ref(), None)
                    .map_err(|e| format!("fetch base {base}: {e}"))?;
                Some(
                    r.remote
                        .changed_paths(base, &r.sha)
                        .map_err(|e| e.to_string())?,
                )
            }
            None => None,
        };
        let ctx = Context {
            commit_sha: r.sha.clone(),
            branch: r.branch.clone(),
            repo_id: r.repo_id.as_str().to_string(),
            event: r.event,
            vars: req.vars.clone(),
        };
        let (tools, executor, workspaces, committer) = self.parts(&r, req);
        let default_branch = req
            .default_branch
            .clone()
            .unwrap_or_else(|| "main".to_string());
        let options = schedule::Options {
            // With shared slots the slots are the limit; without, `cpus`.
            parallelism: self.slots.as_ref().map_or(self.cpus, |s| s.total()),
            changed_paths: changed_paths.clone(),
            base_env: vec![
                ("CI".into(), "true".into()),
                ("IWCI".into(), "true".into()),
                ("IWCI_COMMIT".into(), r.sha.clone()),
                ("IWCI_BRANCH".into(), r.branch.clone()),
                ("IWCI_REPO_ID".into(), r.repo_id.as_str().to_string()),
            ],
            memory: self.memory.clone(),
            secrets: req.secrets.0.clone(),
            caches: Some(Arc::new(StoreCaches::new(
                self.store.clone(),
                &r.owner,
                &r.repo_id,
                &r.branch,
                &default_branch,
                r.event,
                req.storage_quota.or(self.default_storage_quota),
            ))),
            logs: logs.clone(),
            slots: self.slots.clone(),
        };

        let mut pipelines = Vec::new();
        let mut passed = true;
        let mut usage = Usage::default();
        for (file, text) in &r.pipelines {
            let plan = match iwci_spec::parse(text, &ctx) {
                Ok(plan) => plan,
                Err(errors) => {
                    passed = false;
                    pipelines.push(PipelineOutput::Invalid {
                        file: file.clone(),
                        errors: errors
                            .0
                            .iter()
                            .map(|e| format!("{}: {}", e.path, e.message))
                            .collect(),
                    });
                    continue;
                }
            };
            if !plan
                .triggers
                .matches(r.event, &r.branch, changed_paths.as_deref())
            {
                pipelines.push(PipelineOutput::NotTriggered {
                    file: file.clone(),
                    name: plan.name,
                });
                continue;
            }
            let report = schedule::run(&plan, &workspaces, &tools, &executor, &committer, &options);
            passed &= report.passed();
            usage.add(&self.usage_of(&report));
            pipelines.push(PipelineOutput::Ran {
                file: file.clone(),
                report,
            });
        }
        Ok(RunOutput {
            commit: r.sha,
            branch: r.branch,
            owner: r.owner.as_str().to_string(),
            repo_id: r.repo_id.as_str().to_string(),
            passed,
            pipelines,
            usage,
            started_at,
            finished_at: now_secs(),
        })
    }

    /// What a report's jobs used. Only jobs that ran are charged.
    pub fn usage_of(&self, report: &RunReport) -> Usage {
        let mut usage = Usage::default();
        let share = self.jobs_per_cpu.max(1) as f64;
        for job in report.jobs.iter().filter(|j| j.execution.is_some()) {
            let secs = Duration::from_millis(job.duration_ms).as_secs_f64();
            usage.jobs += 1;
            usage.wall_seconds += secs;
            usage.vcpu_seconds += secs / share;
            usage.memory_gib_seconds += secs * job.memory_mib as f64 / 1024.0;
        }
        usage
    }

    /// Warms everything a run of this commit would need, without running a
    /// job: the clone, every workspace's dependency installs (into the
    /// install cache), and every tool (fetched and compiled). A run that
    /// follows starts from cache.
    pub fn prepare(&self, req: &RunRequest) -> Result<PrepareOutput, String> {
        let r = self.resolve(req)?;
        let ctx = Context {
            commit_sha: r.sha.clone(),
            branch: r.branch.clone(),
            repo_id: r.repo_id.as_str().to_string(),
            event: r.event,
            vars: req.vars.clone(),
        };
        let (tools, _, workspaces, _) = self.parts(&r, req);
        let mut out = PrepareOutput {
            commit: r.sha.clone(),
            pipelines: Vec::new(),
            installs: Vec::new(),
            tools: Vec::new(),
            problems: Vec::new(),
        };
        let mut seen_ws = std::collections::HashSet::new();
        let mut seen_tools = std::collections::HashSet::new();
        for (file, text) in &r.pipelines {
            let plan = match iwci_spec::parse(text, &ctx) {
                Ok(plan) => plan,
                Err(e) => {
                    out.problems.push(format!("{file}: {e}"));
                    continue;
                }
            };
            if !plan.triggers.matches(r.event, &r.branch, None) {
                continue;
            }
            out.pipelines.push(plan.name.clone());
            for ws in &plan.workspaces {
                if !seen_ws.insert(ws.key.clone()) || ws.deps.is_empty() {
                    continue;
                }
                match workspaces.build(ws) {
                    Ok(built) => out.installs.extend(built.installs),
                    Err(e) => out.problems.push(format!("workspace: {e}")),
                }
            }
            for template in &plan.jobs {
                for tool in std::iter::once(&template.tool).chain(&template.tools) {
                    let name = tool.to_string();
                    if !seen_tools.insert(name.clone()) {
                        continue;
                    }
                    match tools.resolve(tool).and_then(|r| self.warm(&r)) {
                        Ok(()) => out.tools.push(name),
                        Err(e) => out.problems.push(format!("{name}: {e}")),
                    }
                }
            }
        }
        Ok(out)
    }
}

/// What [`Runner::warm_published`] warmed, and what it could not.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WarmOutput {
    pub warmed: Vec<String>,
    pub problems: Vec<String>,
}

impl Runner {
    /// Downloads and compiles every published builtin and environment, so
    /// no job pays for it: the newest release of each `major.minor` (which
    /// covers every pin a pipeline can write, `@1`, `@1.27` or `@1.27.3`
    /// of the newest patch). Blobs land in the store's disk cache and
    /// compiled code in the module cache, on disk and in memory. A fresh
    /// catalog each time, so a newly published version is seen.
    /// Repository tools are left to their first use: there can be any
    /// number, and each belongs to one repository.
    pub fn warm_published(&self) -> WarmOutput {
        let mut out = WarmOutput::default();
        let catalog = iwci_store::Catalog::new(self.store.clone());
        let repo = RepoId::new("warm").expect("a valid id");
        for (kind, label) in [
            (iwci_store::ToolKind::Builtin, "builtin"),
            (iwci_store::ToolKind::Env, "env"),
        ] {
            let names = match catalog.names(kind) {
                Ok(names) => names,
                Err(e) => {
                    out.problems.push(format!("listing {label}s: {e}"));
                    continue;
                }
            };
            for name in names {
                let versions = match catalog.versions(kind, &name, &repo) {
                    Ok(v) => v,
                    Err(e) => {
                        out.problems.push(format!("{label}:{name}: {e}"));
                        continue;
                    }
                };
                let mut seen = std::collections::HashSet::new();
                for version in versions.iter().filter(|v| v.pre.is_empty()) {
                    if !seen.insert((version.major, version.minor)) {
                        continue;
                    }
                    let reference = format!("{label}:{name}@{version}");
                    let warmed = reference
                        .parse::<iwci_store::ToolRef>()
                        .map_err(|e| e.to_string())
                        .and_then(|r| catalog.resolve(&r, &repo).map_err(|e| e.to_string()))
                        .and_then(|resolved| self.warm(&resolved));
                    match warmed {
                        Ok(()) => out.warmed.push(reference),
                        Err(e) => out.problems.push(format!("{reference}: {e}")),
                    }
                }
            }
        }
        out
    }

    /// Compiles a resolved tool (or every command of an environment) into
    /// the module cache, in memory and on disk; its bytes are already in the
    /// store's disk cache by the time it resolves.
    pub fn warm(&self, resolved: &Resolved) -> Result<(), String> {
        match resolved {
            Resolved::Tool {
                manifest, module, ..
            } => {
                let sha: [u8; 32] = hex::decode(&module.sha256)
                    .ok()
                    .and_then(|b| b.try_into().ok())
                    .ok_or("bad module hash")?;
                let module = iwci_runtime::WasmModule::with_sha256(
                    manifest.name.clone(),
                    sha,
                    module.bytes.clone(),
                );
                self.runtime.prepare(&module).map_err(|e| e.to_string())
            }
            Resolved::Env {
                manifest, packages, ..
            } => {
                let webcs: Vec<_> = manifest
                    .packages
                    .iter()
                    .zip(packages)
                    .map(|(p, b)| {
                        iwci_runtime::WebcPackage::new(
                            p.name.clone(),
                            p.version.to_string(),
                            b.bytes.clone(),
                        )
                    })
                    .collect();
                self.runtime
                    .prepare_environment(&webcs)
                    .map_err(|e| e.to_string())
            }
        }
    }
}

/// Every `.yml`/`.yaml` directly in the commit's pipeline directory, read
/// through a checkout into a scratch snapshot (the cache has no work tree).
fn read_pipelines(remote: &RemoteCache, sha: &str) -> Result<Vec<(String, String)>, String> {
    let scratch = SnapshotBuilder::new();
    remote
        .checkout_into(sha, &scratch, "/src")
        .map_err(|e| format!("checkout: {e}"))?;
    let snapshot = scratch.freeze();
    let dir = format!("/src/{PIPELINE_DIR}");
    let mut out = Vec::new();
    for path in snapshot.list_files(&dir) {
        let name = path.display().to_string();
        let rel = name.trim_start_matches("/src/").to_string();
        if path.parent().map(|p| p.display().to_string()) != Some(dir.clone()) {
            continue;
        }
        if !(rel.ends_with(".yml") || rel.ends_with(".yaml")) {
            continue;
        }
        let bytes = snapshot.read(&path).map_err(|e| e.to_string())?;
        out.push((
            rel,
            String::from_utf8(bytes).map_err(|_| format!("{name} is not UTF-8"))?,
        ));
    }
    Ok(out)
}

/// The ref a run's commit is fetched from: the request's `ref` (a pull
/// request's `refs/pull/<n>/head`, which carries a fork's commits), or the
/// branch's own.
fn fetch_ref(requested: Option<&str>, branch: &str) -> Result<String, String> {
    match requested {
        Some(r) if r.starts_with("refs/") => Ok(r.to_string()),
        Some(r) => Err(format!(
            "`ref` is a full ref such as refs/pull/12/head, not `{r}`"
        )),
        None => Ok(format!("refs/heads/{branch}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pull_request_is_fetched_from_its_ref_and_a_push_from_its_branch() {
        let req: RunRequest = serde_json::from_str(
            r#"{"repo": "r", "branch": "pull/12", "ref": "refs/pull/12/head"}"#,
        )
        .unwrap();
        assert_eq!(
            fetch_ref(req.git_ref.as_deref(), "pull/12").unwrap(),
            "refs/pull/12/head"
        );
        assert_eq!(fetch_ref(None, "main").unwrap(), "refs/heads/main");
        assert!(fetch_ref(Some("pull/12/head"), "x").is_err());
    }

    #[test]
    fn a_request_takes_its_quota_in_bytes_or_as_a_size() {
        let parse = |q: &str| {
            serde_json::from_str::<RunRequest>(&format!(
                "{{\"repo\": \"r\", \"storage-quota\": {q}}}"
            ))
        };
        assert_eq!(parse("1048576").unwrap().storage_quota, Some(1 << 20));
        assert_eq!(parse("\"10GiB\"").unwrap().storage_quota, Some(10 << 30));
        assert_eq!(parse("\"512MiB\"").unwrap().storage_quota, Some(512 << 20));
        assert!(
            parse("\"lots\"")
                .unwrap_err()
                .to_string()
                .contains("not a size")
        );
        assert_eq!(
            serde_json::from_str::<RunRequest>("{\"repo\": \"r\"}")
                .unwrap()
                .storage_quota,
            None
        );
    }

    #[test]
    fn owner_and_repo_come_from_the_url_unless_given() {
        let req = RunRequest {
            repo: "https://github.com/Acme/Web.git".into(),
            ..Default::default()
        };
        assert_eq!(req.owner().unwrap().as_str(), "github.com-acme");
        assert_eq!(req.repo_id().unwrap().as_str(), "web");
        let req = RunRequest {
            owner: Some("team-7".into()),
            repo_id: Some("site".into()),
            ..req
        };
        assert_eq!(req.owner().unwrap().as_str(), "team-7");
        assert_eq!(req.repo_id().unwrap().as_str(), "site");
    }
}
