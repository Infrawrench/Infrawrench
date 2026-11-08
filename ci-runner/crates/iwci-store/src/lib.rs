//! Where CI tools and environments live, and how a job gets verified bytes
//! for one.
//!
//! A job names what it runs with `using:`, as `builtin:<name>@<req>`,
//! `repo:<name>@<req>` or `env:<name>@<req>`. [`Catalog::resolve`] lists the
//! name's versions, picks the highest one matching the prefix requirement
//! (see [`VersionReq`]), loads and validates its manifest, and fetches every
//! blob the manifest names, checking each one's size and SHA-256 before
//! handing it over. Storage is Cloudflare R2 through its S3 API
//! ([`R2Store`]), normally behind a disk cache for blobs ([`LayeredStore`]
//! over [`LocalStore`]).
//!
//! # Bucket layout
//!
//! This is the contract the future upload API must follow. Anything that
//! writes to the bucket has to produce exactly these keys, or the runner will
//! not find (or will refuse) what it wrote.
//!
//! | Key | Content | Mutable |
//! |-----|---------|---------|
//! | `blobs/sha256/<hex>` | raw bytes of a wasm module, webc package or data file | never |
//! | `builtins/<name>/<version>.json` | [`ToolManifest`] | never |
//! | `environments/<name>/<version>.json` | [`EnvManifest`] | never |
//! | `repos/<repo_id>/tools/<name>/<version>.json` | [`ToolManifest`] | never |
//!
//! Rules, each enforced on read by this crate:
//!
//! - **Key grammar.** Segments are `[A-Za-z0-9._-]+`, never `.` or `..`, and
//!   the first segment never starts with `.`. Nothing in that set needs
//!   percent-encoding, so a key is the same string in SigV4, on the wire and
//!   on disk.
//! - **`<hex>`** is 64 lowercase hex digits and must be the SHA-256 of the
//!   object. Uppercase is not folded, so each blob has exactly one key.
//! - **`<name>`** matches `[a-z0-9][a-z0-9_-]{0,63}`. With no `.` or `/` it
//!   cannot leave its directory.
//! - **`<version>`** is semver `MAJOR.MINOR.PATCH[-PRERELEASE]`, without
//!   leading zeros and **without build metadata**: `1.0.0+a` and `1.0.0+b`
//!   have equal precedence and would be two keys for one version.
//! - **`<repo_id>`** is the integration's opaque id, `[A-Za-z0-9._-]{1,128}`,
//!   never containing `..`.
//! - **A manifest's `name` and `version` equal its key's.** A manifest
//!   copied to another key is refused, so what a job resolved is what the
//!   manifest claims to be.
//! - **Every listing prefix ends in `/`**, so `repos/a/` never matches
//!   `repos/ab/`, and keys under a listed prefix that are not exactly
//!   `<prefix><version>.json` are ignored.
//! - **Versions are immutable.** Manifests are written create-only
//!   (`If-None-Match: *`); re-publishing identical content is a no-op and
//!   different content is refused. A job that resolved `7.1.3` yesterday
//!   gets the same bytes today.
//! - **Blobs before manifests.** A writer uploads every blob a manifest
//!   names before the manifest, so a reader never sees a manifest whose
//!   blobs are missing.
//!
//! Two rules the runner cannot check and the upload API must:
//!
//! - **Proof of possession.** Builtins and every repository share one blob
//!   namespace, so a manifest can name any blob by digest. If the upload API
//!   accepted a repository manifest naming a digest it was merely told,
//!   repository B could mount repository A's private tool by learning its
//!   hash (from a log line, say). The API must only accept a manifest whose
//!   blobs it received and hashed itself in that repository's upload, or
//!   that repository already uploaded. (Digests then grant nothing: knowing
//!   one means already having the bytes.)
//! - **No blob deletion by reference counting a single manifest.** Because
//!   the namespace is shared, removing a version must never delete its
//!   blobs directly; garbage collection has to mark from every manifest in
//!   the bucket and sweep what is unreached, after a grace period longer
//!   than the longest run (a run resolves manifests and blobs at different
//!   moments).
//!
//! Changes from the first sketch of this layout, and why: build metadata is
//! refused (two keys for one version); hex is lowercase only (two keys for
//! one blob); name and version must match the key (a misplaced manifest
//! would otherwise run under a name it does not have); manifests are
//! create-only rather than check-then-put (two concurrent publishers could
//! both pass the check); and the proof-of-possession rule above, which the
//! shared namespace makes necessary.
//!
//! # Manifests
//!
//! Both are JSON with `"schema": 1` and unknown fields refused. A tool:
//!
//! ```json
//! {
//!   "schema": 1,
//!   "name": "tsc",
//!   "version": "7.1.3",
//!   "abi": "tsc-host",
//!   "module": { "sha256": "<64 hex>", "size": 4194304 },
//!   "files": [{ "path": "/lib/lib.d.ts", "sha256": "<64 hex>", "size": 1024 }],
//!   "args": ["--pretty"],
//!   "env": { "NODE_ENV": "ci" },
//!   "description": "TypeScript, compiled to wasm"
//! }
//! ```
//!
//! `abi` is `wasi`, `wasix` or `tsc-host`. `files`, `args`, `env` and
//! `description` are optional. File paths are absolute, normalised guest
//! paths, mounted read-only. An environment:
//!
//! ```json
//! {
//!   "schema": 1,
//!   "name": "node",
//!   "version": "22.0.0",
//!   "packages": [{ "name": "wasmer/bash", "version": "1.0.24", "sha256": "<64 hex>", "size": 123 }],
//!   "entry": "bash",
//!   "env": { "PATH": "/bin" }
//! }
//! ```
//!
//! Limits: each blob at most [`MAX_BLOB_SIZE`] (256 MiB), the sum of a
//! manifest's blobs at most [`MAX_TOTAL_SIZE`] (1 GiB), at most
//! [`MAX_FILES`] files and [`MAX_PACKAGES`] packages, manifests at most
//! [`MAX_MANIFEST_SIZE`].

mod catalog;
mod error;
pub mod keys;
mod manifest;
mod publish;
mod r2;
mod store;
mod version;

pub use catalog::{Blob, Catalog, Resolved, ToolKind, ToolRef};
pub use error::{Error, ManifestError, StoreError};
pub use keys::{Namespace, RepoId};
pub use manifest::{
    Abi, BlobRef, EnvEntry, EnvManifest, EnvPackage, MAX_BLOB_SIZE, MAX_FILES, MAX_MANIFEST_SIZE,
    MAX_PACKAGES, MAX_TOTAL_SIZE, SCHEMA, ToolFile, ToolManifest, is_valid_guest_path,
};
pub use publish::{
    EnvDraft, FileSource, ManifestOutcome, PackageSource, PublishReport, ToolDraft, publish_env,
    publish_tool,
};
pub use r2::{Credentials, R2Options, R2Store, RetryPolicy, UrlStyle, account_endpoint};
pub use store::{LayeredStore, LocalStore, MAX_OBJECT_SIZE, ObjectMeta, ObjectStore};
pub use version::{PreId, Version, VersionError, VersionReq};
