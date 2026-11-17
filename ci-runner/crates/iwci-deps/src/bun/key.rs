//! What a task cache key reads of a Bun workspace's lockfile for one
//! project, as [`crate::pnpm`]'s key does for pnpm: the part of the install
//! that project's files can resolve, so another project's dependencies
//! leave its key alone.
//!
//! Only for the isolated linker. It is worked out from the layout the
//! installer plans, without fetching anything: starting at the project's
//! directory, every `node_modules` a file there can resolve through (its
//! own and each ancestor's), every package directory those link to, and
//! the same again from each of those, peer variants included. Hoisted
//! links (`.bun/node_modules`, and the root's `publicHoistPattern` ones)
//! count only for a name that closure already has, as for pnpm.
//!
//! The hoisted linker puts every package of every project in one tree at
//! the root, where any project's files can import any of them, declared or
//! not, so a project there has no part smaller than the whole lockfile:
//! [`KeyIndex::digest`] gives `None`, and the key reads the whole file.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::{
    BunError, BunOptions, Linker, Result, Settings, isolated, linker_of, lockfile_error,
    parse_lockfile,
};

/// A workspace's `bun.lock` planned once, to key any number of its
/// projects with [`KeyIndex::digest`].
pub struct KeyIndex {
    /// `None` for the hoisted linker.
    view: Option<View>,
}

struct View {
    root: PathBuf,
    /// What holds for the whole lockfile.
    whole: String,
    /// Each `node_modules` directory's links: alias to its target, and
    /// whether hoisting made it.
    modules: HashMap<PathBuf, BTreeMap<String, (PathBuf, bool)>>,
    /// Each package directory's package, as its `Debug` form (identity,
    /// resolution and integrity, dependencies, platform fields), and name.
    trees: HashMap<PathBuf, (String, String)>,
}

/// `link` as the `node_modules` directory it is in and the name it has
/// there (`@scope/name` included): `None` for a path with no
/// `node_modules`.
fn split_link(link: &Path) -> Option<(PathBuf, String)> {
    let components: Vec<Component<'_>> = link.components().collect();
    let last = components
        .iter()
        .rposition(|c| c.as_os_str() == "node_modules")?;
    let modules: PathBuf = components[..=last].iter().collect();
    let alias: Vec<String> = components[last + 1..]
        .iter()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!alias.is_empty()).then(|| (modules, alias.join("/")))
}

impl KeyIndex {
    /// Reads the project whose `bun.lock` is in `root` through `read` (a
    /// file's bytes by absolute path, `None` when absent) and plans its
    /// install as `options` would, which must be the options it is
    /// installed with.
    pub fn new(
        read: &dyn Fn(&Path) -> Option<Vec<u8>>,
        root: &Path,
        options: &BunOptions,
    ) -> Result<KeyIndex> {
        let lock_path = root.join("bun.lock");
        let with_path = |error: BunError| match error {
            BunError::Lockfile { message, .. } => BunError::Lockfile {
                path: lock_path.display().to_string(),
                message,
            },
            other => other,
        };
        let text = read(&lock_path).ok_or_else(|| with_path(lockfile_error("not found")))?;
        let text = String::from_utf8(text).map_err(|_| with_path(lockfile_error("not UTF-8")))?;
        let lock = parse_lockfile(&text).map_err(|message| with_path(lockfile_error(message)))?;
        let settings = Settings::read_with(read, root)?;
        if linker_of(&lock, &settings) == Linker::Hoisted {
            return Ok(KeyIndex { view: None });
        }
        let layout = isolated::plan(&lock, root, &settings, options).map_err(with_path)?;
        let mut modules: HashMap<PathBuf, BTreeMap<String, (PathBuf, bool)>> = HashMap::new();
        for (link, target) in &layout.links {
            let Some((dir, alias)) = split_link(link) else {
                continue;
            };
            let hoisted = layout.hoisted_links.contains(link);
            // The first link made at a path is the one the install keeps.
            modules
                .entry(dir)
                .or_default()
                .entry(alias)
                .or_insert_with(|| (target.clone(), hoisted));
        }
        let trees = layout
            .trees
            .iter()
            .map(|(dir, package)| (dir.clone(), (format!("{package:?}"), package.name.clone())))
            .collect();
        let whole = format!(
            "{}\0{}\0{:?}",
            lock.version, lock.config_version, lock.patched_dependencies
        );
        Ok(KeyIndex {
            view: Some(View {
                root: root.to_path_buf(),
                whole,
                modules,
                trees,
            }),
        })
    }

