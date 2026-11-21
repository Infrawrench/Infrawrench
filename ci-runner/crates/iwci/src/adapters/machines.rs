//! The runner's virtual machines (`--machines`): [`crate::machines::Machines`]
//! over `iwci-vm`.
//!
//! A job's machine is given its files and the run's scratch, runs its
//! script, and sends back what it left under the paths the scheduler will
//! read; this writes that into the job's files and the scratch, as the
//! job's own writes, and reports the machine's run as the job's execution.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use iwci_spec::{Action, VmOs};
use iwci_vfs::Entry;
use iwci_vm::{Host, Os, Shell};

use crate::machines::{Collected, MachineRun, Machines, apply};
use crate::schedule::{Execution, MachineUsage};

pub struct VmMachines {
    pub host: Host,
    /// Stop a job that prints nothing and uses no CPU for this long, as an
    /// isolate's job is stopped.
    pub stall_after: Option<Duration>,
}

fn os(os: VmOs) -> Os {
    match os {
        VmOs::Linux => Os::Linux,
        VmOs::Windows => Os::Windows,
    }
}

fn collected(c: iwci_vm::Collected) -> Collected {
    Collected {
        deleted: c.deleted,
        entries: c.entries,
    }
}

impl Machines for VmMachines {
    fn platforms(&self) -> Vec<VmOs> {
        self.host
            .platforms()
            .into_iter()
            .map(|o| match o {
                Os::Linux => VmOs::Linux,
                Os::Windows => VmOs::Windows,
            })
            .collect()
    }

    fn overhead(&self, vm: VmOs) -> u64 {
        self.host.overhead(os(vm))
    }

    fn env_caches(&self, vm: VmOs) -> Vec<crate::env_cache::EnvCacheDecl> {
        let Some((image, caches)) = self.host.caches(os(vm)) else {
            return Vec::new();
        };
        caches
            .iter()
            .map(|c| crate::env_cache::EnvCacheDecl {
                name: c.name.clone(),
                path: c.path.clone(),
                max_bytes: c.max_bytes,
                // Kept across rebuilds of the image, which keep its
                // libraries' ABI (the same Ubuntu release); a cache is
                // never read by another image.
                environment: format!("machine:{image}"),
            })
            .collect()
    }

    fn run_script(
        &self,
        run: crate::machines::ScriptRun<'_>,
    ) -> Result<crate::machines::ScriptOutcome, String> {
        // No `/tmp/workflow`: an empty one, copied in and out.
        let scratch = iwci_vfs::SnapshotBuilder::new().freeze().fork();
        let settle = || Ok(());
        let never = || false;
        let outcome = self.host.run(iwci_vm::Job {
            id: run.id,
            os: Os::Linux,
            memory_bytes: run.memory_bytes,
            cpus: None,
            timeout: run.timeout,
            network: true,
            shell: Shell::Bash,
            script: run.script,
            env: run.env,
            cwd: run.cwd,
            workspace: Some((run.workspace_key.as_str(), run.workspace)),
            fs: run.fs,
            scratch: iwci_vm::Scratch {
                live: None,
                files: &scratch,
                settle: &settle,
            },
            scratch_at: iwci_spec::SCRATCH_PATH,
            collect: run.collect,
            repository: None,
            output: None,
            cancelled: &never,
            stall_after: self.stall_after,
            output_cap: iwci_runtime::DEFAULT_OUTPUT_CAP,
        })?;
        let mut stderr = outcome.stderr;
        for note in outcome.notes {
            stderr.push_str(&format!("[iwci] {note}\n"));
        }
        Ok(crate::machines::ScriptOutcome {
            exit_code: outcome.exited.map(|e| e.code),
            stdout: outcome.stdout,
            stderr,
            boot_ms: outcome.boot_ms,
            collected: collected(outcome.files),
        })
    }

