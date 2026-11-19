//! Installs an npm project's `node_modules` from `package-lock.json` (or
//! `npm-shrinkwrap.json`), without npm and without running any install
//! script.
//!
//! # Layout
//!
//! The result is the tree `npm ci` lays out. A lockfile npm 7 or later
//! wrote records that tree itself: every entry of its `packages` map is
//! keyed by where it is installed, so each package is unpacked at its key
//! (`node_modules/is-odd/node_modules/is-number`, or
//! `packages/web/node_modules/ms` for a copy a workspace needs of its
//! own), and an entry with `link: true` is a symlink to the directory its
//! `resolved` names (each workspace at `node_modules/<name>`, and a
//! `file:` directory dependency). An `npm:` alias is unpacked under the
//! alias, from the package the entry's `name` says. A package npm marks
//! `inBundle` inside another package comes with that package's tarball and
//! is not fetched again; one the root or a workspace bundles is fetched as
//! any other, as npm does. Entries npm would prune (`extraneous`) are left
//! out.
//!
//! Every `node_modules` gets the `.bin` npm links into it (see
//! `bin_links`; commands are read by [`crate::node_bins`]), so `npm run`
//! finds a dependency's command by name. In the isolate, a registry
//! package that only works natively (`rollup` 4, `esbuild`,
//! `lightningcss`) is installed as its WebAssembly build
//! ([`crate::wasm_builds`]).
//!
//! Left out: npm's hidden lockfile (`node_modules/.package-lock.json`) and
//! every install script. A warning names the packages `npm ci` would have
//! run scripts for.
//!
//! # Platform
//!
//! The isolate is the platform [`crate::pnpm`] describes: cpu `wasm32`, no
//! operating system. An optional package (`optional: true`, so everything
//! that leads to it is optional) whose `os`, `cpu` or `libc` rule that out
//! is skipped together with its *optional set*, as Arborist computes it
//! (`lib/optional-set.js`): the packages that need it without the option
//! of doing without, up to the optional dependency that brought it in, and
//! everything only those depend on. A package that is not optional is
//! installed whatever its platform fields say: npm would refuse the install
//! with `EBADPLATFORM` on a real mismatched host, and here the files are
//! inert. Setting [`NpmOptions::platform`] reproduces what `npm ci` keeps on
//! that host, with npm's own check (`npm-install-checks`), which is what
//! the comparison tests use; the isolate is matched as pnpm matches it,
//! which also reads a native build's platform from its name when the
//! lockfile records no `os`, `cpu` or `libc` for it. `engines` is not
//! checked.
//!
//! # Lockfile support
//!
//! `lockfileVersion` 2 (npm 7 and 8) and 3 (npm 9 and later). Registry
//! packages, `npm:` aliases, workspaces, links, bundled dependencies,
//! tarballs by URL and tarballs in the repository (`file:x.tgz`), each
//! checked against the lockfile's `integrity` (`sha512-`, or `sha1-` for
//! packages old enough to have nothing else). `registry`,
//! `@scope:registry` and `replace-registry-host` are read from the
//! project's `.npmrc`, so `registry.npmjs.org` in `resolved` stands for the
//! configured registry as it does for npm. Refused with a clear error:
//! version 1 lockfiles, git dependencies, directories installed as copies
//! (`install-links`), remote tarballs without an integrity, and a
//! `package.json` whose dependencies the lockfile does not list (what
//! `npm ci` calls out of sync).

mod lockfile;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use iwci_vfs::SnapshotBuilder;
use iwci_vfs::virtual_fs::mem_fs;
use shared_buffer::OwnedBuffer;

use crate::fetch::{self, FetchError, Fetcher, Integrity};
use crate::node_bins;
use crate::npmrc::Npmrc;
use crate::pnpm::{self, Platform};
use crate::wasm_builds::{self, Substitution, WasmBuild};

pub use lockfile::{Entry, Lockfile, MAX_LOCKFILE_VERSION, parse_lockfile};

/// The public npm registry.
pub const DEFAULT_REGISTRY: &str = pnpm::DEFAULT_REGISTRY;

/// The lockfiles npm reads, in the order it prefers them.
pub const LOCKFILES: [&str; 2] = ["npm-shrinkwrap.json", "package-lock.json"];

/// The files an install reads besides the packages' own and the projects'
/// `package.json`s: what a cache of its result is keyed on.
pub const INPUT_FILES: [&str; 3] = ["npm-shrinkwrap.json", "package-lock.json", ".npmrc"];

#[derive(Debug, Clone)]
pub struct NpmOptions {
    /// The registry when `.npmrc` names none.
    pub registry: String,
    /// Whether `dev` packages are installed, as `npm ci` does by default.
    /// Type checking needs them.
    pub include_dev: bool,
    /// The platform optional dependencies are matched against; `None` is
    /// the WebAssembly isolate.
    pub platform: Option<Platform>,
    /// A second platform an optional dependency may be for, as for pnpm
    /// ([`pnpm::PnpmOptions::native`]).
    pub native: Option<Platform>,
    /// Native packages installed as their WebAssembly build for the
    /// isolate (`platform: None`); see [`wasm_builds`]. An option, so a
    /// cache keyed on the options changes when the table does.
    pub wasm_builds: &'static [WasmBuild],
    /// Tarballs fetched and unpacked at once.
    pub parallelism: usize,
    /// The most one package may unpack to.
    pub max_unpacked_bytes: u64,
}

