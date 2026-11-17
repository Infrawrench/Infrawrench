//! Installs a Bun project's `node_modules` from `bun.lock`, without Bun
//! and without running any install script.
//!
//! # Layout
//!
//! Bun has two linkers, and the result is whichever `bun install
//! --frozen-lockfile` would use, so module resolution finds what it finds
//! after a real install:
//!
//! - **hoisted**: the flat tree npm made familiar. `bun.lock` records it
//!   directly (a package's key under `packages` is its path in that tree),
//!   so each package is unpacked where its key says: `is-odd/is-number` at
//!   `node_modules/is-odd/node_modules/is-number`. A workspace package is a
//!   symlink at `node_modules/<name>`, and what is nested under its key
//!   goes into its own `node_modules`.
//! - **isolated**: every package in `node_modules/.bun/<name>@<version>`
//!   with its dependencies as symlinks beside it, each project's direct
//!   dependencies linked into its `node_modules`, and one more variant of a
//!   package per set of peers it is installed against (see `isolated.rs`).
//!   Directory names are Bun's own, peer hash included, with one exception:
//!   a resolution longer than 80 bytes (a long tarball URL) is cut and
//!   given a hash that is not the one Bun computes.
//!
//! Bun picks the linker from `bunfig.toml`'s `[install] linker`, and
//! otherwise from the lockfile: isolated when its `configVersion` is 1
//! (written by Bun 1.3.2 and later for a new lockfile) and the project has
//! workspaces, hoisted for everything else. The isolated layout honours
//! `hoist`, `hoistPattern` and `publicHoistPattern` from the same file.
//!
//! Left out, as for pnpm: `node_modules/.bin` and Bun's own bookkeeping
//! files. Packages that want a build step are installed as their published
//! files; `trustedDependencies` only decides which of them get a warning
//! saying so.
//!
//! # Platform
//!
//! The isolate is the platform [`crate::pnpm`] describes: cpu `wasm32`, no
//! operating system. An optional dependency whose `os`, `cpu` or `libc`
//! rule that out is skipped, with everything only it depends on. Bun
//! writes `none` for a value it has no name for (`wasm32` among them), so
//! such a field is read from the package's name instead, as pnpm reads a
//! package that declares nothing.
//!
//! # Lockfile support
//!
//! `bun.lock` versions 0 to 3 (Bun 1.2 and later). Registry packages, `npm:`
//! aliases, workspaces, `link:` dependencies, tarballs by URL or by a path
//! in the repository, GitHub dependencies (fetched as the archive Bun
//! hashed), `overrides` and catalogs (already applied in the lockfile) and
//! `patchedDependencies`. Everything fetched is checked against the
//! lockfile's integrity. Refused with a clear error: a `bun.lockb` without
//! a `bun.lock`, packages the lockfile has no integrity for, git
//! dependencies that are not on GitHub, and `file:` directories.

mod isolated;
mod key;
mod lockfile;
#[cfg(test)]
mod tests;
mod wyhash;

use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use iwci_vfs::SnapshotBuilder;
use iwci_vfs::virtual_fs::mem_fs;
use shared_buffer::OwnedBuffer;

use crate::fetch::{self, FetchError, Fetcher, Integrity};
use crate::pnpm::{self, Patch, Platform};

pub use key::KeyIndex;
pub use lockfile::{
    Deps, Lockfile, MAX_LOCKFILE_VERSION, Package, Resolution, Workspace, parse_lockfile,
};

/// The public npm registry.
pub const DEFAULT_REGISTRY: &str = pnpm::DEFAULT_REGISTRY;

/// The files an install reads besides the packages' own: what a cache of
/// its result is keyed on.
pub const INPUT_FILES: [&str; 3] = ["bun.lock", "bun.lockb", "bunfig.toml"];

