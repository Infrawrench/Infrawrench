//! Turning a job's file changes into a commit, and listing the objects an
//! upload of that commit needs.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};

use gix::ObjectId;
use gix::bstr::{BString, ByteSlice, ByteVec};
use gix::objs::FindExt;
use gix::objs::tree::EntryKind;
use iwci_vfs::Change;

use crate::checkout::validate_name;
use crate::{GitError, Result, find_commit};

/// A person and a moment, for a commit's author or committer line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
    /// The zone the time was recorded in, as seconds east of UTC.
    pub utc_offset: i32,
}

/// The commit [`crate::RemoteCache::commit_changes`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCommit {
    pub commit: String,
    pub tree: String,
    pub parent: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ObjectKind {
    Blob,
    Tree,
    Commit,
}

impl ObjectKind {
    /// The name git uses in object headers and APIs use in JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            ObjectKind::Blob => "blob",
            ObjectKind::Tree => "tree",
            ObjectKind::Commit => "commit",
        }
    }
}

/// One object of a commit's upload, in git's canonical encoding (without
/// the `<kind> <len>\0` header), so `sha1(header + data) == id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedObject {
    pub id: String,
    pub kind: ObjectKind,
    pub data: Vec<u8>,
}

pub(crate) fn commit_changes(
    repo: &gix::Repository,
    head: ObjectId,
    changes: &[Change],
    strip_prefix: &str,
    message: &str,
    author: &Identity,
    committer: &Identity,
) -> Result<NewCommit> {
    let head_tree = find_commit(repo, head)?.tree_id()?.detach();
    let prefix = iwci_vfs::normalise(strip_prefix)?;
    let head_tree_object = repo.find_tree(head_tree)?;
    let mut editor = repo.edit_tree(head_tree)?;
    for change in changes {
        let path = relative_path(change.path(), &prefix)?;
        match change {
            Change::Added { bytes, .. } | Change::Modified { bytes, .. } => {
                let blob = repo.write_blob(bytes)?.detach();
                // A job sees no mode bits, so an edited file keeps the mode
                // it had (an executable stays executable) and anything new,
                // or anything that was a symlink or a directory before, is
                // a plain file now.
                // Looked up in head's tree, not the editor's: the editor
                // only knows the trees an earlier edit already loaded.
                let before = head_tree_object
                    .lookup_entry_by_path(Path::new(OsStr::from_bytes(&path)))?
                    .map(|e| e.mode().kind());
                let kind = match before {
                    Some(EntryKind::BlobExecutable) => EntryKind::BlobExecutable,
                    _ => EntryKind::Blob,
                };
                editor.upsert(&path, kind, blob)?;
            }
            Change::Deleted { .. } => {
                editor.remove(&path)?;
            }
        }
    }
    let tree = editor.write()?.detach();
    if tree == head_tree {
        return Err(GitError::NothingToCommit(head.to_string()));
    }
    let mut message = message.to_owned();
    if !message.ends_with('\n') {
        message.push('\n');
    }
    let commit = gix::objs::Commit {
        tree,
        parents: vec![head].into(),
        author: signature(author),
        committer: signature(committer),
        encoding: None,
        message: message.into(),
        extra_headers: Vec::new(),
    };
    let id = repo.write_object(&commit)?.detach();
    Ok(NewCommit {
        commit: id.to_string(),
        tree: tree.to_string(),
        parent: head.to_string(),
    })
}

fn signature(identity: &Identity) -> gix::actor::Signature {
    gix::actor::Signature {
        name: identity.name.as_str().into(),
        email: identity.email.as_str().into(),
        time: gix::date::Time {
            seconds: identity.time,
            offset: identity.utc_offset,
        },
    }
}

