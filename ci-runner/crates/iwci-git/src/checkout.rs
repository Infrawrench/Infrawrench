//! Writing a commit's tree into the in-memory file system.

use std::ffi::OsStr;
use std::future::Future;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use gix::ObjectId;
use gix::bstr::{BStr, ByteSlice};
use gix::objs::FindExt;
use gix::objs::tree::EntryKind;
use iwci_vfs::VfsError;
use iwci_vfs::virtual_fs::{AsyncWriteExt, FileSystem, FsError, mem_fs};

use crate::{GitError, Result, find_commit};

/// Deeper trees than this are refused. Real repositories stay far below
/// it; a crafted one could otherwise recurse until the stack runs out.
const MAX_TREE_DEPTH: usize = 512;

/// What a checkout wrote.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Checkout {
    pub commit: String,
    pub tree: String,
    /// Regular files, executables included.
    pub files: usize,
    /// Of `files`, how many git records as executable. The in-memory file
    /// system has no mode bits, so this is reported rather than applied.
    pub executables: usize,
    pub symlinks: usize,
    pub directories: usize,
    /// Total size of the files written.
    pub bytes: u64,
    /// Gitlinks, which have no content in this repository and were skipped.
    pub submodules: Vec<Submodule>,
}

/// A submodule entry left out of a checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submodule {
    /// Relative to the checkout root, `/`-separated.
    pub path: String,
    /// The commit the superproject pins it to.
    pub commit: String,
}

/// The delta base cache shared out between the decoding threads. Packs
/// from a shallow fetch are delta compressed against similar files, often
/// in chains dozens deep; with gix's default 64-entry cache a 30k-file
/// checkout re-inflates the same bases over and over and takes seconds
/// rather than a few hundred milliseconds. The cache is freed with the
/// handles when the checkout returns.
const DELTA_CACHE_BYTES: usize = 256 << 20;
const MAX_THREADS: usize = 8;
/// Fewer files than this per thread and spawning costs more than it saves.
const FILES_PER_THREAD: usize = 512;

pub(crate) fn checkout(
    repo: &gix::Repository,
    commit: ObjectId,
    fs: &mem_fs::FileSystem,
    into: &str,
) -> Result<Checkout> {
    let tree = find_commit(repo, commit)?.tree_id()?.detach();
    let root = iwci_vfs::normalise(into)?;
    prepare_root(fs, &root)?;

    // First a single-threaded walk of the trees: every name validated,
    // directories and symlinks created, files queued in tree order. Then
    // the blobs, which is where the time goes, decoded on several threads.
    let mut walker = Walker {
        objects: &repo.objects,
        hash: repo.object_hash(),
        fs,
        root_len: root.as_os_str().len(),
        path: root,
        blob: Vec::new(),
        tree_bufs: Vec::new(),
        files: Vec::new(),
        out: Checkout {
            commit: commit.to_string(),
            tree: tree.to_string(),
            ..Checkout::default()
        },
    };
    walker.tree(tree, 0)?;
    let Walker { files, mut out, .. } = walker;
    out.files = files.len();
    out.bytes = write_files(repo, fs, &files)?;
    Ok(out)
}

/// A file the walk found, written by [`write_files`].
struct FileJob {
    path: PathBuf,
    id: ObjectId,
}

fn write_files(repo: &gix::Repository, fs: &mem_fs::FileSystem, files: &[FileJob]) -> Result<u64> {
    let parallelism = std::thread::available_parallelism().map_or(1, |n| n.get());
    let threads = parallelism
        .min(MAX_THREADS)
        .min(files.len().div_ceil(FILES_PER_THREAD))
        .max(1);
    let with_cache = |mut repo: gix::Repository| {
        let bytes = DELTA_CACHE_BYTES / threads;
        repo.objects.set_pack_cache(move || {
            Box::new(gix::odb::pack::cache::lru::MemoryCappedHashmap::new(bytes))
        });
        // Every blob is read once; caching whole objects only costs memory.
        repo.objects.unset_object_cache();
        repo
    };
    if threads == 1 {
        return write_chunk(&with_cache(repo.clone()), fs, files);
    }
    let shared = repo.clone().into_sync();
    // Contiguous chunks keep each thread on a run of files that were
    // packed near each other, so its share of the cache stays useful.
    let chunk = files.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|files| {
                let repo = with_cache(shared.to_thread_local());
                scope.spawn(move || write_chunk(&repo, fs, files))
            })
            .collect();
        let mut total = 0;
        for handle in handles {
            total += handle.join().expect("a checkout thread panicked")?;
        }
        Ok(total)
    })
}

