//! What a task cache key reads of a pnpm workspace's lockfile for one
//! project: the part of the install that project's files can resolve
//! through, rather than the whole file, so a dependency added to or removed
//! from one project leaves every unrelated project's key as it was.
//!
//! A file in a project resolves a bare import through its own
//! `node_modules`, then each ancestor directory's, up to the workspace root.
//! The importers it can reach are therefore the project itself, every
//! project at an ancestor directory (the root, `.`, always), and the
//! projects those `link:` to, whose own `node_modules` resolution follows
//! the link into. From those importers the key takes:
//!
//! - each importer's dependency lists, as the lockfile has them;
//! - every snapshot their dependencies reach, through optional ones skipped
//!   for the platform too, with its package's metadata (version,
//!   resolution and integrity, platform fields);
//! - the hoisting decision for every name that closure contains. Hoisting
//!   is decided over the whole install, so another project's dependency can
//!   change which version of a name sits in `.pnpm/node_modules`, where a
//!   package's undeclared imports land: a name the closure has is keyed on
//!   what it hoists to;
//! - what holds for the whole lockfile: its version, its
//!   `patchedDependencies`, `injectWorkspacePackages` and
//!   `integrityTarget`.
//!
//! Left out: a hoisted name that nothing in the closure is called or
//! depends on. A package that imports such a name without declaring it
//! works only because an unrelated project installs it, and would already
//! fail in an install limited to its project (`only:`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

use sha2::{Digest, Sha256};

use super::hoist::{HoistKind, HoistTarget};
use super::{
    DepRef, Lockfile, Plan, PnpmError, PnpmOptions, Result, WorkspaceSettings, importer_deps,
    importer_dir, link_target_id, normalise_importer_id, parse_lockfile, snapshot_deps,
};

/// A workspace's lockfile parsed once, with the install's hoisting worked
/// out, to key any number of its projects with [`KeyIndex::digest`].
pub struct KeyIndex {
    lockfile: Lockfile,
    include_dev: bool,
    /// Every hoisted name, with where each of its links points.
    hoisted: BTreeMap<String, Vec<(HoistKind, HoistTarget)>>,
}

