//! pip: installs the wheels a hashed requirements file or a `pylock.toml`
//! locks, for the interpreter of `env:python`, without running pip.
//!
//! ```text
//! <user base>/lib/python3.13/site-packages/   every wheel's files, plus its .dist-info
//!                                               with INSTALLER and a rewritten RECORD
//! <user base>/bin/                              console scripts and a wheel's scripts
//! ```
//!
//! The user base is `PYTHONUSERBASE` (`/root/.local` by default), so the
//! interpreter reads it as its user site: `.pth` files work and pip in the
//! job sees the packages as installed. Its `bin` goes first on the job's
//! `PATH` ([`path`]).
//!
//! **What the lock must say.** Every entry pins one version and lists the
//! SHA-256 of the files it allows (`pip-compile --generate-hashes`, `uv pip
//! compile --generate-hashes`, `poetry export`, `pip lock`, `uv export
//! --format pylock.toml`). The installer installs exactly those entries
//! whose markers hold for `env:python`; it resolves nothing, and warns when
//! an installed distribution needs one the lock leaves out.
//!
//! **Which file.** From a requirements file, each entry's files are looked
//! up on the indexes (the file's own `--index-url` and
//! `--extra-index-url`, then PyPI and Wasmer's WASIX index) and only files
//! whose hash the lock lists are candidates. A `pylock.toml` names its
//! files itself. Of the candidates, the wheel whose tags fit CPython 3.13
//! on `wasix_wasm32` best is installed: a WASIX build when the lock has
//! one, else a pure-Python wheel. A wheel for another platform or a source
//! distribution is refused, since a job cannot build one. Every download is
//! checked against its hash before anything is unpacked.
//!
//! A WASIX wheel gets into a lock by `pip lock` in `env:python`, which
//! records the files that interpreter takes, or by its hash added to a
//! requirements entry: Wasmer's wheels carry a local version (`numpy
//! 2.5.1+wasix.3`), which `==2.5.1` matches. `pip-compile` on another
//! machine hashes only the files of the version it resolved there.

mod markers;
mod pep440;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use base64::Engine;
use iwci_vfs::{SnapshotBuilder, VfsError, join_under, normalise};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::archive::{ArchiveFile, read_zip};
use crate::fetch::{FetchError, Fetcher, Integrity};
use crate::go::parallel;

pub use markers::Environment;

/// PyPI's simple index.
pub const PYPI: &str = "https://pypi.org/simple";
/// Wasmer's index of wheels built for WASIX.
pub const WASIX_INDEX: &str = "https://python-registry.wasix.org/simple";
/// Where packages go: the interpreter's user base.
pub const DEFAULT_USER_BASE: &str = "/root/.local";
/// Looked for in this order when no `file:` is given.
pub const DEFAULT_FILES: &[&str] = &["pylock.toml", "requirements.txt"];

/// The interpreter packages are installed for: what its markers read and
/// which wheel tags it takes. The default is `env:python@3.13`'s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub python: (u32, u32),
    pub full_version: String,
    /// Wheel platform tags, best first.
    pub platforms: Vec<String>,
    pub os_name: String,
    pub sys_platform: String,
    pub platform_machine: String,
    pub platform_system: String,
    pub platform_release: String,
    pub platform_version: String,
}

impl Default for Target {
    fn default() -> Self {
        // What CPython 3.13.15 in `python/python` 3.13.20 reports under
        // WASIX, with `_PYTHON_HOST_PLATFORM=wasix-wasm32` as the
        // environment sets it (README, "Python").
        Target {
            python: (3, 13),
            full_version: "3.13.15".to_string(),
            platforms: vec!["wasix_wasm32".to_string()],
            os_name: "posix".to_string(),
            sys_platform: "wasi".to_string(),
            platform_machine: "wasm32".to_string(),
            platform_system: "WASI".to_string(),
            platform_release: String::new(),
            platform_version: String::new(),
        }
    }
}

impl Target {
    pub fn environment(&self) -> Environment {
        let (major, minor) = self.python;
        let mut values = BTreeMap::new();
        values.insert("python_version", format!("{major}.{minor}"));
        values.insert("python_full_version", self.full_version.clone());
        values.insert("implementation_version", self.full_version.clone());
        values.insert("implementation_name", "cpython".to_string());
        values.insert("platform_python_implementation", "CPython".to_string());
        values.insert("os_name", self.os_name.clone());
        values.insert("sys_platform", self.sys_platform.clone());
        values.insert("platform_machine", self.platform_machine.clone());
        values.insert("platform_system", self.platform_system.clone());
        values.insert("platform_release", self.platform_release.clone());
        values.insert("platform_version", self.platform_version.clone());
        Environment {
            values,
            ..Environment::default()
        }
    }

