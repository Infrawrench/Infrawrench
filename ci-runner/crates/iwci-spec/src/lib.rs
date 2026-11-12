//! The CI pipeline file (`.infrawrench/ci/*.yml`): parsing, validation,
//! matrix expansion and `${{ }}` interpolation.
//!
//! [`parse`] takes the file and the commit it runs for and returns a
//! [`Plan`] with nothing left to interpret: every matrix entry is its own
//! job, every expression is substituted, every default is filled in, and
//! jobs that need the same clone and dependencies point at one shared
//! [`WorkspaceSpec`]. Validation collects every problem it finds rather than
//! stopping at the first, so one push shows a user all of them.
//!
//! The file format is documented in `ci-runner/README.md` and described for
//! editors by `ci-runner/schema/ci.schema.json`; `tests/schema.rs` keeps the
//! JSON Schema's keys in step with the structs in [`raw`].

pub mod cron;
pub mod expr;
mod glob;
mod interp;
pub mod packages;
pub mod plan;
pub mod raw;
mod shell;
mod units;
pub mod workspace;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

use sha2::Digest;

pub use glob::PathFilter;
pub use plan::*;

/// Where a parsed file runs: substituted for `${{ commit.* }}` and
/// `${{ repo.* }}`.
#[derive(Debug, Clone, Default)]
pub struct Context {
    pub commit_sha: String,
    pub branch: String,
    pub repo_id: String,
    pub event: Event,
    /// The repository's variables (organisation ones overridden by the
    /// repository's), for `${{ vars.<name> }}`. Not secret: they are
    /// substituted into the plan like any other name.
    pub vars: std::collections::BTreeMap<String, String>,
    /// The repository's workspace packages, for `packages:` jobs.
    pub packages: PackagesSource,
}

/// What `packages:` jobs expand over.
#[derive(Debug, Clone, Default)]
#[allow(clippy::large_enum_variant)]
pub enum PackagesSource {
    /// Not looked at (`iwci validate`): each `packages:` job is checked
    /// with one placeholder package.
    #[default]
    Unknown,
    /// The repository declares no workspace.
    Missing,
    /// Its workspace files could not be read.
    Invalid(String),
    Found(std::sync::Arc<workspace::WorkspacePackages>),
}

impl PackagesSource {
    /// From what [`workspace::discover`] made of a commit.
    pub fn from_discovery(found: Result<Option<workspace::WorkspacePackages>, String>) -> Self {
        match found {
            Ok(Some(ws)) => PackagesSource::Found(std::sync::Arc::new(ws)),
            Ok(None) => PackagesSource::Missing,
            Err(e) => PackagesSource::Invalid(e),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecError {
    /// Where in the file, as a dotted path (`jobs.typescript.cwd`). Empty
    /// for a YAML syntax error, whose message carries the line instead.
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecErrors(pub Vec<SpecError>);

impl fmt::Display for SpecErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, e) in self.0.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            if e.path.is_empty() {
                write!(f, "{}", e.message)?;
            } else {
                write!(f, "{}: {}", e.path, e.message)?;
            }
        }
        Ok(())
    }
}

impl std::error::Error for SpecErrors {}

/// Limits that keep one pipeline file from asking for an unbounded run.
/// A turbo-style graph of a monorepo is several jobs per package (build,
/// bundle, test, format): 180 packages already make about 700.
pub const MAX_JOBS: usize = 1024;
pub const MAX_MATRIX_ENTRIES: usize = 64;
pub const DEFAULT_TIMEOUT_SECS: u64 = 10 * 60;
pub const MAX_TIMEOUT_SECS: u64 = 60 * 60;
pub const DEFAULT_MEMORY: u64 = 2 << 30;
/// What the run's shared `/tmp/workflow` holds unless `scratch:` says.
pub const DEFAULT_SCRATCH: u64 = 1 << 30;
/// Where every job of a run finds the scratch directory they share.
pub const SCRATCH_PATH: &str = "/tmp/workflow";
/// The most `tools:` one job may list.
pub const MAX_TOOLS: usize = 16;
/// The most services one job may start.
pub const MAX_SERVICES: usize = 8;
/// How long a job waits for a service's `ready:` unless it says.
pub const DEFAULT_READY_TIMEOUT_SECS: u64 = 60;
pub const MIN_MEMORY: u64 = 16 << 20;
pub const MAX_MEMORY: u64 = 16 << 30;
pub const DEFAULT_CLONE_INTO: &str = "/app";

/// The most `cache:` entries one job may have.
pub const MAX_CACHES: usize = 16;
/// The most paths one job's `artifacts:` may list.
pub const MAX_ARTIFACT_PATHS: usize = 64;
/// The most paths one job's `downloads:` may list.
pub const MAX_DOWNLOAD_PATHS: usize = 64;
/// How long downloads are kept unless `retention:` says.
pub const DEFAULT_DOWNLOAD_RETENTION_SECS: u64 = 30 * 86_400;
/// The longest `retention:` a pipeline may ask for. A runner may hold
/// downloads to less (`--download-max-retention`).
pub const MAX_DOWNLOAD_RETENTION_SECS: u64 = 365 * 86_400;