fn write_chunk(repo: &gix::Repository, fs: &mem_fs::FileSystem, files: &[FileJob]) -> Result<u64> {
    let mut blob = Vec::new();
    let mut total = 0;
    for job in files {
        let data = repo.objects.find_blob(&job.id, &mut blob)?.data;
        // The walk saw to it that every name in a directory is unique, so
        // `create_new` failing means something else wrote here meanwhile.
        let mut file = fs
            .new_open_options()
            .write(true)
            .create_new(true)
            .open(&job.path)
            .map_err(|e| vfs_err(&job.path, e))?;
        poll_now(async {
            file.write_all(data).await?;
            file.flush().await
        })
        .map_err(|e| vfs_err(&job.path, e.into()))?;
        total += data.len() as u64;
    }
    Ok(total)
}

/// `root` must end up an empty directory: a checkout over existing content
/// could not tell a duplicate tree entry from a file that was already there.
fn prepare_root(fs: &mem_fs::FileSystem, root: &Path) -> Result<()> {
    if let Some(parent) = root.parent() {
        iwci_vfs::create_dir_all(fs, parent)?;
    }
    match fs.create_dir(root) {
        Ok(()) => Ok(()),
        Err(FsError::AlreadyExists) => {
            let empty = fs.metadata(root).is_ok_and(|m| m.is_dir())
                && fs
                    .read_dir(root)
                    .is_ok_and(|mut entries| entries.next().is_none());
            if empty {
                Ok(())
            } else {
                Err(GitError::TargetNotEmpty(root.display().to_string()))
            }
        }
        Err(source) => Err(vfs_err(root, source)),
    }
}

struct Walker<'a> {
    objects: &'a gix::OdbHandle,
    hash: gix::hash::Kind,
    fs: &'a mem_fs::FileSystem,
    /// The absolute guest path of the entry being visited. One buffer,
    /// pushed and popped as the walk goes; only queued files get a copy,
    /// since they are written after the walk.
    path: PathBuf,
    root_len: usize,
    /// Reused for every symlink target.
    blob: Vec<u8>,
    /// One reused buffer per tree depth: a tree's bytes must stay alive
    /// while its subtrees are read.
    tree_bufs: Vec<Vec<u8>>,
    files: Vec<FileJob>,
    out: Checkout,
}

impl Walker<'_> {
    fn tree(&mut self, id: ObjectId, depth: usize) -> Result<()> {
        if depth >= MAX_TREE_DEPTH {
            return Err(
                self.unsafe_entry(b"".as_bstr(), "trees nest deeper than any checkout allows")
            );
        }
        if self.tree_bufs.len() <= depth {
            self.tree_bufs.push(Vec::new());
        }
        let mut buf = std::mem::take(&mut self.tree_bufs[depth]);
        self.objects.find_tree_iter(&id, &mut buf)?;
        self.unique_names(&buf)?;
        for entry in gix::objs::TreeRefIter::from_bytes(&buf, self.hash) {
            let entry = entry?;
            let kind = entry.mode.kind();
            let name = entry.filename;
            if let Err(reason) = validate_name(name, kind == EntryKind::Link) {
                return Err(self.unsafe_entry(name, &reason));
            }
            self.path.push(OsStr::from_bytes(name));
            let result = match kind {
                EntryKind::Tree => self.directory(entry.oid.to_owned(), depth),
                EntryKind::Blob | EntryKind::BlobExecutable => {
                    self.files.push(FileJob {
                        path: self.path.clone(),
                        id: entry.oid.to_owned(),
                    });
                    self.out.executables += usize::from(kind == EntryKind::BlobExecutable);
                    Ok(())
                }
                EntryKind::Link => self.symlink(entry.oid),
                EntryKind::Commit => {
                    let path = self.relative();
                    self.out.submodules.push(crate::Submodule {
                        path,
                        commit: entry.oid.to_string(),
                    });
                    Ok(())
                }
            };
            // A failure leaves the path half popped, which is fine: the
            // walk stops at the first error.
            result?;
            self.path.pop();
        }
        self.tree_bufs[depth] = buf;
        Ok(())
    }

    /// Refuses a tree that names one entry twice. The in-memory file
    /// system cannot be relied on for this: it refuses a directory over a
    /// directory, but over a file it adds a second child of the same name,
    /// and `create_new` succeeds over a directory. Git orders a subtree as
    /// if its name ended in `/`, so a file and a directory of one name need
    /// not be adjacent; sorting the raw names makes any repeat adjacent.
    fn unique_names(&self, tree: &[u8]) -> Result<()> {
        let mut names = Vec::new();
        for entry in gix::objs::TreeRefIter::from_bytes(tree, self.hash) {
            names.push(entry?.filename);
        }
        names.sort_unstable();
        match names.windows(2).find(|pair| pair[0] == pair[1]) {
            Some(pair) => {
                Err(self.unsafe_entry(pair[0], "the tree has two entries with this name"))
            }
            None => Ok(()),
        }
    }

    fn directory(&mut self, id: ObjectId, depth: usize) -> Result<()> {
        self.fs
            .create_dir(&self.path)
            .map_err(|e| self.duplicate_or(e))?;
        self.out.directories += 1;
        self.tree(id, depth + 1)
    }

    fn symlink(&mut self, id: &gix::oid) -> Result<()> {
        // Owned so the error paths can borrow `self`; symlinks are rare
        // enough that the copy does not matter.
        let target = PathBuf::from(OsStr::from_bytes(
            self.objects.find_blob(id, &mut self.blob)?.data,
        ));
        let raw = target.as_os_str().as_bytes();
        if raw.is_empty() || raw.contains(&0) {
            return Err(self.unsafe_here("symlink target is empty or holds a NUL"));
        }
        // The target is kept verbatim. It can point anywhere, but it
        // resolves inside the guest's own file system, which is the only
        // world a job can see.
        if let Err(e) = self.fs.create_symlink(&target, &self.path) {
            return Err(self.duplicate_or(e));
        }
        self.out.symlinks += 1;
        Ok(())
    }

    /// The current path relative to the checkout root.
    fn relative(&self) -> String {
        let bytes = self.path.as_os_str().as_bytes();
        let rel = bytes.get(self.root_len..).unwrap_or_default();
        String::from_utf8_lossy(rel.strip_prefix(b"/").unwrap_or(rel)).into_owned()
    }

    /// An error about `name`, an entry of the tree at the current path.
    fn unsafe_entry(&self, name: &BStr, reason: &str) -> GitError {
        let parent = self.relative();
        GitError::UnsafeEntry {
            parent: if parent.is_empty() {
                "/".into()
            } else {
                parent
            },
            name: name.to_str_lossy().into_owned(),
            reason: reason.to_owned(),
        }
    }

    /// An error about the entry the current path ends in.
    fn unsafe_here(&mut self, reason: &str) -> GitError {
        let name = self
            .path
            .file_name()
            .map(|n| n.as_bytes().to_vec())
            .unwrap_or_default();
        self.path.pop();
        self.unsafe_entry(name.as_bstr(), reason)
    }

    fn duplicate_or(&mut self, source: FsError) -> GitError {
        if source == FsError::AlreadyExists {
            self.unsafe_here("the tree has two entries with this name")
        } else {
            vfs_err(&self.path, source)
        }
    }
}

