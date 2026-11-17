//! Bundler: installs what `Gemfile.lock` pins into `vendor/bundle` as
//! `bundle install` lays it out with `BUNDLE_PATH=vendor/bundle`, without
//! running Ruby.
//!
//! ```text
//! <dir>/vendor/bundle/ruby/<ruby_version>/
//!   gems/<name>-<version>/            each gem's files (its data.tar.gz)
//!   specifications/<name>-<version>.gemspec
//!                                     its specification, as RubyGems writes it
//!   extensions/<platform>/<api>/<name>-<version>/gem.build_complete
//!                                     for a gem with a native extension
//!   bin/<executable>                  RubyGems' wrapper for each executable
//!   bundler/gems/<repo>-<rev12>/      each `GIT` source's tree at its commit
//! ```
//!
//! The job gets `BUNDLE_PATH` and `BUNDLE_FROZEN=true` ([`env`]), which is
//! everything `bundle exec` needs to load the bundle with no network.
//!
//! **What the lock must say.** Bundler 2.6 and later write a `CHECKSUMS`
//! section (`bundle lock --add-checksums` adds one to an older lock) with
//! each gem file's SHA-256, and every gem from a gem server must have one:
//! each `.gem` is checked against it before anything is unpacked. A `GIT`
//! source is fetched by the commit the lock names (https only), so git's
//! object ids verify it, and a `PATH` source is a directory of the
//! repository, which needs nothing installed.
//!
//! **Which build.** A job runs a Ruby built for WebAssembly, which no gem
//! publishes a build for, so the `ruby` platform's build of every gem (its
//! source) is installed, and the lock must list `ruby` under `PLATFORMS`
//! (`bundle lock --add-platform ruby`), as Bundler in the job would insist
//! too, with a `ruby` build of every gem.
//!
//! **Native extensions.** A gem's C extension cannot be compiled here. A
//! [`PrebuiltExtensions`] may supply a build for the job's Ruby; without
//! one the gem's Ruby files are installed and marked built anyway, so the
//! bundle loads and only requiring that gem's compiled part fails (with a
//! `LoadError`), and the report names it. A Rails lock carries gems like
//! that which a test suite never loads (kamal's `ed25519`).

mod gemspec;
mod lockfile;

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

use flate2::read::GzDecoder;
use iwci_vfs::{SnapshotBuilder, VfsError, join_under, normalise};

use crate::archive::{TarItem, check_path, read_tar};
use crate::fetch::{FetchError, Fetcher, Integrity};
pub use crate::git::{GitTrees, NoGit, TreeFile};
use crate::go::parallel;

use gemspec::Gemspec;
use lockfile::{LockedSpec, Lockfile, SourceKind};

/// Where gems go, relative to the Gemfile's directory. Bundler resolves a
/// relative `BUNDLE_PATH` against that directory (`Bundler.root`), so one
/// value serves every Gemfile a workspace installs.
pub const BUNDLE_PATH: &str = "vendor/bundle";

/// The lockfile, then the name Bundler also accepts beside `gems.rb`.
pub const LOCKFILES: &[&str] = &["Gemfile.lock", "gems.locked"];

/// What an install reads besides `*.gemspec` files of `PATH` sources
/// ([`path_gemspecs`]), for anything keyed on its inputs.
pub const INPUT_FILES: [&str; 6] = [
    "Gemfile.lock",
    "gems.locked",
    "Gemfile",
    "gems.rb",
    ".ruby-version",
    ".bundle/config",
];

/// What RubyGems in one `env:ruby` reports, which decides where things go
/// and what the written files say.
///
/// **To be confirmed against `env:ruby`'s own `RbConfig` and RubyGems**
/// when the environment lands: the values here are what a CRuby build for
/// `wasm32-wasi` with `--disable-shared` reports (the 3.4 build's
/// `rbconfig.rb` says `arch` `wasm32-wasi` and `ENABLE_SHARED` `no`), and
/// the RubyGems each release ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RubyAbi {
    /// `major.minor`, as `env:ruby@<version>` names it.
    pub version: &'static str,
    /// `RbConfig::CONFIG["ruby_version"]`: the directory under
    /// `vendor/bundle/ruby/`.
    pub ruby_version: &'static str,
    /// `Gem::Platform.local.to_s`: from `RbConfig::CONFIG["arch"]`.
    pub platform: &'static str,
    /// `Gem.extension_api_version`: `ruby_version`, with `-static` when
    /// `ENABLE_SHARED` is `no`.
    pub extension_api_version: &'static str,
    /// `Gem::VERSION`: written into each gemspec as `installed_by_version`.
    pub rubygems: &'static str,
    /// Which template RubyGems writes `bin/` wrappers with.
    pub binstub: Binstub,
}

