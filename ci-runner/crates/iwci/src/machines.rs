//! Jobs in a virtual machine: `platform: linux` and `platform: windows`.
//!
//! The scheduler treats such a job like any other up to the moment it
//! runs: its file system is the workspace's snapshot forked for it, with
//! the artifacts it is handed, what it is lent and the caches it restores
//! written in, exactly as for a job in an isolate. Only the execution
//! differs: instead of an isolate, [`Machines::run`] starts a machine,
//! gives it those files, runs the script, and writes what the job left
//! under [`MachineRun::collect`] back into the same file system. So
//! everything after (changes, `$IWCI_OUTPUT`, artifacts, downloads,
//! caches) reads the job's files as it always does, and the run's
//! `/tmp/workflow` comes and goes the same way.
//!
//! The machines themselves (QEMU, the images, the agent conversation) are
//! `iwci-vm`'s; `adapters::machines` puts the two together.

use std::path::{Path, PathBuf};

use iwci_spec::{PlannedJob, VmOs, VmSpec};
use iwci_vfs::{Entry, JobFs, Snapshot};

use crate::schedule::{Execution, OutputSink};

/// The runner's virtual machines, when it has any.
pub trait Machines: Send + Sync {
    /// The operating systems it has machines for.
    fn platforms(&self) -> Vec<VmOs>;

    /// What a machine of `os` takes of the runner's memory beyond the
    /// job's `memory:` (the emulator, the firmware, page tables), reserved
    /// with it.
    fn overhead(&self, os: VmOs) -> u64;

    /// Runs the job's script in a fresh machine, and writes what it left
    /// under `run.collect` into `run.fs` and what it left in the run's
    /// `/tmp/workflow` into `run.scratch` before it returns. An `Err` is
    /// the runner's failure (the machine did not start), never the job's.
    fn run(&self, run: MachineRun<'_>) -> Result<Execution, String>;
}

/// One job for [`Machines::run`].
pub struct MachineRun<'a> {
    pub job: &'a PlannedJob,
    pub vm: &'a VmSpec,
    /// The workspace's files, the same for every job of the workspace,
    /// and a key that names them for this commit: a machine image of them
    /// is made once and shared.
    pub workspace: &'a Snapshot,
    pub workspace_key: String,
    /// The job's files: the workspace's with what the job starts with
    /// written over them.
    pub fs: &'a JobFs,
    /// The run's `/tmp/workflow`, rooted at `/`.
    pub scratch: &'a JobFs,
    /// Every variable the job gets, secrets included, as for any job.
    pub env: Vec<(String, String)>,
    /// The job's working directory, a Unix path.
    pub cwd: String,
    /// What the scheduler reads from the job's files after it (see
    /// [`collect_paths`]).
    pub collect: Collecting,
    pub log: Option<OutputSink>,
    pub cancel: Option<iwci_runtime::Cancel>,
}

/// What a runner says when a job asks for machines it does not have.
pub fn missing(os: VmOs) -> String {
    let what = match os {
        VmOs::Linux => "Linux virtual machines",
        VmOs::Windows => "Windows virtual machines",
    };
    format!(
        "this runner has no {what} (`platform: {os}`): it needs KVM and the machine images, given with `--machines`. See the README's \"Platforms\"."
    )
}

/// What a job's machine sends back: what the scheduler reads from the
/// job's files once it has run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Collecting {
    /// Sent whole, ignored by git or not: `$IWCI_OUTPUT`, artifacts,
    /// downloads and caches. Sorted, each once, none inside another.
    pub paths: Vec<String>,
    /// The clone, when the job's changes count (`changes:`): sent without
    /// what git ignores in it, which is never a change
    /// ([`iwci_vm_proto::gitignore`]).
    pub repository: Option<String>,
}

impl Collecting {
    /// Everything the machine may send back.
    pub fn allowed(&self) -> Vec<String> {
        self.paths
            .iter()
            .cloned()
            .chain(self.repository.clone())
            .collect()
    }
}

/// What a job's machine sends back (see [`Collecting`]).
pub fn collect_paths(
    job: &PlannedJob,
    root: Option<&str>,
    output: &str,
    caches: bool,
) -> Collecting {
    let repository = root
        .filter(|_| !matches!(job.changes, iwci_spec::ChangePolicy::Ignore))
        .map(str::to_owned);
    let mut paths: Vec<String> = vec![output.to_string()];
    paths.extend(job.artifacts.iter().cloned());
    if let Some(downloads) = &job.downloads {
        paths.extend(downloads.paths.iter().cloned());
    }
    if caches {
        for cache in &job.caches {
            paths.extend(cache.paths.iter().cloned());
        }
    }
    paths.sort();
    paths.dedup();
    let mut out: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths {
        // Sorted, so a path's parent in the list comes before it.
        if !out.iter().any(|p| is_under(&path, p)) {
            out.push(path);
        }
    }
    Collecting {
        paths: out,
        repository,
    }
}

