//! Reading `bun.lock`, Bun's text lockfile (Bun 1.2 and later).
//!
//! The file is JSON with trailing commas. Its `workspaces` object lists each
//! workspace's own dependency ranges by workspace path (`""` is the root),
//! and `packages` lists every installed package under the path it has in
//! Bun's hoisted tree: `"is-number"` is the copy at the top, and
//! `"is-odd/is-number"` the one nested under `is-odd` because it is another
//! version. A package depends on whichever entry is nearest above it, the
//! way Node resolves a bare import, so the keys carry the whole resolution.
//!
//! Each entry is an array whose first element is `name@resolution` and
//! whose shape depends on the kind of resolution (from Bun's
//! `src/install/lockfile/bun.lock.rs`):
//!
//! | kind      | entry                                                    |
//! | --------- | -------------------------------------------------------- |
//! | npm       | `["name@version", registry, info, integrity]`            |
//! | tarball   | `["name@url-or-path", info, integrity?]`                 |
//! | GitHub    | `["name@github:owner/repo#commit", info, tag, integrity?]` |
//! | git       | `["name@git+url#commit", info, tag, integrity?]`         |
//! | workspace | `["name@workspace:path"]`                                |
//! | link      | `["name@link:path", info]`                               |
//! | folder    | `["name@file:path", info]`                               |
//! | root      | `["name@root:", info]`                                   |
//!
//! `info` holds the package's own dependency ranges and its `os`, `cpu`,
//! `libc`, `bundled` and `hasInstallScript` fields.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

/// The newest `lockfileVersion` this reads. 0 and 1 came with Bun 1.2, 2
/// made a missing integrity an error, and 3 is written when `overrides`
/// holds scoped rules (which only matter while resolving).
pub const MAX_LOCKFILE_VERSION: u64 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lockfile {
    pub version: u64,
    /// 1 since Bun 1.3.2, which made the isolated linker the default for
    /// workspaces; absent or 0 in a lockfile from before.
    pub config_version: u64,
    /// By workspace path; the root is `""`.
    pub workspaces: BTreeMap<String, Workspace>,
    /// By path in the hoisted tree.
    pub packages: BTreeMap<String, Package>,
    /// `name@version` to a patch file, relative to the root.
    pub patched_dependencies: BTreeMap<String, String>,
    pub trusted_dependencies: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Workspace {
    pub name: Option<String>,
    pub deps: Deps,
}

/// The dependency ranges of a workspace or a package, by group. Only the
/// names matter here: the versions were resolved when the lockfile was
/// written.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Deps {
    pub dependencies: BTreeSet<String>,
    /// Workspaces only.
    pub dev_dependencies: BTreeSet<String>,
    pub optional_dependencies: BTreeSet<String>,
    pub peer_dependencies: BTreeSet<String>,
    pub optional_peers: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    /// The package's own name, which an `npm:` alias's key differs from.
    pub name: String,
    /// `name@resolution`, the entry's first element. Two entries with the
    /// same one are the same package placed twice.
    pub ident: String,
    pub resolution: Resolution,
    pub deps: Deps,
    pub os: Vec<String>,
    pub cpu: Vec<String>,
    pub libc: Vec<String>,
    /// Shipped inside its dependent's tarball, so not fetched.
    pub bundled: bool,
    pub has_install_script: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Npm {
        version: String,
        /// The tarball's URL when it is not on the default registry.
        url: Option<String>,
        integrity: Option<String>,
    },
    /// A tarball by URL, or by a path inside the repository.
    Tarball {
        location: String,
        integrity: Option<String>,
    },
    Github {
        owner: String,
        repo: String,
        commit: String,
        integrity: Option<String>,
    },
    Git {
        url: String,
    },
    /// A workspace package, by its directory.
    Workspace {
        path: String,
    },
    /// A `link:` dependency: a symlink to a directory.
    Link {
        path: String,
    },
    /// A `file:` directory, which Bun copies.
    Folder {
        path: String,
    },
    /// The root package, depended on by one of its workspaces.
    Root,
}