impl Default for NpmOptions {
    fn default() -> Self {
        Self {
            registry: DEFAULT_REGISTRY.to_string(),
            include_dev: true,
            platform: None,
            native: None,
            wasm_builds: wasm_builds::WASM_BUILDS,
            parallelism: fetch::DEFAULT_PARALLELISM,
            max_unpacked_bytes: pnpm::DEFAULT_MAX_UNPACKED_BYTES,
        }
    }
}

/// What an install did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallReport {
    /// The lockfile read (`package-lock.json` or `npm-shrinkwrap.json`).
    pub lockfile: String,
    pub lockfile_version: u64,
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
    /// Packages that came inside another package's tarball.
    pub bundled: usize,
    /// Native packages installed as their WebAssembly build, described,
    /// sorted.
    pub wasm_builds: Vec<String>,
    /// Commands linked into a `node_modules/.bin`.
    pub bins: usize,
    /// Optional packages skipped for their platform, and what only they
    /// needed, by location, sorted.
    pub skipped_optional: Vec<String>,
    /// What a real `npm ci` would have done and this one did not.
    pub warnings: Vec<String>,
    pub elapsed: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum NpmError {
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
    #[error("{package}: {message}")]
    Unsupported { package: String, message: String },
}

pub type Result<T> = std::result::Result<T, NpmError>;

fn lockfile_error(message: impl Into<String>) -> NpmError {
    NpmError::Lockfile {
        path: "package-lock.json".to_string(),
        message: message.into(),
    }
}

/// How `resolved` URLs on one registry are moved to the configured one
/// (`.npmrc`'s `replace-registry-host`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplaceHost {
    /// URLs on this host, and under this path when there is one: npm's
    /// default is `registry.npmjs.org`.
    Host {
        host: String,
        path: Option<String>,
    },
    Always,
    Never,
}

/// The `.npmrc` settings that decide where packages come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub registry: Option<String>,
    /// `@scope` to that scope's registry.
    pub scoped_registries: BTreeMap<String, String>,
    pub replace_registry_host: ReplaceHost,
    /// `legacy-peer-deps`: npm neither installs nor follows peer
    /// dependencies, which changes what an optional package takes with it.
    pub legacy_peer_deps: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            registry: None,
            scoped_registries: BTreeMap::new(),
            replace_registry_host: ReplaceHost::Host {
                host: "registry.npmjs.org".to_string(),
                path: None,
            },
            legacy_peer_deps: false,
        }
    }
}

/// `scheme`, `host[:port]` and path of an http(s) URL.
fn split_url(url: &str) -> Option<(&str, &str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    Some((scheme, authority, &rest[end..]))
}

fn host_of(authority: &str) -> &str {
    authority.split(':').next().unwrap_or(authority)
}

fn has_path_prefix(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

impl Settings {
    /// Reads the settings of the project rooted at `root`.
    pub fn read(builder: &SnapshotBuilder, root: &Path) -> Settings {
        Self::read_with(&|path| builder.read(path).ok(), root)
    }

    /// [`Settings::read`] through `read`, which gives a file's bytes by
    /// absolute path, or `None` when it is absent. A value that names an
    /// environment variable (`${NPM_REGISTRY}`) is not expanded: there is
    /// no job environment when the install runs, so the key is ignored.
    pub fn read_with(read: &dyn Fn(&Path) -> Option<Vec<u8>>, root: &Path) -> Settings {
        let npmrc = Npmrc::read(read, root);
        let mut settings = Settings {
            registry: npmrc.registry().map(str::to_string),
            scoped_registries: npmrc.scoped_registries(),
            ..Settings::default()
        };
        for (key, value) in npmrc.values() {
            if key == "legacy-peer-deps" {
                settings.legacy_peer_deps = value == "true";
            } else if key == "replace-registry-host" {
                settings.replace_registry_host = match value {
                    "never" => ReplaceHost::Never,
                    "always" => ReplaceHost::Always,
                    "npmjs" => ReplaceHost::Host {
                        host: "registry.npmjs.org".to_string(),
                        path: None,
                    },
                    other => match split_url(other) {
                        Some((_, authority, path)) => ReplaceHost::Host {
                            host: host_of(authority).to_string(),
                            path: Some(path.trim_end_matches('/').to_string())
                                .filter(|path| !path.is_empty()),
                        },
                        None => ReplaceHost::Host {
                            host: other.to_string(),
                            path: None,
                        },
                    },
                };
            }
        }
        settings
    }

    /// The registry `name` is fetched from.
    fn registry_for<'a>(&'a self, name: &str, options: &'a NpmOptions) -> &'a str {
        name.split_once('/')
            .filter(|(scope, _)| scope.starts_with('@'))
            .and_then(|(scope, _)| self.scoped_registries.get(scope))
            .or(self.registry.as_ref())
            .unwrap_or(&options.registry)
    }

    /// Arborist's `#registryResolved`: a `resolved` URL on the replaced
    /// host is the same path on the configured registry (the default one;
    /// npm does not apply scopes here).
    fn rewrite(&self, resolved: &str, options: &NpmOptions) -> String {
        let registry = self.registry.as_deref().unwrap_or(&options.registry);
        let (Some((_, authority, path)), Some((scheme, registry_authority, registry_path))) =
            (split_url(resolved), split_url(registry))
        else {
            return resolved.to_string();
        };
        let match_path = match &self.replace_registry_host {
            ReplaceHost::Never => return resolved.to_string(),
            ReplaceHost::Always => None,
            ReplaceHost::Host { host, path } => {
                if !host_of(authority).eq_ignore_ascii_case(host) {
                    return resolved.to_string();
                }
                path.as_deref()
            }
        };
        if let Some(prefix) = match_path
            && !has_path_prefix(path, prefix)
        {
            return resolved.to_string();
        }
        let registry_path = registry_path.trim_end_matches('/');
        let path = match match_path {
            Some(prefix) => format!("{registry_path}{}", &path[prefix.len()..]),
            None if !registry_path.is_empty() && !has_path_prefix(path, registry_path) => {
                format!("{registry_path}{path}")
            }
            None => path.to_string(),
        };
        format!("{scheme}://{registry_authority}{path}")
    }
}

/// What an entry of `packages` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// The project itself (`""`).
    Root,
    /// A directory that is not under `node_modules`: a workspace, or
    /// another link's target. Its files are the repository's.
    Dir,
    /// A package installed under some `node_modules`.
    Package,
    /// A symlink under some `node_modules`.
    Link,
}