    /// Every `(python, abi, platform)` tag the interpreter takes, best
    /// first, as `packaging.tags.sys_tags` orders them for CPython.
    pub fn tags(&self) -> Vec<(String, String, String)> {
        let (major, minor) = self.python;
        let cp = format!("cp{major}{minor}");
        let mut tags = Vec::new();
        for platform in &self.platforms {
            for abi in [cp.as_str(), "abi3", "none"] {
                tags.push((cp.clone(), abi.to_string(), platform.clone()));
            }
            for older in (2..minor).rev() {
                tags.push((format!("cp{major}{older}"), "abi3".into(), platform.clone()));
            }
        }
        let py_versions: Vec<String> = std::iter::once(format!("py{major}{minor}"))
            .chain(std::iter::once(format!("py{major}")))
            .chain((0..minor).rev().map(|m| format!("py{major}{m}")))
            .collect();
        for platform in &self.platforms {
            for py in &py_versions {
                tags.push((py.clone(), "none".into(), platform.clone()));
            }
        }
        tags.push((cp.clone(), "none".into(), "any".into()));
        for py in &py_versions {
            tags.push((py.clone(), "none".into(), "any".into()));
        }
        tags
    }

    fn site_packages(&self, user_base: &Path) -> PathBuf {
        let (major, minor) = self.python;
        user_base.join(format!("lib/python{major}.{minor}/site-packages"))
    }
}

#[derive(Debug, Clone)]
pub struct PipOptions {
    /// The lock, relative to the install directory. `None` looks for
    /// [`DEFAULT_FILES`].
    pub file: Option<String>,
    /// Indexes a requirements file's entries are looked up on, after the
    /// file's own. Each is a PEP 503 simple index, without a trailing `/`.
    pub indexes: Vec<String>,
    pub user_base: String,
    pub target: Target,
    /// Downloads in flight at once.
    pub parallelism: usize,
    /// One wheel download. PyPI's default limit is 100 MiB, and a project
    /// can be granted more.
    pub max_wheel_bytes: u64,
    /// One wheel, unpacked.
    pub max_unpacked_bytes: u64,
    pub max_files_per_wheel: usize,
    /// Everything written into the snapshot, which lives in memory.
    pub max_total_bytes: u64,
}

impl Default for PipOptions {
    fn default() -> Self {
        Self {
            file: None,
            indexes: vec![PYPI.to_string(), WASIX_INDEX.to_string()],
            user_base: DEFAULT_USER_BASE.to_string(),
            target: Target::default(),
            parallelism: 8,
            max_wheel_bytes: 512 << 20,
            max_unpacked_bytes: 1 << 30,
            max_files_per_wheel: 100_000,
            max_total_bytes: 4 << 30,
        }
    }
}

/// The environment a job needs: the user base the packages are in.
pub fn env(options: &PipOptions) -> Vec<(String, String)> {
    vec![("PYTHONUSERBASE".to_string(), options.user_base.clone())]
}

/// Directories to put first on a job's `PATH`: where console scripts are.
pub fn path(options: &PipOptions) -> Vec<String> {
    vec![format!("{}/bin", options.user_base.trim_end_matches('/'))]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledDist {
    pub name: String,
    pub version: String,
    /// The wheel's file name.
    pub wheel: String,
}

#[derive(Debug, Clone, Default)]
pub struct PipReport {
    /// The lock read, as an absolute path.
    pub lockfile: String,
    pub installed: Vec<InstalledDist>,
    /// Entries whose marker does not hold for the target.
    pub skipped: Vec<String>,
    /// Problems that did not stop the install: a dependency the lock does
    /// not install, an entry it cannot (a local directory).
    pub warnings: Vec<String>,
    pub bytes_written: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum PipError {
    #[error(transparent)]
    Vfs(#[from] VfsError),
    #[error(transparent)]
    Fetch(#[from] FetchError),
    #[error("{0}: no pylock.toml or requirements.txt (name another with `file:`)")]
    NoLockfile(String),
    #[error("{file}: {message}")]
    Lockfile { file: String, message: String },
    #[error("{name}: {message}")]
    Package { name: String, message: String },
    #[error("{what} is over the {limit} byte limit")]
    TooLarge { what: String, limit: u64 },
}

pub type Result<T> = std::result::Result<T, PipError>;

/// PEP 503's normalised project name.
pub fn normalise_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut separator = false;
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            separator = true;
        } else {
            if separator && !out.is_empty() {
                out.push('-');
            }
            separator = false;
            out.push(c.to_ascii_lowercase());
        }
    }
    out
}

/// One file the lock allows for an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LockedFile {
    filename: String,
    /// Where to fetch it, or `None` for a file in the repository.
    url: Option<String>,
    /// For a file in the repository: its absolute path in the snapshot.
    path: Option<PathBuf>,
    integrity: Integrity,
}

/// One package the lock installs.
#[derive(Debug, Clone)]
struct Locked {
    name: String,
    version: Option<String>,
    extras: Vec<String>,
    /// `requirements.txt:12` or `pylock.toml: numpy`, for messages.
    origin: String,
    /// Hex SHA-256 digests the files may have (a requirements file).
    hashes: Vec<String>,
    /// The files themselves, when the lock names them (pylock.toml, a
    /// direct URL); otherwise they are looked up on the indexes.
    files: Option<Vec<LockedFile>>,
}