/// The patch files the `bun.lock` in `lock` names, relative to its
/// directory. The lockfile does not pin their content, so anything keyed
/// on an install's inputs reads them too.
pub fn patch_files(lock: Option<&[u8]>) -> Vec<String> {
    lock.and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|text| parse_lockfile(text).ok())
        .map(|lock| lock.patched_dependencies.into_values().collect())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Linker {
    Hoisted,
    Isolated,
}

#[derive(Debug, Clone)]
pub struct BunOptions {
    /// Base URL for registry tarballs when `bunfig.toml` names none.
    pub registry: String,
    /// Whether workspaces' `devDependencies` are installed. Type checking
    /// needs them, so on by default.
    pub include_dev: bool,
    /// The platform optional dependencies are matched against; `None` is
    /// the WebAssembly isolate.
    pub platform: Option<Platform>,
    /// Tarballs fetched and unpacked at once.
    pub parallelism: usize,
    /// The most one package may unpack to.
    pub max_unpacked_bytes: u64,
}

impl Default for BunOptions {
    fn default() -> Self {
        Self {
            registry: DEFAULT_REGISTRY.to_string(),
            include_dev: true,
            platform: None,
            parallelism: fetch::DEFAULT_PARALLELISM,
            max_unpacked_bytes: pnpm::DEFAULT_MAX_UNPACKED_BYTES,
        }
    }
}

/// What an install did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallReport {
    pub linker: Linker,
    /// Package directories written.
    pub packages: usize,
    /// Distinct tarballs fetched.
    pub tarballs: usize,
    /// Compressed bytes fetched.
    pub tarball_bytes: u64,
    /// Files written.
    pub files: usize,
    /// Bytes written.
    pub bytes: u64,
    /// Symlinks created.
    pub links: usize,
    /// Of those, links created by the isolated layout's hoisting.
    pub hoisted: usize,
    /// Optional dependencies skipped for their platform, as
    /// `name@version`, sorted.
    pub skipped_optional: Vec<String>,
    /// Packages a patch was applied to, sorted.
    pub patched: Vec<String>,
    /// What a real install would have done and this one did not.
    pub warnings: Vec<String>,
    pub elapsed: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum BunError {
    #[error(transparent)]
    Vfs(#[from] iwci_vfs::VfsError),
    #[error("{path}: {message}")]
    Lockfile { path: String, message: String },
    #[error("{path}: {message}")]
    Config { path: String, message: String },
    #[error("{package}: {source}")]
    Fetch {
        package: String,
        #[source]
        source: FetchError,
    },
    #[error("{package}: bad tarball: {message}")]
    Tarball { package: String, message: String },
    #[error("{package}: patch {patch} does not apply: {message}")]
    Patch {
        package: String,
        patch: String,
        message: String,
    },
    #[error("{package}: {message}")]
    Unsupported { package: String, message: String },
}

pub type Result<T> = std::result::Result<T, BunError>;

fn lockfile_error(message: impl Into<String>) -> BunError {
    BunError::Lockfile {
        path: "bun.lock".to_string(),
        message: message.into(),
    }
}

/// The `[install]` settings of a project's `bunfig.toml` that change what
/// is installed where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub linker: Option<Linker>,
    /// What the isolated layout links into `node_modules/.bun/node_modules`;
    /// empty when `hoist = false`.
    pub hoist_pattern: Vec<String>,
    /// What it links into the root `node_modules` as well.
    pub public_hoist_pattern: Vec<String>,
    pub registry: Option<String>,
    /// `@scope` to that scope's registry.
    pub scoped_registries: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            linker: None,
            hoist_pattern: vec!["*".to_string()],
            public_hoist_pattern: Vec::new(),
            registry: None,
            scoped_registries: BTreeMap::new(),
        }
    }
}

/// A registry as `bunfig.toml` writes one: a URL, or a table with a `url`.
fn registry_url(value: &toml::Value) -> Option<String> {
    match value {
        toml::Value::String(url) => Some(url.clone()),
        toml::Value::Table(table) => table.get("url")?.as_str().map(str::to_string),
        _ => None,
    }
}

