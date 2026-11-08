//! `using:` resolution and execution over `iwci-store` and `iwci-runtime`.

use std::sync::Arc;

use iwci_runtime::{Invocation as RtInvocation, Limits, Runtime, WasmModule, WebcPackage};
use iwci_spec::{Action, ToolRef};
use iwci_store::{Abi, Catalog, RepoId, Resolved};

use crate::schedule::{Execution, Executor, Invocation, Tools};

/// One per run: the catalog caches listings, manifests and blobs, so a
/// matrix of twenty jobs lists R2 once.
pub struct StoreTools {
    pub catalog: Catalog,
    pub repo: RepoId,
}

impl Tools for StoreTools {
    type Tool = Resolved;

    fn resolve(&self, tool: &ToolRef) -> Result<Arc<Resolved>, String> {
        // The spec and the store each parse references; the store's parser
        // is the one that decides version matching, so hand it the text.
        let reference: iwci_store::ToolRef =
            tool.to_string().parse().map_err(|e| format!("{e}"))?;
        self.catalog
            .resolve(&reference, &self.repo)
            .map(Arc::new)
            .map_err(|e| e.to_string())
    }
}

pub struct RuntimeExecutor {
    pub runtime: Arc<Runtime>,
}

fn sha256_bytes(hex_digest: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(hex_digest).map_err(|e| e.to_string())?;
    bytes
        .try_into()
        .map_err(|_| "a sha256 is 32 bytes".to_string())
}

impl Executor<Resolved> for RuntimeExecutor {
    fn execute(
        &self,
        tool: &Resolved,
        action: &Action,
        inv: Invocation<'_>,
    ) -> Result<Execution, String> {
        let limits = Limits {
            timeout: inv.job.timeout,
            memory_bytes: inv.job.memory_bytes,
        };
        let manifest_env = match tool {
            Resolved::Tool { manifest, .. } => &manifest.env,
            Resolved::Env { manifest, .. } => &manifest.env,
        };
        // The manifest's defaults first, so the job's own `env:` wins.
        let mut env: Vec<(String, String)> = manifest_env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (k, v) in inv.env {
            env.retain(|(existing, _)| *existing != k);
            env.push((k, v));
        }
        let mut invocation = RtInvocation {
            args: Vec::new(),
            env,
            cwd: inv.job.cwd.clone(),
            fs: inv.fs.as_dyn(),
            limits,
            log: inv.log.map(|sink| {
                let log: iwci_runtime::LogSink = Arc::new(move |stream, data: &[u8]| {
                    sink(stream == iwci_runtime::Stream::Stderr, data)
                });
                log
            }),
        };

        let outcome = match (tool, action) {
            (
                Resolved::Tool {
                    manifest,
                    module,
                    files,
                    ..
                },
                Action::Args { args },
            ) => {
                // Data files a tool ships with (a default config, a rule set)
                // are written outside the clone, so they never show up as a
                // job's changes.
                for (path, blob) in files {
                    inv.fs.write(path, &blob.bytes).map_err(|e| e.to_string())?;
                }
                invocation.args = manifest.args.iter().chain(args).cloned().collect();
                let module = WasmModule::with_sha256(
                    manifest.name.clone(),
                    sha256_bytes(&module.sha256)?,
                    module.bytes.clone(),
                );
                match manifest.abi {
                    Abi::TscHost => {
                        let o = self
                            .runtime
                            .run_tsc(&module, invocation, false)
                            .map_err(|e| e.to_string())?;
                        Execution {
                            exit_code: o.exit_code,
                            stdout: lossy(&o.stdout),
                            stderr: with_error(lossy(&o.stderr), o.error),
                            timed_out: o.timed_out,
                            out_of_memory: o.out_of_memory,
                        }
                    }
                    Abi::Wasi | Abi::Wasix => {
                        let o = self
                            .runtime
                            .run_command(&module, invocation)
                            .map_err(|e| e.to_string())?;
                        Execution {
                            exit_code: o.exit_code,
                            stdout: lossy(&o.stdout),
                            stderr: with_error(lossy(&o.stderr), o.error),
                            timed_out: o.timed_out,
                            out_of_memory: o.out_of_memory,
                        }
                    }
                }
            }
            (
                Resolved::Env {
                    manifest, packages, ..
                },
                Action::Script { script },
            ) => {
                let webcs: Vec<WebcPackage> = manifest
                    .packages
                    .iter()
                    .zip(packages)
                    .map(|(pkg, blob)| {
                        WebcPackage::new(
                            pkg.name.clone(),
                            pkg.version.to_string(),
                            blob.bytes.clone(),
                        )
                    })
                    .collect();
                let entry = match manifest.entry {
                    iwci_store::EnvEntry::Bash => "bash",
                };
                let o = self
                    .runtime
                    .run_script(&webcs, entry, script, invocation)
                    .map_err(|e| e.to_string())?;
                Execution {
                    exit_code: o.exit_code,
                    stdout: lossy(&o.stdout),
                    stderr: with_error(lossy(&o.stderr), o.error),
                    timed_out: o.timed_out,
                    out_of_memory: o.out_of_memory,
                }
            }
            // Validation pairs `env:` with `run:` and tools with `args:`, and
            // the store resolves each kind to the matching variant.
            (Resolved::Tool { .. }, Action::Script { .. }) => {
                return Err("a tool cannot run a script".into());
            }
            (Resolved::Env { .. }, Action::Args { .. }) => {
                return Err("an environment needs a `run:` script".into());
            }
        };
        Ok(outcome)
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn with_error(mut stderr: String, error: Option<String>) -> String {
    if let Some(e) = error {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str(&e);
    }
    stderr
}
