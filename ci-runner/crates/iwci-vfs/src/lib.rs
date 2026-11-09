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

pub mod archive;
mod limit;
pub use limit::WriteBudget;

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
}

impl Input {
    pub fn path(&self) -> &Path {
        match self {
            Input::File { path, .. } | Input::Dir { path } | Input::Absent { path } => path,
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
        Input::observe(fs, self.path()) == *self
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
        }
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
        for entry in entries {
            match entry {
                Entry::Dir { path } => create_dir_all(&self.fs, path)?,
                Entry::File { path, data } => {
                    let path = normalise(path)?;
                    if let Some(parent) = path.parent() {
                        create_dir_all(&self.fs, parent)?;
                    }
                    let _ = self.fs.remove_file(&path);
                    self.fs
                        .new_open_options_ext()
                        .insert_ro_file(&path, data.clone())
                        .map_err(fs_err(&path))?;
                }
                Entry::Symlink { path, target } => {
                    let path = normalise(path)?;
                    let _ = self.fs.remove_file(&path);
                    symlink(&self.fs, &path, target)?;
                }
            }
        }
        Ok(())
    }

    /// Ends the writes. Only the read side survives, so a job that holds the
    /// snapshot cannot change what the next job sees.
    pub fn freeze(self) -> Snapshot {
        Snapshot {
            fs: Arc::new(ReadOnlyFs(self.fs)),
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
}

impl Snapshot {
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

    /// A writable view for one job: a fresh in-memory layer over this
    /// snapshot. Constant time; nothing is copied until the job writes.
    pub fn fork(&self) -> JobFs {
        self.fork_with(None)
    }

    /// [`Snapshot::fork`], with the bytes the job adds held to `budget`: a
    /// write past it is refused as a full disk would refuse it. The job's
    /// files live in memory, so this is what keeps a job that writes
    /// gigabytes inside its memory limit. See `limit.rs`.
    pub fn fork_limited(&self, budget: Arc<dyn WriteBudget>) -> JobFs {
        self.fork_with(Some(budget))
    }

    fn fork_with(&self, budget: Option<Arc<dyn WriteBudget>>) -> JobFs {
        let upper = TmpFileSystem::new();
        let overlay = JobOverlay {
            inner: OverlayFileSystem::new(upper.clone(), [self.fs.clone()]),
            upper: upper.clone(),
            base: self.fs.clone(),
            budget,
        };
        JobFs {
            overlay: Arc::new(overlay),
            upper,
            base: self.clone(),
        }
    }
}

/// One job's file system. See [`Snapshot::fork`].
#[derive(Debug, Clone)]
pub struct JobFs {
    overlay: Arc<JobOverlay>,
    upper: TmpFileSystem,
    base: Snapshot,
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

    pub fn read(&self, path: impl AsRef<Path>) -> Result<Vec<u8>> {
        read_file(self.overlay.as_ref(), path)
    }

    pub fn write(&self, path: impl AsRef<Path>, bytes: &[u8]) -> Result<()> {
        write_file(self.overlay.as_ref(), path, bytes)
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
#[derive(Debug)]
pub struct JobOverlay {
    inner: OverlayFileSystem<TmpFileSystem, [Arc<ReadOnlyFs>; 1]>,
    upper: TmpFileSystem,
    base: Arc<ReadOnlyFs>,
    budget: Option<Arc<dyn WriteBudget>>,
}

impl JobOverlay {
    /// The size of `path` in the upper layer, when it is a file there: the
    /// bytes the job has been charged for it.
    fn upper_size(&self, path: &Path) -> Option<u64> {
        let meta = self.upper.symlink_metadata(path).ok()?;
        meta.is_file().then_some(meta.len)
    }

    fn give(&self, bytes: Option<u64>) {
        if let (Some(budget), Some(bytes)) = (&self.budget, bytes) {
            budget.give(bytes);
        }
    }

    fn limited(
        &self,
        file: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
        conf: &virtual_fs::OpenOptionsConfig,
    ) -> Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static> {
        match &self.budget {
            Some(budget) if conf.write || conf.append => {
                Box::new(limit::LimitedFile::new(file, budget.clone(), conf.append))
            }
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
                    let size = self.upper_size(&entry.path);
                    self.upper.remove_file(&entry.path)?;
                    self.give(size);
                }
            }
        }
        self.upper.remove_dir(path)
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
    fn hard_link(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.inner.hard_link(source, target)
    }
    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        if !self.inner.symlink_metadata(path)?.is_dir() {
            return Err(FsError::BaseNotDirectory);
        }
        // The merged listing already hides whited-out entries.
        if self.inner.read_dir(path)?.next().is_some() {
            return Err(FsError::DirectoryNotEmpty);
        }
        let in_upper = self.upper.metadata(path).is_ok_and(|m| m.is_dir());
        if in_upper {
            self.purge_upper(path)?;
        }
        if self.base.metadata(path).is_ok_and(|m| m.is_dir()) {
            self.white_out(path)?;
        }
        Ok(())
    }
    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        self.inner.rename(from, to)
    }
    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.inner.metadata(path)
    }
    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.inner.symlink_metadata(path)
    }
    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        let size = self.upper_size(path);
        self.inner.remove_file(path)?;
        self.give(size);
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
        // The overlay's copy-on-write opens the lower file without
        // `truncate` and copies it up on the first write, so writing fewer
        // bytes than the file held leaves the old tail in place: `ab` over
        // `0123456789` reads back `ab23456789`. A truncating open needs none
        // of the old content, so it gets a fresh upper file instead.
        let truncating = conf.truncate && (conf.write || conf.append);
        let lower_only = self.upper.symlink_metadata(path).is_err()
            && self.base.metadata(path).is_ok_and(|m| m.is_file())
            && !whiteout_path(path).is_some_and(|m| self.upper.metadata(&m).is_ok());
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
            return Ok(self.limited(file, conf));
        }
        // Truncating a file the job wrote gives its bytes back.
        let released = if truncating {
            self.upper_size(path)
        } else {
            None
        };
        let file = self
            .inner
            .new_open_options()
            .options(conf.clone())
            .open(path)?;
        self.give(released);
        Ok(self.limited(file, conf))
    }
}