/// Installs every wheel the lock in `dir` pins for the target.
pub fn install(
    builder: &SnapshotBuilder,
    dir: &str,
    fetcher: &dyn Fetcher,
    options: &PipOptions,
) -> Result<PipReport> {
    let dir = normalise(dir)?;
    let lock_path = match &options.file {
        Some(file) => {
            let path = join_under(&dir, file)?;
            if !builder.is_file(&path) {
                return Err(PipError::Lockfile {
                    file: path.display().to_string(),
                    message: "not found".to_string(),
                });
            }
            path
        }
        None => DEFAULT_FILES
            .iter()
            .map(|name| dir.join(name))
            .find(|path| builder.is_file(path))
            .ok_or_else(|| PipError::NoLockfile(dir.display().to_string()))?,
    };
    let file = lock_path.display().to_string();
    let lock_error = |message: String| PipError::Lockfile {
        file: file.clone(),
        message,
    };
    let text = String::from_utf8(builder.read(&lock_path)?)
        .map_err(|_| lock_error("not UTF-8".to_string()))?;
    let lock_dir = lock_path.parent().unwrap_or(Path::new("/")).to_path_buf();
    let short = lock_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("lock")
        .to_string();
    let is_pylock = short.starts_with("pylock.") && short.ends_with(".toml");
    let mut env = options.target.environment();
    let (entries, mut indexes) = if is_pylock {
        let (entries, groups) = parse_pylock(&text, &short, &lock_dir).map_err(lock_error)?;
        env.dependency_groups = groups;
        (entries, Vec::new())
    } else {
        let parsed = parse_requirements(&text, &short).map_err(lock_error)?;
        (parsed.entries, parsed.indexes)
    };
    for index in &options.indexes {
        if !indexes.contains(index) {
            indexes.push(index.clone());
        }
    }

    let mut report = PipReport {
        lockfile: file.clone(),
        ..PipReport::default()
    };
    let mut wanted: Vec<(Locked, Option<String>)> = Vec::new();
    let mut seen = BTreeMap::new();
    for (entry, marker) in entries {
        if let Some(marker) = &marker
            && !markers::evaluate(marker, &env, None).map_err(lock_error)?
        {
            report.skipped.push(entry.origin.clone());
            continue;
        }
        let key = normalise_name(&entry.name);
        if let Some(other) = seen.insert(key, entry.origin.clone()) {
            return Err(lock_error(format!(
                "{} and {other} both install {}",
                entry.origin, entry.name
            )));
        }
        wanted.push((entry, marker));
    }
    wanted.sort_by_key(|(e, _)| normalise_name(&e.name));

    let user_base = normalise(&options.user_base)?;
    let layout = Layout {
        site: options.target.site_packages(&user_base),
        bin: user_base.join("bin"),
        include: user_base.join(format!(
            "include/python{}.{}",
            options.target.python.0, options.target.python.1
        )),
        data: user_base.clone(),
    };
    let tags = options.target.tags();
    let mut written = 0u64;
    let mut metadata = Vec::new();
    parallel(
        &wanted,
        options.parallelism,
        |(entry, _)| prepare(entry, builder, fetcher, &indexes, &tags, &layout, options),
        |prepared: Prepared| {
            for (path, bytes, executable) in &prepared.files {
                written += bytes.len() as u64;
                if written > options.max_total_bytes {
                    return Err(PipError::TooLarge {
                        what: "the installed wheels".to_string(),
                        limit: options.max_total_bytes,
                    });
                }
                builder.write(path, bytes)?;
                if *executable {
                    builder.set_mode(path, 0o755)?;
                }
            }
            metadata.push((prepared.dist.clone(), prepared.extras, prepared.requires));
            report.installed.push(prepared.dist);
            Ok(())
        },
    )?;
    report.bytes_written = written;
    report.installed.sort_by_key(|d| normalise_name(&d.name));
    report
        .warnings
        .extend(missing_dependencies(&metadata, &env, &short));
    Ok(report)
}

/// Where a wheel's schemes go.
struct Layout {
    site: PathBuf,
    bin: PathBuf,
    include: PathBuf,
    data: PathBuf,
}

struct Prepared {
    dist: InstalledDist,
    extras: Vec<String>,
    requires: Vec<String>,
    files: Vec<(PathBuf, Vec<u8>, bool)>,
}

/// Picks, downloads, verifies and unpacks one entry's wheel, writing
/// nothing.
fn prepare(
    entry: &Locked,
    builder: &SnapshotBuilder,
    fetcher: &dyn Fetcher,
    indexes: &[String],
    tags: &[(String, String, String)],
    layout: &Layout,
    options: &PipOptions,
) -> Result<Prepared> {
    let fail = |message: String| PipError::Package {
        name: format!("{} ({})", entry.name, entry.origin),
        message,
    };
    let candidates = match &entry.files {
        Some(files) => files.clone(),
        None => {
            let mut found = Vec::new();
            for index in indexes {
                found.extend(list_index(fetcher, index, &entry.name, &entry.hashes)?);
            }
            found
        }
    };
    let chosen = choose(entry, &candidates, tags, indexes).map_err(fail)?;
    let bytes: std::sync::Arc<[u8]> = match (&chosen.url, &chosen.path) {
        (Some(url), _) => fetcher.fetch(url, &chosen.integrity)?,
        (None, Some(path)) => {
            let bytes = builder.read(path)?;
            crate::fetch::verify(&path.display().to_string(), &bytes, &chosen.integrity)?;
            bytes.into()
        }
        (None, None) => return Err(fail("a file with neither a url nor a path".into())),
    };
    if bytes.len() as u64 > options.max_wheel_bytes {
        return Err(PipError::TooLarge {
            what: chosen.filename.clone(),
            limit: options.max_wheel_bytes,
        });
    }
    let files = read_zip(
        &bytes,
        options.max_files_per_wheel,
        options.max_unpacked_bytes,
    )
    .map_err(|e| fail(format!("{}: {e}", chosen.filename)))?;
    let wheel = parse_wheel_name(&chosen.filename).expect("chosen files are wheels");
    let unpacked = unpack_wheel(&wheel, files, layout)
        .map_err(|e| fail(format!("{}: {e}", chosen.filename)))?;
    Ok(Prepared {
        dist: InstalledDist {
            name: entry.name.clone(),
            version: wheel.version.clone(),
            wheel: chosen.filename.clone(),
        },
        extras: entry.extras.clone(),
        requires: unpacked.requires,
        files: unpacked.files,
    })
}

