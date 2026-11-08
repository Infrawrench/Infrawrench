//! Fixture repositories built with the `git` CLI and served over `file://`,
//! which gix fetches from by spawning `git-upload-pack`. Nothing here, or in
//! the tests using it, touches the network.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

/// `None` (with the reason printed) when the `git` CLI is unavailable, in
/// which case a test returns early.
pub fn git_or_skip(test: &str) -> Option<()> {
    let ok = Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        eprintln!("skipping {test}: the git CLI is not installed");
        return None;
    }
    Some(())
}

/// A directory removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "iwci-git-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        // Canonical, so file:// URLs built from it match what git reports
        // (on macOS the temp dir is behind a /var -> /private/var link).
        Self(std::fs::canonicalize(&path).unwrap())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs git with the user's global and system config shut out, so commit
/// signing, hooks or templates on the host cannot change a fixture.
pub fn git(dir: &Path, args: &[&str]) -> String {
    git_with_input(dir, args, None)
}

pub fn git_with_input(dir: &Path, args: &[&str], input: Option<&[u8]>) -> String {
    use std::io::Write;
    let mut child = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn git");
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim_end().to_owned()
}

/// A non-bare repository the tests commit to and the cache fetches from.
pub struct Fixture {
    pub dir: TempDir,
    commits: u32,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = TempDir::new("remote");
        git(dir.path(), &["init", "-q", "-b", "main"]);
        Self { dir, commits: 0 }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn url(&self) -> String {
        format!("file://{}", self.path().display())
    }

    pub fn write(&self, rel: &str, bytes: &[u8]) {
        let path = self.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    pub fn remove(&self, rel: &str) {
        let path = self.path().join(rel);
        if path.is_dir() {
            std::fs::remove_dir_all(path).unwrap();
        } else {
            std::fs::remove_file(path).unwrap();
        }
    }

    pub fn symlink(&self, rel: &str, target: &str) {
        let path = self.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, path).unwrap();
    }

    pub fn git(&self, args: &[&str]) -> String {
        git(self.path(), args)
    }

    /// Commits everything in the work tree, with a fixed clock so shas are
    /// stable within a run. Returns the new commit's sha.
    pub fn commit(&mut self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.commit_staged(message)
    }

    /// Commits the index as it stands, for entries (gitlinks) that have no
    /// work tree counterpart for `git add -A` to keep.
    pub fn commit_staged(&mut self, message: &str) -> String {
        self.commits += 1;
        let date = format!("{} +0000", 1_700_000_000 + self.commits * 60);
        let dir = self.path().to_path_buf();
        let mut cmd = Command::new("git");
        let out = cmd
            .args(["commit", "-q", "--allow-empty", "-m", message])
            .current_dir(&dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        self.git(&["rev-parse", "HEAD"])
    }
}

/// `git` against a bare repository, such as the cache's.
pub fn git_dir(git_dir: &Path, args: &[&str]) -> String {
    let mut full = vec!["--git-dir", git_dir.to_str().unwrap()];
    full.extend_from_slice(args);
    git(git_dir.parent().unwrap(), &full)
}
