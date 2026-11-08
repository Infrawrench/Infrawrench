//! Publishing manifests and their blobs, for the script that uploads our
//! builtins and environments.
//!
//! The order is the contract: blobs first, manifest last, manifest written
//! create-only. A reader can therefore never see a manifest whose blobs are
//! not there yet, and a published version can never change underneath a job
//! that already resolved it.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::Error;
use crate::keys::{Namespace, blob_key, sha256_hex};
use crate::manifest::{
    Abi, BlobRef, EnvEntry, EnvManifest, EnvPackage, MAX_BLOB_SIZE, SCHEMA, ToolFile, ToolManifest,
};
use crate::store::ObjectStore;
use crate::version::Version;

/// A data file to publish with a tool.
#[derive(Debug, Clone)]
pub struct FileSource {
    /// Where the guest sees it (absolute).
    pub guest_path: String,
    /// The local file.
    pub source: PathBuf,
}

/// A tool manifest without hashes, plus where its bytes are.
#[derive(Debug, Clone)]
pub struct ToolDraft {
    /// Tool name.
    pub name: String,
    /// Version to publish.
    pub version: Version,
    /// Host interface.
    pub abi: Abi,
    /// The local `.wasm`.
    pub module: PathBuf,
    /// Data files.
    pub files: Vec<FileSource>,
    /// Prefix arguments.
    pub args: Vec<String>,
    /// Guest environment.
    pub env: BTreeMap<String, String>,
    /// Free text.
    pub description: Option<String>,
}

/// A webc package to publish with an environment.
#[derive(Debug, Clone)]
pub struct PackageSource {
    /// Package name, `name` or `namespace/name`.
    pub name: String,
    /// The package's version.
    pub version: Version,
    /// The local `.webc`.
    pub source: PathBuf,
}

/// An environment manifest without hashes, plus where its bytes are.
#[derive(Debug, Clone)]
pub struct EnvDraft {
    /// Environment name.
    pub name: String,
    /// Version to publish.
    pub version: Version,
    /// Packages, in mount order.
    pub packages: Vec<PackageSource>,
    /// What runs the script.
    pub entry: EnvEntry,
    /// Script environment.
    pub env: BTreeMap<String, String>,
    /// Free text.
    pub description: Option<String>,
}

/// Whether the manifest was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestOutcome {
    /// This call published the version.
    Created,
    /// The identical manifest was already there; nothing changed. Re-running
    /// a publish script is therefore safe.
    AlreadyPublished,
}

/// What a publish did.
#[derive(Debug, Clone)]
pub struct PublishReport {
    /// The manifest's key.
    pub manifest_key: String,
    /// SHA-256 of the manifest document.
    pub manifest_sha256: String,
    /// Whether the manifest was written.
    pub outcome: ManifestOutcome,
    /// Digests of blobs this call uploaded.
    pub uploaded: Vec<String>,
    /// Digests of blobs that were already present.
    pub skipped: Vec<String>,
}

const BLOB_TYPE: &str = "application/octet-stream";
const MANIFEST_TYPE: &str = "application/json";

fn read_local(path: &Path) -> Result<Vec<u8>, Error> {
    let local = |source| Error::LocalFile {
        path: path.to_owned(),
        source,
    };
    // Size is checked before reading so an accidental multi-gigabyte path
    // fails fast instead of filling memory.
    let len = fs::metadata(path).map_err(local)?.len();
    if len > MAX_BLOB_SIZE {
        return Err(local(std::io::Error::other(format!(
            "larger than the {MAX_BLOB_SIZE}-byte blob limit"
        ))));
    }
    fs::read(path).map_err(local)
}

