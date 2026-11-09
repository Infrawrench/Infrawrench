//! Installs a pnpm workspace's `node_modules` from `pnpm-lock.yaml`,
//! without pnpm and without running any install script.
//!
//! # Layout
//!
//! The result is pnpm's default isolated layout, so module resolution (Node's
//! and TypeScript's) finds exactly what it finds after `pnpm install
//! --frozen-lockfile`:
//!
//! - every snapshot (a package at one set of peer versions) is unpacked at
//!   `node_modules/.pnpm/<dir>/node_modules/<name>`, where `<dir>` is
//!   pnpm's own escaping of the dependency path ([`dep_path_to_filename`]),
//!   so the directories match a real install name for name;
//! - each snapshot's dependencies are relative symlinks next to it, in
//!   `node_modules/.pnpm/<dir>/node_modules/<alias>`;
//! - each workspace project gets `<project>/node_modules/<alias>` links to
//!   its direct dependencies, and `link:` dependencies point at the other
//!   project's directory;
//! - hoisting follows the workspace's `hoistPattern` (default `*`, into
//!   `node_modules/.pnpm/node_modules`), `publicHoistPattern` (default
//!   none, into `node_modules`) and `hoistWorkspacePackages` (default on),
//!   with pnpm's precedence (see `hoist.rs`).
//!
//! Left out, because no job here runs a package's code through them:
//! `node_modules/.bin`, `.modules.yaml` and the virtual store's
//! `lock.yaml`. Packages that want a build step (`requiresBuild`, native
//! addons, `postinstall`) are installed as their published files.
//!
//! # Platform
//!
//! Jobs run in a WebAssembly isolate, so native binaries are dead weight,
//! but the `wasm32` builds of native packages (`@rolldown/binding-wasm32-wasi`,
//! `@oxc-parser/binding-wasm32-wasi`) are exactly what a job's Node can load:
//! the runner gives it a `node:wasi` (`iwci-runtime`'s `node/`). With
//! [`PnpmOptions::platform`] left at `None`, the isolate is treated as a
//! platform with cpu `wasm32` and no operating system or C library: an
//! optional dependency is installed when it asks for `wasm32` (or declares
//! nothing) and names no operating system or libc beyond exclusions
//! (`!win32`). Anything else is skipped, along with everything only it
//! depends on. A non-optional package with platform fields is installed
//! regardless (pnpm would refuse the install on a real mismatched host;
//! here the files are inert). Setting a [`Platform`] reproduces what pnpm
//! installs on that host, which is what the comparison tests use.
//!
//! # Lockfile support
//!
//! Formats 9.x (pnpm 9 to 11) and 6.x (pnpm 8). Registry packages, tarball
//! URLs with an integrity, repository-relative `file:` tarballs, npm
//! aliases, peer suffixes, `link:` workspace dependencies, and
//! `patchedDependencies` (paths from `pnpm-workspace.yaml`, the root
//! `package.json`'s `pnpm` field, or the lockfile itself). Refused with a
//! clear error: directory and git resolutions (`file:` directories,
//! injected workspace packages, git dependencies), tarballs without an
//! integrity, and `nodeLinker: hoisted` or `pnp`.

mod dep_path;
mod hoist;
mod lockfile;
mod patch;
mod tarball;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use iwci_vfs::SnapshotBuilder;
use iwci_vfs::virtual_fs::{FileSystem as _, FsError, mem_fs};
use serde::Deserialize;
use sha2::Digest;
use shared_buffer::OwnedBuffer;

use crate::fetch::{self, FetchError, Fetcher, Integrity};

pub use dep_path::{
    DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH, dep_path_to_filename, patch_hash, ref_to_relative,
    remove_peers_suffix, remove_suffix, split_name_version,
};
pub use lockfile::{
    DepRef, Importer, Lockfile, Package, PatchedDependency, Resolution, Snapshot, parse_lockfile,
};
pub use patch::Patch;
pub use tarball::DEFAULT_MAX_UNPACKED_BYTES;

/// The public npm registry.
pub const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org/";

/// A host platform as pnpm matches packages' `os`, `cpu` and `libc` fields
/// against it (Node's `process.platform` and `process.arch` names).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Platform {
    pub os: String,
    pub cpu: String,
    /// `glibc` or `musl` on Linux; `None` where there is no C library to
    /// tell apart, which (as in pnpm) accepts any `libc` field.
    pub libc: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PnpmOptions {
    /// Base URL for registry tarballs, with or without a trailing slash.
    pub registry: String,
    /// Per-scope registries (`@my-org` to a URL), as `.npmrc`'s
    /// `@scope:registry=` configures them.
    pub scoped_registries: BTreeMap<String, String>,
    /// Install only these workspace projects (ids as in the lockfile's
    /// `importers`, e.g. `app/packages/web`; `.` is the root) and the
    /// projects they `link:` to, plus everything those depend on. `None`
    /// installs every project.
    pub only_importers: Option<Vec<String>>,
    /// Whether projects' `devDependencies` are installed. Type checking
    /// needs them (`@types/*` are dev dependencies), so on by default.
    pub include_dev: bool,
    /// The platform optional dependencies are matched against; `None` is
    /// the WebAssembly isolate (see the module documentation).
    pub platform: Option<Platform>,
    /// Tarballs fetched and unpacked at once.
    pub parallelism: usize,
    /// The most one package may unpack to.
    pub max_unpacked_bytes: u64,
}

impl Default for PnpmOptions {
    fn default() -> Self {
        Self {
            registry: DEFAULT_REGISTRY.to_string(),
            scoped_registries: BTreeMap::new(),
            only_importers: None,
            include_dev: true,
            platform: None,
            parallelism: fetch::DEFAULT_PARALLELISM,
            max_unpacked_bytes: DEFAULT_MAX_UNPACKED_BYTES,
        }
    }
}

