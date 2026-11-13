//! `using:` resolution and execution over `iwci-store` and `iwci-runtime`.

use std::sync::Arc;

use iwci_runtime::{
    Invocation as RtInvocation, Limits, PathCommand, Ready, Runtime, Service, ServiceProgram,
    WasmModule, WebcPackage,
};
use iwci_spec::{Action, ReadyCheck, ToolRef};
use iwci_store::{Abi, Catalog, RepoId, Resolved};

use crate::schedule::{Execution, Executor, Invocation, ServiceRun, Tools};

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

    fn env_caches(&self, tool: &Resolved) -> Vec<crate::env_cache::EnvCacheDecl> {
        let Resolved::Env { manifest, .. } = tool else {
            return Vec::new();
        };
        manifest
            .caches
            .iter()
            .map(|c| crate::env_cache::EnvCacheDecl {
                name: c.name.clone(),
                path: c.path.clone(),
                max_bytes: c.max_bytes,
                environment: format!("{}@{}", manifest.name, manifest.version),
            })
            .collect()
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
        path_tools: &[Arc<Resolved>],
        services: &[ServiceRun<'_, Resolved>],
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
        let commands = path_commands(path_tools, inv.fs, &mut env)?;
        prepend_path(&mut env, inv.path);
        let services = services
            .iter()
            .map(|s| service(s, inv.fs))
            .collect::<Result<Vec<_>, _>>()?;
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
            scratch: Some(inv.scratch.as_dyn()),
            commands,
            internet: inv.job.network,
            modes: inv.fs.modes(),
            services,
            cancel: inv.cancel.clone(),
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
                    Abi::TscHost if !invocation.services.is_empty() => {
                        return Err(format!(
                            "`{}` runs through the tsc host, which has no network or processes for services; start them for a job in an environment instead",
                            manifest.name
                        ));
                    }
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
                            stalled_after: None,
                            out_of_memory: o.out_of_memory,
                            service_failure: None,
                            cancelled: o.cancelled,
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
                            stalled_after: o.stalled_after.map(|d| d.as_secs()),
                            out_of_memory: o.out_of_memory,
                            service_failure: o.service_failure,
                            cancelled: o.cancelled,
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
                let (webcs, entry) = environment(manifest, packages);
                let o = self
                    .runtime
                    .run_script(&webcs, entry, script, invocation)
                    .map_err(|e| e.to_string())?;
                Execution {
                    exit_code: o.exit_code,
                    stdout: lossy(&o.stdout),
                    stderr: with_error(lossy(&o.stderr), o.error),
                    timed_out: o.timed_out,
                    stalled_after: o.stalled_after.map(|d| d.as_secs()),
                    out_of_memory: o.out_of_memory,
                    service_failure: o.service_failure,
                    cancelled: o.cancelled,
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

/// An environment's packages, and the shell that runs its scripts.
fn environment(
    manifest: &iwci_store::EnvManifest,
    packages: &[iwci_store::Blob],
) -> (Vec<WebcPackage>, &'static str) {
    let webcs = manifest
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
    (webcs, entry)
}

/// One of the job's `services:` for the runtime: an environment with its
/// script, or a tool with its arguments, its manifest's default
/// environment under its own.
fn service(run: &ServiceRun<'_, Resolved>, fs: &iwci_vfs::JobFs) -> Result<Service, String> {
    let planned = run.service;
    let fail = |e: String| format!("service `{}`: {e}", planned.name);
    let defaults = match run.tool.as_ref() {
        Resolved::Tool { manifest, .. } => &manifest.env,
        Resolved::Env { manifest, .. } => &manifest.env,
    };
    let mut env: Vec<(String, String)> = defaults
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (k, v) in &run.env {
        env.retain(|(existing, _)| existing != k);
        env.push((k.clone(), v.clone()));
    }
    let program = match (run.tool.as_ref(), &planned.action) {
        (
            Resolved::Tool {
                manifest,
                module,
                files,
                ..
            },
            Action::Args { args },
        ) => {
            if manifest.abi == Abi::TscHost {
                return Err(fail(format!(
                    "`{}` runs through the tsc host, so it cannot be a service",
                    manifest.name
                )));
            }
            for (path, blob) in files {
                fs.write(path, &blob.bytes)
                    .map_err(|e| fail(e.to_string()))?;
            }
            ServiceProgram::Command {
                module: WasmModule::with_sha256(
                    manifest.name.clone(),
                    sha256_bytes(&module.sha256).map_err(fail)?,
                    module.bytes.clone(),
                ),
                args: manifest.args.iter().chain(args).cloned().collect(),
            }
        }
        (
            Resolved::Env {
                manifest, packages, ..
            },
            Action::Script { script },
        ) => {
            let (packages, entry) = environment(manifest, packages);
            ServiceProgram::Script {
                packages,
                entry: entry.into(),
                script: script.clone(),
            }
        }
        // Validation pairs them, as for a job.
        (Resolved::Tool { .. }, Action::Script { .. }) => {
            return Err(fail("a tool cannot run a script".into()));
        }
        (Resolved::Env { .. }, Action::Args { .. }) => {
            return Err(fail("an environment needs a `run:` script".into()));
        }
    };
    Ok(Service {
        name: planned.name.clone(),
        program,
        env,
        ready: match &planned.ready.check {
            ReadyCheck::Started => Ready::Started,
            ReadyCheck::Port { port } => Ready::Port(*port),
            ReadyCheck::Log { pattern } => Ready::Log(pattern.clone()),
            ReadyCheck::Command { script } => Ready::Command(script.clone()),
        },
        ready_timeout: planned.ready.timeout,
    })
}

/// The job's `tools:` as commands for its script: each tool's module,
/// named after the tool. A tool's data files are written as they would be
/// for a job of its own, and its default environment fills in variables the
/// job does not set.
fn path_commands(
    tools: &[Arc<Resolved>],
    fs: &iwci_vfs::JobFs,
    env: &mut Vec<(String, String)>,
) -> Result<Vec<PathCommand>, String> {
    let mut commands = Vec::with_capacity(tools.len());
    for tool in tools {
        let Resolved::Tool {
            manifest,
            module,
            files,
            ..
        } = tool.as_ref()
        else {
            return Err("`tools:` takes tools, not environments".into());
        };
        if manifest.abi == Abi::TscHost {
            return Err(format!(
                "`{}` reads files through the tsc-host ABI, so it only runs as a job of its own (`using:`), not as a command in a script",
                manifest.name
            ));
        }
        if !manifest.args.is_empty() {
            return Err(format!(
                "`{}` has default arguments, which a command on PATH cannot carry; run it as a job of its own",
                manifest.name
            ));
        }
        for (path, blob) in files {
            fs.write(path, &blob.bytes).map_err(|e| e.to_string())?;
        }
        for (k, v) in &manifest.env {
            if !env.iter().any(|(existing, _)| existing == k) {
                env.push((k.clone(), v.clone()));
            }
        }
        commands.push(PathCommand {
            name: manifest.name.clone(),
            module: WasmModule::with_sha256(
                manifest.name.clone(),
                sha256_bytes(&module.sha256)?,
                module.bytes.clone(),
            ),
        });
    }
    Ok(commands)
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

/// Puts `dirs` (what the workspace's installs provide, such as pip's
/// console scripts) first on `PATH`, ahead of whatever the environment's
/// manifest or the job set, or of the runtime's default.
fn prepend_path(env: &mut Vec<(String, String)>, dirs: &[String]) {
    if dirs.is_empty() {
        return;
    }
    let current = env.iter().rev().find(|(k, _)| k == "PATH").map_or_else(
        || iwci_runtime::DEFAULT_PATH.to_string(),
        |(_, v)| v.clone(),
    );
    let mut parts: Vec<&str> = dirs.iter().map(String::as_str).collect();
    parts.extend(
        current
            .split(':')
            .filter(|p| !p.is_empty() && !dirs.iter().any(|d| d == p)),
    );
    let joined = parts.join(":");
    env.retain(|(k, _)| k != "PATH");
    env.push(("PATH".to_string(), joined));
}
