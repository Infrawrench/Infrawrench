//! Which paths of a repository git ignores, as its `.gitignore` files say.
//!
//! The runner and the agent judge a job's new files by the same rules: what
//! a job installs or builds into an ignored path (`node_modules`, `target`,
//! `dist`) is not a change to the repository, so `changes:` never counts it
//! and a machine never sends it back. Only the `.gitignore` files inside the
//! repository count. A job's clone has no `.git/info/exclude`, and the
//! global excludes of whoever runs the runner are no business of a pipeline.
//!
//! The rules are git's, through `gix-ignore` (which `gix` already brings
//! into the tree): the nearest `.gitignore` that has a rule for a path
//! decides it, a later rule in a file beats an earlier one, and git never
//! looks inside an ignored directory, so `!` cannot bring back a file in
//! one.

use std::cell::RefCell;
use std::collections::HashMap;

use bstr::ByteSlice;
use gix_glob::pattern::Case;
use gix_glob::wildmatch::Mode;

/// The ignore rules of one repository, each `.gitignore` read once, when a
/// path first needs it.
pub struct GitIgnore<R> {
    root: String,
    read: R,
    /// Each directory's rules, by its path relative to the root (`""` for
    /// the root itself).
    lists: RefCell<HashMap<String, Vec<gix_glob::Pattern>>>,
}

impl<R: Fn(&str) -> Option<Vec<u8>>> GitIgnore<R> {
    /// The repository at `root`, a clean absolute Unix path. `read` gives a
    /// file's bytes by its Unix path, or `None` when it is not there.
    pub fn new(root: &str, read: R) -> Self {
        GitIgnore {
            root: root.to_owned(),
            read,
            lists: RefCell::default(),
        }
    }

    /// Whether git ignores `path`, a clean absolute Unix path, which is a
    /// directory when `is_dir`. A path is ignored when it, or a directory
    /// above it inside the repository, is. The root itself and paths
    /// outside it never are.
    pub fn ignored(&self, path: &str, is_dir: bool) -> bool {
        let Some(relative) = relative(&self.root, path) else {
            return false;
        };
        let mut end = 0;
        for (i, part) in relative.split('/').enumerate() {
            end += if i == 0 { part.len() } else { part.len() + 1 };
            let last = end == relative.len();
            if self.matched(&relative[..end], !last || is_dir) {
                return true;
            }
        }
        false
    }

    /// Whether the rules that decide `relative` (from the root) ignore it,
    /// not looking at the directories above it.
    fn matched(&self, relative: &str, is_dir: bool) -> bool {
        let mut base = parent(relative);
        loop {
            let within = if base.is_empty() {
                relative
            } else {
                &relative[base.len() + 1..]
            };
            if let Some(ignore) = self.decide(base, within, is_dir) {
                return ignore;
            }
            if base.is_empty() {
                return false;
            }
            base = parent(base);
        }
    }

    /// What the `.gitignore` in `base` says about `within`, a path relative
    /// to `base`: `Some(true)` to ignore it, `Some(false)` for a `!` rule,
    /// `None` when no rule there names it.
    fn decide(&self, base: &str, within: &str, is_dir: bool) -> Option<bool> {
        let mut lists = self.lists.borrow_mut();
        let patterns = lists
            .entry(base.to_owned())
            .or_insert_with(|| self.load(base));
        let path = within.as_bytes().as_bstr();
        let basename = within.rfind('/').map(|p| p + 1);
        patterns
            .iter()
            .rev()
            .find(|p| {
                p.matches_repo_relative_path(
                    path,
                    basename,
                    Some(is_dir),
                    Case::Sensitive,
                    Mode::NO_MATCH_SLASH_LITERAL,
                )
            })
            .map(|p| !p.is_negative())
    }