    fn run(&self, run: MachineRun<'_>) -> Result<Execution, String> {
        let Action::Script { script } = &run.job.action else {
            return Err("a job on a virtual machine runs a `run:` script".into());
        };
        let shell = Shell::parse(&run.vm.shell)
            .ok_or_else(|| format!("`{}` is not a shell a machine has", run.vm.shell))?;
        let cancel = run.cancel.clone();
        let cancelled = move || cancel.as_ref().is_some_and(|c| c.is_cancelled());
        let sink = run.log.clone();
        let output = move |err: bool, data: &[u8]| {
            if let Some(sink) = &sink {
                sink(err, data);
            }
        };
        let scratch = run.scratch;
        let settle = move || scratch.settle();
        let outcome = self.host.run(iwci_vm::Job {
            id: &run.job.id,
            os: os(run.vm.os),
            memory_bytes: run.job.memory_bytes,
            // The scheduler has already cut it to what this runner holds.
            cpus: run.job.cpus,
            timeout: run.job.timeout,
            network: run.job.network,
            shell,
            script,
            env: run.env,
            cwd: &run.cwd,
            workspace: Some((run.workspace_key.as_str(), run.workspace)),
            fs: run.fs,
            // Served to the machine as the job's view when it can be: it
            // then waits for another runner's file only when the job opens
            // it, and what the job writes is shared as it is closed. A
            // copy otherwise, which needs everything here first.
            scratch: iwci_vm::Scratch {
                live: Some(run.scratch.as_dyn()),
                files: run.scratch.fs(),
                settle: &settle,
            },
            scratch_at: iwci_spec::SCRATCH_PATH,
            collect: &run.collect.paths,
            repository: run.collect.repository.as_deref(),
            output: Some(&output),
            cancelled: &cancelled,
            stall_after: self.stall_after,
            output_cap: iwci_runtime::DEFAULT_OUTPUT_CAP,
        })?;

        // What the job left, as its own writes: the scheduler reads its
        // changes, outputs, artifacts, downloads and caches from here.
        let mut notes = outcome.notes;
        if let Err(e) = apply(run.fs, &collected(outcome.files), &run.collect.allowed()) {
            notes.push(format!(
                "what the machine sent back could not all be kept: {e}"
            ));
        }
        let scratch = collected(outcome.scratch);
        if let Err(e) = apply(run.scratch.fs(), &scratch, &["/".into()]) {
            notes.push(format!("/tmp/workflow: {e}"));
        }
        // The job's own writes, for the other runners of a split run.
        run.scratch
            .wrote(
                scratch
                    .deleted
                    .iter()
                    .map(PathBuf::as_path)
                    .chain(scratch.entries.iter().map(|(entry, _)| match entry {
                        Entry::Dir { path }
                        | Entry::File { path, .. }
                        | Entry::Symlink { path, .. } => path.as_path(),
                    })),
            );
        let exited = outcome.exited.unwrap_or_default();
        let mut stderr = outcome.stderr;
        for note in notes {
            stderr.push_str(&format!("[iwci] {note}\n"));
        }
        let held = run.job.memory_bytes;
        Ok(Execution {
            exit_code: if outcome.exited.is_some() {
                exited.code
            } else {
                iwci_runtime::TIMEOUT_EXIT_CODE
            },
            stdout: outcome.stdout,
            stderr,
            timed_out: outcome.timed_out,
            stalled_after: outcome.stalled_after,
            out_of_memory: exited.oom_killed,
            peak_memory_bytes: exited.peak_memory_bytes,
            // A machine holds its whole memory for as long as it runs:
            // what the job reserves next time is all of it.
            held_memory_bytes: held,
            service_failure: None,
            cancelled: outcome.cancelled,
            sandbox: None,
            machine: Some(MachineUsage {
                os: run.vm.os.name().into(),
                image: if outcome.image.is_empty() {
                    run.vm.image.clone()
                } else {
                    outcome.image
                },
                arch: outcome.arch,
                boot_ms: outcome.boot_ms,
                transfer_ms: outcome.transfer_ms,
                reserved_mib: self.host.overhead(os(run.vm.os)) >> 20,
                cpu_ms: outcome.cpu_ms,
            }),
        })
    }
}

/// `--machines <dir>` (or `IWCI_MACHINES`): the machine images, as
/// `ci-runner/images/` builds them. Each kind of machine the host cannot
/// run (no KVM, no image, no QEMU) is left off with a line saying why,
/// rather than stopping the runner.
pub fn open(
    dir: std::path::PathBuf,
    cache: std::path::PathBuf,
    cpus: u32,
    stall_after: Option<Duration>,
    runtime: &iwci_runtime::Runtime,
) -> Option<Arc<dyn Machines>> {
    #[cfg(not(target_os = "linux"))]
    let _ = runtime;
    let host = Host::open(iwci_vm::Config {
        dir,
        cache,
        qemu: std::env::var_os("IWCI_QEMU").map(Into::into),
        qemu_img: std::env::var_os("IWCI_QEMU_IMG").map(Into::into),
        mkfs_erofs: std::env::var_os("IWCI_MKFS_EROFS").map(Into::into),
        cpus,
        workspace_cache_bytes: 16 << 30,
        #[cfg(target_os = "linux")]
        outside: runtime.outside(),
    });
    for problem in host.problems() {
        eprintln!("iwci: machines: {problem}");
    }
    if host.platforms().is_empty() {
        return None;
    }
    Some(Arc::new(VmMachines { host, stall_after }))
}
