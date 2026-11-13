//! Tool and environment manifests, schema 1.
//!
//! Parsing is strict (`deny_unknown_fields`) so a typo in a hand-written
//! manifest fails at publish time instead of being silently ignored. The
//! `schema` field is read on its own first, so a future schema with new fields
//! reports "unsupported schema 2" rather than "unknown field".

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::ManifestError;
use crate::keys::{is_valid_name, is_valid_sha256};
use crate::version::Version;

/// The only manifest schema this crate reads and writes.
pub const SCHEMA: u32 = 1;
/// Largest single blob (module, data file or webc package).
pub const MAX_BLOB_SIZE: u64 = 256 * 1024 * 1024;
/// Largest sum of every blob one manifest references, so a manifest cannot
/// make a job fetch an unbounded amount through many capped files.
pub const MAX_TOTAL_SIZE: u64 = 1024 * 1024 * 1024;
/// Largest manifest document.
pub const MAX_MANIFEST_SIZE: usize = 1024 * 1024;
/// Most data files a tool may mount.
pub const MAX_FILES: usize = 4096;
/// Most packages an environment may name.
pub const MAX_PACKAGES: usize = 64;
const MAX_ARGS: usize = 256;
const MAX_ARG_LEN: usize = 4096;
const MAX_ENV: usize = 256;
const MAX_ENV_VALUE_LEN: usize = 32 * 1024;
const MAX_DESCRIPTION_LEN: usize = 1024;
const MAX_GUEST_PATH_LEN: usize = 4096;
/// Most caches an environment may declare.
pub const MAX_ENV_CACHES: usize = 8;
/// The smallest and largest `max-bytes` of an environment's cache.
pub const MIN_ENV_CACHE_BYTES: u64 = 1024 * 1024;
pub const MAX_ENV_CACHE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// A reference to a blob by digest and size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlobRef {
    /// Lowercase hex SHA-256.
    pub sha256: String,
    /// Exact length in bytes.
    pub size: u64,
}

/// How the runtime hosts a tool's module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Abi {
    /// Plain WASI preview 1 (`wasm32-wasip1`), such as gofmt.
    Wasi,
    /// WASIX, Wasmer's superset.
    Wasix,
    /// The TypeScript compiler host interface.
    TscHost,
}

/// A data file mounted read-only into the guest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolFile {
    /// Absolute, normalised guest path.
    pub path: String,
    /// Lowercase hex SHA-256 of the content.
    pub sha256: String,
    /// Exact length in bytes.
    pub size: u64,
}

/// `builtins/<name>/<version>.json` and `repos/<id>/tools/<name>/<version>.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolManifest {
    /// Always [`SCHEMA`].
    pub schema: u32,
    /// The tool's name, equal to the `<name>` segment of its key.
    pub name: String,
    /// The tool's version, equal to the `<version>` segment of its key.
    pub version: Version,
    /// How to host the module.
    pub abi: Abi,
    /// The wasm module.
    pub module: BlobRef,
    /// Data files mounted read-only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<ToolFile>,
    /// Arguments placed before the job's own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Environment variables set for the guest.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Free text for humans.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One webc package of an environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvPackage {
    /// Package name, `name` or `namespace/name` (each part a valid name).
    pub name: String,
    /// The package's own version.
    pub version: Version,
    /// Lowercase hex SHA-256 of the `.webc`.
    pub sha256: String,
    /// Exact length in bytes.
    pub size: u64,
}

/// The program a job's `run:` script is handed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvEntry {
    /// `bash`, which must be provided by one of the packages.
    Bash,
}

/// A directory of an environment whose additions every job keeps between
/// runs, such as Go's build cache: what a job writes there beyond what the
/// packages ship is saved after it passes and restored before its next
/// run (`iwci`'s schedule, "environment caches").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct EnvCache {
    /// What a job's `env-cache:` and its report call it.
    pub name: String,
    /// Absolute, normalised guest path of the directory.
    pub path: String,
    /// The most one saved cache may hold, in bytes of file content.
    pub max_bytes: u64,
}

