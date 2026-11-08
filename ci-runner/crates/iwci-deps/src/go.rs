//! Go modules: fills a module cache (`GOMODCACHE`) from `go.sum`.
//!
//! `go.sum` is the lockfile here. Every `<module> <version> h1:<hash>` line
//! pins a module's whole source tree and every `<module> <version>/go.mod
//! h1:<hash>` line pins just its `go.mod`, which the go command needs for
//! modules that only take part in version selection. Downloading everything
//! `go.sum` pins, rather than resolving the build list from `go.mod`, keeps
//! this installer free of Go's version selection and still covers `replace`
//! directives, because `go.sum` records the replacement's hashes.
//!
//! Everything comes from a module proxy over the GOPROXY protocol and is laid
//! out exactly as the go command lays out its own cache:
//!
//! ```text
//! $GOMODCACHE/cache/download/<escaped module>/@v/<escaped version>.mod
//! $GOMODCACHE/cache/download/<escaped module>/@v/<escaped version>.info
//! $GOMODCACHE/cache/download/<escaped module>/@v/<escaped version>.zip
//! $GOMODCACHE/cache/download/<escaped module>/@v/<escaped version>.ziphash
//! $GOMODCACHE/<escaped module>@<escaped version>/...   (the extracted tree)
//! ```
//!
//! A go.mod-only pin gets just its `.mod`, which is what the go command
//! itself leaves behind for such modules. The go command treats an extracted
//! directory as complete only when its `.ziphash` exists, and it checks that
//! hash against `go.sum` before using the directory, so the cache this writes
//! is checked again by the toolchain in the isolate.
//!
//! The `h1:` hash covers the files inside the zip rather than the zip's
//! bytes, so the zip is fetched with [`Integrity::VerifiedAfterExtraction`]
//! and verified here, in memory, before any of it is written.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use base64::Engine;
use iwci_vfs::{SnapshotBuilder, VfsError, join_under, normalise};
use sha2::{Digest, Sha256};

use crate::fetch::{FetchError, Fetcher, Integrity};

pub const DEFAULT_PROXY: &str = "https://proxy.golang.org";
pub const DEFAULT_MOD_CACHE: &str = "/root/go/pkg/mod";

/// Go's own limits on a module zip (`golang.org/x/mod/zip`): the zip and the
/// total of its uncompressed files may each be at most 500 MiB, and a
/// `go.mod` or `LICENSE` at most 16 MiB. A zip over them is one the go
/// command would refuse to extract, so refusing it here costs nothing.
pub const MAX_ZIP_FILE: u64 = 500 << 20;
pub const MAX_GO_MOD: u64 = 16 << 20;
pub const MAX_LICENSE: u64 = 16 << 20;

/// The module that carries Go toolchains. `go.sum` lists it when the go
/// command switched toolchains, but the isolate runs with
/// `GOTOOLCHAIN=local` and each of its zips is a whole Go distribution for
/// one platform, so it is never installed.
const TOOLCHAIN_MODULE: &str = "golang.org/toolchain";

/// How the go command in the isolate treats `go.mod`; becomes `GOFLAGS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ModFlag {
    /// `-mod=readonly`: build from the module cache, ignore any `vendor`
    /// directory, and fail if `go.mod` or `go.sum` would need to change.
    /// The default, because CI should report a stale `go.mod` rather than
    /// quietly repair it in a fork whose changes may become a commit, and
    /// because the go command could not fetch whatever a repair needed
    /// anyway.
    #[default]
    Readonly,
    /// `-mod=mod`: as readonly, but lets the go command rewrite `go.mod`
    /// and `go.sum` from what is in the cache.
    Mod,
    /// Leave `GOFLAGS` unset, so a repository with a committed `vendor`
    /// directory builds from it as it does on a developer's machine.
    Inherit,
}