/// What an install did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallReport {
    /// The workspace projects linked, by importer id.
    pub importers: Vec<String>,
    /// Snapshot directories written under the virtual store.
    pub packages: usize,
    /// Distinct tarballs fetched (one per package, whatever its peers).
    pub tarballs: usize,
    /// Compressed bytes fetched.
    pub tarball_bytes: u64,
    /// Files written.
    pub files: usize,
    /// Bytes written.
    pub bytes: u64,
    /// Symlinks created (dependencies, project links and hoisting).
    pub links: usize,
    /// Of those, links created by hoisting.
    pub hoisted: usize,
    /// Optional dependencies skipped for their platform, by dependency
    /// path, sorted.
    pub skipped_optional: Vec<String>,
    /// Snapshots a patch was applied to, by dependency path, sorted.
    pub patched: Vec<String>,
    pub elapsed: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum PnpmError {
    #[error(transparent)]
    Vfs(#[from] iwci_vfs::VfsError),
    #[error("{path}: {message}")]
    Lockfile { path: String, message: String },
    #[error("{path}: {message}")]
    Config { path: String, message: String },
    #[error("{dep_path}: {source}")]
    Fetch {
        dep_path: String,
        #[source]
        source: FetchError,
    },
    #[error("{dep_path}: bad tarball: {message}")]
    Tarball { dep_path: String, message: String },
    #[error("{dep_path}: patch {patch} does not apply: {message}")]
    Patch {
        dep_path: String,
        patch: String,
        message: String,
    },
    #[error("{dep_path}: {message}")]
    Unsupported { dep_path: String, message: String },
}

pub type Result<T> = std::result::Result<T, PnpmError>;

/// The pnpm settings that change the layout, read from the workspace's
/// `.npmrc`, `pnpm-workspace.yaml` (which wins) and root `package.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSettings {
    pub hoist_pattern: Vec<String>,
    pub public_hoist_pattern: Vec<String>,
    pub hoist_workspace_packages: bool,
    /// Relative to the workspace root.
    pub virtual_store_dir: String,
    pub virtual_store_dir_max_length: usize,
    /// Selector (`name@version`) to patch file, relative to the root.
    pub patched_dependencies: BTreeMap<String, String>,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            hoist_pattern: vec!["*".to_string()],
            public_hoist_pattern: Vec::new(),
            hoist_workspace_packages: true,
            virtual_store_dir: "node_modules/.pnpm".to_string(),
            virtual_store_dir_max_length: DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH,
            patched_dependencies: BTreeMap::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Patterns {
    One(String),
    Many(Vec<String>),
}

impl Patterns {
    fn into_vec(self) -> Vec<String> {
        match self {
            Patterns::One(pattern) => vec![pattern],
            Patterns::Many(patterns) => patterns,
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawWorkspace {
    node_linker: Option<String>,
    hoist: Option<bool>,
    hoist_pattern: Option<Patterns>,
    public_hoist_pattern: Option<Patterns>,
    shamefully_hoist: Option<bool>,
    hoist_workspace_packages: Option<bool>,
    virtual_store_dir: Option<String>,
    virtual_store_dir_max_length: Option<usize>,
    patched_dependencies: Option<BTreeMap<String, String>>,
}

impl WorkspaceSettings {
    /// Reads the settings of the workspace rooted at `root`.
    pub fn read(builder: &SnapshotBuilder, root: &Path) -> Result<WorkspaceSettings> {
        let mut raw = RawWorkspace::default();
        let npmrc_path = root.join(".npmrc");
        if let Ok(bytes) = builder.read(&npmrc_path) {
            read_npmrc(&String::from_utf8_lossy(&bytes), &mut raw);
        }
        let workspace_path = root.join("pnpm-workspace.yaml");
        if let Ok(bytes) = builder.read(&workspace_path) {
            let yaml: RawWorkspace =
                serde_yaml_ng::from_slice(&bytes).map_err(|e| PnpmError::Config {
                    path: workspace_path.display().to_string(),
                    message: e.to_string(),
                })?;
            merge(&mut raw, yaml);
        }
        let mut patched = BTreeMap::new();
        if let Ok(bytes) = builder.read(root.join("package.json"))
            && let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes)
            && let Some(map) = manifest
                .pointer("/pnpm/patchedDependencies")
                .and_then(|value| value.as_object())
        {
            for (selector, path) in map {
                if let Some(path) = path.as_str() {
                    patched.insert(selector.clone(), path.to_string());
                }
            }
        }
        patched.extend(raw.patched_dependencies.take().unwrap_or_default());

        if let Some(linker) = raw.node_linker.as_deref()
            && linker != "isolated"
        {
            return Err(PnpmError::Config {
                path: root.display().to_string(),
                message: format!(
                    "nodeLinker {linker} is not supported; only the default isolated layout is"
                ),
            });
        }
        let defaults = WorkspaceSettings::default();
        let mut hoist_pattern = raw
            .hoist_pattern
            .map(Patterns::into_vec)
            .unwrap_or(defaults.hoist_pattern);
        if raw.hoist == Some(false) {
            hoist_pattern.clear();
        }
        let public_hoist_pattern = if raw.shamefully_hoist == Some(true) {
            vec!["*".to_string()]
        } else {
            raw.public_hoist_pattern
                .map(Patterns::into_vec)
                .unwrap_or(defaults.public_hoist_pattern)
        };
        Ok(WorkspaceSettings {
            hoist_pattern,
            public_hoist_pattern,
            hoist_workspace_packages: raw
                .hoist_workspace_packages
                .unwrap_or(defaults.hoist_workspace_packages),
            virtual_store_dir: raw.virtual_store_dir.unwrap_or(defaults.virtual_store_dir),
            virtual_store_dir_max_length: raw
                .virtual_store_dir_max_length
                .unwrap_or(defaults.virtual_store_dir_max_length),
            patched_dependencies: patched,
        })
    }
}

fn merge(into: &mut RawWorkspace, from: RawWorkspace) {
    macro_rules! take {
        ($($field:ident),*) => { $( if from.$field.is_some() { into.$field = from.$field; } )* };
    }
    take!(
        node_linker,
        hoist,
        hoist_pattern,
        public_hoist_pattern,
        shamefully_hoist,
        hoist_workspace_packages,
        virtual_store_dir,
        virtual_store_dir_max_length,
        patched_dependencies
    );
}

/// The layout keys of an `.npmrc` (`key=value`, `key[]=value` for lists).
fn read_npmrc(text: &str, raw: &mut RawWorkspace) {
    let mut hoist_pattern = Vec::new();
    let mut public_hoist_pattern = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim().trim_matches('"'));
        let flag = || Some(value == "true");
        match key {
            "node-linker" => raw.node_linker = Some(value.to_string()),
            "hoist" => raw.hoist = flag(),
            "shamefully-hoist" => raw.shamefully_hoist = flag(),
            "hoist-workspace-packages" => raw.hoist_workspace_packages = flag(),
            "virtual-store-dir" => raw.virtual_store_dir = Some(value.to_string()),
            "virtual-store-dir-max-length" => {
                raw.virtual_store_dir_max_length = value.parse().ok();
            }
            "hoist-pattern" | "hoist-pattern[]" => hoist_pattern.push(value.to_string()),
            "public-hoist-pattern" | "public-hoist-pattern[]" => {
                public_hoist_pattern.push(value.to_string());
            }
            _ => {}
        }
    }
    if !hoist_pattern.is_empty() {
        raw.hoist_pattern = Some(Patterns::Many(hoist_pattern));
    }
    if !public_hoist_pattern.is_empty() {
        raw.public_hoist_pattern = Some(Patterns::Many(public_hoist_pattern));
    }
}

/// Whether the optional dependency `package` installs on `platform`
/// (`None`: the isolate). A port of pnpm's `checkPlatform` for a single
/// host, after its `effectivePlatform`, which fills platform fields a
/// registry left out from the package name's tokens.
pub fn platform_accepts(platform: Option<&Platform>, package: &Package) -> bool {
    let (os, cpu, libc) = effective_platform(package);
    let libc_ok = match platform {
        // pnpm skips the libc check when the host's C library is unknown.
        Some(Platform { libc: None, .. }) => true,
        Some(Platform {
            libc: Some(current),
            ..
        }) => axis_accepts(Some(current), &libc),
        None => axis_accepts(None, &libc),
    };
    axis_accepts(platform.map(|p| p.os.as_str()), &os)
        // The isolate's cpu is wasm32: what the `wasm32` builds of native
        // packages are compiled for.
        && axis_accepts(Some(platform.map_or("wasm32", |p| p.cpu.as_str())), &cpu)
        && libc_ok
}

/// Port of pnpm's `effectivePlatform` and `inferPlatformFromPackageName`
/// (`config/package-is-installable`): `@nx/nx-win32-arm64-msvc` wants
/// win32 on arm64 even if its metadata lost the fields. A package that
/// declares nothing is only treated as a binary when its name has an
/// operating system and a cpu or libc token, so `@electron/windows-sign`
/// stays installable.
fn effective_platform(package: &Package) -> (Vec<String>, Vec<String>, Vec<String>) {
    let declared = (
        package.os.clone(),
        package.cpu.clone(),
        package.libc.clone(),
    );
    if !package.os.is_empty() && !package.cpu.is_empty() && !package.libc.is_empty() {
        return declared;
    }
    let name = package
        .name
        .split_once('/')
        .map_or(package.name.as_str(), |(_, rest)| rest);
    let lowercase = name.to_lowercase();
    let tokens: Vec<&str> = lowercase.split(['-', '_', '.']).collect();
    let pick = |value_for: fn(&str) -> Option<&'static str>| {
        let mut values: Vec<String> = Vec::new();
        for token in &tokens {
            if let Some(value) = value_for(token)
                && !values.iter().any(|seen| seen == value)
            {
                values.push(value.to_string());
            }
        }
        values
    };
    let os = pick(|token| match token {
        "aix" => Some("aix"),
        "android" => Some("android"),
        "darwin" | "macos" | "osx" => Some("darwin"),
        "freebsd" => Some("freebsd"),
        "linux" => Some("linux"),
        "netbsd" => Some("netbsd"),
        "openbsd" => Some("openbsd"),
        "openharmony" => Some("openharmony"),
        "sunos" => Some("sunos"),
        "win32" | "windows" => Some("win32"),
        _ => None,
    });
    let cpu = pick(|token| match token {
        "arm" | "armv6" | "armv7" => Some("arm"),
        "arm64" | "aarch64" => Some("arm64"),
        "ia32" => Some("ia32"),
        "loong64" => Some("loong64"),
        "mips64el" => Some("mips64el"),
        "ppc64" | "ppc64le" => Some("ppc64"),
        "riscv64" => Some("riscv64"),
        "s390x" => Some("s390x"),
        "x64" | "amd64" => Some("x64"),
        "wasm32" => Some("wasm32"),
        _ => None,
    });
    let libc = pick(|token| match token {
        "glibc" | "gnu" | "gnueabihf" => Some("glibc"),
        "musl" | "musleabihf" => Some("musl"),
        _ => None,
    });
    let declares = !package.os.is_empty() || !package.cpu.is_empty() || !package.libc.is_empty();
    let names_binary = !os.is_empty() && (!cpu.is_empty() || !libc.is_empty());
    if !declares && !names_binary {
        return declared;
    }
    let or = |declared: Vec<String>, inferred: Vec<String>| {
        if declared.is_empty() {
            inferred
        } else {
            declared
        }
    };
    (
        or(declared.0, os),
        or(declared.1, cpu),
        or(declared.2, libc),
    )
}

