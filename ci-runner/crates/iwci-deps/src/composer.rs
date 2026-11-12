//! Composer: installs what `composer.lock` pins into `vendor/` as
//! `composer install` lays it out, without running Composer.
//!
//! ```text
//! <dir>/vendor/<vendor>/<package>/   each package's files
//! <dir>/vendor/bin/<name>            Composer's proxy for each package's `bin`
//! <dir>/vendor/composer/             installed.json, installed.php,
//!                                    InstalledVersions.php, ClassLoader.php
//!                                    and the autoloader ([`dump_autoload`])
//! <dir>/vendor/autoload.php
//! ```
//!
//! **How each package is verified.** Composer's lock records a SHA-1 of a
//! package's dist archive only when the repository serving it provides one,
//! and Packagist does not for the GitHub archives nearly every package is
//! published as (`dist.shasum` is `""`). It always records the commit the
//! package was released from (`source.reference`), so:
//!
//! - a dist with a `shasum` is downloaded and checked against it;
//! - otherwise the package's git commit is fetched from its `source.url`
//!   and checked by git's object ids, which pin every byte of the tree
//!   ([`GitTrees`]). The files are laid out as the dist archive would have
//!   them: `git archive`, and so a GitHub zipball, leaves out what the
//!   tree's `.gitattributes` mark `export-ignore`, and so does this;
//! - a `path` package (a directory of the repository) is linked, as
//!   Composer links it;
//! - anything else is refused.
//!
//! Plugins and scripts never run, as with `--no-plugins --no-scripts`.
//! Dev packages are installed, as `composer install` does by default.
//!
//! The autoloader depends on the repository's own files (a root `classmap`
//! is a scan of them), so it is not part of the cached install: the caller
//! runs [`dump_autoload`] on every workspace build, after the install.

mod autoload;
mod classmap;
mod gitattributes;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use iwci_vfs::{SnapshotBuilder, VfsError, join_under, normalise};
use serde_json::{Map, Value};

use crate::archive::{check_path, common_root, read_zip};
use crate::fetch::{FetchError, Fetcher, Integrity};
use crate::go::parallel;

pub use autoload::{AutoloadReport, dump_autoload};
use gitattributes::ExportIgnore;

/// One file of a git tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeFile {
    /// Relative and `/`-separated.
    pub path: String,
    pub data: Vec<u8>,
    pub executable: bool,
}

/// Fetches one commit of a git repository: how a package with no dist
/// hash is verified, since the commit id pins every byte of its tree.
pub trait GitTrees: Send + Sync {
    /// Every file of `commit`'s tree in the repository at `url`.
    fn files(&self, url: &str, commit: &str) -> std::result::Result<Vec<TreeFile>, String>;
}

/// A [`GitTrees`] that has nothing: every package must carry a dist hash.
pub struct NoGit;

impl GitTrees for NoGit {
    fn files(&self, url: &str, _commit: &str) -> std::result::Result<Vec<TreeFile>, String> {
        Err(format!(
            "{url}: fetching git repositories is not set up here"
        ))
    }
}

#[derive(Debug, Clone)]
pub struct ComposerOptions {
    /// Packages fetched at once.
    pub parallelism: usize,
    /// One dist download.
    pub max_dist_bytes: u64,
    /// One package, unpacked.
    pub max_unpacked_bytes: u64,
    pub max_files_per_package: usize,
    /// Everything written into the snapshot, which lives in memory.
    pub max_total_bytes: u64,
}

impl Default for ComposerOptions {
    fn default() -> Self {
        Self {
            parallelism: 8,
            max_dist_bytes: 256 << 20,
            max_unpacked_bytes: 1 << 30,
            max_files_per_package: 100_000,
            max_total_bytes: 4 << 30,
        }
    }
}

/// How a package's bytes were checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verified {
    /// Its dist archive, against the lock's `dist.shasum`.
    DistSha1,
    /// Its git commit, by the commit id in `source.reference`.
    GitCommit,
    /// A directory of the repository itself, linked.
    Path,
    /// A metapackage: nothing to install.
    Nothing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledPackage {
    pub name: String,
    pub version: String,
    pub verified: Verified,
}

