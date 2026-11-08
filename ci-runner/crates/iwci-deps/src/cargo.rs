//! Cargo crates: vendors what `Cargo.lock` pins from crates.io.
//!
//! The result is what `cargo vendor` produces, so cargo in the isolate
//! resolves every crates.io dependency from disk through its ordinary
//! directory-source replacement:
//!
//! ```text
//! <workspace>/vendor/<name>/                  the newest locked version of a crate
//! <workspace>/vendor/<name>-<version>/        every other locked version of it
//! <workspace>/vendor/*/.cargo-checksum.json   {"files": {path: sha256}, "package": checksum}
//! <workspace>/.cargo/config.toml              [source.crates-io] replace-with = "vendored-sources"
//!                                             [source.vendored-sources] directory = "vendor"
//! ```
//!
//! The naming is `cargo vendor`'s: the highest version of each name takes
//! the bare name and the others carry a version suffix. The directory
//! source does not care what the directories are called (it reads each
//! `Cargo.toml`), but matching keeps the tree familiar to anyone who looks.
//! As in current `cargo vendor`, each crate is the pristine content of its
//! `.crate` tarball, minus `.gitattributes`, `.gitignore`, anything under a
//! `.git` directory and cargo's own `.cargo-ok` marker. `package` is the
//! `Cargo.lock` checksum, which cargo checks against the lockfile, and
//! `files` lets it notice a vendored file being edited.
//!
//! Only crates.io is supported. Packages from git or another registry are
//! returned in [`CargoReport::unsupported`] rather than failing the install,
//! so the caller can decide; a build that needs them fails offline with
//! cargo's own message. Path dependencies and workspace members need
//! nothing.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use iwci_vfs::{SnapshotBuilder, VfsError, join_under, normalise};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::fetch::{FetchError, Fetcher, Integrity};
use crate::go::{lexical_join, parallel};

/// How `Cargo.lock` names crates.io, whatever protocol cargo used to reach it.
pub const CRATES_IO: &str = "registry+https://github.com/rust-lang/crates.io-index";
/// The crates.io index's `dl` (see `https://index.crates.io/config.json`).
/// Crates are `<dl>/<name>/<name>-<version>.crate`.
pub const DEFAULT_DOWNLOAD_BASE: &str = "https://static.crates.io/crates";

const REPLACEMENT_NAME: &str = "vendored-sources";
const CHECKSUM_COMMENT: &str = "This file only protects against accidental modifications. \
    It is not a security mechanism and does not protect against malicious changes.";

#[derive(Debug, Clone)]
pub struct CargoOptions {
    /// crates.io's download base, without a trailing slash.
    pub download_base: String,
    /// The vendor directory, relative to the workspace.
    pub vendor_dir: String,
    /// `cargo vendor --versioned-dirs`: always suffix the version.
    pub versioned_dirs: bool,
    /// Downloads in flight at once.
    pub parallelism: usize,
    /// A single `.crate` download. crates.io caps uploads at 10 MiB unless
    /// a crate is granted more; this leaves room for those.
    pub max_crate_bytes: u64,
    /// Unpacked size of one crate. Cargo itself stops at 512 MiB.
    pub max_unpacked_bytes: u64,
    pub max_files_per_crate: usize,
    /// Bytes written into the snapshot across every crate. The snapshot
    /// lives in memory.
    pub max_total_bytes: u64,
}

