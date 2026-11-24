//! The file systems of a CI run.
//!
//! A run builds one [`Snapshot`] per distinct workspace (the clone plus the
//! installed dependencies) and then freezes it. Every job [`Snapshot::fork`]s
//! it into a [`JobFs`]: Wasmer's overlay file system with a fresh in-memory
//! upper layer over the frozen snapshot. Jobs therefore start in constant time
//! however large `node_modules` is, cannot see each other's writes, and
//! [`JobFs::changes`] reads exactly what a job wrote by walking its upper
//! layer, which is how a formatter's output becomes a commit.
//!
//! Everything here is Wasmer's own `virtual-fs`, so the same objects are what
//! a guest sees through `WasiEnvBuilder::fs`. The helpers are synchronous: the
//! in-memory files complete every read and write on the first poll, so a
//! single-threaded `block_on` is all they need.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use futures::executor::block_on;
use virtual_fs::{
    AsyncReadExt, AsyncWriteExt, FileSystem, FsError, OverlayFileSystem, TmpFileSystem, mem_fs,
};

pub use virtual_fs;
pub use virtual_fs::mem_fs::SpillConfig;

pub mod archive;
mod index;
mod limit;
pub use limit::WriteBudget;
pub mod modes;
pub use modes::{Modes, TrackModes};
pub mod tree;

/// The file system type a guest is given.
pub type DynFs = Arc<dyn FileSystem + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum VfsError {
    #[error("{path}: {source}")]
    Fs {
        path: String,
        #[source]
        source: FsError,
    },
    #[error("{0}: not an absolute, normalised path")]
    BadPath(String),
}

pub type Result<T> = std::result::Result<T, VfsError>;

fn fs_err(path: &Path) -> impl FnOnce(FsError) -> VfsError + '_ {
    move |source| VfsError::Fs {
        path: path.display().to_string(),
        source,
    }
}

/// `path` as an absolute path with no `.` or `..` and no repeated separators.
/// Every path that reaches a file system goes through this, so a lockfile or
/// tarball entry such as `../../etc/passwd` cannot climb out of where it was
/// put.
pub fn normalise(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    let mut out = PathBuf::from("/");
    let mut absolute = false;
    for component in path.components() {
        match component {
            Component::RootDir => absolute = true,
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => {
                return Err(VfsError::BadPath(path.display().to_string()));
            }
        }
    }
    if !absolute {
        return Err(VfsError::BadPath(path.display().to_string()));
    }
    Ok(out)
}

/// `relative` joined under `root`, refusing anything that would leave it.
pub fn join_under(root: impl AsRef<Path>, relative: impl AsRef<Path>) -> Result<PathBuf> {
    let relative = relative.as_ref();
    let mut out = normalise(root)?;
    for component in relative.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(VfsError::BadPath(relative.display().to_string())),
        }
    }
    Ok(out)
}

/// Creates `path` and every missing parent.
pub fn create_dir_all(fs: &(impl FileSystem + ?Sized), path: impl AsRef<Path>) -> Result<()> {
    let path = normalise(path)?;
    let mut current = PathBuf::from("/");
    for component in path.components().skip(1) {
        current.push(component);
        // Looked up first: the in-memory file system's `create_dir` lists
        // the whole directory to find out whether it exists, which made
        // every file written under a `node_modules/.pnpm` of thousands of
        // packages cost a listing of all of them (#998).
        if fs.metadata(&current).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        match fs.create_dir(&current) {
            Ok(()) | Err(FsError::AlreadyExists) => {}
            Err(source) => return Err(fs_err(&current)(source)),
        }
    }
    Ok(())
}

/// Writes `bytes` to `path`, creating parents and replacing any old content.
pub fn write_file(
    fs: &(impl FileSystem + ?Sized),
    path: impl AsRef<Path>,
    bytes: &[u8],
) -> Result<()> {
    let path = normalise(path)?;
    if let Some(parent) = path.parent() {
        create_dir_all(fs, parent)?;
    }
    let mut file = fs
        .new_open_options()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(fs_err(&path))?;
    block_on(async {
        file.write_all(bytes).await?;
        file.flush().await
    })
    .map_err(|e| fs_err(&path)(e.into()))
}

/// `path` with every symlink along it replaced by its target, as the
/// kernel resolves a path. Relative targets resolve against the link's
/// directory; a target that climbs above `/` stops there, as on POSIX.
pub fn resolve(fs: &(impl FileSystem + ?Sized), path: impl AsRef<Path>) -> Result<PathBuf> {
    const MAX_HOPS: usize = 40;
    let path = normalise(path)?;
    let mut pending: Vec<std::ffi::OsString> = path
        .components()
        .skip(1)
        .map(|c| c.as_os_str().to_owned())
        .collect();
    pending.reverse();
    let mut out = PathBuf::from("/");
    let mut hops = 0;
    while let Some(part) = pending.pop() {
        if part == ".." {
            out.pop();
            continue;
        }
        if part == "." {
            continue;
        }
        out.push(&part);
        let is_link = fs
            .symlink_metadata(&out)
            .is_ok_and(|m| m.file_type().is_symlink());
        if !is_link {
            continue;
        }
        hops += 1;
        if hops > MAX_HOPS {
            return Err(fs_err(&out)(FsError::InvalidInput));
        }
        let target = fs.readlink(&out).map_err(fs_err(&out))?;
        out.pop();
        if target.is_absolute() {
            out = PathBuf::from("/");
        }
        for component in target.components().rev() {
            match component {
                Component::Normal(p) => pending.push(p.to_owned()),
                Component::ParentDir => pending.push("..".into()),
                _ => {}
            }
        }
    }
    Ok(out)
}

/// The whole content of the file at `path` (symlinks followed).
pub fn read_file(fs: &(impl FileSystem + ?Sized), path: impl AsRef<Path>) -> Result<Vec<u8>> {
    let path = resolve(fs, path)?;
    let mut file = fs
        .new_open_options()
        .read(true)
        .open(&path)
        .map_err(fs_err(&path))?;
    let mut bytes = Vec::new();
    block_on(file.read_to_end(&mut bytes)).map_err(|e| fs_err(&path)(e.into()))?;
    Ok(bytes)
}

/// Creates a symlink at `link` whose content is `target` (which may be
/// relative to the link's directory, as on POSIX).
pub fn symlink(
    fs: &(impl FileSystem + ?Sized),
    link: impl AsRef<Path>,
    target: impl AsRef<Path>,
) -> Result<()> {
    let link = normalise(link)?;
    if let Some(parent) = link.parent() {
        create_dir_all(fs, parent)?;
    }
    fs.create_symlink(target.as_ref(), &link)
        .map_err(fs_err(&link))
}

pub fn is_file(fs: &(impl FileSystem + ?Sized), path: impl AsRef<Path>) -> bool {
    fs.metadata(path.as_ref()).is_ok_and(|m| m.is_file())
}

pub fn is_dir(fs: &(impl FileSystem + ?Sized), path: impl AsRef<Path>) -> bool {
    fs.metadata(path.as_ref()).is_ok_and(|m| m.is_dir())
}

/// Every regular file under `root`, sorted, symlinks not followed.
pub fn list_files(fs: &(impl FileSystem + ?Sized), root: impl AsRef<Path>) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = walk_no_follow(fs, root.as_ref())
        .into_iter()
        .filter(|(_, meta)| meta.is_file())
        .map(|(path, _)| path)
        .collect();
    files.sort();
    files
}

/// The file system a run fills in before any job starts: the clone, then the
/// dependencies. [`SnapshotBuilder::freeze`] ends the writes.
/// One read a [`SnapshotBuilder::layer`] made of the file system under it:
/// what an install depended on, so a cached result can be checked against
/// a later checkout.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Input {
    File {
        path: PathBuf,
        sha256: [u8; 32],
    },
    Dir {
        path: PathBuf,
    },
    /// Looked for and not there. Recorded because a file appearing later
    /// (an `.npmrc` added to the repository) can change the result.
    Absent {
        path: PathBuf,
    },
    /// Every regular file under a directory, by path and content
    /// ([`tree_digest`]): what copying a directory (a pnpm `file:`
    /// directory dependency) read, so a file added to it later is a change.
    Tree {
        path: PathBuf,
        sha256: [u8; 32],
    },
}

/// The directories [`SnapshotBuilder::read_tree`] leaves out: what a
/// package manager never copies out of a directory dependency.
pub const TREE_SKIPPED: [&str; 2] = ["node_modules", ".git"];

/// The regular files under `root` (symlinks not followed, [`TREE_SKIPPED`]
/// directories left out), relative to it and sorted.
fn tree_files(fs: &(impl FileSystem + ?Sized), root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(children) = fs.read_dir(&dir) else {
            continue;
        };
        for child in children.flatten() {
            let Ok(meta) = fs.symlink_metadata(&child.path) else {
                continue;
            };
            if meta.is_dir() {
                let skipped = child
                    .path
                    .file_name()
                    .is_some_and(|name| TREE_SKIPPED.iter().any(|skip| name == *skip));
                if !skipped {
                    stack.push(child.path);
                }
            } else if meta.is_file()
                && let Ok(relative) = child.path.strip_prefix(root)
            {
                out.push(relative.to_path_buf());
            }
        }
    }
    out.sort();
    out
}

/// A digest of every file [`tree_files`] lists under `root`, by path and
/// content; `None` when `root` is not a directory.
pub fn tree_digest(fs: &(impl FileSystem + ?Sized), root: &Path) -> Option<[u8; 32]> {
    use sha2::Digest;
    if !is_dir(fs, root) {
        return None;
    }
    let mut hash = sha2::Sha256::new();
    for file in tree_files(fs, root) {
        let bytes = read_file(fs, root.join(&file)).ok()?;
        hash.update(file.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(sha2::Sha256::digest(&bytes));
    }
    Some(hash.finalize().into())
}

impl Input {
    pub fn path(&self) -> &Path {
        match self {
            Input::File { path, .. }
            | Input::Dir { path }
            | Input::Absent { path }
            | Input::Tree { path, .. } => path,
        }
    }

    /// The same read made of `fs` now.
    pub fn observe(fs: &(impl FileSystem + ?Sized), path: &Path) -> Input {
        use sha2::Digest;
        let path = path.to_path_buf();
        match read_file(fs, &path) {
            Ok(bytes) => Input::File {
                sha256: sha2::Sha256::digest(&bytes).into(),
                path,
            },
            Err(_) if is_dir(fs, &path) => Input::Dir { path },
            Err(_) => Input::Absent { path },
        }
    }

    /// Whether `fs` still looks the way it did when this was recorded.
    pub fn holds(&self, fs: &(impl FileSystem + ?Sized)) -> bool {
        match self {
            Input::Tree { path, sha256 } => tree_digest(fs, path).as_ref() == Some(sha256),
            _ => Input::observe(fs, self.path()) == *self,
        }
    }
}

/// Something a layer wrote, captured so it can be replayed into another
/// snapshot. File contents are shared, not copied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Dir {
        path: PathBuf,
    },
    File {
        path: PathBuf,
        data: shared_buffer::OwnedBuffer,
    },
    Symlink {
        path: PathBuf,
        target: PathBuf,
    },
}

#[derive(Debug)]
struct ReadBase {
    fs: mem_fs::FileSystem,
    reads: std::sync::Mutex<BTreeMap<PathBuf, Input>>,
}

impl ReadBase {
    fn observe(&self, path: &Path) -> Input {
        let input = Input::observe(&self.fs, path);
        self.reads
            .lock()
            .expect("read log lock")
            .entry(path.to_path_buf())
            .or_insert_with(|| input.clone());
        input
    }
}

/// The file system a run fills in before any job starts: the clone, then the
/// dependencies. [`SnapshotBuilder::freeze`] ends the writes.
#[derive(Debug, Default)]
pub struct SnapshotBuilder {
    fs: mem_fs::FileSystem,
    /// Set on a [`SnapshotBuilder::layer`]: what reads fall back to, and the
    /// log of those reads.
    base: Option<Arc<ReadBase>>,
    /// Modes given to paths (see `modes.rs`), such as the executable bit of
    /// a checked-out file.
    modes: std::sync::Mutex<tree::PathTree<u32>>,
}

