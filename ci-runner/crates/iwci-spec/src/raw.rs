//! The pipeline file as written. Every struct denies unknown fields, so a
//! typo such as `cmd:` for `cwd:` is an error rather than a silently ignored
//! key. [`crate::plan`] turns this into the validated, expanded form.

use indexmap::IndexMap;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Pipeline {
    pub name: String,
    #[serde(default)]
    pub on: Option<Triggers>,
    /// The clone and dependencies every job starts from unless it overrides
    /// them. Jobs with the same effective workspace share one snapshot.
    #[serde(default)]
    pub workspace: Option<Workspace>,
    pub jobs: IndexMap<String, Job>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Triggers {
    #[serde(default)]
    pub push: Option<TriggerFilter>,
    #[serde(default)]
    pub pull_request: Option<TriggerFilter>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct TriggerFilter {
    /// Branch globs (`main`, `release/*`). Empty means every branch.
    #[serde(default)]
    pub branches: Vec<String>,
    /// Path globs; the run starts only when the commit touches one of them.
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Workspace {
    #[serde(default)]
    pub clone: Option<Clone>,
    #[serde(default)]
    pub deps: Option<Vec<Dep>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Clone {
    /// `1` (the default) for a shallow clone, a larger number for more
    /// history, or `full`.
    #[serde(default)]
    pub depth: Option<Depth>,
    /// Where the repository appears inside the isolate. Default `/app`.
    #[serde(default)]
    pub into: Option<String>,
    #[serde(default)]
    pub submodules: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Depth {
    Commits(u32),
    Named(String),
}

/// `pnpm`, or `pnpm: { dir: app }` to point at a lockfile below the root.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Dep {
    Name(String),
    Configured(IndexMap<String, DepOptions>),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct DepOptions {
    /// Directory of the lockfile, relative to the clone. Default the root.
    #[serde(default)]
    pub dir: Option<String>,
    /// pnpm only: install just these importers' dependency closure.
    #[serde(default)]
    pub only: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Job {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub matrix: Option<Matrix>,
    pub using: String,
    /// Arguments for a tool (`builtin:` / `repo:`), as a list or one string
    /// split like a shell would split it (no expansion).
    #[serde(default)]
    pub args: Option<Args>,
    /// A shell script for an environment (`env:`).
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: IndexMap<String, String>,
    /// Overrides the pipeline's `workspace.clone`; `false` starts the job
    /// from an empty file system.
    #[serde(default)]
    pub clone: Option<Override<Clone>>,
    /// Overrides the pipeline's `workspace.deps`; `false` installs nothing.
    #[serde(default)]
    pub deps: Option<Override<Vec<Dep>>>,
    #[serde(default)]
    pub changes: Option<Changes>,
    #[serde(default)]
    pub needs: Vec<String>,
    /// When the job runs, given how its `needs` went. See `crate::expr`.
    #[serde(default, rename = "if")]
    pub condition: Option<String>,
    /// Names the job may write to the file at `$IWCI_OUTPUT`, for jobs that
    /// need it to read as `${{ needs.<job>.outputs.<name> }}`.
    #[serde(default)]
    pub outputs: Vec<String>,
    /// Path globs; the job is skipped when the commit touches none of them.
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub timeout: Option<String>,
    #[serde(default)]
    pub memory: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Override<T> {
    Disabled(bool),
    Value(T),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Args {
    List(Vec<String>),
    Line(String),
}

/// `[web, mobile]` (read as `${{ matrix }}`), or named axes
/// (`{ package: [web, mobile], mode: [strict] }`, read as
/// `${{ matrix.package }}`) whose cartesian product is expanded, or a
/// `${{ needs.<job>.outputs.<name> }}` holding either of those as JSON.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Matrix {
    List(Vec<Scalar>),
    Axes(IndexMap<String, AxisOrExclude>),
    Expr(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum AxisOrExclude {
    Axis(Vec<Scalar>),
    Exclude(Vec<IndexMap<String, Scalar>>),
    /// One axis's values from another job's output, as a JSON list.
    Expr(String),
}

/// Matrix values may be written as numbers or booleans; they are used as
/// text either way.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Scalar {
    String(String),
    Int(i64),
    Float(f64),
    Bool(bool),
}

impl Scalar {
    pub fn as_text(&self) -> String {
        match self {
            Scalar::String(s) => s.clone(),
            Scalar::Int(n) => n.to_string(),
            Scalar::Float(n) => n.to_string(),
            Scalar::Bool(b) => b.to_string(),
        }
    }
}

/// What to do when a job leaves the workspace different from how it found
/// it: `ignore` (the default), `fail`, or `{ commit: "<message>" }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Changes {
    Mode(String),
    Commit(CommitChanges),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct CommitChanges {
    pub commit: String,
}