/// Fills in every `${{ hashFiles('glob', ...) }}` left in a cache key, with
/// `hash` turning a list of globs (relative to the clone) into a digest.
pub fn expand_hash_files(
    key: &str,
    mut hash: impl FnMut(&[String]) -> String,
) -> Result<String, String> {
    let mut out = String::with_capacity(key.len());
    let mut rest = key;
    while let Some(start) = rest.find("${{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 3..];
        let end = after.find("}}").ok_or("`${{` is never closed with `}}`")?;
        let globs = interp::hash_files_globs(after[..end].trim())?;
        out.push_str(&hash(&globs));
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// `512MiB`, `4GiB` and the like, as `memory:` takes them.
pub fn parse_size(text: &str) -> Option<u64> {
    units::parse_bytes(text)
}

/// A duration such as `90s`, `10m` or `1h`, in seconds.
pub fn parse_duration_secs(text: &str) -> Option<u64> {
    units::parse_duration_secs(text)
}

/// Parses and validates a pipeline file for one commit.
pub fn parse(yaml: &str, ctx: &Context) -> Result<Plan, SpecErrors> {
    let mut raw: raw::Pipeline = serde_yaml_ng::from_str(yaml).map_err(|e| {
        SpecErrors(vec![SpecError {
            path: String::new(),
            message: e.to_string(),
        }])
    })?;
    let mut expand_errors = Vec::new();
    let generated = packages::expand(&mut raw, &ctx.packages, &mut expand_errors);
    // Each job carries the services it starts with from here on, so a job
    // expanded later (a deferred matrix) needs nothing but itself.
    let base_services = raw
        .workspace
        .as_ref()
        .and_then(|w| w.services.clone())
        .unwrap_or_default();
    for job in raw.jobs.values_mut() {
        let services = effective_services(&base_services, job.services.as_ref());
        job.services = Some(raw::Services::Map(services));
    }
    let decls: HashMap<String, JobDecl> = raw
        .jobs
        .iter()
        .map(|(k, j)| {
            (
                k.clone(),
                JobDecl {
                    outputs: j.outputs.clone(),
                    has_matrix: j.matrix.is_some(),
                },
            )
        })
        .collect();
    let mut v = Validator {
        errors: expand_errors,
        ctx,
        decls: &decls,
        generated: &generated,
    };
    let plan = v.pipeline(raw);
    if v.errors.is_empty() {
        Ok(plan)
    } else {
        Err(SpecErrors(v.errors))
    }
}

/// The services a job starts: `workspace.services`, with the job's own of
/// the same name in their place and its others after them, or none at all
/// for `services: false`.
fn effective_services(
    base: &indexmap::IndexMap<String, raw::Service>,
    job: Option<&raw::Services>,
) -> indexmap::IndexMap<String, raw::Service> {
    match job {
        None | Some(raw::Services::Enabled(true)) => base.clone(),
        Some(raw::Services::Enabled(false)) => indexmap::IndexMap::new(),
        Some(raw::Services::Map(own)) => {
            let mut all = base.clone();
            for (name, service) in own {
                all.insert(name.clone(), service.clone());
            }
            all
        }
    }
}

fn is_name(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_')
}

fn is_version_req(s: &str) -> bool {
    let (core, pre) = match s.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (s, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = (1..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()));
    // A prerelease only makes sense on a full version: `7.1.0-beta.1`.
    let pre_ok = pre.is_none_or(|pre| {
        parts.len() == 3
            && !pre.is_empty()
            && pre
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    });
    core_ok && pre_ok
}

fn is_env_key(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// Parses `using:`.
fn parse_tool(using: &str) -> Result<ToolRef, String> {
    let Some((kind, rest)) = using.split_once(':') else {
        return Err(format!(
            "`{using}` is not a tool reference; write `builtin:<name>@<version>`, `repo:<name>@<version>` or `env:<name>@<version>`"
        ));
    };
    let Some((name, version)) = rest.split_once('@') else {
        return Err(format!(
            "`{using}` has no version; pin one, e.g. `{kind}:{rest}@1`, so a new release cannot change what a commit runs"
        ));
    };
    if !is_name(name) {
        return Err(format!(
            "`{name}` is not a valid tool name (lowercase letters, digits, `-` and `_`, up to 64)"
        ));
    }
    if !is_version_req(version) {
        return Err(format!(
            "`{version}` is not a version; use `7`, `7.1` or `7.1.3`"
        ));
    }
    let (name, version) = (name.to_string(), version.to_string());
    match kind {
        "builtin" => Ok(ToolRef::Builtin { name, version }),
        "repo" => Ok(ToolRef::Repo { name, version }),
        "env" => Ok(ToolRef::Env { name, version }),
        other => Err(format!(
            "unknown tool kind `{other}`; expected `builtin`, `repo` or `env`"
        )),
    }
}

/// One expanded matrix entry: axis name to value, in axis order. The list
/// shorthand uses the axis name `""`, which only `${{ matrix }}` reads.
type MatrixEntry = Vec<(String, String)>;

/// What a job declares, which other jobs' expressions are checked against.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct JobDecl {
    pub outputs: Vec<String>,
    pub has_matrix: bool,
}

struct Validator<'a> {
    errors: Vec<SpecError>,
    ctx: &'a Context,
    decls: &'a HashMap<String, JobDecl>,
    /// The jobs `packages:` jobs became, by key.
    generated: &'a packages::Generated,
}

/// The parts of a job that do not depend on its matrix entry or on other
/// jobs' outputs, checked once.
struct JobStatic {
    tool: Option<ToolRef>,
    tools: Vec<ToolRef>,
    timeout: u64,
    memory: u64,
    changes: ChangePolicy,
    /// The services that passed their checks, substituted per entry.
    services: Vec<ServiceStatic>,
    /// `downloads:`' retention and `when:`, when it has any.
    downloads: Option<(u64, DownloadWhen)>,
}

/// A service's parts that do not depend on the matrix entry.
struct ServiceStatic {
    name: String,
    raw: raw::Service,
    tool: ToolRef,
    timeout: u64,
}

/// The shape of a matrix, which decides how `${{ matrix }}` reads.
enum Shape {
    None,
    List,
    Axes,
    /// From another job's output, not known yet.
    Pending,
}

fn is_output_name(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// Expands a template whose jobs depend on other jobs' outputs.
pub(crate) fn instantiate(
    plan: &Plan,
    template: &JobTemplate,
    needs: &NeedsValues,
) -> Result<Vec<PlannedJob>, SpecErrors> {
    let raw = template
        .raw
        .as_ref()
        .expect("deferred templates keep their source");
    let generated: packages::Generated = template
        .package
        .iter()
        .map(|p| (template.key.clone(), p.clone()))
        .collect();
    let mut v = Validator {
        errors: Vec::new(),
        ctx: &plan.ctx,
        decls: &plan.decls,
        generated: &generated,
    };
    let st = v.job_static(
        &format!("jobs.{}", template.key),
        raw,
        &plan.workspaces[template.workspace],
    );
    let (jobs, _) = v.instances(
        &template.key,
        raw,
        &st,
        template.workspace,
        &plan.workspaces,
        Some(needs),
    );
    if v.errors.is_empty() {
        Ok(jobs)
    } else {
        Err(SpecErrors(v.errors))
    }
}

impl Validator<'_> {
    fn error(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.errors.push(SpecError {
            path: path.into(),
            message: message.into(),
        });
    }

    fn pipeline(&mut self, raw: raw::Pipeline) -> Plan {
        if raw.name.trim().is_empty() {
            self.error("name", "must not be empty");
        }
        let triggers = self.triggers(raw.on);
        let base_ws = raw.workspace.unwrap_or_default();
        let base_clone = Some(base_ws.clone.unwrap_or_default());
        let base_deps = base_ws.deps.unwrap_or_default();

        if raw.jobs.is_empty() {
            self.error("jobs", "a pipeline needs at least one job");
        }
        for (key, job) in &raw.jobs {
            for need in &job.needs {
                if need == key {
                    self.error(format!("jobs.{key}.needs"), "a job cannot need itself");
                } else if !raw.jobs.contains_key(need) {
                    self.error(
                        format!("jobs.{key}.needs"),
                        format!("no job named `{need}`"),
                    );
                }
            }
            let mut seen = HashSet::new();
            for output in &job.outputs {
                if !is_output_name(output) {
                    self.error(
                        format!("jobs.{key}.outputs"),
                        format!("`{output}` is not a valid output name"),
                    );
                }
                if !seen.insert(output) {
                    self.error(
                        format!("jobs.{key}.outputs"),
                        format!("lists `{output}` twice"),
                    );
                }
            }
            if !job.outputs.is_empty() && job.matrix.is_some() {
                // Every entry would write the same names, and which one won
                // would depend on timing.
                self.error(
                    format!("jobs.{key}.outputs"),
                    "a job with a matrix cannot declare outputs",
                );
            }
        }
        if let Some(cycle) = find_cycle(&raw.jobs) {
            self.error(
                "jobs",
                format!("`needs` forms a cycle: {}", cycle.join(" -> ")),
            );
        }

        let mut workspaces: Vec<WorkspaceSpec> = Vec::new();
        let mut jobs: Vec<JobTemplate> = Vec::new();
        for (key, job) in raw.jobs {
            let path = format!("jobs.{key}");
            let package = self.generated.get(&key).cloned();
            if package.is_none() && !is_name(&key) {
                self.error(
                    &path,
                    "job keys use lowercase letters, digits, `-` and `_`, up to 64",
                );
            }
            let clone = match &job.clone {
                None | Some(raw::Override::Disabled(true)) => base_clone.clone(),
                Some(raw::Override::Disabled(false)) => None,
                Some(raw::Override::Value(c)) => Some(c.clone()),
            };
            let deps = match &job.deps {
                None | Some(raw::Override::Disabled(true)) => base_deps.clone(),
                Some(raw::Override::Disabled(false)) => Vec::new(),
                Some(raw::Override::Value(d)) => d.clone(),
            };
            let ws_path = if job.clone.is_some() || job.deps.is_some() {
                path.clone()
            } else {
                "workspace".to_string()
            };
            let workspace = self.workspace(&ws_path, clone.as_ref(), &deps);
            let ws_index = match workspaces.iter().position(|w| w.key == workspace.key) {
                Some(i) => i,
                None => {
                    workspaces.push(workspace);
                    workspaces.len() - 1
                }
            };

            let condition = job
                .condition
                .as_ref()
                .and_then(|src| match expr::parse(src) {
                    Ok(e) => {
                        for name in e.names() {
                            if let Err(msg) = interp::check_name(name, &job.needs, self.decls) {
                                self.error(format!("{path}.if"), msg);
                            }
                        }
                        Some(e)
                    }
                    Err(msg) => {
                        self.error(format!("{path}.if"), msg);
                        None
                    }
                });
            let st = self.job_static(&path, &job, &workspaces[ws_index]);
            let (instances, deferred) =
                self.instances(&key, &job, &st, ws_index, &workspaces, None);
            let path_tools = st.tools.clone();
            let Some(tool) = st.tool else { continue };
            jobs.push(JobTemplate {
                key: key.clone(),
                needs: job.needs.clone(),
                condition_source: job.condition.clone(),
                condition,
                outputs: job.outputs.clone(),
                workspace: ws_index,
                paths: job.paths.clone(),
                tool,
                tools: path_tools,
                instances: (!deferred).then_some(instances),
                package,
                raw: deferred.then(|| job.clone()),
            });
        }
        let count: usize = jobs
            .iter()
            .map(|t| t.instances.as_ref().map_or(0, Vec::len))
            .sum();
        if count > MAX_JOBS {
            self.error(
                "jobs",
                format!("expands to {count} jobs; the limit is {MAX_JOBS}"),
            );
        }

        let scratch_bytes = match &raw.scratch {
            None => DEFAULT_SCRATCH,
            Some(text) => match units::parse_bytes(text) {
                Some(b) if (MIN_MEMORY..=MAX_MEMORY).contains(&b) => b,
                Some(_) => {
                    self.error("scratch", "must be between 16MiB and 16GiB");
                    DEFAULT_SCRATCH
                }
                None => {
                    self.error(
                        "scratch",
                        format!("`{text}` is not a size; use e.g. `512MiB` or `4GiB`"),
                    );
                    DEFAULT_SCRATCH
                }
            },
        };

        Plan {
            name: raw.name,
            triggers,
            workspaces,
            jobs,
            scratch_bytes,
            decls: self.decls.clone(),
            ctx: self.ctx.clone(),
        }
    }

    fn triggers(&mut self, raw: Option<raw::Triggers>) -> Triggers {
        let Some(raw) = raw else {
            // No `on:` means every push, which is what a first pipeline file
            // almost always wants.
            return Triggers {
                push: Some(TriggerFilter::default()),
                pull_request: None,
                schedule: Vec::new(),
            };
        };
        let mut filter = |name: &str, f: Option<raw::TriggerFilter>| {
            f.map(|f| {
                for (field, globs) in [("branches", &f.branches), ("paths", &f.paths)] {
                    for g in globs {
                        if let Err(e) = glob::check_filter(g) {
                            self.error(format!("on.{name}.{field}"), e);
                        }
                    }
                }
                TriggerFilter {
                    branches: f.branches,
                    paths: f.paths,
                }
            })
        };
        let push = filter("push", raw.push);
        let pull_request = filter("pull-request", raw.pull_request);
        let mut schedule = Vec::new();
        if raw.schedule.len() > 16 {
            self.error("on.schedule", "lists more than 16 schedules");
        }
        for (i, entry) in raw.schedule.iter().enumerate() {
            match cron::Cron::parse(&entry.cron) {
                Ok(c) => schedule.push(c),
                Err(e) => self.error(format!("on.schedule[{i}].cron"), e),
            }
        }
        if push.is_none() && pull_request.is_none() && raw.schedule.is_empty() {
            self.error("on", "lists no events, so the pipeline would never run");
        }
        Triggers {
            push,
            pull_request,
            schedule,
        }
    }

    fn workspace(
        &mut self,
        path: &str,
        clone: Option<&raw::Clone>,
        deps: &[raw::Dep],
    ) -> WorkspaceSpec {
        let clone = clone.map(|c| {
            let depth = match &c.depth {
                None => CloneDepth::Shallow(1),
                Some(raw::Depth::Commits(0)) => {
                    self.error(format!("{path}.clone.depth"), "must be at least 1");
                    CloneDepth::Shallow(1)
                }
                Some(raw::Depth::Commits(n)) => CloneDepth::Shallow(*n),
                Some(raw::Depth::Named(s)) if s == "full" => CloneDepth::Full,
                Some(raw::Depth::Named(s)) => {
                    self.error(
                        format!("{path}.clone.depth"),
                        format!("`{s}` is not a depth; use a number of commits or `full`"),
                    );
                    CloneDepth::Shallow(1)
                }
            };
            let into = c
                .into
                .clone()
                .unwrap_or_else(|| DEFAULT_CLONE_INTO.to_string());
            let into = match normalise_abs(&into) {
                Some(p) if p != "/" => p,
                _ => {
                    self.error(
                        format!("{path}.clone.into"),
                        format!("`{into}` must be an absolute path below `/`, without `..`"),
                    );
                    DEFAULT_CLONE_INTO.to_string()
                }
            };
            CloneSpec {
                depth,
                into,
                submodules: c.submodules.unwrap_or(false),
            }
        });

        let mut specs = Vec::new();
        for (i, dep) in deps.iter().enumerate() {
            let dep_path = format!("{path}.deps[{i}]");
            let (name, options) = match dep {
                raw::Dep::Name(n) => (n.clone(), raw::DepOptions::default()),
                raw::Dep::Configured(map) if map.len() == 1 => {
                    let (n, o) = map.iter().next().expect("one entry");
                    (n.clone(), o.clone())
                }
                raw::Dep::Configured(_) => {
                    self.error(
                        &dep_path,
                        "write one ecosystem per entry, e.g. `- go: { dir: tools }`",
                    );
                    continue;
                }
            };
            let Some(ecosystem) = Ecosystem::parse(&name) else {
                self.error(
                    &dep_path,
                    format!(
                        "unknown ecosystem `{name}`; expected `pnpm`, `go`, `cargo`, `pip` or `composer`"
                    ),
                );
                continue;
            };
            let Some(clone) = &clone else {
                self.error(
                    &dep_path,
                    "dependencies need a clone to read the lockfile from",
                );
                continue;
            };
            let dir = match options.dir.as_deref() {
                None | Some("") | Some(".") => Some(clone.into.clone()),
                Some(rel) => join_relative(&clone.into, rel),
            };
            let Some(dir) = dir else {
                self.error(
                    format!("{dep_path}.dir"),
                    "must be a relative path inside the clone, without `..`",
                );
                continue;
            };
            if options.only.is_some() && ecosystem != Ecosystem::Pnpm {
                self.error(format!("{dep_path}.only"), "only applies to pnpm");
            }
            let file = match options.file {
                Some(_) if ecosystem != Ecosystem::Pip => {
                    self.error(format!("{dep_path}.file"), "file applies only to pip");
                    None
                }
                Some(file) if join_relative(&dir, &file).is_none() || file.is_empty() => {
                    self.error(
                        format!("{dep_path}.file"),
                        "must be a relative path inside the clone, without `..`",
                    );
                    None
                }
                file => file,
            };
            let spec = DepSpec {
                ecosystem,
                dir,
                only: options.only,
                file,
            };
            if specs.contains(&spec) {
                self.error(&dep_path, "listed twice");
                continue;
            }
            specs.push(spec);
        }

        let key = {
            let canonical = serde_json::to_vec(&(&clone, &specs)).expect("serialisable");
            hex::encode(&sha2::Sha256::digest(&canonical)[..12])
        };
        WorkspaceSpec {
            key,
            clone,
            deps: specs,
        }
    }

    /// Expands `raw` into its entries. A `${{ }}` matrix is substituted
    /// first and read as JSON; while its value is not known yet the result
    /// is one placeholder entry and [`Shape::Pending`].
    fn matrix(
        &mut self,
        path: &str,
        raw: Option<&raw::Matrix>,
        scope: &interp::Scope<'_>,
    ) -> (Vec<MatrixEntry>, Shape) {
        let path = format!("{path}.matrix");
        let Some(raw) = raw else {
            return (vec![Vec::new()], Shape::None);
        };
        let resolved;
        let from_output = matches!(raw, raw::Matrix::Expr(_));
        let raw = match raw {
            raw::Matrix::Expr(text) => {
                match self.dynamic(&path, text, scope) {
                    Some(json) => {
                        match serde_json::from_str::<raw::Matrix>(&json) {
                            Ok(raw::Matrix::Expr(_)) | Err(_) => {
                                self.error(&path, format!("`{text}` must hold a JSON list or object of axes, not `{}`", short(&json)));
                                return (vec![Vec::new()], Shape::Pending);
                            }
                            Ok(m) => {
                                resolved = m;
                                &resolved
                            }
                        }
                    }
                    None => return (vec![Vec::new()], Shape::Pending),
                }
            }
            m => m,
        };
        let (entries, shape) = match raw {
            raw::Matrix::Expr(_) => unreachable!("resolved above"),
            raw::Matrix::List(values) => {
                let values: Vec<String> = values.iter().map(raw::Scalar::as_text).collect();
                // An output may say "nothing to do" with an empty list.
                if !(from_output && values.is_empty()) {
                    self.check_axis(&path, &values);
                }
                (
                    values
                        .into_iter()
                        .map(|v| vec![(String::new(), v)])
                        .collect::<Vec<_>>(),
                    Shape::List,
                )
            }
            raw::Matrix::Axes(axes) => {
                let mut names = Vec::new();
                let mut product: Vec<MatrixEntry> = vec![Vec::new()];
                let mut excludes = Vec::new();
                let mut pending = false;
                for (axis, values) in axes {
                    let values: Vec<String> = match (axis.as_str(), values) {
                        ("exclude", raw::AxisOrExclude::Exclude(list)) => {
                            excludes = list.clone();
                            continue;
                        }
                        ("exclude", _) => {
                            self.error(format!("{path}.exclude"), "is a list of combinations to drop, e.g. `- { os: windows, mode: strict }`");
                            continue;
                        }
                        (_, raw::AxisOrExclude::Exclude(_)) => {
                            self.error(format!("{path}.{axis}"), "an axis is a list of values");
                            continue;
                        }
                        (_, raw::AxisOrExclude::Axis(values)) => {
                            let values: Vec<String> =
                                values.iter().map(raw::Scalar::as_text).collect();
                            if !from_output || !values.is_empty() {
                                self.check_axis(&format!("{path}.{axis}"), &values);
                            }
                            values
                        }
                        (_, raw::AxisOrExclude::Expr(text)) => {
                            match self.dynamic(&format!("{path}.{axis}"), text, scope) {
                                None => {
                                    pending = true;
                                    vec!["pending".to_string()]
                                }
                                Some(json) => match serde_json::from_str::<Vec<raw::Scalar>>(&json)
                                {
                                    Ok(values) => {
                                        let values: Vec<String> =
                                            values.iter().map(raw::Scalar::as_text).collect();
                                        if !values.is_empty() {
                                            self.check_axis(&format!("{path}.{axis}"), &values);
                                        }
                                        values
                                    }
                                    Err(_) => {
                                        self.error(
                                            format!("{path}.{axis}"),
                                            format!(
                                                "`{text}` must hold a JSON list, not `{}`",
                                                short(&json)
                                            ),
                                        );
                                        continue;
                                    }
                                },
                            }
                        }
                    };
                    if !is_name(axis) {
                        self.error(
                            format!("{path}.{axis}"),
                            "axis names use lowercase letters, digits, `-` and `_`",
                        );
                    }
                    names.push(axis.clone());
                    product = product
                        .into_iter()
                        .flat_map(|entry| {
                            values.iter().map(move |v| {
                                let mut e = entry.clone();
                                e.push((axis.clone(), v.clone()));
                                e
                            })
                        })
                        .collect();
                }
                if names.is_empty() {
                    self.error(&path, "needs at least one axis");
                    return (vec![Vec::new()], Shape::None);
                }
                if pending {
                    return (vec![Vec::new()], Shape::Pending);
                }
                for (i, exclude) in excludes.iter().enumerate() {
                    for k in exclude.keys() {
                        if !names.contains(k) {
                            self.error(
                                format!("{path}.exclude[{i}]"),
                                format!("no axis named `{k}`"),
                            );
                        }
                    }
                }
                let before = product.len();
                product.retain(|entry| {
                    !excludes.iter().any(|ex| {
                        ex.iter().all(|(k, v)| {
                            entry.iter().any(|(ek, ev)| ek == k && *ev == v.as_text())
                        })
                    })
                });
                if product.is_empty() && before > 0 {
                    self.error(&path, "`exclude` removes every combination");
                }
                (product, Shape::Axes)
            }
        };
        if entries.len() > MAX_MATRIX_ENTRIES {
            self.error(
                &path,
                format!(
                    "expands to {} entries; the limit is {MAX_MATRIX_ENTRIES}",
                    entries.len()
                ),
            );
        }
        if entries.is_empty() {
            // A dynamic matrix may legitimately come back empty (nothing
            // changed): the job then has no entries and simply does not run.
            return (Vec::new(), shape);
        }
        (entries, shape)
    }

    /// Substitutes a `${{ }}` matrix value. `None` while it reads outputs
    /// that do not exist yet.
    fn dynamic(&mut self, path: &str, text: &str, scope: &interp::Scope<'_>) -> Option<String> {
        let trimmed = text.trim();
        if !(trimmed.starts_with("${{") && trimmed.ends_with("}}")) {
            self.error(
                path,
                format!("`{text}` is neither a list nor `${{{{ needs.<job>.outputs.<name> }}}}`"),
            );
            return Some("[]".into());
        }
        let before = scope.deferred.get();
        let value = match interp::substitute(trimmed, scope) {
            Ok(v) => v,
            Err(e) => {
                self.error(path, e);
                return Some("[]".into());
            }
        };
        if scope.deferred.get() && !before {
            return None;
        }
        Some(value)
    }

    fn check_axis(&mut self, path: &str, values: &[String]) {
        if values.is_empty() {
            self.error(path, "needs at least one value");
        }
        let mut seen = HashSet::new();
        for v in values {
            if !seen.insert(v) {
                self.error(path, format!("lists `{v}` twice"));
            }
            if v.contains([',', '[', ']']) || v.trim() != v || v.is_empty() {
                // These would make the expanded job id ambiguous.
                self.error(
                    path,
                    format!("`{v}` cannot be empty, padded, or contain `,`, `[` or `]`"),
                );
            }
        }
    }

    fn job_static(&mut self, path: &str, job: &raw::Job, workspace: &WorkspaceSpec) -> JobStatic {
        let tool = match parse_tool(&job.using) {
            Ok(t) => Some(t),
            Err(e) => {
                self.error(format!("{path}.using"), e);
                None
            }
        };
        let timeout = match &job.timeout {
            None => DEFAULT_TIMEOUT_SECS,
            Some(t) => match units::parse_duration_secs(t) {
                Some(s) if (1..=MAX_TIMEOUT_SECS).contains(&s) => s,
                Some(_) => {
                    self.error(format!("{path}.timeout"), "must be between 1s and 60m");
                    DEFAULT_TIMEOUT_SECS
                }
                None => {
                    self.error(
                        format!("{path}.timeout"),
                        format!("`{t}` is not a duration; use e.g. `90s`, `10m` or `1h`"),
                    );
                    DEFAULT_TIMEOUT_SECS
                }
            },
        };
        let memory = match &job.memory {
            None => DEFAULT_MEMORY,
            Some(m) => match units::parse_bytes(m) {
                Some(b) if (MIN_MEMORY..=MAX_MEMORY).contains(&b) => b,
                Some(_) => {
                    self.error(format!("{path}.memory"), "must be between 16MiB and 16GiB");
                    DEFAULT_MEMORY
                }
                None => {
                    self.error(
                        format!("{path}.memory"),
                        format!("`{m}` is not a size; use e.g. `512MiB` or `4GiB`"),
                    );
                    DEFAULT_MEMORY
                }
            },
        };
        let changes = match &job.changes {
            None => ChangePolicy::Ignore,
            Some(raw::Changes::Mode(m)) if m == "ignore" => ChangePolicy::Ignore,
            Some(raw::Changes::Mode(m)) if m == "fail" => ChangePolicy::Fail,
            Some(raw::Changes::Mode(m)) => {
                self.error(
                    format!("{path}.changes"),
                    format!("`{m}` is not a policy; use `ignore`, `fail` or `commit: <message>`"),
                );
                ChangePolicy::Ignore
            }
            Some(raw::Changes::Commit(c)) => {
                if c.commit.trim().is_empty() || c.commit.len() > 4096 {
                    self.error(
                        format!("{path}.changes.commit"),
                        "needs a commit message of 1 to 4096 characters",
                    );
                }
                ChangePolicy::Commit {
                    message: c.commit.clone(),
                }
            }
        };
        if !matches!(changes, ChangePolicy::Ignore) && workspace.clone.is_none() {
            self.error(
                format!("{path}.changes"),
                "a job without a clone has no repository to change",
            );
        }
        for p in &job.paths {
            if let Err(e) = glob::check_filter(p) {
                self.error(format!("{path}.paths"), e);
            }
        }
        for k in job.env.keys() {
            if !is_env_key(k) {
                self.error(
                    format!("{path}.env.{k}"),
                    "is not a valid environment variable name",
                );
            } else if k.starts_with("IWCI_") {
                self.error(
                    format!("{path}.env.{k}"),
                    "`IWCI_` variables are set by the runner",
                );
            }
        }
        match (&tool, &job.args, &job.run) {
            (Some(t), _, None) if t.is_env() => {
                self.error(
                    path,
                    format!(
                        "`{}` is an environment; give the job a `run:` script",
                        job.using
                    ),
                );
            }
            (Some(t), Some(_), _) if t.is_env() => {
                self.error(
                    format!("{path}.args"),
                    "an environment job takes a `run:` script, not `args:`",
                );
            }
            (Some(t), _, Some(_)) if !t.is_env() => {
                self.error(format!("{path}.run"), format!("`{}` is a tool; give it `args:`, or use an `env:` environment for a script", job.using));
            }
            _ => {}
        }
        let caches = job.cache.as_ref().map(|c| c.as_slice()).unwrap_or_default();
        if caches.len() > MAX_CACHES {
            self.error(
                format!("{path}.cache"),
                format!("lists {} caches; the limit is {MAX_CACHES}", caches.len()),
            );
        }
        for (i, entry) in caches.iter().enumerate() {
            let at = format!("{path}.cache[{i}]");
            if entry.key.trim().is_empty() || entry.key.len() > 512 {
                self.error(format!("{at}.key"), "needs a key of 1 to 512 characters");
            }
            if entry.restore_keys.len() > 8
                || entry.restore_keys.iter().any(|k| k.trim().is_empty())
            {
                self.error(
                    format!("{at}.restore-keys"),
                    "takes up to 8 non-empty prefixes",
                );
            }
            if entry.paths.is_empty() || entry.paths.len() > 64 {
                self.error(format!("{at}.paths"), "needs 1 to 64 paths");
            }
            if workspace.clone.is_none() && entry.paths.iter().any(|p| !p.starts_with('/')) {
                self.error(
                    format!("{at}.paths"),
                    "a job without a clone can only cache absolute paths",
                );
            }
        }
        if job.artifacts.len() > MAX_ARTIFACT_PATHS
            || job.artifacts.iter().any(|p| p.trim().is_empty())
        {
            self.error(
                format!("{path}.artifacts"),
                format!("takes up to {MAX_ARTIFACT_PATHS} non-empty paths"),
            );
        }
        if workspace.clone.is_none() && job.artifacts.iter().any(|p| !p.starts_with('/')) {
            self.error(
                format!("{path}.artifacts"),
                "a job without a clone can only keep absolute paths",
            );
        }
        if matches!(
            job.task_cache,
            Some(raw::TaskCache::Inputs(_)) | Some(raw::TaskCache::Enabled(true))
        ) {
            let at = format!("{path}.task-cache");
            if workspace.clone.is_none() {
                self.error(
                    &at,
                    "a job without a clone has no files to key its cache on",
                );
            }
            let reads_secret = |env: &indexmap::IndexMap<String, String>| {
                env.values()
                    .any(|v| matches!(interp::secret_parts(v), Ok(Some(_))))
            };
            if reads_secret(&job.env) {
                // Its result could depend on a secret the key cannot hold.
                self.error(&at, "a job that reads secrets cannot be task-cached");
            } else if let Some(raw::Services::Map(services)) = &job.services
                && services.values().any(|s| reads_secret(&s.env))
            {
                self.error(
                    &at,
                    "a job whose services read secrets cannot be task-cached",
                );
            }
            if matches!(changes, ChangePolicy::Commit { .. }) {
                self.error(&at, "a job that commits its changes cannot be task-cached");
            }
        }
        let mut tools: Vec<ToolRef> = Vec::new();
        if !job.tools.is_empty() && tool.as_ref().is_some_and(|t| !t.is_env()) {
            self.error(
                format!("{path}.tools"),
                "puts tools on an environment's PATH, so it needs `using: env:...`",
            );
        }
        if job.tools.len() > MAX_TOOLS {
            self.error(
                format!("{path}.tools"),
                format!("lists {} tools; the limit is {MAX_TOOLS}", job.tools.len()),
            );
        }
        for text in &job.tools {
            match parse_tool(text) {
                Ok(t) if t.is_env() => self.error(
                    format!("{path}.tools"),
                    format!(
                        "`{text}` is an environment; `tools:` takes `builtin:` and `repo:` tools"
                    ),
                ),
                Ok(t) => {
                    if tools.iter().any(|o| o.name() == t.name()) {
                        self.error(
                            format!("{path}.tools"),
                            format!(
                                "lists two tools named `{}`; each becomes a command of that name",
                                t.name()
                            ),
                        );
                    }
                    tools.push(t);
                }
                Err(e) => self.error(format!("{path}.tools"), e),
            }
        }
        let services = match &job.services {
            Some(raw::Services::Map(services)) => self.services(path, services, timeout),
            _ => Vec::new(),
        };
        let downloads = job
            .downloads
            .as_ref()
            .map(|d| self.downloads(path, &d.0, job, workspace));
        JobStatic {
            tool,
            tools,
            timeout,
            memory,
            changes,
            services,
            downloads,
        }
    }

    /// Checks a job's `downloads:` and returns its retention and `when:`.
    fn downloads(
        &mut self,
        path: &str,
        downloads: &raw::Downloads,
        job: &raw::Job,
        workspace: &WorkspaceSpec,
    ) -> (u64, DownloadWhen) {
        let at = format!("{path}.downloads");
        if downloads.paths.is_empty()
            || downloads.paths.len() > MAX_DOWNLOAD_PATHS
            || downloads.paths.iter().any(|p| p.trim().is_empty())
        {
            self.error(
                format!("{at}.paths"),
                format!("needs 1 to {MAX_DOWNLOAD_PATHS} non-empty paths"),
            );
        }
        if workspace.clone.is_none() && downloads.paths.iter().any(|p| !p.starts_with('/')) {
            self.error(
                format!("{at}.paths"),
                "a job without a clone can only keep absolute paths",
            );
        }
        let retention = match &downloads.retention {
            None => DEFAULT_DOWNLOAD_RETENTION_SECS,
            Some(r) => match units::parse_duration_secs(r) {
                Some(s) if (3600..=MAX_DOWNLOAD_RETENTION_SECS).contains(&s) => s,
                Some(_) => {
                    self.error(format!("{at}.retention"), "must be between 1h and 365d");
                    DEFAULT_DOWNLOAD_RETENTION_SECS
                }
                None => {
                    self.error(
                        format!("{at}.retention"),
                        format!("`{r}` is not a duration; use e.g. `12h`, `7d` or `30d`"),
                    );
                    DEFAULT_DOWNLOAD_RETENTION_SECS
                }
            },
        };
        let when = match &downloads.when {
            None => DownloadWhen::Success,
            Some(w) => DownloadWhen::parse(w).unwrap_or_else(|| {
                self.error(
                    format!("{at}.when"),
                    format!("is `success`, `failure` or `always`, not `{w}`"),
                );
                DownloadWhen::Success
            }),
        };
        // A hit does not run the job, so it would have nothing to upload.
        if matches!(
            job.task_cache,
            Some(raw::TaskCache::Inputs(_)) | Some(raw::TaskCache::Enabled(true))
        ) {
            self.error(
                format!("{path}.task-cache"),
                "a job with `downloads:` cannot be task-cached: a hit does not run it, so it would have nothing to upload",
            );
        }
        (retention, when)
    }

    /// Checks a job's services (`workspace.services` already merged in)
    /// and returns the ones that can be planned.
    fn services(
        &mut self,
        path: &str,
        services: &indexmap::IndexMap<String, raw::Service>,
        job_timeout: u64,
    ) -> Vec<ServiceStatic> {
        if services.len() > MAX_SERVICES {
            self.error(
                format!("{path}.services"),
                format!(
                    "starts {} services; the limit is {MAX_SERVICES}",
                    services.len()
                ),
            );
        }
        let mut out = Vec::new();
        for (name, service) in services {
            let at = format!("{path}.services.{name}");
            let errors = self.errors.len();
            if !is_name(name) {
                self.error(
                    &at,
                    "service names use lowercase letters, digits, `-` and `_`, up to 64",
                );
            } else if name == "localhost" {
                self.error(&at, "`localhost` already names the job's loopback");
            }
            let tool = match parse_tool(&service.using) {
                Ok(t) => Some(t),
                Err(e) => {
                    self.error(format!("{at}.using"), e);
                    None
                }
            };
            match (&tool, &service.args, &service.run) {
                (Some(t), _, None) if t.is_env() => self.error(
                    &at,
                    format!(
                        "`{}` is an environment; give the service a `run:` script that starts it",
                        service.using
                    ),
                ),
                (Some(t), Some(_), _) if t.is_env() => self.error(
                    format!("{at}.args"),
                    "an environment service takes a `run:` script, not `args:`",
                ),
                (Some(t), _, Some(_)) if !t.is_env() => self.error(
                    format!("{at}.run"),
                    format!(
                        "`{}` is a tool; give it `args:`, or use an `env:` environment for a script",
                        service.using
                    ),
                ),
                _ => {}
            }
            for k in service.env.keys() {
                if !is_env_key(k) {
                    self.error(
                        format!("{at}.env.{k}"),
                        "is not a valid environment variable name",
                    );
                } else if k.starts_with("IWCI_") {
                    self.error(
                        format!("{at}.env.{k}"),
                        "`IWCI_` variables are set by the runner",
                    );
                }
            }
            let mut timeout = DEFAULT_READY_TIMEOUT_SECS.min(job_timeout);
            if let Some(ready) = &service.ready {
                let checks = [
                    ready.port.is_some(),
                    ready.log.is_some(),
                    ready.command.is_some(),
                ];
                if checks.iter().filter(|c| **c).count() > 1 {
                    self.error(
                        format!("{at}.ready"),
                        "give one of `port`, `log` or `command`",
                    );
                }
                if ready.port == Some(0) {
                    self.error(format!("{at}.ready.port"), "must be between 1 and 65535");
                }
                if ready.command.is_some() && tool.as_ref().is_some_and(|t| !t.is_env()) {
                    self.error(
                        format!("{at}.ready.command"),
                        "runs in the service's environment, so the service needs `using: env:...`",
                    );
                }
                if let Some(t) = &ready.timeout {
                    match units::parse_duration_secs(t) {
                        Some(s) if (1..=job_timeout).contains(&s) => timeout = s,
                        Some(_) => self.error(
                            format!("{at}.ready.timeout"),
                            "must be at least 1s and no longer than the job's timeout",
                        ),
                        None => self.error(
                            format!("{at}.ready.timeout"),
                            format!("`{t}` is not a duration; use e.g. `30s` or `2m`"),
                        ),
                    }
                }
            }
            if self.errors.len() == errors
                && let Some(tool) = tool
            {
                out.push(ServiceStatic {
                    name: name.clone(),
                    raw: service.clone(),
                    tool,
                    timeout,
                });
            }
        }
        out
    }

    /// The job's expanded entries, and whether any of them read outputs
    /// that are not known yet (`needs` is `None` while parsing).
    fn instances(
        &mut self,
        key: &str,
        job: &raw::Job,
        st: &JobStatic,
        ws_index: usize,
        workspaces: &[WorkspaceSpec],
        needs: Option<&NeedsValues>,
    ) -> (Vec<PlannedJob>, bool) {
        let path = format!("jobs.{key}");
        let package = self.generated.get(key).cloned();
        let matrix_scope = interp::Scope {
            ctx: self.ctx,
            matrix: interp::MatrixScope::None,
            needs_list: &job.needs,
            decls: self.decls,
            needs,
            deferred: std::cell::Cell::new(false),
            hash_files: std::cell::Cell::new(false),
            package: package.as_ref(),
        };
        let (entries, shape) = self.matrix(&path, job.matrix.as_ref(), &matrix_scope);
        let mut deferred = matrix_scope.deferred.get();
        let workspace = &workspaces[ws_index];
        // A package's job starts in, and resolves relative paths against,
        // its package's directory.
        let default_cwd = match (&workspace.clone, &package) {
            (Some(c), Some(p)) => format!("{}/{}", c.into, p.dir),
            (Some(c), None) => c.into.clone(),
            (None, _) => "/".to_string(),
        };

        let mut out: Vec<PlannedJob> = Vec::new();
        for entry in &entries {
            let matrix = match shape {
                Shape::None => interp::MatrixScope::None,
                Shape::Pending => interp::MatrixScope::Pending,
                Shape::List => interp::MatrixScope::List(&entry[0].1),
                Shape::Axes => interp::MatrixScope::Axes(entry),
            };
            let scope = interp::Scope {
                ctx: self.ctx,
                matrix,
                needs_list: &job.needs,
                decls: self.decls,
                needs,
                deferred: std::cell::Cell::new(false),
                hash_files: std::cell::Cell::new(false),
                package: package.as_ref(),
            };
            // Errors from this entry, gathered locally because `sub` borrows
            // them while the rest of the loop also reports.
            let local = std::cell::RefCell::new(Vec::<SpecError>::new());
            let report = |field: &str, message: String| {
                local.borrow_mut().push(SpecError {
                    path: format!("{path}.{field}"),
                    message,
                });
            };
            let sub = |field: &str, text: &str| -> String {
                match interp::substitute(text, &scope) {
                    Ok(s) => s,
                    Err(e) => {
                        report(field, e);
                        text.to_string()
                    }
                }
            };
            let values: Vec<&str> = entry.iter().map(|(_, v)| v.as_str()).collect();
            let id = if values.is_empty() {
                key.to_string()
            } else {
                format!("{key}[{}]", values.join(","))
            };
            let display_name = match (&job.name, &package) {
                (Some(n), _) => sub("name", n),
                (None, Some(p)) => format!("{} ({})", p.job, p.dir),
                (None, None) if values.is_empty() => key.to_string(),
                (None, None) => format!("{key} ({})", values.join(", ")),
            };
            let cwd_raw = job.cwd.as_deref().map(|c| sub("cwd", c));
            // `args:`/`run:` and `env:`, for the job and for each service
            // (whose fields are under `services.<name>.`).
            let action_of =
                |at: &str, args: &Option<raw::Args>, run: &Option<String>| match (args, run) {
                    (_, Some(script)) => Action::Script {
                        script: sub(&format!("{at}run"), script),
                    },
                    (Some(raw::Args::List(list)), None) => Action::Args {
                        args: list.iter().map(|a| sub(&format!("{at}args"), a)).collect(),
                    },
                    (Some(raw::Args::Line(line)), None) => {
                        let line = sub(&format!("{at}args"), line);
                        match shell::split(&line) {
                            Ok(args) => Action::Args { args },
                            Err(e) => {
                                report(&format!("{at}args"), e);
                                Action::Args { args: Vec::new() }
                            }
                        }
                    }
                    (None, None) => Action::Args { args: Vec::new() },
                };
            let env_of = |at: &str, vars: &indexmap::IndexMap<String, String>| {
                let mut env: Vec<(String, String)> = Vec::new();
                let mut secret_env: Vec<SecretEnv> = Vec::new();
                for (k, v) in vars {
                    let field = format!("{at}env.{k}");
                    match interp::secret_parts(v) {
                        Ok(None) => env.push((k.clone(), sub(&field, v))),
                        Ok(Some(parts)) => secret_env.push(SecretEnv {
                            key: k.clone(),
                            parts: parts
                                .into_iter()
                                .map(|p| match p {
                                    interp::RawPart::Text(t) => SecretPart::Text(sub(&field, &t)),
                                    interp::RawPart::Secret(name) => SecretPart::Secret(name),
                                })
                                .collect(),
                        }),
                        Err(e) => report(&field, e),
                    }
                }
                (env, secret_env)
            };
            let action = action_of("", &job.args, &job.run);
            let (env, secret_env) = env_of("", &job.env);
            let services: Vec<PlannedService> = st
                .services
                .iter()
                .map(|s| {
                    let at = format!("services.{}.", s.name);
                    let (env, secret_env) = env_of(&at, &s.raw.env);
                    let ready = s.raw.ready.clone().unwrap_or_default();
                    let check = if let Some(port) = ready.port {
                        ReadyCheck::Port { port }
                    } else if let Some(pattern) = &ready.log {
                        let pattern = sub(&format!("{at}ready.log"), pattern);
                        if let Err(e) = regex::RegexBuilder::new(&pattern)
                            .size_limit(1 << 20)
                            .build()
                        {
                            report(
                                &format!("{at}ready.log"),
                                format!("is not a regular expression: {e}"),
                            );
                        }
                        ReadyCheck::Log { pattern }
                    } else if let Some(script) = &ready.command {
                        ReadyCheck::Command {
                            script: sub(&format!("{at}ready.command"), script),
                        }
                    } else {
                        ReadyCheck::Started
                    };
                    PlannedService {
                        name: s.name.clone(),
                        tool: s.tool.clone(),
                        action: action_of(&at, &s.raw.args, &s.raw.run),
                        env,
                        secret_env,
                        ready: Readiness {
                            check,
                            timeout: std::time::Duration::from_secs(s.timeout),
                        },
                    }
                })
                .collect();
            let clone_root = workspace.clone.as_ref().map(|_| default_cwd.clone());
            // A `cache:` or `artifacts:` path: substituted, then relative to
            // the clone or absolute, without `..`, and never the runner's own.
            let guest_path = |field: &str, p: &str, what: &str| -> Option<String> {
                let p = sub(field, p);
                let resolved = if p.starts_with('/') {
                    normalise_abs(&p)
                } else {
                    clone_root
                        .as_deref()
                        .and_then(|root| join_relative(root, &p))
                };
                match resolved {
                    Some(r)
                        if r == "/"
                            || r.starts_with("/iwci")
                            || r == "/dev"
                            || r.starts_with("/dev/") =>
                    {
                        report(field, format!("`{p}` is not a path a job can {what}"));
                        None
                    }
                    Some(r) => Some(r),
                    None => {
                        report(
                            field,
                            format!(
                                "`{p}` must be relative to the clone or absolute, without `..`"
                            ),
                        );
                        None
                    }
                }
            };
            let artifacts: Vec<String> = job
                .artifacts
                .iter()
                .filter_map(|p| guest_path("artifacts", p, "keep"))
                .collect();
            let download_paths: Vec<String> = job
                .downloads
                .as_ref()
                .map(|d| d.0.paths.as_slice())
                .unwrap_or_default()
                .iter()
                .filter_map(|p| guest_path("downloads", p, "download"))
                .collect();
            let caches: Vec<CacheSpec> = job
                .cache
                .as_ref()
                .map(|c| c.as_slice())
                .unwrap_or_default()
                .iter()
                .enumerate()
                .map(|(i, entry)| {
                    scope.hash_files.set(true);
                    let key = sub(&format!("cache[{i}].key"), &entry.key);
                    let restore_keys = entry
                        .restore_keys
                        .iter()
                        .map(|k| sub(&format!("cache[{i}].restore-keys"), k))
                        .collect();
                    scope.hash_files.set(false);
                    let paths = entry
                        .paths
                        .iter()
                        .filter_map(|p| guest_path(&format!("cache[{i}].paths"), p, "cache"))
                        .collect();
                    CacheSpec {
                        key,
                        restore_keys,
                        paths,
                    }
                })
                .collect();
            let task_cache = match &job.task_cache {
                None | Some(raw::TaskCache::Enabled(false)) => None,
                Some(t) => {
                    let (inputs, root_inputs) = match t {
                        raw::TaskCache::Inputs(i) => (i.inputs.clone(), i.root_inputs.clone()),
                        _ => (Vec::new(), Vec::new()),
                    };
                    let prefix = package.as_ref().map(|p| format!("{}/", p.dir));
                    let mut globs = Vec::new();
                    let mut check = |field: &str, glob: String| {
                        let body = glob.strip_prefix('!').unwrap_or(&glob);
                        if body.starts_with('/') || body.split('/').any(|c| c == "..") {
                            report(
                                field,
                                format!("`{glob}` must be a glob inside the clone, without `..`"),
                            );
                        } else if let Err(e) = glob::check_filter(&glob) {
                            report(field, e);
                        } else {
                            globs.push(glob);
                        }
                    };
                    if inputs.is_empty() {
                        globs_default(&prefix, &mut check);
                    }
                    for g in &inputs {
                        let g = sub("task-cache.inputs", g);
                        let (neg, body) = match g.strip_prefix('!') {
                            Some(b) => ("!", b.to_string()),
                            None => ("", g.clone()),
                        };
                        check(
                            "task-cache.inputs",
                            format!("{neg}{}{body}", prefix.as_deref().unwrap_or("")),
                        );
                    }
                    for g in &root_inputs {
                        check("task-cache.root-inputs", sub("task-cache.root-inputs", g));
                    }
                    Some(TaskCacheSpec { inputs: globs })
                }
            };
            deferred |= scope.deferred.get();
            let cwd = match cwd_raw {
                None => default_cwd.clone(),
                // A path that is only known later is checked then.
                Some(_) if deferred => default_cwd.clone(),
                Some(c) => match normalise_abs(&c) {
                    Some(p) => p,
                    None => {
                        report(
                            "cwd",
                            format!("`{c}` must be an absolute path without `..`"),
                        );
                        default_cwd.clone()
                    }
                },
            };
            // Each matrix entry substitutes the same text, so a bad
            // expression would otherwise be reported once per entry.
            for e in local.into_inner() {
                if !self.errors.contains(&e) {
                    self.errors.push(e);
                }
            }
            if out.iter().any(|j| j.id == id) {
                self.error(&path, format!("expands to `{id}` more than once"));
                continue;
            }
            let matrix: BTreeMap<String, String> = entry
                .iter()
                .map(|(k, v)| {
                    (
                        if k.is_empty() {
                            "value".to_string()
                        } else {
                            k.clone()
                        },
                        v.clone(),
                    )
                })
                .collect();
            if let Some(tool) = &st.tool {
                out.push(PlannedJob {
                    id,
                    key: key.to_string(),
                    display_name,
                    matrix,
                    tool: tool.clone(),
                    action,
                    cwd,
                    env,
                    secret_env,
                    tools: st.tools.clone(),
                    workspace: ws_index,
                    changes: st.changes.clone(),
                    outputs: job.outputs.clone(),
                    timeout: std::time::Duration::from_secs(st.timeout),
                    memory_bytes: st.memory,
                    caches,
                    artifacts,
                    downloads: st.downloads.map(|(retention_secs, when)| DownloadSpec {
                        paths: download_paths,
                        retention_secs,
                        when,
                    }),
                    network: job.network.unwrap_or(true),
                    package: package.clone(),
                    task_cache,
                    services,
                });
            }
        }
        (out, deferred)
    }
}

/// A task cache's inputs when it names none: every file of its package, or
/// of the clone.
fn globs_default(prefix: &Option<String>, add: &mut impl FnMut(&str, String)) {
    add(
        "task-cache",
        format!("{}**", prefix.as_deref().unwrap_or("")),
    );
}

fn short(text: &str) -> String {
    let mut s: String = text.chars().take(60).collect();
    if s.len() < text.len() {
        s.push_str("...");
    }
    s
}

/// `path` normalised, if it is absolute and has no `..`.
fn normalise_abs(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p => parts.push(p),
        }
    }
    Some(format!("/{}", parts.join("/")))
}

