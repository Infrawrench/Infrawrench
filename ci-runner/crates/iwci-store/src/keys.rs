//! Object key grammar and the layout of the bucket.
//!
//! Every key any store accepts goes through [`validate_key`], so the grammar
//! here is what keeps a `LocalStore` key from naming a path outside its root
//! and what keeps a crafted name from addressing another namespace in R2.

use std::fmt;

use crate::error::StoreError;
use crate::version::Version;

/// Longest key accepted. S3 allows 1024 bytes; staying at that limit means a
/// key valid here is valid in every S3-compatible store.
pub const MAX_KEY_LEN: usize = 1024;

/// Prefix of the immutable content namespace.
pub const BLOBS_PREFIX: &str = "blobs/sha256/";
/// Prefix of builtin tool manifests.
pub const BUILTINS_PREFIX: &str = "builtins/";
/// Prefix of environment manifests.
pub const ENVIRONMENTS_PREFIX: &str = "environments/";
/// Prefix of per-repository namespaces.
pub const REPOS_PREFIX: &str = "repos/";
/// Suffix of every manifest object.
pub const MANIFEST_SUFFIX: &str = ".json";

/// Checks a full object key.
///
/// A key is one or more `/`-separated segments. Each segment is made of
/// `[A-Za-z0-9._-]`, is neither `.` nor `..`, and the first segment does not
/// start with `.` (that keeps `LocalStore`'s staging directory unaddressable).
/// The set is deliberately small: nothing in it needs percent-encoding, so the
/// key signed by SigV4, the key on the wire and the key on disk are the same
/// string, and no Unicode normalisation or case folding can make two keys
/// collide on one file.
pub fn validate_key(key: &str) -> Result<(), StoreError> {
    validate_path_like(key, false)
}

/// Checks a listing prefix: the key grammar, except that it may be empty, may
/// end in `/`, and its last segment may be a partial segment.
pub fn validate_prefix(prefix: &str) -> Result<(), StoreError> {
    if prefix.is_empty() {
        return Ok(());
    }
    validate_path_like(prefix, true)
}

fn validate_path_like(key: &str, is_prefix: bool) -> Result<(), StoreError> {
    let bad = |reason: &'static str| StoreError::InvalidKey {
        key: key.to_owned(),
        reason,
    };
    if key.len() > MAX_KEY_LEN {
        return Err(bad("longer than 1024 bytes"));
    }
    let body = if is_prefix {
        key.strip_suffix('/').unwrap_or(key)
    } else {
        key
    };
    if body.is_empty() {
        return Err(bad("empty"));
    }
    for (i, segment) in body.split('/').enumerate() {
        if segment.is_empty() {
            return Err(bad("empty segment"));
        }
        if segment == "." || segment == ".." {
            return Err(bad("`.` or `..` segment"));
        }
        if i == 0 && segment.starts_with('.') {
            return Err(bad("first segment starts with `.`"));
        }
        if !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return Err(bad("characters outside [A-Za-z0-9._-]"));
        }
    }
    Ok(())
}

/// Checks a tool, environment or package name: `[a-z0-9][a-z0-9_-]{0,63}`.
///
/// Names are a key segment, so excluding `.` and `/` here is what stops a name
/// from stepping out of `<prefix>/<name>/`.
pub fn is_valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

/// Checks a lowercase hex SHA-256 digest.
///
/// Uppercase is refused rather than folded so a blob has exactly one key.
pub fn is_valid_sha256(hex: &str) -> bool {
    hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// An opaque repository id from the integration, validated as
/// `[A-Za-z0-9._-]{1,128}` with no `..` anywhere and not `.` itself.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RepoId(String);

impl RepoId {
    /// Validates and wraps a repository id.
    pub fn new(id: impl Into<String>) -> Result<Self, StoreError> {
        let id = id.into();
        let ok = (1..=128).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            && !id.contains("..")
            && id != ".";
        if ok {
            Ok(Self(id))
        } else {
            Err(StoreError::InvalidKey {
                key: id,
                reason: "repository id must match [A-Za-z0-9._-]{1,128} without `..`",
            })
        }
    }

    /// The id as given.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RepoId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("RepoId").field(&self.0).finish()
    }
}

impl fmt::Display for RepoId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Where a manifest lives. Each variant maps to one fixed prefix, and the
/// variant for user tools carries the repository, so the only way to build a
/// key under `repos/<id>/` is to hold that `RepoId`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Namespace {
    /// `builtins/`
    Builtin,
    /// `environments/`
    Environment,
    /// `repos/<repo_id>/tools/`
    Repo(RepoId),
}