fn kind_of(location: &str, entry: &Entry) -> Kind {
    if location.is_empty() {
        Kind::Root
    } else if entry.link {
        Kind::Link
    } else if location.starts_with("node_modules/") || location.contains("/node_modules/") {
        Kind::Package
    } else {
        Kind::Dir
    }
}

/// The folder name a package at `location` is installed under: what
/// follows its last `node_modules/`.
fn folder_name(location: &str) -> &str {
    location
        .rsplit_once("node_modules/")
        .map_or(location, |(_, name)| name)
}

/// A location with `.` and `..` worked out lexically, as npm's `relpath`
/// writes them (a link to `../lib` keeps its `..`).
fn normalise_location(location: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in location.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

/// One dependency edge between two entries, by index.
#[derive(Debug, Clone, Copy)]
struct Edge {
    from: usize,
    to: usize,
    optional: bool,
}

/// The lockfile as a tree, with Arborist's notion of where a dependency
/// resolves to.
struct Tree<'a> {
    entries: &'a [(String, Entry)],
    kinds: Vec<Kind>,
    index: HashMap<&'a str, usize>,
    /// Entries left out before anything else: extraneous ones, and `dev`
    /// ones when dev dependencies are not installed.
    excluded: Vec<bool>,
    out: Vec<Vec<Edge>>,
    into: Vec<Vec<Edge>>,
}

impl<'a> Tree<'a> {
    fn new(lock: &'a Lockfile, settings: &Settings, options: &NpmOptions) -> Tree<'a> {
        let entries = lock.packages.as_slice();
        let kinds: Vec<Kind> = entries
            .iter()
            .map(|(location, entry)| kind_of(location, entry))
            .collect();
        let index = entries
            .iter()
            .enumerate()
            .map(|(i, (location, _))| (location.as_str(), i))
            .collect();
        let excluded = entries
            .iter()
            .map(|(_, entry)| entry.extraneous || (!options.include_dev && entry.dev))
            .collect();
        let mut tree = Tree {
            entries,
            kinds,
            index,
            excluded,
            out: vec![Vec::new(); entries.len()],
            into: vec![Vec::new(); entries.len()],
        };
        for from in 0..entries.len() {
            if tree.excluded[from] || tree.kinds[from] == Kind::Link {
                continue;
            }
            for (name, optional) in tree.declared(from, settings, options) {
                if let Some(to) = tree.resolve(from, name) {
                    let edge = Edge { from, to, optional };
                    tree.out[from].push(edge);
                    tree.into[to].push(edge);
                }
            }
        }
        tree
    }

    /// The dependencies entry `i` declares, each with whether it is
    /// optional. A name in more than one group is what the last of peer,
    /// production, optional and dev says, the order Arborist loads them in
    /// (`Node#loadDeps`); dev dependencies count for the root and the
    /// directories links point at (Arborist's tops) only.
    fn declared(
        &self,
        i: usize,
        settings: &Settings,
        options: &NpmOptions,
    ) -> BTreeMap<&'a str, bool> {
        let entry = &self.entries[i].1;
        let mut found = BTreeMap::new();
        if !settings.legacy_peer_deps {
            for name in entry.peer_dependencies.keys() {
                found.insert(name.as_str(), entry.optional_peer(name));
            }
        }
        for name in entry.dependencies.keys() {
            found.insert(name.as_str(), false);
        }
        for name in entry.optional_dependencies.keys() {
            found.insert(name.as_str(), true);
        }
        if options.include_dev && matches!(self.kinds[i], Kind::Root | Kind::Dir) {
            for name in entry.dev_dependencies.keys() {
                found.insert(name.as_str(), false);
            }
        }
        found
    }

    /// The entry whose children a lookup from `location` tries next: the
    /// package it is nested in, or for a directory, the nearest directory
    /// entry above it (Arborist's `fsParent`), or the root.
    fn parent_of(&self, location: &str) -> Option<String> {
        if location.is_empty() {
            return None;
        }
        if let Some((parent, _)) = location.rsplit_once("/node_modules/") {
            return Some(parent.to_string());
        }
        if location.starts_with("node_modules/") {
            return Some(String::new());
        }
        let mut dir = location;
        while let Some((up, _)) = dir.rsplit_once('/') {
            if let Some(&i) = self.index.get(up)
                && self.kinds[i] == Kind::Dir
            {
                return Some(up.to_string());
            }
            dir = up;
        }
        Some(String::new())
    }