/// Whether `path` is `prefix` or below it.
pub fn is_under(path: &str, prefix: &str) -> bool {
    prefix == "/"
        || path == prefix
        || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

/// What a machine sent back for a job: what it deleted, then what it
/// wrote, each with its Unix mode when the machine has modes.
#[derive(Debug, Default)]
pub struct Collected {
    pub deleted: Vec<PathBuf>,
    pub entries: Vec<(Entry, Option<u32>)>,
}

/// Writes what a machine sent back into a job's files, as the job's own
/// writes: deletions first (a directory deleted and made again comes back
/// with only what was sent), then directories, files and links, then
/// modes. Only paths under one of `allowed` are taken: the machine is the
/// job's, and the job does not get to write elsewhere in the runner.
pub fn apply(fs: &JobFs, collected: &Collected, allowed: &[String]) -> Result<(), String> {
    let inside = |path: &Path| {
        path.to_str()
            .is_some_and(|p| allowed.iter().any(|a| is_under(p, a)))
    };
    for path in &collected.deleted {
        if !inside(path) {
            return Err(format!(
                "the machine deleted `{}`, which is outside what it was asked for",
                path.display()
            ));
        }
        remove_all(fs, path).map_err(|e| format!("`{}`: {e}", path.display()))?;
    }
    let modes = fs.modes();
    for (entry, mode) in &collected.entries {
        let path = match entry {
            Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => path,
        };
        // A parent of an allowed path (`/app` for `/app/out`) is only a
        // directory on the way.
        let parent_of_allowed = matches!(entry, Entry::Dir { .. })
            && path
                .to_str()
                .is_some_and(|p| allowed.iter().any(|a| is_under(a, p) && a.as_str() != p));
        if !inside(path) && !parent_of_allowed {
            return Err(format!(
                "the machine sent `{}`, which is outside what it was asked for",
                path.display()
            ));
        }
        // A file where a directory was, or the other way round: the old
        // one goes first.
        if let Ok(meta) = fs.as_dyn().symlink_metadata(path) {
            let replace = match entry {
                Entry::Dir { .. } => !meta.is_dir(),
                Entry::File { .. } | Entry::Symlink { .. } => meta.is_dir(),
            };
            if replace {
                remove_all(fs, path).map_err(|e| format!("`{}`: {e}", path.display()))?;
            }
        }
        fs.apply(std::slice::from_ref(entry))
            .map_err(|e| format!("`{}`: {e}", path.display()))?;
        if let Some(mode) = mode
            && !matches!(entry, Entry::Symlink { .. })
        {
            modes.set(path, *mode & 0o7777);
        }
    }
    Ok(())
}

/// Removes `path` and everything under it. A path already gone is fine.
fn remove_all(fs: &JobFs, path: &Path) -> Result<(), String> {
    let dyn_fs = fs.as_dyn();
    let Ok(meta) = dyn_fs.symlink_metadata(path) else {
        return Ok(());
    };
    if meta.is_dir() {
        let children: Vec<PathBuf> = dyn_fs
            .read_dir(path)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path)
            .collect();
        for child in children {
            remove_all(fs, &child)?;
        }
        fs.remove_dir(path).map_err(|e| e.to_string())
    } else {
        fs.remove_file(path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(yaml: &str) -> PlannedJob {
        let plan = iwci_spec::parse(yaml, &Default::default()).unwrap();
        plan.static_jobs().next().unwrap().clone()
    }

    #[test]
    fn collects_what_the_scheduler_reads_and_nothing_twice() {
        let job = job("name: t
jobs:
  a:
    platform: linux
    run: make
    changes: fail
    artifacts: [out, out/bin, dist]
    downloads: [/root/report.xml]
    cache: { key: k, paths: [/root/.cache, /app/node_modules] }
");
        // What is in the clone is asked for on its own too: the clone
        // comes back without what git ignores, and artifacts and caches
        // are often there (`dist`, `node_modules`).
        assert_eq!(
            collect_paths(&job, Some("/app"), "/iwci/output", true),
            Collecting {
                paths: [
                    "/app/dist",
                    "/app/node_modules",
                    "/app/out",
                    "/iwci/output",
                    "/root/.cache",
                    "/root/report.xml"
                ]
                .map(String::from)
                .to_vec(),
                repository: Some("/app".into()),
            }
        );
        // Without `changes:` the clone itself is not read, and without a
        // cache store neither are the cache paths.
        let job = super::tests::job(
            "name: t\njobs:\n  a:\n    platform: linux\n    run: make\n    artifacts: [out]\n    cache: { key: k, paths: [/root/.cache] }\n",
        );
        assert_eq!(
            collect_paths(&job, Some("/app"), "/iwci/output", false),
            Collecting {
                paths: vec!["/app/out".into(), "/iwci/output".into()],
                repository: None,
            }
        );
    }

    fn snapshot() -> Snapshot {
        let b = iwci_vfs::SnapshotBuilder::new();
        b.write("/app/keep.txt", b"keep").unwrap();
        b.write("/app/gone.txt", b"gone").unwrap();
        b.write("/app/dir/a.txt", b"a").unwrap();
        b.write("/app/dir/b.txt", b"b").unwrap();
        b.write("/app/file-then-dir", b"x").unwrap();
        b.write("/etc/passwd", b"root").unwrap();
        b.freeze()
    }

    #[test]
    fn applies_deletions_then_writes_then_modes() {
        let fs = snapshot().fork();
        let collected = Collected {
            deleted: vec!["/app/gone.txt".into(), "/app/dir".into()],
            entries: vec![
                (
                    Entry::Dir {
                        path: "/app".into(),
                    },
                    Some(0o755),
                ),
                (
                    Entry::Dir {
                        path: "/app/dir".into(),
                    },
                    Some(0o755),
                ),
                (
                    Entry::File {
                        path: "/app/dir/c.txt".into(),
                        data: b"c".to_vec().into(),
                    },
                    Some(0o644),
                ),
                (
                    Entry::File {
                        path: "/app/run.sh".into(),
                        data: b"#!/bin/sh".to_vec().into(),
                    },
                    Some(0o100755),
                ),
                (
                    Entry::Dir {
                        path: "/app/file-then-dir".into(),
                    },
                    None,
                ),
                (
                    Entry::Symlink {
                        path: "/app/link".into(),
                        target: "keep.txt".into(),
                    },
                    Some(0o777),
                ),
            ],
        };
        apply(&fs, &collected, &["/app".into()]).unwrap();
        assert_eq!(fs.read("/app/keep.txt").unwrap(), b"keep");
        assert!(fs.read("/app/gone.txt").is_err());
        assert!(fs.read("/app/dir/a.txt").is_err());
        assert_eq!(fs.read("/app/dir/c.txt").unwrap(), b"c");
        assert!(
            fs.as_dyn()
                .symlink_metadata(Path::new("/app/file-then-dir"))
                .unwrap()
                .is_dir()
        );
        assert_eq!(fs.modes().get(Path::new("/app/run.sh")), Some(0o755));

        let changes: Vec<String> = fs
            .changes("/app")
            .iter()
            .map(|c| c.path().display().to_string())
            .collect();
        // A file made a directory is not a change of its own, as when a
        // job in an isolate does `rm f && mkdir f`: `JobFs::changes` lists
        // files.
        assert_eq!(
            changes,
            [
                "/app/dir/a.txt",
                "/app/dir/b.txt",
                "/app/dir/c.txt",
                "/app/gone.txt",
                "/app/run.sh"
            ]
        );
    }

    #[test]
    fn refuses_what_it_was_not_asked_for() {
        let fs = snapshot().fork();
        let write = Collected {
            deleted: vec![],
            entries: vec![(
                Entry::File {
                    path: "/etc/passwd".into(),
                    data: b"evil".to_vec().into(),
                },
                None,
            )],
        };
        assert!(apply(&fs, &write, &["/app".into()]).is_err());
        assert_eq!(fs.read("/etc/passwd").unwrap(), b"root");
        let delete = Collected {
            deleted: vec!["/etc".into()],
            entries: vec![],
        };
        assert!(apply(&fs, &delete, &["/app".into()]).is_err());
        // `/apple` is not under `/app`.
        let sibling = Collected {
            deleted: vec![],
            entries: vec![(
                Entry::File {
                    path: "/apple".into(),
                    data: b"x".to_vec().into(),
                },
                None,
            )],
        };
        assert!(apply(&fs, &sibling, &["/app".into()]).is_err());
    }
}