/// Publishes a tool under `ns`, which must be [`Namespace::Builtin`] or a
/// [`Namespace::Repo`].
pub fn publish_tool(
    store: &dyn ObjectStore,
    ns: &Namespace,
    draft: &ToolDraft,
) -> Result<(ToolManifest, PublishReport), Error> {
    if *ns == Namespace::Environment {
        return Err(Error::InvalidRef {
            input: draft.name.clone(),
            reason: "tools publish to builtins or a repository, not environments".into(),
        });
    }
    let module = read_local(&draft.module)?;
    let mut blobs = vec![module];
    let mut files = Vec::with_capacity(draft.files.len());
    for f in &draft.files {
        let bytes = read_local(&f.source)?;
        files.push(ToolFile {
            path: f.guest_path.clone(),
            sha256: sha256_hex(&bytes),
            size: bytes.len() as u64,
        });
        blobs.push(bytes);
    }
    let manifest = ToolManifest {
        schema: SCHEMA,
        name: draft.name.clone(),
        version: draft.version.clone(),
        abi: draft.abi,
        module: BlobRef {
            sha256: sha256_hex(&blobs[0]),
            size: blobs[0].len() as u64,
        },
        files,
        args: draft.args.clone(),
        env: draft.env.clone(),
        description: draft.description.clone(),
    };
    let key = ns.manifest_key(&manifest.name, &manifest.version)?;
    manifest.validate().map_err(|e| Error::manifest(&key, e))?;
    let report = publish(store, &key, &manifest.to_json(), &blobs, |b| {
        ToolManifest::from_json(b).is_ok_and(|m| m == manifest)
    })?;
    Ok((manifest, report))
}

/// Publishes an environment.
pub fn publish_env(
    store: &dyn ObjectStore,
    draft: &EnvDraft,
) -> Result<(EnvManifest, PublishReport), Error> {
    let mut blobs = Vec::with_capacity(draft.packages.len());
    let mut packages = Vec::with_capacity(draft.packages.len());
    for p in &draft.packages {
        let bytes = read_local(&p.source)?;
        packages.push(EnvPackage {
            name: p.name.clone(),
            version: p.version.clone(),
            sha256: sha256_hex(&bytes),
            size: bytes.len() as u64,
        });
        blobs.push(bytes);
    }
    let manifest = EnvManifest {
        schema: SCHEMA,
        name: draft.name.clone(),
        version: draft.version.clone(),
        packages,
        entry: draft.entry,
        env: draft.env.clone(),
        description: draft.description.clone(),
    };
    let key = Namespace::Environment.manifest_key(&manifest.name, &manifest.version)?;
    manifest.validate().map_err(|e| Error::manifest(&key, e))?;
    let report = publish(store, &key, &manifest.to_json(), &blobs, |b| {
        EnvManifest::from_json(b).is_ok_and(|m| m == manifest)
    })?;
    Ok((manifest, report))
}

/// Uploads blobs then the manifest. `same` decides whether an existing
/// manifest document is the one being published; it compares parsed
/// manifests, so reformatting alone is not a conflict.
fn publish(
    store: &dyn ObjectStore,
    key: &str,
    document: &[u8],
    blobs: &[Vec<u8>],
    same: impl Fn(&[u8]) -> bool,
) -> Result<PublishReport, Error> {
    let existing_outcome = |existing: Option<Vec<u8>>| match existing {
        Some(b) if same(&b) => Ok(Some((ManifestOutcome::AlreadyPublished, sha256_hex(&b)))),
        Some(_) => Err(Error::VersionExists {
            key: key.to_owned(),
        }),
        None => Ok(None),
    };
    // Checked before uploading anything, so a version conflict costs nothing.
    let mut outcome = existing_outcome(store.get(key)?)?;

    let mut uploaded = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = HashSet::new();
    for bytes in blobs {
        let digest = sha256_hex(bytes);
        if !seen.insert(digest.clone()) {
            continue;
        }
        let bkey = blob_key(&digest)?;
        match store.head(&bkey)? {
            // Same digest and length is the same content; nothing to do.
            Some(meta) if meta.size == bytes.len() as u64 => skipped.push(digest),
            // A wrong-length object at a content address is corruption, and
            // the right bytes are in hand, so it is repaired.
            _ => {
                store.put(&bkey, bytes, BLOB_TYPE)?;
                uploaded.push(digest);
            }
        }
    }

    if outcome.is_none() {
        outcome = Some(if store.put_if_absent(key, document, MANIFEST_TYPE)? {
            (ManifestOutcome::Created, sha256_hex(document))
        } else {
            // Lost a race with another publisher: fine if it published the
            // same thing, a conflict otherwise.
            existing_outcome(store.get(key)?)?.ok_or_else(|| Error::ManifestMissing {
                key: key.to_owned(),
            })?
        });
    }
    let (outcome, manifest_sha256) = outcome.expect("set above");
    Ok(PublishReport {
        manifest_key: key.to_owned(),
        // The digest of the document as stored, which after a re-publish of
        // a reformatted manifest is the old document's.
        manifest_sha256,
        outcome,
        uploaded,
        skipped,
    })
}