/// The best wheel among `candidates` for the target's tags.
fn choose(
    entry: &Locked,
    candidates: &[LockedFile],
    tags: &[(String, String, String)],
    indexes: &[String],
) -> std::result::Result<LockedFile, String> {
    let want = normalise_name(&entry.name);
    let pinned = entry
        .version
        .as_deref()
        .map(|v| pep440::Version::parse(v).ok_or_else(|| format!("{v:?} is not a version")))
        .transpose()?;
    let mut best: Option<(usize, &LockedFile)> = None;
    let mut other_wheels = Vec::new();
    let mut sdists = Vec::new();
    for candidate in candidates {
        let Some(wheel) = parse_wheel_name(&candidate.filename) else {
            if candidate.filename.ends_with(".tar.gz") || candidate.filename.ends_with(".zip") {
                sdists.push(candidate.filename.clone());
            }
            continue;
        };
        if normalise_name(&wheel.name) != want {
            continue;
        }
        if let Some(pinned) = &pinned
            && !pep440::Version::parse(&wheel.version).is_some_and(|v| v.matches_exactly(pinned))
        {
            continue;
        }
        let rank = wheel
            .tags
            .iter()
            .filter_map(|t| tags.iter().position(|w| w == t))
            .min();
        match rank {
            Some(rank) if best.is_none_or(|(b, _)| rank < b) => best = Some((rank, candidate)),
            Some(_) => {}
            None => other_wheels.push(candidate.filename.clone()),
        }
    }
    if let Some((_, file)) = best {
        return Ok(file.clone());
    }
    let wanted_platform = tags.first().map_or("this platform", |(_, _, p)| p.as_str());
    if !other_wheels.is_empty() {
        other_wheels.truncate(3);
        return Err(format!(
            "the lock allows only wheels for other interpreters or platforms ({}, ...), \
             and no {wanted_platform} or pure-Python wheel; lock against {WASIX_INDEX}/ too \
             (README, \"Python\")",
            other_wheels.join(", ")
        ));
    }
    if !sdists.is_empty() {
        return Err(format!(
            "the lock allows only a source distribution ({}), which a job cannot build",
            sdists.join(", ")
        ));
    }
    if entry.files.is_some() {
        return Err("the lock lists no wheel".to_string());
    }
    Err(format!(
        "none of the files on {} has one of the lock's hashes",
        indexes.join(", ")
    ))
}