    /// Where a dependency on `name` from entry `from` resolves: the nearest
    /// `node_modules/<name>` up the tree, through a link to its target.
    fn resolve(&self, from: usize, name: &str) -> Option<usize> {
        let mut location = self.entries[from].0.clone();
        loop {
            let candidate = if location.is_empty() {
                format!("node_modules/{name}")
            } else {
                format!("{location}/node_modules/{name}")
            };
            if let Some(&found) = self.index.get(candidate.as_str())
                && !self.excluded[found]
            {
                return Some(self.target(found));
            }
            location = self.parent_of(&location)?;
        }
    }

    /// A link's target entry, or the entry itself.
    fn target(&self, i: usize) -> usize {
        if self.kinds[i] != Kind::Link {
            return i;
        }
        let Some(resolved) = self.entries[i].1.resolved.as_deref() else {
            return i;
        };
        let resolved = resolved.strip_prefix("file:").unwrap_or(resolved);
        self.index
            .get(normalise_location(resolved).as_str())
            .copied()
            .unwrap_or(i)
    }

    /// Arborist's `optionalSet`: entry `i`, everything that needs it
    /// without being optional about it (up to the optional edges that
    /// bound the set), and the dependencies only those have.
    fn optional_set(&self, i: usize, inert: &[bool]) -> Vec<usize> {
        let mut set = vec![i];
        let mut in_set = HashSet::from([i]);
        let mut next = 0;
        while next < set.len() {
            for edge in &self.into[set[next]] {
                if !edge.optional && in_set.insert(edge.from) {
                    set.push(edge.from);
                }
            }
            next += 1;
        }
        // `gatherDepSet(set, edge => !set.has(edge.to) && !edge.from.inert)`
        let counts = |edge: &Edge| !in_set.contains(&edge.to) && !inert[edge.from];
        let mut deps = set.clone();
        let mut in_deps = in_set.clone();
        let mut next = 0;
        while next < deps.len() {
            for edge in &self.out[deps[next]] {
                if counts(edge) && in_deps.insert(edge.to) {
                    deps.push(edge.to);
                }
            }
            next += 1;
        }
        let mut changed = true;
        while changed && !in_deps.is_empty() {
            changed = false;
            for &dep in &deps {
                if !in_deps.contains(&dep) {
                    continue;
                }
                if self.into[dep]
                    .iter()
                    .any(|edge| !in_deps.contains(&edge.from) && counts(edge))
                {
                    in_deps.remove(&dep);
                    changed = true;
                }
            }
        }
        deps.retain(|dep| in_deps.contains(dep));
        deps
    }

    /// Which entries the platform rules out: Arborist's
    /// `#checkEngineAndPlatform` for optional entries, in lockfile order.
    fn inert(&self, options: &NpmOptions) -> Vec<bool> {
        let mut inert = vec![false; self.entries.len()];
        for (i, (_, entry)) in self.entries.iter().enumerate() {
            if self.excluded[i] || !entry.optional || inert[i] {
                continue;
            }
            let accepted = match &options.platform {
                Some(platform) => npm_accepts(platform, entry),
                None => {
                    let name = entry
                        .name
                        .as_deref()
                        .unwrap_or_else(|| folder_name(&self.entries[i].0));
                    pnpm::platform_accepts_fields(None, name, &entry.os, &entry.cpu, &entry.libc)
                        || options.native.as_ref().is_some_and(|native| {
                            pnpm::platform_accepts_fields(
                                Some(native),
                                name,
                                &entry.os,
                                &entry.cpu,
                                &entry.libc,
                            )
                        })
                }
            };
            if !accepted {
                for member in self.optional_set(i, &inert) {
                    inert[member] = true;
                }
            }
        }
        inert
    }

    /// Whether an entry nested at `location` sits inside an installed
    /// package's own directory (so its files can come from that package's
    /// tarball).
    fn inside_package(&self, location: &str) -> bool {
        let mut location = location.to_string();
        while let Some(parent) = self.parent_of(&location) {
            if let Some(&i) = self.index.get(parent.as_str())
                && self.kinds[i] == Kind::Package
            {
                return true;
            }
            location = parent;
        }
        false
    }
}