    /// A digest of everything `project` (a directory relative to the
    /// workspace root, `.` for the root) can resolve of the install, or
    /// `None` when the layout gives it no part smaller than the whole (the
    /// hoisted linker).
    pub fn digest(&self, project: &str) -> Option<[u8; 32]> {
        let view = self.view.as_ref()?;
        let start = match project.trim_matches('/') {
            "" | "." => view.root.clone(),
            dir => view.root.join(dir),
        };
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut queue: Vec<PathBuf> = vec![start];
        // (`node_modules` directory, alias, target), relative to the root.
        let mut included: BTreeSet<(PathBuf, String, PathBuf)> = BTreeSet::new();
        let mut names: BTreeSet<String> = BTreeSet::new();
        let mut pending: Vec<(PathBuf, String, PathBuf)> = Vec::new();
        let relative = |path: &Path| {
            path.strip_prefix(&view.root)
                .map(Path::to_path_buf)
                .unwrap_or_else(|_| path.to_path_buf())
        };
        loop {
            while let Some(dir) = queue.pop() {
                if !seen.insert(dir.clone()) {
                    continue;
                }
                if let Some((_, name)) = view.trees.get(&dir) {
                    names.insert(name.clone());
                }
                // What a file in `dir` resolves through: each ancestor's
                // `node_modules`, up to the workspace root.
                for ancestor in dir.ancestors() {
                    if !ancestor.starts_with(&view.root) {
                        break;
                    }
                    let modules = ancestor.join("node_modules");
                    let Some(links) = view.modules.get(&modules) else {
                        continue;
                    };
                    for (alias, (target, hoisted)) in links {
                        let entry = (modules.clone(), alias.clone(), target.clone());
                        if *hoisted {
                            pending.push(entry);
                        } else if included.insert(entry) {
                            names.insert(alias.clone());
                            queue.push(target.clone());
                        }
                    }
                }
            }
            // A hoisted name counts once the closure has it, which can
            // bring in more.
            let before = included.len();
            pending.retain(|(modules, alias, target)| {
                if !names.contains(alias) {
                    return true;
                }
                if included.insert((modules.clone(), alias.clone(), target.clone())) {
                    queue.push(target.clone());
                }
                false
            });
            if included.len() == before && queue.is_empty() {
                break;
            }
        }

        let mut hash = Sha256::new();
        let mut field = |label: &str, value: &str| {
            hash.update(label.as_bytes());
            hash.update([0]);
            hash.update(value.as_bytes());
            hash.update([0]);
        };
        field("iwci bun closure", "1");
        field("lockfile", &view.whole);
        let mut packages: BTreeSet<PathBuf> = BTreeSet::new();
        for (modules, alias, target) in &included {
            field("modules", &relative(modules).display().to_string());
            field("alias", alias);
            field("target", &relative(target).display().to_string());
            if view.trees.contains_key(target) {
                packages.insert(target.clone());
            }
        }
        for dir in packages {
            field("package", &relative(&dir).display().to_string());
            field("is", &view.trees[&dir].0);
        }
        Some(hash.finalize().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE: &str = include_str!("fixtures/workspace/bun.lock");

    fn index(lock: &str, bunfig: Option<&str>) -> KeyIndex {
        let mut files: HashMap<PathBuf, Vec<u8>> = HashMap::new();
        files.insert("/w/bun.lock".into(), lock.as_bytes().to_vec());
        if let Some(bunfig) = bunfig {
            files.insert("/w/bunfig.toml".into(), bunfig.as_bytes().to_vec());
        }
        KeyIndex::new(
            &|path| files.get(path).cloned(),
            Path::new("/w"),
            &BunOptions::default(),
        )
        .unwrap()
    }

    /// The fixture with `ms` (only `packages/b` depends on it) at another
    /// version.
    fn ms_bumped() -> String {
        let bumped = WORKSPACE
            .replace("\"ms\": \"2.1.3\"", "\"ms\": \"2.1.2\"")
            .replace(
                "[\"ms@2.1.3\", \"\", {}, \"sha512-6Flz",
                "[\"ms@2.1.2\", \"\", {}, \"sha512-sGkP",
            );
        assert_ne!(bumped, WORKSPACE);
        bumped
    }

    #[test]
    fn another_projects_dependency_leaves_the_key_alone() {
        let before = index(WORKSPACE, None);
        let after = index(&ms_bumped(), None);
        assert_eq!(before.digest("packages/a"), after.digest("packages/a"));
        assert_eq!(before.digest("."), after.digest("."));
        assert_ne!(before.digest("packages/b"), after.digest("packages/b"));
        assert!(before.digest("packages/a").is_some());
    }

    #[test]
    fn a_linked_projects_dependency_changes_the_key() {
        // `packages/b` links to `packages/a`, whose `is-odd` changes.
        let changed = WORKSPACE.replace("sha512-CQpnWPrDwmP1", "sha512-CQpnWPrDwmP2");
        let before = index(WORKSPACE, None);
        let after = index(&changed, None);
        assert_ne!(before.digest("packages/a"), after.digest("packages/a"));
        assert_ne!(before.digest("packages/b"), after.digest("packages/b"));
        assert_eq!(before.digest("."), after.digest("."));
    }

    #[test]
    fn the_roots_dependencies_change_every_key() {
        let changed = WORKSPACE.replace("sha512-41Cifkg6", "sha512-41Cifkg7");
        let before = index(WORKSPACE, None);
        let after = index(&changed, None);
        for project in [".", "packages/a", "packages/b"] {
            assert_ne!(before.digest(project), after.digest(project), "{project}");
        }
    }

    #[test]
    fn the_hoisted_linker_has_no_part_smaller_than_the_whole() {
        let hoisted = index(WORKSPACE, Some("[install]\nlinker = \"hoisted\"\n"));
        assert_eq!(hoisted.digest("packages/a"), None);
    }

    #[test]
    fn links_split_at_their_node_modules() {
        assert_eq!(
            split_link(Path::new("/w/node_modules/.bun/node_modules/@scope/x")),
            Some((
                PathBuf::from("/w/node_modules/.bun/node_modules"),
                "@scope/x".to_string()
            ))
        );
        assert_eq!(split_link(Path::new("/w/src/x")), None);
    }
}
