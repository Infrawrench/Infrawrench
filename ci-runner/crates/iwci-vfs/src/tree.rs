//! Values kept by path, for a job's files: their write accounts
//! (`limit::Account`) and their modes (`modes.rs`).
//!
//! Kept as a tree of path components rather than a map of whole paths: a
//! file deep in a tree of long directory names would otherwise hold its
//! whole path, several kilobytes, for a value of a few bytes. Here each
//! file holds its own name and a small node, and the directories above it
//! are shared, so what the tree takes grows with what the job made, which
//! is charged to it (`ENTRY_COST`), not with how deep it made it. Nodes
//! with nothing under them and no value go as soon as they empty.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub struct PathTree<T> {
    root: Node<T>,
}

#[derive(Debug)]
struct Node<T> {
    value: Option<T>,
    children: BTreeMap<OsString, Node<T>>,
}

impl<T> Default for PathTree<T> {
    fn default() -> Self {
        Self {
            root: Node::default(),
        }
    }
}

impl<T> Default for Node<T> {
    fn default() -> Self {
        Self {
            value: None,
            children: BTreeMap::new(),
        }
    }
}

impl<T> Node<T> {
    fn is_empty(&self) -> bool {
        self.value.is_none() && self.children.is_empty()
    }

    /// Calls `f` with each value at or under this node and its path from
    /// here, in path order.
    fn walk<'a>(&'a self, path: &mut PathBuf, f: &mut impl FnMut(&Path, &'a T)) {
        if let Some(value) = &self.value {
            f(path, value);
        }
        for (name, child) in &self.children {
            path.push(name);
            child.walk(path, f);
            path.pop();
        }
    }
}

/// The names along `path`, root and `.` left out.
pub(crate) fn names(path: &Path) -> impl Iterator<Item = &OsStr> {
    path.components().filter_map(|c| match c {
        Component::Normal(n) => Some(n),
        Component::ParentDir => Some(OsStr::new("..")),
        _ => None,
    })
}

impl<P: AsRef<Path>, T> FromIterator<(P, T)> for PathTree<T> {
    fn from_iter<I: IntoIterator<Item = (P, T)>>(iter: I) -> Self {
        let mut tree = Self::default();
        for (path, value) in iter {
            tree.insert(path.as_ref(), value);
        }
        tree
    }
}

impl<T> PathTree<T> {
    fn node(&self, path: &Path) -> Option<&Node<T>> {
        let mut node = &self.root;
        for name in names(path) {
            node = node.children.get(name)?;
        }
        Some(node)
    }

    fn node_mut(&mut self, path: &Path) -> &mut Node<T> {
        let mut node = &mut self.root;
        for name in names(path) {
            node = node.children.entry(name.to_os_string()).or_default();
        }
        node
    }

    /// The value at `path`, if there is one.
    pub fn get(&self, path: &Path) -> Option<&T> {
        self.node(path)?.value.as_ref()
    }

    /// The value at `path`, made with `make` if there is none.
    pub fn get_or_insert_with(&mut self, path: &Path, make: impl FnOnce() -> T) -> &mut T {
        self.node_mut(path).value.get_or_insert_with(make)
    }

    pub fn insert(&mut self, path: &Path, value: T) {
        self.node_mut(path).value = Some(value);
    }

    /// Takes the value at `path`, if any, pruning what it leaves empty.
    pub fn remove(&mut self, path: &Path) -> Option<T> {
        let names: Vec<&OsStr> = names(path).collect();
        fn take<T>(node: &mut Node<T>, names: &[&OsStr]) -> Option<T> {
            let Some((first, rest)) = names.split_first() else {
                return node.value.take();
            };
            let child = node.children.get_mut(*first)?;
            let taken = take(child, rest);
            if child.is_empty() {
                node.children.remove(*first);
            }
            taken
        }
        take(&mut self.root, &names)
    }

    /// Takes the values at and under `path` out as a tree of their own,
    /// rooted where `path` was.
    pub fn detach(&mut self, path: &Path) -> Option<PathTree<T>> {
        let names: Vec<&OsStr> = names(path).collect();
        fn take<T>(node: &mut Node<T>, names: &[&OsStr]) -> Option<Node<T>> {
            let Some((first, rest)) = names.split_first() else {
                return Some(std::mem::take(node));
            };
            if rest.is_empty() {
                return node.children.remove(*first);
            }
            let child = node.children.get_mut(*first)?;
            let taken = take(child, rest);
            if child.is_empty() {
                node.children.remove(*first);
            }
            taken
        }
        take(&mut self.root, &names).map(|root| PathTree { root })
    }

