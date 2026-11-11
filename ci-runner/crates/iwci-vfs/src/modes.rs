//! File modes, which Wasmer's file systems do not have.
//!
//! `virtual-fs` metadata carries a type, a size and times, and WASIX's
//! `filestat` has no field for a mode either, so a job's `chmod` changed
//! nothing and every file read as mode 0 (#959). [`Modes`] is the record the
//! runner keeps instead: the permission bits (and setuid, setgid and sticky)
//! of every path that was given some, by absolute guest path.
//!
//! A snapshot holds the modes its checkout set (git's executable bit), and
//! each job's [`Modes`] records what the job changed over them, so forking
//! stays constant time. The file systems that own the paths keep the record
//! in step: [`crate::JobOverlay`] and [`TrackModes`] move a path's mode with
//! it on rename and forget it when the path is removed, so a file created
//! later at the same path starts from the default, as on Linux.
//!
//! Nothing enforces a mode: a job runs as one user that may do anything to
//! its own files. Modes are kept so that a job can read back what it set and
//! what the commit says.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use virtual_fs::FileSystem;

/// The bits a mode keeps: permissions plus setuid, setgid and sticky.
pub const MODE_BITS: u32 = 0o7777;

/// A regular file nobody gave a mode: `0666` under the usual `022` umask.
pub const DEFAULT_FILE_MODE: u32 = 0o644;
/// A directory nobody gave a mode.
pub const DEFAULT_DIR_MODE: u32 = 0o755;
/// What `chmod +x` and git's executable bit make of a file.
pub const EXECUTABLE_MODE: u32 = 0o755;

/// The modes a snapshot was built with, by absolute guest path.
pub type SnapshotModes = Arc<BTreeMap<PathBuf, u32>>;

/// One job's file modes. Cheap to clone; clones share the record.
#[derive(Debug, Clone, Default)]
pub struct Modes(Arc<ModesInner>);

#[derive(Debug, Default)]
struct ModesInner {
    /// The snapshot's, never written.
    base: SnapshotModes,
    /// What the job set over `base`: `None` hides a `base` entry, for a path
    /// that was removed (or replaced) and is back to the default.
    own: Mutex<BTreeMap<PathBuf, Option<u32>>>,
}

impl Modes {
    /// A record over the modes a snapshot was built with.
    pub fn over(base: SnapshotModes) -> Self {
        Self(Arc::new(ModesInner {
            base,
            own: Mutex::default(),
        }))
    }

    fn own(&self) -> std::sync::MutexGuard<'_, BTreeMap<PathBuf, Option<u32>>> {
        self.0.own.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The mode recorded for `path`, if one was: `None` means the default
    /// for what is there. `path` is absolute and has no symlinks left to
    /// resolve (see [`crate::resolve`]).
    pub fn get(&self, path: &Path) -> Option<u32> {
        match self.own().get(path) {
            Some(mode) => *mode,
            None => self.0.base.get(path).copied(),
        }
    }

    /// Records `mode` (its [`MODE_BITS`]) for `path`.
    pub fn set(&self, path: &Path, mode: u32) {
        self.own()
            .insert(path.to_path_buf(), Some(mode & MODE_BITS));
    }

    /// `path` was removed: whatever is created there next has the default.
    pub fn removed(&self, path: &Path) {
        let mut own = self.own();
        self.forget(&mut own, path);
    }

    fn forget(&self, own: &mut BTreeMap<PathBuf, Option<u32>>, path: &Path) {
        if self.0.base.contains_key(path) {
            own.insert(path.to_path_buf(), None);
        } else {
            own.remove(path);
        }
    }

    /// `from` was renamed to `to`: its mode, and the modes of everything
    /// under it, move with it, and whatever `to` held before is gone.
    pub fn renamed(&self, from: &Path, to: &Path) {
        if from == to {
            return;
        }
        let mut own = self.own();
        // Every recorded path at or under `from`, with what it ends up as.
        let mut moving: BTreeMap<PathBuf, Option<u32>> = BTreeMap::new();
        for (path, mode) in self.0.base.range(from.to_path_buf()..) {
            if !path.starts_with(from) {
                break;
            }
            moving.insert(path.clone(), Some(*mode));
        }
        for (path, mode) in own.range(from.to_path_buf()..) {
            if !path.starts_with(from) {
                break;
            }
            moving.insert(path.clone(), *mode);
        }
        // The target's old entry (a file renamed over) goes; a directory
        // can only be renamed over an empty one, which has nothing under it.
        self.forget(&mut own, to);
        for (path, mode) in moving {
            let Ok(rest) = path.strip_prefix(from) else {
                continue;
            };
            let target = if rest.as_os_str().is_empty() {
                to.to_path_buf()
            } else {
                to.join(rest)
            };
            self.forget(&mut own, &path);
            match mode {
                Some(mode) => {
                    own.insert(target, Some(mode));
                }
                None => self.forget(&mut own, &target),
            }
        }
    }
}