fn patterns(value: &toml::Value) -> Option<Vec<String>> {
    match value {
        toml::Value::String(one) => Some(vec![one.clone()]),
        toml::Value::Array(many) => Some(
            many.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
        ),
        _ => None,
    }
}

impl Settings {
    /// Reads the settings of the project rooted at `root`.
    pub fn read(builder: &SnapshotBuilder, root: &Path) -> Result<Settings> {
        Self::read_with(&|path| builder.read(path).ok(), root)
    }

    /// [`Settings::read`] through `read`, which gives a file's bytes by
    /// absolute path, or `None` when it is absent.
    pub fn read_with(read: &dyn Fn(&Path) -> Option<Vec<u8>>, root: &Path) -> Result<Settings> {
        let path = root.join("bunfig.toml");
        let mut settings = Settings::default();
        let Some(bytes) = read(&path) else {
            return Ok(settings);
        };
        let config = |message: String| BunError::Config {
            path: path.display().to_string(),
            message,
        };
        let text = String::from_utf8(bytes).map_err(|_| config("not UTF-8".to_string()))?;
        let document: toml::Table = toml::from_str(&text).map_err(|e| config(e.to_string()))?;
        let Some(install) = document.get("install").and_then(toml::Value::as_table) else {
            return Ok(settings);
        };
        if let Some(linker) = install.get("linker") {
            settings.linker = Some(match linker.as_str() {
                Some("hoisted") => Linker::Hoisted,
                Some("isolated") => Linker::Isolated,
                _ => {
                    return Err(config(format!(
                        "install.linker is {linker}; expected \"hoisted\" or \"isolated\""
                    )));
                }
            });
        }
        if let Some(found) = install.get("hoistPattern").and_then(patterns) {
            settings.hoist_pattern = found;
        }
        if install.get("hoist").and_then(toml::Value::as_bool) == Some(false) {
            settings.hoist_pattern.clear();
        }
        if let Some(found) = install.get("publicHoistPattern").and_then(patterns) {
            settings.public_hoist_pattern = found;
        }
        settings.registry = install.get("registry").and_then(registry_url);
        if let Some(scopes) = install.get("scopes").and_then(toml::Value::as_table) {
            for (scope, value) in scopes {
                if let Some(url) = registry_url(value) {
                    let scope = format!("@{}", scope.trim_start_matches('@'));
                    settings.scoped_registries.insert(scope, url);
                }
            }
        }
        Ok(settings)
    }
}

/// The linker Bun installs `lock` with: `bunfig.toml`'s, or isolated for a
/// workspace whose lockfile Bun 1.3.2 or later wrote, hoisted otherwise.
fn linker_of(lock: &Lockfile, settings: &Settings) -> Linker {
    settings
        .linker
        .unwrap_or(if lock.config_version >= 1 && lock.workspaces.len() > 1 {
            Linker::Isolated
        } else {
            Linker::Hoisted
        })
}

/// Whether the optional dependency `package` installs on the options'
/// platform.
fn accepts(options: &BunOptions, package: &Package) -> bool {
    // `none` is Bun's word for a value it does not know. Dropping it
    // leaves the field to the package's name.
    let known = |values: &[String]| -> Vec<String> {
        values
            .iter()
            .filter(|value| *value != "none")
            .cloned()
            .collect()
    };
    pnpm::platform_accepts_fields(
        options.platform.as_ref(),
        &package.name,
        &known(&package.os),
        &known(&package.cpu),
        &known(&package.libc),
    )
}

/// The key of the package a dependency on `name` resolves to from the
/// tree path `from`: the nearest entry above it, as Node would look.
fn resolve<'a>(lock: &'a Lockfile, from: &[&str], name: &str) -> Option<&'a str> {
    for depth in (0..=from.len()).rev() {
        let mut key = from[..depth].join("/");
        if depth > 0 {
            key.push('/');
        }
        key.push_str(name);
        if let Some((key, _)) = lock.packages.get_key_value(&key) {
            return Some(key);
        }
    }
    None
}

