//! A shallow `.git` written into a job's checkout.
//!
//! A checkout is only a tree of files, but pipelines ported from GitHub
//! Actions assume `actions/checkout` left a repository behind: they run
//! `git ls-files`, `git rev-parse HEAD`, `git describe --always`, and Go
//! stamps binaries from `git status`. This writes enough of a repository
//! for those to work, and for `git status` to call the checkout clean.
//!
//! What it holds: the commit and every tree under it as loose objects,
//! `shallow` naming the commit (so its parents are not needed), `HEAD` on
//! the run's branch (or detached on the commit when the run is not on a
//! branch, as `actions/checkout` leaves a pull request), and an index of
//! every file, symlink and submodule with its real object id and size. Blobs
//! are not copied: the files themselves are in the checkout, and the index
//! names their ids. A command that needs a blob's old content (`git diff`
//! on a file the job changed, `git show HEAD:file`) says it is missing.
//!
//! It is written into the frozen snapshot, so every job sees the same bytes
//! through the lower layer, and what git writes (a refreshed index) goes to
//! the job's own overlay. The scheduler leaves `.git` out of a job's changes
//! and out of `hashFiles`.

use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::ZlibEncoder;
use gix::ObjectId;
use sha1::Digest;

use crate::{GitError, Result};

/// What `HEAD` points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Head {
    /// `refs/heads/<name>`, holding the commit.
    Branch(String),
    /// The commit itself, as a detached `HEAD`.
    Detached,
}

impl Head {
    /// The branch a ref names (`refs/heads/main` is `main`), or a detached
    /// `HEAD` for anything else (`refs/pull/1/head`, a tag, nothing).
    pub fn from_ref(git_ref: Option<&str>) -> Head {
        git_ref
            .and_then(|r| r.strip_prefix("refs/heads/"))
            .filter(|name| {
                gix::validate::reference::name_partial(gix::bstr::BStr::new(name)).is_ok()
            })
            .map_or(Head::Detached, |name| Head::Branch(name.to_string()))
    }
}

/// Git's mode for a symlink.
pub(crate) const SYMLINK_MODE: u32 = 0o120000;

/// One index entry: a file, a symlink or a submodule.
pub(crate) struct IndexEntry {
    pub path: Vec<u8>,
    pub id: ObjectId,
    /// Git's mode: `100644`, `100755`, `120000` or `160000`.
    pub mode: u32,
    pub size: u64,
}

pub(crate) fn write(
    repo: &gix::Repository,
    builder: &iwci_vfs::SnapshotBuilder,
    root: &Path,
    head: &Head,
    commit: ObjectId,
    trees: &[ObjectId],
    files: &[IndexEntry],
) -> Result<()> {
    let git = root.join(".git");
    let fs = builder.fs();

    for dir in ["objects/info", "objects/pack", "refs/heads", "refs/tags"] {
        iwci_vfs::create_dir_all(fs, git.join(dir))?;
    }
    match head {
        Head::Branch(name) => {
            iwci_vfs::write_file(
                fs,
                git.join("HEAD"),
                format!("ref: refs/heads/{name}\n").as_bytes(),
            )?;
            iwci_vfs::write_file(
                fs,
                git.join("refs/heads").join(name),
                format!("{commit}\n").as_bytes(),
            )?;
        }
        Head::Detached => {
            iwci_vfs::write_file(fs, git.join("HEAD"), format!("{commit}\n").as_bytes())?;
        }
    }
    iwci_vfs::write_file(fs, git.join("shallow"), format!("{commit}\n").as_bytes())?;
    iwci_vfs::write_file(
        fs,
        git.join("config"),
        b"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
    )?;

    write_loose(repo, builder, &git, commit, gix::objs::Kind::Commit)?;
    for tree in trees {
        write_loose(repo, builder, &git, *tree, gix::objs::Kind::Tree)?;
    }
    // git compares a file with its index entry by hashing the file, but a
    // symlink by reading the entry's blob, so those few blobs are needed.
    for link in files.iter().filter(|f| f.mode == SYMLINK_MODE) {
        write_loose(repo, builder, &git, link.id, gix::objs::Kind::Blob)?;
    }

    iwci_vfs::write_file(fs, git.join("index"), &build_index(files))?;
    Ok(())
}

