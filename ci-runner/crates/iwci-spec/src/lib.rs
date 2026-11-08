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

pub mod expr;
mod glob;
mod interp;
pub mod plan;
pub mod raw;
mod shell;
mod units;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

use sha2::Digest;

pub use plan::*;

/// Where a parsed file runs: substituted for `${{ commit.* }}` and
/// `${{ repo.* }}`.
#[derive(Debug, Clone, Default)]
pub struct Context {
    pub commit_sha: String,
    pub branch: String,
    pub repo_id: String,
    pub event: Event,
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
pub const MAX_JOBS: usize = 256;
pub const MAX_MATRIX_ENTRIES: usize = 64;
pub const DEFAULT_TIMEOUT_SECS: u64 = 10 * 60;
pub const MAX_TIMEOUT_SECS: u64 = 60 * 60;
pub const DEFAULT_MEMORY: u64 = 2 << 30;
pub const MIN_MEMORY: u64 = 16 << 20;
pub const MAX_MEMORY: u64 = 16 << 30;
pub const DEFAULT_CLONE_INTO: &str = "/app";

/// The most `cache:` entries one job may have.
pub const MAX_CACHES: usize = 16;

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

/// Parses and validates a pipeline file for one commit.
pub fn parse(yaml: &str, ctx: &Context) -> Result<Plan, SpecErrors> {
    let raw: raw::Pipeline = serde_yaml_ng::from_str(yaml).map_err(|e| {
        SpecErrors(vec![SpecError {
            path: String::new(),
            message: e.to_string(),
        }])
    })?;
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
        errors: Vec::new(),
        ctx,
        decls: &decls,
    };
    let plan = v.pipeline(raw);
    if v.errors.is_empty() {
        Ok(plan)
    } else {
        Err(SpecErrors(v.errors))
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
}

/// The parts of a job that do not depend on its matrix entry or on other
/// jobs' outputs, checked once.
struct JobStatic {
    tool: Option<ToolRef>,
    timeout: u64,
    memory: u64,
    changes: ChangePolicy,
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
    let mut v = Validator {
        errors: Vec::new(),
        ctx: &plan.ctx,
        decls: &plan.decls,
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
            if !is_name(&key) {
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
                instances: (!deferred).then_some(instances),
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

        Plan {
            name: raw.name,
            triggers,
            workspaces,
            jobs,
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
            };
        };
        let mut filter = |name: &str, f: Option<raw::TriggerFilter>| {
            f.map(|f| {
                for (field, globs) in [("branches", &f.branches), ("paths", &f.paths)] {
                    for g in globs {
                        if let Err(e) = glob::compile(g) {
                            self.error(format!("on.{name}.{field}"), format!("`{g}`: {e}"));
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
        if push.is_none() && pull_request.is_none() {
            self.error("on", "lists no events, so the pipeline would never run");
        }
        Triggers { push, pull_request }
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
                    format!("unknown ecosystem `{name}`; expected `pnpm`, `go` or `cargo`"),
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
            let spec = DepSpec {
                ecosystem,
                dir,
                only: options.only,
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
            if let Err(e) = glob::compile(p) {
                self.error(format!("{path}.paths"), format!("`{p}`: {e}"));
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
        JobStatic {
            tool,
            timeout,
            memory,
            changes,
        }
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
        let matrix_scope = interp::Scope {
            ctx: self.ctx,
            matrix: interp::MatrixScope::None,
            needs_list: &job.needs,
            decls: self.decls,
            needs,
            deferred: std::cell::Cell::new(false),
            hash_files: std::cell::Cell::new(false),
        };
        let (entries, shape) = self.matrix(&path, job.matrix.as_ref(), &matrix_scope);
        let mut deferred = matrix_scope.deferred.get();
        let workspace = &workspaces[ws_index];
        let default_cwd = workspace
            .clone
            .as_ref()
            .map_or_else(|| "/".to_string(), |c| c.into.clone());

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
            let display_name = match &job.name {
                Some(n) => sub("name", n),
                None if values.is_empty() => key.to_string(),
                None => format!("{key} ({})", values.join(", ")),
            };
            let cwd_raw = job.cwd.as_deref().map(|c| sub("cwd", c));
            let action = match (&job.args, &job.run) {
                (_, Some(script)) => Action::Script {
                    script: sub("run", script),
                },
                (Some(raw::Args::List(list)), None) => Action::Args {
                    args: list.iter().map(|a| sub("args", a)).collect(),
                },
                (Some(raw::Args::Line(line)), None) => {
                    let line = sub("args", line);
                    match shell::split(&line) {
                        Ok(args) => Action::Args { args },
                        Err(e) => {
                            report("args", e);
                            Action::Args { args: Vec::new() }
                        }
                    }
                }
                (None, None) => Action::Args { args: Vec::new() },
            };
            let env: Vec<(String, String)> = job
                .env
                .iter()
                .map(|(k, v)| (k.clone(), sub(&format!("env.{k}"), v)))
                .collect();
            let clone_root = workspace.clone.as_ref().map(|c| c.into.clone());
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
                        .filter_map(|p| {
                            let p = sub(&format!("cache[{i}].paths"), p);
                            let resolved = if p.starts_with('/') {
                                normalise_abs(&p)
                            } else {
                                clone_root.as_deref().and_then(|root| join_relative(root, &p))
                            };
                            match resolved {
                                Some(r) if r == "/" || r.starts_with("/iwci") || r == "/dev" || r.starts_with("/dev/") => {
                                    report(&format!("cache[{i}].paths"), format!("`{p}` is not a path a job can cache"));
                                    None
                                }
                                Some(r) => Some(r),
                                None => {
                                    report(
                                        &format!("cache[{i}].paths"),
                                        format!("`{p}` must be relative to the clone or absolute, without `..`"),
                                    );
                                    None
                                }
                            }
                        })
                        .collect();
                    CacheSpec { key, restore_keys, paths }
                })
                .collect();
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
                    workspace: ws_index,
                    changes: st.changes.clone(),
                    outputs: job.outputs.clone(),
                    timeout: std::time::Duration::from_secs(st.timeout),
                    memory_bytes: st.memory,
                    caches,
                });
            }
        }
        (out, deferred)
    }
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