impl ModFlag {
    fn goflags(self) -> Option<&'static str> {
        match self {
            ModFlag::Readonly => Some("-mod=readonly"),
            ModFlag::Mod => Some("-mod=mod"),
            ModFlag::Inherit => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GoOptions {
    /// Module proxy base URL, without a trailing slash.
    pub proxy: String,
    /// Where the module cache goes in the snapshot (absolute).
    pub mod_cache: String,
    pub mod_flag: ModFlag,
    /// Whether to keep each module's `.zip` beside its extracted tree. The
    /// go command builds from the tree alone; the zip is only read by
    /// `go mod verify` and when serving the cache as a proxy. Dropping it
    /// halves the memory a large dependency graph takes.
    pub keep_zips: bool,
    /// Downloads in flight at once.
    pub parallelism: usize,
    /// Go sets no limit on the number of files in a module, so this one is
    /// ours: a 500 MiB zip of empty files would otherwise be millions of
    /// in-memory entries.
    pub max_files_per_module: usize,
    /// Bytes written into the snapshot across every module, the zips, trees
    /// and metadata together. The snapshot lives in memory.
    pub max_total_bytes: u64,
}

impl Default for GoOptions {
    fn default() -> Self {
        Self {
            proxy: DEFAULT_PROXY.to_string(),
            mod_cache: DEFAULT_MOD_CACHE.to_string(),
            mod_flag: ModFlag::default(),
            keep_zips: true,
            parallelism: 8,
            max_files_per_module: 250_000,
            max_total_bytes: 4 << 30,
        }
    }
}

/// What `go.sum` pinned for one module version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinKind {
    /// The source tree (and its `go.mod`): zip, tree, `.mod`, `.info`,
    /// `.ziphash`.
    Source,
    /// Only the `go.mod`: just the `.mod`.
    GoModOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoModule {
    pub path: String,
    pub version: String,
    pub kind: PinKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedModule {
    pub path: String,
    pub version: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct GoReport {
    /// The `module` path of each `go.mod` read (the workspace's modules).
    pub main_modules: Vec<String>,
    /// The `go.sum` and `go.work.sum` files the pins came from.
    pub sum_files: Vec<String>,
    /// Every installed module version, sorted.
    pub modules: Vec<GoModule>,
    pub skipped: Vec<SkippedModule>,
    pub bytes_written: u64,
    /// What a job's environment needs; see [`env`].
    pub env: Vec<(String, String)>,
}

#[derive(Debug, thiserror::Error)]
pub enum GoError {
    #[error(transparent)]
    Vfs(#[from] VfsError),
    #[error(transparent)]
    Fetch(#[from] FetchError),
    #[error("{0}: no go.mod or go.work")]
    NotAModule(String),
    #[error("{file}:{line}: {message}")]
    Parse {
        file: String,
        line: usize,
        message: String,
    },
    #[error("{dir}: listed in go.work but has no go.mod")]
    MissingModule { dir: String },
    #[error("{0:?} is not a valid module path")]
    BadModulePath(String),
    #[error("{0:?} is not a valid module version")]
    BadVersion(String),
    #[error("{module}@{version}: go.sum files pin different hashes ({first} and {second})")]
    ConflictingPins {
        module: String,
        version: String,
        first: String,
        second: String,
    },
    #[error("{url}: hashes to {actual}, but go.sum pins {expected}")]
    HashMismatch {
        url: String,
        expected: String,
        actual: String,
    },
    #[error("{module}: {message}")]
    BadModule { module: String, message: String },
    #[error("installing Go modules would write more than {limit} bytes")]
    TooLarge { limit: u64 },
}

pub type Result<T> = std::result::Result<T, GoError>;

/// The environment a job needs to build offline from the installed cache.
///
/// - `GOMODCACHE` points at the cache, and `GOPATH` at the directory it sits
///   in when the cache is the conventional `<GOPATH>/pkg/mod`.
/// - `GOPROXY=off` makes anything missing fail at once with "module lookup
///   disabled", instead of each lookup waiting on a network the isolate does
///   not have.
/// - `GOSUMDB=off` because the checksum database is only consulted for a
///   module `go.sum` does not list, and with the proxy off no such module
///   can arrive. Every module in the cache was verified against `go.sum`
///   here, and the go command verifies it again on use. (`GONOSUMDB=*`
///   would say the same thing in a pattern; one variable is clearer.)
/// - `GOTOOLCHAIN=local` because a `go` or `toolchain` line newer than the
///   isolate's Go would otherwise send the go command to download a
///   toolchain; this way it fails naming the version it wanted.
/// - `GOFLAGS` as [`ModFlag`] describes.
pub fn env(options: &GoOptions) -> Vec<(String, String)> {
    let mut env = vec![("GOMODCACHE".to_string(), options.mod_cache.clone())];
    if let Some(gopath) = options.mod_cache.strip_suffix("/pkg/mod")
        && !gopath.is_empty()
    {
        env.push(("GOPATH".to_string(), gopath.to_string()));
    }
    env.push(("GOPROXY".to_string(), "off".to_string()));
    env.push(("GOSUMDB".to_string(), "off".to_string()));
    env.push(("GOTOOLCHAIN".to_string(), "local".to_string()));
    if let Some(flags) = options.mod_flag.goflags() {
        env.push(("GOFLAGS".to_string(), flags.to_string()));
    }
    env
}

/// Installs every module version the `go.sum` files under `module_dir` pin.
///
/// `module_dir` holds a `go.mod`, a `go.work`, or both. With a `go.work`,
/// the `go.sum` of every module it `use`s is read, plus `go.work.sum`.
pub fn install(
    builder: &SnapshotBuilder,
    module_dir: &str,
    fetcher: &dyn Fetcher,
    options: &GoOptions,
) -> Result<GoReport> {
    let dir = normalise(module_dir)?;
    normalise(&options.mod_cache)?;
    let has_mod = builder.is_file(dir.join("go.mod"));
    let work_path = dir.join("go.work");
    let has_work = builder.is_file(&work_path);
    if !has_mod && !has_work {
        return Err(GoError::NotAModule(dir.display().to_string()));
    }

    let mut module_dirs = BTreeSet::new();
    let mut sum_paths = Vec::new();
    if has_work {
        let text = read_text(builder, &work_path)?;
        for used in parse_go_work_uses(&text, &work_path.display().to_string())? {
            let used_dir = lexical_join(&dir, &used);
            if !builder.is_file(used_dir.join("go.mod")) {
                return Err(GoError::MissingModule {
                    dir: used_dir.display().to_string(),
                });
            }
            module_dirs.insert(used_dir);
        }
        sum_paths.push(dir.join("go.work.sum"));
    }
    // Read even when a go.work leaves it out: a job may well build with
    // GOWORK=off, and extra pins only cost a download.
    if has_mod {
        module_dirs.insert(dir.clone());
    }

    let mut report = GoReport {
        env: env(options),
        ..GoReport::default()
    };
    for module_dir in &module_dirs {
        let go_mod_path = module_dir.join("go.mod");
        if let Some(path) = module_directive(&read_text(builder, &go_mod_path)?) {
            report.main_modules.push(path);
        }
        sum_paths.push(module_dir.join("go.sum"));
    }

    let mut pins = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for path in sum_paths {
        if !seen.insert(path.clone()) || !builder.is_file(&path) {
            continue;
        }
        let file = path.display().to_string();
        parse_go_sum(&read_text(builder, &path)?, &file, &mut pins)?;
        report.sum_files.push(file);
    }

    let mut jobs = Vec::new();
    for ((path, version), pin) in pins {
        if path == TOOLCHAIN_MODULE {
            report.skipped.push(SkippedModule {
                path,
                version,
                reason: "Go toolchain; the isolate runs with GOTOOLCHAIN=local".to_string(),
            });
            continue;
        }
        jobs.push(Job { path, version, pin });
    }

    let mut written = 0u64;
    parallel(
        &jobs,
        options.parallelism,
        |job| prepare(job, fetcher, options),
        |prepared: Prepared| {
            for (path, payload) in &prepared.files {
                written += payload.len() as u64;
                if written > options.max_total_bytes {
                    return Err(GoError::TooLarge {
                        limit: options.max_total_bytes,
                    });
                }
                builder.write(path, payload)?;
            }
            report.modules.push(prepared.module);
            Ok(())
        },
    )?;
    report.bytes_written = written;
    report
        .modules
        .sort_by(|a, b| (&a.path, &a.version).cmp(&(&b.path, &b.version)));
    Ok(report)
}

/// Go's case-encoding of a module path for URLs and cache paths: each
/// uppercase letter becomes `!` and its lowercase, so `example.com/M` and
/// `example.com/m` stay distinct on case-insensitive file systems. Fails on
/// anything that is not a valid module path, which also guarantees the
/// result is safe in a URL and as a relative path.
pub fn escape_path(path: &str) -> Result<String> {
    if !is_module_path(path) {
        return Err(GoError::BadModulePath(path.to_string()));
    }
    Ok(case_encode(path))
}

/// [`escape_path`] for a version (`v1.0.0-RC1` becomes `v1.0.0-!r!c1`).
pub fn escape_version(version: &str) -> Result<String> {
    if !is_version(version) {
        return Err(GoError::BadVersion(version.to_string()));
    }
    Ok(case_encode(version))
}

fn case_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            out.push('!');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Go's dirhash `Hash1`: the SHA-256 of the sorted lines
/// `"<hex sha256 of file>  <name>\n"`, base64 encoded behind `h1:`. For a
/// module zip the names are the zip's entry names, `<module>@<version>/` and
/// all. `None` if a name contains a newline, which the format cannot carry.
pub fn hash1<'a>(files: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> Option<String> {
    let mut lines: Vec<(&str, String)> = Vec::new();
    for (name, bytes) in files {
        if name.contains('\n') {
            return None;
        }
        lines.push((name, hex::encode(Sha256::digest(bytes))));
    }
    lines.sort_by(|a, b| a.0.cmp(b.0));
    let mut summary = Sha256::new();
    for (name, digest) in lines {
        summary.update(format!("{digest}  {name}\n").as_bytes());
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(summary.finalize());
    Some(format!("h1:{encoded}"))
}

/// The hash a `/go.mod h1:` line pins: [`hash1`] over a single file named
/// `go.mod` (no module prefix), as the go command's `goModSum` computes it.
pub fn hash_go_mod(bytes: &[u8]) -> String {
    hash1([("go.mod", bytes)]).expect("the name has no newline")
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Pin {
    zip: Option<String>,
    go_mod: Option<String>,
}

struct Job {
    path: String,
    version: String,
    pin: Pin,
}

/// Bytes on their way into the snapshot: either straight from the fetcher
/// (no copy) or produced here.
enum Payload {
    Shared(Arc<[u8]>),
    Owned(Vec<u8>),
}

impl std::ops::Deref for Payload {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        match self {
            Payload::Shared(bytes) => bytes,
            Payload::Owned(bytes) => bytes,
        }
    }
}

struct Prepared {
    module: GoModule,
    files: Vec<(PathBuf, Payload)>,
}

/// Downloads and verifies one module version and returns the files it
/// becomes, without writing anything.
fn prepare(job: &Job, fetcher: &dyn Fetcher, options: &GoOptions) -> Result<Prepared> {
    let module = format!("{}@{}", job.path, job.version);
    let bad = |message: String| GoError::BadModule {
        module: module.clone(),
        message,
    };
    let escaped_path = escape_path(&job.path)?;
    let escaped_version = escape_version(&job.version)?;
    let proxy = options.proxy.trim_end_matches('/');
    let url = |ext: &str| format!("{proxy}/{escaped_path}/@v/{escaped_version}.{ext}");
    let download_dir = join_under(
        &options.mod_cache,
        format!("cache/download/{escaped_path}/@v"),
    )?;
    let download_file = |ext: &str| download_dir.join(format!("{escaped_version}.{ext}"));

    let mod_url = url("mod");
    // Pinned `.mod` files and zips are checked by the fetcher against
    // go.sum, which is what lets it cache them; the checks below stay as
    // the installer's own guarantee whatever fetcher it is given.
    let mod_integrity = match &job.pin.go_mod {
        Some(h1) => Integrity::GoMod { h1: h1.clone() },
        None => Integrity::VerifiedAfterExtraction,
    };
    let go_mod = fetcher.fetch(&mod_url, &mod_integrity)?;
    if go_mod.len() as u64 > MAX_GO_MOD {
        return Err(bad(format!(
            "go.mod is larger than Go's {MAX_GO_MOD} byte limit"
        )));
    }
    if let Some(expected) = &job.pin.go_mod {
        let actual = hash_go_mod(&go_mod);
        if &actual != expected {
            return Err(GoError::HashMismatch {
                url: mod_url,
                expected: expected.clone(),
                actual,
            });
        }
    }

    let mut files = Vec::new();
    let kind = if let Some(expected) = &job.pin.zip {
        let zip_url = url("zip");
        let zip = fetcher.fetch(
            &zip_url,
            &Integrity::GoModuleZip {
                module: job.path.clone(),
                version: job.version.clone(),
                h1: expected.clone(),
            },
        )?;
        let tree = read_module_zip(&job.path, &job.version, &zip, options.max_files_per_module)
            .map_err(bad)?;
        if &tree.hash != expected {
            return Err(GoError::HashMismatch {
                url: zip_url,
                expected: expected.clone(),
                actual: tree.hash,
            });
        }
        if job.pin.go_mod.is_none() {
            // Nothing pins the .mod, so hold it to the go.mod inside the
            // verified zip, or to the one-line file the proxy protocol
            // synthesises for a module without one.
            let synthesised = format!("module {}\n", job.path).into_bytes();
            let want = tree.go_mod.as_deref().unwrap_or(&synthesised);
            if &go_mod[..] != want {
                return Err(bad(format!(
                    "{mod_url} does not match the go.mod in the verified zip"
                )));
            }
        }
        // The .info file (version and commit time) is not covered by any
        // hash; the go command does not verify it either. Checking that it
        // names the version asked for catches a proxy serving garbage.
        let info_url = url("info");
        let info = fetcher.fetch(&info_url, &Integrity::VerifiedAfterExtraction)?;
        check_info(&info, &job.version).map_err(|m| bad(format!("{info_url}: {m}")))?;

        let root = join_under(
            &options.mod_cache,
            format!("{escaped_path}@{escaped_version}"),
        )?;
        for (relative, bytes) in tree.files {
            files.push((join_under(&root, &relative)?, Payload::Owned(bytes)));
        }
        files.push((download_file("info"), Payload::Shared(info)));
        if options.keep_zips {
            files.push((download_file("zip"), Payload::Shared(zip)));
        }
        // Written without a trailing newline, as the go command writes it.
        files.push((
            download_file("ziphash"),
            Payload::Owned(tree.hash.into_bytes()),
        ));
        PinKind::Source
    } else {
        PinKind::GoModOnly
    };
    files.push((download_file("mod"), Payload::Shared(go_mod)));

    Ok(Prepared {
        module: GoModule {
            path: job.path.clone(),
            version: job.version.clone(),
            kind,
        },
        files,
    })
}

fn check_info(bytes: &[u8], version: &str) -> std::result::Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("not JSON: {e}"))?;
    match value.get("Version").and_then(|v| v.as_str()) {
        Some(found) if found == version => Ok(()),
        Some(found) => Err(format!("names version {found}")),
        None => Err("has no Version".to_string()),
    }
}

/// A module zip's verified content.
struct ModuleTree {
    hash: String,
    go_mod: Option<Vec<u8>>,
    /// Paths relative to the module root, and their bytes.
    files: Vec<(String, Vec<u8>)>,
}

/// The `h1:` hash of a module zip, after the same checks the installer
/// applies, for the fetcher to verify (and so cache) zips by.
pub(crate) fn zip_h1(
    path: &str,
    version: &str,
    bytes: &[u8],
) -> std::result::Result<String, String> {
    read_module_zip(
        path,
        version,
        bytes,
        GoOptions::default().max_files_per_module,
    )
    .map(|t| t.hash)
}

/// Reads a module zip, applying the checks `golang.org/x/mod/zip` applies
/// before it extracts one (prefix, clean and portable paths, case-folded
/// collisions, go.mod placement, sizes), and computes its `h1:` hash.
fn read_module_zip(
    path: &str,
    version: &str,
    bytes: &[u8],
    max_files: usize,
) -> std::result::Result<ModuleTree, String> {
    if bytes.len() as u64 > MAX_ZIP_FILE {
        return Err(format!(
            "module zip is {} bytes; Go's limit is {MAX_ZIP_FILE}",
            bytes.len()
        ));
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("unreadable zip: {e}"))?;
    if archive.len() > max_files {
        return Err(format!(
            "module zip has {} entries; the limit is {max_files}",
            archive.len()
        ));
    }

    let mut entries: Vec<(String, Vec<u8>)> = Vec::with_capacity(archive.len());
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("unreadable zip entry {index}: {e}"))?;
        // The raw bytes, as Go's archive/zip reads them, rather than the zip
        // crate's code-page decoding of names without the UTF-8 flag: the
        // hash covers the name exactly as stored.
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| format!("zip entry {index} has a name that is not UTF-8"))?
            .to_string();
        let declared = entry.size();
        total = total.saturating_add(declared);
        if total > MAX_ZIP_FILE {
            return Err(format!(
                "total uncompressed size is over Go's {MAX_ZIP_FILE} byte limit"
            ));
        }
        // Never trust the declared size for the allocation, and stop one
        // byte past it so a lying header cannot inflate without bound.
        let mut content = Vec::with_capacity(declared.min(1 << 20) as usize);
        (&mut entry)
            .take(declared.saturating_add(1))
            .read_to_end(&mut content)
            .map_err(|e| format!("{name}: {e}"))?;
        if content.len() as u64 > declared {
            return Err(format!("{name}: larger than its declared size"));
        }
        entries.push((name, content));
    }

    let hash = hash1(entries.iter().map(|(n, b)| (n.as_str(), b.as_slice())))
        .ok_or("a file name contains a newline")?;

    let prefix = format!("{path}@{version}/");
    let mut collisions = Collisions::default();
    let mut files = Vec::new();
    let mut go_mod = None;
    for (name, content) in entries {
        let relative = name
            .strip_prefix(&prefix)
            .ok_or_else(|| format!("{name}: path does not have prefix {prefix:?}"))?;
        if relative.is_empty() {
            continue;
        }
        let (relative, is_dir) = match relative.strip_suffix('/') {
            Some(dir) => (dir, true),
            None => (relative, false),
        };
        check_file_path(relative).map_err(|m| format!("{name}: {m}"))?;
        collisions.check(relative, is_dir)?;
        if is_dir {
            // Empty directories may appear in a module zip but are not
            // extracted.
            continue;
        }
        let base = relative.rsplit('/').next().unwrap_or(relative);
        if base.eq_ignore_ascii_case("go.mod") {
            if base != relative {
                return Err(format!("{name}: go.mod file not in module root directory"));
            }
            if relative != "go.mod" {
                return Err(format!("{name}: go.mod files must have lowercase names"));
            }
        }
        let size = content.len() as u64;
        if relative == "go.mod" {
            if size > MAX_GO_MOD {
                return Err(format!(
                    "go.mod is larger than Go's {MAX_GO_MOD} byte limit"
                ));
            }
            go_mod = Some(content.clone());
        }
        if relative == "LICENSE" && size > MAX_LICENSE {
            return Err(format!(
                "LICENSE is larger than Go's {MAX_LICENSE} byte limit"
            ));
        }
        files.push((relative.to_string(), content));
    }
    Ok(ModuleTree {
        hash,
        go_mod,
        files,
    })
}

/// Go's collision checker: no two entries may be equal under case folding,
/// and nothing may be both a file and a directory. Lowercasing stands in for
/// Unicode simple folding, which differs only for a handful of characters
/// Go's file name rules almost never let through.
#[derive(Default)]
struct Collisions(HashMap<String, (String, bool)>);

impl Collisions {
    fn check(&mut self, path: &str, is_dir: bool) -> std::result::Result<(), String> {
        let mut path = path;
        let mut is_dir = is_dir;
        loop {
            let folded = path.to_lowercase();
            match self.0.get(&folded) {
                Some((other, other_is_dir)) => {
                    if other != path {
                        return Err(format!(
                            "case-insensitive file name collision: {other:?} and {path:?}"
                        ));
                    }
                    if *other_is_dir != is_dir {
                        return Err(format!("entry {path:?} is both a file and a directory"));
                    }
                    if !is_dir {
                        return Err(format!("multiple entries for file {path:?}"));
                    }
                }
                None => {
                    self.0.insert(folded, (path.to_string(), is_dir));
                }
            }
            match path.rfind('/') {
                Some(slash) => {
                    path = &path[..slash];
                    is_dir = true;
                }
                None => return Ok(()),
            }
        }
    }
}

/// Go's `module.CheckFilePath`, plus the `path.Clean` check its zip reader
/// makes first. This is what keeps `..`, absolute paths and backslashes out
/// of the extracted tree; `join_under` then refuses anything left over.
fn check_file_path(path: &str) -> std::result::Result<(), String> {
    if path.is_empty() || path.starts_with('/') || path.ends_with('/') || path.contains("//") {
        return Err("file path is not clean".to_string());
    }
    for element in path.split('/') {
        if element.chars().all(|c| c == '.') {
            return Err(format!("invalid path element {element:?}"));
        }
        if element.ends_with('.') {
            return Err(format!("trailing dot in path element {element:?}"));
        }
        for c in element.chars() {
            let ok = if c.is_ascii() {
                c.is_ascii_alphanumeric() || " !#$%&()+,-.=@[]^_{}~".contains(c)
            } else {
                c.is_alphabetic()
            };
            if !ok {
                return Err(format!("invalid char {c:?} in path element {element:?}"));
            }
        }
        let short = element.split('.').next().unwrap_or(element);
        if is_windows_reserved(short) {
            return Err(format!("{element:?} is a reserved file name on Windows"));
        }
        // Windows short names (`PROGRA~1`) are refused too, as Go does.
        if let Some(tilde) = short.rfind('~') {
            let suffix = &short[tilde + 1..];
            if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
                return Err(format!("{element:?} looks like a Windows short name"));
            }
        }
    }
    Ok(())
}