fn join_relative(root: &str, rel: &str) -> Option<String> {
    if rel.starts_with('/') {
        return None;
    }
    normalise_abs(&format!("{root}/{rel}"))
}

/// The first `needs` cycle among the job keys, if there is one.
fn find_cycle(jobs: &indexmap::IndexMap<String, raw::Job>) -> Option<Vec<String>> {
    fn visit<'a>(
        key: &'a str,
        jobs: &'a indexmap::IndexMap<String, raw::Job>,
        state: &mut HashMap<&'a str, bool>,
        stack: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        match state.get(key) {
            Some(true) => return None,
            Some(false) => {
                let start = stack.iter().position(|k| *k == key).unwrap_or(0);
                let mut cycle: Vec<String> = stack[start..].iter().map(|s| s.to_string()).collect();
                cycle.push(key.to_string());
                return Some(cycle);
            }
            None => {}
        }
        state.insert(key, false);
        stack.push(key);
        if let Some(job) = jobs.get(key) {
            for need in &job.needs {
                if need != key
                    && jobs.contains_key(need)
                    && let Some(c) = visit(need, jobs, state, stack)
                {
                    return Some(c);
                }
            }
        }
        stack.pop();
        state.insert(key, true);
        None
    }
    let mut state = HashMap::new();
    for key in jobs.keys() {
        if let Some(c) = visit(key, jobs, &mut state, &mut Vec::new()) {
            return Some(c);
        }
    }
    None
}

#[cfg(test)]
mod tests;
