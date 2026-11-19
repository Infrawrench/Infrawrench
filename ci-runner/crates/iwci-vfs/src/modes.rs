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
//!
//! A mode belongs to a file, not a name, so a file with hard links has one
//! for all its names: the record keeps those by the file's inode number
//! ([`Modes::linked`]), which the job's own file system gives every name of
//! such a file (`Metadata::ino`), and a path is looked up there first.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use virtual_fs::FileSystem;
use xxhash_rust::xxh64::Xxh64;

use crate::tree::{PathTree, names};

/// The bits a mode keeps: permissions plus setuid, setgid and sticky.
pub const MODE_BITS: u32 = 0o7777;

/// A regular file nobody gave a mode: `0666` under the usual `022` umask.
pub const DEFAULT_FILE_MODE: u32 = 0o644;
/// A directory nobody gave a mode.
pub const DEFAULT_DIR_MODE: u32 = 0o755;
/// What `chmod +x` and git's executable bit make of a file.
pub const EXECUTABLE_MODE: u32 = 0o755;

/// The modes a snapshot was built with, by absolute guest path.
pub type SnapshotModes = Arc<PathTree<u32>>;

/// One job's file modes. Cheap to clone; clones share the record.
#[derive(Debug, Clone, Default)]
pub struct Modes(Arc<ModesInner>);

/// Both records are trees of path components (`tree.rs`), not maps of whole
/// paths: a job that chmods files deep under long directory names would
/// otherwise keep a copy of each multi-kilobyte path.
#[derive(Debug, Default)]
struct ModesInner {
    /// The snapshot's, never written.
    base: SnapshotModes,
    /// `base`'s paths by `st_ino`, made the first time the job asks by one.
    base_inos: OnceLock<InoIndex>,
    /// What the job set over `base`.
    own: Mutex<Own>,
    /// Where the modes really are, when the files are in a file system
    /// that has them ([`Modes::real`]).
    real: Option<Arc<dyn RealModes>>,
    /// The file system whose files can have hard links, which numbers
    /// those (`Metadata::ino`): the job's own layer ([`Modes::numbered_by`]).
    numbers: OnceLock<crate::DynFs>,
    /// Whether any file was given a second name, before which nothing
    /// asks `numbers`.
    any_linked: AtomicBool,
    /// Files with hard links that have a mode, by inode number. One with
    /// none has no entry: every name has the default.
    linked: Mutex<HashMap<u64, Linked>>,
}

/// What the record keeps of a file with hard links and a mode.
#[derive(Debug, Clone)]
struct Linked {
    mode: u32,
    /// Its names the record has seen (linked, given a mode, renamed to),
    /// less those removed: where [`Modes::by_ino`] finds it.
    names: Vec<PathBuf>,
}

impl Linked {
    fn named(&mut self, path: &Path) {
        if !self.names.iter().any(|n| n == path) {
            self.names.push(path.to_path_buf());
        }
    }
}

/// What a job set over the snapshot's modes, and its paths by `st_ino`.
#[derive(Debug, Default)]
struct Own {
    /// `None` hides a `base` entry, for a path that was removed (or
    /// replaced) and is back to the default.
    tree: PathTree<Option<u32>>,
    /// Every path `tree` has a mode for. One that only hides a `base`
    /// entry is looked up by its path, so it costs only its place in `tree`.
    inos: InoIndex,
}

impl Own {
    fn get(&self, path: &Path) -> Option<&Option<u32>> {
        self.tree.get(path)
    }

    fn insert(&mut self, path: &Path, value: Option<u32>) {
        match value {
            Some(_) => self.inos.add(path),
            None => self.inos.remove(path),
        }
        self.tree.insert(path, value);
    }

    fn remove(&mut self, path: &Path) {
        if self.tree.remove(path).is_some() {
            self.inos.remove(path);
        }
    }

    fn detach(&mut self, path: &Path) -> Option<PathTree<Option<u32>>> {
        let detached = self.tree.detach(path)?;
        let inos = &mut self.inos;
        detached.for_each_under(Path::new("/"), |rest, mode| {
            if mode.is_some() {
                inos.remove(&path.join(rest));
            }
        });
        Some(detached)
    }
}

