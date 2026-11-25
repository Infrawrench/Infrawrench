//! An environment's own caches (`caches` in its manifest, such as Go's
//! build cache): what a job adds to one of its directories is restored
//! before the job's next run and saved after it passes, with no `cache:`
//! entry. They go through the same [`Caches`] store as `cache:`, so they
//! are scoped the same way (a pull request never writes where the default
//! branch reads) and count against the same quota.
//!
//! The directory holds only what the job added: the runtime mounts the
//! environment's own files under the job's file system rather than in it
//! (`iwci-runtime`'s `job_root`), so what the packages ship is never saved.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use iwci_vfs::{Entry, JobFs};
use sha2::Digest;

use crate::schedule::Caches;

/// One cache an environment declares, as the scheduler needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvCacheDecl {
    /// What `env-cache:` and the report call it.
    pub name: String,
    /// The directory, an absolute guest path.
    pub path: String,
    /// The most a saved cache may hold, in bytes of file content.
    pub max_bytes: u64,
    /// The environment and its exact version, `go@1.27.6`: a cache is only
    /// ever read back by the build that wrote it.
    pub environment: String,
}

/// The store key of `cache` for job `job`: one entry per repository and
/// scope (which the store adds), environment version, runner architecture
/// (a V8 code cache is only good for the build and machine that wrote it)
/// and job. Saving replaces it, so a scope holds the newest run's.
pub fn key(cache: &EnvCacheDecl, job: &str) -> String {
    format!(
        "env-cache/{}/{}/{}/{job}",
        cache.environment,
        std::env::consts::ARCH,
        cache.name
    )
}

/// The path of the job's `cache:` entry that covers `path`, or that lies
/// under it, if any. The environment's cache of that directory is then
/// left to the job's: restored after it, it wrote its own copy over the
/// files the job's key chose, and its directory, collected back from a
/// machine to be compared, undid the exact hit that keeps a job cache in
/// the machine (guava's `~/.m2/repository`, 190 MB in 5,000 files, came
/// back and was saved again after every warm run, Maven having rewritten
/// files in it).
pub fn cached_by_job<'a>(path: &str, caches: &'a [iwci_spec::CacheSpec]) -> Option<&'a str> {
    caches
        .iter()
        .flat_map(|c| c.paths.iter())
        .find(|p| crate::machines::is_under(path, p) || crate::machines::is_under(p, path))
        .map(String::as_str)
}

/// What one entry was when restored, to tell what a run changed.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Dir,
    File([u8; 16]),
    Symlink(PathBuf),
}

fn kind(entry: &Entry) -> (PathBuf, Kind) {
    match entry {
        Entry::Dir { path } => (path.clone(), Kind::Dir),
        Entry::File { path, data } => {
            let digest = sha2::Sha256::digest(data.as_ref());
            let mut short = [0u8; 16];
            short.copy_from_slice(&digest[..16]);
            (path.clone(), Kind::File(short))
        }
        Entry::Symlink { path, target } => (path.clone(), Kind::Symlink(target.clone())),
    }
}

fn path_of(entry: &Entry) -> &PathBuf {
    match entry {
        Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => path,
    }
}

fn file_bytes(entries: &[Entry]) -> u64 {
    entries
        .iter()
        .map(|e| match e {
            Entry::File { data, .. } => data.len() as u64,
            _ => 0,
        })
        .sum()
}

fn kib(bytes: u64) -> String {
    format!("{} KiB", bytes.div_ceil(1024))
}

/// One of the job's environment caches, from restore to save.
pub struct Active {
    decl: EnvCacheDecl,
    key: String,
    /// The most it may save: its `max-bytes`, or a quarter of the job's
    /// memory when that is less, since a restored cache is held in the
    /// job's memory like any other file.
    limit: u64,
    /// Each entry the restore wrote, as it was.
    restored: BTreeMap<PathBuf, Kind>,
}

impl Active {
    /// The directory, which is the cache's and never a change to the
    /// repository.
    pub fn path(&self) -> &str {
        &self.decl.path
    }
}

/// Restores `cache` for `job` into `fs`, a job with `memory_bytes` of
/// memory. A miss, or a store that cannot be read, starts the job without
/// it.
pub fn restore(
    store: &dyn Caches,
    cache: EnvCacheDecl,
    job: &str,
    fs: &JobFs,
    memory_bytes: u64,
    lines: &mut Vec<String>,
) -> Active {
    let key = key(&cache, job);
    let name = &cache.name;
    let limit = cache.max_bytes.min(memory_bytes / 4);
    let mut restored = BTreeMap::new();
    match store.restore(&key, &[], memory_bytes) {
        Ok(Some(found)) => match fs.apply(&found.entries) {
            Ok(()) => {
                fs.apply_modes(&found.modes);
                fs.set_restored_times(&found.entries);
                lines.push(format!(
                    "env cache `{name}`: restored {}",
                    kib(file_bytes(&found.entries))
                ));
                restored = found.entries.iter().map(kind).collect();
            }
            Err(e) => lines.push(format!(
                "env cache `{name}`: could not restore ({e}); starting without it"
            )),
        },
        Ok(None) => lines.push(format!("env cache `{name}`: miss")),
        Err(e) => lines.push(format!(
            "env cache `{name}`: could not read the cache ({e}); starting without it"
        )),
    }
    Active {
        decl: cache,
        key,
        limit,
        restored,
    }
}