/// A loose object is zlib-compressed `<kind> <len>\0<payload>` under a
/// two-hex-digit fanout directory. The ids are the ones checkout used, so
/// no hashing is needed here.
fn write_loose(
    repo: &gix::Repository,
    builder: &iwci_vfs::SnapshotBuilder,
    git: &Path,
    id: ObjectId,
    kind: gix::objs::Kind,
) -> Result<()> {
    let hex = id.to_string();
    let path: PathBuf = git.join("objects").join(&hex[..2]).join(&hex[2..]);
    // Two directories with the same content share one tree object.
    if builder.read(&path).is_ok() {
        return Ok(());
    }
    let object = repo
        .try_find_object(id)?
        .ok_or_else(|| GitError::NotFetched(hex.clone()))?;
    if object.kind != kind {
        return Err(GitError::WrongObjectKind {
            id: hex,
            expected: kind.to_string(),
            actual: object.kind.to_string(),
        });
    }
    let mut raw = Vec::with_capacity(object.data.len() + 32);
    raw.extend_from_slice(kind.as_bytes());
    raw.push(b' ');
    write!(raw, "{}\0", object.data.len()).map_err(|e| io_err(&path, e))?;
    raw.extend_from_slice(&object.data);

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(&raw).map_err(|e| io_err(&path, e))?;
    let compressed = encoder.finish().map_err(|e| io_err(&path, e))?;
    iwci_vfs::write_file(builder.fs(), path, &compressed)?;
    Ok(())
}

/// Git's index version 2: a 12-byte header, one entry per path sorted by
/// its bytes, then a SHA-1 of everything before it. Timestamps and the
/// device, inode and owner fields are zero, so the first `git status`
/// hashes each file to compare it with its id rather than trusting a stat,
/// and finds the checkout clean.
fn build_index(files: &[IndexEntry]) -> Vec<u8> {
    let mut sorted: Vec<&IndexEntry> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    let mut out = Vec::with_capacity(12 + sorted.len() * 96 + 20);
    out.extend_from_slice(b"DIRC");
    out.extend_from_slice(&2u32.to_be_bytes());
    out.extend_from_slice(&(sorted.len() as u32).to_be_bytes());

    for entry in sorted {
        // ctime and mtime (seconds and nanoseconds each), dev and ino.
        out.extend_from_slice(&[0; 24]);
        out.extend_from_slice(&entry.mode.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes()); // uid
        out.extend_from_slice(&0u32.to_be_bytes()); // gid
        // The size is stored truncated to 32 bits, as git stores it.
        out.extend_from_slice(&(entry.size as u32).to_be_bytes());
        out.extend_from_slice(entry.id.as_bytes());
        // Version 2 has no extended flags: a name of 0xfff bytes or more
        // stores 0xfff and is found by its NUL.
        let flags = entry.path.len().min(0xfff) as u16;
        out.extend_from_slice(&flags.to_be_bytes());
        out.extend_from_slice(&entry.path);
        // One to eight NULs: the entry, from its ctime, ends on a multiple
        // of eight bytes.
        let used = 62 + entry.path.len();
        let padding = 8 - used % 8;
        out.extend(std::iter::repeat_n(0, padding));
    }

    let checksum = sha1::Sha1::digest(&out);
    out.extend_from_slice(&checksum);
    out
}

fn io_err(path: &Path, source: std::io::Error) -> GitError {
    GitError::Io {
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, last: u8, size: u64) -> IndexEntry {
        IndexEntry {
            path: name.as_bytes().to_vec(),
            id: format!("{last:040x}").parse().unwrap(),
            mode: 0o100644,
            size,
        }
    }

    #[test]
    fn index_is_sorted_and_checksummed() {
        let entries = [entry("b.txt", 2, 5), entry("a.txt", 1, 3)];
        let index = build_index(&entries);
        assert_eq!(&index[..4], b"DIRC");
        assert_eq!(&index[4..8], &2u32.to_be_bytes());
        assert_eq!(&index[8..12], &2u32.to_be_bytes());
        let mut blob = [0u8; 20];
        blob[19] = 1;
        assert_eq!(&index[12 + 40..12 + 60], &blob); // a.txt's blob id
        assert_eq!(&index[12 + 62..12 + 68], b"a.txt\0");
        assert_eq!(
            &index[index.len() - 20..],
            &sha1::Sha1::digest(&index[..index.len() - 20])[..]
        );
    }

    #[test]
    fn each_entry_ends_on_eight_bytes_with_at_least_one_nul() {
        // 62 + 2 = 64 is already a multiple of eight: git still writes
        // eight NULs there, since the name must end in one.
        for name in ["ab", "x", "longer-name.txt"] {
            let index = build_index(&[entry(name, 1, 1)]);
            let len = index.len() - 12 - 20;
            assert_eq!(len % 8, 0, "{name}");
            assert!(len > 62 + name.len(), "{name}");
        }
    }

    #[test]
    fn a_ref_on_a_branch_names_it_and_anything_else_detaches() {
        assert_eq!(
            Head::from_ref(Some("refs/heads/feat/x")),
            Head::Branch("feat/x".into())
        );
        assert_eq!(Head::from_ref(Some("refs/pull/7/head")), Head::Detached);
        assert_eq!(Head::from_ref(None), Head::Detached);
        assert_eq!(Head::from_ref(Some("refs/heads/a..b")), Head::Detached);
    }
}