/// `environments/<name>/<version>.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvManifest {
    /// Always [`SCHEMA`].
    pub schema: u32,
    /// The environment's name, equal to the `<name>` segment of its key.
    pub name: String,
    /// The environment's version, equal to the `<version>` segment of its key.
    pub version: Version,
    /// The webc packages, in mount order.
    pub packages: Vec<EnvPackage>,
    /// What runs the script.
    pub entry: EnvEntry,
    /// Environment variables set for the script.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Directories whose additions a job keeps between runs. A runner
    /// older than the field rejects the manifest (`deny_unknown_fields`),
    /// so a version that has them is published after every runner can
    /// read them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caches: Vec<EnvCache>,
    /// Free text for humans.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Deserialize)]
struct SchemaProbe {
    schema: Option<serde_json::Value>,
}

fn check_schema(bytes: &[u8]) -> Result<(), ManifestError> {
    if bytes.len() > MAX_MANIFEST_SIZE {
        return Err(invalid(
            "",
            format!("manifest larger than {MAX_MANIFEST_SIZE} bytes"),
        ));
    }
    let probe: SchemaProbe = serde_json::from_slice(bytes)?;
    let found = probe.schema.and_then(|v| v.as_u64()).unwrap_or(0);
    if found != u64::from(SCHEMA) {
        return Err(ManifestError::UnsupportedSchema { found });
    }
    Ok(())
}

fn invalid(field: impl Into<String>, reason: impl Into<String>) -> ManifestError {
    ManifestError::Invalid {
        field: field.into(),
        reason: reason.into(),
    }
}

fn check_name(field: &str, name: &str) -> Result<(), ManifestError> {
    if is_valid_name(name) {
        Ok(())
    } else {
        Err(invalid(field, "must match [a-z0-9][a-z0-9_-]{0,63}"))
    }
}

fn check_blob(field: &str, sha256: &str, size: u64, min: u64) -> Result<(), ManifestError> {
    if !is_valid_sha256(sha256) {
        return Err(invalid(
            format!("{field}.sha256"),
            "must be 64 lowercase hex digits",
        ));
    }
    if size < min || size > MAX_BLOB_SIZE {
        return Err(invalid(
            format!("{field}.size"),
            format!("must be between {min} and {MAX_BLOB_SIZE} bytes"),
        ));
    }
    Ok(())
}

/// Checks an absolute, normalised guest path: starts with `/`, no empty, `.`
/// or `..` segments, no trailing `/`, not `/` itself, no NUL.
pub fn is_valid_guest_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    path.len() <= MAX_GUEST_PATH_LEN
        && !rest.is_empty()
        && !path.contains('\0')
        && rest
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}

fn check_env(field: &str, env: &BTreeMap<String, String>) -> Result<(), ManifestError> {
    if env.len() > MAX_ENV {
        return Err(invalid(field, format!("more than {MAX_ENV} variables")));
    }
    for (k, v) in env {
        let key_ok = k.len() <= 256
            && k.bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !key_ok {
            return Err(invalid(
                format!("{field}.{k}"),
                "names must match [A-Za-z_][A-Za-z0-9_]*",
            ));
        }
        if v.len() > MAX_ENV_VALUE_LEN || v.contains('\0') {
            return Err(invalid(
                format!("{field}.{k}"),
                format!("values are at most {MAX_ENV_VALUE_LEN} bytes with no NUL"),
            ));
        }
    }
    Ok(())
}

fn check_description(d: &Option<String>) -> Result<(), ManifestError> {
    match d {
        Some(d) if d.len() > MAX_DESCRIPTION_LEN => Err(invalid(
            "description",
            format!("at most {MAX_DESCRIPTION_LEN} bytes"),
        )),
        _ => Ok(()),
    }
}

fn to_json<T: Serialize>(value: &T) -> Vec<u8> {
    // Pretty and newline-terminated so a published manifest diffs cleanly;
    // serialising a struct with BTreeMaps is deterministic, which `publish`
    // relies on to compare a re-publish with what is already there.
    let mut out = serde_json::to_vec_pretty(value).expect("manifests always serialise");
    out.push(b'\n');
    out
}