/// Saves what the job left in the cache's directory, after a pass. Nothing
/// is saved when it is what was restored. Past its limit (`max-bytes`, or
/// a quarter of the job's memory), only what this run wrote is kept, so a cache that has grown with files
/// no build uses any more starts again from what the last build needed;
/// when even that is too big, nothing is saved.
pub fn save(
    store: &dyn Caches,
    active: &Active,
    fs: &JobFs,
    lines: &mut Vec<String>,
    saves: &mut crate::saves::Saves,
) {
    let name = &active.decl.name;
    let entries = fs.entries_under(&[&active.decl.path]);
    let now: BTreeMap<PathBuf, Kind> = entries.iter().map(kind).collect();
    if now == active.restored {
        lines.push(format!("env cache `{name}`: unchanged"));
        return;
    }
    if !entries
        .iter()
        .any(|e| matches!(e, Entry::File { .. } | Entry::Symlink { .. }))
    {
        // Emptied (`go clean -cache`): replace what was saved, or it
        // would come back next run.
        let emptied = active.restored.values().any(|k| !matches!(k, Kind::Dir));
        if emptied {
            let shown = name.clone();
            queue(
                store,
                active,
                entries,
                Vec::new(),
                lines,
                saves,
                Box::new(move |saved| match saved {
                    Ok(_) => format!("env cache `{shown}`: emptied"),
                    Err(e) => format!("env cache `{shown}`: could not save ({e})"),
                }),
            );
        } else {
            lines.push(format!("env cache `{name}`: nothing to save"));
        }
        return;
    }
    let max = active.limit;
    let total = file_bytes(&entries);
    let (kept, note) = if total <= max {
        (entries, String::new())
    } else {
        // What this run wrote or changed, with the directories above it.
        let written: Vec<Entry> = entries
            .into_iter()
            .filter(|e| {
                !matches!(e, Entry::Dir { .. }) && {
                    let (path, now) = kind(e);
                    active.restored.get(&path) != Some(&now)
                }
            })
            .collect();
        let size = file_bytes(&written);
        if size > max {
            lines.push(format!(
                "env cache `{name}`: not saved, this run alone wrote {}, more than its {}",
                kib(size),
                kib(max)
            ));
            return;
        }
        let root = PathBuf::from(&active.decl.path);
        let mut dirs = BTreeSet::new();
        for entry in &written {
            for parent in path_of(entry).ancestors().skip(1) {
                if !parent.starts_with(&root) {
                    break;
                }
                dirs.insert(parent.to_path_buf());
            }
        }
        let mut kept: Vec<Entry> = dirs.into_iter().map(|path| Entry::Dir { path }).collect();
        kept.extend(written);
        kept.sort_by_key(|e| path_of(e).components().count());
        (
            kept,
            format!(
                " (it held {}, more than its {}, so only what this run wrote was kept)",
                kib(total),
                kib(max)
            ),
        )
    };
    let modes = fs.modes_of(&kept);
    let shown = name.clone();
    let size = kib(file_bytes(&kept));
    queue(
        store,
        active,
        kept,
        modes,
        lines,
        saves,
        Box::new(move |saved| match saved {
            Ok(_) => format!("env cache `{shown}`: saved {size}{note}"),
            Err(e) => format!("env cache `{shown}`: could not save ({e})"),
        }),
    );
}

/// Saves `entries` under the cache's key now, or after the job
/// ([`crate::saves`]). One made after the job claims its key first, as a
/// job cache's save does, so a restore of it waits for the upload; a key
/// another job of this runner is saving is left to that save.
#[allow(clippy::too_many_arguments)]
fn queue(
    store: &dyn Caches,
    active: &Active,
    entries: Vec<Entry>,
    modes: Vec<(PathBuf, u32)>,
    lines: &mut Vec<String>,
    saves: &mut crate::saves::Saves,
    line: Box<dyn FnOnce(Result<std::time::Duration, String>) -> String + Send>,
) {
    let name = &active.decl.name;
    if saves.is_deferred() && !store.claim(&active.key) {
        lines.push(format!("env cache `{name}`: being saved by another job"));
        return;
    }
    let save = crate::saves::Save {
        key: active.key.clone(),
        restore_keys: Vec::new(),
        pending: format!(
            "env cache `{name}`: saving {} after the job",
            kib(file_bytes(&entries))
        ),
        entries,
        modes,
        line,
    };
    saves.save(store, save, lines);
}

#[cfg(test)]
mod tests {
    use super::cached_by_job;

    fn caches(paths: &[&str]) -> Vec<iwci_spec::CacheSpec> {
        vec![iwci_spec::CacheSpec {
            key: "k".into(),
            restore_keys: Vec::new(),
            paths: paths.iter().map(|p| p.to_string()).collect(),
        }]
    }

    #[test]
    fn a_job_cache_over_under_or_at_the_directory_takes_it() {
        let m2 = "/root/.m2/repository";
        assert_eq!(cached_by_job(m2, &caches(&[m2])), Some(m2));
        assert_eq!(
            cached_by_job(m2, &caches(&["/root/.m2"])),
            Some("/root/.m2")
        );
        assert_eq!(
            cached_by_job(m2, &caches(&["/root/.m2/repository/org"])),
            Some("/root/.m2/repository/org")
        );
        // A sibling, or a name that only starts the same, is not it.
        assert_eq!(cached_by_job(m2, &caches(&["/root/.m2/wrapper"])), None);
        assert_eq!(cached_by_job(m2, &caches(&["/root/.m2/repository2"])), None);
        assert_eq!(cached_by_job(m2, &[]), None);
    }
}
