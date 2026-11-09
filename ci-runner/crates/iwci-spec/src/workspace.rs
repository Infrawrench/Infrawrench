//! The repository's JavaScript workspace: which directories are packages,
//! what each is called, which scripts it has and which other packages of
//! the workspace it depends on. `packages:` jobs expand over it.
//!
//! The packages are the ones `pnpm-workspace.yaml` lists (its `packages:`
//! globs, `!` excluding), or, without that file, the root `package.json`'s
//! `workspaces` (npm, Yarn and Bun). The root package itself is not one of
//! them. A dependency is a workspace dependency when its name is another
//! package's, whatever version range it gives, as Turborepo reads them.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

/// The most packages a workspace may have.
pub const MAX_PACKAGES: usize = 1024;
/// The most directories discovery visits looking for them.
const MAX_DIRS: usize = 200_000;

/// The files of a commit, relative to the repository root.
pub trait RepoFiles {
    fn read(&self, path: &str) -> Option<Vec<u8>>;
    /// The names in a directory (`""` is the root), and whether each is a
    /// directory. Symlinks are neither followed nor listed as directories.
    fn list(&self, dir: &str) -> Vec<(String, bool)>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Package {
    /// Relative to the repository root, without a trailing `/`.
    pub dir: String,
    /// `name` from its `package.json`, or the directory when it has none.
    pub name: String,
    /// Script name to command.
    pub scripts: BTreeMap<String, String>,
    /// The directories of the workspace packages it depends on.
    pub deps: Vec<String>,
    /// The names directly in its directory, files and directories alike.
    pub entries: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct WorkspacePackages {
    /// Sorted by directory.
    pub packages: Vec<Package>,
}

impl WorkspacePackages {
    pub fn get(&self, dir: &str) -> Option<&Package> {
        self.packages
            .binary_search_by(|p| p.dir.as_str().cmp(dir))
            .ok()
            .map(|i| &self.packages[i])
    }
}

#[derive(Deserialize, Default)]
struct PnpmWorkspace {
    #[serde(default)]
    packages: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    scripts: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    dependencies: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    dev_dependencies: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    optional_dependencies: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    peer_dependencies: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    workspaces: Option<Workspaces>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Workspaces {
    List(Vec<String>),
    Object {
        #[serde(default)]
        packages: Vec<String>,
    },
}

/// The workspace's packages, `None` when the repository declares no
/// workspace, or why it could not be read.
pub fn discover(files: &dyn RepoFiles) -> Result<Option<WorkspacePackages>, String> {
    let globs = if let Some(bytes) = files.read("pnpm-workspace.yaml") {
        let ws: PnpmWorkspace =
            serde_yaml_ng::from_slice(&bytes).map_err(|e| format!("pnpm-workspace.yaml: {e}"))?;
        ws.packages
    } else {
        let Some(bytes) = files.read("package.json") else {
            return Ok(None);
        };
        let root: Manifest =
            serde_json::from_slice(&bytes).map_err(|e| format!("package.json: {e}"))?;
        match root.workspaces {
            None => return Ok(None),
            Some(Workspaces::List(g)) | Some(Workspaces::Object { packages: g }) => g,
        }
    };
    // Patterns as pnpm writes them: `./apps/*`, `apps/**/`, `!**/test/**`.
    let patterns: Vec<String> = globs
        .iter()
        .map(|g| {
            let (neg, body) = match g.strip_prefix('!') {
                Some(b) => ("!", b),
                None => ("", g.as_str()),
            };
            let body = body.trim_start_matches("./").trim_end_matches('/');
            format!("{neg}{body}")
        })
        .filter(|g| !g.is_empty() && g != "!")
        .collect();
    for p in &patterns {
        crate::glob::check_filter(p).map_err(|e| format!("workspace packages: {e}"))?;
    }
    if patterns.iter().all(|p| p.starts_with('!')) {
        return Ok(Some(WorkspacePackages::default()));
    }

    // Every directory with a package.json that the patterns let through,
    // never inside node_modules or a hidden directory.
    let mut found: Vec<(String, Manifest, BTreeSet<String>)> = Vec::new();
    let mut stack = vec![String::new()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        visited += 1;
        if visited > MAX_DIRS {
            return Err(format!(
                "the repository has more than {MAX_DIRS} directories to look for workspace packages in"
            ));
        }
        let children = files.list(&dir);
        let entries: BTreeSet<String> = children.iter().map(|(n, _)| n.clone()).collect();
        if !dir.is_empty()
            && entries.contains("package.json")
            && crate::glob::filter_matches(&patterns, &dir)
        {
            let path = format!("{dir}/package.json");
            let bytes = files.read(&path).unwrap_or_default();
            let manifest: Manifest =
                serde_json::from_slice(&bytes).map_err(|e| format!("{path}: {e}"))?;
            found.push((dir.clone(), manifest, entries.clone()));
            if found.len() > MAX_PACKAGES {
                return Err(format!(
                    "the workspace has more than {MAX_PACKAGES} packages"
                ));
            }
        }
        for (name, is_dir) in children {
            if is_dir && name != "node_modules" && !name.starts_with('.') {
                stack.push(if dir.is_empty() {
                    name
                } else {
                    format!("{dir}/{name}")
                });
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));

    let mut by_name: HashMap<String, String> = HashMap::new();
    for (dir, manifest, _) in &found {
        let name = manifest.name.clone().unwrap_or_else(|| dir.clone());
        if let Some(other) = by_name.insert(name.clone(), dir.clone()) {
            return Err(format!(
                "two workspace packages are named `{name}`: `{other}` and `{dir}`"
            ));
        }
    }
    let packages = found
        .into_iter()
        .map(|(dir, m, entries)| {
            let deps: BTreeSet<String> = m
                .dependencies
                .keys()
                .chain(m.dev_dependencies.keys())
                .chain(m.optional_dependencies.keys())
                .chain(m.peer_dependencies.keys())
                .filter_map(|n| by_name.get(n))
                .filter(|d| **d != dir)
                .cloned()
                .collect();
            Package {
                name: m.name.unwrap_or_else(|| dir.clone()),
                scripts: m
                    .scripts
                    .into_iter()
                    .map(|(k, v)| (k, v.as_str().unwrap_or_default().to_string()))
                    .collect(),
                deps: deps.into_iter().collect(),
                entries,
                dir,
            }
        })
        .collect();
    Ok(Some(WorkspacePackages { packages }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Files(BTreeMap<String, String>);

    impl RepoFiles for Files {
        fn read(&self, path: &str) -> Option<Vec<u8>> {
            self.0.get(path).map(|s| s.as_bytes().to_vec())
        }
        fn list(&self, dir: &str) -> Vec<(String, bool)> {
            let prefix = if dir.is_empty() {
                String::new()
            } else {
                format!("{dir}/")
            };
            let mut out: BTreeMap<String, bool> = BTreeMap::new();
            for path in self.0.keys() {
                if let Some(rest) = path.strip_prefix(&prefix) {
                    match rest.split_once('/') {
                        Some((d, _)) => out.insert(d.to_string(), true),
                        None => out.insert(rest.to_string(), false),
                    };
                }
            }
            out.into_iter().collect()
        }
    }

    fn files(list: &[(&str, &str)]) -> Files {
        Files(
            list.iter()
                .map(|(p, c)| (p.to_string(), c.to_string()))
                .collect(),
        )
    }

    #[test]
    fn pnpm_workspace_packages_and_their_dependencies() {
        let ws = discover(&files(&[
            (
                "pnpm-workspace.yaml",
                "packages:\n  - ./packages/*\n  - apps/**/\n  - '!apps/legacy'\n",
            ),
            ("package.json", r#"{"name":"root"}"#),
            (
                "packages/core/package.json",
                r#"{"name":"@x/core","scripts":{"build":"tsc"}}"#,
            ),
            ("packages/core/tsconfig.json", "{}"),
            (
                "packages/ui/package.json",
                r#"{"name":"@x/ui","dependencies":{"@x/core":"workspace:*","react":"19"}}"#,
            ),
            (
                "apps/web/package.json",
                r#"{"name":"web","devDependencies":{"@x/ui":"^1.0.0"},"peerDependencies":{"@x/core":"*"}}"#,
            ),
            ("apps/legacy/package.json", r#"{"name":"legacy"}"#),
            ("apps/web/node_modules/@x/ui/package.json", r#"{"name":"@x/ui"}"#),
            ("packages/.hidden/package.json", r#"{"name":"hidden"}"#),
            ("tools/package.json", r#"{"name":"tools"}"#),
        ]))
        .unwrap()
        .unwrap();
        let dirs: Vec<&str> = ws.packages.iter().map(|p| p.dir.as_str()).collect();
        assert_eq!(dirs, ["apps/web", "packages/core", "packages/ui"]);
        assert_eq!(
            ws.get("apps/web").unwrap().deps,
            ["packages/core", "packages/ui"]
        );
        assert_eq!(ws.get("packages/ui").unwrap().deps, ["packages/core"]);
        let core = ws.get("packages/core").unwrap();
        assert_eq!(core.scripts["build"], "tsc");
        assert!(core.entries.contains("tsconfig.json"));
    }

    #[test]
    fn package_json_workspaces_and_no_workspace() {
        let ws = discover(&files(&[
            ("package.json", r#"{"workspaces":{"packages":["libs/*"]}}"#),
            ("libs/a/package.json", r#"{}"#),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(
            ws.packages[0].name, "libs/a",
            "a nameless package goes by its directory"
        );
        assert!(
            discover(&files(&[("package.json", r#"{"name":"solo"}"#)]))
                .unwrap()
                .is_none()
        );
        assert!(discover(&files(&[])).unwrap().is_none());
    }

    #[test]
    fn duplicate_names_are_an_error() {
        let err = discover(&files(&[
            ("pnpm-workspace.yaml", "packages: ['p/*']"),
            ("p/a/package.json", r#"{"name":"same"}"#),
            ("p/b/package.json", r#"{"name":"same"}"#),
        ]))
        .unwrap_err();
        assert!(
            err.contains("two workspace packages are named `same`"),
            "{err}"
        );
    }
}