/// npm's `checkPlatform` (`npm-install-checks`) on a real host: the fields
/// as the lockfile records them, with nothing read from the package's
/// name, and a `libc` field failing where the host has no C library to
/// name. The isolate is matched the pnpm installer's way instead, which
/// also reads a native build's platform from its name when its fields are
/// missing (see the module documentation).
fn npm_accepts(platform: &Platform, entry: &Entry) -> bool {
    fn check_list(value: Option<&str>, list: &[String]) -> bool {
        if list.is_empty() || (list.len() == 1 && list[0] == "any") {
            return true;
        }
        let mut negated = 0;
        let mut matched = false;
        for item in list {
            match item.strip_prefix('!') {
                Some(excluded) => {
                    negated += 1;
                    if Some(excluded) == value {
                        return false;
                    }
                }
                None => matched |= Some(item.as_str()) == value,
            }
        }
        matched || negated == list.len()
    }
    let libc_ok = entry.libc.is_empty()
        || (platform.libc.is_some() && check_list(platform.libc.as_deref(), &entry.libc));
    check_list(Some(&platform.os), &entry.os)
        && check_list(Some(&platform.cpu), &entry.cpu)
        && libc_ok
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

impl Source {
    fn key(&self) -> String {
        match self {
            Source::Remote { url, .. } => url.clone(),
            Source::Local { path, .. } => path.display().to_string(),
        }
    }
}

fn is_git(resolved: &str) -> bool {
    resolved.starts_with("git+")
        || resolved.starts_with("git:")
        || resolved.starts_with("git@")
        || resolved.starts_with("github:")
        || resolved.starts_with("gitlab:")
        || resolved.starts_with("bitbucket:")
}

fn source_of(
    builder: &SnapshotBuilder,
    root: &Path,
    location: &str,
    name: &str,
    entry: &Entry,
    settings: &Settings,
    options: &NpmOptions,
) -> Result<Source> {
    let unsupported = |message: String| NpmError::Unsupported {
        package: location.to_string(),
        message,
    };
    let sri = || entry.integrity.clone().map(Integrity::Sri);
    let unverifiable = |url: &str| {
        unsupported(format!(
            "{url} has no integrity in the lockfile, so it cannot be verified; run npm install and commit the lockfile"
        ))
    };
    match entry.resolved.as_deref() {
        // Written without `resolved` (`omit-lockfile-registry-resolved`):
        // the registry's tarball for that name and version.
        None => {
            let version = entry.version.as_deref().ok_or_else(|| {
                unsupported(
                    "the lockfile records neither where it comes from nor its version".to_string(),
                )
            })?;
            let registry = settings.registry_for(name, options).trim_end_matches('/');
            let basename = name.rsplit('/').next().unwrap_or(name);
            let url = format!("{registry}/{name}/-/{basename}-{version}.tgz");
            let integrity = sri().ok_or_else(|| unverifiable(&url))?;
            Ok(Source::Remote { url, integrity })
        }
        Some(resolved) if resolved.starts_with("https://") || resolved.starts_with("http://") => {
            let url = settings.rewrite(resolved, options);
            let integrity = sri().ok_or_else(|| unverifiable(&url))?;
            Ok(Source::Remote { url, integrity })
        }
        Some(resolved) if is_git(resolved) => Err(unsupported(format!(
            "git dependencies ({resolved}) are not supported: the lockfile pins a commit but no hash of what npm builds from it; publish it, or depend on a tarball"
        ))),
        Some(resolved) if resolved.starts_with("file:") => {
            let relative = resolved.trim_start_matches("file:");
            let path = iwci_vfs::join_under(root, relative)
                .map_err(|_| unsupported(format!("{resolved} is outside the project")))?;
            if !builder.is_file(&path) {
                return Err(unsupported(format!(
                    "{resolved} is a directory installed as a copy (install-links), which is not supported; drop install-links so npm links it, or make it a workspace"
                )));
            }
            Ok(Source::Local {
                path,
                integrity: sri(),
            })
        }
        Some(other) => Err(unsupported(format!(
            "resolved {other} is not something this installer fetches"
        ))),
    }
}

/// The names `package.json`'s dependency groups declare.
fn declared_names(manifest: &serde_json::Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for group in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if let Some(map) = manifest.get(group).and_then(|v| v.as_object()) {
            names.extend(map.keys().cloned());
        }
    }
    names
}

/// The names a lockfile entry records for a project.
fn recorded_names(entry: &Entry) -> BTreeSet<String> {
    entry
        .dependencies
        .keys()
        .chain(entry.dev_dependencies.keys())
        .chain(entry.optional_dependencies.keys())
        .chain(entry.peer_dependencies.keys())
        .cloned()
        .collect()
}