/// One dependency of a project or a package.
#[derive(Debug, Clone, Copy)]
struct Edge<'a> {
    alias: &'a str,
    peer: bool,
    /// Whether the dependent works without it.
    optional: bool,
    /// The key it resolves to. `None` for a peer nobody provides and an
    /// optional dependency that never resolved.
    target: Option<&'a str>,
}

/// The dependencies in `deps`, resolved from the tree path `from`, sorted
/// by name. A name in more than one group is what the last of peer, dev,
/// production and optional says it is, as in npm.
fn edges<'a>(
    lock: &'a Lockfile,
    deps: &'a Deps,
    from: &[&str],
    owner: &str,
    options: &BunOptions,
) -> Result<Vec<Edge<'a>>> {
    let mut found: BTreeMap<&'a str, Edge<'a>> = BTreeMap::new();
    let mut add = |names: &'a BTreeSet<String>, peer: bool, optional: bool| {
        for alias in names {
            let optional = optional || (peer && deps.optional_peers.contains(alias));
            found.insert(
                alias,
                Edge {
                    alias,
                    peer,
                    optional,
                    target: resolve(lock, from, alias),
                },
            );
        }
    };
    add(&deps.peer_dependencies, true, false);
    if options.include_dev {
        add(&deps.dev_dependencies, false, false);
    }
    add(&deps.dependencies, false, false);
    add(&deps.optional_dependencies, false, true);
    for edge in found.values() {
        if !edge.peer && !edge.optional && edge.target.is_none() {
            return Err(lockfile_error(format!(
                "{owner} depends on {}, which has no entry under packages; run bun install and commit bun.lock",
                edge.alias
            )));
        }
    }
    Ok(found.into_values().collect())
}

/// Where a workspace, a `link:` dependency or the root is.
fn directory_of(root: &Path, package: &Package) -> Result<PathBuf> {
    match &package.resolution {
        Resolution::Workspace { path } => Ok(iwci_vfs::join_under(root, path)?),
        Resolution::Link { path } => pnpm::lexical_join(root, path).ok_or_else(|| {
            lockfile_error(format!(
                "{}: the link leaves the file system",
                package.ident
            ))
        }),
        _ => Ok(root.to_path_buf()),
    }
}

/// What to write: package directories to fill and symlinks to make.
#[derive(Default)]
struct Layout<'a> {
    trees: Vec<(PathBuf, &'a Package)>,
    /// A link and the absolute path it points at.
    links: Vec<(PathBuf, PathBuf)>,
    /// Optional dependencies skipped for their platform, by identity.
    skipped: BTreeSet<String>,
    hoisted: usize,
    /// Of `links`, the ones hoisting made, by path.
    hoisted_links: HashSet<PathBuf>,
}

