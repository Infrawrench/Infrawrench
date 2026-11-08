//! The git side of a CI run: a persistent object cache per remote, fetching
//! one commit by its sha, and writing a commit's tree straight from the
//! object database into the run's in-memory [`iwci_vfs::SnapshotBuilder`].
//!
//! The cache is one bare repository per remote under a cache directory,
//! named by the sha256 of the remote's normalised URL. It never has a work
//! tree: checkout reads blobs out of the packs and writes them into the
//! snapshot, so the host disk only ever holds compressed objects, and a
//! commit that a previous run already fetched costs no network at all.
//!
//! Every operation on a remote takes that remote's lock file (an `flock`):
//! shared for reads, exclusive for anything that writes objects or refs, so
//! concurrent runs for one repository serialise their fetches instead of
//! interleaving writes to one object database.
//!
//! Tree contents are untrusted. Every name is validated before it becomes a
//! path, and a tree that would write outside the checkout root, into a
//! `.git` directory, or over an entry it already wrote is refused.

use std::fmt;
use std::path::{Path, PathBuf};

use gix::ObjectId;

mod checkout;
mod commit;
mod diff;
mod fetch;
mod lock;
mod url;

pub use checkout::{Checkout, Submodule};
pub use commit::{ExportedObject, Identity, NewCommit, ObjectKind};

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("invalid remote URL {0}")]
    BadUrl(String),
    #[error("{0:?} is not a full hexadecimal object id")]
    BadObjectId(String),
    #[error("{0:?} is not a usable ref name")]
    BadRefHint(String),
    #[error("commit {0} is not in the cache; fetch it first")]
    NotFetched(String),
    #[error("{id} is a {kind}, not a commit")]
    NotACommit { id: String, kind: String },
    #[error("the remote sent no commit {commit} (asked by sha{})", match hint { Some(h) => format!(" and through {h}"), None => String::new() })]
    NotReachable {
        commit: String,
        hint: Option<String>,
    },
    #[error(
        "fetching {commit} by sha failed ({by_sha}), and so did fetching it through {hint} ({by_hint})"
    )]
    FetchFailed {
        commit: String,
        hint: String,
        by_sha: Box<GitError>,
        by_hint: Box<GitError>,
    },
    #[error("refusing tree entry {name:?} in {parent:?}: {reason}")]
    UnsafeEntry {
        parent: String,
        name: String,
        reason: String,
    },
    #[error("checkout target {0} already has content")]
    TargetNotEmpty(String),
    #[error("{path} is not under {prefix}")]
    OutsidePrefix { path: String, prefix: String },
    #[error("the changes leave the tree of {0} as it was; there is nothing to commit")]
    NothingToCommit(String),
    #[error("git: {0}")]
    Git(#[from] gix::Error),
    #[error(transparent)]
    Vfs(#[from] iwci_vfs::VfsError),
    #[error("{path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub type Result<T> = std::result::Result<T, GitError>;

/// How much history to fetch along with the commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    /// The commit and `n - 1` generations of ancestors; `Shallow(1)` is the
    /// commit alone. Zero is treated as one.
    Shallow(u32),
    /// Everything reachable from the commit.
    Full,
}

/// Credentials for an HTTPS remote. The secret is held in memory only: it
/// is handed to gix when the server asks for authentication, never written
/// into the cache repository's configuration, and never printed (`Debug`
/// redacts it). SSH remotes authenticate with the host's SSH agent and
/// keys, and ignore this.
#[derive(Clone, PartialEq, Eq)]
pub struct Auth {
    username: String,
    secret: String,
}

impl Auth {
    /// A forge token, sent the way GitHub expects an installation or
    /// Actions token: basic auth as `x-access-token:<token>`. GitLab and
    /// Gitea accept the same form for their tokens.
    pub fn token(token: impl Into<String>) -> Self {
        Self::basic("x-access-token", token)
    }

    pub fn basic(username: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            secret: secret.into(),
        }
    }

    pub fn username(&self) -> &str {
        &self.username
    }
}

impl fmt::Debug for Auth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Auth")
            .field("username", &self.username)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// What [`RemoteCache::fetch_commit`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    /// The commit, as full lowercase hex.
    pub commit: String,
    /// Its root tree.
    pub tree: String,
    /// False when the cache already held the commit with enough history,
    /// in which case nothing touched the network.
    pub from_network: bool,
    /// True when the server refused the commit by sha and it was found
    /// through the ref hint instead.
    pub via_ref_hint: bool,
    /// Objects in the packs received; 0 on a cache hit.
    pub objects_received: u64,
}