/// `npm ci` refuses a lockfile that is behind `package.json`. Comparing
/// what each project declares with what the lockfile recorded for it
/// catches the usual case (a dependency added or removed without
/// committing the lockfile) without resolving anything.
fn check_in_sync(
    builder: &SnapshotBuilder,
    root: &Path,
    lock_name: &str,
    tree: &Tree<'_>,
) -> Result<()> {
    for (i, (location, entry)) in tree.entries.iter().enumerate() {
        if !matches!(tree.kinds[i], Kind::Root | Kind::Dir) {
            continue;
        }
        let Ok(dir) = iwci_vfs::join_under(root, location) else {
            continue;
        };
        let Ok(bytes) = builder.read(dir.join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let declared = declared_names(&manifest);
        let recorded = recorded_names(entry);
        if declared == recorded {
            continue;
        }
        let project = if location.is_empty() {
            "package.json".to_string()
        } else {
            format!("{location}/package.json")
        };
        let mut differences: Vec<String> = declared
            .difference(&recorded)
            .map(|name| format!("{name} is missing from it"))
            .chain(
                recorded
                    .difference(&declared)
                    .map(|name| format!("{name} is no longer in {project}")),
            )
            .collect();
        differences.truncate(5);
        return Err(NpmError::Lockfile {
            path: lock_name.to_string(),
            message: format!(
                "out of sync with {project} ({}); run npm install and commit {}",
                differences.join(", "),
                lock_name.rsplit('/').next().unwrap_or(lock_name)
            ),
        });
    }
    Ok(())
}

/// The lifecycle scripts `npm ci` runs for the project and its
/// workspaces themselves, in its order.
const PROJECT_SCRIPTS: [&str; 7] = [
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
];

/// The project's and its workspaces' own lifecycle scripts, as
/// `<package.json> <script> (<command>)`.
fn project_scripts(builder: &SnapshotBuilder, root: &Path, tree: &Tree<'_>) -> Vec<String> {
    let mut found = Vec::new();
    for (i, (location, _)) in tree.entries.iter().enumerate() {
        if !matches!(tree.kinds[i], Kind::Root | Kind::Dir) || tree.excluded[i] {
            continue;
        }
        let Ok(dir) = iwci_vfs::join_under(root, location) else {
            continue;
        };
        let Ok(bytes) = builder.read(dir.join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let Some(scripts) = manifest.get("scripts").and_then(|v| v.as_object()) else {
            continue;
        };
        for name in PROJECT_SCRIPTS {
            if let Some(command) = scripts.get(name).and_then(|v| v.as_str()) {
                let project = if location.is_empty() {
                    "package.json".to_string()
                } else {
                    format!("{location}/package.json")
                };
                found.push(format!("{project} {name} ({command})"));
            }
        }
    }
    found
}

/// What to write.
struct Plan<'a> {
    /// A package directory to fill: where, its location, its real name and
    /// its entry.
    trees: Vec<(PathBuf, &'a str, &'a str, &'a Entry)>,
    /// A link and the absolute path it points at.
    links: Vec<(PathBuf, PathBuf)>,
    bundled: usize,
    /// Where the bundled packages are, inside their bundlers' trees.
    bundled_dirs: Vec<PathBuf>,
    skipped: Vec<String>,
    install_scripts: Vec<String>,
}

fn plan<'a>(tree: &Tree<'a>, root: &Path, options: &NpmOptions) -> Result<Plan<'a>> {
    let inert = tree.inert(options);
    let mut plan = Plan {
        trees: Vec::new(),
        links: Vec::new(),
        bundled: 0,
        bundled_dirs: Vec::new(),
        skipped: Vec::new(),
        install_scripts: Vec::new(),
    };
    // Locations left out, whose nested entries go with them.
    let mut gone: HashSet<&str> = HashSet::new();
    for (i, (location, entry)) in tree.entries.iter().enumerate() {
        let kind = tree.kinds[i];
        if kind == Kind::Root {
            continue;
        }
        let parent_gone = {
            let mut up = tree.parent_of(location);
            let mut found = false;
            while let Some(parent) = up {
                if gone.contains(parent.as_str()) {
                    found = true;
                    break;
                }
                up = tree.parent_of(&parent);
            }
            found
        };
        if tree.excluded[i] || inert[i] || parent_gone {
            gone.insert(location);
            if inert[i] && !tree.excluded[i] && kind == Kind::Package {
                plan.skipped.push(location.clone());
            }
            continue;
        }
        match kind {
            Kind::Root | Kind::Dir => {}
            Kind::Link => {
                let resolved = entry.resolved.as_deref().ok_or_else(|| {
                    lockfile_error(format!("{location} is a link with no resolved target"))
                })?;
                let resolved = resolved.strip_prefix("file:").unwrap_or(resolved);
                let at = iwci_vfs::join_under(root, location)
                    .map_err(|_| lockfile_error(format!("{location} is outside the project")))?;
                let target = pnpm::lexical_join(root, resolved).ok_or_else(|| {
                    lockfile_error(format!("{location}: the link leaves the file system"))
                })?;
                plan.links.push((at, target));
            }
            Kind::Package => {
                if entry.in_bundle && tree.inside_package(location) {
                    plan.bundled += 1;
                    if let Ok(at) = iwci_vfs::join_under(root, location) {
                        plan.bundled_dirs.push(at);
                    }
                    continue;
                }
                let at = iwci_vfs::join_under(root, location)
                    .map_err(|_| lockfile_error(format!("{location} is outside the project")))?;
                let name = entry
                    .name
                    .as_deref()
                    .unwrap_or_else(|| folder_name(location));
                if entry.has_install_script {
                    plan.install_scripts.push(match &entry.version {
                        Some(version) => format!("{name}@{version}"),
                        None => name.to_string(),
                    });
                }
                plan.trees.push((at, location, name, entry));
            }
        }
    }
    plan.skipped.sort();
    plan.install_scripts.sort();
    plan.install_scripts.dedup();
    Ok(plan)
}

/// One tarball and every directory it is unpacked into.
struct Job<'a> {
    /// The first location, for messages.
    location: &'a str,
    source: Source,
    targets: Vec<&'a Path>,
    /// The WebAssembly build to install instead, and its registry.
    wasm: Option<(Substitution, &'a str)>,
}

#[derive(Default)]
struct JobStats {
    tarball_bytes: u64,
    packages: usize,
    files: usize,
    bytes: u64,
    /// The substitution made, described.
    wasm_build: Option<String>,
}