impl SnapshotBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The file system being built, for code (git checkout, dependency
    /// installers) that writes through the `virtual_fs` traits directly.
    /// On a layer this is the layer alone: reads that should see the file
    /// system underneath go through [`SnapshotBuilder::read`] and friends.
    pub fn fs(&self) -> &mem_fs::FileSystem {
        &self.fs
    }

    /// An empty builder whose reads fall through to this one and are
    /// recorded ([`SnapshotBuilder::reads`]), and whose writes stay in the
    /// layer ([`SnapshotBuilder::entries`]). A dependency install runs in
    /// one, which is what makes its result cacheable: the reads are exactly
    /// what it depended on, and the entries are exactly what it produced.
    pub fn layer(&self) -> SnapshotBuilder {
        SnapshotBuilder {
            fs: mem_fs::FileSystem::default(),
            base: Some(Arc::new(ReadBase {
                fs: self.fs.clone(),
                reads: Default::default(),
            })),
            modes: Default::default(),
        }
    }

    /// Gives `path` the mode `mode` (its permission bits) in the snapshot.
    pub fn set_mode(&self, path: impl AsRef<Path>, mode: u32) -> Result<()> {
        let path = normalise(path)?;
        self.modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(&path, mode & modes::MODE_BITS);
        Ok(())
    }

    /// Every mode given with [`SnapshotBuilder::set_mode`], by absolute
    /// path, in path order. A layer's modes are its own, like its
    /// [`SnapshotBuilder::entries`]: what a cached install has to carry
    /// besides its files.
    pub fn modes(&self) -> Vec<(PathBuf, u32)> {
        let mut out = Vec::new();
        self.modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .for_each_under(Path::new("/"), |path, mode| {
                out.push((Path::new("/").join(path), *mode));
            });
        out
    }

    /// Gives each path its mode, as [`SnapshotBuilder::set_mode`] does.
    pub fn apply_modes(&self, modes: &[(PathBuf, u32)]) -> Result<()> {
        for (path, mode) in modes {
            self.set_mode(path, *mode)?;
        }
        Ok(())
    }

    pub fn write(&self, path: impl AsRef<Path>, bytes: &[u8]) -> Result<()> {
        write_file(&self.fs, path, bytes)
    }

    pub fn read(&self, path: impl AsRef<Path>) -> Result<Vec<u8>> {
        let path = path.as_ref();
        match (read_file(&self.fs, path), &self.base) {
            (Ok(bytes), _) => Ok(bytes),
            (Err(_), Some(base)) => {
                base.observe(&normalise(path)?);
                read_file(&base.fs, path)
            }
            (Err(e), None) => Err(e),
        }
    }

    /// Every regular file under the directory `dir` (symlinks not
    /// followed, [`TREE_SKIPPED`] left out), relative to it, with its
    /// contents. On a layer, a directory the layer does not have itself is
    /// read from underneath and recorded as one [`Input::Tree`].
    pub fn read_tree(&self, dir: impl AsRef<Path>) -> Result<Vec<(PathBuf, Vec<u8>)>> {
        let dir = normalise(dir)?;
        let fs: &mem_fs::FileSystem = match &self.base {
            Some(base) if !is_dir(&self.fs, &dir) => {
                let sha256 = tree_digest(&base.fs, &dir).ok_or_else(|| VfsError::Fs {
                    path: dir.display().to_string(),
                    source: FsError::EntryNotFound,
                })?;
                base.reads.lock().expect("read log lock").insert(
                    dir.clone(),
                    Input::Tree {
                        path: dir.clone(),
                        sha256,
                    },
                );
                &base.fs
            }
            _ => &self.fs,
        };
        tree_files(fs, &dir)
            .into_iter()
            .map(|file| {
                let bytes = read_file(fs, dir.join(&file))?;
                Ok((file, bytes))
            })
            .collect()
    }

    pub fn mkdir_all(&self, path: impl AsRef<Path>) -> Result<()> {
        create_dir_all(&self.fs, path)
    }

    pub fn symlink(&self, link: impl AsRef<Path>, target: impl AsRef<Path>) -> Result<()> {
        symlink(&self.fs, link, target)
    }

    pub fn is_file(&self, path: impl AsRef<Path>) -> bool {
        let path = path.as_ref();
        if is_file(&self.fs, path) {
            return true;
        }
        match (&self.base, normalise(path)) {
            (Some(base), Ok(path)) => matches!(base.observe(&path), Input::File { .. }),
            _ => false,
        }
    }

    pub fn is_dir(&self, path: impl AsRef<Path>) -> bool {
        let path = path.as_ref();
        if is_dir(&self.fs, path) {
            return true;
        }
        match (&self.base, normalise(path)) {
            (Some(base), Ok(path)) => matches!(base.observe(&path), Input::Dir { .. }),
            _ => false,
        }
    }

    /// Every read a layer made of the file system under it, sorted.
    pub fn reads(&self) -> Vec<Input> {
        self.base.as_ref().map_or_else(Vec::new, |b| {
            b.reads
                .lock()
                .expect("read log lock")
                .values()
                .cloned()
                .collect()
        })
    }

    /// Everything this builder holds, parents before children, symlinks not
    /// followed.
    pub fn entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        let mut stack = vec![PathBuf::from("/")];
        while let Some(dir) = stack.pop() {
            let Ok(children) = self.fs.read_dir(&dir) else {
                continue;
            };
            let mut children: Vec<PathBuf> = children.flatten().map(|e| e.path).collect();
            children.sort();
            for path in children.into_iter().rev() {
                let Ok(meta) = self.fs.symlink_metadata(&path) else {
                    continue;
                };
                let ft = meta.file_type();
                if ft.is_symlink() {
                    if let Ok(target) = self.fs.readlink(&path) {
                        out.push(Entry::Symlink { path, target });
                    }
                } else if ft.is_dir() {
                    out.push(Entry::Dir { path: path.clone() });
                    stack.push(path);
                } else if let Some(data) = owned_buffer(&self.fs, &path) {
                    out.push(Entry::File { path, data });
                }
            }
        }
        // The stack visits depth first; a stable sort by depth keeps every
        // parent directory ahead of what is inside it.
        out.sort_by_key(|e| match e {
            Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => {
                path.components().count()
            }
        });
        out
    }

    /// Writes `entries` into this builder, replacing what is at each path.
    /// Files go in as read-only views of the same buffers, so replaying a
    /// cached `node_modules` costs no copy of its contents.
    pub fn apply(&self, entries: &[Entry]) -> Result<()> {
        // Directories already made or found by this call: a layer lists a
        // directory once and then thousands of files in it, so each parent
        // is looked up once rather than once per file.
        let mut dirs: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
        let mut ensure_dir = |dir: &Path| -> Result<()> {
            if !dirs.contains(dir) {
                create_dir_all(&self.fs, dir)?;
                dirs.insert(dir.to_path_buf());
            }
            Ok(())
        };
        for entry in entries {
            match entry {
                Entry::Dir { path } => ensure_dir(&normalise(path)?)?,
                Entry::File { path, data } => {
                    let path = normalise(path)?;
                    if let Some(parent) = path.parent() {
                        ensure_dir(parent)?;
                    }
                    // `insert_ro_file` replaces what is at `path` itself.
                    self.fs
                        .new_open_options_ext()
                        .insert_ro_file(&path, data.clone())
                        .map_err(fs_err(&path))?;
                }
                Entry::Symlink { path, target } => {
                    let path = normalise(path)?;
                    if let Some(parent) = path.parent() {
                        ensure_dir(parent)?;
                    }
                    let _ = self.fs.remove_file(&path);
                    self.fs
                        .create_symlink(target, &path)
                        .map_err(fs_err(&path))?;
                }
            }
        }
        Ok(())
    }

    /// Ends the writes. Only the read side survives, so a job that holds the
    /// snapshot cannot change what the next job sees.
    pub fn freeze(self) -> Snapshot {
        Snapshot {
            fs: Arc::new(ReadOnlyFs {
                fs: self.fs,
                index: index::Index::default(),
            }),
            modes: Arc::new(self.modes.into_inner().unwrap_or_else(|e| e.into_inner())),
        }
    }
}

/// A file's contents as a shareable buffer: the buffer itself for a
/// read-only file (no copy), the bytes otherwise.
fn owned_buffer(fs: &mem_fs::FileSystem, path: &Path) -> Option<shared_buffer::OwnedBuffer> {
    let file = fs.new_open_options().read(true).open(path).ok()?;
    if let Some(buffer) = file.as_owned_buffer() {
        return Some(buffer);
    }
    drop(file);
    read_file(fs, path)
        .ok()
        .map(shared_buffer::OwnedBuffer::from)
}

/// Every entry under `root` with its metadata, parents first, without
/// following symlinks. `virtual_fs::walk` reads every entry as a directory,
/// symlinks included, which loops on a `node_modules` that links back up.
fn walk_no_follow(
    fs: &(impl FileSystem + ?Sized),
    root: &Path,
) -> Vec<(PathBuf, virtual_fs::Metadata)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(children) = fs.read_dir(&dir) else {
            continue;
        };
        for child in children.flatten() {
            let Ok(meta) = fs.symlink_metadata(&child.path) else {
                // A whiteout marker has no target; report it by name.
                out.push((child.path, virtual_fs::Metadata::default()));
                continue;
            };
            if meta.is_dir() {
                stack.push(child.path.clone());
            }
            out.push((child.path, meta));
        }
    }
    out
}

/// A frozen workspace, shared by every job that uses it. Cheap to clone.
#[derive(Debug, Clone)]
pub struct Snapshot {
    fs: Arc<ReadOnlyFs>,
    modes: modes::SnapshotModes,
}

impl Snapshot {
    /// The mode the snapshot gave `path`, if it gave it one (a checked-out
    /// executable); other paths have the default for their type.
    pub fn mode(&self, path: impl AsRef<Path>) -> Option<u32> {
        self.modes.get(path.as_ref()).copied()
    }

    pub fn read(&self, path: impl AsRef<Path>) -> Result<Vec<u8>> {
        read_file(self.fs.as_ref(), path)
    }

    pub fn is_file(&self, path: impl AsRef<Path>) -> bool {
        is_file(self.fs.as_ref(), path)
    }

    pub fn is_dir(&self, path: impl AsRef<Path>) -> bool {
        is_dir(self.fs.as_ref(), path)
    }

    pub fn list_files(&self, root: impl AsRef<Path>) -> Vec<PathBuf> {
        list_files(self.fs.as_ref(), root)
    }

    /// The names directly in `dir`, and whether each is a directory
    /// (symlinks are not followed, so a link to one is not).
    pub fn list_dir(&self, dir: impl AsRef<Path>) -> Vec<(String, bool)> {
        let fs = self.fs.as_ref();
        let Ok(children) = fs.read_dir(dir.as_ref()) else {
            return Vec::new();
        };
        let mut out: Vec<(String, bool)> = children
            .flatten()
            .filter_map(|c| {
                let name = c.path.file_name()?.to_str()?.to_string();
                let is_dir = fs.symlink_metadata(&c.path).is_ok_and(|m| m.is_dir());
                Some((name, is_dir))
            })
            .collect();
        out.sort();
        out
    }

    /// [`Snapshot::list_files`] without descending into directories
    /// `skip_dir` names (by their name alone), such as `node_modules`.
    pub fn list_files_skipping(
        &self,
        root: impl AsRef<Path>,
        skip_dir: impl Fn(&str) -> bool,
    ) -> Vec<PathBuf> {
        let fs = self.fs.as_ref();
        let mut out = Vec::new();
        let mut stack = vec![root.as_ref().to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(children) = fs.read_dir(&dir) else {
                continue;
            };
            for child in children.flatten() {
                let Ok(meta) = fs.symlink_metadata(&child.path) else {
                    continue;
                };
                if meta.is_dir() {
                    let skip = child
                        .path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(&skip_dir);
                    if !skip {
                        stack.push(child.path);
                    }
                } else if meta.is_file() {
                    out.push(child.path);
                }
            }
        }
        out.sort();
        out
    }

    /// The snapshot itself as a file system, read only: for files that are
    /// mounted into jobs as they are, such as a Node tool's directory,
    /// rather than forked for a job to write over.
    pub fn read_only(&self) -> DynFs {
        self.fs.clone()
    }

    /// A writable view for one job: a fresh in-memory layer over this
    /// snapshot. Constant time; nothing is copied until the job writes.
    pub fn fork(&self) -> JobFs {
        self.fork_with(None, None)
    }

    /// [`Snapshot::fork`], with the bytes the job adds held to `budget`: a
    /// write past it is refused as a full disk would refuse it. The job's
    /// files live in memory, so this is what keeps a job that writes
    /// gigabytes inside its memory limit. See `limit.rs`.
    pub fn fork_limited(&self, budget: Arc<dyn WriteBudget>) -> JobFs {
        self.fork_with(Some(budget), None)
    }

    /// [`Snapshot::fork_limited`], with the job's files kept in memory only
    /// up to `spill.resident_max` bytes: past that, the least recently used
    /// move to unlinked files in `spill.dir` on the host's disk, so `budget`
    /// can allow a job more files than its memory holds. See the vendored
    /// virtual-fs's `mem_fs/spill.rs`.
    pub fn fork_spilling(&self, budget: Arc<dyn WriteBudget>, spill: SpillConfig) -> JobFs {
        self.fork_with(Some(budget), Some(spill))
    }

    fn fork_with(&self, budget: Option<Arc<dyn WriteBudget>>, spill: Option<SpillConfig>) -> JobFs {
        let upper = TmpFileSystem::new();
        let spill = spill.map(|config| upper.set_spill(config));
        let modes = Modes::over(self.modes.clone());
        modes.numbered_by(Arc::new(upper.clone()));
        let overlay = JobOverlay {
            inner: OverlayFileSystem::new(upper.clone(), [self.fs.clone()]),
            upper: upper.clone(),
            base: self.fs.clone(),
            budget,
            modes,
            accounts: Default::default(),
            renames: futures::lock::Mutex::new(()),
        };
        JobFs {
            overlay: Arc::new(overlay),
            upper,
            base: self.clone(),
            spill,
        }
    }
}

/// One job's file system. See [`Snapshot::fork`].
#[derive(Debug, Clone)]
pub struct JobFs {
    overlay: Arc<JobOverlay>,
    upper: TmpFileSystem,
    base: Snapshot,
    /// How much of the job's files is in memory and on disk, when they
    /// spill ([`Snapshot::fork_spilling`]).
    spill: Option<Arc<mem_fs::Spill>>,
}

/// A path a job changed, relative to nothing: these are absolute guest paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Added { path: PathBuf, bytes: Vec<u8> },
    Modified { path: PathBuf, bytes: Vec<u8> },
    Deleted { path: PathBuf },
}

impl Change {
    pub fn path(&self) -> &Path {
        match self {
            Change::Added { path, .. }
            | Change::Modified { path, .. }
            | Change::Deleted { path } => path,
        }
    }
}

impl JobFs {
    /// What the guest is given.
    pub fn as_dyn(&self) -> DynFs {
        self.overlay.clone()
    }

    /// The job's file modes: the snapshot's, and what the job changed.
    /// What the job's writes are charged to, when it has a limit.
    pub fn budget(&self) -> Option<Arc<dyn WriteBudget>> {
        self.overlay.budget.clone()
    }

    /// Bytes of the job's files in memory and on disk, when they spill;
    /// `None` when every file is in memory.
    pub fn spill_usage(&self) -> Option<(u64, u64)> {
        self.spill.as_ref().map(|spill| spill.usage())
    }

    pub fn modes(&self) -> Modes {
        self.overlay.modes.clone()
    }

