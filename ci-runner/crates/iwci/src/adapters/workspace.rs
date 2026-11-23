//! Building a workspace (clone, then dependencies) and committing a job's
//! changes, over `iwci-git` and `iwci-deps`.

use std::sync::Arc;

use iwci_deps::cache::{InstallKey, Installer};
use iwci_deps::fetch::Fetcher;
use iwci_git::{Identity, RemoteCache};
use iwci_spec::{CloneDepth, DepSpec, Ecosystem, WorkspaceSpec};
use iwci_vfs::{Change, SnapshotBuilder};

use crate::schedule::{BuiltWorkspace, Committer, Workspaces};

pub struct GitWorkspaces {
    pub remote: RemoteCache,
    pub commit: String,
    pub auth: Option<iwci_git::Auth>,
    /// A branch or ref to fall back on when the server refuses to serve a
    /// commit by its id.
    pub ref_hint: Option<String>,
    pub fetcher: Arc<dyn Fetcher>,
    /// Whole installs, keyed by what each read (`iwci_deps::cache`).
    pub layers: Arc<iwci_deps::cache::LayerCache>,
    /// Threads an install may use to fetch and unpack (`--cpus`).
    pub threads: usize,
    /// Where Composer packages without a dist hash, and Bundler's `GIT`
    /// sources, are fetched by commit.
    pub git: Option<iwci_git::GitCache>,
    /// Native extensions built ahead of time for `env:ruby`, placed where
    /// Bundler looks for a gem's compiled part.
    pub prebuilt: Arc<dyn iwci_deps::bundler::PrebuiltExtensions>,
    /// What `install-scripts: true` runs its scripts with: the runner's
    /// machines and the run's caches.
    pub scripts: Option<crate::install_scripts::ScriptHost>,
}

/// Packages' git commits (Composer's, Bundler's), through the run's git
/// cache. The commit id is what verifies them: gix checks every object it
/// receives against its id, so the tree read back is the one the lock
/// names.
pub struct CachedGitTrees {
    pub git: iwci_git::GitCache,
    /// Tests reach fixture repositories over `file://`; a lock never may,
    /// or it could read repositories on the runner's own disk.
    pub allow_local: bool,
}

impl iwci_deps::git::GitTrees for CachedGitTrees {
    fn files(&self, url: &str, commit: &str) -> Result<Vec<iwci_deps::git::TreeFile>, String> {
        if !(url.starts_with("https://") || self.allow_local && url.starts_with("file://")) {
            return Err(format!("{url}: only https git URLs are fetched"));
        }
        let remote = self.git.remote(url).map_err(|e| e.to_string())?;
        // No credentials: the run's token is for its own repository.
        remote
            .fetch_commit(commit, iwci_git::Depth::Shallow(1), None, None)
            .map_err(|e| format!("fetch: {e}"))?;
        let scratch = SnapshotBuilder::new();
        remote
            .checkout_into(commit, &scratch, "/tree")
            .map_err(|e| format!("checkout: {e}"))?;
        let tree = scratch.freeze();
        let mut files = Vec::new();
        for path in tree.list_files("/tree") {
            let Ok(relative) = path.strip_prefix("/tree") else {
                continue;
            };
            let data = tree.read(&path).map_err(|e| e.to_string())?;
            files.push(iwci_deps::git::TreeFile {
                path: relative.to_string_lossy().into_owned(),
                data,
                executable: tree.mode(&path).is_some_and(|m| m & 0o111 != 0),
            });
        }
        Ok(files)
    }
}

/// The runner's own Linux, for a JS install with `native: true`: its
/// packages are installed beside the isolate's (`PnpmOptions::native`).
pub(crate) fn native_platform(dep: &iwci_spec::DepSpec) -> Option<iwci_deps::pnpm::Platform> {
    dep.native.then(iwci_deps::pnpm::native_platform).flatten()
}

/// What a workspace with the runner's own Linux packages tells its jobs'
/// `node`: report that platform (`process.platform`, `process.arch`), not
/// Edge.js's `wasi` and `wasm32`, so a package's wrapper picks the build
/// that was installed for it and starts it (iwci-runtime's
/// `node/host-platform.cjs`).
/// Where a workspace with a `native: true` install records the platform it
/// chose, for a `node` started without `IWCI_NODE_PLATFORM`
/// (`iwci-runtime/node/host-platform.cjs` reads the same path).
const NODE_PLATFORM_FILE: &str = "/etc/iwci/node-platform";

fn node_platform_env(native: Option<&iwci_deps::pnpm::Platform>) -> Option<(String, String)> {
    native.map(|p| {
        (
            "IWCI_NODE_PLATFORM".to_string(),
            format!("{}-{}", p.os, p.cpu),
        )
    })
}