fn is_windows_reserved(short: &str) -> bool {
    const NAMES: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    if NAMES.iter().any(|n| n.eq_ignore_ascii_case(short)) {
        return true;
    }
    let bytes = short.as_bytes();
    bytes.len() == 4
        && (short[..3].eq_ignore_ascii_case("COM") || short[..3].eq_ignore_ascii_case("LPT"))
        && (b'1'..=b'9').contains(&bytes[3])
}

/// A module path as Go's `module.CheckPath` accepts it, in the parts that
/// matter here: slash-separated elements of ASCII letters, digits and
/// `-._~`, none empty and none starting or ending with a dot. That excludes
/// `!` (so case-encoding is unambiguous), `..`, and anything that would need
/// escaping in a URL.
fn is_module_path(path: &str) -> bool {
    !path.is_empty()
        && path.split('/').all(|element| {
            !element.is_empty()
                && !element.starts_with('.')
                && !element.ends_with('.')
                && element
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        })
}

/// A module version: `v` then semver characters. Strict enough to be safe
/// in a URL and a file name; the proxy rejects anything not canonical.
fn is_version(version: &str) -> bool {
    version.len() > 1
        && version.starts_with('v')
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-.+".contains(&b))
}

/// Adds `text`'s pins to `pins`. Lines whose hash is not `h1:` are skipped,
/// as the go command skips hash algorithms it does not know.
fn parse_go_sum(text: &str, file: &str, pins: &mut BTreeMap<(String, String), Pin>) -> Result<()> {
    for (index, line) in text.lines().enumerate() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.is_empty() {
            continue;
        }
        let parse_error = |message: String| GoError::Parse {
            file: file.to_string(),
            line: index + 1,
            message,
        };
        let &[module, version, hash] = fields.as_slice() else {
            return Err(parse_error(format!("malformed go.sum line {line:?}")));
        };
        if !hash.starts_with("h1:") {
            continue;
        }
        let (version, go_mod_only) = match version.strip_suffix("/go.mod") {
            Some(version) => (version, true),
            None => (version, false),
        };
        if !is_module_path(module) {
            return Err(parse_error(format!(
                "{module:?} is not a valid module path"
            )));
        }
        if !is_version(version) {
            return Err(parse_error(format!("{version:?} is not a valid version")));
        }
        let pin = pins
            .entry((module.to_string(), version.to_string()))
            .or_default();
        let slot = if go_mod_only {
            &mut pin.go_mod
        } else {
            &mut pin.zip
        };
        match slot {
            Some(existing) if existing != hash => {
                return Err(GoError::ConflictingPins {
                    module: module.to_string(),
                    version: version.to_string(),
                    first: existing.clone(),
                    second: hash.to_string(),
                });
            }
            Some(_) => {}
            None => *slot = Some(hash.to_string()),
        }
    }
    Ok(())
}