impl KeyIndex {
    /// Reads the workspace whose `pnpm-lock.yaml` is in `root` through
    /// `read` (a file's bytes by absolute path, `None` when absent), and
    /// works out the hoisting of the install `options` describe, which
    /// must be the options the workspace is installed with.
    pub fn new(
        read: &dyn Fn(&Path) -> Option<Vec<u8>>,
        root: &Path,
        options: &PnpmOptions,
    ) -> Result<KeyIndex> {
        let lock_path = root.join("pnpm-lock.yaml");
        let lock_name = lock_path.display().to_string();
        let error = |message: &str| PnpmError::Lockfile {
            path: lock_name.clone(),
            message: message.to_string(),
        };
        let text = read(&lock_path).ok_or_else(|| error("not found"))?;
        let text = String::from_utf8(text).map_err(|_| error("not UTF-8"))?;
        let lockfile = parse_lockfile(&text)?;
        let settings = WorkspaceSettings::read_with(read, root)?;
        let hoisted = {
            let plan = Plan::build(&lockfile, &settings, options)?;
            let mut names = BTreeMap::new();
            for id in &plan.importers {
                let dir = importer_dir(root, id)?;
                if let Some(bytes) = read(&dir.join("package.json"))
                    && let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes)
                    && let Some(name) = manifest.get("name").and_then(|name| name.as_str())
                {
                    names.insert(id.to_string(), name.to_string());
                }
            }
            plan.hoist(&lockfile, &settings, options, &names)
        };
        let mut by_alias: BTreeMap<String, Vec<(HoistKind, HoistTarget)>> = BTreeMap::new();
        for hoisted in hoisted {
            by_alias
                .entry(hoisted.alias)
                .or_default()
                .push((hoisted.kind, hoisted.target));
        }
        Ok(KeyIndex {
            lockfile,
            include_dev: options.include_dev,
            hoisted: by_alias,
        })
    }

    /// The importers a file in `project` (a directory relative to the
    /// workspace root, `.` for the root) can resolve through, sorted.
    pub fn importers(&self, project: &str) -> Vec<String> {
        let project = normalise_importer_id(project);
        let importers = &self.lockfile.importers;
        let mut selected: BTreeSet<&str> = BTreeSet::new();
        let mut dir = project.as_str();
        loop {
            if let Some((key, _)) = importers.get_key_value(dir) {
                selected.insert(key.as_str());
            }
            if dir == "." {
                break;
            }
            dir = dir.rsplit_once('/').map_or(".", |(parent, _)| parent);
        }
        let mut queue: Vec<&str> = selected.iter().copied().collect();
        while let Some(id) = queue.pop() {
            for (alias, reference) in importer_deps(&importers[id], self.include_dev) {
                if let DepRef::Link(path) = DepRef::parse(alias, reference)
                    && let Some(target) = link_target_id(id, &path)
                    && let Some((key, _)) = importers.get_key_value(target.as_str())
                    && selected.insert(key.as_str())
                {
                    queue.push(key.as_str());
                }
            }
        }
        selected.into_iter().map(str::to_string).collect()
    }

    /// A digest of everything `project` can resolve of the install (see
    /// the module documentation).
    pub fn digest(&self, project: &str) -> [u8; 32] {
        let lockfile = &self.lockfile;
        let importers = self.importers(project);
        let mut hash = Sha256::new();
        let mut field = |label: &str, value: &str| {
            hash.update(label.as_bytes());
            hash.update([0]);
            hash.update(value.as_bytes());
            hash.update([0]);
        };
        field("iwci pnpm closure", "1");
        field("version", &lockfile.version);
        field(
            "inject",
            if lockfile.inject_workspace_packages {
                "true"
            } else {
                "false"
            },
        );
        field("patched", &format!("{:?}", lockfile.patched_dependencies));
        if lockfile.integrity_pins_tar {
            field("integrity target", "tar");
        }

        let mut names: BTreeSet<&str> = BTreeSet::new();
        let mut queue: VecDeque<String> = VecDeque::new();
        for id in &importers {
            let importer = &lockfile.importers[id];
            field("importer", id);
            field("dependencies", &format!("{:?}", importer.dependencies));
            if self.include_dev {
                field(
                    "devDependencies",
                    &format!("{:?}", importer.dev_dependencies),
                );
            }
            field(
                "optionalDependencies",
                &format!("{:?}", importer.optional_dependencies),
            );
            for (alias, reference) in importer_deps(importer, self.include_dev) {
                names.insert(alias);
                if let DepRef::Snapshot(dep_path) = DepRef::parse(alias, reference) {
                    queue.push_back(dep_path);
                }
            }
        }

        // Every snapshot the importers reach, as hoisting's graph has them:
        // through optional ones a platform skips too.
        let mut reachable: BTreeSet<&str> = BTreeSet::new();
        let mut missing: BTreeSet<String> = BTreeSet::new();
        while let Some(dep_path) = queue.pop_front() {
            let Some((key, snapshot)) = lockfile.snapshots.get_key_value(dep_path.as_str()) else {
                // The install fails on it; the key still says it was named.
                missing.insert(dep_path);
                continue;
            };
            if !reachable.insert(key.as_str()) {
                continue;
            }
            for (alias, reference) in snapshot_deps(snapshot) {
                names.insert(alias.as_str());
                if let DepRef::Snapshot(child) = DepRef::parse(alias, reference) {
                    queue.push_back(child);
                }
            }
        }
        for dep_path in &reachable {
            field("snapshot", dep_path);
            field("wiring", &format!("{:?}", lockfile.snapshots[*dep_path]));
            match lockfile.package(dep_path) {
                Some(package) => {
                    names.insert(package.name.as_str());
                    field("package", &format!("{package:?}"));
                }
                None => field("package", ""),
            }
        }
        for dep_path in &missing {
            field("missing", dep_path);
        }

        for name in names {
            if let Some(links) = self.hoisted.get(name) {
                field("hoisted", name);
                field("to", &format!("{links:?}"));
            }
        }
        hash.finalize().into()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::*;

    const INTEGRITY: &str = "sha512-AAAA";

    /// A workspace of `files` (relative to `/w`), read the way the
    /// scheduler reads a checkout.
    fn index(files: &[(&str, &str)]) -> KeyIndex {
        let files: HashMap<PathBuf, Vec<u8>> = files
            .iter()
            .map(|(path, text)| (Path::new("/w").join(path), text.as_bytes().to_vec()))
            .collect();
        KeyIndex::new(
            &|path| files.get(path).cloned(),
            Path::new("/w"),
            &PnpmOptions::default(),
        )
        .unwrap()
    }

    fn package(name: &str, version: &str) -> String {
        format!("  '{name}@{version}':\n    resolution: {{integrity: {INTEGRITY}}}\n")
    }

    /// A lockfile with the root, `app` (which links to `lib`), `lib` and an
    /// unrelated `other`, where `other` depends on `other_deps`.
    fn lockfile(other_deps: &[(&str, &str)], lib_version: &str) -> String {
        let mut text = String::from("lockfileVersion: '9.0'\n\nimporters:\n\n");
        text.push_str("  .:\n    devDependencies:\n      prettier:\n        specifier: ^3.0.0\n        version: 3.0.0\n\n");
        text.push_str("  app:\n    dependencies:\n      lib:\n        specifier: workspace:*\n        version: link:../lib\n      react:\n        specifier: ^18.0.0\n        version: 18.0.0\n\n");
        text.push_str(&format!(
            "  lib:\n    dependencies:\n      left-pad:\n        specifier: ^1.0.0\n        version: {lib_version}\n\n"
        ));
        if other_deps.is_empty() {
            text.push_str("  other: {}\n");
        } else {
            text.push_str("  other:\n    dependencies:\n");
            for (name, version) in other_deps {
                text.push_str(&format!(
                    "      {name}:\n        specifier: '*'\n        version: {version}\n"
                ));
            }
        }
        text.push_str("\npackages:\n\n");
        let mut packages: BTreeMap<String, ()> = BTreeMap::new();
        for (name, version) in [
            ("prettier", "3.0.0"),
            ("react", "18.0.0"),
            ("loose-envify", "1.4.0"),
            ("left-pad", lib_version),
        ]
        .into_iter()
        .chain(other_deps.iter().copied())
        {
            packages.insert(format!("{name}@{version}"), ());
        }
        for key in packages.keys() {
            let (name, version) = key.rsplit_once('@').unwrap();
            text.push_str(&package(name, version));
            text.push('\n');
        }
        text.push_str("snapshots:\n\n");
        for key in packages.keys() {
            if key == "react@18.0.0" {
                text.push_str("  react@18.0.0:\n    dependencies:\n      loose-envify: 1.4.0\n\n");
            } else {
                text.push_str(&format!("  {key}: {{}}\n\n"));
            }
        }
        text
    }

    fn workspace(lock: &str) -> KeyIndex {
        index(&[
            ("pnpm-lock.yaml", lock),
            ("package.json", r#"{"name":"root"}"#),
            ("app/package.json", r#"{"name":"app"}"#),
            ("lib/package.json", r#"{"name":"lib"}"#),
            ("other/package.json", r#"{"name":"other"}"#),
        ])
    }

    #[test]
    fn a_project_reaches_its_links_and_ancestors() {
        let index = workspace(&lockfile(&[], "1.3.0"));
        assert_eq!(index.importers("app"), [".", "app", "lib"]);
        assert_eq!(index.importers("app/src/deep"), [".", "app", "lib"]);
        assert_eq!(index.importers("other"), [".", "other"]);
        assert_eq!(index.importers("."), ["."]);
        assert_eq!(index.importers("not-a-project"), ["."]);
    }

    #[test]
    fn another_projects_dependencies_leave_the_key_alone() {
        let before = workspace(&lockfile(&[("chalk", "5.0.0")], "1.3.0"));
        let removed = workspace(&lockfile(&[], "1.3.0"));
        let bumped = workspace(&lockfile(&[("chalk", "5.1.0")], "1.3.0"));
        assert_eq!(before.digest("app"), removed.digest("app"));
        assert_eq!(before.digest("app"), bumped.digest("app"));
        assert_ne!(before.digest("other"), removed.digest("other"));
        assert_ne!(before.digest("other"), bumped.digest("other"));
    }

    #[test]
    fn a_linked_projects_dependencies_change_the_key() {
        let before = workspace(&lockfile(&[], "1.3.0"));
        let after = workspace(&lockfile(&[], "1.3.1"));
        assert_ne!(before.digest("app"), after.digest("app"));
        assert_ne!(before.digest("lib"), after.digest("lib"));
        assert_eq!(before.digest("other"), after.digest("other"));
    }

    #[test]
    fn the_roots_dependencies_change_every_key() {
        let before = workspace(&lockfile(&[], "1.3.0"));
        let after = workspace(&lockfile(&[], "1.3.0").replace("3.0.0", "3.0.1"));
        for project in ["app", "lib", "other", "."] {
            assert_ne!(before.digest(project), after.digest(project), "{project}");
        }
    }

    #[test]
    fn a_hoisted_name_in_the_closure_is_keyed_on_its_version() {
        // `other` depending on a different `loose-envify` directly makes its
        // version the hoisted one (depth 0 beats react's depth 1), which is
        // what an undeclared `loose-envify` import inside `app`'s closure
        // now resolves to.
        let before = workspace(&lockfile(&[], "1.3.0"));
        let after = workspace(&lockfile(&[("loose-envify", "1.3.0")], "1.3.0"));
        assert_ne!(before.digest("app"), after.digest("app"));
        // `lib` never reaches `loose-envify`.
        assert_eq!(before.digest("lib"), after.digest("lib"));
    }

    #[test]
    fn a_boot_document_leaves_every_key_alone() {
        // What pnpm version a project pins installs nothing a job resolves.
        let lock = lockfile(&[("chalk", "5.0.0")], "1.3.0");
        let plain = workspace(&lock);
        let booted = workspace(&format!("{}{lock}", crate::pnpm::lockfile::BOOT_DOCUMENT));
        let bumped = workspace(&format!(
            "{}{lock}",
            crate::pnpm::lockfile::BOOT_DOCUMENT.replace("12.4.1", "12.5.0")
        ));
        for project in ["app", "lib", "other", "."] {
            assert_eq!(plain.digest(project), booted.digest(project), "{project}");
            assert_eq!(plain.digest(project), bumped.digest(project), "{project}");
        }
    }

    #[test]
    fn a_dependency_moved_between_groups_is_a_change() {
        let lock = lockfile(&[], "1.3.0");
        let moved = lock.replace(
            "  app:\n    dependencies:\n      lib:\n        specifier: workspace:*\n        version: link:../lib\n      react:",
            "  app:\n    dependencies:\n      lib:\n        specifier: workspace:*\n        version: link:../lib\n    devDependencies:\n      react:",
        );
        assert_ne!(lock, moved);
        assert_ne!(
            workspace(&lock).digest("app"),
            workspace(&moved).digest("app")
        );
    }

    #[test]
    fn the_repository_lockfile_keys_each_project() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let Ok(root) = root.canonicalize() else {
            return;
        };
        if !root.join("pnpm-lock.yaml").is_file() {
            return;
        }
        let read = |path: &Path| std::fs::read(path).ok();
        let started = std::time::Instant::now();
        let index = KeyIndex::new(&read, &root, &PnpmOptions::default()).unwrap();
        let parsed = started.elapsed();
        let ids: Vec<String> = index.lockfile.importers.keys().cloned().collect();
        let started = std::time::Instant::now();
        let digests: BTreeSet<[u8; 32]> = ids.iter().map(|id| index.digest(id)).collect();
        eprintln!(
            "{} importers: parsed and hoisted in {parsed:?}, keyed in {:?}",
            ids.len(),
            started.elapsed()
        );
        // Projects with different dependencies get different keys.
        assert!(
            digests.len() > ids.len() / 2,
            "{} of {}",
            digests.len(),
            ids.len()
        );
    }
}