/// The two forms of RubyGems' executable wrapper (`app_script_text`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binstub {
    /// RubyGems 3.6: `load Gem.activate_bin_path(...)`.
    ActivateBinPath,
    /// RubyGems 4.0: `Gem.activate_and_load_bin_path(...)`.
    ActivateAndLoadBinPath,
}

/// The Rubies gems are installed for, oldest first. Every value needs
/// confirming against the environment (see [`RubyAbi`]).
pub const RUBY_ABIS: &[RubyAbi] = &[
    RubyAbi {
        version: "3.4",
        ruby_version: "3.4.0",
        platform: "wasm32-wasi",
        extension_api_version: "3.4.0-static",
        rubygems: "3.6.9",
        binstub: Binstub::ActivateBinPath,
    },
    RubyAbi {
        version: "4.0",
        ruby_version: "4.0.0",
        platform: "wasm32-wasi",
        extension_api_version: "4.0.0-static",
        rubygems: "4.0.20",
        binstub: Binstub::ActivateAndLoadBinPath,
    },
];

/// The ABI for `major.minor`.
pub fn ruby_abi(version: &str) -> Option<&'static RubyAbi> {
    RUBY_ABIS.iter().find(|a| a.version == version)
}

fn supported() -> String {
    RUBY_ABIS
        .iter()
        .map(|a| a.version)
        .collect::<Vec<_>>()
        .join(", ")
}

/// The gem a [`PrebuiltExtensions`] is asked for.
#[derive(Debug, Clone, Copy)]
pub struct ExtensionRequest<'a> {
    pub name: &'a str,
    pub version: &'a str,
    /// The gem's platform: always `ruby` today.
    pub platform: &'a str,
    /// The Ruby it is for.
    pub abi: &'a RubyAbi,
    /// The gemspec's `extensions` (`ext/<name>/extconf.rb`, ...).
    pub extensions: &'a [String],
}

/// Native extensions built ahead of time for the job's Ruby.
pub trait PrebuiltExtensions: Send + Sync {
    /// Part of the install's cache key: whatever, if it changed, could
    /// change what [`PrebuiltExtensions::files`] returns.
    fn key(&self) -> String;

    /// The files to place in the gem's extension directory
    /// (`extensions/<platform>/<api>/<full name>/`), paths relative to it,
    /// or `None` when there is no build for this gem. `gem.build_complete`
    /// is written either way and need not be among them.
    fn files(
        &self,
        gem: &ExtensionRequest<'_>,
    ) -> std::result::Result<Option<Vec<TreeFile>>, String>;
}

/// No prebuilt extensions: every gem with one is installed without it.
pub struct NoPrebuilt;

impl PrebuiltExtensions for NoPrebuilt {
    fn key(&self) -> String {
        String::new()
    }

    fn files(
        &self,
        _gem: &ExtensionRequest<'_>,
    ) -> std::result::Result<Option<Vec<TreeFile>>, String> {
        Ok(None)
    }
}

#[derive(Debug, Clone)]
pub struct BundlerOptions {
    /// `major.minor` of the Ruby to install for, when the pipeline names
    /// it. Otherwise the lock's `RUBY VERSION`, then `.ruby-version`, then
    /// the newest supported.
    pub ruby: Option<String>,
    /// Gems fetched at once.
    pub parallelism: usize,
    /// One `.gem` download.
    pub max_gem_bytes: u64,
    /// One gem, unpacked.
    pub max_unpacked_bytes: u64,
    pub max_files_per_gem: usize,
    /// Everything written into the snapshot, which lives in memory.
    pub max_total_bytes: u64,
}

impl Default for BundlerOptions {
    fn default() -> Self {
        Self {
            ruby: None,
            parallelism: 8,
            max_gem_bytes: 512 << 20,
            max_unpacked_bytes: 1 << 30,
            max_files_per_gem: 100_000,
            max_total_bytes: 4 << 30,
        }
    }
}

/// The environment a job needs for `bundle exec` to load the bundle.
pub fn env() -> Vec<(String, String)> {
    vec![
        ("BUNDLE_PATH".to_string(), BUNDLE_PATH.to_string()),
        // Bundler checks the Gemfile against the lock and never resolves
        // or reaches a gem server.
        ("BUNDLE_FROZEN".to_string(), "true".to_string()),
    ]
}

/// How one gem's bytes were checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verified {
    /// Its `.gem`, against the lock's `CHECKSUMS` SHA-256.
    Sha256,
    /// Its git commit, by the lock's `revision`.
    GitCommit,
    /// A directory of the repository: nothing installed.
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledGem {
    pub name: String,
    pub version: String,
    pub verified: Verified,
}