impl ToolManifest {
    /// Parses and validates a manifest document.
    pub fn from_json(bytes: &[u8]) -> Result<Self, ManifestError> {
        check_schema(bytes)?;
        let manifest: Self = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// The canonical serialisation.
    pub fn to_json(&self) -> Vec<u8> {
        to_json(self)
    }

    /// Checks every rule a published manifest must satisfy.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.schema != SCHEMA {
            return Err(ManifestError::UnsupportedSchema {
                found: u64::from(self.schema),
            });
        }
        check_name("name", &self.name)?;
        check_blob("module", &self.module.sha256, self.module.size, 1)?;
        if self.files.len() > MAX_FILES {
            return Err(invalid("files", format!("more than {MAX_FILES} files")));
        }
        let mut total = self.module.size;
        let mut paths = BTreeSet::new();
        for (i, f) in self.files.iter().enumerate() {
            let field = format!("files[{i}]");
            if !is_valid_guest_path(&f.path) {
                return Err(invalid(
                    format!("{field}.path"),
                    "must be an absolute, normalised guest path",
                ));
            }
            check_blob(&field, &f.sha256, f.size, 0)?;
            if !paths.insert(f.path.as_str()) {
                return Err(invalid(format!("{field}.path"), "listed twice"));
            }
            total += f.size;
        }
        // A file at `/a` and another at `/a/b` cannot both be mounted.
        let sorted: Vec<&str> = paths.into_iter().collect();
        for pair in sorted.windows(2) {
            if pair[1]
                .strip_prefix(pair[0])
                .is_some_and(|r| r.starts_with('/'))
            {
                return Err(invalid(
                    "files",
                    format!("{} is a file and also a directory of {}", pair[0], pair[1]),
                ));
            }
        }
        if total > MAX_TOTAL_SIZE {
            return Err(invalid(
                "files",
                format!("module and files exceed {MAX_TOTAL_SIZE} bytes"),
            ));
        }
        if self.args.len() > MAX_ARGS {
            return Err(invalid("args", format!("more than {MAX_ARGS} arguments")));
        }
        for (i, a) in self.args.iter().enumerate() {
            if a.len() > MAX_ARG_LEN || a.contains('\0') {
                return Err(invalid(
                    format!("args[{i}]"),
                    format!("at most {MAX_ARG_LEN} bytes with no NUL"),
                ));
            }
        }
        check_env("env", &self.env)?;
        check_description(&self.description)
    }

    /// Every blob the manifest references, module first.
    pub fn blobs(&self) -> impl Iterator<Item = (&str, u64)> {
        std::iter::once((self.module.sha256.as_str(), self.module.size))
            .chain(self.files.iter().map(|f| (f.sha256.as_str(), f.size)))
    }
}

/// Checks a webc package name: `name` or `namespace/name`.
fn is_valid_package_name(name: &str) -> bool {
    match name.split_once('/') {
        Some((ns, n)) => is_valid_name(ns) && is_valid_name(n),
        None => is_valid_name(name),
    }
}

impl EnvManifest {
    /// Parses and validates a manifest document.
    pub fn from_json(bytes: &[u8]) -> Result<Self, ManifestError> {
        check_schema(bytes)?;
        let manifest: Self = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// The canonical serialisation.
    pub fn to_json(&self) -> Vec<u8> {
        to_json(self)
    }

    /// Checks every rule a published manifest must satisfy.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.schema != SCHEMA {
            return Err(ManifestError::UnsupportedSchema {
                found: u64::from(self.schema),
            });
        }
        check_name("name", &self.name)?;
        if self.packages.is_empty() || self.packages.len() > MAX_PACKAGES {
            return Err(invalid(
                "packages",
                format!("must list between 1 and {MAX_PACKAGES} packages"),
            ));
        }
        let mut names = BTreeSet::new();
        let mut total = 0u64;
        for (i, p) in self.packages.iter().enumerate() {
            let field = format!("packages[{i}]");
            if !is_valid_package_name(&p.name) {
                return Err(invalid(
                    format!("{field}.name"),
                    "must be `name` or `namespace/name`, each [a-z0-9][a-z0-9_-]{0,63}",
                ));
            }
            if !names.insert(p.name.as_str()) {
                return Err(invalid(format!("{field}.name"), "listed twice"));
            }
            check_blob(&field, &p.sha256, p.size, 1)?;
            total += p.size;
        }
        if total > MAX_TOTAL_SIZE {
            return Err(invalid(
                "packages",
                format!("packages exceed {MAX_TOTAL_SIZE} bytes"),
            ));
        }
        check_env("env", &self.env)?;
        check_caches(&self.caches)?;
        check_description(&self.description)
    }
}