/// The files of `name` on a PEP 503 `index` whose SHA-256 the lock lists.
/// A project the index does not have is no files.
fn list_index(
    fetcher: &dyn Fetcher,
    index: &str,
    name: &str,
    hashes: &[String],
) -> Result<Vec<LockedFile>> {
    let page_url = format!("{}/{}/", index.trim_end_matches('/'), normalise_name(name));
    let page = match fetcher.fetch(&page_url, &Integrity::Unpinned) {
        Ok(page) => page,
        Err(FetchError::NotFound { .. }) => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let html = String::from_utf8_lossy(&page);
    let mut files = Vec::new();
    for href in anchors(&html) {
        let (url, fragment) = match href.split_once('#') {
            Some((url, fragment)) => (url, Some(fragment)),
            None => (href.as_str(), None),
        };
        let Some(sha256) = fragment
            .and_then(|f| f.strip_prefix("sha256="))
            .map(str::to_ascii_lowercase)
        else {
            continue;
        };
        if !hashes.contains(&sha256) {
            continue;
        }
        let url = resolve_url(&page_url, url);
        let Some(filename) = url_file_name(&url) else {
            continue;
        };
        files.push(LockedFile {
            filename,
            url: Some(url),
            path: None,
            integrity: Integrity::Sha256Hex(sha256),
        });
    }
    Ok(files)
}

/// The `href` of every `<a>` in `html`, entities decoded.
fn anchors(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(start) = lower[at..].find("<a") {
        let tag_start = at + start + 2;
        at = tag_start;
        if !lower[tag_start..].starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let Some(end) = lower[tag_start..].find('>') else {
            break;
        };
        let tag = &html[tag_start..tag_start + end];
        let tag_lower = &lower[tag_start..tag_start + end];
        at = tag_start + end;
        let Some(h) = find_attribute(tag_lower, "href") else {
            continue;
        };
        let rest = tag[h..].trim_start();
        let value = match rest.chars().next() {
            Some(q @ ('"' | '\'')) => rest[1..].split(q).next().unwrap_or(""),
            _ => rest.split(|c: char| c.is_whitespace()).next().unwrap_or(""),
        };
        out.push(decode_entities(value));
    }
    out
}

/// The byte offset just past `name=` in a tag's attributes.
fn find_attribute(tag: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = tag[from..].find(name) {
        let start = from + i;
        let before_ok = start == 0 || tag.as_bytes()[start - 1].is_ascii_whitespace();
        let rest = tag[start + name.len()..].trim_start();
        if before_ok && rest.starts_with('=') {
            let eq = tag.len() - rest.len();
            return Some(eq + 1);
        }
        from = start + name.len();
    }
    None
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(semi) = rest.find(';').filter(|&s| s <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `href` resolved against the page it is on.
fn resolve_url(page: &str, href: &str) -> String {
    if href.starts_with("https://") || href.starts_with("http://") {
        return href.to_string();
    }
    let (scheme, rest) = page.split_once("://").unwrap_or(("https", page));
    if let Some(rest) = href.strip_prefix("//") {
        return format!("{scheme}://{rest}");
    }
    let host = rest.split('/').next().unwrap_or("");
    let mut segments: Vec<&str> = if href.starts_with('/') {
        Vec::new()
    } else {
        let path = &rest[host.len()..];
        let dir = &path[..path.rfind('/').map_or(0, |i| i + 1)];
        dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for part in href.trim_start_matches('/').split('/') {
        match part {
            "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    format!("{scheme}://{host}/{}", segments.join("/"))
}

/// The last path segment of `url`, percent-decoded.
fn url_file_name(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let last = path.rsplit('/').next().filter(|s| !s.is_empty())?;
    let bytes = last.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16)
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let name = String::from_utf8(out).ok()?;
    (!name.contains('/') && !name.contains('\\')).then_some(name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WheelName {
    name: String,
    version: String,
    tags: Vec<(String, String, String)>,
}

/// `{name}-{version}(-{build})?-{python}-{abi}-{platform}.whl`, with each
/// tag possibly a `.`-separated set.
fn parse_wheel_name(filename: &str) -> Option<WheelName> {
    let stem = filename.strip_suffix(".whl")?;
    let parts: Vec<&str> = stem.split('-').collect();
    if !(parts.len() == 5 || parts.len() == 6) {
        return None;
    }
    let n = parts.len();
    let mut tags = Vec::new();
    for py in parts[n - 3].split('.') {
        for abi in parts[n - 2].split('.') {
            for platform in parts[n - 1].split('.') {
                tags.push((py.to_string(), abi.to_string(), platform.to_string()));
            }
        }
    }
    Some(WheelName {
        name: parts[0].to_string(),
        version: parts[1].to_string(),
        tags,
    })
}

struct Unpacked {
    files: Vec<(PathBuf, Vec<u8>, bool)>,
    /// `Requires-Dist` lines of its METADATA.
    requires: Vec<String>,
}

/// A wheel laid out as pip installs it, with `INSTALLER` and a `RECORD`
/// that lists where everything went.
fn unpack_wheel(
    wheel: &WheelName,
    files: Vec<ArchiveFile>,
    layout: &Layout,
) -> std::result::Result<Unpacked, String> {
    let dist_infos: BTreeSet<&str> = files
        .iter()
        .filter_map(|f| f.path.split('/').next())
        .filter(|top| top.ends_with(".dist-info"))
        .collect();
    let dist_info = match dist_infos.len() {
        1 => dist_infos.into_iter().next().expect("one").to_string(),
        0 => return Err("no .dist-info directory".to_string()),
        _ => return Err("more than one .dist-info directory".to_string()),
    };
    let read = |name: &str| {
        files
            .iter()
            .find(|f| f.path == format!("{dist_info}/{name}"))
            .map(|f| String::from_utf8_lossy(&f.data).into_owned())
    };
    let wheel_meta = read("WHEEL").ok_or("no WHEEL file")?;
    let wheel_version = header(&wheel_meta, "Wheel-Version").ok_or("WHEEL has no Wheel-Version")?;
    if wheel_version.split('.').next() != Some("1") {
        return Err(format!("Wheel-Version {wheel_version} is not 1.x"));
    }
    let metadata = read("METADATA").ok_or("no METADATA file")?;
    let requires = headers(&metadata, "Requires-Dist");
    let entry_points = read("entry_points.txt");
    let data_dir = format!("{}.data", dist_info.trim_end_matches(".dist-info"));

    let mut out: Vec<(PathBuf, Vec<u8>, bool)> = Vec::new();
    for file in files {
        if file.path == format!("{dist_info}/RECORD")
            || file.path == format!("{dist_info}/INSTALLER")
            || file.path.ends_with(".pyc") && file.path.contains("/__pycache__/")
        {
            continue;
        }
        let (target, executable, data) = match file.path.strip_prefix(&format!("{data_dir}/")) {
            Some(rest) => {
                let (scheme, rest) = rest
                    .split_once('/')
                    .ok_or_else(|| format!("{}: not in a scheme directory", file.path))?;
                match scheme {
                    "purelib" | "platlib" => (layout.site.join(rest), false, file.data),
                    "scripts" => (layout.bin.join(rest), true, rewrite_shebang(file.data)),
                    "headers" => (
                        layout.include.join(&wheel.name).join(rest),
                        false,
                        file.data,
                    ),
                    "data" => (layout.data.join(rest), false, file.data),
                    other => return Err(format!("{}: unknown scheme {other:?}", file.path)),
                }
            }
            None => (layout.site.join(&file.path), file.executable, file.data),
        };
        out.push((target, data, executable));
    }
    if let Some(entry_points) = entry_points {
        for (name, target) in console_scripts(&entry_points)? {
            out.push((layout.bin.join(&name), script(&target)?, true));
        }
    }
    out.push((
        layout.site.join(&dist_info).join("INSTALLER"),
        b"iwci\n".to_vec(),
        false,
    ));
    let mut record = String::new();
    for (path, data, _) in &out {
        let relative = relative_path(&layout.site, path);
        let digest = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(data));
        record.push_str(&format!(
            "{},sha256={digest},{}\n",
            csv_field(&relative),
            data.len()
        ));
    }
    record.push_str(&format!("{dist_info}/RECORD,,\n"));
    out.push((
        layout.site.join(&dist_info).join("RECORD"),
        record.into_bytes(),
        false,
    ));
    Ok(Unpacked {
        files: out,
        requires,
    })
}

/// `#!python` (what a wheel's scripts start with) becomes the job's
/// `python3`, as pip rewrites it to the interpreter's path.
fn rewrite_shebang(data: Vec<u8>) -> Vec<u8> {
    let Some(rest) = data.strip_prefix(b"#!python") else {
        return data;
    };
    let line_end = rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len());
    if !rest[..line_end]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'\r')
    {
        return data;
    }
    let mut out = b"#!/usr/bin/env python3".to_vec();
    out.extend_from_slice(&rest[line_end..]);
    out
}

/// `[console_scripts]` and `[gui_scripts]` of an `entry_points.txt`.
fn console_scripts(text: &str) -> std::result::Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut in_scripts = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        if line.starts_with('[') {
            in_scripts = matches!(line, "[console_scripts]" | "[gui_scripts]");
            continue;
        }
        if !in_scripts {
            continue;
        }
        let (name, target) = line
            .split_once('=')
            .ok_or_else(|| format!("entry_points.txt: {line:?} has no `=`"))?;
        let name = name.trim();
        if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
            return Err(format!("entry_points.txt: bad script name {name:?}"));
        }
        out.push((name.to_string(), target.trim().to_string()));
    }
    Ok(out)
}

/// The script pip (distlib) writes for `module:attr.path [extras]`.
fn script(target: &str) -> std::result::Result<Vec<u8>, String> {
    let target = target.split('[').next().unwrap_or(target).trim();
    let (module, attr) = target
        .split_once(':')
        .ok_or_else(|| format!("entry point {target:?} names no function"))?;
    let (module, attr) = (module.trim(), attr.trim());
    let ident = |s: &str| {
        !s.is_empty()
            && s.split('.')
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_alphanumeric() || c == '_'))
    };
    if !ident(module) || !ident(attr) {
        return Err(format!("entry point {target:?} is not module:function"));
    }
    let import = attr.split('.').next().expect("non-empty");
    Ok(format!(
        "#!/usr/bin/env python3\n\
         # -*- coding: utf-8 -*-\n\
         import re\n\
         import sys\n\
         from {module} import {import}\n\
         if __name__ == \"__main__\":\n    \
         sys.argv[0] = re.sub(r\"(-script\\.pyw|\\.exe)?$\", \"\", sys.argv[0])\n    \
         sys.exit({attr}())\n"
    )
    .into_bytes())
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// `to` relative to the directory `from`, with `..` as needed.
fn relative_path(from: &Path, to: &Path) -> String {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> =
        std::iter::repeat_n("..".to_string(), from.len() - common).collect();
    parts.extend(
        to[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

/// The first value of an email-style header.
fn header(text: &str, name: &str) -> Option<String> {
    headers(text, name).into_iter().next()
}

/// Every value of an email-style header, up to the blank line that ends
/// the headers.
fn headers(text: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case(name)
        {
            out.push(value.trim().to_string());
        }
    }
    out
}

/// A warning for each dependency an installed distribution needs (its
/// `Requires-Dist`, markers evaluated) that the lock does not install.
fn missing_dependencies(
    installed: &[(InstalledDist, Vec<String>, Vec<String>)],
    env: &Environment,
    lock: &str,
) -> Vec<String> {
    let names: BTreeSet<String> = installed
        .iter()
        .map(|(d, _, _)| normalise_name(&d.name))
        .collect();
    let mut out = BTreeSet::new();
    for (dist, extras, requires) in installed {
        for requirement in requires {
            let (spec, marker) = match requirement.split_once(';') {
                Some((spec, marker)) => (spec, Some(marker.trim())),
                None => (requirement.as_str(), None),
            };
            let name: String = spec
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                .collect();
            if name.is_empty() || names.contains(&normalise_name(&name)) {
                continue;
            }
            let applies = match marker {
                None => true,
                Some(marker) => std::iter::once(None)
                    .chain(extras.iter().map(|e| Some(e.as_str())))
                    .any(|extra| markers::evaluate(marker, env, extra).unwrap_or(false)),
            };
            if applies {
                out.insert(format!(
                    "pip: {} needs {}, which {lock} does not install",
                    dist.name,
                    spec.trim()
                ));
            }
        }
    }
    out.into_iter().collect()
}

struct Requirements {
    entries: Vec<(Locked, Option<String>)>,
    indexes: Vec<String>,
}

/// A requirements file whose every entry is pinned with `==` and hashed.
fn parse_requirements(text: &str, file: &str) -> std::result::Result<Requirements, String> {
    let mut out = Requirements {
        entries: Vec::new(),
        indexes: Vec::new(),
    };
    let mut primary: Option<String> = None;
    let mut extra_indexes = Vec::new();
    for (number, line) in logical_lines(text) {
        let at = |message: String| format!("line {number}: {message}");
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.is_empty() {
            continue;
        }
        if tokens[0].starts_with('-') {
            let (option, inline) = match tokens[0].split_once('=') {
                Some((o, v)) => (o, Some(v)),
                None => (tokens[0], None),
            };
            let value = || {
                inline
                    .or_else(|| tokens.get(1).copied())
                    .map(str::to_string)
                    .ok_or_else(|| at(format!("{option} needs a value")))
            };
            match option {
                "-i" | "--index-url" => primary = Some(value()?),
                "--extra-index-url" => extra_indexes.push(value()?),
                "--require-hashes" | "--pre" | "--prefer-binary" | "--only-binary"
                | "--no-binary" | "--trusted-host" | "--use-feature" => {}
                "--no-index" | "-f" | "--find-links" => {
                    return Err(at(format!(
                        "{option} is not supported: entries are looked up on indexes"
                    )));
                }
                "-r" | "--requirement" | "-c" | "--constraint" | "-e" | "--editable" => {
                    return Err(at(format!(
                        "{option} is not supported: name one compiled lock with `file:`"
                    )));
                }
                other => return Err(at(format!("unknown option {other}"))),
            }
            continue;
        }
        // pip's split: the requirement is every token before the first
        // that starts with `-`.
        let split = tokens
            .iter()
            .position(|t| t.starts_with('-'))
            .unwrap_or(tokens.len());
        let requirement = tokens[..split].join(" ");
        let mut hashes = Vec::new();
        let mut i = split;
        while i < tokens.len() {
            let (option, value) = match tokens[i].split_once('=') {
                Some((o, v)) => (o, Some(v.to_string())),
                None => (tokens[i], tokens.get(i + 1).map(|v| v.to_string())),
            };
            if option != "--hash" {
                return Err(at(format!("{option} is not supported on a requirement")));
            }
            let value = value.ok_or_else(|| at("--hash needs a value".to_string()))?;
            if !tokens[i].contains('=') {
                i += 1;
            }
            i += 1;
            let hex = value
                .strip_prefix("sha256:")
                .ok_or_else(|| at(format!("--hash={value}: only sha256 hashes are supported")))?;
            if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(at(format!("--hash={value}: not a SHA-256")));
            }
            hashes.push(hex.to_ascii_lowercase());
        }
        let (locked, marker) =
            parse_requirement(&requirement, hashes, format!("{file}:{number}")).map_err(at)?;
        out.entries.push((locked, marker));
    }
    out.indexes
        .push(primary.unwrap_or_else(|| PYPI.to_string()));
    out.indexes.extend(extra_indexes);
    for index in &mut out.indexes {
        *index = index.trim_end_matches('/').to_string();
    }
    Ok(out)
}

/// Lines with `\` continuations joined and comments removed, each with the
/// number of the line it started on.
fn logical_lines(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut current: Option<(usize, String)> = None;
    for (index, raw) in text.lines().enumerate() {
        let line = strip_comment(raw);
        let (start, mut acc) = current.take().unwrap_or((index + 1, String::new()));
        let trimmed = line.trim_end();
        match trimmed.strip_suffix('\\') {
            Some(body) => {
                acc.push_str(body);
                acc.push(' ');
                current = Some((start, acc));
            }
            None => {
                acc.push_str(trimmed);
                out.push((start, acc));
            }
        }
    }
    if let Some(last) = current {
        out.push(last);
    }
    out
}

/// pip's rule: `#` starts a comment at the start of a line or after
/// whitespace.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'#' && (i == 0 || bytes[i - 1].is_ascii_whitespace()) {
            return &line[..i];
        }
    }
    line
}