/// The `st_ino` wasmer-wasix gives the file at `path` (absolute, no
/// symlinks left): the 64-bit xxHash of the path as its file system was
/// asked for it, cut to its low 53 bits (`Inode::from_path`, which keeps
/// the numbers exact in JavaScript), and after a rename the number of its
/// new path (vendor/README.md, #1054). Edge.js's C library has an `st_ino`
/// from `fstat` and no path, and asks for a file's mode by it after every
/// `stat` (`/proc/iwci/ino/`, `iwci-runtime`'s `modes.rs`). Tested end to
/// end in `builtins/test.sh` (`bash-node/modes-passes` and
/// `renamed-modes-passes`), since a change in how wasmer-wasix numbers
/// inodes breaks it.
pub fn ino_of(path: &Path) -> u64 {
    xxhash_rust::xxh64::xxh64(path.as_os_str().as_encoded_bytes(), 0) & INO_BITS
}

/// The bits of a hash an inode number keeps.
const INO_BITS: u64 = (1 << 53) - 1;

/// `path`'s ancestors and then `path`, root first, each as its [`ino_of`],
/// its parent's and its name: the path as the record spells it (`/` and the
/// names joined by `/`), hashed once along its length.
fn ino_chain(path: &Path) -> Vec<(u64, u64, &OsStr)> {
    let mut hasher = Xxh64::new(0);
    hasher.update(b"/");
    let root = hasher.digest() & INO_BITS;
    let mut out = vec![(root, root, OsStr::new(""))];
    for (i, name) in names(path).enumerate() {
        if i > 0 {
            hasher.update(b"/");
        }
        hasher.update(name.as_encoded_bytes());
        let parent = out[out.len() - 1].0;
        out.push((hasher.digest() & INO_BITS, parent, name));
    }
    out
}

/// Paths by [`ino_of`], so that `ino/` finds a recorded file without
/// walking the record. Edge.js asks after every `stat`, and a package
/// manager's install records a mode for every executable it unpacks or
/// links while it stats hundreds of thousands of files: walking the record
/// each time, building and hashing every path in it, took most of a pnpm
/// install's time. Each path, and every directory above one, is kept as its
/// parent's number and its own name, so what one costs does not grow with
/// its depth, and a directory goes once nothing indexed is under it.
#[derive(Debug, Default)]
struct InoIndex {
    nodes: HashMap<u64, InoNode>,
    /// Two different paths gave one number: [`Modes::by_ino`] walks the
    /// record instead, as it always did.
    collided: bool,
}

#[derive(Debug)]
struct InoNode {
    parent: u64,
    name: Box<OsStr>,
    /// Indexed paths at or under this one.
    under: u32,
    indexed: bool,
}

impl InoIndex {
    /// Whether `node` is the one for `parent` and `name`.
    fn is(node: &InoNode, parent: u64, name: &OsStr) -> bool {
        node.parent == parent && *node.name == *name
    }

    fn add(&mut self, path: &Path) {
        // Once two paths share a number, lookups walk the record and this
        // is kept no longer.
        if self.collided {
            return;
        }
        let chain = ino_chain(path);
        let (ino, parent, name) = chain[chain.len() - 1];
        if let Some(node) = self.nodes.get(&ino)
            && node.indexed
        {
            self.collided |= !Self::is(node, parent, name);
            return;
        }
        for &(ino, parent, name) in &chain {
            let node = self.nodes.entry(ino).or_insert_with(|| InoNode {
                parent,
                name: name.into(),
                under: 0,
                indexed: false,
            });
            if !Self::is(node, parent, name) {
                self.collided = true;
                return;
            }
            node.under += 1;
        }
        if let Some(node) = self.nodes.get_mut(&ino) {
            node.indexed = true;
        }
    }

