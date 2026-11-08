//! Which paths differ between two commits' trees.
//!
//! Written by hand rather than with gix's tree diff, which lives behind the
//! `blob-diff` feature and its attribute and filter machinery. A tree diff
//! for path filters needs none of that: walk both trees in step and only
//! descend where two subtrees' ids differ, so an unchanged directory costs
//! one comparison however large it is.

use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice, ByteVec};
use gix::objs::FindExt;
use gix::objs::tree::EntryKind;

use crate::{Result, find_commit};

pub(crate) fn changed_paths(
    repo: &gix::Repository,
    base: ObjectId,
    head: ObjectId,
) -> Result<Vec<String>> {
    let base_tree = find_commit(repo, base)?.tree_id()?.detach();
    let head_tree = find_commit(repo, head)?.tree_id()?.detach();
    let mut out = Vec::new();
    let mut prefix = BString::default();
    compare(
        repo,
        Some(base_tree),
        Some(head_tree),
        &mut prefix,
        &mut out,
    )?;
    out.sort();
    out.dedup();
    Ok(out)
}

/// One tree entry, owned, so both sides can be held while recursing.
struct Entry {
    name: BString,
    kind: EntryKind,
    id: ObjectId,
}

fn entries(repo: &gix::Repository, tree: Option<ObjectId>) -> Result<Vec<Entry>> {
    let Some(tree) = tree else {
        return Ok(Vec::new());
    };
    let mut buf = Vec::new();
    let mut out = Vec::new();
    for entry in repo.objects.find_tree_iter(&tree, &mut buf)? {
        let entry = entry?;
        out.push(Entry {
            name: entry.filename.to_owned(),
            kind: entry.mode.kind(),
            id: entry.oid.to_owned(),
        });
    }
    // Git orders a tree as if subtree names ended in `/`; matching the two
    // sides by name needs plain byte order instead.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn compare(
    repo: &gix::Repository,
    old: Option<ObjectId>,
    new: Option<ObjectId>,
    prefix: &mut BString,
    out: &mut Vec<String>,
) -> Result<()> {
    if old == new {
        return Ok(());
    }
    let old = entries(repo, old)?;
    let new = entries(repo, new)?;
    let (mut i, mut j) = (0, 0);
    while i < old.len() || j < new.len() {
        let order = match (old.get(i), new.get(j)) {
            (Some(a), Some(b)) => a.name.cmp(&b.name),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, _) => std::cmp::Ordering::Greater,
        };
        let (a, b) = match order {
            std::cmp::Ordering::Less => {
                i += 1;
                (Some(&old[i - 1]), None)
            }
            std::cmp::Ordering::Greater => {
                j += 1;
                (None, Some(&new[j - 1]))
            }
            std::cmp::Ordering::Equal => {
                i += 1;
                j += 1;
                (Some(&old[i - 1]), Some(&new[j - 1]))
            }
        };
        let name = a
            .or(b)
            .map(|e| e.name.as_bstr())
            .expect("one side is present");
        let len = prefix.len();
        push_component(prefix, name);
        let tree_of = |e: Option<&Entry>| e.filter(|e| e.kind == EntryKind::Tree).map(|e| e.id);
        let leaf_of = |e: Option<&Entry>| {
            e.filter(|e| e.kind != EntryKind::Tree)
                .map(|e| (e.kind, e.id))
        };
        // The path itself changed if it is a non-tree on either side and
        // that side differs; whatever is under it changed if it is a tree on
        // either side and those differ. A file replaced by a directory is
        // both.
        if leaf_of(a) != leaf_of(b) {
            out.push(prefix.to_str_lossy().into_owned());
        }
        if tree_of(a).is_some() || tree_of(b).is_some() {
            compare(repo, tree_of(a), tree_of(b), prefix, out)?;
        }
        prefix.truncate(len);
    }
    Ok(())
}

fn push_component(prefix: &mut BString, name: &BStr) {
    if !prefix.is_empty() {
        prefix.push_byte(b'/');
    }
    prefix.push_str(name);
}