    /// The values at and under `from` now belong at `to`, over any there.
    pub fn rename(&mut self, from: &Path, to: &Path) {
        if from == to {
            return;
        }
        let Some(moving) = self.detach(from) else {
            return;
        };
        fn merge<T>(into: &mut Node<T>, from: Node<T>) {
            if from.value.is_some() {
                into.value = from.value;
            }
            for (name, child) in from.children {
                merge(into.children.entry(name).or_default(), child);
            }
        }
        merge(self.node_mut(to), moving.root);
    }

    /// Calls `f` with each value at or under `path`, and its path relative
    /// to `path` (empty for `path` itself), in path order.
    pub fn for_each_under<'a>(&'a self, path: &Path, mut f: impl FnMut(&Path, &'a T)) {
        if let Some(node) = self.node(path) {
            node.walk(&mut PathBuf::new(), &mut f);
        }
    }

    /// How many values there are.
    pub fn len(&self) -> usize {
        fn count<T>(node: &Node<T>) -> usize {
            usize::from(node.value.is_some()) + node.children.values().map(count).sum::<usize>()
        }
        count(&self.root)
    }

    /// Whether nothing is kept at all.
    pub fn is_empty(&self) -> bool {
        self.root.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::limit::Account;

    fn p(s: &str) -> &Path {
        Path::new(s)
    }

    #[test]
    fn accounts_follow_their_files_and_leave_nothing_behind() {
        let mut a = PathTree::<Arc<Account>>::default();
        a.insert(p("/w/d/a"), Account::new(1));
        a.insert(p("/w/d/e/b"), Account::new(2));
        a.insert(p("/w/c"), Account::new(3));
        assert_eq!(a.len(), 3);
        assert!(a.get(p("/w/d")).is_none());
        assert!(a.get(p("/w/d/a")).is_some());

        // A directory moves with everything under it.
        a.rename(p("/w/d"), p("/x/y"));
        assert!(a.get(p("/w/d/a")).is_none());
        assert!(a.get(p("/x/y/a")).is_some());
        assert!(a.get(p("/x/y/e/b")).is_some());
        // A file renamed over another replaces its account.
        let c = a.get(p("/w/c")).unwrap().clone();
        a.rename(p("/w/c"), p("/x/y/a"));
        assert!(Arc::ptr_eq(a.get(p("/x/y/a")).unwrap(), &c));
        assert_eq!(a.len(), 2);

        assert!(a.remove(p("/x/y/a")).is_some());
        assert!(a.remove(p("/x/y/a")).is_none());
        assert!(a.remove(p("/x/y/e/b")).is_some());
        assert!(a.is_empty(), "{a:?}");

        // Nothing to move: nothing made.
        a.rename(p("/none"), p("/else"));
        assert!(a.is_empty(), "{a:?}");
        let made = a.get_or_insert_with(p("/q/r"), || Account::new(0)).clone();
        assert!(Arc::ptr_eq(
            &made,
            a.get_or_insert_with(p("/q/r"), || Account::new(9))
        ));
    }

    #[test]
    fn values_under_a_path_are_walked_and_detached_by_relative_path() {
        let mut t = PathTree::default();
        t.insert(p("/a"), 1);
        t.insert(p("/a/b/c"), 2);
        t.insert(p("/a/d"), 3);
        t.insert(p("/ab"), 4);
        let mut seen = Vec::new();
        t.for_each_under(p("/a"), |rest, v| seen.push((rest.to_path_buf(), *v)));
        assert_eq!(
            seen,
            [
                (PathBuf::new(), 1),
                (PathBuf::from("b/c"), 2),
                (PathBuf::from("d"), 3)
            ]
        );
        let detached = t.detach(p("/a")).unwrap();
        assert_eq!(detached.get(p("/")), Some(&1));
        assert_eq!(detached.get(p("/b/c")), Some(&2));
        assert_eq!(t.len(), 1);
        assert_eq!(t.get(p("/ab")), Some(&4));
        assert!(t.detach(p("/a")).is_none());
    }
}
