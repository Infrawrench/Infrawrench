//! `pnpm-lock.yaml`, read into one shape for every supported format.
//!
//! The format reference is pnpm's `lockfile/types` package. Format 9 (pnpm
//! 9 to 11) splits each package into `packages` (what to fetch: resolution
//! and platform fields, keyed by `name@version`) and `snapshots` (how it is
//! wired: dependencies, keyed by the full dependency path with patch and
//! peer groups). Format 6 (pnpm 8) has one `packages` map keyed by
//! `/`-prefixed dependency paths that carries both; it is normalised here
//! into the format 9 shape so the installer only knows one.

use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;

use super::PnpmError;
use super::dep_path::{ref_to_relative, remove_suffix, split_name_version};

/// A parsed lockfile.
#[derive(Debug, Clone, Default)]
pub struct Lockfile {
    /// `lockfileVersion` as written (`9.0`, `6.0`).
    pub version: String,
    /// Workspace projects by directory relative to the lockfile (`.` is the
    /// root).
    pub importers: BTreeMap<String, Importer>,
    /// Package metadata keyed by `name@version`.
    pub packages: HashMap<String, Package>,
    /// Wiring keyed by dependency path.
    pub snapshots: HashMap<String, Snapshot>,
    /// `patchedDependencies`: selector (`name@version`, `name`) to the
    /// patch's hash, plus its path when the lockfile records one (format 6
    /// and pnpm 9's format 9 do; pnpm 10 and later keep paths in
    /// `pnpm-workspace.yaml`).
    pub patched_dependencies: BTreeMap<String, PatchedDependency>,
    /// `settings.injectWorkspacePackages`, which turns workspace links
    /// into copies (`file:` dependencies). Not supported by the installer.
    pub inject_workspace_packages: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchedDependency {
    pub hash: String,
    pub path: Option<String>,
}

/// One workspace project's direct dependencies: alias to reference, where
/// a reference is a version (`1.2.3(peer@1.0.0)`), a whole dependency path
/// (an npm alias) or `link:<relative path>`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Importer {
    pub dependencies: BTreeMap<String, String>,
    pub dev_dependencies: BTreeMap<String, String>,
    pub optional_dependencies: BTreeMap<String, String>,
}

/// Where a dependency reference points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DepRef {
    /// A snapshot, by dependency path.
    Snapshot(String),
    /// A directory relative to the referring project (`link:`).
    Link(String),
}