    fn remove(&mut self, path: &Path) {
        if self.collided {
            return;
        }
        let chain = ino_chain(path);
        let (ino, parent, name) = chain[chain.len() - 1];
        match self.nodes.get_mut(&ino) {
            Some(node) if node.indexed && Self::is(node, parent, name) => node.indexed = false,
            Some(node) if node.indexed => {
                self.collided = true;
                return;
            }
            _ => return,
        }
        for (ino, ..) in chain {
            if let Some(node) = self.nodes.get_mut(&ino) {
                node.under = node.under.saturating_sub(1);
                if node.under == 0 {
                    self.nodes.remove(&ino);
                }
            }
        }
    }

    /// The indexed path whose number is `ino`.
    fn find(&self, ino: u64) -> Option<PathBuf> {
        let mut node = self.nodes.get(&ino).filter(|n| n.indexed)?;
        let mut at = ino;
        let mut names = Vec::new();
        while node.parent != at {
            names.push(&*node.name);
            // More names than a path can have is a loop, which only a
            // collision could make.
            if names.len() > 4096 {
                return None;
            }
            at = node.parent;
            node = self.nodes.get(&at)?;
        }
        let mut path = PathBuf::from("/");
        path.extend(names.iter().rev());
        Some(path)
    }
}

/// The modes of files in a file system that keeps them itself: a job's
/// own files seen from inside its sandbox, where `chmod(2)` and `lstat(2)`
/// work. Paths are absolute, with no symlinks left to resolve.
pub trait RealModes: Send + Sync + std::fmt::Debug {
    /// The mode of `path` when it is not the default for its type: `Ok(None)`
    /// when it is, `Err(())` when the file system has no such file (it is
    /// in a mount of its own, which the record answers for).
    #[allow(clippy::result_unit_err)]
    fn get(&self, path: &Path) -> Result<Option<u32>, ()>;
    /// Sets the mode of `path`; `false` when the file system has no such
    /// file.
    fn set(&self, path: &Path, mode: u32) -> bool;
}

impl Modes {
    /// A record over the modes a snapshot was built with.
    pub fn over(base: SnapshotModes) -> Self {
        Self(Arc::new(ModesInner {
            base,
            real: None,
            ..ModesInner::default()
        }))
    }

    /// Files of `fs` (the job's own layer, at the guest's paths) can have
    /// hard links, numbered by `fs`.
    pub fn numbered_by(&self, fs: crate::DynFs) {
        let _ = self.0.numbers.set(fs);
    }