/// The directories a `go.work` file `use`s, in both the single-line and
/// the block form.
fn parse_go_work_uses(text: &str, file: &str) -> Result<Vec<String>> {
    let mut uses = Vec::new();
    let mut block: Option<String> = None;
    for (index, raw) in text.lines().enumerate() {
        let line = match raw.find("//") {
            Some(comment) => &raw[..comment],
            None => raw,
        }
        .trim();
        if line.is_empty() {
            continue;
        }
        if let Some(directive) = &block {
            if line == ")" {
                block = None;
            } else if directive == "use" {
                uses.push(unquote(line));
            }
            continue;
        }
        let (directive, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
        let rest = rest.trim();
        if rest == "(" {
            block = Some(directive.to_string());
        } else if directive == "use" {
            if rest.is_empty() {
                return Err(GoError::Parse {
                    file: file.to_string(),
                    line: index + 1,
                    message: "use without a directory".to_string(),
                });
            }
            uses.push(unquote(rest));
        }
    }
    Ok(uses)
}

/// The path in a `go.mod`'s `module` directive.
fn module_directive(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.split("//").next().unwrap_or(line).trim();
        let rest = line.strip_prefix("module")?;
        rest.starts_with(char::is_whitespace)
            .then(|| unquote(rest.trim()))
    })
}