impl DepRef {
    pub fn parse(alias: &str, reference: &str) -> DepRef {
        match reference.strip_prefix("link:") {
            Some(path) => DepRef::Link(path.to_string()),
            None => DepRef::Snapshot(
                ref_to_relative(reference, alias).unwrap_or_else(|| reference.to_string()),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    pub name: String,
    pub version: String,
    pub resolution: Resolution,
    pub os: Vec<String>,
    pub cpu: Vec<String>,
    pub libc: Vec<String>,
    pub has_bin: bool,
}

/// How to obtain a package's files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// From the registry, at the URL derived from name and version.
    Registry { integrity: String },
    /// From an explicit tarball URL (`https:` or a repository-relative
    /// `file:`).
    Tarball {
        url: String,
        integrity: Option<String>,
    },
    /// A local directory (`file:` dependencies, injected workspace
    /// packages).
    Directory { path: String },
    /// A git repository at a commit.
    Git { repo: String, commit: String },
    /// Anything else (`type: variations`, custom resolvers, a bare entry).
    Other(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub dependencies: BTreeMap<String, String>,
    pub optional_dependencies: BTreeMap<String, String>,
    /// Reached only through optional dependencies.
    pub optional: bool,
}

impl Lockfile {
    /// The `packages` entry for a dependency path.
    pub fn package(&self, dep_path: &str) -> Option<&Package> {
        self.packages.get(remove_suffix(dep_path))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLockfile {
    lockfile_version: Option<serde_yaml_ng::Value>,
    #[serde(default)]
    settings: RawSettings,
    #[serde(default)]
    importers: BTreeMap<String, RawImporter>,
    #[serde(default)]
    packages: HashMap<String, RawPackage>,
    #[serde(default)]
    snapshots: HashMap<String, RawSnapshot>,
    #[serde(default)]
    patched_dependencies: BTreeMap<String, RawPatched>,
    // A format 6 lockfile of a single project (no workspace) puts the
    // root's dependencies at the top level instead of under `importers`.
    #[serde(default)]
    dependencies: BTreeMap<String, RawDep>,
    #[serde(default)]
    dev_dependencies: BTreeMap<String, RawDep>,
    #[serde(default)]
    optional_dependencies: BTreeMap<String, RawDep>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawSettings {
    #[serde(default)]
    inject_workspace_packages: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawImporter {
    #[serde(default)]
    dependencies: BTreeMap<String, RawDep>,
    #[serde(default)]
    dev_dependencies: BTreeMap<String, RawDep>,
    #[serde(default)]
    optional_dependencies: BTreeMap<String, RawDep>,
}

/// An importer dependency: `{specifier, version}` inline since format 6,
/// a bare version string before that.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawDep {
    Inline { version: String },
    Plain(String),
}

impl RawDep {
    fn version(self) -> String {
        match self {
            RawDep::Inline { version } | RawDep::Plain(version) => version,
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawPatched {
    Hash(String),
    Entry { hash: String, path: String },
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawPackage {
    #[serde(default)]
    resolution: RawResolution,
    name: Option<String>,
    version: Option<String>,
    #[serde(default)]
    os: OneOrMany,
    #[serde(default)]
    cpu: OneOrMany,
    #[serde(default)]
    libc: OneOrMany,
    #[serde(default)]
    has_bin: bool,
    // Format 6 keeps the wiring here too.
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
    #[serde(default)]
    optional_dependencies: BTreeMap<String, String>,
    #[serde(default)]
    optional: bool,
}

#[derive(Deserialize, Default)]
struct RawResolution {
    integrity: Option<String>,
    tarball: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    directory: Option<String>,
    repo: Option<String>,
    commit: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawSnapshot {
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
    #[serde(default)]
    optional_dependencies: BTreeMap<String, String>,
    #[serde(default)]
    optional: bool,
}

/// `os: [linux]` in lockfiles; a bare string is accepted too, as in
/// `package.json`.
#[derive(Deserialize, Default)]
#[serde(untagged)]
enum OneOrMany {
    #[default]
    None,
    One(String),
    Many(Vec<String>),
}

impl OneOrMany {
    fn into_vec(self) -> Vec<String> {
        match self {
            OneOrMany::None => Vec::new(),
            OneOrMany::One(value) => vec![value],
            OneOrMany::Many(values) => values,
        }
    }
}

fn err(message: impl Into<String>) -> PnpmError {
    PnpmError::Lockfile {
        path: "pnpm-lock.yaml".to_string(),
        message: message.into(),
    }
}

/// Parses a `pnpm-lock.yaml` of format 9 or 6.
pub fn parse_lockfile(text: &str) -> Result<Lockfile, PnpmError> {
    let mut raw: RawLockfile = serde_yaml_ng::from_str(text).map_err(|e| err(e.to_string()))?;
    let version = match raw.lockfile_version.take() {
        Some(serde_yaml_ng::Value::String(version)) => version,
        Some(serde_yaml_ng::Value::Number(version)) => version.to_string(),
        _ => return Err(err("no lockfileVersion")),
    };
    let major = version.split('.').next().unwrap_or("");
    match major {
        "9" => from_v9(raw, version),
        "6" => from_v6(raw, version),
        _ => Err(err(format!(
            "lockfileVersion {version} is not supported (9.x from pnpm 9 and later, or 6.x from pnpm 8)"
        ))),
    }
}

fn importer_from_raw(raw: RawImporter, strip_slash: bool) -> Importer {
    let convert = |deps: BTreeMap<String, RawDep>| {
        deps.into_iter()
            .map(|(alias, dep)| {
                let version = dep.version();
                let version = if strip_slash {
                    v6_reference(&version)
                } else {
                    version
                };
                (alias, version)
            })
            .collect()
    };
    Importer {
        dependencies: convert(raw.dependencies),
        dev_dependencies: convert(raw.dev_dependencies),
        optional_dependencies: convert(raw.optional_dependencies),
    }
}

fn patched_from_raw(raw: BTreeMap<String, RawPatched>) -> BTreeMap<String, PatchedDependency> {
    raw.into_iter()
        .map(|(selector, patched)| {
            let patched = match patched {
                RawPatched::Hash(hash) => PatchedDependency { hash, path: None },
                RawPatched::Entry { hash, path } => PatchedDependency {
                    hash,
                    path: Some(path),
                },
            };
            (selector, patched)
        })
        .collect()
}

fn package_from_raw(key: &str, raw: RawPackage) -> Result<(Package, Snapshot), PnpmError> {
    let parsed = split_name_version(key);
    let name = raw
        .name
        .or_else(|| parsed.map(|(name, _)| name.to_string()))
        .ok_or_else(|| err(format!("package key {key} has no name@version")))?;
    let version = raw
        .version
        .or_else(|| parsed.map(|(_, version)| version.to_string()))
        .ok_or_else(|| err(format!("package key {key} has no version")))?;
    let resolution = resolution_from_raw(raw.resolution);
    let package = Package {
        name,
        version,
        resolution,
        os: raw.os.into_vec(),
        cpu: raw.cpu.into_vec(),
        libc: raw.libc.into_vec(),
        has_bin: raw.has_bin,
    };
    let snapshot = Snapshot {
        dependencies: raw.dependencies,
        optional_dependencies: raw.optional_dependencies,
        optional: raw.optional,
    };
    Ok((package, snapshot))
}

fn resolution_from_raw(raw: RawResolution) -> Resolution {
    match raw.kind.as_deref() {
        Some("directory") => Resolution::Directory {
            path: raw.directory.unwrap_or_default(),
        },
        Some("git") => Resolution::Git {
            repo: raw.repo.unwrap_or_default(),
            commit: raw.commit.unwrap_or_default(),
        },
        Some(other) => Resolution::Other(format!("resolution type {other}")),
        None => match (raw.tarball, raw.integrity) {
            (Some(url), integrity) => Resolution::Tarball { url, integrity },
            (None, Some(integrity)) => Resolution::Registry { integrity },
            (None, None) => Resolution::Other("a resolution with no integrity or tarball".into()),
        },
    }
}

fn from_v9(raw: RawLockfile, version: String) -> Result<Lockfile, PnpmError> {
    let mut packages = HashMap::with_capacity(raw.packages.len());
    for (key, raw_package) in raw.packages {
        let (package, _) = package_from_raw(&key, raw_package)?;
        packages.insert(key, package);
    }
    let snapshots = raw
        .snapshots
        .into_iter()
        .map(|(key, snapshot)| {
            let snapshot = Snapshot {
                dependencies: snapshot.dependencies,
                optional_dependencies: snapshot.optional_dependencies,
                optional: snapshot.optional,
            };
            (key, snapshot)
        })
        .collect();
    let importers = raw
        .importers
        .into_iter()
        .map(|(id, importer)| (id, importer_from_raw(importer, false)))
        .collect();
    Ok(Lockfile {
        version,
        importers,
        packages,
        snapshots,
        patched_dependencies: patched_from_raw(raw.patched_dependencies),
        inject_workspace_packages: raw.settings.inject_workspace_packages,
    })
}

/// A format 6 reference with its leading `/` dropped: `/ms@2.1.3` (an npm
/// alias) is a whole dependency path once the slash is gone, and bare
/// versions and `link:` are unchanged.
fn v6_reference(reference: &str) -> String {
    reference.strip_prefix('/').unwrap_or(reference).to_string()
}

fn from_v6(raw: RawLockfile, version: String) -> Result<Lockfile, PnpmError> {
    let mut packages = HashMap::with_capacity(raw.packages.len());
    let mut snapshots = HashMap::with_capacity(raw.packages.len());
    for (key, raw_package) in raw.packages {
        let dep_path = key.strip_prefix('/').unwrap_or(&key).to_string();
        let package_key = remove_suffix(&dep_path).to_string();
        let (package, mut snapshot) = package_from_raw(&package_key, raw_package)?;
        for deps in [
            &mut snapshot.dependencies,
            &mut snapshot.optional_dependencies,
        ] {
            for reference in deps.values_mut() {
                *reference = v6_reference(reference);
            }
        }
        packages.insert(package_key, package);
        snapshots.insert(dep_path, snapshot);
    }
    let mut importers: BTreeMap<String, Importer> = raw
        .importers
        .into_iter()
        .map(|(id, importer)| (id, importer_from_raw(importer, true)))
        .collect();
    if importers.is_empty() {
        let root = RawImporter {
            dependencies: raw.dependencies,
            dev_dependencies: raw.dev_dependencies,
            optional_dependencies: raw.optional_dependencies,
        };
        importers.insert(".".to_string(), importer_from_raw(root, true));
    }
    Ok(Lockfile {
        version,
        importers,
        packages,
        snapshots,
        patched_dependencies: patched_from_raw(raw.patched_dependencies),
        inject_workspace_packages: raw.settings.inject_workspace_packages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_6_is_normalised_to_the_format_9_shape() {
        let text = r#"
lockfileVersion: '6.0'

dependencies:
  react-dom:
    specifier: ^18.0.0
    version: 18.2.0(react@18.2.0)
  cjs:
    specifier: npm:string-width@4.2.3
    version: /string-width@4.2.3

packages:

  /react-dom@18.2.0(react@18.2.0):
    resolution: {integrity: sha512-aaaa}
    peerDependencies:
      react: ^18.2.0
    dependencies:
      react: 18.2.0
    dev: false

  /react@18.2.0:
    resolution: {integrity: sha512-bbbb}
    dev: false

  /string-width@4.2.3:
    resolution: {integrity: sha512-cccc}
    dev: false
"#;
        let lockfile = parse_lockfile(text).unwrap();
        let root = &lockfile.importers["."];
        assert_eq!(root.dependencies["cjs"], "string-width@4.2.3");
        assert_eq!(
            DepRef::parse("cjs", &root.dependencies["cjs"]),
            DepRef::Snapshot("string-width@4.2.3".into())
        );
        assert!(
            lockfile
                .snapshots
                .contains_key("react-dom@18.2.0(react@18.2.0)")
        );
        assert_eq!(
            lockfile
                .package("react-dom@18.2.0(react@18.2.0)")
                .unwrap()
                .name,
            "react-dom"
        );
        assert_eq!(
            lockfile.package("react@18.2.0").unwrap().resolution,
            Resolution::Registry {
                integrity: "sha512-bbbb".into()
            }
        );
    }

    #[test]
    fn unsupported_versions_are_named() {
        let error = parse_lockfile("lockfileVersion: 5.4\n")
            .unwrap_err()
            .to_string();
        assert!(error.contains("5.4"), "{error}");
    }
}