/// The mode a job sees for `path` in `fs`: what [`Modes`] recorded for it
/// (after symlinks), or the default for its type. `None` when nothing is
/// there. With `follow` false a symlink is reported as itself, `0777`.
pub fn mode_of(
    fs: &(impl FileSystem + ?Sized),
    modes: &Modes,
    path: &Path,
    follow: bool,
) -> Option<(virtual_fs::Metadata, u32)> {
    let path = crate::normalise(path).ok()?;
    if !follow
        && let Ok(meta) = fs.symlink_metadata(&path)
        && meta.file_type().is_symlink()
    {
        return Some((meta, 0o777));
    }
    let path = crate::resolve(fs, &path).ok()?;
    let meta = fs.metadata(&path).ok()?;
    let mode = modes.get(&path).unwrap_or(if meta.is_dir() {
        DEFAULT_DIR_MODE
    } else {
        DEFAULT_FILE_MODE
    });
    Some((meta, mode))
}

/// A file system whose removals and renames are reflected in a [`Modes`],
/// for a mount other than the job's own overlay (which does this itself).
/// `prefix` is where the mount is, when it is given paths relative to that.
#[derive(Debug)]
pub struct TrackModes {
    inner: crate::DynFs,
    modes: Modes,
    prefix: PathBuf,
}

impl TrackModes {
    pub fn new(inner: crate::DynFs, modes: Modes, prefix: impl Into<PathBuf>) -> Self {
        Self {
            inner,
            modes,
            prefix: prefix.into(),
        }
    }

    /// The guest path of `path` as this mount is given it.
    fn guest(&self, path: &Path) -> PathBuf {
        let rest = path.strip_prefix("/").unwrap_or(path);
        if rest.as_os_str().is_empty() {
            self.prefix.clone()
        } else {
            self.prefix.join(rest)
        }
    }
}

impl FileSystem for TrackModes {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.inner.readlink(path)
    }
    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.inner.read_dir(path)
    }
    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.inner.create_dir(path)
    }
    fn create_symlink(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.inner.create_symlink(source, target)
    }
    fn hard_link(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.inner.hard_link(source, target)
    }
    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.inner.remove_dir(path)?;
        self.modes.removed(&self.guest(path));
        Ok(())
    }
    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        Box::pin(async move {
            self.inner.rename(from, to).await?;
            self.modes.renamed(&self.guest(from), &self.guest(to));
            Ok(())
        })
    }
    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.inner.metadata(path)
    }
    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.inner.symlink_metadata(path)
    }
    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        self.inner.remove_file(path)?;
        self.modes.removed(&self.guest(path));
        Ok(())
    }
    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for TrackModes {
    fn open(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        self.inner
            .new_open_options()
            .options(conf.clone())
            .open(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn a_job_reads_the_snapshot_modes_and_its_own_over_them() {
        let base: SnapshotModes = Arc::new(BTreeMap::from([(p("/app/run.sh"), 0o755)]));
        let modes = Modes::over(base.clone());
        assert_eq!(modes.get(&p("/app/run.sh")), Some(0o755));
        assert_eq!(modes.get(&p("/app/other")), None);

        modes.set(&p("/app/run.sh"), 0o100_700);
        assert_eq!(modes.get(&p("/app/run.sh")), Some(0o700), "only mode bits");
        // Another job over the same snapshot is untouched.
        assert_eq!(Modes::over(base).get(&p("/app/run.sh")), Some(0o755));
    }

    #[test]
    fn a_removed_path_comes_back_with_the_default() {
        let base: SnapshotModes = Arc::new(BTreeMap::from([(p("/app/run.sh"), 0o755)]));
        let modes = Modes::over(base);
        modes.set(&p("/tmp/key"), 0o600);
        modes.removed(&p("/tmp/key"));
        modes.removed(&p("/app/run.sh"));
        assert_eq!(modes.get(&p("/tmp/key")), None);
        assert_eq!(modes.get(&p("/app/run.sh")), None, "hides the snapshot's");
    }

    #[test]
    fn a_rename_moves_modes_and_everything_under_a_directory() {
        let base: SnapshotModes = Arc::new(BTreeMap::from([
            (p("/app/bin/a"), 0o755),
            (p("/app/bin/b"), 0o755),
            (p("/app/binary"), 0o700),
        ]));
        let modes = Modes::over(base);
        modes.set(&p("/app/bin/a"), 0o700);
        modes.set(&p("/app/bin"), 0o711);
        modes.renamed(&p("/app/bin"), &p("/app/tools"));
        assert_eq!(modes.get(&p("/app/tools")), Some(0o711));
        assert_eq!(modes.get(&p("/app/tools/a")), Some(0o700));
        assert_eq!(modes.get(&p("/app/tools/b")), Some(0o755));
        assert_eq!(modes.get(&p("/app/bin/a")), None);
        assert_eq!(modes.get(&p("/app/bin/b")), None);
        // A sibling that only shares a prefix of the name stays.
        assert_eq!(modes.get(&p("/app/binary")), Some(0o700));

        // A file renamed over another replaces its mode, default included.
        modes.set(&p("/w/new"), 0o600);
        modes.set(&p("/w/old"), 0o755);
        modes.renamed(&p("/w/new"), &p("/w/old"));
        assert_eq!(modes.get(&p("/w/old")), Some(0o600));
        modes.renamed(&p("/w/plain"), &p("/w/old"));
        assert_eq!(modes.get(&p("/w/old")), None);
    }
}