/// The hoisted layout: every reachable entry of `packages` where its key
/// puts it.
fn plan_hoisted<'a>(lock: &'a Lockfile, root: &Path, options: &BunOptions) -> Result<Layout<'a>> {
    // Where the packages nested under `key` go.
    let modules_of = |key: &[&str]| -> Result<PathBuf> {
        let mut modules = root.join("node_modules");
        for depth in 1..=key.len() {
            modules = match lock.packages.get(&key[..depth].join("/")) {
                Some(package) if package.resolution.is_directory() => {
                    directory_of(root, package)?.join("node_modules")
                }
                _ => iwci_vfs::join_under(&modules, key[depth - 1])?.join("node_modules"),
            };
        }
        Ok(modules)
    };

    let mut installed: BTreeSet<&'a str> = BTreeSet::new();
    let mut rejected: BTreeSet<&'a str> = BTreeSet::new();
    let mut queue: VecDeque<(&'a str, bool)> = VecDeque::new();
    for (path, workspace) in &lock.workspaces {
        let name = workspace.name.as_deref().unwrap_or_default();
        let from: Vec<&str> = if path.is_empty() || name.is_empty() {
            Vec::new()
        } else {
            lockfile::key_segments(name)
        };
        let owner = if path.is_empty() { "the root" } else { path };
        for edge in edges(lock, &workspace.deps, &from, owner, options)? {
            if let Some(target) = edge.target {
                queue.push_back((target, edge.optional && !edge.peer));
            }
        }
    }
    // Every workspace package is linked at the top, depended on or not.
    for (key, package) in &lock.packages {
        if matches!(package.resolution, Resolution::Workspace { .. })
            && lockfile::key_segments(key).len() == 1
        {
            queue.push_back((key, false));
        }
    }
    while let Some((key, optional)) = queue.pop_front() {
        let package = &lock.packages[key];
        if package.bundled || installed.contains(key) {
            continue;
        }
        if optional && !accepts(options, package) {
            rejected.insert(key);
            continue;
        }
        installed.insert(key);
        if package.resolution.is_directory() {
            continue;
        }
        let path = lockfile::key_segments(key);
        for edge in edges(lock, &package.deps, &path, &package.ident, options)? {
            if let Some(target) = edge.target {
                queue.push_back((target, edge.optional && !edge.peer));
            }
        }
    }

    let mut layout = Layout::default();
    for key in &installed {
        let package = &lock.packages[*key];
        let segments = lockfile::key_segments(key);
        let (name, parent) = segments.split_last().expect("a key has a name");
        let location = iwci_vfs::join_under(modules_of(parent)?, name)?;
        if package.resolution.is_directory() {
            layout.links.push((location, directory_of(root, package)?));
        } else {
            layout.trees.push((location, package));
        }
    }
    let installed_idents: HashSet<&str> = installed
        .iter()
        .map(|key| lock.packages[*key].ident.as_str())
        .collect();
    layout.skipped = rejected
        .iter()
        .map(|key| lock.packages[*key].ident.as_str())
        .filter(|ident| !installed_idents.contains(ident))
        .map(str::to_string)
        .collect();
    Ok(layout)
}

/// Where a package's tarball comes from.
enum Source {
    Remote {
        url: String,
        integrity: Integrity,
    },
    /// A tarball in the repository. The bytes come from the commit, and
    /// are still checked against the lockfile when it has an integrity.
    Local {
        path: PathBuf,
        integrity: Option<Integrity>,
    },
}

fn source_of(
    root: &Path,
    package: &Package,
    settings: &Settings,
    options: &BunOptions,
) -> Result<Source> {
    let unsupported = |message: String| BunError::Unsupported {
        package: package.ident.clone(),
        message,
    };
    let unverifiable = || {
        unsupported(
            "bun.lock has no integrity for it, so it cannot be verified; run bun install with Bun 1.3 or later and commit bun.lock"
                .to_string(),
        )
    };
    let sri = |integrity: &Option<String>| integrity.clone().map(Integrity::Sri);
    match &package.resolution {
        Resolution::Npm {
            version,
            url,
            integrity,
        } => {
            let url = match url {
                Some(url) => url.clone(),
                None => {
                    let registry = package
                        .name
                        .split_once('/')
                        .filter(|(scope, _)| scope.starts_with('@'))
                        .and_then(|(scope, _)| settings.scoped_registries.get(scope))
                        .or(settings.registry.as_ref())
                        .unwrap_or(&options.registry);
                    let registry = registry.trim_end_matches('/');
                    let name = &package.name;
                    let basename = name.rsplit('/').next().unwrap_or(name);
                    format!("{registry}/{name}/-/{basename}-{version}.tgz")
                }
            };
            Ok(Source::Remote {
                url,
                integrity: sri(integrity).ok_or_else(unverifiable)?,
            })
        }
        Resolution::Tarball {
            location,
            integrity,
        } => {
            if location.starts_with("https://") || location.starts_with("http://") {
                Ok(Source::Remote {
                    url: location.clone(),
                    integrity: sri(integrity).ok_or_else(unverifiable)?,
                })
            } else {
                Ok(Source::Local {
                    path: iwci_vfs::join_under(root, location.trim_start_matches("file:"))?,
                    integrity: sri(integrity),
                })
            }
        }
        // The archive Bun downloads and hashes is the one GitHub's API
        // redirects `/repos/<owner>/<repo>/tarball/<commit>` to. Asking
        // for it directly spares the API's rate limit.
        Resolution::Github {
            owner,
            repo,
            commit,
            integrity,
        } => Ok(Source::Remote {
            url: format!("https://codeload.github.com/{owner}/{repo}/legacy.tar.gz/{commit}"),
            integrity: sri(integrity).ok_or_else(unverifiable)?,
        }),
        Resolution::Git { url } => Err(unsupported(format!(
            "git dependencies ({url}) are not supported; depend on a GitHub repository or a tarball, which bun.lock pins by hash"
        ))),
        Resolution::Folder { path } => Err(unsupported(format!(
            "directory dependencies (file:{path}) are not supported; make it a workspace or a link: dependency"
        ))),
        Resolution::Workspace { .. } | Resolution::Link { .. } | Resolution::Root => Err(
            unsupported("is a directory, not a package to fetch".to_string()),
        ),
    }
}