/// The cache directory. Cheap to clone and safe to share between threads;
/// all state is on disk, guarded by per-remote locks.
#[derive(Debug, Clone)]
pub struct GitCache {
    root: PathBuf,
    max_packs: usize,
}

/// Packs accumulate, one per fetch, and gix has no repack. Past this many
/// the next fetch that needs the network starts the remote's repository
/// over, which costs one full-size shallow fetch and keeps lookups (which
/// probe every pack index) from slowing down without bound.
const DEFAULT_MAX_PACKS: usize = 48;

impl GitCache {
    /// Opens (creating if needed) a cache rooted at `cache_dir`.
    pub fn new(cache_dir: impl Into<PathBuf>) -> Result<Self> {
        let root = cache_dir.into();
        std::fs::create_dir_all(&root).map_err(|source| GitError::Io {
            path: root.clone(),
            source,
        })?;
        fetch::install_tls_provider();
        Ok(Self {
            root,
            max_packs: DEFAULT_MAX_PACKS,
        })
    }

    /// Overrides how many packs a remote's repository may collect before a
    /// fetch starts it over. See [`DEFAULT_MAX_PACKS`].
    pub fn with_max_packs(mut self, max_packs: usize) -> Self {
        self.max_packs = max_packs.max(1);
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The cache of one remote. Nothing is created on disk until the first
    /// fetch.
    pub fn remote(&self, remote_url: &str) -> Result<RemoteCache> {
        let remote = url::parse(remote_url)?;
        Ok(RemoteCache {
            git_dir: self.root.join(format!("{}.git", remote.key)),
            lock_path: self.root.join(format!("{}.lock", remote.key)),
            remote,
            max_packs: self.max_packs,
        })
    }

    /// Shorthand for `self.remote(remote_url)?.fetch_commit(..)` without a
    /// ref hint.
    pub fn fetch_commit(
        &self,
        remote_url: &str,
        commit_sha: &str,
        depth: Depth,
        auth: Option<&Auth>,
    ) -> Result<Fetched> {
        self.remote(remote_url)?
            .fetch_commit(commit_sha, depth, auth, None)
    }
}

/// One remote's slice of the cache: a bare repository and its lock file.
#[derive(Debug, Clone)]
pub struct RemoteCache {
    git_dir: PathBuf,
    lock_path: PathBuf,
    remote: url::Remote,
    max_packs: usize,
}

impl RemoteCache {
    /// The bare repository. Useful for inspection with the `git` CLI; this
    /// crate is the only writer.
    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    /// The URL the cache is keyed by: no credentials, lowercased host, no
    /// trailing `.git`.
    pub fn normalised_url(&self) -> &str {
        &self.remote.normalised
    }

    /// Makes `commit_sha` available in the cache with at least `depth` of
    /// history, touching the network only if it is not already there.
    ///
    /// The commit is asked for by sha (`want <sha>`), which protocol v2
    /// servers including GitHub allow. If that fails and `ref_hint` is
    /// given (`refs/heads/main`, `main`, `refs/pull/7/head`), the hint is
    /// fetched at the same depth, then deeper, and the commit must turn up
    /// in what arrives.
    pub fn fetch_commit(
        &self,
        commit_sha: &str,
        depth: Depth,
        auth: Option<&Auth>,
        ref_hint: Option<&str>,
    ) -> Result<Fetched> {
        let commit = parse_oid(commit_sha)?;
        if let Some(hint) = ref_hint {
            fetch::validate_hint(hint)?;
        }
        let _lock = lock::RemoteLock::acquire(&self.lock_path, lock::Mode::Exclusive)?;
        let auth = auth.or(self.remote.url_auth.as_ref());
        fetch::fetch_commit(self, commit, depth, auth, ref_hint)
    }

    /// Whether the cache holds `commit_sha`, without any network.
    pub fn has_commit(&self, commit_sha: &str) -> Result<bool> {
        let id = parse_oid(commit_sha)?;
        let _lock = lock::RemoteLock::acquire(&self.lock_path, lock::Mode::Shared)?;
        let Some(repo) = self.open_existing()? else {
            return Ok(false);
        };
        Ok(repo.find_commit(id).is_ok())
    }