fn axis_accepts(current: Option<&str>, wanted: &[String]) -> bool {
    if wanted.is_empty() || (wanted.len() == 1 && wanted[0] == "any") {
        return true;
    }
    for entry in wanted {
        if let Some(excluded) = entry.strip_prefix('!') {
            if Some(excluded) == current {
                return false;
            }
        } else if Some(entry.as_str()) == current {
            return true;
        }
    }
    wanted.iter().all(|entry| entry.starts_with('!'))
}

/// One installed snapshot.
struct Entry<'a> {
    package: &'a Package,
    snapshot: &'a Snapshot,
    dir: String,
}

/// What to install: the projects, the snapshots their dependencies close
/// over, and which optional ones the platform rules out.
struct Plan<'a> {
    importers: Vec<&'a str>,
    installed: BTreeMap<&'a str, Entry<'a>>,
    skipped: BTreeSet<&'a str>,
    /// Every snapshot the projects reach, through skipped ones too: the
    /// graph hoisting walks.
    reachable: BTreeSet<&'a str>,
}

fn lockfile_error(message: impl Into<String>) -> PnpmError {
    PnpmError::Lockfile {
        path: "pnpm-lock.yaml".to_string(),
        message: message.into(),
    }
}

/// An importer's direct dependencies, `(alias, reference)`, merged as pnpm
/// merges them (`{...dev, ...prod, ...optional}`): an alias keeps the
/// position of the first group that names it and the reference of the
/// last.
fn importer_deps(importer: &Importer, include_dev: bool) -> Vec<(&str, &str)> {
    let mut position: HashMap<&str, usize> = HashMap::new();
    let mut out: Vec<(&str, &str)> = Vec::new();
    let groups = [
        include_dev.then_some(&importer.dev_dependencies),
        Some(&importer.dependencies),
        Some(&importer.optional_dependencies),
    ];
    for group in groups.into_iter().flatten() {
        for (alias, reference) in group {
            match position.get(alias.as_str()) {
                Some(&index) => out[index].1 = reference.as_str(),
                None => {
                    position.insert(alias.as_str(), out.len());
                    out.push((alias.as_str(), reference.as_str()));
                }
            }
        }
    }
    out
}