    fn load(&self, base: &str) -> Vec<gix_glob::Pattern> {
        let file = match (self.root.as_str(), base) {
            ("/", "") => "/.gitignore".to_owned(),
            ("/", base) => format!("/{base}/.gitignore"),
            (root, "") => format!("{root}/.gitignore"),
            (root, base) => format!("{root}/{base}/.gitignore"),
        };
        match (self.read)(&file) {
            Some(bytes) => gix_ignore::parse(&bytes, false)
                .map(|(pattern, _, _)| pattern)
                .collect(),
            None => Vec::new(),
        }
    }
}

/// `path` relative to `root`, when it is below it.
fn relative<'a>(root: &str, path: &'a str) -> Option<&'a str> {
    let rest = if root == "/" {
        path.strip_prefix('/')?
    } else {
        path.strip_prefix(root)?.strip_prefix('/')?
    };
    (!rest.is_empty()).then_some(rest)
}

/// The directory a relative path is in (`""` at the top).
fn parent(relative: &str) -> &str {
    relative.rfind('/').map_or("", |p| &relative[..p])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(files: &[(&str, &str)]) -> GitIgnore<impl Fn(&str) -> Option<Vec<u8>>> {
        let files: HashMap<String, Vec<u8>> = files
            .iter()
            .map(|(p, c)| ((*p).to_owned(), c.as_bytes().to_vec()))
            .collect();
        GitIgnore::new("/app", move |p: &str| files.get(p).cloned())
    }

    #[test]
    fn follows_the_nearest_gitignore_as_git_does() {
        let ig = repo(&[
            (
                "/app/.gitignore",
                "node_modules/\n*.log\n/dist\n!keep.log\n",
            ),
            ("/app/pkg/.gitignore", "!debug.log\ngenerated\n"),
        ]);
        assert!(ig.ignored("/app/node_modules", true));
        assert!(ig.ignored("/app/node_modules/dep/index.js", false));
        assert!(ig.ignored("/app/pkg/node_modules/x.js", false));
        // `node_modules/` names only a directory.
        assert!(!ig.ignored("/app/node_modules", false));
        assert!(ig.ignored("/app/a/b/c.log", false));
        assert!(!ig.ignored("/app/keep.log", false));
        // Anchored to the root's directory.
        assert!(ig.ignored("/app/dist/main.js", false));
        assert!(!ig.ignored("/app/pkg/dist/main.js", false));
        // A deeper file's rules win over the root's.
        assert!(!ig.ignored("/app/pkg/debug.log", false));
        assert!(ig.ignored("/app/pkg/other.log", false));
        assert!(ig.ignored("/app/pkg/generated/a.rs", false));
        assert!(!ig.ignored("/app/generated/a.rs", false));
        assert!(!ig.ignored("/app/src/main.rs", false));
    }

    #[test]
    fn nothing_brings_back_a_file_in_an_ignored_directory() {
        let ig = repo(&[("/app/.gitignore", "build/\n!build/keep.txt\n")]);
        assert!(ig.ignored("/app/build/keep.txt", false));
    }

    #[test]
    fn the_root_and_paths_outside_it_are_never_ignored() {
        let ig = repo(&[("/app/.gitignore", "*\n")]);
        assert!(!ig.ignored("/app", true));
        assert!(!ig.ignored("/root/.cache/x", false));
        assert!(!ig.ignored("/application/x", false));
        assert!(ig.ignored("/app/x", false));
    }

    #[test]
    fn a_repository_at_the_root_of_the_file_system() {
        let files: HashMap<&str, &[u8]> = [("/.gitignore", b"target/\n" as &[u8])].into();
        let ig = GitIgnore::new("/", |p: &str| files.get(p).map(|b| b.to_vec()));
        assert!(ig.ignored("/target/debug/x", false));
        assert!(!ig.ignored("/src/x", false));
    }

    #[test]
    fn each_gitignore_is_read_once() {
        let reads = std::cell::Cell::new(0);
        let ig = GitIgnore::new("/app", |_: &str| {
            reads.set(reads.get() + 1);
            Some(b"*.o\n".to_vec())
        });
        for _ in 0..3 {
            assert!(ig.ignored("/app/a/b.o", false));
        }
        // `/app/.gitignore` and `/app/a/.gitignore`.
        assert_eq!(reads.get(), 2);
    }
}