fn run_job(
    builder: &SnapshotBuilder,
    fs: &mem_fs::FileSystem,
    fetcher: &dyn Fetcher,
    job: &Job<'_>,
    options: &NpmOptions,
) -> Result<JobStats> {
    let fetch_error = |source: FetchError| NpmError::Fetch {
        package: job.location.to_string(),
        source,
    };
    let mut wasm_build = None;
    let bytes: Arc<[u8]> = match &job.source {
        Source::Remote { url, integrity } => {
            let wasm = match &job.wasm {
                Some((substitution, registry)) => substitution
                    .fetch(fetcher, registry)
                    .map_err(fetch_error)?
                    .inspect(|_| wasm_build = Some(substitution.describe())),
                None => None,
            };
            match wasm {
                Some(bytes) => bytes,
                None => fetcher.fetch(url, integrity).map_err(fetch_error)?,
            }
        }
        Source::Local { path, integrity } => {
            let bytes = builder.read(path)?;
            if let Some(integrity) = integrity {
                fetch::verify(&path.display().to_string(), &bytes, integrity)
                    .map_err(fetch_error)?;
            }
            bytes.into()
        }
    };
    let (files, executables) =
        pnpm::tarball::extract_with_executables(&bytes, options.max_unpacked_bytes).map_err(
            |message| NpmError::Tarball {
                package: job.location.to_string(),
                message,
            },
        )?;
    let mut stats = JobStats {
        tarball_bytes: bytes.len() as u64,
        wasm_build,
        ..JobStats::default()
    };
    drop(bytes);
    let tree: BTreeMap<String, OwnedBuffer> = files
        .into_iter()
        .map(|(path, bytes)| (path, OwnedBuffer::from(bytes)))
        .collect();
    for target in &job.targets {
        let (files, bytes) = pnpm::write_tree(fs, target, &tree)?;
        pnpm::mark_executables(builder, target, &executables, &tree)?;
        stats.packages += 1;
        stats.files += files;
        stats.bytes += bytes;
    }
    Ok(stats)
}

/// Whether `source` is the registry's tarball of `name@version`, which is
/// the only kind of package a WebAssembly build stands in for.
fn is_registry_tarball(source: &Source, name: &str, version: &str) -> bool {
    let Source::Remote { url, .. } = source else {
        return false;
    };
    let basename = name.rsplit('/').next().unwrap_or(name);
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.ends_with(&format!("/{name}/-/{basename}-{version}.tgz"))
        || path.ends_with(&format!(
            "/{}/-/{basename}-{version}.tgz",
            name.replace('/', "%2f")
        ))
}

/// ICU's root collation order for the characters a package's folder
/// name can have, as npm sorts paths (`localeCompare` in `en`):
/// punctuation first, in ICU's own order, then digits, then letters
/// whatever their case. A lower case letter goes before its upper case
/// one when nothing else tells two names apart.
fn collation_key(path: &str) -> (Vec<(u8, u8)>, Vec<bool>) {
    const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    let primary = path
        .chars()
        .map(|c| match PUNCTUATION.find(c) {
            Some(rank) => (0, rank as u8),
            None if c.is_ascii_digit() => (1, c as u8),
            None if c.is_ascii_alphabetic() => (2, c.to_ascii_lowercase() as u8),
            None => (3, u8::try_from(u32::from(c) & 0xff).unwrap_or(0)),
        })
        .collect();
    let case = path.chars().map(|c| c.is_ascii_uppercase()).collect();
    (primary, case)
}

/// The commands to link into each `node_modules/.bin`, as `npm ci` links
/// them (Arborist's `rebuild.js` and `bin-links`): every package with a
/// `bin` gets its commands in the `.bin` of the `node_modules` it is in,
/// nested and bundled packages included, and a link (a workspace, a
/// `file:` directory) gets its target's commands in the `.bin` beside it,
/// pointing through the link. The project's own `bin` is not linked, nor
/// a workspace's in its own directory. When two packages in one
/// `node_modules` name the same command, the first to link it keeps it:
/// packages before links, each in npm's path order. A command whose file
/// the package does not have is left out, as npm leaves it.
fn bin_links(builder: &SnapshotBuilder, root: &Path, plan: &Plan<'_>) -> Vec<(PathBuf, PathBuf)> {
    // `.bin` directory to its packages: where each is linked from, where
    // its files are read, and whether it is a link (which links last).
    type Candidate = (bool, PathBuf, PathBuf);
    let mut by_dir: BTreeMap<PathBuf, Vec<Candidate>> = BTreeMap::new();
    let node_modules = |at: &Path| -> Option<PathBuf> {
        let parent = at.parent()?;
        let modules = if parent.file_name().is_some_and(|n| n == "node_modules") {
            parent
        } else {
            parent.parent()?
        };
        (modules.file_name().is_some_and(|n| n == "node_modules")).then(|| modules.to_path_buf())
    };
    let packages = plan
        .trees
        .iter()
        .map(|(at, ..)| (false, at.clone(), at.clone()))
        .chain(
            plan.bundled_dirs
                .iter()
                .map(|at| (false, at.clone(), at.clone())),
        )
        .chain(
            plan.links
                .iter()
                .map(|(link, target)| (true, link.clone(), target.clone())),
        );
    for (is_link, at, files) in packages {
        if let Some(modules) = node_modules(&at) {
            by_dir
                .entry(modules.join(".bin"))
                .or_default()
                .push((is_link, at, files));
        }
    }
    let mut out = Vec::new();
    for (bins, mut candidates) in by_dir {
        candidates.sort_by(|a, b| {
            a.0.cmp(&b.0).then_with(|| {
                let path =
                    |c: &Candidate| c.1.strip_prefix(root).unwrap_or(&c.1).display().to_string();
                collation_key(&path(a)).cmp(&collation_key(&path(b)))
            })
        });
        let mut taken: HashSet<PathBuf> = HashSet::new();
        for (_, at, files) in candidates {
            let source = node_bins::BinSource {
                dir: files.clone(),
                direct: true,
            };
            for (link, target) in node_bins::plan(builder, &bins, &[source]) {
                let Some(file) = pnpm::lexical_join(&bins, &target.to_string_lossy()) else {
                    continue;
                };
                if !builder.is_file(&file) || !taken.insert(link.clone()) {
                    continue;
                }
                // Through the link, as npm resolves it from where the
                // package is installed.
                let through = match file.strip_prefix(&files) {
                    Ok(rest) => pnpm::relative(&bins, &at.join(rest)),
                    Err(_) => target,
                };
                out.push((link, through));
            }
        }
    }
    out
}