impl Resolution {
    /// Whether the package is a directory of the repository rather than
    /// something unpacked into `node_modules`.
    pub fn is_directory(&self) -> bool {
        matches!(
            self,
            Resolution::Workspace { .. } | Resolution::Link { .. } | Resolution::Root
        )
    }
}

/// `text` without `//` and `/* */` comments and without the commas that
/// end an object or an array, which is what turns `bun.lock` into JSON.
pub fn strip_jsonc(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i = (i + 1).min(bytes.len());
                out.extend_from_slice(&bytes[start..i]);
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
            }
            b',' => {
                if !matches!(bytes.get(after_blanks(bytes, i + 1)), Some(b'}' | b']')) {
                    out.push(b',');
                }
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    // Only whole strings, comments and ASCII bytes were dropped or copied,
    // so the result is as valid UTF-8 as the input was.
    String::from_utf8(out).unwrap_or_default()
}

/// The first position at or after `from` that is neither white space nor
/// inside a comment.
fn after_blanks(bytes: &[u8], from: usize) -> usize {
    let mut i = from;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        match (bytes.get(i), bytes.get(i + 1)) {
            (Some(b'/'), Some(b'/')) => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            (Some(b'/'), Some(b'*')) => {
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
            }
            _ => return i,
        }
    }
}

/// `name@resolution` split at the `@` that is not a scope's.
pub fn split_ident(ident: &str) -> Option<(&str, &str)> {
    let at = ident.get(1..)?.find('@')? + 1;
    Some((&ident[..at], &ident[at + 1..]))
}

/// A path in the hoisted tree as package names: `@scope/a/b` is `@scope/a`
/// and then `b`.
pub fn key_segments(key: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut rest = key;
    while !rest.is_empty() {
        let end = if rest.starts_with('@') {
            match rest.find('/') {
                Some(scope) => rest[scope + 1..]
                    .find('/')
                    .map_or(rest.len(), |slash| scope + 1 + slash),
                None => rest.len(),
            }
        } else {
            rest.find('/').unwrap_or(rest.len())
        };
        segments.push(&rest[..end]);
        rest = rest[end..].strip_prefix('/').unwrap_or("");
    }
    segments
}

fn names(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(one)) => vec![one.clone()],
        Some(Value::Array(many)) => many
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn deps(info: &Value) -> Deps {
    Deps {
        dependencies: names(info.get("dependencies")),
        dev_dependencies: names(info.get("devDependencies")),
        optional_dependencies: names(info.get("optionalDependencies")),
        peer_dependencies: names(info.get("peerDependencies")),
        optional_peers: strings(info.get("optionalPeers")).into_iter().collect(),
    }
}

