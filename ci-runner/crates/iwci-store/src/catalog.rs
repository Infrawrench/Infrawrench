//! Turning a `using:` reference into verified bytes.

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{Error, ManifestError};
use crate::keys::{MANIFEST_SUFFIX, Namespace, RepoId, blob_key, is_valid_name, sha256_hex};
use crate::manifest::{EnvManifest, ToolManifest};
use crate::store::ObjectStore;
use crate::version::{Version, VersionReq};

/// Which namespace a reference names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolKind {
    /// `builtin:`, a tool we publish.
    Builtin,
    /// `repo:`, a tool uploaded for the job's own repository.
    Repo,
    /// `env:`, an environment for `run:` scripts.
    Env,
}

impl ToolKind {
    fn label(self) -> &'static str {
        match self {
            ToolKind::Builtin => "builtin",
            ToolKind::Repo => "repo",
            ToolKind::Env => "env",
        }
    }
}

/// A parsed `using:` value: `<kind>:<name>@<version_req>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ToolRef {
    /// The namespace.
    pub kind: ToolKind,
    /// The tool or environment name.
    pub name: String,
    /// The prefix requirement.
    pub version_req: VersionReq,
}

impl fmt::Display for ToolRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}@{}",
            self.kind.label(),
            self.name,
            self.version_req
        )
    }
}

impl FromStr for ToolRef {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let invalid = |reason: &str| Error::InvalidRef {
            input: s.to_owned(),
            reason: reason.to_owned(),
        };
        let (kind, rest) = s
            .split_once(':')
            .ok_or_else(|| invalid("expected `builtin:`, `repo:` or `env:`"))?;
        let kind = match kind {
            "builtin" => ToolKind::Builtin,
            "repo" => ToolKind::Repo,
            "env" => ToolKind::Env,
            _ => return Err(invalid("expected `builtin:`, `repo:` or `env:`")),
        };
        let (name, req) = rest
            .split_once('@')
            .ok_or_else(|| invalid("expected `<name>@<version>`"))?;
        if !is_valid_name(name) {
            return Err(invalid("name must match [a-z0-9][a-z0-9_-]{0,63}"));
        }
        let version_req = req
            .parse()
            .map_err(|e: crate::VersionError| invalid(e.reason))?;
        Ok(ToolRef {
            kind,
            name: name.to_owned(),
            version_req,
        })
    }
}

/// Verified content: the bytes hash to `sha256`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blob {
    /// Lowercase hex SHA-256.
    pub sha256: String,
    /// The content, shared between every job of the run that uses it.
    pub bytes: Arc<[u8]>,
}

/// What a reference resolved to, with every referenced blob fetched and
/// verified.
#[derive(Debug, Clone)]
pub enum Resolved {
    /// A `builtin:` or `repo:` tool.
    Tool {
        /// The manifest.
        manifest: Arc<ToolManifest>,
        /// SHA-256 of the manifest document as stored, for logs and lockfiles:
        /// it pins exactly what ran.
        manifest_sha256: String,
        /// The wasm module.
        module: Blob,
        /// `(guest path, content)` for each data file, in manifest order.
        files: Vec<(String, Blob)>,
    },
    /// An `env:` environment.
    Env {
        /// The manifest.
        manifest: Arc<EnvManifest>,
        /// SHA-256 of the manifest document as stored.
        manifest_sha256: String,
        /// One webc per package, in manifest order.
        packages: Vec<Blob>,
    },
}

#[derive(Debug, Clone)]
enum Loaded {
    Tool(Arc<ToolManifest>, String),
    Env(Arc<EnvManifest>, String),
}

/// A per-key memo where concurrent callers for the same key wait for the
/// first one instead of repeating its work, and failures are not remembered
/// (so a transient network error does not stick for the rest of the run).
struct Memo<V> {
    cells: Mutex<HashMap<String, Arc<Mutex<Option<V>>>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic in another job's resolution leaves the memo consistent (a
    // cell is only ever `None` or a finished value), so poisoning is ignored.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl<V: Clone> Memo<V> {
    fn new() -> Self {
        Self {
            cells: Mutex::new(HashMap::new()),
        }
    }