/// `name[extras] ==version ; marker` or `name[extras] @ url ; marker`.
fn parse_requirement(
    text: &str,
    hashes: Vec<String>,
    origin: String,
) -> std::result::Result<(Locked, Option<String>), String> {
    let text = text.trim();
    let name_len = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .unwrap_or(text.len());
    let name = &text[..name_len];
    if name.is_empty() {
        return Err(format!("{text:?} does not start with a project name"));
    }
    let mut rest = text[name_len..].trim_start();
    let mut extras = Vec::new();
    if let Some(after) = rest.strip_prefix('[') {
        let end = after.find(']').ok_or("an extras list is not closed")?;
        extras = after[..end]
            .split(',')
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .collect();
        rest = after[end + 1..].trim_start();
    }
    if hashes.is_empty() {
        return Err(format!(
            "{name} has no --hash; compile the file with --generate-hashes"
        ));
    }
    let (spec, marker) = if let Some(url_part) = rest.strip_prefix('@') {
        let url_part = url_part.trim();
        let (url, marker) = match url_part.split_once(" ;") {
            Some((url, marker)) => (url.trim(), Some(marker.trim().to_string())),
            None => (url_part, None),
        };
        let filename = url_file_name(url).ok_or_else(|| format!("{url}: names no file"))?;
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(format!("{url}: only http(s) URLs are supported"));
        }
        let file = LockedFile {
            filename,
            url: Some(url.to_string()),
            path: None,
            integrity: sha256_integrity(&hashes),
        };
        let locked = Locked {
            name: name.to_string(),
            version: None,
            extras,
            origin,
            hashes,
            files: Some(vec![file]),
        };
        return Ok((locked, marker));
    } else {
        match rest.split_once(';') {
            Some((spec, marker)) => (spec.trim(), Some(marker.trim().to_string())),
            None => (rest.trim(), None),
        }
    };
    let version = spec
        .strip_prefix("===")
        .or_else(|| spec.strip_prefix("=="))
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.contains([',', '*', '<', '>', '=', '!', '~']))
        .ok_or_else(|| {
            format!("{name} is not pinned to one version with `==` (it says {spec:?})")
        })?;
    Ok((
        Locked {
            name: name.to_string(),
            version: Some(version.to_string()),
            extras,
            origin,
            hashes,
            files: None,
        },
        marker,
    ))
}