impl Namespace {
    /// The prefix all of this namespace's names live under, ending in `/`.
    pub fn prefix(&self) -> String {
        match self {
            Namespace::Builtin => BUILTINS_PREFIX.to_owned(),
            Namespace::Environment => ENVIRONMENTS_PREFIX.to_owned(),
            Namespace::Repo(id) => format!("{REPOS_PREFIX}{}/tools/", id.as_str()),
        }
    }

    /// The prefix listed to find a name's versions: `<prefix><name>/`.
    ///
    /// The name is checked again here rather than trusted from the caller,
    /// because this string is what a crafted `repo:` name would have to bend.
    pub fn versions_prefix(&self, name: &str) -> Result<String, StoreError> {
        if !is_valid_name(name) {
            return Err(StoreError::InvalidKey {
                key: name.to_owned(),
                reason: "name must match [a-z0-9][a-z0-9_-]{0,63}",
            });
        }
        Ok(format!("{}{name}/", self.prefix()))
    }

    /// The key of one manifest: `<prefix><name>/<version>.json`.
    pub fn manifest_key(&self, name: &str, version: &Version) -> Result<String, StoreError> {
        let key = format!("{}{version}{MANIFEST_SUFFIX}", self.versions_prefix(name)?);
        validate_key(&key)?;
        Ok(key)
    }
}

/// The key of a blob: `blobs/sha256/<hex>`.
pub fn blob_key(sha256: &str) -> Result<String, StoreError> {
    if !is_valid_sha256(sha256) {
        return Err(StoreError::InvalidKey {
            key: sha256.to_owned(),
            reason: "not a lowercase hex sha256",
        });
    }
    Ok(format!("{BLOBS_PREFIX}{sha256}"))
}

/// The digest a `blobs/sha256/<hex>` key names, if it is one.
pub fn blob_digest(key: &str) -> Option<&str> {
    key.strip_prefix(BLOBS_PREFIX)
        .filter(|h| is_valid_sha256(h))
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    hex::encode(sha2::Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_grammar() {
        for ok in [
            "blobs/sha256/ab",
            "builtins/tsc/7.1.3.json",
            "a",
            "a/.b",
            "a/b-c_d.e",
        ] {
            validate_key(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        for bad in [
            "",
            "/a",
            "a/",
            "a//b",
            "a/../b",
            "..",
            "a/.",
            ".staging/x",
            "a\\b",
            "a b",
            "a/%2e%2e",
            "a/\u{e9}",
            "a\0b",
        ] {
            assert!(validate_key(bad).is_err(), "{bad:?} accepted");
        }
        assert!(validate_key(&"a".repeat(1025)).is_err());
        validate_prefix("").unwrap();
        validate_prefix("builtins/").unwrap();
        validate_prefix("builtins/ts").unwrap();
        assert!(validate_prefix("/").is_err());
        assert!(validate_prefix("../").is_err());
    }

    #[test]
    fn names_and_repo_ids() {
        assert!(is_valid_name("tsc"));
        assert!(is_valid_name("0x"));
        assert!(is_valid_name(&"a".repeat(64)));
        for bad in ["", "-a", "_a", "A", "a.b", "a/b", "..", &"a".repeat(65)] {
            assert!(!is_valid_name(bad), "{bad:?} accepted");
        }
        RepoId::new("gh-123.abc_D").unwrap();
        RepoId::new("a".repeat(128)).unwrap();
        for bad in ["", ".", "..", "a..b", "a/b", "a b", &"a".repeat(129)] {
            assert!(RepoId::new(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn repo_prefixes_do_not_overlap() {
        // `repos/a/` must not be a prefix of `repos/ab/`, which is why every
        // listing prefix ends in `/`.
        let a = Namespace::Repo(RepoId::new("a").unwrap());
        let ab = Namespace::Repo(RepoId::new("ab").unwrap());
        let pa = a.versions_prefix("x").unwrap();
        let kab = ab.manifest_key("x", &"1.0.0".parse().unwrap()).unwrap();
        assert_eq!(pa, "repos/a/tools/x/");
        assert!(!kab.starts_with(&pa));
        assert!(a.versions_prefix("../ab/tools/x").is_err());
    }

    #[test]
    fn blob_keys() {
        let h = sha256_hex(b"");
        assert_eq!(
            h,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(blob_digest(&blob_key(&h).unwrap()), Some(h.as_str()));
        assert!(blob_key(&h.to_uppercase()).is_err());
        assert!(blob_key("abc").is_err());
    }
}