/// `path` (an absolute guest path) relative to `prefix`, as a `/`-joined
/// tree path. Each component is held to the same rules a checkout holds
/// tree names to, so a job cannot commit a `.git` directory or a name that
/// would not survive the next checkout.
fn relative_path(path: &Path, prefix: &Path) -> Result<BString> {
    let outside = || GitError::OutsidePrefix {
        path: path.display().to_string(),
        prefix: prefix.display().to_string(),
    };
    let path = iwci_vfs::normalise(path)?;
    let rel = path.strip_prefix(prefix).map_err(|_| outside())?;
    let mut out = BString::default();
    for component in rel.components() {
        let Component::Normal(part) = component else {
            return Err(outside());
        };
        let name = part.as_bytes().as_bstr();
        if let Err(reason) = validate_name(name, false) {
            return Err(GitError::UnsafeEntry {
                parent: rel.display().to_string(),
                name: name.to_str_lossy().into_owned(),
                reason,
            });
        }
        if !out.is_empty() {
            out.push_byte(b'/');
        }
        out.push_str(name);
    }
    if out.is_empty() {
        return Err(outside());
    }
    Ok(out)
}

pub(crate) fn export_objects(
    repo: &gix::Repository,
    commit: ObjectId,
) -> Result<Vec<ExportedObject>> {
    let object = find_commit(repo, commit)?;
    let tree = object.tree_id()?.detach();
    let parent_tree = match object.parent_ids().next() {
        Some(parent) => Some(find_commit(repo, parent.detach())?.tree_id()?.detach()),
        None => None,
    };
    let commit_data = object.data.clone();
    drop(object);

    let mut blobs = Vec::new();
    let mut trees = Vec::new();
    new_objects(repo, tree, parent_tree, &mut blobs, &mut trees)?;
    let mut out = blobs;
    out.extend(trees);
    out.push(ExportedObject {
        id: commit.to_string(),
        kind: ObjectKind::Commit,
        data: commit_data,
    });
    Ok(out)
}

/// Appends `tree` and everything under it that `old` (the tree at the same
/// path in the parent) does not have at the same path. Subtrees go before
/// the tree that lists them.
fn new_objects(
    repo: &gix::Repository,
    tree: ObjectId,
    old: Option<ObjectId>,
    blobs: &mut Vec<ExportedObject>,
    trees: &mut Vec<ExportedObject>,
) -> Result<()> {
    if Some(tree) == old {
        return Ok(());
    }
    let old_entries: HashMap<BString, (EntryKind, ObjectId)> = match old {
        Some(old) => {
            let mut buf = Vec::new();
            repo.objects
                .find_tree_iter(&old, &mut buf)?
                .map(|e| e.map(|e| (e.filename.to_owned(), (e.mode.kind(), e.oid.to_owned()))))
                .collect::<std::result::Result<_, _>>()?
        }
        None => HashMap::new(),
    };
    let mut data = Vec::new();
    let entries: Vec<(BString, EntryKind, ObjectId)> = repo
        .objects
        .find_tree_iter(&tree, &mut data)?
        .map(|e| e.map(|e| (e.filename.to_owned(), e.mode.kind(), e.oid.to_owned())))
        .collect::<std::result::Result<_, _>>()?;
    for (name, kind, id) in entries {
        let before = old_entries.get(&name).copied();
        if before.is_some_and(|(_, old_id)| old_id == id) {
            continue;
        }
        match kind {
            EntryKind::Tree => {
                // Only a subtree has anything in common with a subtree.
                let old_tree = before
                    .filter(|(old_kind, _)| *old_kind == EntryKind::Tree)
                    .map(|(_, old_id)| old_id);
                new_objects(repo, id, old_tree, blobs, trees)?
            }
            EntryKind::Blob | EntryKind::BlobExecutable | EntryKind::Link => {
                let mut buf = Vec::new();
                repo.objects.find_blob(&id, &mut buf)?;
                blobs.push(ExportedObject {
                    id: id.to_string(),
                    kind: ObjectKind::Blob,
                    data: buf,
                });
            }
            EntryKind::Commit => {}
        }
    }
    trees.push(ExportedObject {
        id: tree.to_string(),
        kind: ObjectKind::Tree,
        data,
    });
    Ok(())
}