fn snapshot_deps(snapshot: &Snapshot) -> impl Iterator<Item = (&String, &String)> {
    snapshot
        .dependencies
        .iter()
        .chain(snapshot.optional_dependencies.iter())
}

/// `link` (a `/`-separated relative path) taken from the project `from`,
/// as an importer id, or `None` if it leaves the workspace.
fn link_target_id(from: &str, link: &str) -> Option<String> {
    let mut parts: Vec<&str> = if from == "." {
        Vec::new()
    } else {
        from.split('/').collect()
    };
    for part in link.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    Some(if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    })
}

/// An importer id as the lockfile writes it: no `./`, no trailing `/`.
fn normalise_importer_id(id: &str) -> String {
    let trimmed = id.trim_start_matches("./").trim_end_matches('/');
    if trimmed.is_empty() {
        ".".to_string()
    } else {
        trimmed.to_string()
    }
}

impl<'a> Plan<'a> {
    fn build(
        lockfile: &'a Lockfile,
        settings: &WorkspaceSettings,
        options: &PnpmOptions,
    ) -> Result<Plan<'a>> {
        if lockfile.inject_workspace_packages {
            return Err(lockfile_error(
                "injectWorkspacePackages is not supported; workspace packages must be links",
            ));
        }
        let importers = select_importers(lockfile, options)?;

        let mut roots: Vec<String> = Vec::new();
        for id in &importers {
            for (alias, reference) in importer_deps(&lockfile.importers[*id], options.include_dev) {
                if let DepRef::Snapshot(dep_path) = DepRef::parse(alias, reference) {
                    roots.push(dep_path);
                }
            }
        }

        let mut installed = BTreeMap::new();
        let mut skipped = BTreeSet::new();
        let mut queue: VecDeque<String> = roots.iter().cloned().collect();
        while let Some(dep_path) = queue.pop_front() {
            let Some((key, snapshot)) = lockfile.snapshots.get_key_value(dep_path.as_str()) else {
                return Err(lockfile_error(format!(
                    "{dep_path} is depended on but has no entry under snapshots"
                )));
            };
            let key = key.as_str();
            if installed.contains_key(key) || skipped.contains(key) {
                continue;
            }
            let package = lockfile.package(key).ok_or_else(|| {
                lockfile_error(format!(
                    "{key} has no entry under packages ({})",
                    remove_suffix(key)
                ))
            })?;
            if snapshot.optional && !platform_accepts(options.platform.as_ref(), package) {
                skipped.insert(key);
                continue;
            }
            let dir = dep_path_to_filename(key, settings.virtual_store_dir_max_length);
            installed.insert(
                key,
                Entry {
                    package,
                    snapshot,
                    dir,
                },
            );
            for (alias, reference) in snapshot_deps(snapshot) {
                if let DepRef::Snapshot(child) = DepRef::parse(alias, reference) {
                    queue.push_back(child);
                }
            }
        }