/// One tarball and every directory it is unpacked into.
struct Job<'a> {
    package: &'a Package,
    source: Source,
    patch: Option<(&'a str, Arc<Patch>)>,
    targets: Vec<&'a Path>,
}

#[derive(Default)]
struct JobStats {
    tarball_bytes: u64,
    packages: usize,
    files: usize,
    bytes: u64,
}

fn run_job(
    builder: &SnapshotBuilder,
    fs: &mem_fs::FileSystem,
    fetcher: &dyn Fetcher,
    job: &Job<'_>,
    options: &BunOptions,
) -> Result<JobStats> {
    let fetch_error = |source: FetchError| BunError::Fetch {
        package: job.package.ident.clone(),
        source,
    };
    let bytes: Arc<[u8]> = match &job.source {
        Source::Remote { url, integrity } => fetcher.fetch(url, integrity).map_err(fetch_error)?,
        Source::Local { path, integrity } => {
            let bytes = builder.read(path)?;
            if let Some(integrity) = integrity {
                fetch::verify(&path.display().to_string(), &bytes, integrity)
                    .map_err(fetch_error)?;
            }
            bytes.into()
        }
    };
    let mut files =
        pnpm::tarball::extract(&bytes, options.max_unpacked_bytes).map_err(|message| {
            BunError::Tarball {
                package: job.package.ident.clone(),
                message,
            }
        })?;
    let mut stats = JobStats {
        tarball_bytes: bytes.len() as u64,
        ..JobStats::default()
    };
    drop(bytes);
    if let Some((path, patch)) = &job.patch {
        patch.apply(&mut files).map_err(|message| BunError::Patch {
            package: job.package.ident.clone(),
            patch: path.to_string(),
            message,
        })?;
    }
    let files: BTreeMap<String, OwnedBuffer> = files
        .into_iter()
        .map(|(path, bytes)| (path, OwnedBuffer::from(bytes)))
        .collect();
    for target in &job.targets {
        let (files, bytes) = pnpm::write_tree(fs, target, &files)?;
        stats.packages += 1;
        stats.files += files;
        stats.bytes += bytes;
    }
    Ok(stats)
}