fn unquote(token: &str) -> String {
    let token = token.trim();
    for quote in ['"', '`'] {
        if let Some(inner) = token
            .strip_prefix(quote)
            .and_then(|t| t.strip_suffix(quote))
        {
            return inner.to_string();
        }
    }
    token.to_string()
}

/// `relative` resolved against `base` lexically, `..` included, as Go
/// resolves a `use ../shared` line. It cannot climb above `/`.
pub(crate) fn lexical_join(base: &Path, relative: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::RootDir => out = PathBuf::from("/"),
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

fn read_text(builder: &SnapshotBuilder, path: &Path) -> Result<String> {
    String::from_utf8(builder.read(path)?).map_err(|_| GoError::Parse {
        file: path.display().to_string(),
        line: 0,
        message: "not UTF-8".to_string(),
    })
}

/// Runs `work` over `items` on up to `threads` threads and hands each result
/// to `sink` on the calling thread, in completion order. Downloads dominate
/// an install, and the fetcher is `Sync`, so they overlap; writes stay on one
/// thread. The channel holds at most `threads` results, which bounds how
/// many prepared (fully decompressed) packages wait in memory. The first
/// error stops the workers and is returned.
pub(crate) fn parallel<T, R, E>(
    items: &[T],
    threads: usize,
    work: impl Fn(&T) -> std::result::Result<R, E> + Sync,
    mut sink: impl FnMut(R) -> std::result::Result<(), E>,
) -> std::result::Result<(), E>
where
    T: Sync,
    R: Send,
    E: Send,
{
    if items.is_empty() {
        return Ok(());
    }
    let threads = threads.clamp(1, items.len());
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (tx, rx) = std::sync::mpsc::sync_channel(threads);
        for _ in 0..threads {
            let tx = tx.clone();
            let (next, stop, work) = (&next, &stop, &work);
            scope.spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let Some(item) = items.get(next.fetch_add(1, Ordering::Relaxed)) else {
                        break;
                    };
                    let result = work(item);
                    let failed = result.is_err();
                    if tx.send(result).is_err() || failed {
                        break;
                    }
                }
            });
        }
        drop(tx);
        // Breaking out drops the receiver, which fails any worker blocked
        // on a full channel, so the scope's join cannot hang.
        let mut outcome = Ok(());
        for result in rx {
            if let Err(error) = result.and_then(&mut sink) {
                stop.store(true, Ordering::Relaxed);
                outcome = Err(error);
                break;
            }
        }
        outcome
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use super::*;
    use crate::fetch::{MemoryFetcher, verify};

    /// A fetcher over `curl`, for the `#[ignore]`d tests that talk to the
    /// real proxy and registry. Only those tests use it.
    pub(crate) struct CurlFetcher;

    impl Fetcher for CurlFetcher {
        fn fetch(
            &self,
            url: &str,
            integrity: &Integrity,
        ) -> std::result::Result<Arc<[u8]>, FetchError> {
            let output = std::process::Command::new("curl")
                .args(["-fsSL", url])
                .output()
                .map_err(|e| FetchError::Http {
                    url: url.to_string(),
                    message: e.to_string(),
                })?;
            if !output.status.success() {
                return Err(FetchError::Http {
                    url: url.to_string(),
                    message: String::from_utf8_lossy(&output.stderr).into_owned(),
                });
            }
            verify(url, &output.stdout, integrity)?;
            Ok(output.stdout.into())
        }
    }

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// The module behind the known-answer hashes below.
    const KAT_MODULE: &str = "example.com/Hello/World";
    const KAT_VERSION: &str = "v1.2.3";
    const KAT_GO_MOD: &[u8] = b"module example.com/Hello/World\n\ngo 1.21\n";
    const KAT_FILES: [(&str, &[u8]); 4] = [
        ("go.mod", KAT_GO_MOD),
        ("hello.go", b"package world\n\nconst Greeting = \"hi\"\n"),
        ("sub/data.txt", b"some data\n"),
        ("LICENSE", b"MIT\n"),
    ];
    /// Computed by the real go command (go1.24.4): these four files zipped
    /// under `example.com/Hello/World@v1.2.3/` were served from a `file://`
    /// GOPROXY, and `go mod download -json example.com/Hello/World@v1.2.3`
    /// reported them as `Sum` and `GoModSum`. The hash covers names and
    /// contents only, so rebuilding the zip here (with a different
    /// compressor and entry order) must reproduce it exactly.
    const KAT_SUM: &str = "h1:8SJP183uYQVf1z3BFHNBYRD4k3FmAtYzaRfIBdvfic8=";
    const KAT_GO_MOD_SUM: &str = "h1:qyJFkeKVGuVxj/MQGrr7cCxR661GcGtyylOWm7PAY0k=";

    fn kat_zip() -> Vec<u8> {
        let names: Vec<String> = KAT_FILES
            .iter()
            .rev()
            .map(|(name, _)| format!("{KAT_MODULE}@{KAT_VERSION}/{name}"))
            .collect();
        let entries: Vec<(&str, &[u8])> = names
            .iter()
            .zip(KAT_FILES.iter().rev())
            .map(|(name, (_, bytes))| (name.as_str(), *bytes))
            .collect();
        zip_of(&entries)
    }

    const KAT_BASE: &str = "https://proxy.golang.org/example.com/!hello/!world/@v/v1.2.3";
    const DEP_BASE: &str = "https://proxy.golang.org/github.com/!some/!dep/@v/v0.1.0";
    const DEP_GO_MOD: &[u8] = b"module github.com/Some/Dep\n\ngo 1.20\n";

    fn kat_fetcher(zip: Vec<u8>) -> MemoryFetcher {
        let fetcher = MemoryFetcher::new();
        fetcher.insert(format!("{KAT_BASE}.zip"), zip);
        fetcher.insert(format!("{KAT_BASE}.mod"), KAT_GO_MOD);
        fetcher.insert(
            format!("{KAT_BASE}.info"),
            br#"{"Version":"v1.2.3","Time":"2024-01-01T00:00:00Z"}"#.to_vec(),
        );
        fetcher.insert(format!("{DEP_BASE}.mod"), DEP_GO_MOD);
        fetcher
    }

    fn workspace(go_sum: &str) -> SnapshotBuilder {
        let builder = SnapshotBuilder::new();
        builder
            .write(
                "/app/go.mod",
                b"module example.com/app\n\ngo 1.21\n\nrequire example.com/Hello/World v1.2.3\n",
            )
            .unwrap();
        builder.write("/app/go.sum", go_sum.as_bytes()).unwrap();
        builder
    }

    fn kat_go_sum() -> String {
        format!(
            "{KAT_MODULE} {KAT_VERSION} {KAT_SUM}\n\
             {KAT_MODULE} {KAT_VERSION}/go.mod {KAT_GO_MOD_SUM}\n\
             github.com/Some/Dep v0.1.0/go.mod {}\n",
            hash_go_mod(DEP_GO_MOD)
        )
    }

    #[test]
    fn hash1_matches_the_go_command() {
        let names: Vec<String> = KAT_FILES
            .iter()
            .map(|(name, _)| format!("{KAT_MODULE}@{KAT_VERSION}/{name}"))
            .collect();
        let files = names
            .iter()
            .zip(KAT_FILES.iter())
            .map(|(name, (_, bytes))| (name.as_str(), *bytes));
        assert_eq!(hash1(files).unwrap(), KAT_SUM);
        assert_eq!(hash_go_mod(KAT_GO_MOD), KAT_GO_MOD_SUM);
        let tree = read_module_zip(KAT_MODULE, KAT_VERSION, &kat_zip(), 100).unwrap();
        assert_eq!(tree.hash, KAT_SUM);
    }

    #[test]
    fn hash_go_mod_matches_a_real_go_sum_line() {
        // github.com/fatih/color v1.18.0's go.mod as proxy.golang.org serves
        // it, against the line terraform-provider-infrawrench/go.sum carries
        // for it: `github.com/fatih/color v1.18.0/go.mod h1:4FelSp...`.
        let go_mod = b"module github.com/fatih/color\n\ngo 1.17\n\nrequire (\n\tgithub.com/mattn/go-colorable v0.1.13\n\tgithub.com/mattn/go-isatty v0.0.20\n)\n\nrequire golang.org/x/sys v0.25.0\n";
        assert_eq!(
            hash_go_mod(go_mod),
            "h1:4FelSpRwEGDpQ12mAdzqdOukCy4u8WUtOY6lkT/6HfU="
        );
    }

    #[test]
    fn escaping_follows_the_proxy_protocol() {
        assert_eq!(
            escape_path("github.com/BurntSushi/toml").unwrap(),
            "github.com/!burnt!sushi/toml"
        );
        assert_eq!(escape_version("v1.0.0-RC1").unwrap(), "v1.0.0-!r!c1");
        assert_eq!(
            escape_version("v2.0.0+incompatible").unwrap(),
            "v2.0.0+incompatible"
        );
        for bad in [
            "",
            "a//b",
            "a/../b",
            "x!y",
            "/abs",
            "a/.hidden",
            "a?b",
            "a/b/",
        ] {
            assert!(escape_path(bad).is_err(), "{bad:?}");
        }
        for bad in ["", "v", "1.0.0", "v1/../x", "v1?x"] {
            assert!(escape_version(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn installs_a_module_cache() {
        let builder = workspace(&kat_go_sum());
        let fetcher = kat_fetcher(kat_zip());
        let report = install(&builder, "/app", &fetcher, &GoOptions::default()).unwrap();

        assert_eq!(report.main_modules, ["example.com/app"]);
        assert_eq!(report.sum_files, ["/app/go.sum"]);
        assert_eq!(
            report.modules,
            [
                GoModule {
                    path: KAT_MODULE.into(),
                    version: KAT_VERSION.into(),
                    kind: PinKind::Source
                },
                GoModule {
                    path: "github.com/Some/Dep".into(),
                    version: "v0.1.0".into(),
                    kind: PinKind::GoModOnly
                },
            ]
        );

        let cache = "/root/go/pkg/mod";
        let dl = format!("{cache}/cache/download/example.com/!hello/!world/@v");
        assert_eq!(
            builder.read(format!("{dl}/v1.2.3.mod")).unwrap(),
            KAT_GO_MOD
        );
        assert_eq!(
            builder.read(format!("{dl}/v1.2.3.ziphash")).unwrap(),
            KAT_SUM.as_bytes()
        );
        assert_eq!(builder.read(format!("{dl}/v1.2.3.zip")).unwrap(), kat_zip());
        assert!(builder.is_file(format!("{dl}/v1.2.3.info")));
        let tree = format!("{cache}/example.com/!hello/!world@v1.2.3");
        for (name, bytes) in KAT_FILES {
            assert_eq!(builder.read(format!("{tree}/{name}")).unwrap(), bytes);
        }

        // The go.mod-only pin gets its .mod and nothing else.
        let dep = format!("{cache}/cache/download/github.com/!some/!dep/@v");
        assert_eq!(
            builder.read(format!("{dep}/v0.1.0.mod")).unwrap(),
            DEP_GO_MOD
        );
        assert!(!builder.is_file(format!("{dep}/v0.1.0.zip")));
        assert!(!builder.is_dir(format!("{cache}/github.com/!some/!dep@v0.1.0")));
        let mut requests = fetcher.requests();
        requests.sort();
        assert_eq!(
            requests,
            [
                format!("{KAT_BASE}.info"),
                format!("{KAT_BASE}.mod"),
                format!("{KAT_BASE}.zip"),
                format!("{DEP_BASE}.mod"),
            ]
        );

        let env: HashMap<_, _> = report.env.into_iter().collect();
        assert_eq!(env["GOMODCACHE"], cache);
        assert_eq!(env["GOPATH"], "/root/go");
        assert_eq!(env["GOPROXY"], "off");
        assert_eq!(env["GOFLAGS"], "-mod=readonly");
        assert_eq!(env["GOTOOLCHAIN"], "local");
    }

    #[test]
    fn a_tampered_zip_fails_before_anything_is_written() {
        let builder = workspace(&kat_go_sum());
        let mut files = KAT_FILES.to_vec();
        files[1].1 = &b"package world\n\nconst Greeting = \"pwned\"\n"[..];
        let names: Vec<String> = files
            .iter()
            .map(|(n, _)| format!("{KAT_MODULE}@{KAT_VERSION}/{n}"))
            .collect();
        let entries: Vec<(&str, &[u8])> = names
            .iter()
            .zip(&files)
            .map(|(n, (_, b))| (n.as_str(), *b))
            .collect();
        let fetcher = kat_fetcher(zip_of(&entries));
        let options = GoOptions {
            parallelism: 1,
            ..GoOptions::default()
        };
        let error = install(&builder, "/app", &fetcher, &options).unwrap_err();
        // The fetcher checks the zip against go.sum before handing it over.
        assert!(
            matches!(&error, GoError::Fetch(crate::fetch::FetchError::IntegrityMismatch { url, expected })
                if url.ends_with("v1.2.3.zip") && expected == KAT_SUM),
            "{error}"
        );
        assert!(!builder.is_dir("/root/go/pkg/mod/example.com"));
        assert!(
            !builder
                .is_file("/root/go/pkg/mod/cache/download/example.com/!hello/!world/@v/v1.2.3.zip")
        );
    }

    #[test]
    fn a_tampered_go_mod_fails() {
        let builder = workspace(&kat_go_sum());
        let fetcher = kat_fetcher(kat_zip());
        fetcher.insert(
            format!("{DEP_BASE}.mod"),
            b"module github.com/Some/Dep\n".to_vec(),
        );
        let error = install(&builder, "/app", &fetcher, &GoOptions::default()).unwrap_err();
        assert!(
            matches!(&error, GoError::Fetch(crate::fetch::FetchError::IntegrityMismatch { url, .. })
                if url == &format!("{DEP_BASE}.mod")),
            "{error}"
        );
    }

    fn zip_error(entries: &[(&str, &[u8])]) -> String {
        match read_module_zip("example.com/m", "v1.0.0", &zip_of(entries), 100) {
            Err(message) => message,
            Ok(_) => panic!(
                "accepted {:?}",
                entries.iter().map(|e| e.0).collect::<Vec<_>>()
            ),
        }
    }

    #[test]
    fn zip_entries_that_escape_or_break_go_rules_are_refused() {
        let p = "example.com/m@v1.0.0";
        assert!(zip_error(&[(&format!("{p}/../../etc/passwd"), b"x")]).contains("invalid path"));
        assert!(zip_error(&[(&format!("{p}/a/../../x"), b"x")]).contains("invalid path"));
        assert!(zip_error(&[(&format!("{p}//abs"), b"x")]).contains("not clean"));
        assert!(zip_error(&[("example.com/other@v1.0.0/x.go", b"x")]).contains("prefix"));
        assert!(zip_error(&[("/etc/passwd", b"x")]).contains("prefix"));
        assert!(zip_error(&[(&format!("{p}/a\\b"), b"x")]).contains("invalid char"));
        assert!(
            zip_error(&[
                (&format!("{p}/README"), b"x"),
                (&format!("{p}/readme"), b"y")
            ])
            .contains("collision")
        );
        assert!(
            zip_error(&[(&format!("{p}/a"), b"x"), (&format!("{p}/a/b"), b"y")])
                .contains("both a file and a directory")
        );
        assert!(zip_error(&[(&format!("{p}/sub/go.mod"), b"module x\n")]).contains("module root"));
        assert!(zip_error(&[(&format!("{p}/GO.MOD"), b"module x\n")]).contains("lowercase"));
        assert!(zip_error(&[(&format!("{p}/nul.txt"), b"x")]).contains("reserved"));

        let error = read_module_zip(
            "example.com/m",
            "v1.0.0",
            &zip_of(&[(&format!("{p}/a"), b"1"), (&format!("{p}/b"), b"2")]),
            1,
        )
        .err()
        .unwrap();
        assert!(error.contains("limit"), "{error}");

        // Directory entries are allowed and hashed but not extracted.
        let tree = read_module_zip(
            "example.com/m",
            "v1.0.0",
            &zip_of(&[
                (&format!("{p}/dir/"), b""),
                (&format!("{p}/dir/x.go"), b"x"),
            ]),
            100,
        )
        .unwrap();
        assert_eq!(tree.files, [("dir/x.go".to_string(), b"x".to_vec())]);
    }

    #[test]
    fn go_work_covers_every_used_module() {
        let builder = SnapshotBuilder::new();
        builder
            .write(
                "/app/go.work",
                b"go 1.22\n\nuse (\n\t./svc // the service\n\t\"./lib\"\n)\nuse ./tools\n",
            )
            .unwrap();
        let dep_sum = hash_go_mod(DEP_GO_MOD);
        for (dir, module) in [
            ("svc", "a.example/svc"),
            ("lib", "a.example/lib"),
            ("tools", "a.example/tools"),
        ] {
            builder
                .write(
                    format!("/app/{dir}/go.mod"),
                    format!("module {module}\n").as_bytes(),
                )
                .unwrap();
        }
        builder
            .write(
                "/app/svc/go.sum",
                format!("{KAT_MODULE} {KAT_VERSION}/go.mod {KAT_GO_MOD_SUM}\n").as_bytes(),
            )
            .unwrap();
        builder
            .write(
                "/app/go.work.sum",
                format!("github.com/Some/Dep v0.1.0/go.mod {dep_sum}\n").as_bytes(),
            )
            .unwrap();
        let fetcher = kat_fetcher(kat_zip());
        let report = install(&builder, "/app", &fetcher, &GoOptions::default()).unwrap();
        assert_eq!(
            report.main_modules,
            ["a.example/lib", "a.example/svc", "a.example/tools"]
        );
        assert_eq!(report.sum_files, ["/app/go.work.sum", "/app/svc/go.sum"]);
        assert_eq!(report.modules.len(), 2);
        assert!(report.modules.iter().all(|m| m.kind == PinKind::GoModOnly));

        builder.write("/app/go.work", b"use ./missing\n").unwrap();
        assert!(matches!(
            install(&builder, "/app", &fetcher, &GoOptions::default()),
            Err(GoError::MissingModule { .. })
        ));
    }

    #[test]
    fn toolchains_are_skipped_and_conflicts_refused() {
        let builder = workspace(
            "golang.org/toolchain v0.0.1-go1.22.0.linux-amd64 h1:AAAA\n\
             golang.org/toolchain v0.0.1-go1.22.0.linux-amd64/go.mod h1:BBBB\n",
        );
        let report = install(
            &builder,
            "/app",
            &MemoryFetcher::new(),
            &GoOptions::default(),
        )
        .unwrap();
        assert!(report.modules.is_empty());
        assert_eq!(report.skipped.len(), 1);

        let mut pins = BTreeMap::new();
        parse_go_sum("a.example/x v1.0.0 h1:one\n", "a", &mut pins).unwrap();
        let error = parse_go_sum("a.example/x v1.0.0 h1:two\n", "b", &mut pins).unwrap_err();
        assert!(matches!(error, GoError::ConflictingPins { .. }));
        assert!(matches!(
            parse_go_sum("a.example/x v1.0.0\n", "c", &mut pins),
            Err(GoError::Parse { line: 1, .. })
        ));
        assert!(matches!(
            install(
                &SnapshotBuilder::new(),
                "/app",
                &MemoryFetcher::new(),
                &GoOptions::default()
            ),
            Err(GoError::NotAModule(_))
        ));
    }

    #[test]
    fn a_zip_pin_without_a_go_mod_pin_checks_the_mod_against_the_zip() {
        let builder = workspace(&format!("{KAT_MODULE} {KAT_VERSION} {KAT_SUM}\n"));
        let fetcher = kat_fetcher(kat_zip());
        install(&builder, "/app", &fetcher, &GoOptions::default()).unwrap();
        let fetcher = kat_fetcher(kat_zip());
        fetcher.insert(format!("{KAT_BASE}.mod"), b"module evil\n".to_vec());
        let builder = workspace(&format!("{KAT_MODULE} {KAT_VERSION} {KAT_SUM}\n"));
        let error = install(&builder, "/app", &fetcher, &GoOptions::default()).unwrap_err();
        assert!(
            error.to_string().contains("does not match the go.mod"),
            "{error}"
        );
    }

    #[test]
    fn parses_the_terraform_providers_go_sum() {
        let root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../terraform-provider-infrawrench");
        let (Ok(go_mod), Ok(go_sum)) = (
            std::fs::read_to_string(root.join("go.mod")),
            std::fs::read_to_string(root.join("go.sum")),
        ) else {
            eprintln!("skipping: terraform-provider-infrawrench not present");
            return;
        };
        assert_eq!(
            module_directive(&go_mod).as_deref(),
            Some("github.com/Infrawrench/terraform-provider-infrawrench")
        );
        let mut pins = BTreeMap::new();
        parse_go_sum(&go_sum, "go.sum", &mut pins).unwrap();
        let lines = go_sum.lines().filter(|l| !l.trim().is_empty()).count();
        let with_zip = pins.values().filter(|p| p.zip.is_some()).count();
        let with_mod = pins.values().filter(|p| p.go_mod.is_some()).count();
        assert_eq!(with_zip + with_mod, lines);
        assert!(with_zip > 0 && with_mod >= with_zip);
        for (path, version) in pins.keys() {
            escape_path(path).unwrap();
            escape_version(version).unwrap();
        }
        assert!(pins.contains_key(&("github.com/BurntSushi/toml".into(), "v1.2.1".into())));
    }

    #[test]
    fn parallel_stops_at_the_first_error() {
        let items: Vec<u32> = (0..100).collect();
        let mut seen = 0;
        let result: std::result::Result<(), String> = parallel(
            &items,
            4,
            |&i| {
                if i == 10 {
                    Err(format!("item {i}"))
                } else {
                    Ok(i)
                }
            },
            |_| {
                seen += 1;
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "item 10");
        assert!(seen < 100);
    }

    /// Downloads one real module from proxy.golang.org and checks it against
    /// the terraform provider's go.sum lines for it.
    #[test]
    #[ignore = "downloads from proxy.golang.org"]
    fn real_proxy_download() {
        let builder = workspace(
            "github.com/BurntSushi/toml v1.2.1 h1:9F2/+DoOYIOksmaJFPw1tGFy1eDnIJXg+UHjuD8lTak=\n\
             github.com/BurntSushi/toml v1.2.1/go.mod h1:CxXYINrC8qIiEnFrOxCa7Jy5BFHlXnUU2pbicEuybxQ=\n",
        );
        let report = install(&builder, "/app", &CurlFetcher, &GoOptions::default()).unwrap();
        assert_eq!(report.modules.len(), 1);
        assert!(builder.is_file("/root/go/pkg/mod/github.com/!burnt!sushi/toml@v1.2.1/go.mod"));
    }

    /// Installs a whole real module's dependencies and, when
    /// `IWCI_EXPORT_DIR` is set, copies the snapshot there so the result can
    /// be checked with a real `GOPROXY=off go build`.
    #[test]
    #[ignore = "downloads from proxy.golang.org"]
    fn real_module_install() {
        let source = std::env::var("IWCI_GO_MODULE").unwrap_or_else(|_| {
            format!(
                "{}/../../../terraform-provider-infrawrench",
                env!("CARGO_MANIFEST_DIR")
            )
        });
        let builder = SnapshotBuilder::new();
        for name in ["go.mod", "go.sum"] {
            let bytes = std::fs::read(Path::new(&source).join(name)).unwrap();
            builder.write(format!("/app/{name}"), &bytes).unwrap();
        }
        let report = install(&builder, "/app", &CurlFetcher, &GoOptions::default()).unwrap();
        eprintln!(
            "{} modules, {} bytes, skipped {:?}",
            report.modules.len(),
            report.bytes_written,
            report.skipped
        );
        if let Ok(out) = std::env::var("IWCI_EXPORT_DIR") {
            export(&builder, Path::new(&out));
        }
    }

    pub(crate) fn export(builder: &SnapshotBuilder, out: &Path) {
        for path in iwci_vfs::list_files(builder.fs(), "/") {
            let target = out.join(path.strip_prefix("/").unwrap());
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, builder.read(&path).unwrap()).unwrap();
        }
    }
}
