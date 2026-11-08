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