/// Installs the dependencies of the Bun project whose `bun.lock` is at
/// `<root>/bun.lock` into `builder`, fetching every tarball through
/// `fetcher`.
pub fn install(
    builder: &SnapshotBuilder,
    root: &str,
    fetcher: &dyn Fetcher,
    options: &BunOptions,
) -> Result<InstallReport> {
    let started = Instant::now();
    let root = iwci_vfs::normalise(root)?;
    let lock_path = root.join("bun.lock");
    let lock_name = lock_path.display().to_string();
    let Ok(text) = builder.read(&lock_path) else {
        let message = if builder.is_file(root.join("bun.lockb")) {
            "not found, and bun.lockb is Bun's binary lockfile, which is not read; run `bun install --save-text-lockfile --frozen-lockfile --lockfile-only`, commit bun.lock and delete bun.lockb"
        } else {
            "not found"
        };
        return Err(BunError::Lockfile {
            path: lock_name,
            message: message.to_string(),
        });
    };
    let with_path = |error: BunError| match error {
        BunError::Lockfile { message, .. } => BunError::Lockfile {
            path: lock_name.clone(),
            message,
        },
        other => other,
    };
    let text = String::from_utf8(text).map_err(|_| with_path(lockfile_error("not UTF-8")))?;
    let lock = parse_lockfile(&text).map_err(|message| with_path(lockfile_error(message)))?;
    let settings = Settings::read(builder, &root)?;
    let linker = linker_of(&lock, &settings);
    let layout = match linker {
        Linker::Hoisted => plan_hoisted(&lock, &root, options),
        Linker::Isolated => isolated::plan(&lock, &root, &settings, options),
    }
    .map_err(with_path)?;

    // One job per package: every place it goes shares the unpacking.
    let mut grouped: BTreeMap<&str, (&Package, Vec<&Path>)> = BTreeMap::new();
    for (dir, package) in &layout.trees {
        grouped
            .entry(package.ident.as_str())
            .or_insert((package, Vec::new()))
            .1
            .push(dir);
    }
    let mut jobs = Vec::with_capacity(grouped.len());
    let mut patched = Vec::new();
    let mut warnings = Vec::new();
    for (ident, (package, targets)) in grouped {
        let patch = match lock.patched_dependencies.get_key_value(ident) {
            None => None,
            Some((_, path)) => {
                let full = iwci_vfs::join_under(&root, path)?;
                let bytes = builder.read(&full).map_err(|_| BunError::Config {
                    path: full.display().to_string(),
                    message: "patch file named in patchedDependencies is not in the repository"
                        .to_string(),
                })?;
                let patch = Patch::parse(&bytes).map_err(|message| BunError::Config {
                    path: path.clone(),
                    message,
                })?;
                patched.push(ident.to_string());
                Some((path.as_str(), Arc::new(patch)))
            }
        };
        if package.has_install_script && lock.trusted_dependencies.contains(&package.name) {
            warnings.push(format!(
                "{ident} is in trustedDependencies, but its install scripts were not run: nothing here runs them"
            ));
        }
        jobs.push(Job {
            package,
            source: source_of(&root, package, &settings, options)?,
            patch,
            targets,
        });
    }

    let fs = builder.fs();
    let abort = AtomicBool::new(false);
    let results = fetch::parallel_map(&jobs, options.parallelism, |job| {
        if abort.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let result = run_job(builder, fs, fetcher, job, options);
        if result.is_err() {
            abort.store(true, Ordering::Relaxed);
        }
        result.map(Some)
    });
    let mut report = InstallReport {
        linker,
        packages: 0,
        tarballs: 0,
        tarball_bytes: 0,
        files: 0,
        bytes: 0,
        links: 0,
        hoisted: layout.hoisted,
        skipped_optional: layout.skipped.iter().cloned().collect(),
        patched,
        warnings,
        elapsed: Duration::ZERO,
    };
    for result in results {
        if let Some(stats) = result? {
            report.tarballs += 1;
            report.tarball_bytes += stats.tarball_bytes;
            report.packages += stats.packages;
            report.files += stats.files;
            report.bytes += stats.bytes;
        }
    }

    let mut made = HashSet::new();
    for (link, target) in &layout.links {
        if !made.insert(link) {
            continue;
        }
        let parent = link.parent().unwrap_or(Path::new("/"));
        iwci_vfs::symlink(fs, link, pnpm::relative(parent, target))?;
    }
    report.links = made.len();
    report.elapsed = started.elapsed();
    Ok(report)
}