        let mut dirs: HashMap<&str, &str> = HashMap::new();
        for (dep_path, entry) in &installed {
            if let Some(other) = dirs.insert(&entry.dir, dep_path) {
                return Err(lockfile_error(format!(
                    "{other} and {dep_path} map to the same directory {}",
                    entry.dir
                )));
            }
        }

        let mut reachable = BTreeSet::new();
        let mut queue: VecDeque<String> = roots.into_iter().collect();
        while let Some(dep_path) = queue.pop_front() {
            let Some((key, snapshot)) = lockfile.snapshots.get_key_value(dep_path.as_str()) else {
                continue;
            };
            if !reachable.insert(key.as_str()) {
                continue;
            }
            for (alias, reference) in snapshot_deps(snapshot) {
                if let DepRef::Snapshot(child) = DepRef::parse(alias, reference) {
                    queue.push_back(child);
                }
            }
        }

        Ok(Plan {
            importers,
            installed,
            skipped,
            reachable,
        })
    }

    /// The hoisting decisions for this plan, given each workspace
    /// project's package name.
    fn hoist(
        &self,
        lockfile: &'a Lockfile,
        settings: &WorkspaceSettings,
        options: &PnpmOptions,
        project_names: &BTreeMap<String, String>,
    ) -> Vec<hoist::Hoisted> {
        let private = hoist::Matcher::new(&settings.hoist_pattern);
        let public = hoist::Matcher::new(&settings.public_hoist_pattern);
        if private.is_empty() && public.is_empty() {
            return Vec::new();
        }
        let mut graph = HashMap::with_capacity(self.reachable.len());
        for dep_path in &self.reachable {
            let snapshot = &lockfile.snapshots[*dep_path];
            let mut children: Vec<(String, String)> = Vec::new();
            let mut positions: HashMap<String, usize> = HashMap::new();
            for (alias, reference) in snapshot_deps(snapshot) {
                let DepRef::Snapshot(child) = DepRef::parse(alias, reference) else {
                    continue;
                };
                // A later group naming the same alias replaces the target
                // in place, as an ordered map insert does in pnpm.
                match positions.get(alias) {
                    Some(&index) => children[index].1 = child,
                    None => {
                        positions.insert(alias.clone(), children.len());
                        children.push((alias.clone(), child));
                    }
                }
            }
            let sort_key = match self.installed.get(dep_path) {
                Some(entry) => entry.dir.clone(),
                None => dep_path_to_filename(dep_path, settings.virtual_store_dir_max_length),
            };
            graph.insert(
                dep_path.to_string(),
                hoist::GraphNode { children, sort_key },
            );
        }

        let mut direct: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for id in &self.importers {
            let importer = &lockfile.importers[*id];
            let ordered: Vec<(String, String)> = importer_deps(importer, options.include_dev)
                .into_iter()
                .filter_map(|(alias, reference)| match DepRef::parse(alias, reference) {
                    DepRef::Snapshot(dep_path) => Some((alias.to_string(), dep_path)),
                    DepRef::Link(_) => None,
                })
                .collect();
            direct.insert(id.to_string(), ordered);
        }

        let workspace_packages = settings.hoist_workspace_packages.then(|| {
            self.importers
                .iter()
                .filter(|id| **id != ".")
                .filter_map(|id| Some((project_names.get(*id)?.clone(), id.to_string())))
                .collect()
        });
        let installed = |dep_path: &str| self.installed.contains_key(dep_path);
        hoist::hoist(&hoist::HoistInput {
            graph: &graph,
            direct_deps_by_importer: &direct,
            installed: &installed,
            private,
            public,
            workspace_packages,
        })
    }

    /// The patch hashes the installed snapshots need.
    fn patch_hashes(&self) -> BTreeSet<&'a str> {
        self.installed
            .keys()
            .filter_map(|dep_path| patch_hash(dep_path))
            .collect()
    }
}

fn select_importers<'a>(lockfile: &'a Lockfile, options: &PnpmOptions) -> Result<Vec<&'a str>> {
    let mut selected: BTreeSet<&'a str> = BTreeSet::new();
    match &options.only_importers {
        None => selected.extend(lockfile.importers.keys().map(String::as_str)),
        Some(ids) => {
            for id in ids {
                let id = normalise_importer_id(id);
                let (key, _) = lockfile
                    .importers
                    .get_key_value(id.as_str())
                    .ok_or_else(|| lockfile_error(format!("no importer {id}")))?;
                selected.insert(key.as_str());
            }
        }
    }
    // A project that links to another needs that one's dependencies too:
    // resolution follows the link into its sources and on into its own
    // `node_modules`.
    let mut queue: Vec<&'a str> = selected.iter().copied().collect();
    while let Some(id) = queue.pop() {
        for (alias, reference) in importer_deps(&lockfile.importers[id], options.include_dev) {
            if let DepRef::Link(path) = DepRef::parse(alias, reference)
                && let Some(target) = link_target_id(id, &path)
                && let Some((key, _)) = lockfile.importers.get_key_value(target.as_str())
                && selected.insert(key.as_str())
            {
                queue.push(key.as_str());
            }
        }
    }
    Ok(selected.into_iter().collect())
}

/// A patch file, parsed, by the hash the lockfile pins it under.
struct LoadedPatch {
    path: String,
    patch: Arc<Patch>,
}