    fn get_or_try(&self, key: &str, f: impl FnOnce() -> Result<V, Error>) -> Result<V, Error> {
        let cell = lock(&self.cells).entry(key.to_owned()).or_default().clone();
        let mut slot = lock(&cell);
        if let Some(v) = &*slot {
            return Ok(v.clone());
        }
        let v = f()?;
        *slot = Some(v.clone());
        Ok(v)
    }
}

/// Resolves references for one run.
///
/// Listings, manifests and blobs are memoised for the catalog's lifetime, so
/// a matrix of jobs naming the same tool lists the bucket once and fetches
/// each blob once. Make one per run: a long-lived catalog would never see a
/// newly published version.
pub struct Catalog {
    store: Arc<dyn ObjectStore>,
    listings: Memo<Arc<Vec<Version>>>,
    manifests: Memo<Loaded>,
    blobs: Memo<Blob>,
}

impl fmt::Debug for Catalog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Catalog").finish_non_exhaustive()
    }
}

impl Catalog {
    /// A catalog over `store` (typically a `LayeredStore` over `R2Store`).
    pub fn new(store: Arc<dyn ObjectStore>) -> Self {
        Self {
            store,
            listings: Memo::new(),
            manifests: Memo::new(),
            blobs: Memo::new(),
        }
    }

    fn namespace(kind: ToolKind, repo: &RepoId) -> Namespace {
        match kind {
            ToolKind::Builtin => Namespace::Builtin,
            ToolKind::Env => Namespace::Environment,
            // The only place a repository namespace is chosen, and it is
            // always the job's own: a `repo:` reference carries no repo id.
            ToolKind::Repo => Namespace::Repo(repo.clone()),
        }
    }

    /// Every name published as a builtin or an environment, sorted. Repository
    /// tools are not listed: their namespace belongs to one repository.
    pub fn names(&self, kind: ToolKind) -> Result<Vec<String>, Error> {
        let prefix = match kind {
            ToolKind::Builtin => Namespace::Builtin.prefix(),
            ToolKind::Env => Namespace::Environment.prefix(),
            ToolKind::Repo => return Ok(Vec::new()),
        };
        let mut names: Vec<String> = self
            .store
            .list(&prefix)?
            .iter()
            .filter_map(|key| {
                let (name, file) = key.strip_prefix(&prefix)?.split_once('/')?;
                (file.ends_with(MANIFEST_SUFFIX) && !file.contains('/')).then(|| name.to_owned())
            })
            .collect();
        names.dedup();
        Ok(names)
    }

    /// Every published version of a name, highest first, prereleases
    /// included.
    pub fn versions(
        &self,
        kind: ToolKind,
        name: &str,
        repo: &RepoId,
    ) -> Result<Vec<Version>, Error> {
        Ok(self.listing(&Self::namespace(kind, repo), name)?.to_vec())
    }

    fn listing(&self, ns: &Namespace, name: &str) -> Result<Arc<Vec<Version>>, Error> {
        let prefix = ns.versions_prefix(name).map_err(|e| Error::InvalidRef {
            input: name.to_owned(),
            reason: e.to_string(),
        })?;
        self.listings.get_or_try(&prefix, || {
            let mut versions: Vec<Version> = self
                .store
                .list(&prefix)?
                .iter()
                .filter_map(|key| {
                    // Anything that is not exactly `<prefix><version>.json`
                    // (nested keys, stray files, unparseable versions) is not
                    // a version of this name.
                    let rest = key.strip_prefix(&prefix)?;
                    let v = rest.strip_suffix(MANIFEST_SUFFIX)?;
                    if v.contains('/') {
                        return None;
                    }
                    v.parse().ok()
                })
                .collect();
            versions.sort_by(|a, b| b.cmp(a));
            versions.dedup();
            Ok(Arc::new(versions))
        })
    }