    fn linked_files(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Linked>> {
        self.0.linked.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The inode number of the file at `path` when it has hard links (or
    /// had: the number stays while the file does).
    fn number(&self, path: &Path) -> Option<u64> {
        if !self.0.any_linked.load(Ordering::Acquire) {
            return None;
        }
        let meta = self.0.numbers.get()?.symlink_metadata(path).ok()?;
        (meta.ino != 0).then_some(meta.ino)
    }

    /// `target` is a new name of the file at `source`, whose inode number
    /// is now `ino`: both have the mode `source` had.
    pub fn linked(&self, source: &Path, target: &Path, ino: u64) {
        let mode = self.get(source);
        self.0.any_linked.store(true, Ordering::Release);
        let Some(mode) = mode else {
            return;
        };
        let mut linked = self.linked_files();
        let entry = linked.entry(ino).or_insert_with(|| Linked {
            mode,
            names: Vec::new(),
        });
        entry.named(source);
        entry.named(target);
        drop(linked);
        self.own().insert(target, Some(mode));
    }

    /// A job looked at `path`, whose metadata is `meta`, in a file system
    /// that keeps modes itself ([`Modes::real`]): its mode is taken into
    /// the record, by number too when the file has hard links (the file
    /// system numbers those, `Metadata::ino`), so that [`Modes::by_ino`]
    /// finds it by the number every name of it reports.
    pub fn seen(&self, path: &Path, meta: &virtual_fs::Metadata) {
        let mode = self.get(path);
        if meta.ino == 0 || meta.is_dir() {
            return;
        }
        self.0.any_linked.store(true, Ordering::Release);
        let mut linked = self.linked_files();
        match mode {
            Some(mode) => {
                let entry = linked.entry(meta.ino).or_insert_with(|| Linked {
                    mode,
                    names: Vec::new(),
                });
                entry.mode = mode;
                entry.named(path);
            }
            None => {
                linked.remove(&meta.ino);
            }
        }
    }

    /// `path`, a name of the file numbered `ino`, was removed; the file
    /// lost its last name if `last`.
    pub fn unlinked(&self, ino: u64, path: &Path, last: bool) {
        let mut linked = self.linked_files();
        if last {
            linked.remove(&ino);
        } else if let Some(entry) = linked.get_mut(&ino) {
            entry.names.retain(|n| n != path);
        }
    }

    /// Modes that live in `real`, starting from `base` (the modes the
    /// files had when the record was made): a read asks `real` and a
    /// change goes to it, and the record keeps the paths with a mode that
    /// is not the default, which is all [`Modes::recorded`] lists. A path
    /// `real` does not have is kept in the record alone.
    pub fn real(base: SnapshotModes, real: Arc<dyn RealModes>) -> Self {
        Self(Arc::new(ModesInner {
            base,
            real: Some(real),
            ..ModesInner::default()
        }))
    }

    fn own(&self) -> std::sync::MutexGuard<'_, Own> {
        self.0.own.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn base_inos(&self) -> &InoIndex {
        self.0.base_inos.get_or_init(|| {
            let mut index = InoIndex::default();
            let root = Path::new("/");
            self.0
                .base
                .for_each_under(root, |rest, _| index.add(&root.join(rest)));
            index
        })
    }

    /// The path with a mode recorded whose [`ino_of`] is `ino`, if there is
    /// one: one of what [`Modes::recorded`] lists, found by its number.
    pub fn by_ino(&self, ino: u64) -> Option<PathBuf> {
        // A file with hard links and a mode, at one of its names that is
        // still its own.
        if self.0.any_linked.load(Ordering::Acquire) {
            let names = self.linked_files().get(&ino).map(|l| l.names.clone());
            if let Some(names) = names {
                return names
                    .into_iter()
                    .find(|name| self.number(name) == Some(ino));
            }
        }
        let base = self.base_inos();
        {
            let own = self.own();
            if !own.inos.collided && !base.collided {
                if let Some(path) = own.inos.find(ino)
                    && let Some(Some(_)) = own.get(&path)
                {
                    return Some(path);
                }
                return base
                    .find(ino)
                    .filter(|path| own.get(path).is_none() && self.0.base.get(path).is_some());
            }
        }
        self.recorded()
            .into_iter()
            .map(|(path, _)| path)
            .find(|path| ino_of(path) == ino)
    }

    /// The mode recorded for `path`, if one was: `None` means the default
    /// for what is there. `path` is absolute and has no symlinks left to
    /// resolve (see [`crate::resolve`]).
    pub fn get(&self, path: &Path) -> Option<u32> {
        if let Some(real) = &self.0.real
            && let Ok(mode) = real.get(path)
        {
            let mut own = self.own();
            match mode {
                Some(mode) => own.insert(path, Some(mode)),
                None => self.forget(&mut own, path),
            }
            return mode;
        }
        if let Some(ino) = self.number(path)
            && let Some(linked) = self.linked_files().get(&ino)
        {
            return Some(linked.mode);
        }
        match self.own().get(path) {
            Some(mode) => *mode,
            None => self.0.base.get(path).copied(),
        }
    }

    /// Every path with a mode recorded, and that mode.
    pub fn recorded(&self) -> Vec<(PathBuf, u32)> {
        let own = self.own();
        let root = Path::new("/");
        let mut out = Vec::new();
        self.0.base.for_each_under(root, |rest, mode| {
            let path = root.join(rest);
            if own.get(&path).is_none() {
                out.push((path, *mode));
            }
        });
        own.tree.for_each_under(root, |rest, mode| {
            if let Some(mode) = mode {
                out.push((root.join(rest), *mode));
            }
        });
        drop(own);
        // A name of a file with hard links has the file's mode, which a
        // `chmod` through another name changed.
        if self.0.any_linked.load(Ordering::Acquire) {
            for (path, mode) in &mut out {
                if let Some(ino) = self.number(path)
                    && let Some(linked) = self.linked_files().get(&ino)
                {
                    *mode = linked.mode;
                }
            }
        }
        out
    }

    /// Records `mode` (its [`MODE_BITS`]) for `path`.
    pub fn set(&self, path: &Path, mode: u32) {
        if let Some(real) = &self.0.real {
            real.set(path, mode & MODE_BITS);
        }
        if let Some(ino) = self.number(path) {
            let mut linked = self.linked_files();
            let entry = linked.entry(ino).or_insert_with(|| Linked {
                mode,
                names: Vec::new(),
            });
            entry.mode = mode & MODE_BITS;
            entry.named(path);
        }
        self.own().insert(path, Some(mode & MODE_BITS));
    }

    /// `path` was removed: whatever is created there next has the default.
    pub fn removed(&self, path: &Path) {
        let mut own = self.own();
        self.forget(&mut own, path);
    }

    fn forget(&self, own: &mut Own, path: &Path) {
        if self.0.base.get(path).is_some() {
            own.insert(path, None);
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
        // Every recorded path at or under `from`, by its path from `from`,
        // with what it ends up as: the job's own record over the snapshot's.
        let mut moving = own.detach(from).unwrap_or_default();
        self.0.base.for_each_under(from, |rest, mode| {
            // The snapshot's mode no longer applies where it was.
            own.insert(&from.join(rest), None);
            moving.get_or_insert_with(rest, || Some(*mode));
        });
        // The target's old entry (a file renamed over) goes; a directory
        // can only be renamed over an empty one, which has nothing under it.
        self.forget(&mut own, to);
        moving.for_each_under(Path::new("/"), |rest, mode| {
            let target = to.join(rest);
            match mode {
                Some(mode) => own.insert(&target, Some(*mode)),
                None => self.forget(&mut own, &target),
            }
        });
        drop(own);
        // The names a file with hard links is found at move too.
        if self.0.any_linked.load(Ordering::Acquire) {
            for entry in self.linked_files().values_mut() {
                for name in &mut entry.names {
                    if let Ok(rest) = name.strip_prefix(from) {
                        *name = if rest.as_os_str().is_empty() {
                            to.to_path_buf()
                        } else {
                            to.join(rest)
                        };
                    }
                }
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

    fn snapshot<const N: usize>(modes: [(&str, u32); N]) -> SnapshotModes {
        let mut tree = PathTree::default();
        for (path, mode) in modes {
            tree.insert(Path::new(path), mode);
        }
        Arc::new(tree)
    }

    #[test]
    fn a_job_reads_the_snapshot_modes_and_its_own_over_them() {
        let base = snapshot([("/app/run.sh", 0o755)]);
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
        let base = snapshot([("/app/run.sh", 0o755)]);
        let modes = Modes::over(base);
        modes.set(&p("/tmp/key"), 0o600);
        modes.removed(&p("/tmp/key"));
        modes.removed(&p("/app/run.sh"));
        assert_eq!(modes.get(&p("/tmp/key")), None);
        assert_eq!(modes.get(&p("/app/run.sh")), None, "hides the snapshot's");
    }

    #[test]
    fn a_rename_moves_modes_and_everything_under_a_directory() {
        let base = snapshot([
            ("/app/bin/a", 0o755),
            ("/app/bin/b", 0o755),
            ("/app/binary", 0o700),
        ]);
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

    /// What `by_ino` finds is exactly what a walk of `recorded` finds.
    fn assert_found_as_recorded(modes: &Modes, paths: &[&str]) {
        let recorded: Vec<PathBuf> = modes.recorded().into_iter().map(|(p, _)| p).collect();
        for path in paths {
            let ino = ino_of(&p(path));
            let walked = recorded.iter().find(|r| ino_of(r) == ino).cloned();
            assert_eq!(modes.by_ino(ino), walked, "{path}");
        }
    }

    #[test]
    fn a_recorded_path_is_found_by_its_number_through_every_change() {
        let base = snapshot([("/app/run.sh", 0o755), ("/app/bin/a", 0o755)]);
        let modes = Modes::over(base);
        let all = [
            "/",
            "/app",
            "/app/run.sh",
            "/app/bin",
            "/app/bin/a",
            "/app/tools/a",
            "/tmp/key",
            "/tmp",
            "/w/new",
            "/w/old",
            "/w/d/e/f",
        ];
        assert_eq!(
            modes.by_ino(ino_of(&p("/app/run.sh"))),
            Some(p("/app/run.sh"))
        );
        assert_eq!(
            modes.by_ino(ino_of(&p("/app"))),
            None,
            "a directory above one"
        );
        assert_found_as_recorded(&modes, &all);

        modes.set(&p("/tmp/key"), 0o600);
        modes.set(&p("/app/run.sh"), 0o700);
        assert_eq!(modes.by_ino(ino_of(&p("/tmp/key"))), Some(p("/tmp/key")));
        assert_found_as_recorded(&modes, &all);

        // Removed: the snapshot's is hidden, the job's gone.
        modes.removed(&p("/app/run.sh"));
        modes.removed(&p("/tmp/key"));
        assert_eq!(modes.by_ino(ino_of(&p("/app/run.sh"))), None);
        assert_eq!(modes.by_ino(ino_of(&p("/tmp/key"))), None);
        assert_found_as_recorded(&modes, &all);

        // Renamed: found at the new path only, snapshot entries included.
        modes.set(&p("/w/d/e/f"), 0o700);
        modes.renamed(&p("/app/bin"), &p("/app/tools"));
        modes.renamed(&p("/w/d"), &p("/w/new"));
        assert_eq!(
            modes.by_ino(ino_of(&p("/app/tools/a"))),
            Some(p("/app/tools/a"))
        );
        assert_eq!(modes.by_ino(ino_of(&p("/app/bin/a"))), None);
        assert_eq!(
            modes.by_ino(ino_of(&p("/w/new/e/f"))),
            Some(p("/w/new/e/f"))
        );
        assert_found_as_recorded(&modes, &all);
        assert_found_as_recorded(&modes, &["/w/new/e/f", "/w/new", "/w/new/e"]);

        // Everything gone: nothing is left indexed, directories included,
        // although the job's record still hides the snapshot's two entries.
        modes.removed(&p("/w/new/e/f"));
        modes.removed(&p("/app/tools/a"));
        assert!(modes.recorded().is_empty());
        assert!(modes.own().inos.nodes.is_empty(), "{:?}", modes.own().inos);
        assert_found_as_recorded(&modes, &all);
    }

    #[test]
    fn finding_by_number_does_not_walk_the_record() {
        // An install's worth of executables, and a stat of each of many
        // more files: by walking, 20,000 x 40,000 paths built and hashed.
        let modes = Modes::over(Arc::default());
        for i in 0..20_000 {
            modes.set(
                &p(&format!("/app/node_modules/.pnpm/p{i}/bin/cli.js")),
                0o755,
            );
        }
        let started = std::time::Instant::now();
        for i in 0..40_000 {
            let path = format!(
                "/app/node_modules/.pnpm/p{}/bin/cli{}.js",
                i / 2,
                if i % 2 == 0 { "" } else { "x" }
            );
            let found = modes.by_ino(ino_of(&p(&path)));
            assert_eq!(found.is_some(), i % 2 == 0, "{path}");
        }
        let took = started.elapsed();
        assert!(
            took < std::time::Duration::from_secs(2),
            "40,000 lookups took {took:?}"
        );
    }

    #[test]
    fn a_collision_falls_back_to_walking() {
        let modes = Modes::over(Arc::default());
        modes.set(&p("/a/b"), 0o700);
        modes.own().inos.collided = true;
        assert_eq!(modes.by_ino(ino_of(&p("/a/b"))), Some(p("/a/b")));
        assert_eq!(modes.by_ino(ino_of(&p("/a"))), None);
    }
}