/// A cache key from an installer's options, without the thread count,
/// which changes how fast an install runs and never what it writes. The
/// key carries the installer's version (`Installer::version`), so an
/// install an older build of it cached is never replayed.
fn options_key(installer: Installer, dir: &str, options: &impl std::fmt::Debug) -> InstallKey {
    InstallKey::new(installer, dir, options)
}

/// The pnpm installer's options for `dep`, with no threads (the caller sets
/// them after keying): the importers it names, and the registries the
/// project's `.npmrc` sets (`registry`, `@scope:registry`), as pnpm reads
/// them, or the public registry.
fn pnpm_options(builder: &SnapshotBuilder, dep: &DepSpec) -> iwci_deps::pnpm::PnpmOptions {
    let npmrc = iwci_deps::npmrc::Npmrc::read(
        &|path| builder.read(path).ok(),
        std::path::Path::new(&dep.dir),
    );
    iwci_deps::pnpm::PnpmOptions {
        registry: npmrc
            .registry()
            .unwrap_or(iwci_deps::pnpm::DEFAULT_REGISTRY)
            .to_string(),
        scoped_registries: npmrc.scoped_registries(),
        only_importers: dep.only.clone(),
        native: native_platform(dep),
        parallelism: 0,
        ..Default::default()
    }
}

impl GitWorkspaces {
    /// The run's git cache as a source of packages' trees, or nothing.
    fn trees(&self) -> Option<CachedGitTrees> {
        self.git.clone().map(|git| CachedGitTrees {
            git,
            allow_local: false,
        })
    }
}

fn depth(d: CloneDepth) -> iwci_git::Depth {
    match d {
        CloneDepth::Shallow(n) => iwci_git::Depth::Shallow(n),
        CloneDepth::Full => iwci_git::Depth::Full,
    }
}

