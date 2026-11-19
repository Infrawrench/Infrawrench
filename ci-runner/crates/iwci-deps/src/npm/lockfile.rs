//! `package-lock.json` (and `npm-shrinkwrap.json`, the same format), as npm
//! 7 and later write it: `lockfileVersion` 2 or 3, whose `packages` map
//! records the whole `node_modules` tree by location.
//!
//! A location is a path relative to the project root: `""` is the root
//! itself, `node_modules/a/node_modules/b` a package nested in another,
//! `packages/web` a workspace (or any directory a link points at), and
//! `packages/web/node_modules/c` a package installed in that workspace's
//! own `node_modules`. The fields read here are the ones Arborist writes
//! (`lib/shrinkwrap.js`, `metaFromNode`); anything else is ignored.

use std::collections::BTreeMap;

use serde::Deserialize;

/// The newest `lockfileVersion` this reader knows (npm 9 and later write
/// 3; 7 and 8 write 2, which carries the same `packages` map).
pub const MAX_LOCKFILE_VERSION: u64 = 3;

/// One entry of `packages`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    /// The package's own name, written only when it differs from the
    /// folder it is installed in (an `npm:` alias) and for the root and
    /// workspaces.
    pub name: Option<String>,
    pub version: Option<String>,
    /// A tarball URL for a registry or remote package, `file:<path>` for a
    /// tarball in the repository, a git URL for a git dependency, and the
    /// target's location for a link.
    pub resolved: Option<String>,
    pub integrity: Option<String>,
    /// A symlink to `resolved`, which has an entry of its own.
    pub link: bool,
    pub dev: bool,
    pub optional: bool,
    pub dev_optional: bool,
    pub peer: bool,
    /// Comes inside the tarball of the package it is nested in.
    pub in_bundle: bool,
    /// Nothing depends on it; npm prunes it.
    pub extraneous: bool,
    pub has_install_script: bool,
    #[serde(deserialize_with = "list")]
    pub os: Vec<String>,
    #[serde(deserialize_with = "list")]
    pub cpu: Vec<String>,
    #[serde(deserialize_with = "list")]
    pub libc: Vec<String>,
    #[serde(deserialize_with = "map")]
    pub dependencies: BTreeMap<String, String>,
    #[serde(deserialize_with = "map")]
    pub optional_dependencies: BTreeMap<String, String>,
    #[serde(deserialize_with = "map")]
    pub peer_dependencies: BTreeMap<String, String>,
    #[serde(deserialize_with = "map")]
    pub dev_dependencies: BTreeMap<String, String>,
    #[serde(deserialize_with = "peer_meta")]
    pub peer_dependencies_meta: BTreeMap<String, bool>,
}

impl Entry {
    /// Whether the peer dependency `name` is marked optional.
    pub fn optional_peer(&self, name: &str) -> bool {
        self.peer_dependencies_meta
            .get(name)
            .copied()
            .unwrap_or(false)
    }
}

/// A parsed lockfile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lockfile {
    pub version: u64,
    /// By location, in the order the file lists them (npm sorts them).
    pub packages: Vec<(String, Entry)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    lockfile_version: Option<serde_json::Value>,
    packages: Option<serde_json::Map<String, serde_json::Value>>,
}

/// `os`, `cpu` and `libc` are lists in `package.json`, though a string
/// slips through now and then; anything else reads as no restriction.
fn list<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(one) => vec![one],
        serde_json::Value::Array(many) => many
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    })
}

/// A dependency map, keeping only string specifiers.
fn map<'de, D: serde::Deserializer<'de>>(d: D) -> Result<BTreeMap<String, String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Object(map) => map
            .into_iter()
            .filter_map(|(k, v)| Some((k, v.as_str()?.to_string())))
            .collect(),
        _ => BTreeMap::new(),
    })
}

fn peer_meta<'de, D: serde::Deserializer<'de>>(d: D) -> Result<BTreeMap<String, bool>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Object(map) => map
            .into_iter()
            .map(|(k, v)| {
                let optional = v
                    .get("optional")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                (k, optional)
            })
            .collect(),
        _ => BTreeMap::new(),
    })
}

/// Parses a lockfile's text. Version 1 (npm 5 and 6) and a lockfile with
/// no `packages` are refused with what to do about it.
pub fn parse_lockfile(text: &str) -> Result<Lockfile, String> {
    let raw: Raw = serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))?;
    let version = match &raw.lockfile_version {
        None => {
            return Err(
                "has no lockfileVersion (written before npm 5); run `npm install` with npm 7 or later and commit the lockfile it writes"
                    .to_string(),
            );
        }
        Some(value) => value
            .as_u64()
            .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            .ok_or_else(|| format!("lockfileVersion {value} is not a number"))?,
    };
    if version < 2 {
        return Err(format!(
            "lockfileVersion {version} (npm 5 and 6) is not supported: it does not record the node_modules tree; run `npm install --lockfile-version 3` with npm 7 or later and commit the lockfile it writes"
        ));
    }
    if version > MAX_LOCKFILE_VERSION {
        return Err(format!(
            "lockfileVersion {version} was written by an npm newer than this runner knows (it reads up to {MAX_LOCKFILE_VERSION})"
        ));
    }
    let Some(packages) = raw.packages else {
        return Err(format!(
            "lockfileVersion {version} without a `packages` map; run `npm install` with npm 7 or later and commit the lockfile it writes"
        ));
    };
    let mut out = Vec::with_capacity(packages.len());
    for (location, value) in packages {
        let entry: Entry =
            serde_json::from_value(value).map_err(|e| format!("packages[{location:?}]: {e}"))?;
        out.push((location, entry));
    }
    Ok(Lockfile {
        version,
        packages: out,
    })
}