    pub fn read(&self, path: impl AsRef<Path>) -> Result<Vec<u8>> {
        read_file(self.overlay.as_ref(), path)
    }

    pub fn write(&self, path: impl AsRef<Path>, bytes: &[u8]) -> Result<()> {
        write_file(self.overlay.as_ref(), path, bytes)
    }

    /// Makes an empty file at `path` for the job (`$IWCI_OUTPUT`): what the
    /// job writes to it is charged as any write, but not its entry, which
    /// is the runner's.
    pub fn create_for_job(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = normalise(path)?;
        if let Some(parent) = path.parent() {
            create_dir_all(self.overlay.as_ref(), parent)?;
        }
        let conf = virtual_fs::OpenOptionsConfig {
            read: false,
            write: true,
            create_new: false,
            create: true,
            append: false,
            truncate: true,
        };
        self.overlay
            .open_with(&path, &conf, false)
            .map(drop)
            .map_err(fs_err(&path))
    }

    pub fn remove_file(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = normalise(path)?;
        self.overlay.remove_file(&path).map_err(fs_err(&path))
    }

    pub fn remove_dir(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = normalise(path)?;
        self.overlay.remove_dir(&path).map_err(fs_err(&path))
    }

    pub fn create_dir(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = normalise(path)?;
        self.overlay.create_dir(&path).map_err(fs_err(&path))
    }

    /// Everything at and under `paths` as the job sees it now (its own
    /// writes over the snapshot), parents first, symlinks not followed.
    /// Missing paths are skipped: a cache path a job never created is not
    /// an error.
    pub fn entries_under(&self, paths: &[impl AsRef<Path>]) -> Vec<Entry> {
        let fs = self.overlay.as_ref();
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for root in paths {
            let Ok(root) = normalise(root) else { continue };
            let Ok(meta) = fs.symlink_metadata(&root) else {
                continue;
            };
            let mut todo = vec![(root.clone(), meta)];
            if todo[0].1.is_dir() {
                todo.extend(walk_no_follow(fs, &root));
            }
            for (path, meta) in todo {
                if !seen.insert(path.clone()) {
                    continue;
                }
                let ft = meta.file_type();
                if ft.is_symlink() {
                    if let Ok(target) = fs.readlink(&path) {
                        out.push(Entry::Symlink { path, target });
                    }
                } else if ft.is_dir() {
                    out.push(Entry::Dir { path });
                } else if let Ok(bytes) = read_file(fs, &path) {
                    out.push(Entry::File {
                        path,
                        data: bytes.into(),
                    });
                }
            }
        }
        out.sort_by_key(|e| match e {
            Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => {
                path.components().count()
            }
        });
        out
    }

    /// Writes `entries` into the job, as the job's own writes: they count
    /// against its write budget and show up in [`JobFs::changes`].
    pub fn apply(&self, entries: &[Entry]) -> Result<()> {
        let fs = self.overlay.as_ref();
        for entry in entries {
            match entry {
                Entry::Dir { path } => create_dir_all(fs, path)?,
                Entry::File { path, data } => write_file(fs, path, data)?,
                Entry::Symlink { path, target } => {
                    let path = normalise(path)?;
                    let _ = fs.remove_file(&path);
                    symlink(fs, &path, target)?;
                }
            }
        }
        Ok(())
    }

    /// The modes recorded for the files and directories among `entries`,
    /// to keep beside them ([`archive::encode_with_modes`]).
    pub fn modes_of(&self, entries: &[Entry]) -> archive::ModeList {
        let modes = self.modes();
        entries
            .iter()
            .filter_map(|e| match e {
                Entry::Dir { path } | Entry::File { path, .. } => {
                    modes.get(path).map(|mode| (path.clone(), mode))
                }
                Entry::Symlink { .. } => None,
            })
            .collect()
    }

    /// Gives the files among `entries`, which [`JobFs::apply`] wrote, the
    /// modification time of the Unix epoch, as a machine's put gives them:
    /// a cache's files are older than anything the job writes. Stamped with
    /// the time of the restore instead, a restored pnpm store looked
    /// changed since pnpm last checked it, and pnpm hashed every file of it
    /// again (161,102 files, 55 s, in one job).
    pub fn set_restored_times(&self, entries: &[Entry]) {
        for entry in entries {
            if let Entry::File { path, .. } = entry
                && let Ok(path) = normalise(path)
                && let Ok(mut file) = self.upper.new_open_options().read(true).open(&path)
            {
                let _ = file.set_times(None, Some(0));
            }
        }
    }

    /// Records `modes` (what [`JobFs::modes_of`] kept) for paths
    /// [`JobFs::apply`] wrote, as `chmod` would.
    pub fn apply_modes(&self, modes: &[(PathBuf, u32)]) {
        let recorded = self.modes();
        for (path, mode) in modes {
            recorded.set(path, *mode);
        }
    }

    /// What the job's own layer holds over the snapshot: every directory,
    /// file and link written since the fork, parents before children. What
    /// it deleted is not listed. A virtual machine that has the snapshot
    /// already is sent only this.
    pub fn own_entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        for (path, meta) in walk_no_follow(&self.upper, Path::new("/")) {
            if whiteout_target(&path).is_some() {
                continue;
            }
            let ft = meta.file_type();
            if ft.is_symlink() {
                if let Ok(target) = self.upper.readlink(&path) {
                    out.push(Entry::Symlink { path, target });
                }
            } else if ft.is_dir() {
                out.push(Entry::Dir { path });
            } else if ft.is_file()
                && let Ok(bytes) = read_file(&self.upper, &path)
            {
                out.push(Entry::File {
                    path,
                    data: bytes.into(),
                });
            }
        }
        out.sort_by_key(|e| match e {
            Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => {
                path.components().count()
            }
        });
        out
    }

    /// Every file the job added, changed or deleted under `root`, sorted by
    /// path. A file rewritten with the bytes it already had is not a change,
    /// so a formatter that rewrites everything still reports only what moved.
    pub fn changes(&self, root: impl AsRef<Path>) -> Vec<Change> {
        let root = root.as_ref();
        let mut changes = BTreeMap::new();
        for (path, meta) in walk_no_follow(&self.upper, root) {
            if let Some(deleted) = whiteout_target(&path) {
                if self.base.is_file(&deleted) {
                    changes.insert(deleted.clone(), Change::Deleted { path: deleted });
                } else if self.base.is_dir(&deleted) {
                    for path in self.base.list_files(&deleted) {
                        changes.insert(path.clone(), Change::Deleted { path });
                    }
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let Ok(bytes) = read_file(&self.upper, &path) else {
                continue;
            };
            let change = match self.base.read(&path) {
                Ok(old) if old == bytes => continue,
                Ok(_) => Change::Modified { path, bytes },
                Err(_) => Change::Added { path, bytes },
            };
            changes.insert(change.path().to_path_buf(), change);
        }
        changes.into_values().collect()
    }
}

/// The marker Wasmer's overlay uses for a deleted lower-layer entry.
const WHITEOUT_PREFIX: &str = ".wh.";

/// The path a whiteout marker hides, if `path` is one.
fn whiteout_target(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let hidden = name.strip_prefix(WHITEOUT_PREFIX)?;
    Some(path.with_file_name(hidden))
}

fn whiteout_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    Some(path.with_file_name(format!("{WHITEOUT_PREFIX}{name}")))
}

/// Wasmer's overlay with directory removal made POSIX-like. On its own the
/// overlay gets three things wrong, all of which a job's `rm -rf` or a
/// build's `rm -rf dist && mkdir dist` reaches:
///
/// - Removing the last entry of a lower-layer directory leaves an upper copy
///   full of whiteout markers, so the directory then refuses to go
///   (`Directory not empty`).
/// - It whites out a lower-layer directory without checking the merged view
///   is empty, so `rmdir` of a populated directory deletes the whole tree.
/// - Recreating a deleted lower-layer directory drops its whiteout, and the
///   old contents come back. Real overlayfs marks such a directory opaque;
///   here every lower entry is whited out inside the new one instead.
///
/// It also keeps the job's file modes in step with its paths (`modes.rs`).
#[derive(Debug)]
pub struct JobOverlay {
    inner: OverlayFileSystem<TmpFileSystem, [Arc<ReadOnlyFs>; 1]>,
    upper: TmpFileSystem,
    base: Arc<ReadOnlyFs>,
    budget: Option<Arc<dyn WriteBudget>>,
    modes: Modes,
    /// What each file the job may have changed was given without being
    /// charged (`limit::Account`), by path in the upper layer.
    accounts: std::sync::Mutex<tree::PathTree<Arc<limit::Account>>>,
    /// Held for the whole of a rename (#1092). A rename looks at what is
    /// at both ends, then changes them, in several steps across the two
    /// layers; two renames onto one name at once both saw the old file
    /// there, and the second failed to remove what the first had already
    /// replaced. Async, as a rename awaits under it.
    renames: futures::lock::Mutex<()>,
}

impl JobOverlay {
    /// The size of `path` in the upper layer, when it is a file there.
    fn upper_size(&self, path: &Path) -> Option<u64> {
        let meta = self.upper.symlink_metadata(path).ok()?;
        meta.is_file().then_some(meta.len)
    }

    fn accounts(&self) -> std::sync::MutexGuard<'_, tree::PathTree<Arc<limit::Account>>> {
        self.accounts.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The account of the file at `path`; one with nothing given, for a
    /// file the job made itself, if it has none.
    fn account(&self, path: &Path) -> Arc<limit::Account> {
        self.accounts()
            .get_or_insert_with(path, || limit::Account::new(0))
            .clone()
    }

    /// What the job was charged for the upper file at `path`, which is
    /// going: it is given back once the caller has removed the file. A
    /// name of a file that keeps others gives back only its entry; the
    /// bytes go with the last name.
    fn release(&self, path: &Path) -> Option<u64> {
        let meta = self.upper.symlink_metadata(path).ok()?;
        if !meta.is_file() {
            return None;
        }
        let account = self.accounts().remove(path);
        if meta.nlink > 1 {
            return Some(account.map_or(0, |a| a.entry()));
        }
        Some(account.map_or(meta.len, |a| a.released(meta.len) + a.entry()))
    }

    /// The name `path` of a file is gone (`meta` is what the file was
    /// before): the mode record forgets it as a name of a file with hard
    /// links, and the file itself with its last name.
    fn lost_name(&self, path: &Path, meta: Option<virtual_fs::Metadata>) {
        if let Some(meta) = meta
            && meta.ino != 0
        {
            self.modes.unlinked(meta.ino, path, meta.nlink <= 1);
        }
    }

    /// Copies the snapshot's file at `path` up into the job's layer, as a
    /// write to it would, and free for the same reason. In memory, every
    /// read and write here is done on its first poll; one that is not
    /// fails rather than waiting, since this may run inside the guest's
    /// executor, where nothing may block.
    fn copy_up(&self, path: &Path) -> virtual_fs::Result<()> {
        use std::future::Future;
        fn now<F: Future>(future: F) -> virtual_fs::Result<F::Output> {
            let mut future = std::pin::pin!(future);
            let mut cx = std::task::Context::from_waker(futures::task::noop_waker_ref());
            match future.as_mut().poll(&mut cx) {
                std::task::Poll::Ready(out) => Ok(out),
                std::task::Poll::Pending => Err(FsError::IOError),
            }
        }
        let mut bytes = Vec::new();
        let mut src = self.base.new_open_options().read(true).open(path)?;
        now(src.read_to_end(&mut bytes))??;
        if let Some(parent) = path.parent() {
            create_dir_all(&self.upper, parent).map_err(|_| FsError::IOError)?;
        }
        let mut dst = self
            .upper
            .new_open_options()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        now(dst.write_all(&bytes))??;
        now(dst.flush())??;
        self.accounts()
            .insert(path, limit::Account::new(bytes.len() as u64));
        Ok(())
    }

    /// Accounts at and under `from` now belong at `to`.
    fn move_accounts(&self, from: &Path, to: &Path) {
        self.accounts().rename(from, to);
    }

    fn give(&self, bytes: Option<u64>) {
        if let (Some(budget), Some(bytes)) = (&self.budget, bytes) {
            budget.give(bytes);
        }
    }

    fn limited(
        &self,
        path: &Path,
        file: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static> {
        match &self.budget {
            Some(budget) if conf.write || conf.append => Box::new(limit::LimitedFile::new(
                file,
                budget.clone(),
                self.account(path),
                conf.append,
            )),
            _ => file,
        }
    }

    fn white_out(&self, path: &Path) -> virtual_fs::Result<()> {
        let marker = whiteout_path(path).ok_or(FsError::InvalidInput)?;
        if let Some(parent) = marker.parent() {
            create_dir_all(&self.upper, parent).map_err(|_| FsError::IOError)?;
        }
        self.upper
            .new_open_options()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&marker)
            .map(|_| ())
    }

    /// Removes everything under `path` in the upper layer, whiteouts
    /// included, deepest first.
    fn purge_upper(&self, path: &Path) -> virtual_fs::Result<()> {
        if let Ok(entries) = self.upper.read_dir(path) {
            for entry in entries.flatten() {
                let is_dir = self
                    .upper
                    .symlink_metadata(&entry.path)
                    .is_ok_and(|m| m.is_dir());
                if is_dir {
                    self.purge_upper(&entry.path)?;
                } else {
                    let charged = self.release(&entry.path);
                    self.upper.remove_file(&entry.path)?;
                    self.give(charged);
                }
            }
        }
        self.upper.remove_dir(path)
    }