fn package(key: &str, entry: &Value) -> Result<Package, String> {
    let bad = |what: &str| format!("packages[{key:?}]: {what}");
    let items = entry.as_array().ok_or_else(|| bad("is not an array"))?;
    let ident = items
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| bad("does not start with name@resolution"))?;
    let (name, resolved) =
        split_ident(ident).ok_or_else(|| bad("does not start with name@resolution"))?;
    let integrity = |index: usize| {
        items
            .get(index)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let empty = Value::Null;
    let (resolution, info) = if let Some(path) = resolved.strip_prefix("workspace:") {
        (
            Resolution::Workspace {
                path: path.to_string(),
            },
            &empty,
        )
    } else if let Some(path) = resolved.strip_prefix("link:") {
        (
            Resolution::Link {
                path: path.to_string(),
            },
            items.get(1).unwrap_or(&empty),
        )
    } else if let Some(path) = resolved.strip_prefix("file:") {
        (
            Resolution::Folder {
                path: path.to_string(),
            },
            items.get(1).unwrap_or(&empty),
        )
    } else if resolved.starts_with("root:") {
        (Resolution::Root, &empty)
    } else if let Some(spec) = resolved.strip_prefix("github:") {
        let (repository, commit) = spec.split_once('#').ok_or_else(|| bad("names no commit"))?;
        let (owner, repo) = repository
            .split_once('/')
            .ok_or_else(|| bad("is not github:owner/repo#commit"))?;
        (
            Resolution::Github {
                owner: owner.to_string(),
                repo: repo.to_string(),
                commit: commit.to_string(),
                integrity: integrity(3),
            },
            items.get(1).unwrap_or(&empty),
        )
    } else if resolved.starts_with("git+") {
        (
            Resolution::Git {
                url: resolved.to_string(),
            },
            items.get(1).unwrap_or(&empty),
        )
    } else if let Some(registry) = items.get(1).and_then(Value::as_str) {
        (
            Resolution::Npm {
                version: resolved.to_string(),
                url: (!registry.is_empty()).then(|| registry.to_string()),
                integrity: integrity(3),
            },
            items.get(2).unwrap_or(&empty),
        )
    } else {
        (
            Resolution::Tarball {
                location: resolved.to_string(),
                integrity: integrity(2),
            },
            items.get(1).unwrap_or(&empty),
        )
    };
    Ok(Package {
        name: name.to_string(),
        ident: ident.to_string(),
        resolution,
        deps: deps(info),
        os: strings(info.get("os")),
        cpu: strings(info.get("cpu")),
        libc: strings(info.get("libc")),
        bundled: info.get("bundled").and_then(Value::as_bool) == Some(true),
        has_install_script: info.get("hasInstallScript").and_then(Value::as_bool) == Some(true),
    })
}

pub fn parse_lockfile(text: &str) -> Result<Lockfile, String> {
    let root: Value = serde_json::from_str(&strip_jsonc(text)).map_err(|e| e.to_string())?;
    let version = root
        .get("lockfileVersion")
        .and_then(Value::as_u64)
        .ok_or("no lockfileVersion")?;
    if version > MAX_LOCKFILE_VERSION {
        return Err(format!(
            "lockfileVersion {version} is newer than this runner reads (up to {MAX_LOCKFILE_VERSION})"
        ));
    }
    let mut workspaces = BTreeMap::new();
    for (path, value) in root
        .get("workspaces")
        .and_then(Value::as_object)
        .ok_or("no workspaces")?
    {
        workspaces.insert(
            path.clone(),
            Workspace {
                name: value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                deps: deps(value),
            },
        );
    }
    if !workspaces.contains_key("") {
        return Err("workspaces has no root entry".to_string());
    }
    let mut packages = BTreeMap::new();
    if let Some(entries) = root.get("packages").and_then(Value::as_object) {
        for (key, entry) in entries {
            packages.insert(key.clone(), package(key, entry)?);
        }
    }
    let mut patched_dependencies = BTreeMap::new();
    if let Some(map) = root.get("patchedDependencies").and_then(Value::as_object) {
        for (selector, path) in map {
            if let Some(path) = path.as_str() {
                patched_dependencies.insert(selector.clone(), path.to_string());
            }
        }
    }
    Ok(Lockfile {
        version,
        config_version: root
            .get("configVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        workspaces,
        packages,
        patched_dependencies,
        trusted_dependencies: strings(root.get("trustedDependencies"))
            .into_iter()
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_commas_and_comments_go_and_strings_stay() {
        let text = r#"{
  // a comment
  "a": [1, 2,],
  "b": { "c": "x, } // not a comment", }, /* gone */
}"#;
        let value: Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(value["a"][1], 2);
        assert_eq!(value["b"]["c"], "x, } // not a comment");
    }

    #[test]
    fn idents_and_keys_split_at_the_right_places() {
        assert_eq!(split_ident("ms@2.1.3"), Some(("ms", "2.1.3")));
        assert_eq!(
            split_ident("@fix/a@workspace:packages/a"),
            Some(("@fix/a", "workspace:packages/a"))
        );
        assert_eq!(split_ident("ms"), None);
        assert_eq!(key_segments("is-odd/is-number"), ["is-odd", "is-number"]);
        assert_eq!(
            key_segments("@fix/a/@types/node/x"),
            ["@fix/a", "@types/node", "x"]
        );
        assert!(key_segments("").is_empty());
    }
}
