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
    /// The most the run's shared `/tmp/workflow` may hold, such as `2GiB`.
    #[serde(default)]
    pub scratch: Option<String>,
    /// At most one run of a repository per group is in progress: a name,
    /// or `{ group, cancel-in-progress }`. The runner evaluates it; whoever
    /// dispatches runs (the app) enforces it.
    #[serde(default)]
    pub concurrency: Option<Concurrency>,
    pub jobs: IndexMap<String, Job>,
}

/// `concurrency: <group>` or `concurrency: { group, cancel-in-progress }`.
/// Deserialised by hand, like [`OneOrMany`], so an unknown key in the map
/// form is reported as such.
#[derive(Debug, Clone)]
pub enum Concurrency {
    Group(String),
    Full(ConcurrencyMap),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct ConcurrencyMap {
    pub group: String,
    /// A new run cancels the one in progress in its group, rather than
    /// waiting for it.
    #[serde(default)]
    pub cancel_in_progress: bool,
}

impl<'de> Deserialize<'de> for Concurrency {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_yaml_ng::Value::deserialize(deserializer)?;
        match value {
            serde_yaml_ng::Value::String(group) => Ok(Concurrency::Group(group)),
            serde_yaml_ng::Value::Mapping(_) => serde_yaml_ng::from_value(value)
                .map(Concurrency::Full)
                .map_err(serde::de::Error::custom),
            _ => Err(serde::de::Error::custom(
                "`concurrency` is a group name or `{ group, cancel-in-progress }`",
            )),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Triggers {
    #[serde(default)]
    pub push: Option<TriggerFilter>,
    #[serde(default)]
    pub pull_request: Option<TriggerFilter>,
    /// Cron expressions (UTC); a scheduled run uses the default branch.
    #[serde(default)]
    pub schedule: Vec<ScheduleEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct ScheduleEntry {
    pub cron: String,
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
    /// Background services every job starts with, unless it turns them off
    /// (`services: false`) or names its own of the same name.
    #[serde(default)]
    pub services: Option<IndexMap<String, Service>>,
}

/// A job's `services:`: a map of name to service, or `false` for none of
/// the workspace's either.
#[derive(Debug, Clone)]
pub enum Services {
    /// `true` changes nothing; `false` drops `workspace.services`.
    Enabled(bool),
    Map(IndexMap<String, Service>),
}

impl<'de> Deserialize<'de> for Services {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        bool_or(deserializer, Services::Enabled, Services::Map)
    }
}

/// A program that runs beside the job, in its isolate and on its loopback,
/// from before its `run:` until it ends.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Service {
    /// `env:<name>@<version>` (with `run:`), or a `builtin:` or `repo:`
    /// tool (with `args:`).
    pub using: String,
    /// A bash script, for an `env:` service.
    #[serde(default)]
    pub run: Option<String>,
    /// Arguments, for a tool.
    #[serde(default)]
    pub args: Option<Args>,
    /// Its environment variables; `${{ secrets.<name> }}` works here.
    #[serde(default)]
    pub env: IndexMap<String, String>,
    /// When the job may start. Without it, as soon as the service starts.
    #[serde(default)]
    pub ready: Option<Ready>,
}

/// One way to tell a service is ready, and how long to wait for it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Ready {
    /// Something in the job listens on this port of the loopback.
    #[serde(default)]
    pub port: Option<u16>,
    /// A line of its output matches this regular expression.
    #[serde(default)]
    pub log: Option<String>,
    /// This script, run in the service's environment, exits 0.
    #[serde(default)]
    pub command: Option<String>,
    /// Default `60s`.
    #[serde(default)]
    pub timeout: Option<String>,
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
/// The ecosystems are `pnpm`, `go`, `cargo`, `pip` and `composer`.
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
    /// pip only: the lock to read, relative to `dir`, instead of
    /// `pylock.toml` or `requirements.txt`.
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Job {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub matrix: Option<Matrix>,
    /// The tool or environment the job runs in. Required, unless the job
    /// runs on a connected cloud account (`cloud:`), where the machine's
    /// image is the environment.
    #[serde(default)]
    pub using: Option<String>,
    /// Runs the job on one of the organisation's connected cloud accounts
    /// rather than on the runner: `<provider>/<kind>`, or the map. The
    /// runner keeps the job in the graph and hands its execution to the
    /// app. See [`Cloud`].
    #[serde(default)]
    pub cloud: Option<CloudField>,
    /// Infrawrench connections whose credentials are lent to the job (a
    /// kubeconfig, an SSH host entry): names, or `{ name, namespace }`.
    #[serde(default)]
    pub connections: Vec<ConnectionRef>,
    /// Infrawrench SSH keys written into the job (`~/.ssh`), by name.
    #[serde(default)]
    pub ssh_keys: Vec<String>,
    /// Resource grants whose every exported key becomes an environment
    /// variable, by their CI name. The job's own `env:` wins.
    #[serde(default)]
    pub env_from: Vec<String>,
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
    /// Files kept between runs: restored before the job, saved after it
    /// passes. One entry, or a list.
    #[serde(default)]
    pub cache: Option<OneOrMany<CacheEntry>>,
    /// The caches the job's environment keeps on its own, such as Go's
    /// build cache: `false` turns them all off, a map of their names to
    /// `false` the ones it names. Default: all on.
    #[serde(default)]
    pub env_cache: Option<EnvCache>,
    /// Tools (`builtin:`, `repo:`) an `env:` job's script can run by name.
    #[serde(default)]
    pub tools: Vec<String>,
    /// `false` keeps the job off the internet: only its own loopback.
    /// Default: on.
    #[serde(default)]
    pub network: Option<bool>,
    /// Files handed on to the jobs that need this one: paths relative to the
    /// clone, or absolute. Kept once the job passes, then written into the
    /// file system of every job that needs it, directly or through others.
    #[serde(default)]
    pub artifacts: Vec<String>,
    /// Files kept for people to download after the run, in the object
    /// store, for `retention`. A list of paths, or the paths with options.
    /// See [`Downloads`].
    #[serde(default)]
    pub downloads: Option<DownloadsField>,
    /// One job per workspace package: `true` for every package, or a
    /// filter. See [`crate::packages`].
    #[serde(default)]
    pub packages: Option<Packages>,
    /// Skip the job when nothing it reads has changed since a run that
    /// passed, and hand on what that run kept. See [`TaskCache`].
    #[serde(default)]
    pub task_cache: Option<TaskCache>,
    /// Background services started before the job and stopped after it,
    /// over `workspace.services`. See [`Service`].
    #[serde(default)]
    pub services: Option<Services>,
}

/// `cloud: gcp/build`, or `cloud: { provider, kind, ... }`. Deserialised by
/// hand, like [`Concurrency`], so an unknown key in the map form is
/// reported as such.
#[derive(Debug, Clone)]
pub enum CloudField {
    Short(String),
    Full(Cloud),
}

/// Where a cloud job runs. `provider` and `kind` are required and literal;
/// the rest are optional and may use `${{ matrix }}`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Cloud {
    /// The plugin id of an opted-in connection (`aws`, `gcp`, `hetzner`).
    #[serde(default)]
    pub provider: Option<String>,
    /// `vm`, `container`, `build`, `host` or `cluster`.
    #[serde(default)]
    pub kind: Option<String>,
    /// The connection's name, when the organisation opted in more than one
    /// of the provider.
    #[serde(default)]
    pub connection: Option<String>,
    /// The provider's size name (`e2-highcpu-8`); default per provider.
    #[serde(default)]
    pub machine: Option<String>,
    /// A container image (container, build) or an OS image (vm).
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    /// `<type>` or `<type>:<count>`, where the provider offers GPUs.
    #[serde(default)]
    pub gpu: Option<String>,
}

impl<'de> Deserialize<'de> for CloudField {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_yaml_ng::Value::deserialize(deserializer)?;
        match value {
            serde_yaml_ng::Value::String(s) => Ok(CloudField::Short(s)),
            serde_yaml_ng::Value::Mapping(_) => serde_yaml_ng::from_value(value)
                .map(CloudField::Full)
                .map_err(serde::de::Error::custom),
            _ => Err(serde::de::Error::custom(
                "`cloud` is `<provider>/<kind>` or `{ provider, kind, ... }`",
            )),
        }
    }
}

