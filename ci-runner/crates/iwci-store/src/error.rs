//! Error types. Nothing here ever carries a credential: R2 requests are
//! authenticated by header, so not even a URL in an error can hold one.

use std::path::PathBuf;

use crate::version::VersionError;

/// A failure inside an [`ObjectStore`](crate::ObjectStore).
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The key or prefix is outside the grammar in [`crate::keys`].
    #[error("invalid key {key:?}: {reason}")]
    InvalidKey {
        /// The offending key.
        key: String,
        /// What rule it broke.
        reason: &'static str,
    },
    /// A filesystem operation failed.
    #[error("{op} {}: {source}", path.display())]
    Io {
        /// What was being done.
        op: &'static str,
        /// Where.
        path: PathBuf,
        /// The underlying error.
        #[source]
        source: std::io::Error,
    },
    /// The server answered with a status that is not success, not-found or a
    /// retried server error.
    #[error("{method} {key}: HTTP {status}{}", code.as_deref().map(|c| format!(" ({c})")).unwrap_or_default())]
    Http {
        /// HTTP method.
        method: &'static str,
        /// Object key or listing prefix.
        key: String,
        /// Status code.
        status: u16,
        /// The S3 `<Code>` from the error body, when there was one.
        code: Option<String>,
    },
    /// The request never got a response (connection, TLS, timeout), after
    /// every retry.
    #[error("{method} {key}: {message}")]
    Transport {
        /// HTTP method.
        method: &'static str,
        /// Object key or listing prefix.
        key: String,
        /// The client's description.
        message: String,
    },
    /// An object is bigger than [`crate::MAX_OBJECT_SIZE`].
    #[error("{key}: object larger than {limit} bytes")]
    TooLarge {
        /// Object key.
        key: String,
        /// The cap that was hit.
        limit: u64,
    },
    /// The server's response could not be understood.
    #[error("{what}")]
    InvalidResponse {
        /// Description.
        what: String,
    },
    /// The store was configured wrongly.
    #[error("invalid store configuration: {0}")]
    Config(String),
}

/// A manifest that does not parse or does not validate.
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    /// Not JSON, or JSON of the wrong shape (unknown field, wrong type).
    #[error("malformed manifest: {0}")]
    Json(#[from] serde_json::Error),
    /// A `schema` this build does not understand.
    #[error("unsupported manifest schema {found} (this runner reads schema 1)")]
    UnsupportedSchema {
        /// The value found, or 0 when absent or not a number.
        found: u64,
    },
    /// A field breaks a rule.
    #[error("{field}: {reason}")]
    Invalid {
        /// Dotted path to the field, such as `files[2].path`.
        field: String,
        /// The rule, in prose.
        reason: String,
    },
    /// A version string that is not semver.
    #[error(transparent)]
    Version(#[from] VersionError),
}

/// A failure resolving, fetching or publishing a tool or environment.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The store failed.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// A `using:` reference that does not parse.
    #[error("invalid tool reference {input:?}: {reason}")]
    InvalidRef {
        /// What was given.
        input: String,
        /// Why it was refused.
        reason: String,
    },
    /// No version of the name is published at all.
    #[error("{reference}: nothing is published under this name")]
    NotFound {
        /// The reference, as `kind:name@req`.
        reference: String,
    },
    /// Versions exist, none matches.
    #[error("{reference}: no version matches {requirement}; available: {}", if available.is_empty() { "none".to_owned() } else { available.join(", ") })]
    NoMatchingVersion {
        /// The reference, as `kind:name@req`.
        reference: String,
        /// The requirement.
        requirement: String,
        /// Every published version, highest first, prereleases included.
        available: Vec<String>,
    },
    /// The listing named a version whose manifest then failed to load.
    #[error("manifest {key}: {source}")]
    Manifest {
        /// The manifest's key.
        key: String,
        /// What was wrong with it.
        #[source]
        source: ManifestError,
    },
    /// A listed manifest vanished between the listing and the fetch.
    #[error("manifest {key} was listed but could not be fetched")]
    ManifestMissing {
        /// The manifest's key.
        key: String,
    },
    /// A manifest names a blob that is not in the store.
    #[error("blob {sha256} is referenced but missing from the store")]
    BlobMissing {
        /// The digest.
        sha256: String,
    },
    /// A blob's bytes are not the ones its manifest promised.
    #[error(
        "blob {sha256} failed verification: expected {expected_size} bytes, got {actual_size} bytes hashing to {actual_sha256}"
    )]
    BlobMismatch {
        /// The digest the manifest names.
        sha256: String,
        /// The size the manifest names.
        expected_size: u64,
        /// The size received.
        actual_size: u64,
        /// The digest of what was received.
        actual_sha256: String,
    },
    /// Publishing would change a version that is already published.
    #[error(
        "{key} is already published with different content; versions are immutable, publish a new version"
    )]
    VersionExists {
        /// The manifest's key.
        key: String,
    },
    /// A local file given to `publish` could not be read.
    #[error("read {}: {source}", path.display())]
    LocalFile {
        /// The file.
        path: PathBuf,
        /// The underlying error.
        #[source]
        source: std::io::Error,
    },
}

impl Error {
    pub(crate) fn manifest(key: &str, source: impl Into<ManifestError>) -> Self {
        Error::Manifest {
            key: key.to_owned(),
            source: source.into(),
        }
    }
}