#[derive(Debug, Clone, Default)]
pub struct BundlerReport {
    /// The lock read, as an absolute path.
    pub lockfile: String,
    /// The Ruby installed for (`major.minor`).
    pub ruby: String,
    pub installed: Vec<InstalledGem>,
    /// Gems with a native extension installed without it.
    pub missing_extensions: Vec<String>,
    /// Problems that did not stop the install.
    pub warnings: Vec<String>,
    pub bytes_written: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum BundlerError {
    #[error(transparent)]
    Vfs(#[from] VfsError),
    #[error(transparent)]
    Fetch(#[from] FetchError),
    #[error("{0}: no Gemfile.lock (run `bundle lock` and commit it)")]
    NoLockfile(String),
    #[error("{file}: {message}")]
    Lockfile { file: String, message: String },
    #[error("{name}: {message}")]
    Gem { name: String, message: String },
    #[error("{what} is over the {limit} byte limit")]
    TooLarge { what: String, limit: u64 },
}

pub type Result<T> = std::result::Result<T, BundlerError>;

/// The `*.gemspec` files the `PATH` sources of the lock in `lock` name,
/// relative to its directory: Bundler reads them when the bundle loads, so
/// anything keyed on an install's inputs reads them too. Sources outside
/// the lock's directory are left out.
pub fn path_gemspecs(lock: Option<&[u8]>) -> Vec<String> {
    let Some(lock) = lock
        .and_then(|b| std::str::from_utf8(b).ok())
        .and_then(|t| lockfile::parse(t).ok())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for source in &lock.sources {
        let SourceKind::Path { remote } = &source.kind else {
            continue;
        };
        let remote = remote.trim_end_matches('/');
        for spec in &source.specs {
            let path = if remote.is_empty() || remote == "." {
                format!("{}.gemspec", spec.name)
            } else {
                format!("{remote}/{}.gemspec", spec.name)
            };
            if check_path(&path).is_ok() && !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// Installs every gem `<dir>/Gemfile.lock` pins for the `ruby` platform.
pub fn install(
    builder: &SnapshotBuilder,
    dir: &str,
    fetcher: &dyn Fetcher,
    git: &dyn GitTrees,
    prebuilt: &dyn PrebuiltExtensions,
    options: &BundlerOptions,
) -> Result<BundlerReport> {
    let base = normalise(dir)?;
    let lock_path = LOCKFILES
        .iter()
        .map(|name| base.join(name))
        .find(|path| builder.is_file(path))
        .ok_or_else(|| BundlerError::NoLockfile(base.display().to_string()))?;
    let file = lock_path.display().to_string();
    let lock_error = |message: String| BundlerError::Lockfile {
        file: file.clone(),
        message,
    };
    let text = String::from_utf8(builder.read(&lock_path)?)
        .map_err(|_| lock_error("not UTF-8".to_string()))?;
    let lock = lockfile::parse(&text).map_err(lock_error)?;
    let mut report = BundlerReport {
        lockfile: file.clone(),
        ..BundlerReport::default()
    };

    let ruby_version_file = {
        let path = base.join(".ruby-version");
        if builder.is_file(&path) {
            Some(String::from_utf8_lossy(&builder.read(&path)?).into_owned())
        } else {
            None
        }
    };
    let abi = choose_abi(
        options.ruby.as_deref(),
        lock.ruby_version.as_deref(),
        ruby_version_file.as_deref(),
        &mut report.warnings,
    )
    .map_err(lock_error)?;
    report.ruby = abi.version.to_string();
    check_local_config(builder, &base, &mut report.warnings)?;

    let plan = plan(&lock, abi).map_err(lock_error)?;
    let root = base.join(BUNDLE_PATH).join("ruby").join(abi.ruby_version);

    let mut written = 0u64;
    let mut write = |path: &Path, data: &[u8], executable: bool| -> Result<()> {
        written += data.len() as u64;
        if written > options.max_total_bytes {
            return Err(BundlerError::TooLarge {
                what: "the installed gems".to_string(),
                limit: options.max_total_bytes,
            });
        }
        builder.write(path, data)?;
        if executable {
            builder.set_mode(path, 0o755)?;
        }
        Ok(())
    };

    // Gems from gem servers, verified by their checksums.
    // Each gem's specification and the files under its `bindir`, for the
    // wrappers written once every gem is in.
    let mut gems: Vec<(Gemspec, BTreeSet<String>)> = Vec::new();
    parallel(
        &plan.gems,
        options.parallelism,
        |job| prepare_gem(job, fetcher, prebuilt, abi, options),
        |prepared: PreparedGem| {
            let full_name = prepared.spec.full_name();
            let gem_dir = root.join("gems").join(&full_name);
            builder.mkdir_all(&gem_dir)?;
            for item in &prepared.files {
                match item {
                    TarItem::File(f) => write(&gem_dir.join(&f.path), &f.data, f.executable)?,
                    TarItem::Symlink { path, target } => {
                        let link = gem_dir.join(path);
                        if let Some(parent) = link.parent() {
                            builder.mkdir_all(parent)?;
                        }
                        builder.symlink(&link, target)?;
                    }
                }
            }
            write(
                &root
                    .join("specifications")
                    .join(format!("{full_name}.gemspec")),
                &prepared.spec.to_ruby_for_cache(abi.rubygems),
                false,
            )?;
            if !prepared.spec.extensions().is_empty() {
                let ext_dir = root
                    .join("extensions")
                    .join(abi.platform)
                    .join(abi.extension_api_version)
                    .join(&full_name);
                builder.mkdir_all(&ext_dir)?;
                match &prepared.extension {
                    Some(files) => {
                        for f in files {
                            write(&join_under(&ext_dir, &f.path)?, &f.data, f.executable)?;
                        }
                    }
                    None => {
                        report.missing_extensions.push(full_name.clone());
                        report.warnings.push(format!(
                            "bundler: {full_name} has a native extension ({}) and no build of it \
                             for Ruby {} on {}; it is installed without it, so requiring its \
                             compiled part fails with a LoadError",
                            prepared.spec.extensions().join(", "),
                            abi.version,
                            abi.platform
                        ));
                    }
                }
                // What Bundler looks for to count the gem as installed.
                write(&ext_dir.join("gem.build_complete"), b"", false)?;
            }
            report.installed.push(InstalledGem {
                name: prepared.spec.name.clone(),
                version: prepared.spec.version.clone(),
                verified: Verified::Sha256,
            });
            let bindir = format!("{}/", prepared.spec.bindir().trim_end_matches('/'));
            let bins = prepared
                .files
                .iter()
                .map(|item| match item {
                    TarItem::File(f) => &f.path,
                    TarItem::Symlink { path, .. } => path,
                })
                .filter(|path| path.starts_with(&bindir))
                .cloned()
                .collect();
            gems.push((prepared.spec, bins));
            Ok(())
        },
    )?;

    // Git sources, verified by their commits.
    parallel(
        &plan.git,
        options.parallelism,
        |job| prepare_git(job, git, options),
        |(job, files): (GitJob, Vec<TreeFile>)| {
            let checkout = root.join("bundler").join("gems").join(format!(
                "{}-{}",
                job.base_name,
                &job.revision[..12]
            ));
            builder.mkdir_all(&checkout)?;
            for f in &files {
                write(&checkout.join(&f.path), &f.data, f.executable)?;
            }
            for spec in &job.specs {
                report.installed.push(InstalledGem {
                    name: spec.name.clone(),
                    version: spec.version.clone(),
                    verified: Verified::GitCommit,
                });
            }
            Ok(())
        },
    )?;
    for spec in &plan.paths {
        report.installed.push(InstalledGem {
            name: spec.name.clone(),
            version: spec.version.clone(),
            verified: Verified::Path,
        });
    }

    // bin/: RubyGems' wrapper for each executable, as Bundler has it
    // generate them (`env_shebang`, wrappers).
    gems.sort_by(|a, b| a.0.name.cmp(&b.0.name));
    let mut bins: BTreeMap<String, String> = BTreeMap::new();
    for (spec, present) in &gems {
        let bindir = spec.bindir();
        for exe in spec.executables() {
            let skip = |why: &str| {
                format!(
                    "bundler: {}: executable {exe:?} skipped: {why}",
                    spec.full_name()
                )
            };
            if exe.is_empty()
                || exe.contains('/')
                || check_path(&exe).is_err()
                || exe.contains('\'')
            {
                report.warnings.push(skip("not a plain file name"));
                continue;
            }
            let in_gem = format!("{}/{exe}", bindir.trim_end_matches('/'));
            if !present.contains(&in_gem) {
                report
                    .warnings
                    .push(skip(&format!("{in_gem} is not in the gem")));
                continue;
            }
            if let Some(other) = bins.get(&exe) {
                report
                    .warnings
                    .push(skip(&format!("{other} already installed one by that name")));
                continue;
            }
            bins.insert(exe.clone(), spec.name.clone());
            write(
                &root.join("bin").join(&exe),
                binstub(abi, &spec.name, &exe).as_bytes(),
                true,
            )?;
        }
    }

    report.bytes_written = written;
    report.installed.sort_by(|a, b| a.name.cmp(&b.name));
    report.missing_extensions.sort();
    report.warnings.extend(plan.warnings);
    Ok(report)
}

/// Which Ruby to install for: the pipeline's `ruby:`, else the lock's
/// `RUBY VERSION`, else `.ruby-version`, else the newest. The lock's is
/// what Bundler in the job enforces (when the Gemfile names one), so a
/// `ruby:` that disagrees with it is refused rather than installed for a
/// Ruby the bundle will not load in.
fn choose_abi(
    explicit: Option<&str>,
    locked: Option<&str>,
    file: Option<&str>,
    warnings: &mut Vec<String>,
) -> std::result::Result<&'static RubyAbi, String> {
    let unsupported = |v: &str, from: &str| {
        format!(
            "{from} asks for Ruby {v}; gems are installed for Ruby {} only",
            supported()
        )
    };
    let locked = locked.map(|v| {
        let v = v.split_whitespace().next().unwrap_or(v);
        (v.to_string(), major_minor(v))
    });
    if let Some(explicit) = explicit {
        let abi = ruby_abi(explicit).ok_or_else(|| unsupported(explicit, "`ruby:`"))?;
        if let Some((full, Some(mm))) = &locked
            && *mm != abi.version
        {
            return Err(format!(
                "`ruby: \"{}\"` disagrees with the lock's RUBY VERSION ({full}), which Bundler \
                 in the job would refuse",
                abi.version
            ));
        }
        return Ok(abi);
    }
    if let Some((full, mm)) = locked {
        let mm = mm.ok_or_else(|| format!("RUBY VERSION {full:?} is not a version"))?;
        return ruby_abi(&mm).ok_or_else(|| unsupported(&full, "RUBY VERSION"));
    }
    if let Some(text) = file {
        let text = text.trim();
        let version = text.strip_prefix("ruby-").unwrap_or(text);
        match major_minor(version) {
            Some(mm) => {
                return ruby_abi(&mm).ok_or_else(|| unsupported(version, ".ruby-version"));
            }
            None => warnings.push(format!(
                "bundler: .ruby-version says {text:?}, which is not a CRuby version; \
                 installing for Ruby {}",
                RUBY_ABIS[RUBY_ABIS.len() - 1].version
            )),
        }
    }
    Ok(&RUBY_ABIS[RUBY_ABIS.len() - 1])
}

/// `3.4` of `3.4.1p0`, `3.4.1` or `3.4`.
fn major_minor(version: &str) -> Option<String> {
    let mut parts = version.split('.');
    let major = parts.next()?;
    let minor: String = parts
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if major.is_empty() || !major.bytes().all(|b| b.is_ascii_digit()) || minor.is_empty() {
        return None;
    }
    Some(format!("{major}.{minor}"))
}

/// A repository's `.bundle/config` beats the environment in Bundler's
/// settings, so one that sets its own path would hide the install.
fn check_local_config(
    builder: &SnapshotBuilder,
    base: &Path,
    warnings: &mut Vec<String>,
) -> Result<()> {
    let path = base.join(".bundle/config");
    if !builder.is_file(&path) {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&builder.read(&path)?).into_owned();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        if key.trim() == "BUNDLE_PATH" && value.trim_end_matches('/') != BUNDLE_PATH {
            warnings.push(format!(
                "bundler: {} sets BUNDLE_PATH to {value:?}, which wins over the job's \
                 {BUNDLE_PATH:?}, so `bundle exec` will not find the installed gems",
                path.display()
            ));
        }
    }
    Ok(())
}

/// One gem to download.
#[derive(Debug, Clone)]
struct GemJob {
    spec: LockedSpec,
    remotes: Vec<String>,
    sha256: String,
}

/// One git source to fetch.
#[derive(Debug, Clone)]
struct GitJob {
    remote: String,
    revision: String,
    base_name: String,
    specs: Vec<LockedSpec>,
}

#[derive(Debug, Default)]
struct Plan {
    gems: Vec<GemJob>,
    git: Vec<GitJob>,
    paths: Vec<LockedSpec>,
    warnings: Vec<String>,
}

/// RubyGems' rule for a gem name.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// A gem version as it can appear in a file name: `Gem::Version`'s
/// characters, no `-`.
fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.starts_with(|c: char| c.is_ascii_digit())
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.')
}

fn is_commit(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What to install, from the lock: the `ruby` build of every gem from a
/// gem server, each git source once, and nothing for `PATH` gems.
fn plan(lock: &Lockfile, abi: &RubyAbi) -> std::result::Result<Plan, String> {
    if !lock
        .platforms
        .iter()
        .any(|p| p == "ruby" || p == abi.platform)
    {
        return Err(format!(
            "PLATFORMS lists {}, not `ruby`: a job's Ruby (built for {}) installs each gem's \
             `ruby` build, and Bundler refuses a lock that does not list its platform. Run \
             `bundle lock --add-platform ruby` and commit the lock",
            if lock.platforms.is_empty() {
                "nothing".to_string()
            } else {
                lock.platforms.join(", ")
            },
            abi.platform
        ));
    }
    let mut plan = Plan::default();
    // Each installed gem, by name, with where it comes from.
    let mut chosen: BTreeMap<String, (String, LockedSpec)> = BTreeMap::new();
    let mut others: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut take = |spec: &LockedSpec, origin: String| -> std::result::Result<(), String> {
        if let Some((other, _)) = chosen.insert(spec.name.clone(), (origin.clone(), spec.clone())) {
            return Err(format!(
                "{} is locked twice ({other} and {origin})",
                spec.name
            ));
        }
        Ok(())
    };
    let mut missing_checksums = Vec::new();
    for source in &lock.sources {
        match &source.kind {
            SourceKind::Gem { remotes } => {
                if remotes.is_empty() {
                    return Err("a GEM section without a remote".to_string());
                }
                for remote in remotes {
                    if !remote.starts_with("https://") {
                        return Err(format!(
                            "gem server {remote:?} is not https; only https servers are fetched"
                        ));
                    }
                }
                for spec in &source.specs {
                    if !valid_name(&spec.name) {
                        return Err(format!("{:?} is not a gem name", spec.name));
                    }
                    if !valid_version(&spec.version) {
                        return Err(format!(
                            "{}: {:?} is not a gem version",
                            spec.name, spec.version
                        ));
                    }
                    if spec.platform != "ruby" {
                        others
                            .entry(spec.name.clone())
                            .or_default()
                            .insert(spec.platform.clone());
                        continue;
                    }
                    take(spec, remotes[0].clone())?;
                    match lock.checksums.get(&spec.lock_name()) {
                        Some(Some(sha256)) => plan.gems.push(GemJob {
                            spec: spec.clone(),
                            remotes: remotes.clone(),
                            sha256: sha256.clone(),
                        }),
                        _ => missing_checksums.push(spec.lock_name()),
                    }
                }
            }
            SourceKind::Git {
                remote,
                revision,
                reference,
                submodules,
            } => {
                let at = reference.as_deref().unwrap_or("its revision");
                if !remote.starts_with("https://") {
                    return Err(format!(
                        "git source {remote:?} ({at}) is not https; only https repositories are fetched"
                    ));
                }
                if !is_commit(revision) {
                    return Err(format!(
                        "git source {remote}: revision {revision:?} is not a commit id"
                    ));
                }
                if *submodules {
                    return Err(format!(
                        "git source {remote}: `submodules: true` is not supported"
                    ));
                }
                for spec in &source.specs {
                    take(spec, remote.clone())?;
                }
                let base_name = git_base_name(remote);
                if !valid_name(&base_name) {
                    return Err(format!(
                        "git source {remote}: {base_name:?} is not a directory name"
                    ));
                }
                let revision = revision.to_ascii_lowercase();
                if plan
                    .git
                    .iter()
                    .any(|g| g.base_name == base_name && g.revision[..12] == revision[..12])
                {
                    return Err(format!(
                        "two git sources check out to {base_name}-{}",
                        &revision[..12]
                    ));
                }
                plan.git.push(GitJob {
                    remote: remote.clone(),
                    revision,
                    base_name,
                    specs: source.specs.clone(),
                });
            }
            SourceKind::Path { remote } => {
                for spec in &source.specs {
                    take(spec, format!("path {remote}"))?;
                    plan.paths.push(spec.clone());
                }
            }
        }
    }
    // A gem with builds for other platforms and none for `ruby`, in a lock
    // that lists `ruby`: Bundler in the job would look for the `ruby` build
    // and not find it. `bundle lock --add-checksums --add-platform ruby` in
    // one command writes a lock like that (Bundler 4.0.3).
    let unbuilt: Vec<String> = others
        .iter()
        .filter(|(name, _)| !chosen.contains_key(*name))
        .map(|(name, platforms)| {
            format!(
                "{name} ({})",
                platforms.iter().cloned().collect::<Vec<_>>().join(", ")
            )
        })
        .collect();
    if !unbuilt.is_empty() {
        let shown: Vec<&str> = unbuilt.iter().take(5).map(String::as_str).collect();
        return Err(format!(
            "PLATFORMS lists `ruby`, but the lock has no `ruby` build of {}{}, only builds for \
             other platforms. Add the platform again: `bundle lock --remove-platform ruby`, then \
             `bundle lock --add-platform ruby`, and commit the lock",
            shown.join(", "),
            if unbuilt.len() > 5 { ", ..." } else { "" }
        ));
    }
    if !missing_checksums.is_empty() {
        let first: Vec<&str> = missing_checksums
            .iter()
            .take(5)
            .map(String::as_str)
            .collect();
        let what = if lock.has_checksums {
            format!(
                "CHECKSUMS has no sha256 for {}{}",
                first.join(", "),
                if missing_checksums.len() > 5 {
                    ", ..."
                } else {
                    ""
                }
            )
        } else {
            "there is no CHECKSUMS section".to_string()
        };
        return Err(format!(
            "{what}, and every gem's file is checked against one. Run `bundle lock \
             --add-checksums` (Bundler 2.6 or later) and commit the lock"
        ));
    }
    // Every dependency of an installed gem must be installed too.
    let mut missing = BTreeSet::new();
    for (_, spec) in chosen.values() {
        for dep in &spec.dependencies {
            if dep != "bundler" && !chosen.contains_key(dep) {
                missing.insert(format!(
                    "bundler: {} depends on {dep}, which the lock does not install for `ruby`",
                    spec.name
                ));
            }
        }
    }
    plan.warnings.extend(missing);
    Ok(plan)
}

/// The directory name Bundler checks a git source out under:
/// `File.basename(uri.sub(%r{^(\w+://)?([^/:]+:)?(//\w*/)?(\w*/)*}, ""), ".git")`.
fn git_base_name(uri: &str) -> String {
    let mut rest = uri;
    if let Some(at) = rest.find("://")
        && rest[..at]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        rest = &rest[at + 3..];
    }
    if let Some(at) = rest.find(':')
        && at > 0
        && !rest[..at].contains('/')
    {
        rest = &rest[at + 1..];
    }
    let trimmed = rest.trim_end_matches('/');
    let last = trimmed.rsplit('/').next().unwrap_or(trimmed);
    match last.strip_suffix(".git") {
        Some(stem) if !stem.is_empty() => stem.to_string(),
        _ => last.to_string(),
    }
}

/// A gem downloaded, checked and unpacked, written nowhere yet.
struct PreparedGem {
    spec: Gemspec,
    files: Vec<TarItem>,
    extension: Option<Vec<TreeFile>>,
}

fn prepare_gem(
    job: &GemJob,
    fetcher: &dyn Fetcher,
    prebuilt: &dyn PrebuiltExtensions,
    abi: &RubyAbi,
    options: &BundlerOptions,
) -> Result<PreparedGem> {
    let full_name = job.spec.full_name();
    let fail = |message: String| BundlerError::Gem {
        name: full_name.clone(),
        message,
    };
    let integrity = Integrity::Sha256Hex(job.sha256.clone());
    let mut bytes = None;
    let mut last_error = None;
    for remote in &job.remotes {
        let url = format!("{}/gems/{full_name}.gem", remote.trim_end_matches('/'));
        match fetcher.fetch(&url, &integrity) {
            Ok(b) => {
                bytes = Some(b);
                break;
            }
            Err(e @ FetchError::NotFound { .. }) => last_error = Some(e),
            Err(e) => return Err(e.into()),
        }
    }
    let bytes = match (bytes, last_error) {
        (Some(b), _) => b,
        (None, Some(e)) => return Err(e.into()),
        (None, None) => return Err(fail("no gem server to fetch it from".to_string())),
    };
    if bytes.len() as u64 > options.max_gem_bytes {
        return Err(BundlerError::TooLarge {
            what: format!("{full_name}.gem"),
            limit: options.max_gem_bytes,
        });
    }
    let gem = read_gem(&bytes, options).map_err(fail)?;
    let spec = Gemspec::from_yaml(&gem.metadata).map_err(fail)?;
    if spec.name != job.spec.name || spec.version != job.spec.version || spec.platform != "ruby" {
        return Err(fail(format!(
            "the gem's metadata says it is {}, not what the lock names",
            spec.full_name()
        )));
    }
    let extensions = spec.extensions();
    let extension = if extensions.is_empty() {
        None
    } else {
        let request = ExtensionRequest {
            name: &spec.name,
            version: &spec.version,
            platform: &spec.platform,
            abi,
            extensions: &extensions,
        };
        let files = prebuilt
            .files(&request)
            .map_err(|e| fail(format!("its prebuilt extension: {e}")))?;
        if let Some(files) = &files {
            for f in files {
                check_path(&f.path).map_err(|e| fail(format!("its prebuilt extension: {e}")))?;
            }
        }
        files
    };
    Ok(PreparedGem {
        spec,
        files: gem.data,
        extension,
    })
}

/// A `.gem`'s parts: the YAML of `metadata.gz` and the entries of
/// `data.tar.gz`.
struct GemFile {
    metadata: String,
    data: Vec<TarItem>,
}

/// The largest `metadata.gz` read, unpacked: a gemspec with a file list
/// of tens of thousands of entries is a few megabytes.
const MAX_METADATA_BYTES: u64 = 64 << 20;

fn read_gem(bytes: &[u8], options: &BundlerOptions) -> std::result::Result<GemFile, String> {
    // The outer tar: metadata.gz, data.tar.gz, checksums.yaml.gz and
    // signatures. Nothing in it is unpacked to disk.
    let outer = read_tar(bytes, 16, options.max_gem_bytes)?;
    let mut metadata = None;
    let mut data = None;
    for item in outer {
        let TarItem::File(f) = item else { continue };
        match f.path.as_str() {
            "metadata.gz" => metadata = Some(f.data),
            "data.tar.gz" => data = Some(f.data),
            _ => {}
        }
    }
    let metadata = metadata.ok_or("not a gem: no metadata.gz")?;
    let data = data.ok_or("not a gem: no data.tar.gz")?;
    let mut yaml = Vec::new();
    GzDecoder::new(&metadata[..])
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut yaml)
        .map_err(|e| format!("metadata.gz: {e}"))?;
    if yaml.len() as u64 > MAX_METADATA_BYTES {
        return Err(format!(
            "metadata.gz is over {MAX_METADATA_BYTES} bytes unpacked"
        ));
    }
    let yaml = String::from_utf8(yaml).map_err(|_| "metadata.gz is not UTF-8".to_string())?;
    let data = read_tar(
        GzDecoder::new(&data[..]),
        options.max_files_per_gem,
        options.max_unpacked_bytes,
    )
    .map_err(|e| format!("data.tar.gz: {e}"))?;
    Ok(GemFile {
        metadata: yaml,
        data,
    })
}

fn prepare_git(
    job: &GitJob,
    git: &dyn GitTrees,
    options: &BundlerOptions,
) -> Result<(GitJob, Vec<TreeFile>)> {
    let fail = |message: String| BundlerError::Gem {
        name: format!("{} at {}", job.remote, job.revision),
        message,
    };
    let files = git.files(&job.remote, &job.revision).map_err(fail)?;
    if files.len() > options.max_files_per_gem {
        return Err(fail(format!(
            "more than {} files",
            options.max_files_per_gem
        )));
    }
    let total: u64 = files.iter().map(|f| f.data.len() as u64).sum();
    if total > options.max_unpacked_bytes {
        return Err(BundlerError::TooLarge {
            what: format!("{} at {}", job.remote, job.revision),
            limit: options.max_unpacked_bytes,
        });
    }
    for f in &files {
        check_path(&f.path).map_err(fail)?;
    }
    Ok((job.clone(), files))
}

/// RubyGems' wrapper for `exe` of `gem` (`Gem::Installer#app_script_text`),
/// with the `#!/usr/bin/env ruby` line Bundler's `env_shebang` gives it.
fn binstub(abi: &RubyAbi, gem: &str, exe: &str) -> String {
    // `gemdeps_load` and `explicit_version_requirement`, interpolated as
    // they are: their later lines are not indented.
    let (gemdeps, explicit) = match (gem == "bundler", abi.binstub) {
        (false, _) => ("\nGem.use_gemdeps\n", "version = str"),
        (true, Binstub::ActivateAndLoadBinPath) => {
            ("", "version = str\nENV['BUNDLER_VERSION'] = str\n")
        }
        (true, Binstub::ActivateBinPath) => {
            ("", "version = str\n    ENV['BUNDLER_VERSION'] = str\n")
        }
    };
    let head = format!(
        "#!/usr/bin/env ruby\n\
         #\n\
         # This file was generated by RubyGems.\n\
         #\n\
         # The application '{gem}' is installed as part of a gem, and\n\
         # this file is here to facilitate running it.\n\
         #\n\
         \n\
         require 'rubygems'\n\
         {gemdeps}\n\
         version = \">= 0.a\"\n\
         \n\
         str = ARGV.first\n\
         if str\n  \
           str = str.b[/\\A_(.*)_\\z/, 1]\n  \
           if str and Gem::Version.correct?(str)\n    \
             {explicit}\n    \
             ARGV.shift\n  \
           end\n\
         end\n\
         \n"
    );
    let tail = match abi.binstub {
        Binstub::ActivateAndLoadBinPath => format!(
            "if Gem.respond_to?(:activate_and_load_bin_path)\n  \
               Gem.activate_and_load_bin_path('{gem}', '{exe}', version)\n\
             else\n  \
               load Gem.activate_bin_path('{gem}', '{exe}', version)\n\
             end\n"
        ),
        Binstub::ActivateBinPath => format!(
            "if Gem.respond_to?(:activate_bin_path)\n\
             load Gem.activate_bin_path('{gem}', '{exe}', version)\n\
             else\n\
             gem {name}, version\n\
             load Gem.bin_path({name}, {file}, version)\n\
             end\n",
            name = gemspec::dump(gem.as_bytes()),
            file = gemspec::dump(exe.as_bytes()),
        ),
    };
    head + &tail
}

#[cfg(test)]
mod tests;