fn check_caches(caches: &[EnvCache]) -> Result<(), ManifestError> {
    if caches.len() > MAX_ENV_CACHES {
        return Err(invalid(
            "caches",
            format!("more than {MAX_ENV_CACHES} caches"),
        ));
    }
    for (i, cache) in caches.iter().enumerate() {
        let field = format!("caches[{i}]");
        check_name(&format!("{field}.name"), &cache.name)?;
        if !is_valid_guest_path(&cache.path) {
            return Err(invalid(
                format!("{field}.path"),
                "must be an absolute, normalised guest path",
            ));
        }
        if !(MIN_ENV_CACHE_BYTES..=MAX_ENV_CACHE_BYTES).contains(&cache.max_bytes) {
            return Err(invalid(
                format!("{field}.max-bytes"),
                format!("must be between {MIN_ENV_CACHE_BYTES} and {MAX_ENV_CACHE_BYTES}"),
            ));
        }
        for other in &caches[..i] {
            if other.name == cache.name {
                return Err(invalid(format!("{field}.name"), "listed twice"));
            }
            let within =
                |a: &str, b: &str| a == b || a.strip_prefix(b).is_some_and(|r| r.starts_with('/'));
            if within(&cache.path, &other.path) || within(&other.path, &cache.path) {
                return Err(invalid(
                    format!("{field}.path"),
                    format!("overlaps the cache at {}", other.path),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn tool_json(extra: &str) -> String {
        format!(
            r#"{{"schema":1,"name":"tsc","version":"7.1.3","abi":"tsc-host",
               "module":{{"sha256":"{H}","size":10}}{extra}}}"#
        )
    }

    fn tool_err(extra: &str) -> String {
        ToolManifest::from_json(tool_json(extra).as_bytes())
            .unwrap_err()
            .to_string()
    }

    #[test]
    fn parses_minimal_and_full_tool() {
        let m = ToolManifest::from_json(tool_json("").as_bytes()).unwrap();
        assert_eq!(m.abi, Abi::TscHost);
        assert_eq!(m.version.to_string(), "7.1.3");
        let full = tool_json(&format!(
            r#","files":[{{"path":"/lib/lib.d.ts","sha256":"{H}","size":0}}],
               "args":["--pretty"],"env":{{"NODE_ENV":"ci"}},"description":"TypeScript""#
        ));
        let m = ToolManifest::from_json(full.as_bytes()).unwrap();
        // The canonical form parses back to the same manifest.
        assert_eq!(ToolManifest::from_json(&m.to_json()).unwrap(), m);
    }

    #[test]
    fn rejects_bad_tools() {
        assert!(tool_err(r#","extra":1"#).contains("unknown field"));
        assert!(tool_err(r#","abi":"wasi""#).contains("duplicate field"));
        let cases = [
            (
                r#","files":[{"path":"lib","sha256":"H","size":0}]"#,
                "files[0].path",
            ),
            (
                r#","files":[{"path":"/a/../b","sha256":"H","size":0}]"#,
                "files[0].path",
            ),
            (
                r#","files":[{"path":"/a/","sha256":"H","size":0}]"#,
                "files[0].path",
            ),
            (
                r#","files":[{"path":"/a//b","sha256":"H","size":0}]"#,
                "files[0].path",
            ),
            (
                r#","files":[{"path":"/","sha256":"H","size":0}]"#,
                "files[0].path",
            ),
            (
                r#","files":[{"path":"/a","sha256":"ABC","size":0}]"#,
                "files[0].sha256",
            ),
            (
                r#","files":[{"path":"/a","sha256":"H","size":0},{"path":"/a","sha256":"H","size":0}]"#,
                "listed twice",
            ),
            (
                r#","files":[{"path":"/a","sha256":"H","size":0},{"path":"/a/b","sha256":"H","size":0}]"#,
                "also a directory",
            ),
            (
                r#","files":[{"path":"/a","sha256":"H","size":268435457}]"#,
                "files[0].size",
            ),
            (r#","env":{"1A":"x"}"#, "env.1A"),
            (r#","args":["a\u0000b"]"#, "args[0]"),
        ];
        for (extra, want) in cases {
            let err = tool_err(&extra.replace("\"H\"", &format!("\"{H}\"")));
            assert!(err.contains(want), "{extra}: {err}");
        }
        let bad_name = tool_json("").replace("\"tsc\"", "\"Tsc\"");
        assert!(ToolManifest::from_json(bad_name.as_bytes()).is_err());
        let bad_abi = tool_json("").replace("tsc-host", "native");
        assert!(ToolManifest::from_json(bad_abi.as_bytes()).is_err());
        let bad_version = tool_json("").replace("7.1.3", "7.1");
        assert!(ToolManifest::from_json(bad_version.as_bytes()).is_err());
        let empty_module = tool_json("").replace("\"size\":10", "\"size\":0");
        assert!(ToolManifest::from_json(empty_module.as_bytes()).is_err());
    }

    #[test]
    fn schema_is_checked_first() {
        let v2 = tool_json(r#","future":true"#).replace("\"schema\":1", "\"schema\":2");
        assert!(matches!(
            ToolManifest::from_json(v2.as_bytes()),
            Err(ManifestError::UnsupportedSchema { found: 2 })
        ));
        let none = tool_json("").replace("\"schema\":1,", "");
        assert!(matches!(
            ToolManifest::from_json(none.as_bytes()),
            Err(ManifestError::UnsupportedSchema { found: 0 })
        ));
    }

    #[test]
    fn environments() {
        let json = format!(
            r#"{{"schema":1,"name":"node","version":"22.0.0","entry":"bash",
               "packages":[{{"name":"wasmer/bash","version":"1.0.24","sha256":"{H}","size":5}},
                           {{"name":"coreutils","version":"1.0.0","sha256":"{H}","size":5}}]}}"#
        );
        let m = EnvManifest::from_json(json.as_bytes()).unwrap();
        assert_eq!(m.entry, EnvEntry::Bash);
        assert_eq!(EnvManifest::from_json(&m.to_json()).unwrap(), m);
        for (from, to) in [
            ("\"bash\",", "\"zsh\","),
            ("wasmer/bash", "a/b/c"),
            ("wasmer/bash", "coreutils"),
            ("\"size\":5}]", "\"size\":0}]"),
        ] {
            assert!(
                EnvManifest::from_json(json.replacen(from, to, 1).as_bytes()).is_err(),
                "{to}"
            );
        }
        let empty = r#"{"schema":1,"name":"node","version":"22.0.0","entry":"bash","packages":[]}"#;
        assert!(EnvManifest::from_json(empty.as_bytes()).is_err());
    }

    #[test]
    fn environment_caches() {
        let with = |caches: &str| {
            format!(
                r#"{{"schema":1,"name":"go","version":"1.27.6","entry":"bash",
                   "packages":[{{"name":"wasmer/bash","version":"1.0.24","sha256":"{H}","size":5}}],
                   "caches":[{caches}]}}"#
            )
        };
        let go = r#"{"name":"go-build","path":"/root/.cache/go-build","max-bytes":1073741824}"#;
        let m = EnvManifest::from_json(with(go).as_bytes()).unwrap();
        assert_eq!(
            m.caches,
            vec![EnvCache {
                name: "go-build".into(),
                path: "/root/.cache/go-build".into(),
                max_bytes: 1 << 30,
            }]
        );
        assert_eq!(EnvManifest::from_json(&m.to_json()).unwrap(), m);
        // Without caches the canonical form has no `caches` at all, so an
        // environment published before the field reads back unchanged.
        let none = EnvManifest {
            caches: Vec::new(),
            ..m.clone()
        };
        assert!(
            !String::from_utf8(none.to_json())
                .unwrap()
                .contains("caches")
        );
        let other = r#"{"name":"other","path":"/root/other","max-bytes":1048576}"#;
        let cases: Vec<(String, &str)> = vec![
            (
                r#"{"name":"Go","path":"/a","max-bytes":1048576}"#.into(),
                "caches[0].name",
            ),
            (
                r#"{"name":"go","path":"a","max-bytes":1048576}"#.into(),
                "caches[0].path",
            ),
            (
                r#"{"name":"go","path":"/a","max-bytes":1}"#.into(),
                "caches[0].max-bytes",
            ),
            (
                r#"{"name":"go","path":"/a","max-bytes":1048576,"x":1}"#.into(),
                "unknown field",
            ),
            (format!("{go},{go}"), "listed twice"),
            (
                format!(
                    r#"{go},{{"name":"inner","path":"/root/.cache/go-build/x","max-bytes":1048576}}"#
                ),
                "overlaps",
            ),
            ([other; 9].join(","), "more than 8"),
        ];
        for (caches, want) in &cases {
            let err = EnvManifest::from_json(with(caches).as_bytes())
                .unwrap_err()
                .to_string();
            assert!(err.contains(want), "{caches}: {err}");
        }
    }
}
