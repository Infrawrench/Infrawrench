//! Fetching one commit of a git repository: how a package whose lock pins
//! a commit rather than a file hash is verified, since the commit id pins
//! every byte of its tree. Composer packages without a dist hash and
//! Bundler's `GIT` sources both come this way.

/// One file of a git tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeFile {
    /// Relative and `/`-separated.
    pub path: String,
    pub data: Vec<u8>,
    pub executable: bool,
}

/// Fetches one commit of a git repository.
pub trait GitTrees: Send + Sync {
    /// Every file of `commit`'s tree in the repository at `url`.
    fn files(&self, url: &str, commit: &str) -> std::result::Result<Vec<TreeFile>, String>;
}

/// A [`GitTrees`] that has nothing: every package must carry a file hash.
pub struct NoGit;

impl GitTrees for NoGit {
    fn files(&self, url: &str, _commit: &str) -> std::result::Result<Vec<TreeFile>, String> {
        Err(format!(
            "{url}: fetching git repositories is not set up here"
        ))
    }
}
