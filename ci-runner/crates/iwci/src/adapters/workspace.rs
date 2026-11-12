//! Building a workspace (clone, then dependencies) and committing a job's
//! changes, over `iwci-git` and `iwci-deps`.

use std::sync::Arc;

use iwci_deps::fetch::Fetcher;
use iwci_git::{Identity, RemoteCache};
use iwci_spec::{CloneDepth, Ecosystem, WorkspaceSpec};
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
    /// Where Composer packages without a dist hash are fetched by commit.
    pub git: Option<iwci_git::GitCache>,
}

/// Composer packages' git commits, through the run's git cache. The commit
/// id is what verifies them: gix checks every object it receives against
/// its id, so the tree read back is the one the lock names.
pub struct CachedGitTrees {
    pub git: iwci_git::GitCache,
    /// Tests reach fixture repositories over `file://`; a lock never may,
    /// or it could read repositories on the runner's own disk.
    pub allow_local: bool,
}

impl iwci_deps::composer::GitTrees for CachedGitTrees {
    fn files(&self, url: &str, commit: &str) -> Result<Vec<iwci_deps::composer::TreeFile>, String> {
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
            files.push(iwci_deps::composer::TreeFile {
                path: relative.to_string_lossy().into_owned(),
                data,
                executable: tree.mode(&path).is_some_and(|m| m & 0o111 != 0),
            });
        }
        Ok(files)
    }
}

/// A cache key from an installer's options, without the thread count,
/// which changes how fast an install runs and never what it writes.
fn options_key(kind: &str, dir: &str, options: &impl std::fmt::Debug) -> String {
    format!("{kind}\0{dir}\0{options:?}")
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
            let checkout = self
                .remote
                .checkout_into(&self.commit, &builder, &clone.into)
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
                    let mut options = iwci_deps::pnpm::PnpmOptions {
                        only_importers: dep.only.clone(),
                        parallelism: 0,
                        ..Default::default()
                    };
                    let key = options_key("pnpm", &dep.dir, &options);
                    options.parallelism = threads;
                    self.layers.install(&builder, &key, |layer| {
                        iwci_deps::pnpm::install(layer, &dep.dir, fetcher, &options)
                            .map(|_| Vec::new())
                    })
                }
                Ecosystem::Go => {
                    let mut options = iwci_deps::go::GoOptions {
                        parallelism: 0,
                        ..Default::default()
                    };
                    let key = options_key("go", &dep.dir, &options);
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
                    let key = options_key("cargo", &dep.dir, &options);
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
                    let key = options_key("pip", &dep.dir, &options);
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
                    let key = options_key("composer", &dep.dir, &options);
                    options.parallelism = threads;
                    let git = self.git.clone().map(|git| CachedGitTrees {
                        git,
                        allow_local: false,
                    });
                    let git: &dyn iwci_deps::composer::GitTrees = match &git {
                        Some(g) => g,
                        None => &iwci_deps::composer::NoGit,
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
            }
            .map_err(|e| format!("{} in {}: {e}", dep.ecosystem.name(), dep.dir))?;
            warnings.extend(notes);
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
    use iwci_deps::composer::GitTrees;
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