    /// Writes the tree of `commit_sha` into `builder` under `into` (an
    /// absolute guest path such as `/app`, which must be absent or an empty
    /// directory). Regular and executable files become files, symlinks
    /// become symlinks, and submodules are skipped and listed in the result.
    pub fn checkout_into(
        &self,
        commit_sha: &str,
        builder: &iwci_vfs::SnapshotBuilder,
        into: &str,
    ) -> Result<Checkout> {
        let id = parse_oid(commit_sha)?;
        let _lock = lock::RemoteLock::acquire(&self.lock_path, lock::Mode::Shared)?;
        let repo = self.open_or_not_fetched(commit_sha)?;
        checkout::checkout(&repo, id, builder.fs(), into)
    }

    /// Paths (relative to the repository root, `/`-separated, sorted) whose
    /// content, mode or presence differ between the trees of two cached
    /// commits. A path that changed from a file to a directory or back is
    /// listed along with every file under the directory. Fetch the base
    /// with `Depth::Shallow(1)` if it is not an ancestor within the head's
    /// fetched history.
    pub fn changed_paths(&self, base_sha: &str, head_sha: &str) -> Result<Vec<String>> {
        let base = parse_oid(base_sha)?;
        let head = parse_oid(head_sha)?;
        let _lock = lock::RemoteLock::acquire(&self.lock_path, lock::Mode::Shared)?;
        let repo = self.open_or_not_fetched(head_sha)?;
        diff::changed_paths(&repo, base, head)
    }

    /// Writes a commit whose parent is `head_sha` and whose tree is head's
    /// tree with `changes` applied, into the cache's object database only.
    /// Change paths are absolute guest paths; `strip_prefix` (the checkout
    /// root, such as `/app`) is removed from each. Nothing is pushed: use
    /// [`RemoteCache::export_objects`] to hand the new objects to whatever
    /// uploads them.
    pub fn commit_changes(
        &self,
        head_sha: &str,
        changes: &[iwci_vfs::Change],
        strip_prefix: &str,
        message: &str,
        author: &Identity,
        committer: &Identity,
    ) -> Result<NewCommit> {
        let head = parse_oid(head_sha)?;
        let _lock = lock::RemoteLock::acquire(&self.lock_path, lock::Mode::Exclusive)?;
        let repo = self.open_or_not_fetched(head_sha)?;
        commit::commit_changes(
            &repo,
            head,
            changes,
            strip_prefix,
            message,
            author,
            committer,
        )
    }

    /// Every object reachable from `commit_sha` that is not reachable from
    /// its first parent's tree, ordered so each object comes after
    /// everything it references: blobs, then trees bottom-up, then the
    /// commit. That is the set and order an upload through a forge's Git
    /// Data API needs.
    pub fn export_objects(&self, commit_sha: &str) -> Result<Vec<ExportedObject>> {
        let id = parse_oid(commit_sha)?;
        let _lock = lock::RemoteLock::acquire(&self.lock_path, lock::Mode::Shared)?;
        let repo = self.open_or_not_fetched(commit_sha)?;
        commit::export_objects(&repo, id)
    }

    fn open_existing(&self) -> Result<Option<gix::Repository>> {
        if !fetch::is_ready(&self.git_dir) {
            return Ok(None);
        }
        Ok(Some(fetch::open_repo(&self.git_dir)?))
    }

    fn open_or_not_fetched(&self, sha: &str) -> Result<gix::Repository> {
        self.open_existing()?
            .ok_or_else(|| GitError::NotFetched(sha.to_ascii_lowercase()))
    }
}

pub(crate) fn parse_oid(sha: &str) -> Result<ObjectId> {
    if sha.len() != 40 {
        return Err(GitError::BadObjectId(sha.to_owned()));
    }
    ObjectId::from_hex(sha.as_bytes()).map_err(|_| GitError::BadObjectId(sha.to_owned()))
}

pub(crate) fn find_commit(repo: &gix::Repository, id: ObjectId) -> Result<gix::Commit<'_>> {
    let object = repo
        .try_find_object(id)?
        .ok_or_else(|| GitError::NotFetched(id.to_string()))?;
    if object.kind != gix::objs::Kind::Commit {
        return Err(GitError::NotACommit {
            id: id.to_string(),
            kind: object.kind.to_string(),
        });
    }
    Ok(object.into_commit())
}