/// A frozen in-memory file system: every read is forwarded, every write is
/// refused. The overlay never writes to its lower layer, so this is belt and
/// braces against a bug there leaking one job's writes into the next.
#[derive(Debug)]
pub struct ReadOnlyFs(mem_fs::FileSystem);

impl FileSystem for ReadOnlyFs {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.0.readlink(path)
    }
    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.0.read_dir(path)
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
        self.0.metadata(path)
    }
    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.0.symlink_metadata(path)
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
        self.0
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

    #[test]
    fn a_limited_fork_refuses_writes_past_its_budget_before_they_land() {
        use std::sync::atomic::Ordering;
        let cap = Arc::new(Cap {
            max: 64 << 10,
            ..Default::default()
        });
        let job = snapshot().fork_limited(cap.clone());
        job.write("/app/small.txt", &[1u8; 1024]).unwrap();
        assert_eq!(cap.used.load(Ordering::SeqCst), 1024);

        // Refused before it reaches the file: nothing of it is written.
        assert!(job.write("/app/big.bin", &vec![0u8; 1 << 20]).is_err());
        assert_eq!(job.read("/app/big.bin").map(|b| b.len()).unwrap_or(0), 0);
        assert_eq!(cap.used.load(Ordering::SeqCst), 1024);

        // Overwriting gives the old bytes back first; deleting gives them back.
        job.write("/app/small.txt", &[2u8; 512]).unwrap();
        assert_eq!(cap.used.load(Ordering::SeqCst), 512);
        job.remove_file("/app/small.txt").unwrap();
        assert_eq!(cap.used.load(Ordering::SeqCst), 0);

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

    #[test]
    fn a_stored_entry_cannot_climb_out() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"IWCIENTS");
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&1u64.to_le_bytes());
        buf.push(0);
        let evil = "/app/../etc";
        buf.extend_from_slice(&(evil.len() as u32).to_le_bytes());
        buf.extend_from_slice(evil.as_bytes());
        assert!(archive::decode(&mut buf.as_slice(), 1 << 20).is_err());
    }

    #[test]
    fn the_frozen_layer_refuses_writes() {
        let snap = snapshot();
        assert!(write_file(snap.fs.as_ref(), "/app/x", b"x").is_err());
    }
}