impl Workspaces for GitWorkspaces {
    fn build(&self, spec: &WorkspaceSpec) -> Result<BuiltWorkspace, String> {
        let builder = SnapshotBuilder::new();
        let mut env = Vec::new();
        let mut warnings = Vec::new();
        let mut installs = Vec::new();
        let mut path = Vec::new();
        if let Some(clone) = &spec.clone {
            if clone.submodules {
                warnings.push(
                    "`submodules: true` is not supported yet; submodules were left out".to_string(),
                );
            }
            self.remote
                .fetch_commit(
                    &self.commit,
                    depth(clone.depth),
                    self.auth.as_ref(),
                    self.ref_hint.as_deref(),
                )
                .map_err(|e| format!("fetch: {e}"))?;
            let head = iwci_git::Head::from_ref(self.ref_hint.as_deref());
            let checkout = self
                .remote
                .checkout_repository_into(&self.commit, &builder, &clone.into, &head)
                .map_err(|e| format!("checkout: {e}"))?;
            for sub in &checkout.submodules {
                warnings.push(format!(
                    "submodule `{}` was left out of the checkout",
                    sub.path
                ));
            }
        }
        for dep in &spec.deps {
            let fetcher = self.fetcher.as_ref();
            let threads = self.threads.max(1);
            let (outcome, notes) = match dep.ecosystem {
                Ecosystem::Pnpm => {
                    let mut options = pnpm_options(&builder, dep);
                    // The registries are in the options, so in the key.
                    let key = options_key(Installer::Pnpm, &dep.dir, &options);
                    options.parallelism = threads;
                    env.extend(node_platform_env(options.native.as_ref()));
                    env.extend(iwci_deps::pnpm::env());
                    self.layers.install(&builder, &key, |layer| {
                        iwci_deps::pnpm::install(layer, &dep.dir, fetcher, &options)
                            .map(|_| Vec::new())
                    })
                }
                Ecosystem::Npm => {
                    let mut options = iwci_deps::npm::NpmOptions {
                        native: native_platform(dep),
                        parallelism: 0,
                        ..Default::default()
                    };
                    let key = options_key(Installer::Npm, &dep.dir, &options);
                    options.parallelism = threads;
                    env.extend(node_platform_env(options.native.as_ref()));
                    self.layers.install(&builder, &key, |layer| {
                        iwci_deps::npm::install(layer, &dep.dir, fetcher, &options).map(|report| {
                            report
                                .warnings
                                .iter()
                                .map(|warning| format!("npm in {}: {warning}", dep.dir))
                                .collect()
                        })
                    })
                }
                Ecosystem::Bun => {
                    let mut options = iwci_deps::bun::BunOptions {
                        native: native_platform(dep),
                        parallelism: 0,
                        ..Default::default()
                    };
                    let key = options_key(Installer::Bun, &dep.dir, &options);
                    options.parallelism = threads;
                    env.extend(node_platform_env(options.native.as_ref()));
                    self.layers.install(&builder, &key, |layer| {
                        iwci_deps::bun::install(layer, &dep.dir, fetcher, &options).map(|report| {
                            report
                                .warnings
                                .iter()
                                .map(|warning| format!("bun in {}: {warning}", dep.dir))
                                .collect()
                        })
                    })
                }
                Ecosystem::Go => {
                    let mut options = iwci_deps::go::GoOptions {
                        parallelism: 0,
                        ..Default::default()
                    };
                    let key = options_key(Installer::Go, &dep.dir, &options);
                    options.parallelism = threads;
                    env.extend(iwci_deps::go::env(&options));
                    self.layers.install(&builder, &key, |layer| {
                        iwci_deps::go::install(layer, &dep.dir, fetcher, &options)
                            .map(|_| Vec::new())
                    })
                }
                Ecosystem::Cargo => {
                    let mut options = iwci_deps::cargo::CargoOptions {
                        parallelism: 0,
                        ..Default::default()
                    };
                    let key = options_key(Installer::Cargo, &dep.dir, &options);
                    options.parallelism = threads;
                    env.extend(iwci_deps::cargo::env());
                    self.layers.install(&builder, &key, |layer| {
                        iwci_deps::cargo::install(layer, &dep.dir, fetcher, &options).map(
                            |report| {
                                report
                                    .unsupported
                                    .iter()
                                    .map(|u| format!("cargo in {}: {u:?} is not vendored", dep.dir))
                                    .collect()
                            },
                        )
                    })
                }
                Ecosystem::Pip => {
                    let mut options = iwci_deps::pip::PipOptions {
                        file: dep.file.clone(),
                        parallelism: 0,
                        ..Default::default()
                    };
                    let key = options_key(Installer::Pip, &dep.dir, &options);
                    options.parallelism = threads;
                    env.extend(iwci_deps::pip::env(&options));
                    path.extend(iwci_deps::pip::path(&options));
                    self.layers.install(&builder, &key, |layer| {
                        iwci_deps::pip::install(layer, &dep.dir, fetcher, &options)
                            .map(|report| report.warnings)
                    })
                }
                Ecosystem::Composer => {
                    let mut options = iwci_deps::composer::ComposerOptions {
                        parallelism: 0,
                        ..Default::default()
                    };
                    let key = options_key(Installer::Composer, &dep.dir, &options);
                    options.parallelism = threads;
                    let git = self.trees();
                    let git: &dyn iwci_deps::git::GitTrees = match &git {
                        Some(g) => g,
                        None => &iwci_deps::git::NoGit,
                    };
                    self.layers
                        .install(&builder, &key, |layer| {
                            iwci_deps::composer::install(layer, &dep.dir, fetcher, git, &options)
                                .map(|report| report.warnings)
                        })
                        .and_then(|done| {
                            // The autoloader reads the repository's own
                            // files, so it is written on every build rather
                            // than cached with the packages.
                            let autoload = iwci_deps::composer::dump_autoload(&builder, &dep.dir)
                                .map_err(|e| e.to_string())?;
                            warnings.extend(autoload.warnings);
                            Ok(done)
                        })
                }
                Ecosystem::Bundler => {
                    let mut options = iwci_deps::bundler::BundlerOptions {
                        ruby: dep.ruby.clone(),
                        without_extensions: dep.without_extensions.clone().unwrap_or_default(),
                        parallelism: 0,
                        ..Default::default()
                    };
                    let prebuilt = self.prebuilt.as_ref();
                    // What the prebuilt extensions are changes what an
                    // install writes, so it is part of the key.
                    let key =
                        options_key(Installer::Bundler, &dep.dir, &options).with(&prebuilt.key());
                    options.parallelism = threads;
                    env.extend(iwci_deps::bundler::env_for(&builder, &dep.dir));
                    let git = self.trees();
                    let git: &dyn iwci_deps::git::GitTrees = match &git {
                        Some(g) => g,
                        None => &iwci_deps::git::NoGit,
                    };
                    self.layers.install(&builder, &key, |layer| {
                        iwci_deps::bundler::install(
                            layer, &dep.dir, fetcher, git, prebuilt, &options,
                        )
                        .map(|report| report.warnings)
                    })
                }
            }
            .map_err(|e| format!("{} in {}: {e}", dep.ecosystem.name(), dep.dir))?;
            // Install scripts run after all (`install-scripts: true`): the
            // install's own word that they did not is no longer so.
            warnings.extend(
                notes
                    .into_iter()
                    .filter(|n| !(spec.install_scripts && n.ends_with(iwci_deps::SCRIPTS_NOT_RUN))),
            );
            installs.push(format!(
                "{} in {}: {}",
                dep.ecosystem.name(),
                dep.dir,
                match outcome {
                    iwci_deps::cache::Outcome::Memory => "cached (memory)",
                    iwci_deps::cache::Outcome::Disk => "cached (disk)",
                    iwci_deps::cache::Outcome::Installed => "installed",
                }
            ));
        }
        if spec.install_scripts {
            crate::install_scripts::run(self.scripts.as_ref(), &builder, spec, &mut installs)?;
        }
        // The platform a `native: true` install chose, as a file too: a
        // `node` started without the variable reads it there
        // (`node/host-platform.cjs`), since a tool may run its tasks with
        // only the variables they name (turbo's strict mode, its default).
        if let Some((_, platform)) = env.iter().find(|(k, _)| k == "IWCI_NODE_PLATFORM") {
            builder
                .write(NODE_PLATFORM_FILE, platform.as_bytes())
                .map_err(|e| format!("could not record the Node platform: {e}"))?;
        }
        Ok(BuiltWorkspace {
            snapshot: builder.freeze(),
            env,
            warnings,
            installs,
            path,
        })
    }
}