/// One of `connections:`: a name, or `{ name, namespace }`.
#[derive(Debug, Clone)]
pub enum ConnectionRef {
    Name(String),
    Full(ConnectionEntry),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct ConnectionEntry {
    pub name: String,
    /// For a Kubernetes connection: the namespace its kubeconfig's context
    /// selects.
    #[serde(default)]
    pub namespace: Option<String>,
}

impl ConnectionRef {
    pub fn name(&self) -> &str {
        match self {
            ConnectionRef::Name(n) => n,
            ConnectionRef::Full(e) => &e.name,
        }
    }

    pub fn namespace(&self) -> Option<&str> {
        match self {
            ConnectionRef::Name(_) => None,
            ConnectionRef::Full(e) => e.namespace.as_deref(),
        }
    }
}

impl<'de> Deserialize<'de> for ConnectionRef {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_yaml_ng::Value::deserialize(deserializer)?;
        match value {
            serde_yaml_ng::Value::String(s) => Ok(ConnectionRef::Name(s)),
            serde_yaml_ng::Value::Mapping(_) => serde_yaml_ng::from_value(value)
                .map(ConnectionRef::Full)
                .map_err(serde::de::Error::custom),
            _ => Err(serde::de::Error::custom(
                "a connection is its name, or `{ name, namespace }`",
            )),
        }
    }
}

/// `downloads: [dist/app.tar.gz]`, or
/// `downloads: { paths: [...], retention: 7d, when: always }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Downloads {
    /// Relative to the clone, or absolute; a directory keeps every file
    /// the job wrote under it.
    pub paths: Vec<String>,
    /// How long they are kept, such as `7d` or `12h`. Default `30d`.
    #[serde(default)]
    pub retention: Option<String>,
    /// `success` (the default), `failure` or `always`: which outcomes of
    /// the job keep them.
    #[serde(default)]
    pub when: Option<String>,
}