/// pnpm 10 and later hash a patch file as the SHA-256 of its text with
/// CRLF line ends turned into LF.
fn patch_file_hash(bytes: &[u8]) -> String {
    let mut normalised = Vec::with_capacity(bytes.len());
    let mut iter = bytes.iter().peekable();
    while let Some(&b) = iter.next() {
        if b == b'\r' && iter.peek() == Some(&&b'\n') {
            continue;
        }
        normalised.push(b);
    }
    hex::encode(sha2::Sha256::digest(&normalised))
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

fn load_patches(
    builder: &SnapshotBuilder,
    root: &Path,
    lockfile: &Lockfile,
    settings: &WorkspaceSettings,
    needed: &BTreeSet<&str>,
) -> Result<HashMap<String, LoadedPatch>> {
    let mut loaded = HashMap::new();
    if needed.is_empty() {
        return Ok(loaded);
    }
    let read = |path: &str| -> Result<Vec<u8>> {
        let full = iwci_vfs::join_under(root, path)?;
        builder.read(&full).map_err(|_| PnpmError::Config {
            path: full.display().to_string(),
            message: "patch file named in patchedDependencies is not in the repository".to_string(),
        })
    };
    // Hash to path, and paths whose content no longer matches the hash the
    // lockfile pinned for their selector.
    let mut by_hash: HashMap<String, String> = HashMap::new();
    let mut stale: HashMap<String, String> = HashMap::new();
    for entry in lockfile.patched_dependencies.values() {
        if let Some(path) = &entry.path {
            by_hash.insert(entry.hash.clone(), path.clone());
        }
    }
    let mut contents: HashMap<String, Vec<u8>> = HashMap::new();
    for (selector, path) in &settings.patched_dependencies {
        let bytes = read(path)?;
        let computed = patch_file_hash(&bytes);
        if let Some(locked) = lockfile.patched_dependencies.get(selector)
            && locked.hash != computed
        {
            if is_sha256_hex(&locked.hash) {
                stale.insert(locked.hash.clone(), path.clone());
            } else {
                // An older pnpm hashed patches another way; the selector
                // still says which file it meant.
                by_hash
                    .entry(locked.hash.clone())
                    .or_insert_with(|| path.clone());
            }
        }
        by_hash.entry(computed).or_insert_with(|| path.clone());
        contents.insert(path.clone(), bytes);
    }
    for hash in needed {
        let Some(path) = by_hash.get(*hash) else {
            let message = match stale.get(*hash) {
                Some(path) => format!(
                    "{path} has changed since pnpm-lock.yaml was written (the lockfile pins patch hash {hash}); run pnpm install"
                ),
                None => format!(
                    "the lockfile pins patch hash {hash}, but no patchedDependencies entry has that content"
                ),
            };
            return Err(lockfile_error(message));
        };
        let bytes = match contents.get(path) {
            Some(bytes) => bytes.clone(),
            None => read(path)?,
        };
        let patch = Patch::parse(&bytes).map_err(|message| PnpmError::Config {
            path: path.clone(),
            message,
        })?;
        loaded.insert(
            hash.to_string(),
            LoadedPatch {
                path: path.clone(),
                patch: Arc::new(patch),
            },
        );
    }
    Ok(loaded)
}

/// Where a package's tarball comes from.
enum Source {
    Remote {
        url: String,
        integrity: Integrity,
    },
    /// A `file:` tarball inside the repository. Its integrity is checked
    /// when the lockfile has one; the bytes come from the commit itself.
    Local {
        path: PathBuf,
        integrity: Option<Integrity>,
    },
}

/// Snapshot directories that share one patch variant: `(dep path, dir)`.
type Targets<'a> = Vec<(&'a str, &'a str)>;

/// One tarball and every directory it is unpacked into.
struct Job<'a> {
    /// The package key (`name@version`).
    key: &'a str,
    package: &'a Package,
    source: Source,
    /// One per patch variant (unpatched is `None`).
    variants: Vec<(Option<&'a LoadedPatch>, Targets<'a>)>,
}

fn registry_url(options: &PnpmOptions, name: &str, version: &str) -> String {
    let registry = name
        .split_once('/')
        .filter(|(scope, _)| scope.starts_with('@'))
        .and_then(|(scope, _)| options.scoped_registries.get(scope))
        .unwrap_or(&options.registry);
    let registry = registry.trim_end_matches('/');
    let basename = name.rsplit('/').next().unwrap_or(name);
    format!("{registry}/{name}/-/{basename}-{version}.tgz")
}

fn source_of(root: &Path, key: &str, package: &Package, options: &PnpmOptions) -> Result<Source> {
    let unsupported = |message: String| PnpmError::Unsupported {
        dep_path: key.to_string(),
        message,
    };
    match &package.resolution {
        Resolution::Registry { integrity } => Ok(Source::Remote {
            url: registry_url(options, &package.name, &package.version),
            integrity: Integrity::Sri(integrity.clone()),
        }),
        Resolution::Tarball { url, integrity } => {
            if let Some(path) = url.strip_prefix("file:") {
                return Ok(Source::Local {
                    path: iwci_vfs::join_under(root, path)?,
                    integrity: integrity.clone().map(Integrity::Sri),
                });
            }
            match integrity {
                Some(integrity) => Ok(Source::Remote {
                    url: url.clone(),
                    integrity: Integrity::Sri(integrity.clone()),
                }),
                None => Err(unsupported(format!(
                    "tarball {url} has no integrity in the lockfile, so it cannot be verified"
                ))),
            }
        }
        Resolution::Directory { path } => Err(unsupported(format!(
            "directory dependencies (file:{path}) are not supported"
        ))),
        Resolution::Git { repo, .. } => Err(unsupported(format!(
            "git dependencies ({repo}) are not supported"
        ))),
        Resolution::Other(what) => Err(unsupported(format!("{what} is not supported"))),
    }
}