#[derive(Debug, Clone, Default)]
pub struct ComposerReport {
    pub installed: Vec<InstalledPackage>,
    pub warnings: Vec<String>,
    pub bytes_written: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ComposerError {
    #[error(transparent)]
    Vfs(#[from] VfsError),
    #[error(transparent)]
    Fetch(#[from] FetchError),
    #[error("{0}: no composer.lock")]
    NoLockfile(String),
    #[error("{file}: {message}")]
    Lockfile { file: String, message: String },
    #[error("{name}: {message}")]
    Package { name: String, message: String },
    #[error("{what} is over the {limit} byte limit")]
    TooLarge { what: String, limit: u64 },
}

pub type Result<T> = std::result::Result<T, ComposerError>;

/// Where packages go, from the root `composer.json`'s `config`.
#[derive(Debug, Clone)]
pub(crate) struct Dirs {
    pub base: PathBuf,
    pub vendor: PathBuf,
    pub bin: PathBuf,
}

impl Dirs {
    pub(crate) fn read(base: &Path, root: &Value) -> Result<Dirs> {
        let config = root.get("config");
        let setting = |key: &str| config.and_then(|c| c.get(key)).and_then(Value::as_str);
        let bad = |key: &str, value: &str| ComposerError::Lockfile {
            file: base.join("composer.json").display().to_string(),
            message: format!("config.{key} {value:?} is not a directory inside the repository"),
        };
        let vendor_setting = setting("vendor-dir").unwrap_or("vendor");
        let vendor =
            join_under(base, vendor_setting).map_err(|_| bad("vendor-dir", vendor_setting))?;
        let bin = match setting("bin-dir") {
            Some(dir) => {
                let dir_expanded = dir.replace("{$vendor-dir}", vendor_setting);
                join_under(base, &dir_expanded).map_err(|_| bad("bin-dir", dir))?
            }
            None => vendor.join("bin"),
        };
        if vendor == base {
            return Err(bad("vendor-dir", vendor_setting));
        }
        Ok(Dirs {
            base: base.to_path_buf(),
            vendor,
            bin,
        })
    }
}

/// A package of the lock.
#[derive(Debug, Clone)]
struct Package {
    name: String,
    version: String,
    dev: bool,
    plan: Plan,
    bins: Vec<String>,
    raw: Map<String, Value>,
}

#[derive(Debug, Clone)]
enum Plan {
    Dist { url: String, sha1: String },
    Git { url: String, commit: String },
    Path { target: PathBuf },
    Nothing,
}

/// Installs every package `<dir>/composer.lock` pins, dev packages
/// included. The autoloader is [`dump_autoload`]'s.
pub fn install(
    builder: &SnapshotBuilder,
    dir: &str,
    fetcher: &dyn Fetcher,
    git: &dyn GitTrees,
    options: &ComposerOptions,
) -> Result<ComposerReport> {
    let base = normalise(dir)?;
    let lock_path = base.join("composer.lock");
    if !builder.is_file(&lock_path) {
        return Err(ComposerError::NoLockfile(base.display().to_string()));
    }
    let file = lock_path.display().to_string();
    let lock_error = |message: String| ComposerError::Lockfile {
        file: file.clone(),
        message,
    };
    let lock: Value = serde_json::from_slice(&builder.read(&lock_path)?)
        .map_err(|e| lock_error(format!("not JSON: {e}")))?;
    let root = read_root(builder, &base)?;
    let dirs = Dirs::read(&base, &root)?;

    let mut packages = Vec::new();
    let mut names = BTreeSet::new();
    for (key, dev) in [("packages", false), ("packages-dev", true)] {
        let Some(list) = lock.get(key) else { continue };
        let list = list
            .as_array()
            .ok_or_else(|| lock_error(format!("`{key}` is not a list")))?;
        for raw in list {
            let package = parse_package(raw, dev, &base).map_err(lock_error)?;
            if !names.insert(package.name.clone()) {
                return Err(lock_error(format!("{} is locked twice", package.name)));
            }
            packages.push(package);
        }
    }

    let mut report = ComposerReport::default();
    let mut written = 0u64;
    let mut installed: Vec<(Package, Option<String>, BTreeSet<String>)> = Vec::new();
    parallel(
        &packages,
        options.parallelism,
        |package| prepare(package, fetcher, git, options),
        |(package, files): (Package, Vec<TreeFile>)| {
            let install_dir = join_under(&dirs.vendor, &package.name)?;
            let mut paths = BTreeSet::new();
            match &package.plan {
                Plan::Path { target } => {
                    let parent = install_dir.parent().unwrap_or(&dirs.vendor);
                    builder.mkdir_all(parent)?;
                    builder.symlink(&install_dir, relative_link(parent, target))?;
                }
                Plan::Nothing => {}
                _ => {
                    builder.mkdir_all(&install_dir)?;
                    for f in &files {
                        written += f.data.len() as u64;
                        if written > options.max_total_bytes {
                            return Err(ComposerError::TooLarge {
                                what: "the installed packages".to_string(),
                                limit: options.max_total_bytes,
                            });
                        }
                        let path = install_dir.join(&f.path);
                        builder.write(&path, &f.data)?;
                        if f.executable {
                            builder.set_mode(&path, 0o755)?;
                        }
                        paths.insert(f.path.clone());
                    }
                }
            }
            let install_path = match package.plan {
                Plan::Nothing => None,
                _ => Some(format!("../{}", package.name)),
            };
            report.installed.push(InstalledPackage {
                name: package.name.clone(),
                version: package.version.clone(),
                verified: match package.plan {
                    Plan::Dist { .. } => Verified::DistSha1,
                    Plan::Git { .. } => Verified::GitCommit,
                    Plan::Path { .. } => Verified::Path,
                    Plan::Nothing => Verified::Nothing,
                },
            });
            installed.push((package, install_path, paths));
            Ok(())
        },
    )?;
    report.bytes_written = written;
    installed.sort_by(|a, b| a.0.name.cmp(&b.0.name));
    report.installed.sort_by(|a, b| a.name.cmp(&b.name));

    // vendor/bin, as Composer's BinaryInstaller writes it.
    let mut bin_names = BTreeMap::new();
    for (package, install_path, paths) in &installed {
        if install_path.is_none() {
            continue;
        }
        for bin in &package.bins {
            let skip =
                |why: &str| format!("composer: {}: bin {bin:?} skipped: {why}", package.name);
            if check_path(bin).is_err() || bin.is_empty() || bin.contains(UNSAFE_PROXY_CHARS) {
                report
                    .warnings
                    .push(skip("not a plain path inside the package"));
                continue;
            }
            let target = dirs.vendor.join(&package.name).join(bin);
            let present = paths.contains(bin.as_str()) || builder.is_file(&target);
            if !present {
                report.warnings.push(skip("not in the package"));
                continue;
            }
            let name = bin.rsplit('/').next().unwrap_or(bin).to_string();
            if let Some(other) = bin_names.insert(name.clone(), package.name.clone()) {
                bin_names.insert(name, other.clone());
                report
                    .warnings
                    .push(skip(&format!("{other} already installed one by that name")));
                continue;
            }
            let link = dirs.bin.join(&name);
            let head = builder.read(&target)?;
            let proxy =
                autoload::bin_proxy(&link, &target, &dirs.vendor, &head[..head.len().min(500)]);
            builder.write(&link, proxy.as_bytes())?;
            // As Composer chmods them. The install cache does not keep
            // modes yet, which a job does not notice: WASIX runs a file
            // whatever its mode, and only `stat` shows one.
            builder.set_mode(&link, 0o755)?;
            builder.set_mode(&target, 0o755)?;
        }
    }

    // vendor/composer: what Composer itself reads back.
    let composer_dir = dirs.vendor.join("composer");
    let mut json_packages = Vec::new();
    let mut dev_names = Vec::new();
    for (package, install_path, _) in &installed {
        let mut entry = package.raw.clone();
        entry.insert(
            "installation-source".into(),
            // A package installed from its commit is laid out as its dist
            // would be, and has no `.git` for Composer to treat as a clone.
            match package.plan {
                Plan::Nothing => Value::Null,
                _ => "dist".into(),
            },
        );
        entry.insert(
            "install-path".into(),
            install_path.clone().map_or(Value::Null, Value::String),
        );
        if package.dev {
            dev_names.push(Value::String(package.name.clone()));
        }
        json_packages.push(Value::Object(entry));
    }
    let installed_json = serde_json::json!({
        "packages": json_packages,
        "dev": true,
        "dev-package-names": dev_names,
    });
    builder.write(
        composer_dir.join("installed.json"),
        (pretty_json(&installed_json) + "\n").as_bytes(),
    )?;
    let versions: Vec<(&Package, Option<&str>)> = installed
        .iter()
        .map(|(p, path, _)| (p, path.as_deref()))
        .collect();
    // From vendor/composer back to the repository, with a trailing `/`.
    let root_path = "../".repeat(
        composer_dir
            .strip_prefix(&dirs.base)
            .map_or(2, |r| r.components().count()),
    );
    builder.write(
        composer_dir.join("installed.php"),
        autoload::installed_php(&root, &root_path, &versions).as_bytes(),
    )?;
    builder.write(
        composer_dir.join("InstalledVersions.php"),
        include_bytes!("composer/php/InstalledVersions.php"),
    )?;
    builder.write(
        composer_dir.join("ClassLoader.php"),
        include_bytes!("composer/php/ClassLoader.php"),
    )?;
    builder.write(
        composer_dir.join("LICENSE"),
        include_bytes!("composer/php/LICENSE"),
    )?;
    Ok(report)
}

/// Characters Composer refuses in a bin path, since its proxies embed it.
const UNSAFE_PROXY_CHARS: &[char] = &[
    '*', '$', '`', '"', '&', '^', '|', '<', '>', '(', ')', '%', '!', ';', '\n', '\r', '\t',
];

/// The root `composer.json`, or an empty object when there is none.
fn read_root(builder: &SnapshotBuilder, base: &Path) -> Result<Value> {
    let path = base.join("composer.json");
    if !builder.is_file(&path) {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(&builder.read(&path)?).map_err(|e| ComposerError::Lockfile {
        file: path.display().to_string(),
        message: format!("not JSON: {e}"),
    })
}

/// Composer's rule for a package name.
fn valid_name(name: &str) -> bool {
    let Some((vendor, package)) = name.split_once('/') else {
        return false;
    };
    let part = |s: &str| {
        !s.is_empty()
            && s.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && s.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && s.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-')
            })
            && !s.contains("..")
    };
    part(vendor) && part(package)
}

fn is_commit(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_package(raw: &Value, dev: bool, base: &Path) -> std::result::Result<Package, String> {
    let object = raw.as_object().ok_or("a package that is not an object")?;
    let text = |key: &str| object.get(key).and_then(Value::as_str);
    let name = text("name").ok_or("a package without a name")?.to_string();
    if !valid_name(&name) {
        return Err(format!("{name:?} is not a package name"));
    }
    let version = text("version").unwrap_or("").to_string();
    let fail = |m: &str| format!("{name}: {m}");
    if object
        .get("target-dir")
        .and_then(Value::as_str)
        .is_some_and(|t| !t.is_empty())
    {
        return Err(fail(
            "`target-dir` (the PSR-0 era's layout) is not supported",
        ));
    }
    let field = |outer: &str, inner: &str| {
        object
            .get(outer)
            .and_then(|o| o.get(inner))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let (dist_type, dist_url, shasum) = (
        field("dist", "type"),
        field("dist", "url"),
        field("dist", "shasum"),
    );
    let (source_type, source_url, reference) = (
        field("source", "type"),
        field("source", "url"),
        field("source", "reference"),
    );
    let plan = if text("type") == Some("metapackage") {
        Plan::Nothing
    } else if dist_type == "path" {
        let target = join_under(base, &dist_url)
            .map_err(|_| fail(&format!("path {dist_url:?} is not inside the repository")))?;
        Plan::Path { target }
    } else if !shasum.is_empty() {
        if dist_type != "zip" {
            return Err(fail(&format!(
                "a {dist_type:?} dist; only zip dists are supported"
            )));
        }
        if shasum.len() != 40 || !shasum.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(fail(&format!("dist.shasum {shasum:?} is not a SHA-1")));
        }
        if !dist_url.starts_with("https://") {
            return Err(fail(&format!("dist.url {dist_url:?} is not https")));
        }
        Plan::Dist {
            url: dist_url,
            sha1: shasum.to_ascii_lowercase(),
        }
    } else if source_type == "git" && is_commit(&reference) {
        if !source_url.starts_with("https://") {
            return Err(fail(&format!(
                "source.url {source_url:?} is not an https git URL"
            )));
        }
        Plan::Git {
            url: source_url,
            commit: reference.to_ascii_lowercase(),
        }
    } else {
        return Err(fail(
            "the lock pins neither a dist shasum nor a git commit, so there is nothing to check it against",
        ));
    };
    let bins = match object.get("bin") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Some(_) => return Err(fail("`bin` is not a list")),
    };
    Ok(Package {
        name,
        version,
        dev,
        plan,
        bins,
        raw: object.clone(),
    })
}

/// Fetches and checks one package's files, writing nothing.
fn prepare(
    package: &Package,
    fetcher: &dyn Fetcher,
    git: &dyn GitTrees,
    options: &ComposerOptions,
) -> Result<(Package, Vec<TreeFile>)> {
    let fail = |message: String| ComposerError::Package {
        name: package.name.clone(),
        message,
    };
    let files = match &package.plan {
        Plan::Dist { url, sha1 } => {
            let bytes = fetcher.fetch(url, &Integrity::Sha1Hex(sha1.clone()))?;
            if bytes.len() as u64 > options.max_dist_bytes {
                return Err(ComposerError::TooLarge {
                    what: format!("{}'s dist", package.name),
                    limit: options.max_dist_bytes,
                });
            }
            let mut files = read_zip(
                &bytes,
                options.max_files_per_package,
                options.max_unpacked_bytes,
            )
            .map_err(|e| fail(format!("{url}: {e}")))?;
            // Composer moves the contents of a single top directory up.
            if let Some(root) = common_root(&files) {
                for f in &mut files {
                    f.path = f.path[root.len() + 1..].to_string();
                }
            }
            files
                .into_iter()
                .map(|f| TreeFile {
                    path: f.path,
                    data: f.data,
                    executable: f.executable,
                })
                .collect()
        }
        Plan::Git { url, commit } => {
            let files = git
                .files(url, commit)
                .map_err(|e| fail(format!("{url} at {commit}: {e}")))?;
            if files.len() > options.max_files_per_package {
                return Err(fail(format!(
                    "more than {} files",
                    options.max_files_per_package
                )));
            }
            let total: u64 = files.iter().map(|f| f.data.len() as u64).sum();
            if total > options.max_unpacked_bytes {
                return Err(ComposerError::TooLarge {
                    what: format!("{} at {commit}", package.name),
                    limit: options.max_unpacked_bytes,
                });
            }
            for f in &files {
                check_path(&f.path).map_err(|e| fail(format!("{url} at {commit}: {e}")))?;
            }
            let ignore = ExportIgnore::from_files(
                files.iter().map(|f| (f.path.as_str(), f.data.as_slice())),
            );
            files
                .into_iter()
                .filter(|f| !ignore.excludes(&f.path))
                .collect()
        }
        Plan::Path { .. } | Plan::Nothing => Vec::new(),
    };
    Ok((package.clone(), files))
}

/// A symlink target from the directory `from` to `to`, relative.
fn relative_link(from: &Path, to: &Path) -> PathBuf {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut out = PathBuf::new();
    for _ in common..from.len() {
        out.push("..");
    }
    for c in &to[common..] {
        out.push(c);
    }
    out
}

/// JSON as Composer writes it: four-space indents, slashes unescaped.
pub(crate) fn pretty_json(value: &Value) -> String {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    serde::Serialize::serialize(value, &mut serializer).expect("a Value serialises");
    String::from_utf8(out).expect("JSON is UTF-8")
}

#[cfg(test)]
mod tests;