impl<'de> Deserialize<'de> for DownloadsField {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_yaml_ng::Value::deserialize(deserializer)?;
        if value.is_sequence() {
            serde_yaml_ng::from_value(value)
                .map(|paths| {
                    DownloadsField(Downloads {
                        paths,
                        ..Default::default()
                    })
                })
                .map_err(serde::de::Error::custom)
        } else {
            serde_yaml_ng::from_value(value)
                .map(DownloadsField)
                .map_err(serde::de::Error::custom)
        }
    }
}

/// [`Downloads`] as a job writes it: the list form or the full one.
/// Deserialised by hand, like [`OneOrMany`], so a mistake inside the
/// mapping is reported as itself.
#[derive(Debug, Clone)]
pub struct DownloadsField(pub Downloads);

/// `packages: true`, or which packages a job runs in.
#[derive(Debug, Clone)]
pub enum Packages {
    All(bool),
    Filter(PackageFilter),
}

impl<'de> Deserialize<'de> for Packages {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        bool_or(deserializer, Packages::All, Packages::Filter)
    }
}

/// `true`/`false` or a struct, deserialised by hand so a mistake inside the
/// struct (an unknown field) is reported as itself, as with [`OneOrMany`].
fn bool_or<'de, D, T, R>(
    deserializer: D,
    flag: impl FnOnce(bool) -> R,
    value: impl FnOnce(T) -> R,
) -> Result<R, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let v = serde_yaml_ng::Value::deserialize(deserializer)?;
    match v {
        serde_yaml_ng::Value::Bool(b) => Ok(flag(b)),
        other => serde_yaml_ng::from_value(other)
            .map(value)
            .map_err(serde::de::Error::custom),
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct PackageFilter {
    /// Globs over each package's directory or name (`app/packages/*`,
    /// `@scope/*`); a package either matches is let through. `!` excludes,
    /// read in order like `paths:`. Empty means every package.
    #[serde(default)]
    pub only: Vec<String>,
    /// Names that must all be directly in the package's directory.
    #[serde(default)]
    pub has: Vec<String>,
    /// Scripts its `package.json` must all have.
    #[serde(default)]
    pub has_script: Vec<String>,
    /// Script name to a glob its command must match (`*` matches anything,
    /// `/` included), such as `build: "tsdown*"`; `!` before the glob
    /// selects packages whose script does not match or is missing.
    #[serde(default)]
    pub scripts: IndexMap<String, String>,
}

/// `env-cache: false`, or `env-cache: { go-build: false }`.
#[derive(Debug, Clone)]
pub enum EnvCache {
    Enabled(bool),
    Each(IndexMap<String, bool>),
}

impl<'de> Deserialize<'de> for EnvCache {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        bool_or(deserializer, EnvCache::Enabled, EnvCache::Each)
    }
}

/// `task-cache: true`, or what the job reads.
#[derive(Debug, Clone)]
pub enum TaskCache {
    Enabled(bool),
    Inputs(TaskCacheInputs),
}

impl<'de> Deserialize<'de> for TaskCache {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        bool_or(deserializer, TaskCache::Enabled, TaskCache::Inputs)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct TaskCacheInputs {
    /// Globs of the files the job reads, relative to its package (or to the
    /// clone for a job without `packages:`); `!` excludes. Default: all of
    /// them.
    #[serde(default)]
    pub inputs: Vec<String>,
    /// Globs relative to the clone that every package's job reads too, such
    /// as a shared `tsconfig.base.json`.
    #[serde(default)]
    pub root_inputs: Vec<String>,
    /// `false` leaves the artifacts the job is handed out of its key, for a
    /// job that has them only to pass them on. Default `true`.
    pub artifacts: Option<bool>,
}

/// One value or a list of them. Deserialised by hand rather than as an
/// untagged enum, whose only error is "did not match any variant": this
/// passes on the real one, such as an unknown field inside an entry.
#[derive(Debug, Clone)]
pub enum OneOrMany<T> {
    One(T),
    Many(Vec<T>),
}

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for OneOrMany<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_yaml_ng::Value::deserialize(deserializer)?;
        if value.is_sequence() {
            serde_yaml_ng::from_value(value)
                .map(OneOrMany::Many)
                .map_err(serde::de::Error::custom)
        } else {
            serde_yaml_ng::from_value(value)
                .map(OneOrMany::One)
                .map_err(serde::de::Error::custom)
        }
    }
}

impl<T> OneOrMany<T> {
    pub fn as_slice(&self) -> &[T] {
        match self {
            OneOrMany::One(t) => std::slice::from_ref(t),
            OneOrMany::Many(v) => v,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct CacheEntry {
    /// The exact key to restore and save under. May use
    /// `${{ hashFiles('glob', ...) }}`.
    pub key: String,
    /// Key prefixes to fall back on, in order, when `key` misses.
    #[serde(default)]
    pub restore_keys: Vec<String>,
    /// What to keep: paths relative to the clone, or absolute.
    pub paths: Vec<String>,
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