/// Writes `files` under `base`, creating each directory once. Files are
/// inserted as read-only nodes over the shared buffers, the way pnpm
/// hardlinks a package's files from its store: the bytes are not copied
/// (so not copied while holding the file system's one lock), and every
/// directory that holds the package shares them. The snapshot is frozen
/// before any job runs, and a job's writes land in its own overlay layer,
/// so nothing ever writes to these nodes.
fn write_tree(
    fs: &mem_fs::FileSystem,
    base: &Path,
    files: &BTreeMap<String, OwnedBuffer>,
) -> Result<(usize, u64)> {
    let fs_error = |path: &Path, source: FsError| {
        PnpmError::Vfs(iwci_vfs::VfsError::Fs {
            path: path.display().to_string(),
            source,
        })
    };
    iwci_vfs::create_dir_all(fs, base)?;
    let mut dirs: BTreeSet<&str> = BTreeSet::new();
    for path in files.keys() {
        let mut end = 0;
        while let Some(index) = path[end..].find('/') {
            end += index;
            dirs.insert(&path[..end]);
            end += 1;
        }
    }
    // Sorted, so every parent comes before its children.
    for dir in dirs {
        let full = base.join(dir);
        match fs.create_dir(&full) {
            Ok(()) | Err(FsError::AlreadyExists) => {}
            Err(source) => return Err(fs_error(&full, source)),
        }
    }
    let mut bytes = 0u64;
    for (path, contents) in files {
        let full = base.join(path);
        fs.insert_ro_file(&full, contents.clone())
            .map_err(|source| fs_error(&full, source))?;
        bytes += contents.len() as u64;
    }
    Ok((files.len(), bytes))
}

#[derive(Default)]
struct JobStats {
    tarball_bytes: u64,
    packages: usize,
    files: usize,
    bytes: u64,
}

fn run_job(
    fs: &mem_fs::FileSystem,
    store: &Path,
    fetcher: &dyn Fetcher,
    job: &Job<'_>,
    options: &PnpmOptions,
) -> Result<JobStats> {
    let bytes: Arc<[u8]> = match &job.source {
        Source::Remote { url, integrity } => {
            fetcher
                .fetch(url, integrity)
                .map_err(|source| PnpmError::Fetch {
                    dep_path: job.key.to_string(),
                    source,
                })?
        }
        Source::Local { path, integrity } => {
            let bytes = iwci_vfs::read_file(fs, path)?;
            if let Some(integrity) = integrity {
                fetch::verify(&path.display().to_string(), &bytes, integrity).map_err(
                    |source| PnpmError::Fetch {
                        dep_path: job.key.to_string(),
                        source,
                    },
                )?;
            }
            bytes.into()
        }
    };
    let files = tarball::extract(&bytes, options.max_unpacked_bytes).map_err(|message| {
        PnpmError::Tarball {
            dep_path: job.key.to_string(),
            message,
        }
    })?;
    let mut stats = JobStats {
        tarball_bytes: bytes.len() as u64,
        ..JobStats::default()
    };
    drop(bytes);
    let shared = |files: BTreeMap<String, Vec<u8>>| -> BTreeMap<String, OwnedBuffer> {
        files
            .into_iter()
            .map(|(path, bytes)| (path, OwnedBuffer::from(bytes)))
            .collect()
    };
    let files = shared(files);
    for (patch, targets) in &job.variants {
        let patched;
        let tree = match patch {
            None => &files,
            Some(loaded) => {
                let mut copy: BTreeMap<String, Vec<u8>> = files
                    .iter()
                    .map(|(path, bytes)| (path.clone(), bytes.as_slice().to_vec()))
                    .collect();
                loaded
                    .patch
                    .apply(&mut copy)
                    .map_err(|message| PnpmError::Patch {
                        dep_path: job.key.to_string(),
                        patch: loaded.path.clone(),
                        message,
                    })?;
                patched = shared(copy);
                &patched
            }
        };
        for (_, dir) in targets {
            let base =
                iwci_vfs::join_under(store, format!("{dir}/node_modules/{}", job.package.name))?;
            let (files, bytes) = write_tree(fs, &base, tree)?;
            stats.packages += 1;
            stats.files += files;
            stats.bytes += bytes;
        }
    }
    Ok(stats)
}

/// `to` relative to the directory `from_dir`; both absolute and normalised.
fn relative(from_dir: &Path, to: &Path) -> PathBuf {
    let from: Vec<Component<'_>> = from_dir.components().collect();
    let to: Vec<Component<'_>> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut out = PathBuf::new();
    for _ in common..from.len() {
        out.push("..");
    }
    for component in &to[common..] {
        out.push(component);
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// `link` from the directory `base`, resolving `..` lexically.
fn lexical_join(base: &Path, link: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for part in link.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if !out.pop() {
                    return None;
                }
            }
            part => out.push(part),
        }
    }
    Some(out)
}

fn importer_dir(root: &Path, id: &str) -> Result<PathBuf> {
    if id == "." {
        Ok(root.to_path_buf())
    } else {
        Ok(iwci_vfs::join_under(root, id)?)
    }
}