pub struct GitCommitter {
    pub remote: RemoteCache,
    pub head: String,
    pub identity: Identity,
}

impl Committer for GitCommitter {
    fn commit(&self, root: &str, changes: &[Change], message: &str) -> Result<String, String> {
        self.remote
            .commit_changes(
                &self.head,
                changes,
                root,
                message,
                &self.identity,
                &self.identity,
            )
            .map(|c| c.commit)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iwci_deps::git::GitTrees;
    use std::process::Command;

    fn git(dir: &std::path::Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    /// A pnpm project's `.npmrc` registries reach the installer, and its
    /// cache key, which used to fetch from the public registry whatever
    /// the project named.
    #[test]
    fn pnpm_registries_come_from_the_projects_npmrc() {
        let builder = SnapshotBuilder::new();
        let dep = DepSpec {
            ecosystem: Ecosystem::Pnpm,
            dir: "/app".into(),
            only: Some(vec!["web".into()]),
            file: None,
            ruby: None,
            without_extensions: None,
            native: false,
        };
        let default = pnpm_options(&builder, &dep);
        assert_eq!(default.registry, iwci_deps::pnpm::DEFAULT_REGISTRY);
        assert!(default.scoped_registries.is_empty());
        assert_eq!(default.only_importers, Some(vec!["web".to_string()]));
        assert_eq!(default.parallelism, 0);

        builder
            .write(
                "/app/.npmrc",
                b"registry=https://mirror.example.com/npm/\n@corp:registry=https://corp.example.com/\n",
            )
            .unwrap();
        let configured = pnpm_options(&builder, &dep);
        assert_eq!(configured.registry, "https://mirror.example.com/npm/");
        assert_eq!(
            configured
                .scoped_registries
                .get("@corp")
                .map(String::as_str),
            Some("https://corp.example.com/")
        );
        assert_ne!(
            options_key(Installer::Pnpm, &dep.dir, &default),
            options_key(Installer::Pnpm, &dep.dir, &configured)
        );
    }

    /// A package's commit, fetched over `file://` from a fixture repository,
    /// comes back file for file with its executable bits; a lock can never
    /// name a local repository.
    #[test]
    fn composer_packages_come_from_the_git_cache() {
        let root = std::env::temp_dir().join(format!("iwci-git-trees-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/A.php"), "<?php class A {}\n").unwrap();
        std::fs::write(repo.join("bin"), "#!/usr/bin/env php\n<?php\n").unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["add", "-A"]);
        git(&repo, &["update-index", "--chmod=+x", "bin"]);
        git(&repo, &["commit", "-qm", "one"]);
        let commit = git(&repo, &["rev-parse", "HEAD"]);
        let url = format!("file://{}", repo.display());

        let trees = CachedGitTrees {
            git: iwci_git::GitCache::new(root.join("cache")).unwrap(),
            allow_local: true,
        };
        let mut files = trees.files(&url, &commit).unwrap();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let summary: Vec<(&str, bool)> = files
            .iter()
            .map(|f| (f.path.as_str(), f.executable))
            .collect();
        assert_eq!(summary, [("bin", true), ("src/A.php", false)]);
        assert_eq!(files[1].data, b"<?php class A {}\n");
        assert!(trees.files(&url, &"0".repeat(40)).is_err());

        let locked = CachedGitTrees {
            allow_local: false,
            ..trees
        };
        let err = locked.files(&url, &commit).unwrap_err();
        assert!(err.contains("only https"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