impl Default for CargoOptions {
    fn default() -> Self {
        Self {
            download_base: DEFAULT_DOWNLOAD_BASE.to_string(),
            vendor_dir: "vendor".to_string(),
            versioned_dirs: false,
            parallelism: 8,
            max_crate_bytes: 256 << 20,
            max_unpacked_bytes: 512 << 20,
            max_files_per_crate: 100_000,
            max_total_bytes: 4 << 30,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendoredCrate {
    pub name: String,
    pub version: String,
    /// Absolute path of its directory in the snapshot.
    pub dir: String,
}

/// A locked package this installer cannot provide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedPackage {
    pub name: String,
    pub version: String,
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigChange {
    /// There was no cargo config; one was written.
    Created,
    /// The source sections were appended to an existing config.
    Appended,
    /// The config already replaced crates.io with this vendor directory.
    AlreadyConfigured,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigOutcome {
    pub path: String,
    pub change: ConfigChange,
}

#[derive(Debug, Clone, Default)]
pub struct CargoReport {
    /// `Cargo.lock`'s `version`, absent before version 3.
    pub lockfile_version: Option<u32>,
    pub vendored: Vec<VendoredCrate>,
    pub unsupported: Vec<UnsupportedPackage>,
    /// `None` when nothing came from crates.io, so nothing was replaced.
    pub config: Option<ConfigOutcome>,
    pub bytes_written: u64,
    /// What a job's environment needs; see [`env`].
    pub env: Vec<(String, String)>,
}

#[derive(Debug, thiserror::Error)]
pub enum CargoError {
    #[error(transparent)]
    Vfs(#[from] VfsError),
    #[error(transparent)]
    Fetch(#[from] FetchError),
    #[error("{0}: no Cargo.lock")]
    NoLockfile(String),
    #[error("{file}: {message}")]
    Lockfile { file: String, message: String },
    #[error("{name} {version}: {message}")]
    BadCrate {
        name: String,
        version: String,
        message: String,
    },
    #[error("{what} is over the {limit} byte limit")]
    TooLarge { what: String, limit: u64 },
    #[error("{path}: {message}")]
    ConflictingConfig { path: String, message: String },
}

pub type Result<T> = std::result::Result<T, CargoError>;

/// The environment a job needs. `CARGO_NET_OFFLINE=true` makes cargo fail
/// at once on anything not vendored (a git dependency, say) instead of
/// trying a network the isolate does not have, and keeps it from refreshing
/// an index it no longer reads.
pub fn env() -> Vec<(String, String)> {
    vec![("CARGO_NET_OFFLINE".to_string(), "true".to_string())]
}

#[derive(Debug, Deserialize)]
struct Lockfile {
    version: Option<u32>,
    #[serde(default)]
    package: Vec<LockedPackage>,
}

#[derive(Debug, Deserialize)]
struct LockedPackage {
    name: String,
    version: String,
    source: Option<String>,
    checksum: Option<String>,
}

struct CrateJob {
    name: String,
    version: String,
    checksum: String,
    dir: PathBuf,
}

struct PreparedCrate {
    vendored: VendoredCrate,
    dirs: Vec<PathBuf>,
    files: Vec<(PathBuf, Vec<u8>)>,
}

/// Vendors every crates.io package in `<workspace_dir>/Cargo.lock` and
/// points the workspace's cargo config at the result.
pub fn install(
    builder: &SnapshotBuilder,
    workspace_dir: &str,
    fetcher: &dyn Fetcher,
    options: &CargoOptions,
) -> Result<CargoReport> {
    let workspace = normalise(workspace_dir)?;
    let vendor_root = join_under(&workspace, &options.vendor_dir)?;
    if vendor_root == workspace {
        return Err(CargoError::Vfs(VfsError::BadPath(
            options.vendor_dir.clone(),
        )));
    }
    let lock_path = workspace.join("Cargo.lock");
    if !builder.is_file(&lock_path) {
        return Err(CargoError::NoLockfile(workspace.display().to_string()));
    }
    let lock_file = lock_path.display().to_string();
    let lock_error = |message: String| CargoError::Lockfile {
        file: lock_file.clone(),
        message,
    };
    let text = String::from_utf8(builder.read(&lock_path)?)
        .map_err(|_| lock_error("not UTF-8".to_string()))?;
    let lock: Lockfile = toml::from_str(&text).map_err(|e| lock_error(e.to_string()))?;
    let packages = parse_lockfile(&lock).map_err(lock_error)?;

    let mut report = CargoReport {
        lockfile_version: lock.version,
        env: env(),
        ..CargoReport::default()
    };

    // `cargo vendor`'s naming needs the highest locked version of each name
    // before any directory is chosen.
    let mut newest: HashMap<&str, &semver::Version> = HashMap::new();
    let mut registry = Vec::new();
    for (package, version) in &packages {
        match package.source.as_deref() {
            None => {}
            Some(CRATES_IO) => {
                newest
                    .entry(package.name.as_str())
                    .and_modify(|v| *v = (*v).max(version))
                    .or_insert(version);
                registry.push((*package, version));
            }
            Some(source) => report.unsupported.push(UnsupportedPackage {
                name: package.name.clone(),
                version: package.version.clone(),
                source: source.to_string(),
            }),
        }
    }

    let mut jobs = Vec::new();
    for (package, version) in registry {
        let checksum = package.checksum.clone().ok_or_else(|| {
            lock_error(format!(
                "{} {} has no checksum; regenerate the lockfile with a current cargo",
                package.name, package.version
            ))
        })?;
        let suffixed = options.versioned_dirs || newest[package.name.as_str()] != version;
        let dir_name = if suffixed {
            format!("{}-{}", package.name, package.version)
        } else {
            package.name.clone()
        };
        jobs.push(CrateJob {
            name: package.name.clone(),
            version: package.version.clone(),
            checksum,
            dir: join_under(&vendor_root, dir_name)?,
        });
    }

    let mut written = 0u64;
    parallel(
        &jobs,
        options.parallelism,
        |job| prepare(job, fetcher, options),
        |prepared: PreparedCrate| {
            for dir in &prepared.dirs {
                builder.mkdir_all(dir)?;
            }
            for (path, bytes) in &prepared.files {
                written += bytes.len() as u64;
                if written > options.max_total_bytes {
                    return Err(CargoError::TooLarge {
                        what: "the vendored crates".to_string(),
                        limit: options.max_total_bytes,
                    });
                }
                builder.write(path, bytes)?;
            }
            report.vendored.push(prepared.vendored);
            Ok(())
        },
    )?;
    report.bytes_written = written;
    report.vendored.sort_by(|a, b| a.dir.cmp(&b.dir));

    if !jobs.is_empty() {
        report.config = Some(configure(builder, &workspace, &options.vendor_dir)?);
    }
    Ok(report)
}

/// The lockfile's packages with parsed versions, after checking the format
/// version and that every name and version is safe to put in a URL and a
/// path.
fn parse_lockfile(
    lock: &Lockfile,
) -> std::result::Result<Vec<(&LockedPackage, semver::Version)>, String> {
    match lock.version {
        // Versions 3 and 4 differ only in how git sources are encoded.
        Some(3 | 4) => {}
        // Version 2 had no `version` key but carried checksums inline, so it
        // reads the same; version 1 kept them in `[metadata]`, which the
        // missing-checksum check below reports.
        None => {}
        Some(other) => return Err(format!("unsupported lockfile version {other}")),
    }
    let mut out = Vec::with_capacity(lock.package.len());
    for package in &lock.package {
        if !is_crate_name(&package.name) {
            return Err(format!("{:?} is not a valid crate name", package.name));
        }
        let version = semver::Version::parse(&package.version)
            .map_err(|e| format!("{} {:?}: {e}", package.name, package.version))?;
        if let Some(checksum) = &package.checksum
            && (checksum.len() != 64 || !checksum.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(format!(
                "{} {}: malformed checksum",
                package.name, package.version
            ));
        }
        out.push((package, version));
    }
    Ok(out)
}

/// crates.io's rule: ASCII letters, digits, `-` and `_`, at most 64 long.
fn is_crate_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Downloads, verifies and unpacks one crate, writing nothing.
fn prepare(job: &CrateJob, fetcher: &dyn Fetcher, options: &CargoOptions) -> Result<PreparedCrate> {
    let bad = |message: String| CargoError::BadCrate {
        name: job.name.clone(),
        version: job.version.clone(),
        message,
    };
    let too_large = |what: &str, limit: u64| CargoError::TooLarge {
        what: format!("{} {}: {what}", job.name, job.version),
        limit,
    };
    let url = format!(
        "{}/{name}/{name}-{version}.crate",
        options.download_base.trim_end_matches('/'),
        name = job.name,
        version = job.version
    );
    let bytes = fetcher.fetch(&url, &Integrity::Sha256Hex(job.checksum.clone()))?;
    if bytes.len() as u64 > options.max_crate_bytes {
        return Err(too_large("the .crate download", options.max_crate_bytes));
    }

    let prefix = format!("{}-{}", job.name, job.version);
    let mut archive = tar::Archive::new(GzDecoder::new(&bytes[..]));
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut checksums = BTreeMap::new();
    let mut unpacked = 0u64;
    for entry in archive.entries().map_err(|e| bad(e.to_string()))? {
        let mut entry = entry.map_err(|e| bad(e.to_string()))?;
        let path = entry.path().map_err(|e| bad(e.to_string()))?.into_owned();
        let shown = path.display().to_string();
        let relative = path
            .strip_prefix(&prefix)
            .map_err(|_| bad(format!("{shown}: outside the {prefix}/ directory")))?;
        let relative =
            relative_parts(relative).ok_or_else(|| bad(format!("{shown}: escapes the crate")))?;
        let kind = entry.header().entry_type();
        if relative.is_empty() {
            if kind.is_dir() {
                continue;
            }
            return Err(bad(format!("{shown}: not a file inside the crate")));
        }
        if !vendor_this(&relative) {
            continue;
        }
        let key = relative.join("/");
        let target =
            join_under(&job.dir, &key).map_err(|_| bad(format!("{shown}: escapes the crate")))?;
        if kind.is_dir() {
            dirs.push(target);
            continue;
        }
        // Crates.io tarballs hold only files and directories (`cargo
        // package` follows symlinks), and a link is the classic way for an
        // archive to write outside where it is unpacked.
        if !(kind.is_file() || kind == tar::EntryType::Continuous) {
            return Err(bad(format!("{shown}: unsupported entry type {kind:?}")));
        }
        if files.len() >= options.max_files_per_crate {
            return Err(bad(format!(
                "more than {} files",
                options.max_files_per_crate
            )));
        }
        let size = entry.size();
        unpacked = unpacked.saturating_add(size);
        if unpacked > options.max_unpacked_bytes {
            return Err(too_large("unpacked", options.max_unpacked_bytes));
        }
        let mut content = Vec::with_capacity(size.min(1 << 20) as usize);
        entry
            .read_to_end(&mut content)
            .map_err(|e| bad(format!("{shown}: {e}")))?;
        checksums.insert(key, hex::encode(Sha256::digest(&content)));
        files.push((target, content));
    }

    let manifest = serde_json::json!({
        "$comment": CHECKSUM_COMMENT,
        "files": checksums,
        "package": job.checksum,
    });
    files.push((
        job.dir.join(".cargo-checksum.json"),
        manifest.to_string().into_bytes(),
    ));
    Ok(PreparedCrate {
        vendored: VendoredCrate {
            name: job.name.clone(),
            version: job.version.clone(),
            dir: job.dir.display().to_string(),
        },
        dirs,
        files,
    })
}

/// The plain components of a path inside a crate, or `None` if any
/// component is `..`, absolute or otherwise not a name. `.` is dropped so a
/// `./src/lib.rs` entry is keyed as `src/lib.rs`.
fn relative_parts(path: &Path) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts)
}

/// `cargo vendor`'s filter. A tarball's own `.cargo-checksum.json` at the
/// root is dropped as well: ours replaces it, and leaving it listed in
/// `files` would make cargo report the vendored copy as modified.
fn vendor_this(parts: &[String]) -> bool {
    if parts.iter().any(|part| part == ".git") {
        return false;
    }
    match parts.last().map(String::as_str) {
        Some(".gitattributes" | ".gitignore") => false,
        _ => {
            !(parts.len() == 1 && matches!(parts[0].as_str(), ".cargo-ok" | ".cargo-checksum.json"))
        }
    }
}

/// Points the workspace's cargo config at the vendor directory, appending
/// to an existing config rather than rewriting it, so its comments and
/// layout survive. Cargo reads `.cargo/config` over `.cargo/config.toml`
/// when both exist, so that is the one changed when present.
fn configure(
    builder: &SnapshotBuilder,
    workspace: &Path,
    vendor_dir: &str,
) -> Result<ConfigOutcome> {
    let legacy = workspace.join(".cargo/config");
    let path = if builder.is_file(&legacy) {
        legacy
    } else {
        workspace.join(".cargo/config.toml")
    };
    let shown = path.display().to_string();
    let conflict = |message: String| CargoError::ConflictingConfig {
        path: shown.clone(),
        message,
    };
    let vendor_root = join_under(workspace, vendor_dir)?;

    let existing = if builder.is_file(&path) {
        Some(
            String::from_utf8(builder.read(&path)?)
                .map_err(|_| conflict("not UTF-8".to_string()))?,
        )
    } else {
        None
    };
    let table: toml::Table = match &existing {
        Some(text) => text
            .parse()
            .map_err(|e| conflict(format!("not valid TOML: {e}")))?,
        None => toml::Table::new(),
    };
    let state = replacement_state(&table, workspace, &vendor_root).map_err(conflict)?;

    let directory = toml::Value::String(vendor_dir.to_string()).to_string();
    let mut addition = String::new();
    if !state.crates_io {
        addition.push_str(&format!(
            "[source.crates-io]\nreplace-with = \"{REPLACEMENT_NAME}\"\n"
        ));
    }
    if !state.vendored {
        if !addition.is_empty() {
            addition.push('\n');
        }
        addition.push_str(&format!(
            "[source.{REPLACEMENT_NAME}]\ndirectory = {directory}\n"
        ));
    }
    if addition.is_empty() {
        return Ok(ConfigOutcome {
            path: shown,
            change: ConfigChange::AlreadyConfigured,
        });
    }

    let header = "# Added by the CI runner: crates.io resolves from the vendored copies it\n\
                  # downloaded and checked against Cargo.lock.\n";
    let (merged, change) = match existing {
        Some(mut text) => {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push('\n');
            text.push_str(header);
            text.push_str(&addition);
            (text, ConfigChange::Appended)
        }
        None => (format!("{header}{addition}"), ConfigChange::Created),
    };
    // Appending a table header can clash with how the file already wrote
    // `source` (an inline table, say, or a `[source.crates-io]` with other
    // keys). Re-reading the result catches every such case.
    let reread: toml::Table = merged.parse().map_err(|e| {
        conflict(format!(
            "cannot add the vendored source to this file's [source] tables: {e}"
        ))
    })?;
    let state = replacement_state(&reread, workspace, &vendor_root).map_err(conflict)?;
    if !(state.crates_io && state.vendored) {
        return Err(conflict(
            "the vendored source did not take effect".to_string(),
        ));
    }
    builder.write(&path, merged.as_bytes())?;
    Ok(ConfigOutcome {
        path: shown,
        change,
    })
}

struct ReplacementState {
    /// `[source.crates-io] replace-with = "vendored-sources"` is present.
    crates_io: bool,
    /// `[source.vendored-sources] directory` names the vendor directory.
    vendored: bool,
}

/// What a config already says about crates.io's replacement, or why it
/// conflicts with vendoring.
fn replacement_state(
    table: &toml::Table,
    workspace: &Path,
    vendor_root: &Path,
) -> std::result::Result<ReplacementState, String> {
    let Some(source) = table.get("source") else {
        return Ok(ReplacementState {
            crates_io: false,
            vendored: false,
        });
    };
    let source = source.as_table().ok_or("`source` is not a table")?;
    let crates_io = match source.get("crates-io") {
        None => false,
        Some(value) => {
            let section = value
                .as_table()
                .ok_or("`source.crates-io` is not a table")?;
            match section.get("replace-with").map(|v| v.as_str()) {
                Some(Some(REPLACEMENT_NAME)) => true,
                Some(Some(other)) => {
                    return Err(format!(
                        "crates.io is already replaced with {other:?}; vendoring needs {REPLACEMENT_NAME:?}"
                    ));
                }
                Some(None) => {
                    return Err("`source.crates-io.replace-with` is not a string".to_string());
                }
                None => false,
            }
        }
    };
    let vendored = match source.get(REPLACEMENT_NAME) {
        None => false,
        Some(value) => {
            let section = value
                .as_table()
                .ok_or_else(|| format!("`source.{REPLACEMENT_NAME}` is not a table"))?;
            let directory = section.get("directory").and_then(|v| v.as_str());
            let points_here = directory.is_some_and(|d| lexical_join(workspace, d) == vendor_root);
            if !points_here || section.len() != 1 {
                return Err(format!(
                    "`source.{REPLACEMENT_NAME}` is already defined as something other than this vendor directory"
                ));
            }
            true
        }
    };
    Ok(ReplacementState {
        crates_io,
        vendored,
    })
}

#[cfg(test)]
mod tests {
    use flate2::Compression;
    use flate2::write::GzEncoder;

    use super::*;
    use crate::fetch::MemoryFetcher;

    fn sha256(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    /// A `.crate`: a gzipped tar with every path under `<prefix>/`.
    fn crate_of(prefix: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        for (name, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, format!("{prefix}/{name}"), *bytes)
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    /// A `.crate` with one raw entry, bypassing the tar crate's own path
    /// checks so it can hold names a real attacker would write.
    fn raw_crate(name: &str, kind: tar::EntryType, link: Option<&str>) -> Vec<u8> {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        let mut header = tar::Header::new_gnu();
        header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
        header.set_entry_type(kind);
        header.set_mode(0o644);
        let body: &[u8] = if kind.is_file() { b"x" } else { b"" };
        header.set_size(body.len() as u64);
        if let Some(link) = link {
            header.as_gnu_mut().unwrap().linkname[..link.len()].copy_from_slice(link.as_bytes());
        }
        header.set_cksum();
        builder.append(&header, body).unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    const CARGO_TOML: &[u8] = b"[package]\nname = \"x\"\n";

    struct Fixture {
        builder: SnapshotBuilder,
        fetcher: MemoryFetcher,
        crates: HashMap<String, Vec<u8>>,
    }

    fn url(name: &str, version: &str) -> String {
        format!("{DEFAULT_DOWNLOAD_BASE}/{name}/{name}-{version}.crate")
    }

    fn fixture() -> Fixture {
        let fetcher = MemoryFetcher::new();
        let mut crates = HashMap::new();
        for (name, version) in [("foo", "1.0.0"), ("foo", "2.0.0"), ("bar", "0.3.1+meta")] {
            let lib = format!("// {name} {version}\n");
            let tarball = crate_of(
                &format!("{name}-{version}"),
                &[
                    ("Cargo.toml", CARGO_TOML),
                    ("Cargo.toml.orig", CARGO_TOML),
                    (".cargo_vcs_info.json", b"{}"),
                    (".gitignore", b"/target\n"),
                    ("src/lib.rs", lib.as_bytes()),
                ],
            );
            fetcher.insert(url(name, version), tarball.clone());
            crates.insert(format!("{name}-{version}"), tarball);
        }
        let lock = format!(
            r#"# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = ["foo 1.0.0", "foo 2.0.0", "bar", "gitdep", "other"]

[[package]]
name = "foo"
version = "1.0.0"
source = "{CRATES_IO}"
checksum = "{}"

[[package]]
name = "foo"
version = "2.0.0"
source = "{CRATES_IO}"
checksum = "{}"

[[package]]
name = "bar"
version = "0.3.1+meta"
source = "{CRATES_IO}"
checksum = "{}"

[[package]]
name = "gitdep"
version = "0.1.0"
source = "git+https://github.com/example/gitdep?branch=main#0123456789abcdef0123456789abcdef01234567"

[[package]]
name = "other"
version = "1.0.0"
source = "sparse+https://registry.example.com/index/"
checksum = "{}"
"#,
            sha256(&crates["foo-1.0.0"]),
            sha256(&crates["foo-2.0.0"]),
            sha256(&crates["bar-0.3.1+meta"]),
            "0".repeat(64),
        );
        let builder = SnapshotBuilder::new();
        builder.write("/app/Cargo.toml", b"[workspace]\n").unwrap();
        builder.write("/app/Cargo.lock", lock.as_bytes()).unwrap();
        Fixture {
            builder,
            fetcher,
            crates,
        }
    }

    #[test]
    fn vendors_like_cargo_vendor() {
        let f = fixture();
        let report = install(&f.builder, "/app", &f.fetcher, &CargoOptions::default()).unwrap();
        assert_eq!(report.lockfile_version, Some(4));
        let dirs: Vec<_> = report.vendored.iter().map(|c| c.dir.as_str()).collect();
        // The newest foo takes the bare name; the older one is suffixed.
        assert_eq!(
            dirs,
            [
                "/app/vendor/bar",
                "/app/vendor/foo",
                "/app/vendor/foo-1.0.0"
            ]
        );
        assert_eq!(
            report.unsupported,
            [
                UnsupportedPackage {
                    name: "gitdep".into(),
                    version: "0.1.0".into(),
                    source: "git+https://github.com/example/gitdep?branch=main#0123456789abcdef0123456789abcdef01234567".into(),
                },
                UnsupportedPackage {
                    name: "other".into(),
                    version: "1.0.0".into(),
                    source: "sparse+https://registry.example.com/index/".into(),
                },
            ]
        );
        assert_eq!(
            f.builder.read("/app/vendor/foo/src/lib.rs").unwrap(),
            b"// foo 2.0.0\n"
        );
        assert_eq!(
            f.builder.read("/app/vendor/foo-1.0.0/src/lib.rs").unwrap(),
            b"// foo 1.0.0\n"
        );
        assert!(!f.builder.is_file("/app/vendor/foo/.gitignore"));
        assert!(f.builder.is_file("/app/vendor/foo/Cargo.toml.orig"));

        let manifest: serde_json::Value = serde_json::from_slice(
            &f.builder
                .read("/app/vendor/bar/.cargo-checksum.json")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["package"], sha256(&f.crates["bar-0.3.1+meta"]));
        let files = manifest["files"].as_object().unwrap();
        let mut names: Vec<_> = files.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                ".cargo_vcs_info.json",
                "Cargo.toml",
                "Cargo.toml.orig",
                "src/lib.rs"
            ]
        );
        assert_eq!(files["src/lib.rs"], sha256(b"// bar 0.3.1+meta\n"));
        assert_eq!(files["Cargo.toml"], sha256(CARGO_TOML));

        let config = report.config.unwrap();
        assert_eq!(config.path, "/app/.cargo/config.toml");
        assert_eq!(config.change, ConfigChange::Created);
        let written: toml::Table = String::from_utf8(f.builder.read(&config.path).unwrap())
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            written["source"]["crates-io"]["replace-with"].as_str(),
            Some("vendored-sources")
        );
        assert_eq!(
            written["source"]["vendored-sources"]["directory"].as_str(),
            Some("vendor")
        );
        assert_eq!(
            report.env,
            [("CARGO_NET_OFFLINE".to_string(), "true".to_string())]
        );
    }

    #[test]
    fn merges_an_existing_config() {
        let f = fixture();
        let existing = "# keep me\n[build]\ntarget-dir = \"out\"\n\n[source.mirror]\nregistry = \"sparse+https://m.example/\"";
        f.builder
            .write("/app/.cargo/config.toml", existing.as_bytes())
            .unwrap();
        let report = install(&f.builder, "/app", &f.fetcher, &CargoOptions::default()).unwrap();
        assert_eq!(report.config.unwrap().change, ConfigChange::Appended);
        let text = String::from_utf8(f.builder.read("/app/.cargo/config.toml").unwrap()).unwrap();
        assert!(text.starts_with(existing), "{text}");
        let table: toml::Table = text.parse().unwrap();
        assert_eq!(table["build"]["target-dir"].as_str(), Some("out"));
        assert_eq!(
            table["source"]["crates-io"]["replace-with"].as_str(),
            Some("vendored-sources")
        );

        // Running again finds it already configured and leaves it alone.
        let report = install(&f.builder, "/app", &f.fetcher, &CargoOptions::default()).unwrap();
        assert_eq!(
            report.config.unwrap().change,
            ConfigChange::AlreadyConfigured
        );
        assert_eq!(
            f.builder.read("/app/.cargo/config.toml").unwrap(),
            text.as_bytes()
        );
    }

    #[test]
    fn the_legacy_config_name_wins_and_conflicts_are_refused() {
        let f = fixture();
        f.builder
            .write("/app/.cargo/config", b"[net]\nretry = 3\n")
            .unwrap();
        let report = install(&f.builder, "/app", &f.fetcher, &CargoOptions::default()).unwrap();
        assert_eq!(report.config.unwrap().path, "/app/.cargo/config");
        assert!(!f.builder.is_file("/app/.cargo/config.toml"));

        for conflicting in [
            "[source.crates-io]\nreplace-with = \"mirror\"\n",
            "[source.vendored-sources]\ndirectory = \"third_party\"\n",
            "[source.crates-io]\nregistry = \"x\"\n",
            "source = { mirror = { registry = \"x\" } }\n",
        ] {
            let f = fixture();
            f.builder
                .write("/app/.cargo/config.toml", conflicting.as_bytes())
                .unwrap();
            let error =
                install(&f.builder, "/app", &f.fetcher, &CargoOptions::default()).unwrap_err();
            assert!(
                matches!(error, CargoError::ConflictingConfig { .. }),
                "{conflicting}: {error}"
            );
            assert_eq!(
                f.builder.read("/app/.cargo/config.toml").unwrap(),
                conflicting.as_bytes()
            );
        }
    }

    #[test]
    fn a_checksum_mismatch_fails_before_anything_is_written() {
        let f = fixture();
        f.fetcher.insert(
            url("foo", "2.0.0"),
            crate_of("foo-2.0.0", &[("src/lib.rs", b"evil")]),
        );
        let options = CargoOptions {
            parallelism: 1,
            ..CargoOptions::default()
        };
        let error = install(&f.builder, "/app", &f.fetcher, &options).unwrap_err();
        assert!(
            matches!(&error, CargoError::Fetch(FetchError::IntegrityMismatch { url: u, .. }) if u == &url("foo", "2.0.0")),
            "{error}"
        );
        assert!(!f.builder.is_dir("/app/vendor/foo"));
        assert!(!f.builder.is_file("/app/.cargo/config.toml"));
    }

    fn single_crate_lock(tarball: &[u8]) -> (SnapshotBuilder, MemoryFetcher) {
        let fetcher = MemoryFetcher::new();
        fetcher.insert(url("evil", "1.0.0"), tarball.to_vec());
        let builder = SnapshotBuilder::new();
        let lock = format!(
            "version = 3\n\n[[package]]\nname = \"evil\"\nversion = \"1.0.0\"\nsource = \"{CRATES_IO}\"\nchecksum = \"{}\"\n",
            sha256(tarball)
        );
        builder.write("/app/Cargo.lock", lock.as_bytes()).unwrap();
        (builder, fetcher)
    }

    #[test]
    fn escaping_and_linking_entries_are_refused() {
        for (name, kind, link) in [
            ("evil-1.0.0/../../etc/passwd", tar::EntryType::Regular, None),
            ("/etc/passwd", tar::EntryType::Regular, None),
            ("other-1.0.0/src/lib.rs", tar::EntryType::Regular, None),
            (
                "evil-1.0.0/link",
                tar::EntryType::Symlink,
                Some("/etc/passwd"),
            ),
            (
                "evil-1.0.0/hard",
                tar::EntryType::Link,
                Some("evil-1.0.0/Cargo.toml"),
            ),
        ] {
            let (builder, fetcher) = single_crate_lock(&raw_crate(name, kind, link));
            let error = install(&builder, "/app", &fetcher, &CargoOptions::default()).unwrap_err();
            assert!(
                matches!(error, CargoError::BadCrate { .. }),
                "{name}: {error}"
            );
            assert_eq!(
                iwci_vfs::list_files(builder.fs(), "/"),
                [PathBuf::from("/app/Cargo.lock")]
            );
        }
    }

    #[test]
    fn crates_over_the_limits_are_refused() {
        let tarball = crate_of("evil-1.0.0", &[("a", &[0u8; 2048]), ("b", b"b")]);
        let (builder, fetcher) = single_crate_lock(&tarball);
        let options = CargoOptions {
            max_unpacked_bytes: 1024,
            ..CargoOptions::default()
        };
        assert!(matches!(
            install(&builder, "/app", &fetcher, &options),
            Err(CargoError::TooLarge { .. })
        ));
        let options = CargoOptions {
            max_files_per_crate: 1,
            ..CargoOptions::default()
        };
        assert!(matches!(
            install(&builder, "/app", &fetcher, &options),
            Err(CargoError::BadCrate { .. })
        ));
    }

    #[test]
    fn lockfiles_without_checksums_or_with_unknown_versions_are_refused() {
        let builder = SnapshotBuilder::new();
        builder
            .write(
                "/app/Cargo.lock",
                format!("[[package]]\nname = \"a\"\nversion = \"1.0.0\"\nsource = \"{CRATES_IO}\"\n\n[metadata]\n").as_bytes(),
            )
            .unwrap();
        let error = install(
            &builder,
            "/app",
            &MemoryFetcher::new(),
            &CargoOptions::default(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("no checksum"), "{error}");
        builder.write("/app/Cargo.lock", b"version = 9\n").unwrap();
        let error = install(
            &builder,
            "/app",
            &MemoryFetcher::new(),
            &CargoOptions::default(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("version 9"), "{error}");
        assert!(matches!(
            install(
                &SnapshotBuilder::new(),
                "/app",
                &MemoryFetcher::new(),
                &CargoOptions::default()
            ),
            Err(CargoError::NoLockfile(_))
        ));
        // A lockfile with only path packages needs nothing and writes no config.
        builder
            .write(
                "/app/Cargo.lock",
                b"version = 4\n\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\n",
            )
            .unwrap();
        let report = install(
            &builder,
            "/app",
            &MemoryFetcher::new(),
            &CargoOptions::default(),
        )
        .unwrap();
        assert!(report.vendored.is_empty() && report.config.is_none());
    }

    #[test]
    fn parses_the_linux_appservers_lockfile() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../linux-appserver/Cargo.lock");
        let Ok(text) = std::fs::read_to_string(&path) else {
            eprintln!("skipping: linux-appserver not present");
            return;
        };
        let lock: Lockfile = toml::from_str(&text).unwrap();
        assert_eq!(lock.version, Some(4));
        let packages = parse_lockfile(&lock).unwrap();
        let registry = packages
            .iter()
            .filter(|(p, _)| p.source.as_deref() == Some(CRATES_IO))
            .count();
        let expected = text.matches(&format!("source = \"{CRATES_IO}\"")).count();
        assert_eq!(registry, expected);
        assert!(registry > 0);
        assert!(
            packages
                .iter()
                .all(|(p, _)| p.source.is_none() || p.checksum.is_some())
        );
    }

    /// Vendors a real workspace from crates.io and, when `IWCI_EXPORT_DIR` is
    /// set, copies the snapshot there so `cargo fetch --offline --locked` can
    /// check it with cargo's own directory source.
    #[test]
    #[ignore = "downloads from crates.io"]
    fn real_workspace_vendor() {
        let source = std::env::var("IWCI_CARGO_WORKSPACE")
            .unwrap_or_else(|_| format!("{}/../../../linux-appserver", env!("CARGO_MANIFEST_DIR")));
        let builder = SnapshotBuilder::new();
        let bytes = std::fs::read(Path::new(&source).join("Cargo.lock")).unwrap();
        builder.write("/app/Cargo.lock", &bytes).unwrap();
        let report = install(
            &builder,
            "/app",
            &crate::go::tests::CurlFetcher,
            &CargoOptions::default(),
        )
        .unwrap();
        eprintln!(
            "{} crates, {} bytes, unsupported {:?}",
            report.vendored.len(),
            report.bytes_written,
            report.unsupported
        );
        if let Ok(out) = std::env::var("IWCI_EXPORT_DIR") {
            crate::go::tests::export(&builder, Path::new(&out));
        }
    }
}