/// Installs the dependencies of the pnpm workspace whose `pnpm-lock.yaml`
/// is at `<root>/pnpm-lock.yaml` into `builder`, fetching every tarball
/// through `fetcher`.
pub fn install(
    builder: &SnapshotBuilder,
    root: &str,
    fetcher: &dyn Fetcher,
    options: &PnpmOptions,
) -> Result<InstallReport> {
    let started = Instant::now();
    let root = iwci_vfs::normalise(root)?;
    let lock_path = root.join("pnpm-lock.yaml");
    let lock_name = lock_path.display().to_string();
    let text = builder.read(&lock_path).map_err(|_| PnpmError::Lockfile {
        path: lock_name.clone(),
        message: "not found".to_string(),
    })?;
    let text = String::from_utf8(text).map_err(|_| PnpmError::Lockfile {
        path: lock_name.clone(),
        message: "not UTF-8".to_string(),
    })?;
    let with_path = |error: PnpmError| match error {
        PnpmError::Lockfile { message, .. } => PnpmError::Lockfile {
            path: lock_name.clone(),
            message,
        },
        other => other,
    };
    let lockfile = parse_lockfile(&text).map_err(with_path)?;
    let settings = WorkspaceSettings::read(builder, &root)?;
    let plan = Plan::build(&lockfile, &settings, options).map_err(with_path)?;
    let store = iwci_vfs::join_under(&root, &settings.virtual_store_dir)?;
    let patches = load_patches(builder, &root, &lockfile, &settings, &plan.patch_hashes())
        .map_err(with_path)?;

    // One job per package: peer variants share a tarball, and patch
    // variants share the unpacking.
    let mut grouped: BTreeMap<&str, BTreeMap<Option<&str>, Targets<'_>>> = BTreeMap::new();
    for (dep_path, entry) in &plan.installed {
        grouped
            .entry(remove_suffix(dep_path))
            .or_default()
            .entry(patch_hash(dep_path))
            .or_default()
            .push((dep_path, entry.dir.as_str()));
    }
    let mut jobs = Vec::with_capacity(grouped.len());
    let mut patched = Vec::new();
    for (key, variants) in grouped {
        let package = &lockfile.packages[key];
        let source = source_of(&root, key, package, options)?;
        let mut job_variants = Vec::with_capacity(variants.len());
        for (hash, targets) in variants {
            let patch = hash.map(|hash| &patches[hash]);
            if patch.is_some() {
                patched.extend(targets.iter().map(|(dep_path, _)| dep_path.to_string()));
            }
            job_variants.push((patch, targets));
        }
        jobs.push(Job {
            key,
            package,
            source,
            variants: job_variants,
        });
    }

    let fs = builder.fs();
    let abort = AtomicBool::new(false);
    let results = fetch::parallel_map(&jobs, options.parallelism, |job| {
        if abort.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let result = run_job(fs, &store, fetcher, job, options);
        if result.is_err() {
            abort.store(true, Ordering::Relaxed);
        }
        result.map(Some)
    });
    let mut report = InstallReport::default();
    for result in results {
        if let Some(stats) = result? {
            report.tarballs += 1;
            report.tarball_bytes += stats.tarball_bytes;
            report.packages += stats.packages;
            report.files += stats.files;
            report.bytes += stats.bytes;
        }
    }

    let package_dir = |entry: &Entry<'_>| -> Result<PathBuf> {
        Ok(iwci_vfs::join_under(
            &store,
            format!("{}/node_modules/{}", entry.dir, entry.package.name),
        )?)
    };
    let mut links: Vec<(PathBuf, PathBuf)> = Vec::new();
    for entry in plan.installed.values() {
        let modules = iwci_vfs::join_under(&store, format!("{}/node_modules", entry.dir))?;
        for (alias, reference) in snapshot_deps(entry.snapshot) {
            // The package itself already sits under its own name here.
            if alias == &entry.package.name {
                continue;
            }
            if let DepRef::Snapshot(child) = DepRef::parse(alias, reference)
                && let Some(child) = plan.installed.get(child.as_str())
            {
                links.push((iwci_vfs::join_under(&modules, alias)?, package_dir(child)?));
            }
        }
    }
    let mut project_names = BTreeMap::new();
    for id in &plan.importers {
        let dir = importer_dir(&root, id)?;
        if let Ok(bytes) = builder.read(dir.join("package.json"))
            && let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes)
            && let Some(name) = manifest.get("name").and_then(|name| name.as_str())
        {
            project_names.insert(id.to_string(), name.to_string());
        }
        let modules = dir.join("node_modules");
        for (alias, reference) in importer_deps(&lockfile.importers[*id], options.include_dev) {
            match DepRef::parse(alias, reference) {
                DepRef::Snapshot(dep_path) => {
                    if let Some(entry) = plan.installed.get(dep_path.as_str()) {
                        links.push((iwci_vfs::join_under(&modules, alias)?, package_dir(entry)?));
                    }
                }
                DepRef::Link(path) => {
                    let target = lexical_join(&dir, &path).ok_or_else(|| {
                        lockfile_error(format!("{id}: link:{path} leaves the file system"))
                    })?;
                    links.push((iwci_vfs::join_under(&modules, alias)?, target));
                }
            }
        }
    }
    let hoisted = plan.hoist(&lockfile, &settings, options, &project_names);
    report.hoisted = hoisted.len();
    let private_modules = store.join("node_modules");
    let public_modules = root.join("node_modules");
    for hoisted in hoisted {
        let modules = match hoisted.kind {
            hoist::HoistKind::Private => &private_modules,
            hoist::HoistKind::Public => &public_modules,
        };
        let target = match &hoisted.target {
            hoist::HoistTarget::Snapshot(dep_path) => {
                package_dir(&plan.installed[dep_path.as_str()])?
            }
            hoist::HoistTarget::Project(id) => importer_dir(&root, id)?,
        };
        links.push((iwci_vfs::join_under(modules, &hoisted.alias)?, target));
    }

    let mut made = HashSet::new();
    for (link, target) in links {
        if !made.insert(link.clone()) {
            continue;
        }
        let parent = link.parent().unwrap_or(Path::new("/"));
        iwci_vfs::symlink(fs, &link, relative(parent, &target))?;
    }
    report.links = made.len();
    report.importers = plan.importers.iter().map(|id| id.to_string()).collect();
    report.skipped_optional = plan
        .skipped
        .iter()
        .map(|dep_path| dep_path.to_string())
        .collect();
    patched.sort();
    report.patched = patched;
    report.elapsed = started.elapsed();
    Ok(report)
}