    fn load(
        &self,
        kind: ToolKind,
        key: &str,
        name: &str,
        version: &Version,
    ) -> Result<Loaded, Error> {
        self.manifests.get_or_try(key, || {
            let bytes = self.store.get(key)?.ok_or_else(|| Error::ManifestMissing {
                key: key.to_owned(),
            })?;
            let digest = sha256_hex(&bytes);
            let (m_name, m_version, loaded) = match kind {
                ToolKind::Env => {
                    let m = EnvManifest::from_json(&bytes).map_err(|e| Error::manifest(key, e))?;
                    (
                        m.name.clone(),
                        m.version.clone(),
                        Loaded::Env(Arc::new(m), digest),
                    )
                }
                ToolKind::Builtin | ToolKind::Repo => {
                    let m = ToolManifest::from_json(&bytes).map_err(|e| Error::manifest(key, e))?;
                    (
                        m.name.clone(),
                        m.version.clone(),
                        Loaded::Tool(Arc::new(m), digest),
                    )
                }
            };
            // A manifest copied to another name or version's key is refused,
            // so the key a job resolved is always what the manifest claims.
            if m_name != name || &m_version != version {
                return Err(Error::manifest(
                    key,
                    ManifestError::Invalid {
                        field: "name/version".into(),
                        reason: format!(
                            "manifest says {m_name}@{m_version}, its key says {name}@{version}"
                        ),
                    },
                ));
            }
            Ok(loaded)
        })
    }

    /// Fetches a blob and checks its size and digest.
    pub fn blob(&self, sha256: &str, size: u64) -> Result<Blob, Error> {
        let key = blob_key(sha256)?;
        let blob = self.blobs.get_or_try(&key, || {
            let bytes = self.store.get(&key)?.ok_or_else(|| Error::BlobMissing {
                sha256: sha256.to_owned(),
            })?;
            let actual = sha256_hex(&bytes);
            if actual != sha256 {
                return Err(Error::BlobMismatch {
                    sha256: sha256.to_owned(),
                    expected_size: size,
                    actual_size: bytes.len() as u64,
                    actual_sha256: actual,
                });
            }
            Ok(Blob {
                sha256: actual,
                bytes: bytes.into(),
            })
        })?;
        // Checked outside the memo: the digest fixes the content, but two
        // manifests could disagree about its size, and each must be held to
        // its own claim.
        if blob.bytes.len() as u64 != size {
            return Err(Error::BlobMismatch {
                sha256: sha256.to_owned(),
                expected_size: size,
                actual_size: blob.bytes.len() as u64,
                actual_sha256: blob.sha256.clone(),
            });
        }
        Ok(blob)
    }

    /// Resolves `reference` for a job of repository `repo`: picks the highest
    /// matching version, loads and validates its manifest, and fetches and
    /// verifies every blob it names.
    pub fn resolve(&self, reference: &ToolRef, repo: &RepoId) -> Result<Resolved, Error> {
        let ns = Self::namespace(reference.kind, repo);
        let versions = self.listing(&ns, &reference.name)?;
        if versions.is_empty() {
            return Err(Error::NotFound {
                reference: reference.to_string(),
            });
        }
        let Some(version) = reference.version_req.best(versions.iter()) else {
            return Err(Error::NoMatchingVersion {
                reference: reference.to_string(),
                requirement: reference.version_req.to_string(),
                available: versions.iter().map(ToString::to_string).collect(),
            });
        };
        let key = ns.manifest_key(&reference.name, version)?;
        match self.load(reference.kind, &key, &reference.name, version)? {
            Loaded::Tool(manifest, manifest_sha256) => {
                let module = self.blob(&manifest.module.sha256, manifest.module.size)?;
                let files = manifest
                    .files
                    .iter()
                    .map(|f| Ok((f.path.clone(), self.blob(&f.sha256, f.size)?)))
                    .collect::<Result<_, Error>>()?;
                Ok(Resolved::Tool {
                    manifest,
                    manifest_sha256,
                    module,
                    files,
                })
            }
            Loaded::Env(manifest, manifest_sha256) => {
                let packages = manifest
                    .packages
                    .iter()
                    .map(|p| self.blob(&p.sha256, p.size))
                    .collect::<Result<_, Error>>()?;
                Ok(Resolved::Env {
                    manifest,
                    manifest_sha256,
                    packages,
                })
            }
        }
    }
}