/// The most packages a warning names before it counts the rest.
const NAMED_IN_WARNING: usize = 12;

/// Installs the dependencies of the npm project whose lockfile is in
/// `root` into `builder`, fetching every tarball through `fetcher`.
pub fn install(
    builder: &SnapshotBuilder,
    root: &str,
    fetcher: &dyn Fetcher,
    options: &NpmOptions,
) -> Result<InstallReport> {
    let started = Instant::now();
    let root = iwci_vfs::normalise(root)?;
    let Some((lock_file, text)) = LOCKFILES
        .iter()
        .find_map(|name| Some((*name, builder.read(root.join(name)).ok()?)))
    else {
        return Err(NpmError::Lockfile {
            path: root.join("package-lock.json").display().to_string(),
            message: "not found; run npm install and commit package-lock.json".to_string(),
        });
    };
    let lock_name = root.join(lock_file).display().to_string();
    let with_path = |error: NpmError| match error {
        NpmError::Lockfile { message, .. } => NpmError::Lockfile {
            path: lock_name.clone(),
            message,
        },
        other => other,
    };
    let text = String::from_utf8(text).map_err(|_| with_path(lockfile_error("not UTF-8")))?;
    let lock = parse_lockfile(&text).map_err(|message| with_path(lockfile_error(message)))?;
    let settings = Settings::read(builder, &root);
    let tree = Tree::new(&lock, &settings, options);
    check_in_sync(builder, &root, &lock_name, &tree)?;
    let plan = plan(&tree, &root, options).map_err(with_path)?;

    // One job per tarball: every place it goes shares the unpacking.
    let mut grouped: BTreeMap<String, Job<'_>> = BTreeMap::new();
    for (at, location, name, entry) in &plan.trees {
        let source = source_of(builder, &root, location, name, entry, &settings, options)?;
        let key = format!("{}\0{:?}", source.key(), entry.integrity);
        // Only for the isolate, and only for what a registry serves: a
        // tarball by any other URL may be anything.
        let wasm = match (&options.platform, &entry.version) {
            (None, Some(version)) if is_registry_tarball(&source, name, version) => {
                wasm_builds::substitution(options.wasm_builds, name, version).map(|found| {
                    let registry = settings.registry_for(found.build.wasm, options);
                    (found, registry)
                })
            }
            _ => None,
        };
        grouped
            .entry(key)
            .or_insert(Job {
                location,
                source,
                targets: Vec::new(),
                wasm,
            })
            .targets
            .push(at);
    }
    let jobs: Vec<Job<'_>> = grouped.into_values().collect();

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
        lockfile: lock_file.to_string(),
        lockfile_version: lock.version,
        bundled: plan.bundled,
        skipped_optional: plan.skipped.clone(),
        ..InstallReport::default()
    };
    for result in results {
        if let Some(stats) = result? {
            report.tarballs += 1;
            report.tarball_bytes += stats.tarball_bytes;
            report.packages += stats.packages;
            report.files += stats.files;
            report.bytes += stats.bytes;
            report.wasm_builds.extend(stats.wasm_build);
        }
    }
    report.wasm_builds.sort();

    let mut made = HashSet::new();
    for (link, target) in &plan.links {
        if !made.insert(link.clone()) {
            continue;
        }
        let parent = link.parent().unwrap_or(Path::new("/"));
        iwci_vfs::symlink(fs, link, pnpm::relative(parent, target))?;
    }
    report.links = made.len();
    for (link, target) in bin_links(builder, &root, &plan) {
        if made.insert(link.clone()) {
            iwci_vfs::symlink(fs, &link, target)?;
            report.bins += 1;
        }
    }

    if !plan.install_scripts.is_empty() {
        let count = plan.install_scripts.len();
        let mut named = plan.install_scripts[..count.min(NAMED_IN_WARNING)].join(", ");
        if count > NAMED_IN_WARNING {
            named.push_str(&format!(" and {} more", count - NAMED_IN_WARNING));
        }
        report.warnings.push(format!(
            "npm ci would have run the install scripts of {count} package{} ({named}); nothing here runs them",
            if count == 1 { "" } else { "s" }
        ));
    }
    let scripts = project_scripts(builder, &root, &tree);
    if !scripts.is_empty() {
        report.warnings.push(format!(
            "npm ci would have run {}; nothing here runs them",
            scripts.join(", ")
        ));
    }
    report.elapsed = started.elapsed();
    Ok(report)
}