/// Whether `name` may become one path component of a checkout. Untrusted:
/// it comes straight out of a tree object.
pub(crate) fn validate_name(name: &BStr, is_symlink: bool) -> std::result::Result<(), String> {
    use gix::validate::path::component;
    // gix's checks are git's own (`core.protectHFS`/`protectNTFS`): no
    // empty names, `.` or `..`, no `/`, and no `.git` under any spelling
    // that a case-folding or Unicode-ignoring file system would treat as
    // it. Windows device names are not an issue for an in-memory tree, and
    // refusing backslashes would refuse real Unix repositories.
    let options = component::Options {
        protect_windows: false,
        protect_hfs: true,
        protect_ntfs: true,
    };
    component(
        name,
        is_symlink.then_some(component::Mode::Symlink),
        options,
    )
    .map_err(|e| e.to_string())?;
    if name.contains(&0) {
        return Err("names must not contain NUL".into());
    }
    // And the file system's own view, the rule `iwci_vfs::join_under`
    // enforces: exactly one normal component, nothing that a `Path` would
    // read as a root, a parent or the current directory.
    let mut components = Path::new(OsStr::from_bytes(name)).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(part)), None) if part.as_bytes() == name.as_bytes() => Ok(()),
        _ => Err("not a single path component".into()),
    }
}

fn vfs_err(path: &Path, source: FsError) -> GitError {
    GitError::Vfs(VfsError::Fs {
        path: path.display().to_string(),
        source,
    })
}

/// Drives a future that is known to complete on its first poll. The
/// in-memory files finish every write synchronously; a pending poll would
/// mean that stopped being true, which is reported rather than spun on.
fn poll_now<F: Future<Output = std::io::Result<()>>>(future: F) -> std::io::Result<()> {
    let mut future = pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(result) => result,
        Poll::Pending => Err(std::io::Error::other(
            "an in-memory write did not complete synchronously",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_escape_or_plant_a_repository_are_refused() {
        for bad in [
            "", ".", "..", "a/b", ".git", ".GIT", "GIT~1", ".git.", "a\0b",
        ] {
            assert!(
                validate_name(bad.as_bytes().as_bstr(), false).is_err(),
                "{bad:?}"
            );
        }
        assert!(validate_name(b".gitmodules".as_bstr(), true).is_err());
        for good in [
            "a",
            ".github",
            ".gitignore",
            "x..y",
            "...",
            "back\\slash",
            "naïve",
        ] {
            assert!(
                validate_name(good.as_bytes().as_bstr(), false).is_ok(),
                "{good:?}"
            );
        }
    }
}
