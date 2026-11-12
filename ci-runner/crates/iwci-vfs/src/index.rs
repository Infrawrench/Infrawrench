//! Name lookups in a frozen snapshot that do not scan directories (#995).
//!
//! Wasmer's in-memory file system keeps a directory's children in a list and
//! finds a path by checking each child of each directory along it in turn,
//! so every lookup through `node_modules/.pnpm` (thousands of packages)
//! compared names with most of them. Module resolution stats the same few
//! directories constantly: `ui`'s Vitest job used about 5% more runner CPU
//! than it does with this index.
//!
//! A snapshot never changes once frozen, so [`Index`] lists each directory
//! once, the first time a lookup goes through it, and answers from a hash
//! map after that: a lookup costs one hash of its parent's path and one of
//! its name. Only directories something looked in are listed, and the index
//! lives as long as the snapshot, so every job forked from it shares it.
//!
//! It answers exactly what the in-memory file system would, errors included,
//! and leaves alone what it does not cover: paths with `.` or `..` in them,
//! the root itself, opening files and reading links. The one difference is a
//! file's access time: opening a file updates it in the file system, and the
//! index keeps the one from when the directory was listed.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use virtual_fs::{DirEntry, FileSystem, FsError, Metadata, ReadDir, mem_fs};

/// One directory's children, in the order the file system lists them.
#[derive(Debug)]
struct Dir {
    entries: Vec<(OsString, Metadata)>,
    by_name: HashMap<OsString, usize>,
}

impl Dir {
    fn get(&self, name: &OsStr) -> Option<&Metadata> {
        self.by_name.get(name).map(|&i| &self.entries[i].1)
    }
}

#[derive(Debug, Default)]
pub(crate) struct Index {
    /// Directories listed so far, by absolute path.
    dirs: RwLock<HashMap<PathBuf, Arc<Dir>>>,
}

/// Whether `path` is absolute with nothing but names after the root, the
/// only form the index answers for.
fn plain(path: &Path) -> bool {
    let mut components = path.components();
    components.next() == Some(Component::RootDir)
        && components.all(|c| matches!(c, Component::Normal(_)))
}

impl Index {
    /// What `fs.metadata(path)` (or `symlink_metadata`, the same thing in
    /// the in-memory file system, which never follows a link) returns.
    pub(crate) fn metadata(
        &self,
        fs: &mem_fs::FileSystem,
        path: &Path,
    ) -> Result<Metadata, FsError> {
        let (Some(parent), Some(name), true) = (path.parent(), path.file_name(), plain(path))
        else {
            return fs.metadata(path);
        };
        self.dir(fs, parent)?
            .get(name)
            .cloned()
            .ok_or(FsError::EntryNotFound)
    }

    /// What `fs.read_dir(path)` returns.
    pub(crate) fn read_dir(
        &self,
        fs: &mem_fs::FileSystem,
        path: &Path,
    ) -> Result<ReadDir, FsError> {
        if !plain(path) {
            return fs.read_dir(path);
        }
        let dir = match self.dir(fs, path) {
            Ok(dir) => dir,
            // The in-memory file system refuses to list a file with
            // `InvalidInput`, not `BaseNotDirectory`.
            Err(FsError::BaseNotDirectory) if self.metadata(fs, path).is_ok() => {
                return Err(FsError::InvalidInput);
            }
            Err(e) => return Err(e),
        };
        Ok(ReadDir::new(
            dir.entries
                .iter()
                .map(|(name, meta)| DirEntry {
                    path: path.join(name),
                    metadata: Ok(meta.clone()),
                })
                .collect(),
        ))
    }

    /// The listing of the directory at `path`, listing it now if nothing has
    /// looked in it before. An error is what looking up a child of `path`
    /// gives: `EntryNotFound` when `path` is missing, `BaseNotDirectory`
    /// when it, or a directory above it, is something else.
    fn dir(&self, fs: &mem_fs::FileSystem, path: &Path) -> Result<Arc<Dir>, FsError> {
        if let Some(dir) = self
            .dirs
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(path)
        {
            return Ok(dir.clone());
        }
        // Checked through the index too, so a path under a missing or
        // non-directory parent is refused without listing anything.
        if path.parent().is_some() && !self.metadata(fs, path)?.is_dir() {
            return Err(FsError::BaseNotDirectory);
        }
        let mut entries = Vec::new();
        let mut by_name = HashMap::new();
        for entry in fs.read_dir(path)? {
            let entry = entry?;
            let (Some(name), Ok(meta)) = (entry.path.file_name(), entry.metadata) else {
                continue;
            };
            by_name.insert(name.to_owned(), entries.len());
            entries.push((name.to_owned(), meta));
        }
        let dir = Arc::new(Dir { entries, by_name });
        Ok(self
            .dirs
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .entry(path.to_path_buf())
            .or_insert(dir)
            .clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs() -> mem_fs::FileSystem {
        let fs = mem_fs::FileSystem::default();
        crate::write_file(&fs, "/app/a.txt", b"a").unwrap();
        crate::write_file(
            &fs,
            "/app/node_modules/.pnpm/x@1/node_modules/x/index.js",
            b"x",
        )
        .unwrap();
        crate::symlink(&fs, "/app/node_modules/x", ".pnpm/x@1/node_modules/x").unwrap();
        for i in 0..50 {
            crate::write_file(&fs, format!("/app/many/{i}"), b"").unwrap();
        }
        fs
    }

    /// Every lookup answers what the file system itself answers, whatever
    /// is (or is not) along the path.
    #[test]
    fn the_index_answers_what_the_file_system_does() {
        let fs = fs();
        let index = Index::default();
        let paths = [
            "/",
            "/app",
            "/app/",
            "/app/a.txt",
            "/app/a.txt/under-a-file",
            "/app/missing",
            "/app/missing/deeper",
            "/app/node_modules",
            "/app/node_modules/x",
            "/app/node_modules/x/index.js",
            "/app/node_modules/.pnpm/x@1/node_modules/x/index.js",
            "/app/node_modules/.pnpm/x@1/node_modules/x/../x/index.js",
            "/app/./a.txt",
            "/app/many/7",
            "/app/many/50",
            "/nope",
        ];
        // Twice: once listing directories, once from the listings.
        for _ in 0..2 {
            for path in paths {
                let path = Path::new(path);
                assert_eq!(
                    index.metadata(&fs, path),
                    fs.metadata(path),
                    "metadata {}",
                    path.display()
                );
                let listing = |r: Result<ReadDir, FsError>| {
                    r.map(|d| d.flatten().map(|e| e.path).collect::<Vec<_>>())
                };
                assert_eq!(
                    listing(index.read_dir(&fs, path)),
                    listing(fs.read_dir(path)),
                    "read_dir {}",
                    path.display()
                );
            }
        }
    }
}