/// One integrity that accepts any of `hashes` (hex SHA-256).
fn sha256_integrity(hashes: &[String]) -> Integrity {
    if let [only] = hashes {
        return Integrity::Sha256Hex(only.clone());
    }
    let sri = hashes
        .iter()
        .filter_map(|h| hex::decode(h).ok())
        .map(|d| {
            format!(
                "sha256-{}",
                base64::engine::general_purpose::STANDARD.encode(d)
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    Integrity::Sri(sri)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct Pylock {
    lock_version: String,
    #[serde(default)]
    default_groups: Vec<String>,
    #[serde(default)]
    packages: Vec<PylockPackage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct PylockPackage {
    name: String,
    version: Option<String>,
    marker: Option<String>,
    #[serde(default)]
    wheels: Vec<PylockFile>,
    sdist: Option<PylockFile>,
    archive: Option<PylockFile>,
    vcs: Option<toml::Value>,
    directory: Option<toml::Value>,
}

#[derive(Debug, Deserialize)]
struct PylockFile {
    name: Option<String>,
    url: Option<String>,
    path: Option<String>,
    #[serde(default)]
    hashes: BTreeMap<String, String>,
}

/// A PEP 751 lock: its packages with their markers, and the dependency
/// groups it installs by default.
#[allow(clippy::type_complexity)]
fn parse_pylock(
    text: &str,
    file: &str,
    dir: &Path,
) -> std::result::Result<(Vec<(Locked, Option<String>)>, Vec<String>), String> {
    let lock: Pylock = toml::from_str(text).map_err(|e| e.to_string())?;
    if lock.lock_version.split('.').next() != Some("1") {
        return Err(format!("lock-version {} is not 1.x", lock.lock_version));
    }
    let mut out = Vec::new();
    for package in lock.packages {
        let origin = format!("{file}: {}", package.name);
        let kind = if package.vcs.is_some() {
            Some("a version control checkout")
        } else if package.directory.is_some() {
            Some("a local directory")
        } else {
            None
        };
        let mut files = Vec::new();
        let mut hashes = Vec::new();
        let listed = package
            .wheels
            .iter()
            .chain(package.archive.iter())
            .chain(package.sdist.iter());
        for f in listed {
            let sha256 = f
                .hashes
                .get("sha256")
                .map(|h| h.to_ascii_lowercase())
                .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| format!("{origin}: a file without a sha256 hash"))?;
            let source = f.url.as_deref().or(f.path.as_deref()).unwrap_or("");
            let filename = f
                .name
                .clone()
                .or_else(|| url_file_name(source))
                .ok_or_else(|| format!("{origin}: a file with no name"))?;
            let (url, path) = match (&f.url, &f.path) {
                (Some(url), _) => (Some(url.clone()), None),
                (None, Some(path)) => (
                    None,
                    Some(join_under(dir, path).map_err(|_| {
                        format!("{origin}: {path:?} is not a path inside the repository")
                    })?),
                ),
                (None, None) => return Err(format!("{origin}: a file with no url or path")),
            };
            files.push(LockedFile {
                filename,
                url,
                path,
                integrity: Integrity::Sha256Hex(sha256.clone()),
            });
            hashes.push(sha256);
        }
        if let Some(kind) = kind
            && files.is_empty()
        {
            return Err(format!(
                "{origin}: {kind}, which a lock cannot pin by hash; install it in the job"
            ));
        }
        out.push((
            Locked {
                name: package.name,
                version: package.version,
                extras: Vec::new(),
                origin,
                hashes,
                files: Some(files),
            },
            package.marker,
        ));
    }
    Ok((out, lock.default_groups))
}

#[cfg(test)]
mod tests;
