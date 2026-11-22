//! A minimal, read-only `.git` written into the snapshot after checkout.
//!
//! A checkout is only a tree of files, but pipelines ported from GitHub
//! Actions assume `actions/checkout` left a repository behind: the failing
//! email-sdk job runs `git ls-files --cached --others --exclude-standard`.
//! This module gives those jobs just enough of a repository for `ls-files`,
//! `rev-parse HEAD` and `describe --always` to work. It is written into the
//! frozen snapshot, so every job sees the same bytes through the lower layer
//! and its own writes still go to the fork's overlay.
//!
//! The object database holds only the checked-out commit and its root tree
//! as loose objects. `shallow` marks the commit as the end of history, so no
//! parent objects are needed. The index lists every checked-out file with
//! its real blob id and size.

use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::ZlibEncoder;
use gix::ObjectId;
use sha1::Digest;

use crate::{GitError, Result};

/// The checked-out commit has no branch attached to it in the cache. Any
/// branch name works for the commands this supports; `main` is the one the
/// benchmarks use.
const BRANCH: &str = "main";

/// One checked-out file, as the index needs it.
pub(crate) struct IndexEntry {
    pub path: Vec<u8>,
    pub id: ObjectId,
    pub executable: bool,
    pub size: u64,
}

pub(crate) fn write(
    repo: &gix::Repository,
    builder: &iwci_vfs::SnapshotBuilder,
    root: &Path,
    commit: ObjectId,
    tree: ObjectId,
    files: &[IndexEntry],
) -> Result<()> {
    let git = root.join(".git");

    iwci_vfs::write_file(
        builder.fs(),
        git.join("HEAD"),
        format!("ref: refs/heads/{BRANCH}\n").as_bytes(),
    )?;
    iwci_vfs::write_file(
        builder.fs(),
        git.join("refs/heads/main"),
        format!("{commit}\n").as_bytes(),
    )?;
    iwci_vfs::write_file(
        builder.fs(),
        git.join("shallow"),
        format!("{commit}\n").as_bytes(),
    )?;
    iwci_vfs::write_file(
        builder.fs(),
        git.join("config"),
        b"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
    )?;
    for dir in ["objects/info", "objects/pack", "refs/tags"] {
        iwci_vfs::create_dir_all(builder.fs(), git.join(dir))?;
    }

    write_loose(repo, builder, &git, commit, gix::objs::Kind::Commit)?;
    write_loose(repo, builder, &git, tree, gix::objs::Kind::Tree)?;

    iwci_vfs::write_file(builder.fs(), git.join("index"), &build_index(files))?;
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
    let object = repo
        .try_find_object(id)?
        .ok_or_else(|| GitError::NotFetched(id.to_string()))?;
    if object.kind != kind {
        return Err(GitError::WrongObjectKind {
            id: id.to_string(),
            expected: kind.to_string(),
            actual: object.kind.to_string(),
        });
    }
    let mut raw = Vec::with_capacity(object.data.len() + 32);
    raw.extend_from_slice(kind.as_bytes());
    raw.push(b' ');
    write!(raw, "{}\0", object.data.len()).map_err(|e| io_err(Path::new("object"), e))?;
    raw.extend_from_slice(&object.data);

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&raw)
        .map_err(|e| io_err(Path::new("object"), e))?;
    let compressed = encoder
        .finish()
        .map_err(|e| io_err(Path::new("object"), e))?;

    let hex = id.to_string();
    let path: PathBuf = git.join("objects").join(&hex[..2]).join(&hex[2..]);
    iwci_vfs::write_file(builder.fs(), path, &compressed)?;
    Ok(())
}

/// Git's index version 2: a 12-byte header, one entry per file sorted by
/// path bytes, then a SHA-1 of everything written so far. Timestamps and
/// device/inode/owner fields are zero; `ls-files` does not read them, and a
/// job that needs a usable `status` can refresh the index itself.
fn build_index(files: &[IndexEntry]) -> Vec<u8> {
    let mut sorted: Vec<&IndexEntry> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    let mut out = Vec::with_capacity(12 + sorted.len() * 96 + 20);
    out.extend_from_slice(b"DIRC");
    out.extend_from_slice(&2u32.to_be_bytes());
    out.extend_from_slice(&(sorted.len() as u32).to_be_bytes());

    for entry in sorted {
        // ctime and mtime, four bytes each for seconds and nanoseconds.
        out.extend_from_slice(&[0; 16]);
        out.extend_from_slice(&0u32.to_be_bytes()); // dev
        out.extend_from_slice(&0u32.to_be_bytes()); // ino
        let mode = if entry.executable {
            0o100755u32
        } else {
            0o100644u32
        };
        out.extend_from_slice(&mode.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes()); // uid
        out.extend_from_slice(&0u32.to_be_bytes()); // gid
        out.extend_from_slice(&(entry.size as u32).to_be_bytes());
        out.extend_from_slice(entry.id.as_bytes());

        let len = entry.path.len();
        let extended = len >= 0xfff;
        let flags = if extended {
            0x4000u16 | 0x0fff
        } else {
            len as u16
        };
        out.extend_from_slice(&flags.to_be_bytes());
        if extended {
            out.extend_from_slice(&(len.min(0xffff) as u16).to_be_bytes());
        }
        out.extend_from_slice(&entry.path);
        out.push(0);

        let header = if extended { 64 } else { 62 };
        let used = header + len + 1;
        let padding = (8 - (used % 8)) % 8;
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
            executable: false,
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
        assert_eq!(&index[12..16], &[0; 4]); // a.txt's ctime
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
    fn index_pads_each_entry_to_eight_bytes() {
        let entries = [entry("x", 1, 1), entry("longer-name.txt", 2, 1)];
        let index = build_index(&entries);
        // Two entries, a 12-byte header and a 20-byte checksum: all a
        // multiple of eight, so the padded entries must be too.
        assert_eq!((index.len() - 12 - 20) % 8, 0);
    }

    #[test]
    fn long_paths_use_the_extended_flag() {
        let name = "a".repeat(4100);
        let entries = [entry(&name, 1, 1)];
        let index = build_index(&entries);
        assert_eq!(&index[12 + 60..12 + 62], &0x4fffu16.to_be_bytes());
        assert_eq!(&index[12 + 62..12 + 64], &4100u16.to_be_bytes());
    }
}