    /// Removes the directory at `path`, which the merged view already shows
    /// empty: its upper copy (whiteouts and all) goes, and a snapshot
    /// directory there is whited out.
    fn drop_empty_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        if self.upper.metadata(path).is_ok_and(|m| m.is_dir()) {
            self.purge_upper(path)?;
        }
        if self.base.metadata(path).is_ok_and(|m| m.is_dir()) {
            self.white_out(path)?;
        }
        Ok(())
    }

    /// Removes the file or symlink at `path` (whiting out a snapshot one) and
    /// gives back the bytes the job was charged for it.
    fn unlink(&self, path: &Path) -> virtual_fs::Result<()> {
        let charged = self.release(path);
        self.inner.remove_file(path)?;
        self.give(charged);
        Ok(())
    }

    /// Whether the job deleted `path` or a directory above it: a whiteout
    /// hides the snapshot's entry there.
    fn hidden(&self, path: &Path) -> bool {
        path.ancestors().any(|p| {
            whiteout_path(p).is_some_and(|marker| self.upper.symlink_metadata(&marker).is_ok())
        })
    }

    fn clear_white_out(&self, path: &Path) {
        if let Some(marker) = whiteout_path(path) {
            let _ = self.upper.remove_file(&marker);
        }
    }

    /// Moves what is at `from` to `to` in the merged view, as `rename(2)`
    /// does. The overlay's own rename only works within the upper layer: a
    /// snapshot file it copies up to `to`, which fails while `to`'s parent
    /// exists only in the snapshot (that is, always, for a fresh job: #985),
    /// and a snapshot directory or a symlink it cannot move at all. Modes are
    /// left to the caller.
    fn move_entry<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        Box::pin(async move {
            let meta = self.inner.symlink_metadata(from)?;
            if from == to {
                return Ok(());
            }
            let kind = meta.file_type();
            if kind.is_dir() && to.starts_with(from) {
                return Err(FsError::InvalidInput);
            }
            let parent = to.parent().ok_or(FsError::InvalidInput)?;
            if !self.inner.metadata(parent)?.is_dir() {
                return Err(FsError::BaseNotDirectory);
            }
            // What `to` replaces: a file by a file, an empty directory by a
            // directory, as on Linux.
            if let Ok(existing) = self.inner.symlink_metadata(to) {
                match (kind.is_dir(), existing.is_dir()) {
                    (true, true) => {
                        if self.inner.read_dir(to)?.next().is_some() {
                            return Err(FsError::DirectoryNotEmpty);
                        }
                        self.drop_empty_dir(to)?;
                    }
                    (true, false) => return Err(FsError::BaseNotDirectory),
                    (false, true) => return Err(FsError::InvalidInput),
                    // The job's own file replaces `to` in one step below,
                    // so that `to` is never missing in between (#1092).
                    (false, false)
                        if !kind.is_symlink() && self.upper.symlink_metadata(from).is_ok() => {}
                    (false, false) => self.unlink(to)?,
                }
            }
            // Everything below writes `to` into the upper layer, where its
            // parent may so far exist only in the snapshot.
            create_dir_all(&self.upper, parent).map_err(|_| FsError::IOError)?;
            let from_in_base = self.base.symlink_metadata(from).is_ok() && !self.hidden(from);

            if kind.is_symlink() {
                let target = self.inner.readlink(from)?;
                self.upper.create_symlink(&target, to)?;
                self.clear_white_out(to);
                return self.unlink(from);
            }
            if !kind.is_dir() {
                if self.upper.symlink_metadata(from).is_ok() {
                    // The job's own file (or its copy of a snapshot one):
                    // the overlay renames it within the upper layer, over
                    // whatever the upper layer has at `to`, and whites out a
                    // snapshot file at `from`. A snapshot file at `to` is
                    // hidden by the upper one, as a copy-up hides it.
                    let replaced = self.release(to);
                    self.inner.rename(from, to).await?;
                    self.give(replaced);
                    self.move_accounts(from, to);
                    return Ok(());
                }
                // A snapshot file is copied up to `to`, as a write to it
                // would copy it up, and is not charged to the job for the
                // same reason. Not with the overlay's `copy_reference`: the
                // node that makes shares one read position between every
                // handle, so a second read of the file comes back empty.
                // Awaited, not through `read_file`: this runs inside the
                // guest's executor, which `block_on` refuses to nest in.
                let mut bytes = Vec::new();
                let mut src = self.base.new_open_options().read(true).open(from)?;
                src.read_to_end(&mut bytes).await?;
                let mut dst = self
                    .upper
                    .new_open_options()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(to)?;
                dst.write_all(&bytes).await?;
                dst.flush().await?;
                self.accounts()
                    .insert(to, limit::Account::new(bytes.len() as u64));
                self.clear_white_out(to);
                return self.white_out(from);
            }
            // A directory the snapshot has no part in, at either end, moves
            // as one upper-layer directory.
            if !from_in_base && self.base.symlink_metadata(to).is_err() {
                self.inner.rename(from, to).await?;
                self.move_accounts(from, to);
                return Ok(());
            }
            // Otherwise entry by entry: `to` is made as `create_dir` makes it
            // (a snapshot directory deleted there stays deleted), everything
            // in `from` moves into it, and `from`, now empty, goes.
            FileSystem::create_dir(self, to)?;
            let children: Vec<PathBuf> = self
                .inner
                .read_dir(from)?
                .flatten()
                .map(|e| e.path)
                .collect();
            for child in children {
                let Some(name) = child.file_name() else {
                    continue;
                };
                self.move_entry(&child, &to.join(name)).await?;
            }
            self.drop_empty_dir(from)
        })
    }
}

