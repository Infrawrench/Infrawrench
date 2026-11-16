//! The write accounts of a job's files (`limit::Account`), by path.
//!
//! Kept as a tree of path components rather than a map of whole paths: a
//! file deep in a tree of long directory names would otherwise hold its
//! whole path, several kilobytes, for an account of a few bytes. Here each
//! file holds its own name and a small node, and the directories above it
//! are shared, so what the accounts take grows with what the job made,
//! which is charged to it (`ENTRY_COST`), not with how deep it made it.
//! Nodes with nothing under them and no account go as soon as they empty.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path};
use std::sync::Arc;

use crate::limit::Account;

#[derive(Debug, Default)]
pub(crate) struct Accounts {
    root: Node,
}

#[derive(Debug, Default)]
struct Node {
    account: Option<Arc<Account>>,
    children: BTreeMap<OsString, Node>,
}

impl Node {
    fn is_empty(&self) -> bool {
        self.account.is_none() && self.children.is_empty()
    }
}

/// The names along `path`, root and `.` left out.
fn names(path: &Path) -> impl Iterator<Item = &OsStr> {
    path.components().filter_map(|c| match c {
        Component::Normal(n) => Some(n),
        Component::ParentDir => Some(OsStr::new("..")),
        _ => None,
    })
}

impl Accounts {
    #[cfg(test)]
    pub(crate) fn get(&self, path: &Path) -> Option<&Arc<Account>> {
        let mut node = &self.root;
        for name in names(path) {
            node = node.children.get(name)?;
        }
        node.account.as_ref()
    }

    fn node_mut(&mut self, path: &Path) -> &mut Node {
        let mut node = &mut self.root;
        for name in names(path) {
            node = node.children.entry(name.to_os_string()).or_default();
        }
        node
    }

    /// The account at `path`, made with `make` if there is none.
    pub(crate) fn get_or_insert_with(
        &mut self,
        path: &Path,
        make: impl FnOnce() -> Arc<Account>,
    ) -> Arc<Account> {
        self.node_mut(path).account.get_or_insert_with(make).clone()
    }

    pub(crate) fn insert(&mut self, path: &Path, account: Arc<Account>) {
        self.node_mut(path).account = Some(account);
    }

    /// Takes the account at `path`, if any, pruning what it leaves empty.
    pub(crate) fn remove(&mut self, path: &Path) -> Option<Arc<Account>> {
        let names: Vec<&OsStr> = names(path).collect();
        fn take(node: &mut Node, names: &[&OsStr]) -> Option<Arc<Account>> {
            let Some((first, rest)) = names.split_first() else {
                return node.account.take();
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

    /// Detaches the node at `path` with everything under it.
    fn detach(&mut self, path: &Path) -> Option<Node> {
        let names: Vec<&OsStr> = names(path).collect();
        fn take(node: &mut Node, names: &[&OsStr]) -> Option<Node> {
            let (first, rest) = names.split_first()?;
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
        take(&mut self.root, &names)
    }

    /// The accounts at and under `from` now belong at `to`, over any there.
    pub(crate) fn rename(&mut self, from: &Path, to: &Path) {
        if from == to {
            return;
        }
        let Some(moving) = self.detach(from) else {
            return;
        };
        fn merge(into: &mut Node, from: Node) {
            if from.account.is_some() {
                into.account = from.account;
            }
            for (name, child) in from.children {
                merge(into.children.entry(name).or_default(), child);
            }
        }
        merge(self.node_mut(to), moving);
    }

    /// How many accounts there are, for tests.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        fn count(node: &Node) -> usize {
            usize::from(node.account.is_some()) + node.children.values().map(count).sum::<usize>()
        }
        count(&self.root)
    }

    /// Whether nothing is kept at all, for tests.
    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.root.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> &Path {
        Path::new(s)
    }

    #[test]
    fn accounts_follow_their_files_and_leave_nothing_behind() {
        let mut a = Accounts::default();
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
        let made = a.get_or_insert_with(p("/q/r"), || Account::new(0));
        assert!(Arc::ptr_eq(
            &made,
            &a.get_or_insert_with(p("/q/r"), || Account::new(9))
        ));
    }
}