impl FileSystem for JobOverlay {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.inner.readlink(path)
    }
    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.inner.read_dir(path)
    }
    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        let was_deleted = whiteout_path(path).is_some_and(|m| self.upper.metadata(&m).is_ok());
        self.inner.create_dir(path)?;
        if was_deleted && let Ok(entries) = self.base.read_dir(path) {
            for entry in entries.flatten() {
                self.white_out(&entry.path)?;
            }
        }
        Ok(())
    }
    fn create_symlink(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.inner.create_symlink(source, target)
    }
    /// Gives the file at `source` the second name `target`, as `link(2)`.
    /// Both names are the job's layer's, one file there: a snapshot file
    /// is copied up first, as a write to it would be, so a write through
    /// either name is read through the other. The file reports the inode
    /// number its first name had (`Metadata::ino`, the [`modes::ino_of`]
    /// of that path unless it had a number already) and one mode for every
    /// name ([`Modes::linked`]). The new name's entry is charged as a new
    /// file's is; the file's bytes are not, once per name, and go back
    /// with the last name (`release`).
    ///
    /// Not through Wasmer's overlay, whose `hard_link` removes the
    /// whiteout at `target` before anything else, which can bring a
    /// deleted snapshot file back when the link then fails.
    fn hard_link(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        let meta = self.inner.symlink_metadata(source)?;
        if meta.is_dir() || meta.file_type().is_symlink() {
            return Err(FsError::PermissionDenied);
        }
        if self.inner.symlink_metadata(target).is_ok() {
            return Err(FsError::AlreadyExists);
        }
        let parent = target.parent().ok_or(FsError::AlreadyExists)?;
        if !self.inner.metadata(parent)?.is_dir() {
            return Err(FsError::BaseNotDirectory);
        }
        if self.upper.symlink_metadata(source).is_err() {
            self.copy_up(source)?;
        }
        create_dir_all(&self.upper, parent).map_err(|_| FsError::IOError)?;
        let cost = entry_cost(target);
        if let Some(budget) = &self.budget
            && !budget.take(cost)
        {
            return Err(FsError::WriteZero);
        }
        let ino = match meta.ino {
            0 => modes::ino_of(source),
            ino => ino,
        };
        if let Err(e) = self.upper.hard_link_numbered(source, target, ino) {
            self.give(Some(cost));
            return Err(e);
        }
        self.clear_white_out(target);
        let account = self.account(source).linked(cost);
        self.accounts().insert(target, account);
        self.modes.linked(source, target, ino);
        Ok(())
    }
    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        if !self.inner.symlink_metadata(path)?.is_dir() {
            return Err(FsError::BaseNotDirectory);
        }
        // The merged listing already hides whited-out entries.
        if self.inner.read_dir(path)?.next().is_some() {
            return Err(FsError::DirectoryNotEmpty);
        }
        self.drop_empty_dir(path)?;
        self.modes.removed(path);
        Ok(())
    }
    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        Box::pin(async move {
            let _one_at_a_time = self.renames.lock().await;
            // Two names of one file: nothing happens, as `rename(2)` does
            // nothing then.
            if from != to && self.upper.same_file(from, to) {
                return Ok(());
            }
            let replaced = self.upper.symlink_metadata(to).ok();
            self.move_entry(from, to).await?;
            self.modes.renamed(from, to);
            self.lost_name(to, replaced);
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
        let meta = self.upper.symlink_metadata(path).ok();
        self.unlink(path)?;
        self.modes.removed(path);
        self.lost_name(path, meta);
        Ok(())
    }
    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for JobOverlay {
    fn open(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        self.open_with(path, conf, true)
    }
}

impl JobOverlay {
    /// [`virtual_fs::FileOpener::open`]; a new file's entry is charged
    /// only with `charge_entry` (not for one the runner makes for the job).
    fn open_with(
        &self,
        path: &Path,
        conf: &virtual_fs::OpenOptionsConfig,
        charge_entry: bool,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        // The overlay's copy-on-write opens the lower file without
        // `truncate` and copies it up on the first write, so writing fewer
        // bytes than the file held leaves the old tail in place: `ab` over
        // `0123456789` reads back `ab23456789`. A truncating open needs none
        // of the old content, so it gets a fresh upper file instead.
        let truncating = conf.truncate && (conf.write || conf.append);
        let lower_only = self.upper.symlink_metadata(path).is_err()
            && self.base.metadata(path).is_ok_and(|m| m.is_file())
            && !whiteout_path(path).is_some_and(|m| self.upper.metadata(&m).is_ok());
        let writing = conf.write || conf.append;
        if truncating && lower_only {
            if let Some(parent) = path.parent() {
                create_dir_all(&self.upper, parent).map_err(|_| FsError::IOError)?;
            }
            let file = self
                .upper
                .new_open_options()
                .options(conf.clone())
                .create(true)
                .open(path)?;
            self.accounts().insert(path, limit::Account::new(0));
            return Ok(self.limited(path, file, conf));
        }
        // Truncating a file the job wrote gives back what it added.
        let in_upper = self.upper_size(path);
        let released = match in_upper {
            Some(size) if truncating => Some(self.account(path).shrunk(size, 0)),
            _ => None,
        };
        // A file that is not there yet is the job's from its first byte,
        // and its entry (the upper layer's node and its account here) is
        // charged before it is made, as a write past the budget is refused.
        let entry = match &self.budget {
            Some(budget) if charge_entry && writing && in_upper.is_none() && !lower_only => {
                let cost = entry_cost(path);
                if !budget.take(cost) {
                    return Err(FsError::WriteZero);
                }
                Some(cost)
            }
            _ => None,
        };
        let file = match self
            .inner
            .new_open_options()
            .options(conf.clone())
            .open(path)
        {
            Ok(file) => file,
            Err(e) => {
                self.give(entry);
                return Err(e);
            }
        };
        self.give(released);
        if writing && in_upper.is_none() {
            // A snapshot file is copied up on its first change, free (its
            // other open handles share the account).
            let mut accounts = self.accounts();
            if lower_only {
                let given = self.base.metadata(path).map_or(0, |m| m.len);
                accounts.get_or_insert_with(path, || limit::Account::new(given));
            } else {
                accounts.insert(path, limit::Account::made(entry.unwrap_or(0)));
            }
        }
        Ok(self.limited(path, file, conf))
    }
}

/// What a file the job makes is charged beside its bytes: the upper layer's
/// node for it and its write account (`accounts.rs`), its name included.
/// Measured at about 350 bytes counted by the allocator, which keeps a
/// little more of its own (`tests/accounts_memory.rs` holds the job to
/// paying at least what it holds), so a job of tiny files cannot hold more
/// of the runner's memory than its budget says, however deep they are.
pub const ENTRY_COST: u64 = 512;

fn entry_cost(path: &Path) -> u64 {
    ENTRY_COST + path.file_name().map_or(0, |n| n.len() as u64)
}

/// A frozen in-memory file system: every read is forwarded, every write is
/// refused. The overlay never writes to its lower layer, so this is belt and
/// braces against a bug there leaking one job's writes into the next.
/// Lookups and listings are answered from an index of the directories
/// (`index.rs`), which a frozen file system can keep.
#[derive(Debug)]
pub struct ReadOnlyFs {
    fs: mem_fs::FileSystem,
    index: index::Index,
}

impl FileSystem for ReadOnlyFs {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.fs.readlink(path)
    }
    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.index.read_dir(&self.fs, path)
    }
    fn create_dir(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn create_symlink(&self, _: &Path, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn hard_link(&self, _: &Path, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn remove_dir(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn rename<'a>(
        &'a self,
        _: &'a Path,
        _: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        Box::pin(async { Err(FsError::PermissionDenied) })
    }
    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.index.metadata(&self.fs, path)
    }
    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.index.metadata(&self.fs, path)
    }
    fn remove_file(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for ReadOnlyFs {
    fn open(
        &self,
        path: &Path,
        _conf: &virtual_fs::OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>> {
        // The overlay opens the lower file with the guest's own flags and
        // copies it up on the first write, so a write-intent open has to
        // succeed here; it just never gets a handle that can write.
        self.fs
            .new_open_options()
            .read(true)
            .write(false)
            .append(false)
            .truncate(false)
            .create(false)
            .create_new(false)
            .open(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Snapshot {
        let builder = SnapshotBuilder::new();
        builder
            .write("/app/src/a.ts", b"export const a = 1;\n")
            .unwrap();
        builder
            .write("/app/src/b.ts", b"export const b = 2;\n")
            .unwrap();
        builder.write("/app/old/c.ts", b"c\n").unwrap();
        builder
            .write(
                "/app/node_modules/.pnpm/x@1.0.0/node_modules/x/index.d.ts",
                b"export {};\n",
            )
            .unwrap();
        builder
            .symlink("/app/node_modules/x", ".pnpm/x@1.0.0/node_modules/x")
            .unwrap();
        builder.freeze()
    }

    #[test]
    fn normalise_refuses_escapes_and_relative_paths() {
        assert_eq!(normalise("/a/./b//c").unwrap(), PathBuf::from("/a/b/c"));
        assert!(normalise("/a/../etc").is_err());
        assert!(normalise("a/b").is_err());
        assert!(join_under("/app", "../etc/passwd").is_err());
        assert!(join_under("/app", "/etc/passwd").is_err());
        assert_eq!(
            join_under("/app", "x/y").unwrap(),
            PathBuf::from("/app/x/y")
        );
    }

    #[test]
    fn a_fork_reads_the_snapshot_and_follows_symlinks() {
        let job = snapshot().fork();
        assert_eq!(job.read("/app/src/a.ts").unwrap(), b"export const a = 1;\n");
        assert_eq!(
            job.read("/app/node_modules/x/index.d.ts").unwrap(),
            b"export {};\n"
        );
    }

    #[test]
    fn forks_do_not_see_each_others_writes() {
        let snap = snapshot();
        let one = snap.fork();
        let two = snap.fork();
        one.write("/app/src/a.ts", b"changed\n").unwrap();
        assert_eq!(two.read("/app/src/a.ts").unwrap(), b"export const a = 1;\n");
        assert_eq!(
            snap.read("/app/src/a.ts").unwrap(),
            b"export const a = 1;\n"
        );
    }

    #[test]
    fn own_entries_are_the_jobs_writes_and_nothing_of_the_snapshot() {
        let job = snapshot().fork();
        job.write("/app/src/new.ts", b"new\n").unwrap();
        job.write("/root/.ssh/key", b"k").unwrap();
        job.remove_file("/app/old/c.ts").unwrap();
        let mut seen: Vec<String> = job
            .own_entries()
            .into_iter()
            .map(|e| match e {
                Entry::Dir { path } => format!("dir {}", path.display()),
                Entry::File { path, data } => {
                    format!("file {} {}", path.display(), data.len())
                }
                Entry::Symlink { path, .. } => format!("link {}", path.display()),
            })
            .collect();
        seen.sort();
        assert!(
            seen.contains(&"file /app/src/new.ts 4".to_string()),
            "{seen:?}"
        );
        assert!(
            seen.contains(&"file /root/.ssh/key 1".to_string()),
            "{seen:?}"
        );
        assert!(seen.contains(&"dir /root/.ssh".to_string()), "{seen:?}");
        // Neither the snapshot's untouched files nor the deletion marker.
        assert!(
            !seen
                .iter()
                .any(|s| s.contains("a.ts") || s.contains(".wh.")),
            "{seen:?}"
        );
    }

    #[test]
    fn changes_reports_adds_edits_and_deletes_but_not_identical_rewrites() {
        let job = snapshot().fork();
        job.write("/app/src/a.ts", b"export const a = 10;\n")
            .unwrap();
        job.write("/app/src/b.ts", b"export const b = 2;\n")
            .unwrap();
        job.write("/app/src/new.ts", b"new\n").unwrap();
        job.remove_file("/app/old/c.ts").unwrap();
        let changes = job.changes("/app");
        assert_eq!(
            changes,
            vec![
                Change::Deleted {
                    path: "/app/old/c.ts".into()
                },
                Change::Modified {
                    path: "/app/src/a.ts".into(),
                    bytes: b"export const a = 10;\n".to_vec()
                },
                Change::Added {
                    path: "/app/src/new.ts".into(),
                    bytes: b"new\n".to_vec()
                },
            ]
        );
    }

    /// `rm -rf /app/old` as a shell does it: children first, then each
    /// directory on the way back up.
    fn rm_rf(job: &JobFs, path: &str) {
        let fs = job.as_dyn();
        let mut dirs = vec![PathBuf::from(path)];
        let mut order = Vec::new();
        while let Some(dir) = dirs.pop() {
            for entry in fs.read_dir(&dir).unwrap().flatten() {
                if fs.symlink_metadata(&entry.path).unwrap().is_dir() {
                    dirs.push(entry.path);
                } else {
                    fs.remove_file(&entry.path).unwrap();
                }
            }
            order.push(dir);
        }
        for dir in order.into_iter().rev() {
            fs.remove_dir(&dir)
                .unwrap_or_else(|e| panic!("rmdir {}: {e}", dir.display()));
        }
    }

    #[test]
    fn rm_rf_of_a_snapshot_tree_succeeds_and_reports_deletions() {
        let builder = SnapshotBuilder::new();
        builder.write("/app/nm/a/b/c.js", b"c").unwrap();
        builder.write("/app/nm/a/d.js", b"d").unwrap();
        builder.write("/app/keep.txt", b"k").unwrap();
        let job = builder.freeze().fork();
        rm_rf(&job, "/app/nm");
        assert!(job.as_dyn().metadata(Path::new("/app/nm")).is_err());
        assert_eq!(
            job.changes("/app"),
            vec![
                Change::Deleted {
                    path: "/app/nm/a/b/c.js".into()
                },
                Change::Deleted {
                    path: "/app/nm/a/d.js".into()
                },
            ]
        );
    }

    #[test]
    fn rmdir_of_a_populated_snapshot_directory_is_refused() {
        let job = snapshot().fork();
        let err = job.remove_dir("/app/src").unwrap_err();
        assert!(
            matches!(
                err,
                VfsError::Fs {
                    source: FsError::DirectoryNotEmpty,
                    ..
                }
            ),
            "{err}"
        );
        assert!(job.read("/app/src/a.ts").is_ok());
    }

    #[test]
    fn recreating_a_deleted_directory_does_not_bring_its_contents_back() {
        let job = snapshot().fork();
        rm_rf(&job, "/app/src");
        job.create_dir("/app/src").unwrap();
        assert!(job.read("/app/src/a.ts").is_err());
        assert_eq!(
            job.as_dyn()
                .read_dir(Path::new("/app/src"))
                .unwrap()
                .count(),
            0
        );
        job.write("/app/src/a.ts", b"new").unwrap();
        assert_eq!(job.read("/app/src/a.ts").unwrap(), b"new");
        assert_eq!(
            job.changes("/app/src"),
            vec![
                Change::Modified {
                    path: "/app/src/a.ts".into(),
                    bytes: b"new".to_vec()
                },
                Change::Deleted {
                    path: "/app/src/b.ts".into()
                },
            ]
        );
    }

    fn link(job: &JobFs, from: &str, to: &str) -> virtual_fs::Result<()> {
        job.as_dyn().hard_link(Path::new(from), Path::new(to))
    }

    fn meta(job: &JobFs, path: &str) -> virtual_fs::Metadata {
        job.as_dyn().metadata(Path::new(path)).unwrap()
    }

    /// Two names of one file (#1052): one inode number, the number of the
    /// first name, a count of two, and a write through either name read
    /// through the other. Removing one name leaves the other with the file.
    #[test]
    fn a_hard_link_is_a_second_name_of_one_file() {
        let job = snapshot().fork();
        job.write("/app/mine", b"x").unwrap();
        link(&job, "/app/mine", "/app/other").unwrap();
        let ino = modes::ino_of(Path::new("/app/mine"));
        for name in ["/app/mine", "/app/other"] {
            let m = meta(&job, name);
            assert_eq!((m.ino, m.nlink, m.len), (ino, 2, 1), "{name}");
        }
        // Appended through one name, read through the other.
        let mut f = job
            .as_dyn()
            .new_open_options()
            .append(true)
            .open(Path::new("/app/other"))
            .unwrap();
        block_on(f.write_all(b"y")).unwrap();
        drop(f);
        assert_eq!(job.read("/app/mine").unwrap(), b"xy");
        // Truncated through the first.
        job.write("/app/mine", b"z").unwrap();
        assert_eq!(job.read("/app/other").unwrap(), b"z");

        // The first name goes; the file stays, with its number.
        job.remove_file("/app/mine").unwrap();
        assert!(job.read("/app/mine").is_err());
        let m = meta(&job, "/app/other");
        assert_eq!((m.ino, m.nlink), (ino, 1));
        assert_eq!(job.read("/app/other").unwrap(), b"z");
        // A name made again is a file of its own.
        job.write("/app/mine", b"new").unwrap();
        assert_eq!(meta(&job, "/app/mine").ino, 0);
        assert_eq!(job.read("/app/other").unwrap(), b"z");
        job.remove_file("/app/other").unwrap();
        assert_eq!(job.read("/app/mine").unwrap(), b"new");
    }

    /// A snapshot file is copied up once to be linked, so both names are
    /// one file in the job's layer. Git has no hard links: each name is
    /// reported as a file with the content, and so is what a cache or an
    /// artifact keeps of them.
    #[test]
    fn a_linked_snapshot_file_is_one_file_and_each_name_a_change() {
        let job = snapshot().fork();
        link(&job, "/app/src/a.ts", "/app/src/a2.ts").unwrap();
        let mut f = job
            .as_dyn()
            .new_open_options()
            .read(true)
            .write(true)
            .open(Path::new("/app/src/a2.ts"))
            .unwrap();
        block_on(f.write_all(b"import")).unwrap();
        drop(f);
        let bytes = b"import const a = 1;\n".to_vec();
        assert_eq!(job.read("/app/src/a.ts").unwrap(), bytes);
        assert_eq!(
            meta(&job, "/app/src/a.ts").ino,
            modes::ino_of(Path::new("/app/src/a.ts"))
        );
        assert_eq!(meta(&job, "/app/src/a2.ts").nlink, 2);
        // A deleted snapshot file can be a name again, linked.
        job.remove_file("/app/src/b.ts").unwrap();
        link(&job, "/app/src/a.ts", "/app/src/b.ts").unwrap();
        assert_eq!(meta(&job, "/app/src/b.ts").nlink, 3);
        assert_eq!(
            job.changes("/app/src"),
            vec![
                Change::Modified {
                    path: "/app/src/a.ts".into(),
                    bytes: bytes.clone()
                },
                Change::Added {
                    path: "/app/src/a2.ts".into(),
                    bytes: bytes.clone()
                },
                Change::Modified {
                    path: "/app/src/b.ts".into(),
                    bytes: bytes.clone()
                },
            ]
        );
        let entries = job.entries_under(&["/app/src"]);
        let mut files: Vec<_> = entries
            .iter()
            .filter_map(|e| match e {
                Entry::File { path, data } => Some((path.clone(), data.to_vec())),
                _ => None,
            })
            .collect();
        files.sort();
        assert_eq!(
            files,
            vec![
                (PathBuf::from("/app/src/a.ts"), bytes.clone()),
                (PathBuf::from("/app/src/a2.ts"), bytes.clone()),
                (PathBuf::from("/app/src/b.ts"), bytes.clone()),
            ]
        );
        // Restored, they are three files.
        let other = snapshot().fork();
        other.apply(&entries).unwrap();
        other.write("/app/src/a.ts", b"a").unwrap();
        assert_eq!(other.read("/app/src/a2.ts").unwrap(), bytes);
    }

    /// What `link(2)` refuses, it refuses with nothing changed: a
    /// directory (EPERM on Linux), a name that is there, a file that is
    /// not; and a failed link onto a deleted snapshot file leaves it
    /// deleted (Wasmer's overlay removed its whiteout first).
    #[test]
    fn a_refused_hard_link_changes_nothing() {
        let job = snapshot().fork();
        assert_eq!(
            link(&job, "/app/src", "/app/src2"),
            Err(FsError::PermissionDenied)
        );
        assert_eq!(
            link(&job, "/app/node_modules/x", "/app/x2"),
            Err(FsError::PermissionDenied),
            "a symbolic link"
        );
        assert_eq!(
            link(&job, "/app/src/a.ts", "/app/src/b.ts"),
            Err(FsError::AlreadyExists)
        );
        job.remove_file("/app/src/b.ts").unwrap();
        assert_eq!(
            link(&job, "/app/src/none.ts", "/app/src/b.ts"),
            Err(FsError::EntryNotFound)
        );
        assert!(job.read("/app/src/b.ts").is_err());
        assert_eq!(
            link(&job, "/app/src/a.ts", "/app/nowhere/a.ts"),
            Err(FsError::EntryNotFound)
        );
        assert_eq!(
            job.changes("/app"),
            vec![Change::Deleted {
                path: "/app/src/b.ts".into()
            }]
        );
    }

    /// A rename onto another name of the same file does nothing, as
    /// `rename(2)` does nothing; one onto a name of another file replaces
    /// only that name.
    #[test]
    fn renames_onto_and_of_linked_names() {
        let job = snapshot().fork();
        job.write("/w/a", b"a").unwrap();
        link(&job, "/w/a", "/w/b").unwrap();
        block_on(job.as_dyn().rename(Path::new("/w/a"), Path::new("/w/b"))).unwrap();
        assert_eq!(job.read("/w/a").unwrap(), b"a");
        assert_eq!(meta(&job, "/w/b").nlink, 2);

        // Over a name of another file with two: that file keeps its other.
        job.write("/w/c", b"c").unwrap();
        link(&job, "/w/c", "/w/d").unwrap();
        block_on(job.as_dyn().rename(Path::new("/w/a"), Path::new("/w/c"))).unwrap();
        assert_eq!(job.read("/w/c").unwrap(), b"a");
        assert_eq!(meta(&job, "/w/c").nlink, 2, "/w/c and /w/b");
        assert_eq!(job.read("/w/d").unwrap(), b"c");
        assert_eq!(meta(&job, "/w/d").nlink, 1);

        // A name moved to another directory, and its directory moved,
        // still names the file.
        job.create_dir("/w/sub").unwrap();
        block_on(
            job.as_dyn()
                .rename(Path::new("/w/b"), Path::new("/w/sub/b")),
        )
        .unwrap();
        block_on(
            job.as_dyn()
                .rename(Path::new("/w/sub"), Path::new("/w/moved")),
        )
        .unwrap();
        job.write("/w/c", b"through c").unwrap();
        assert_eq!(job.read("/w/moved/b").unwrap(), b"through c");
        job.remove_file("/w/c").unwrap();
        assert_eq!(meta(&job, "/w/moved/b").nlink, 1);
        assert_eq!(job.read("/w/moved/b").unwrap(), b"through c");
    }

    /// An open file keeps working whichever of its names goes, and its
    /// handle's own `unlink` (WASIX's, for the last name) removes it.
    #[test]
    fn an_open_linked_file_outlives_its_names() {
        let job = snapshot().fork();
        job.write("/w/a", b"1").unwrap();
        link(&job, "/w/a", "/w/b").unwrap();
        let mut f = open_rw(&job, "/w/a");
        job.remove_file("/w/a").unwrap();
        block_on(f.write_all(b"2")).unwrap();
        assert_eq!(job.read("/w/b").unwrap(), b"2");
        let mut g = open_rw(&job, "/w/b");
        g.unlink().unwrap();
        assert!(job.read("/w/b").is_err());
        assert!(
            job.as_dyn()
                .read_dir(Path::new("/w"))
                .unwrap()
                .next()
                .is_none()
        );
        block_on(f.write_all(b"3")).unwrap();
    }

    /// A file's bytes are charged once whatever its names, each name's
    /// entry as a new file's, and the bytes come back with the last name.
    #[test]
    fn a_file_with_two_names_is_charged_once() {
        let (job, cap) = budgeted(1, 1000, 1 << 20);
        job.write("/own", &[1u8; 100]).unwrap();
        link(&job, "/own", "/two").unwrap();
        assert_eq!(used(&cap), 100 + e("own") + e("two"));
        // Growth through either name is charged once.
        let mut f = job
            .as_dyn()
            .new_open_options()
            .append(true)
            .open(Path::new("/two"))
            .unwrap();
        block_on(f.write_all(&[2u8; 50])).unwrap();
        drop(f);
        assert_eq!(used(&cap), 150 + e("own") + e("two"));
        job.remove_file("/own").unwrap();
        assert_eq!(used(&cap), 150 + e("two"), "the bytes stay with /two");
        job.remove_file("/two").unwrap();
        assert_eq!(used(&cap), 0);

        // A linked snapshot file is copied up free; only the name costs.
        link(&job, "/s/0", "/s/zero").unwrap();
        assert_eq!(used(&cap), e("zero"));
        job.remove_file("/s/0").unwrap();
        job.remove_file("/s/zero").unwrap();
        assert_eq!(used(&cap), 0);

        // A link the budget has no room for is refused.
        let (job, _cap) = budgeted(0, 0, 100 + e("own") + 10);
        job.write("/own", &[1u8; 100]).unwrap();
        assert_eq!(link(&job, "/own", "/two"), Err(FsError::WriteZero));
        assert!(job.read("/two").is_err());
    }

    /// One mode for every name: set through one, read through another,
    /// found by the file's number after its first name went, and given to
    /// a new name by its source.
    #[test]
    fn a_linked_file_has_one_mode() {
        let job = snapshot().fork();
        let modes = job.modes();
        job.write("/w/run", b"#!/bin/sh\n").unwrap();
        modes.set(Path::new("/w/run"), 0o700);
        link(&job, "/w/run", "/w/run2").unwrap();
        assert_eq!(modes.get(Path::new("/w/run2")), Some(0o700));
        modes.set(Path::new("/w/run2"), 0o755);
        assert_eq!(modes.get(Path::new("/w/run")), Some(0o755));
        let ino = modes::ino_of(Path::new("/w/run"));
        assert_eq!(meta(&job, "/w/run2").ino, ino);
        assert!(modes.by_ino(ino).is_some());
        job.remove_file("/w/run").unwrap();
        assert_eq!(modes.by_ino(ino), Some(PathBuf::from("/w/run2")));
        block_on(
            job.as_dyn()
                .rename(Path::new("/w/run2"), Path::new("/w/run3")),
        )
        .unwrap();
        assert_eq!(modes.by_ino(ino), Some(PathBuf::from("/w/run3")));
        assert_eq!(modes.get(Path::new("/w/run3")), Some(0o755));
        // The last name gone, a file made there has the default.
        job.remove_file("/w/run3").unwrap();
        assert_eq!(modes.by_ino(ino), None);
        job.write("/w/run", b"").unwrap();
        assert_eq!(modes.get(Path::new("/w/run")), None);
        // A snapshot file's mode goes to its new name too.
        let builder = SnapshotBuilder::new();
        builder.write("/app/bin/tool", b"x").unwrap();
        builder.set_mode("/app/bin/tool", 0o755).unwrap();
        let job = builder.freeze().fork();
        link(&job, "/app/bin/tool", "/app/bin/tool2").unwrap();
        assert_eq!(job.modes().get(Path::new("/app/bin/tool2")), Some(0o755));
        assert_eq!(
            job.modes_of(&job.entries_under(&["/app/bin/tool2"])),
            vec![(PathBuf::from("/app/bin/tool2"), 0o755)]
        );
    }

    #[test]
    fn overwriting_a_snapshot_file_with_less_content_truncates_it() {
        let builder = SnapshotBuilder::new();
        builder.write("/app/a.txt", b"0123456789\n").unwrap();
        builder.write("/app/b.txt", b"0123456789\n").unwrap();
        let job = builder.freeze().fork();
        job.write("/app/a.txt", b"ab").unwrap();
        assert_eq!(job.read("/app/a.txt").unwrap(), b"ab");
        // A second write to the now-upper file truncates too.
        job.write("/app/a.txt", b"c").unwrap();
        assert_eq!(job.read("/app/a.txt").unwrap(), b"c");
        assert_eq!(
            job.changes("/app"),
            vec![Change::Modified {
                path: "/app/a.txt".into(),
                bytes: b"c".to_vec()
            }]
        );
        // A non-truncating write still copies up and patches in place.
        let fs = job.as_dyn();
        let mut f = fs
            .new_open_options()
            .write(true)
            .open(Path::new("/app/b.txt"))
            .unwrap();
        futures::executor::block_on(f.write_all(b"XY")).unwrap();
        drop(f);
        assert_eq!(job.read("/app/b.txt").unwrap(), b"XY23456789\n");
    }

    #[test]
    fn resizing_a_snapshot_file_keeps_its_content() {
        let builder = SnapshotBuilder::new();
        builder.write("/app/a.txt", b"0123456789\n").unwrap();
        builder.write("/app/b.txt", b"01").unwrap();
        builder.write("/app/c.txt", b"abcdef").unwrap();
        let job = builder.freeze().fork();
        let fs = job.as_dyn();
        // ftruncate(2) then close(2): nothing else touches the file.
        for (path, size) in [("/app/a.txt", 4), ("/app/b.txt", 5)] {
            fs.new_open_options()
                .read(true)
                .write(true)
                .open(Path::new(path))
                .unwrap()
                .set_len(size)
                .unwrap();
        }
        // Resized, then read through the same handle.
        let mut f = fs
            .new_open_options()
            .read(true)
            .write(true)
            .open(Path::new("/app/c.txt"))
            .unwrap();
        f.set_len(2).unwrap();
        let mut back = Vec::new();
        futures::executor::block_on(f.read_to_end(&mut back)).unwrap();
        assert_eq!(back, b"ab");
        drop(f);
        assert_eq!(job.read("/app/a.txt").unwrap(), b"0123");
        assert_eq!(job.read("/app/b.txt").unwrap(), b"01\0\0\0");
        assert_eq!(
            job.changes("/app"),
            vec![
                Change::Modified {
                    path: "/app/a.txt".into(),
                    bytes: b"0123".to_vec()
                },
                Change::Modified {
                    path: "/app/b.txt".into(),
                    bytes: b"01\0\0\0".to_vec()
                },
                Change::Modified {
                    path: "/app/c.txt".into(),
                    bytes: b"ab".to_vec()
                },
            ]
        );
    }

    #[test]
    fn a_tree_read_through_a_layer_is_one_input_that_any_change_breaks() {
        let checkout = SnapshotBuilder::new();
        checkout.write("/app/lib/package.json", b"{}").unwrap();
        checkout.write("/app/lib/src/a.ts", b"a").unwrap();
        checkout
            .write("/app/lib/node_modules/dep/index.js", b"x")
            .unwrap();
        checkout.write("/app/lib/.git/HEAD", b"x").unwrap();
        let layer = checkout.layer();
        let files = layer.read_tree("/app/lib").unwrap();
        assert_eq!(
            files,
            vec![
                (PathBuf::from("package.json"), b"{}".to_vec()),
                (PathBuf::from("src/a.ts"), b"a".to_vec()),
            ]
        );
        let reads = layer.reads();
        assert!(matches!(&reads[..], [Input::Tree { path, .. }] if path == Path::new("/app/lib")));
        assert!(reads[0].holds(checkout.fs()));
        // What it leaves out does not count.
        checkout
            .write("/app/lib/node_modules/dep/other.js", b"y")
            .unwrap();
        assert!(reads[0].holds(checkout.fs()));
        // A new file or a changed one does.
        checkout.write("/app/lib/src/b.ts", b"b").unwrap();
        assert!(!reads[0].holds(checkout.fs()));
        let fresh = checkout.layer();
        fresh.read_tree("/app/lib").unwrap();
        let reads = fresh.reads();
        assert!(reads[0].holds(checkout.fs()));
        checkout.write("/app/lib/src/a.ts", b"changed").unwrap();
        assert!(!reads[0].holds(checkout.fs()));
        assert!(checkout.layer().read_tree("/app/missing").is_err());
    }

    #[test]
    fn a_layer_reads_through_records_what_it_read_and_keeps_its_own_writes() {
        let checkout = SnapshotBuilder::new();
        checkout.write("/app/pnpm-lock.yaml", b"lock").unwrap();
        checkout
            .write("/app/.cargo/config.toml", b"[build]\n")
            .unwrap();
        let layer = checkout.layer();
        assert_eq!(layer.read("/app/pnpm-lock.yaml").unwrap(), b"lock");
        assert!(!layer.is_file("/app/.npmrc"));
        assert!(layer.is_dir("/app/.cargo"));
        layer.write("/app/node_modules/x/index.js", b"x").unwrap();
        layer.symlink("/app/node_modules/y", "x").unwrap();
        // The installer rewrites an input; the layer's copy wins from now on.
        let config = layer.read("/app/.cargo/config.toml").unwrap();
        layer
            .write(
                "/app/.cargo/config.toml",
                &[config, b"[source]\n".to_vec()].concat(),
            )
            .unwrap();
        assert_eq!(
            layer.read("/app/.cargo/config.toml").unwrap(),
            b"[build]\n[source]\n"
        );
        // The checkout is untouched.
        assert!(!checkout.is_file("/app/node_modules/x/index.js"));

        use sha2::Digest;
        let reads = layer.reads();
        assert_eq!(
            reads,
            vec![
                Input::Dir {
                    path: "/app/.cargo".into()
                },
                Input::File {
                    path: "/app/.cargo/config.toml".into(),
                    sha256: sha2::Sha256::digest(b"[build]\n").into()
                },
                Input::Absent {
                    path: "/app/.npmrc".into()
                },
                Input::File {
                    path: "/app/pnpm-lock.yaml".into(),
                    sha256: sha2::Sha256::digest(b"lock").into()
                },
            ]
        );
        assert!(reads.iter().all(|r| r.holds(checkout.fs())));
        checkout.write("/app/.npmrc", b"registry=x").unwrap();
        assert!(
            !reads.iter().all(|r| r.holds(checkout.fs())),
            "a new file invalidates"
        );

        // Replaying the layer into another checkout reproduces it, symlinks
        // included, and replaces the input the installer rewrote.
        let other = SnapshotBuilder::new();
        other
            .write("/app/.cargo/config.toml", b"[build]\n")
            .unwrap();
        other.apply(&layer.entries()).unwrap();
        let snap = other.freeze();
        assert_eq!(snap.read("/app/node_modules/y/index.js").unwrap(), b"x");
        assert_eq!(
            snap.read("/app/.cargo/config.toml").unwrap(),
            b"[build]\n[source]\n"
        );
        let job = snap.fork();
        job.write("/app/node_modules/x/index.js", b"changed")
            .unwrap();
        assert_eq!(
            job.read("/app/node_modules/y/index.js").unwrap(),
            b"changed"
        );
    }

    #[test]
    fn walking_does_not_follow_symlinks_that_loop() {
        let builder = SnapshotBuilder::new();
        builder
            .write("/app/node_modules/.pnpm/a/node_modules/a/index.js", b"a")
            .unwrap();
        // pnpm links a package's own dependencies back into the store.
        builder
            .symlink("/app/node_modules/.pnpm/a/node_modules/self", "..")
            .unwrap();
        let files = list_files(builder.fs(), "/app");
        assert_eq!(
            files,
            vec![PathBuf::from(
                "/app/node_modules/.pnpm/a/node_modules/a/index.js"
            )]
        );
        assert_eq!(
            builder
                .entries()
                .iter()
                .filter(|e| matches!(e, Entry::Symlink { .. }))
                .count(),
            1
        );
    }

    #[derive(Debug, Default)]
    struct Cap {
        used: std::sync::atomic::AtomicU64,
        max: u64,
    }

    impl WriteBudget for Cap {
        fn take(&self, n: u64) -> bool {
            use std::sync::atomic::Ordering;
            let now = self.used.fetch_add(n, Ordering::SeqCst) + n;
            if now > self.max {
                self.used.fetch_sub(n, Ordering::SeqCst);
                return false;
            }
            true
        }
        fn give(&self, n: u64) {
            self.used.fetch_sub(n, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// A job forked over `size`-byte snapshot files `/s/0`, `/s/1`, ...,
    /// with a budget of `max` bytes.
    fn budgeted(files: usize, size: usize, max: u64) -> (JobFs, Arc<Cap>) {
        let builder = SnapshotBuilder::new();
        for i in 0..files {
            builder.write(format!("/s/{i}"), &vec![7u8; size]).unwrap();
        }
        let cap = Arc::new(Cap {
            max,
            ..Default::default()
        });
        (builder.freeze().fork_limited(cap.clone()), cap)
    }

    fn used(cap: &Cap) -> u64 {
        cap.used.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// What a new file named `name` is charged for its entry.
    fn e(name: &str) -> u64 {
        ENTRY_COST + name.len() as u64
    }

    fn open_rw(job: &JobFs, path: &str) -> Box<dyn virtual_fs::VirtualFile + Send + Sync> {
        job.as_dyn()
            .new_open_options()
            .read(true)
            .write(true)
            .open(Path::new(path))
            .unwrap()
    }

    /// Changes one byte of a snapshot file in place: copies it up, free.
    fn touch(job: &JobFs, path: &str) {
        let mut f = open_rw(job, path);
        block_on(f.write_all(b"x")).unwrap();
    }

    #[test]
    fn removing_a_copied_up_snapshot_file_gives_back_nothing() {
        let (job, cap) = budgeted(2, 1 << 20, (1 << 20) + e("own0"));
        // The job holds its whole budget, then deletes snapshot files it
        // changed: none of that frees room for more of its own bytes.
        job.write("/own0", &vec![1u8; 1 << 20]).unwrap();
        for big in ["/s/0", "/s/1"] {
            touch(&job, big);
            job.remove_file(big).unwrap();
            assert_eq!(used(&cap), (1 << 20) + e("own0"), "after deleting {big}");
        }
        assert!(job.write("/own1", &[1u8; 4096]).is_err(), "still full");
        // Deleting its own file does give room back.
        job.remove_file("/own0").unwrap();
        assert_eq!(used(&cap), 0);
        job.write("/own1", &[1u8; 4096]).unwrap();
    }

    #[test]
    fn renaming_over_a_file_gives_back_only_what_the_job_added_to_it() {
        let (job, cap) = budgeted(1, 1000, 1 << 20);
        job.write("/own", &[1u8; 100]).unwrap();
        assert_eq!(used(&cap), 100 + e("own"));
        // The job's file over a copied-up snapshot file: the copy goes, and
        // nothing was charged for it.
        touch(&job, "/s/0");
        block_on(job.as_dyn().rename(Path::new("/own"), Path::new("/s/0"))).unwrap();
        assert_eq!(used(&cap), 100 + e("own"));
        // A copied-up snapshot file over the job's file: the job's bytes
        // come back, the moved copy still costs nothing.
        let (job, cap) = budgeted(1, 1000, 1 << 20);
        job.write("/own", &[1u8; 100]).unwrap();
        touch(&job, "/s/0");
        block_on(job.as_dyn().rename(Path::new("/s/0"), Path::new("/own"))).unwrap();
        assert_eq!(used(&cap), 0);
        job.remove_file("/own").unwrap();
        assert_eq!(used(&cap), 0);
        // A snapshot file renamed (copied up by the move) and then deleted.
        let (job, cap) = budgeted(1, 1000, 1 << 20);
        job.write("/own", &[1u8; 100]).unwrap();
        block_on(job.as_dyn().rename(Path::new("/s/0"), Path::new("/moved"))).unwrap();
        job.remove_file("/moved").unwrap();
        assert_eq!(used(&cap), 100 + e("own"));
    }

    #[test]
    fn truncating_a_snapshot_file_gives_back_nothing() {
        let (job, cap) = budgeted(3, 1000, 1 << 20);
        job.write("/own", &[1u8; 100]).unwrap();
        // A truncating open of a copied-up snapshot file.
        touch(&job, "/s/0");
        drop(
            job.as_dyn()
                .new_open_options()
                .write(true)
                .truncate(true)
                .open(Path::new("/s/0"))
                .unwrap(),
        );
        assert_eq!(job.read("/s/0").unwrap(), b"");
        assert_eq!(used(&cap), 100 + e("own"));
        // ftruncate(2) of a snapshot file, copied up or not.
        open_rw(&job, "/s/1").set_len(10).unwrap();
        touch(&job, "/s/2");
        open_rw(&job, "/s/2").set_len(0).unwrap();
        assert_eq!(used(&cap), 100 + e("own"));
        // What the job then writes there is its own, and given back.
        let mut f = open_rw(&job, "/s/1");
        f.set_len(500).unwrap();
        assert_eq!(used(&cap), 590 + e("own"));
        f.set_len(0).unwrap();
        assert_eq!(used(&cap), 100 + e("own"));
    }

    #[test]
    fn a_file_holding_given_and_added_bytes_gives_back_only_the_added_ones() {
        let (job, cap) = budgeted(1, 100, 1 << 20);
        // 100 bytes from the snapshot, 50 the job appends.
        let mut f = job
            .as_dyn()
            .new_open_options()
            .append(true)
            .open(Path::new("/s/0"))
            .unwrap();
        block_on(f.write_all(&[2u8; 50])).unwrap();
        drop(f);
        assert_eq!(job.read("/s/0").unwrap().len(), 150);
        assert_eq!(used(&cap), 50);
        // Shrinking takes the job's bytes off the end first...
        let mut f = open_rw(&job, "/s/0");
        f.set_len(120).unwrap();
        assert_eq!(used(&cap), 20);
        // ...then the snapshot's, which give nothing back.
        f.set_len(60).unwrap();
        assert_eq!(used(&cap), 0);
        // Growing it again is charged, and deleting gives that back.
        f.set_len(80).unwrap();
        assert_eq!(used(&cap), 20);
        drop(f);
        job.remove_file("/s/0").unwrap();
        assert_eq!(used(&cap), 0);
        // An open handle on a deleted file gives back nothing more.
        let (job, cap) = budgeted(0, 0, 1 << 20);
        job.write("/own", &[1u8; 100]).unwrap();
        job.write("/keep", &[1u8; 100]).unwrap();
        let mut f = open_rw(&job, "/own");
        job.remove_file("/own").unwrap();
        assert_eq!(used(&cap), 100 + e("keep"));
        f.set_len(0).unwrap();
        assert_eq!(used(&cap), 100 + e("keep"), "`/keep` is still counted");
    }

    #[test]
    fn a_limited_fork_refuses_writes_past_its_budget_before_they_land() {
        use std::sync::atomic::Ordering;
        let cap = Arc::new(Cap {
            max: 64 << 10,
            ..Default::default()
        });
        let job = snapshot().fork_limited(cap.clone());
        job.write("/app/small.txt", &[1u8; 1024]).unwrap();
        let small = e("small.txt");
        assert_eq!(cap.used.load(Ordering::SeqCst), 1024 + small);

        // Refused before it reaches the file: nothing of it is written
        // (the empty file is made, and its entry charged).
        assert!(job.write("/app/big.bin", &vec![0u8; 1 << 20]).is_err());
        assert_eq!(job.read("/app/big.bin").map(|b| b.len()).unwrap_or(0), 0);
        let big = e("big.bin");
        assert_eq!(cap.used.load(Ordering::SeqCst), 1024 + small + big);

        // Overwriting gives the old bytes back first; deleting gives them back.
        job.write("/app/small.txt", &[2u8; 512]).unwrap();
        assert_eq!(cap.used.load(Ordering::SeqCst), 512 + small + big);
        job.remove_file("/app/small.txt").unwrap();
        assert_eq!(cap.used.load(Ordering::SeqCst), big);

        // Many small files add up.
        let refused = (0..100).any(|i| job.write(format!("/app/many/{i}"), &[0u8; 1024]).is_err());
        assert!(refused);
        assert!(cap.used.load(Ordering::SeqCst) <= 64 << 10);

        // Changing a snapshot file in place is not charged for its old bytes.
        let before = cap.used.load(Ordering::SeqCst);
        let fs = job.as_dyn();
        let mut f = fs
            .new_open_options()
            .write(true)
            .open(Path::new("/app/src/a.ts"))
            .unwrap();
        futures::executor::block_on(f.write_all(b"E")).unwrap();
        drop(f);
        assert_eq!(cap.used.load(Ordering::SeqCst), before);
    }

    /// Several threads writing a temporary file each and renaming it onto
    /// one name, the atomic-replace idiom (#1092): the in-memory layer's
    /// rename looked the old file up under a read lock and removed it under
    /// the write lock after, so the second of two renames removed an inode
    /// the first had already removed and panicked. Every rename succeeds,
    /// the name always holds one whole file, the last rename's content wins
    /// and no temporary is left, and the budget ends charged for one file.
    #[test]
    fn concurrent_renames_onto_one_name_all_succeed_and_leave_one_file() {
        use std::sync::atomic::Ordering;
        const THREADS: usize = 8;
        const RENAMES: usize = 1500;
        let cap = Arc::new(Cap {
            max: 1 << 30,
            ..Default::default()
        });
        let job = snapshot().fork_limited(cap.clone());
        job.write("/tmp/rr/target", b"first").unwrap();
        let last: Vec<String> = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..THREADS)
                .map(|t| {
                    let job = &job;
                    scope.spawn(move || {
                        let mut last = String::new();
                        for i in 0..RENAMES {
                            let tmp = format!("/tmp/rr/target.{t}.{i}.tmp");
                            let body = format!("{t}.{i}");
                            job.write(&tmp, body.as_bytes()).unwrap();
                            rename(job, &tmp, "/tmp/rr/target").unwrap();
                            // A reader never finds the name missing.
                            let read = job.read("/tmp/rr/target").unwrap();
                            assert!(!read.is_empty());
                            last = body;
                        }
                        last
                    })
                })
                .collect();
            workers.into_iter().map(|w| w.join().unwrap()).collect()
        });
        assert_eq!(names(&job, "/tmp/rr"), ["target"]);
        let content = String::from_utf8(job.read("/tmp/rr/target").unwrap()).unwrap();
        assert!(
            last.contains(&content),
            "{content} is no thread's last write"
        );
        // The content and the entry of the temporary that ended up there
        // (`target.{t}.{i}.tmp`, its content `{t}.{i}`).
        assert_eq!(
            cap.used.load(Ordering::SeqCst),
            content.len() as u64 + e(&format!("target.{content}.tmp"))
        );
    }

    /// Unlinking a file through a handle open on it, as WASIX unlinks a
    /// file it has open (#1294), while other names in its directory come
    /// and go. The in-memory layer found the file's place among its
    /// directory's entries under a read lock and removed the entry at that
    /// place under the write lock taken after, so a name that went from
    /// before it in between shifted it, and the unlink removed its
    /// neighbour (a file that was then lost, or one that stayed listed with
    /// nothing behind it) or panicked past the end. Each unlink removes its
    /// own file and nothing else.
    #[test]
    fn unlinking_an_open_file_while_its_directory_changes_removes_only_that_file() {
        const ROUNDS: usize = 20_000;
        let fs = mem_fs::FileSystem::default();
        fs.create_dir(Path::new("/d")).unwrap();
        let kept: Vec<String> = (0..8).map(|i| format!("keep{i}")).collect();
        for name in &kept {
            write_file(&fs, format!("/d/{name}"), name.as_bytes()).unwrap();
        }
        std::thread::scope(|scope| {
            for t in 0..2 {
                let fs = &fs;
                scope.spawn(move || {
                    let path = format!("/d/open{t}");
                    for _ in 0..ROUNDS {
                        let mut file = fs
                            .new_open_options()
                            .write(true)
                            .create_new(true)
                            .open(Path::new(&path))
                            .unwrap();
                        file.unlink().unwrap();
                    }
                });
            }
            for t in 0..2 {
                let fs = &fs;
                scope.spawn(move || {
                    let dir = format!("/d/dir{t}");
                    let file = format!("/d/file{t}");
                    for _ in 0..ROUNDS {
                        fs.create_dir(Path::new(&dir)).unwrap();
                        write_file(fs, &file, b"x").unwrap();
                        fs.remove_dir(Path::new(&dir)).unwrap();
                        fs.remove_file(Path::new(&file)).unwrap();
                    }
                });
            }
        });
        let mut listed: Vec<String> = fs
            .read_dir(Path::new("/d"))
            .unwrap()
            .flatten()
            .map(|e| e.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        listed.sort();
        assert_eq!(listed, kept);
        for name in &kept {
            let path = format!("/d/{name}");
            assert_eq!(read_file(&fs, &path).unwrap(), name.as_bytes());
            fs.remove_file(Path::new(&path)).unwrap();
        }
        fs.remove_dir(Path::new("/d")).unwrap();
    }

    #[test]
    fn a_jobs_paths_capture_encode_and_restore_into_another_job() {
        let builder = SnapshotBuilder::new();
        builder.write("/app/src/a.ts", b"a").unwrap();
        let snap = builder.freeze();
        let job = snap.fork();
        job.write("/app/.cache/tsc/web.tsbuildinfo", b"{\"v\":1}")
            .unwrap();
        job.write("/app/.cache/tsc/deep/x", b"x").unwrap();
        symlink(job.as_dyn().as_ref(), "/app/.cache/link", "tsc").unwrap();
        job.write("/root/.cache/go-build/ab/cd", b"go").unwrap();
        let entries = job.entries_under(&["/app/.cache", "/root/.cache/go-build", "/app/missing"]);
        assert!(entries.iter().any(|e| matches!(e, Entry::Symlink { .. })));

        let mut buf = Vec::new();
        archive::encode(&mut buf, &entries).unwrap();
        let decoded = archive::decode(&mut buf.as_slice(), 1 << 20).unwrap();
        assert_eq!(decoded, entries);
        assert!(
            archive::decode(&mut buf.as_slice(), 2).is_err(),
            "the size bound holds"
        );

        let next = snap.fork();
        next.apply(&decoded).unwrap();
        assert_eq!(
            next.read("/app/.cache/tsc/web.tsbuildinfo").unwrap(),
            b"{\"v\":1}"
        );
        assert_eq!(next.read("/app/.cache/link/deep/x").unwrap(), b"x");
        assert_eq!(next.read("/root/.cache/go-build/ab/cd").unwrap(), b"go");
    }

    /// A restored cache kept no modes: a `755` program came back `644`, and
    /// a native program installed from it (Bun's install cache) would not
    /// start. Modes travel with the entries; a stream of the old format is
    /// refused as another format, which a cache reads as a miss.
    #[test]
    fn modes_travel_with_the_entries_and_the_old_format_is_another() {
        let snap = SnapshotBuilder::new().freeze();
        let job = snap.fork();
        job.write("/root/.bun/install/cache/turbo/bin/turbo", b"ELF")
            .unwrap();
        job.write("/root/.bun/install/cache/turbo/package.json", b"{}")
            .unwrap();
        let modes = job.modes();
        modes.set(Path::new("/root/.bun/install/cache/turbo/bin/turbo"), 0o755);
        modes.set(Path::new("/root/.bun/install/cache/turbo/bin"), 0o750);
        let entries = job.entries_under(&["/root/.bun/install/cache"]);
        let kept = job.modes_of(&entries);
        assert_eq!(kept.len(), 2, "{kept:?}");

        let mut buf = Vec::new();
        archive::encode_with_modes(&mut buf, &entries, &kept).unwrap();
        let (decoded, restored) = archive::decode_with_modes(&mut buf.as_slice(), 1 << 20).unwrap();
        assert_eq!(decoded, entries);
        assert_eq!(restored, kept);

        let next = snap.fork();
        next.apply(&decoded).unwrap();
        next.apply_modes(&restored);
        assert_eq!(
            next.modes()
                .get(Path::new("/root/.bun/install/cache/turbo/bin/turbo")),
            Some(0o755)
        );
        assert_eq!(
            next.modes()
                .get(Path::new("/root/.bun/install/cache/turbo/bin")),
            Some(0o750)
        );
        assert_eq!(
            next.modes()
                .get(Path::new("/root/.bun/install/cache/turbo/package.json")),
            None
        );

        // A mode for a path the stream does not hold is damage.
        let mut stray = Vec::new();
        archive::encode_with_modes(&mut stray, &entries, &[("/etc/passwd".into(), 0o777)]).unwrap();
        let err = archive::decode_with_modes(&mut stray.as_slice(), 1 << 20).unwrap_err();
        assert!(!archive::is_other_format(&err), "{err}");

        // Format 1, as every runner before this one wrote it.
        let mut old = Vec::new();
        old.extend_from_slice(b"IWCIENTS");
        old.extend_from_slice(&1u32.to_le_bytes());
        old.extend_from_slice(&0u64.to_le_bytes());
        let err = archive::decode(&mut old.as_slice(), 1 << 20).unwrap_err();
        assert!(archive::is_other_format(&err), "{err}");
    }

    #[test]
    fn a_stored_entry_cannot_climb_out() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"IWCIENTS");
        buf.extend_from_slice(&2u32.to_le_bytes());
        buf.extend_from_slice(&1u64.to_le_bytes());
        buf.push(0);
        let evil = "/app/../etc";
        buf.extend_from_slice(&(evil.len() as u32).to_le_bytes());
        buf.extend_from_slice(evil.as_bytes());
        assert!(archive::decode(&mut buf.as_slice(), 1 << 20).is_err());
    }

    #[test]
    fn modes_come_from_the_snapshot_and_follow_a_jobs_renames_and_removals() {
        let builder = SnapshotBuilder::new();
        builder.write("/app/run.sh", b"#!/bin/sh\n").unwrap();
        builder.write("/app/data.txt", b"x").unwrap();
        builder.set_mode("/app/run.sh", 0o755).unwrap();
        let snap = builder.freeze();
        assert_eq!(snap.mode("/app/run.sh"), Some(0o755));
        assert_eq!(snap.mode("/app/data.txt"), None);

        let job = snap.fork();
        let fs = job.as_dyn();
        let modes = job.modes();
        let mode = |path: &str, follow: bool| {
            modes::mode_of(fs.as_ref(), &modes, Path::new(path), follow).map(|(_, m)| m)
        };
        assert_eq!(mode("/app/run.sh", true), Some(0o755));
        assert_eq!(mode("/app/data.txt", true), Some(0o644));
        assert_eq!(mode("/app", true), Some(0o755));
        assert_eq!(mode("/app/missing", true), None);

        // `chmod 600` then `mv`: the mode goes with the file, and a file
        // created at the old path starts from the default.
        modes.set(Path::new("/app/data.txt"), 0o600);
        block_on(fs.rename(Path::new("/app/data.txt"), Path::new("/app/secret.txt"))).unwrap();
        assert_eq!(mode("/app/secret.txt", true), Some(0o600));
        job.write("/app/data.txt", b"y").unwrap();
        assert_eq!(mode("/app/data.txt", true), Some(0o644));

        // Writing a file keeps its mode; removing it does not.
        job.write("/app/secret.txt", b"rewritten").unwrap();
        assert_eq!(mode("/app/secret.txt", true), Some(0o600));
        job.remove_file("/app/run.sh").unwrap();
        job.write("/app/run.sh", b"echo").unwrap();
        assert_eq!(mode("/app/run.sh", true), Some(0o644));

        // A symlink reads as its target's, or as itself without following.
        symlink(fs.as_ref(), "/app/link", "secret.txt").unwrap();
        assert_eq!(mode("/app/link", true), Some(0o600));
        assert_eq!(mode("/app/link", false), Some(0o777));

        // None of it reaches another job.
        let other = snap.fork();
        let other_mode = modes::mode_of(
            other.as_dyn().as_ref(),
            &other.modes(),
            Path::new("/app/run.sh"),
            true,
        );
        assert_eq!(other_mode.map(|(_, m)| m), Some(0o755));
    }

    fn rename(job: &JobFs, from: &str, to: &str) -> virtual_fs::Result<()> {
        block_on(job.as_dyn().rename(Path::new(from), Path::new(to)))
    }

    fn names(job: &JobFs, dir: &str) -> Vec<String> {
        let mut names: Vec<String> = job
            .as_dyn()
            .read_dir(Path::new(dir))
            .unwrap()
            .flatten()
            .map(|e| e.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// A fresh job renaming checked-out files (#985): the overlay's own
    /// rename copied a snapshot file up into a parent the upper layer did
    /// not have yet, and failed with `EntryNotFound`.
    #[test]
    fn a_fresh_job_renames_snapshot_files() {
        let builder = SnapshotBuilder::new();
        builder.write("/app/README.md", b"readme\n").unwrap();
        builder.write("/app/run.sh", b"#!/bin/sh\n").unwrap();
        builder.write("/app/src/a.ts", b"a\n").unwrap();
        builder.write("/app/src/b.ts", b"b\n").unwrap();
        builder.write("/app/docs/old.md", b"old\n").unwrap();
        builder.set_mode("/app/run.sh", 0o755).unwrap();
        let job = builder.freeze().fork();

        // Within its directory, into another snapshot directory, over
        // another snapshot file, and keeping its mode.
        rename(&job, "/app/README.md", "/app/moved.md").unwrap();
        rename(&job, "/app/src/a.ts", "/app/docs/a.ts").unwrap();
        rename(&job, "/app/src/b.ts", "/app/docs/old.md").unwrap();
        rename(&job, "/app/run.sh", "/app/docs/run.sh").unwrap();
        for _ in 0..2 {
            assert_eq!(job.read("/app/moved.md").unwrap(), b"readme\n");
        }
        assert!(job.read("/app/README.md").is_err());
        assert_eq!(job.read("/app/docs/a.ts").unwrap(), b"a\n");
        assert_eq!(job.read("/app/docs/old.md").unwrap(), b"b\n");
        assert_eq!(names(&job, "/app/src"), Vec::<String>::new());
        assert_eq!(names(&job, "/app/docs"), ["a.ts", "old.md", "run.sh"]);
        assert_eq!(job.modes().get(Path::new("/app/docs/run.sh")), Some(0o755));
        assert_eq!(job.modes().get(Path::new("/app/run.sh")), None);

        // The moved file is the job's now: it can be written and removed.
        job.write("/app/moved.md", b"edited\n").unwrap();
        assert_eq!(job.read("/app/moved.md").unwrap(), b"edited\n");
        job.remove_file("/app/docs/a.ts").unwrap();

        // A missing source is still ENOENT, a missing target directory too.
        assert_eq!(
            rename(&job, "/app/README.md", "/app/x"),
            Err(FsError::EntryNotFound)
        );
        assert!(rename(&job, "/app/moved.md", "/app/nowhere/x").is_err());

        assert_eq!(
            job.changes("/app"),
            vec![
                Change::Deleted {
                    path: "/app/README.md".into()
                },
                Change::Modified {
                    path: "/app/docs/old.md".into(),
                    bytes: b"b\n".to_vec()
                },
                Change::Added {
                    path: "/app/docs/run.sh".into(),
                    bytes: b"#!/bin/sh\n".to_vec()
                },
                Change::Added {
                    path: "/app/moved.md".into(),
                    bytes: b"edited\n".to_vec()
                },
                Change::Deleted {
                    path: "/app/run.sh".into()
                },
                Change::Deleted {
                    path: "/app/src/a.ts".into()
                },
                Change::Deleted {
                    path: "/app/src/b.ts".into()
                },
            ]
        );
    }

    #[test]
    fn a_job_renames_its_own_files_into_snapshot_directories() {
        let job = snapshot().fork();
        job.write("/app/new.txt", b"new").unwrap();
        rename(&job, "/app/new.txt", "/app/node_modules/new.txt").unwrap();
        assert_eq!(job.read("/app/node_modules/new.txt").unwrap(), b"new");
        assert!(job.read("/app/new.txt").is_err());
        // A copied-up file moves as itself, not as the snapshot's copy.
        job.write("/app/src/a.ts", b"changed").unwrap();
        rename(&job, "/app/src/a.ts", "/app/old/a.ts").unwrap();
        assert_eq!(job.read("/app/old/a.ts").unwrap(), b"changed");
        assert!(job.read("/app/src/a.ts").is_err());
    }

    #[test]
    fn a_job_renames_snapshot_directories_and_symlinks() {
        let builder = SnapshotBuilder::new();
        builder.write("/app/dist/index.js", b"i").unwrap();
        builder.write("/app/dist/lib/x.js", b"x").unwrap();
        builder.write("/app/dist/bin/cli", b"c").unwrap();
        builder.symlink("/app/dist/link", "index.js").unwrap();
        builder.write("/app/empty/.keep", b"").unwrap();
        builder.set_mode("/app/dist/bin/cli", 0o755).unwrap();
        let job = builder.freeze().fork();
        // The job's own work inside, which moves too.
        job.write("/app/dist/lib/y.js", b"y").unwrap();
        job.remove_file("/app/dist/index.js").unwrap();
        job.write("/app/dist/index.js", b"rebuilt").unwrap();

        rename(&job, "/app/dist", "/app/out").unwrap();
        assert!(job.as_dyn().metadata(Path::new("/app/dist")).is_err());
        assert_eq!(names(&job, "/app/out"), ["bin", "index.js", "lib", "link"]);
        assert_eq!(names(&job, "/app/out/lib"), ["x.js", "y.js"]);
        assert_eq!(job.read("/app/out/index.js").unwrap(), b"rebuilt");
        assert_eq!(job.read("/app/out/link").unwrap(), b"rebuilt");
        assert_eq!(
            job.as_dyn().readlink(Path::new("/app/out/link")).unwrap(),
            Path::new("index.js")
        );
        assert_eq!(job.modes().get(Path::new("/app/out/bin/cli")), Some(0o755));

        // A directory goes over an empty one, never into a full one or
        // under itself.
        assert_eq!(
            rename(&job, "/app/out", "/app/empty"),
            Err(FsError::DirectoryNotEmpty)
        );
        assert_eq!(
            rename(&job, "/app/out", "/app/out/lib/deeper"),
            Err(FsError::InvalidInput)
        );
        job.remove_file("/app/empty/.keep").unwrap();
        rename(&job, "/app/out", "/app/empty").unwrap();
        assert_eq!(job.read("/app/empty/lib/x.js").unwrap(), b"x");

        // Moving it back where it was deleted from does not bring back the
        // snapshot entries the job removed.
        rename(&job, "/app/empty", "/app/dist").unwrap();
        assert_eq!(names(&job, "/app/dist"), ["bin", "index.js", "lib", "link"]);
        assert_eq!(job.read("/app/dist/index.js").unwrap(), b"rebuilt");
        assert!(job.as_dyn().metadata(Path::new("/app/empty")).is_err());

        // A symlink the job made moves too.
        symlink(job.as_dyn().as_ref(), "/app/mine", "dist/lib").unwrap();
        rename(&job, "/app/mine", "/app/yours").unwrap();
        assert_eq!(job.read("/app/yours/y.js").unwrap(), b"y");
        assert!(
            job.as_dyn()
                .symlink_metadata(Path::new("/app/mine"))
                .is_err()
        );
    }

    #[test]
    fn a_tracked_mount_keeps_modes_by_guest_path() {
        let modes = Modes::default();
        let tmp: DynFs = Arc::new(TmpFileSystem::new());
        let mount = TrackModes::new(tmp, modes.clone(), "/tmp/workflow");
        write_file(&mount, "/a", b"a").unwrap();
        modes.set(Path::new("/tmp/workflow/a"), 0o600);
        block_on(mount.rename(Path::new("/a"), Path::new("/b"))).unwrap();
        assert_eq!(modes.get(Path::new("/tmp/workflow/a")), None);
        assert_eq!(modes.get(Path::new("/tmp/workflow/b")), Some(0o600));
        mount.remove_file(Path::new("/b")).unwrap();
        assert_eq!(modes.get(Path::new("/tmp/workflow/b")), None);
    }

    #[test]
    fn the_frozen_layer_refuses_writes() {
        let snap = snapshot();
        assert!(write_file(snap.fs.as_ref(), "/app/x", b"x").is_err());
    }
}
