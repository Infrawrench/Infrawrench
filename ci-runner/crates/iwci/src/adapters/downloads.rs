//! `downloads:` in the object store: each file a job keeps for people to
//! download is one object, `artifacts/<owner>/<repo-id>/<run-id>/<expires>-<id>`.
//!
//! - `<expires>` is the Unix second after which it is no longer served and
//!   may be deleted. It is in the key so that whatever sweeps the bucket
//!   (the proxy's Cron Trigger) and whatever bills it (`storage_usage`)
//!   know it from a listing alone, without reading each object.
//! - `<id>` is the first 32 hex digits of the SHA-256 of the job's id and
//!   the file's path. The store's key grammar is `[A-Za-z0-9._-]`, which a
//!   path or a job id like `build[app/web]` is not, so the path and the job
//!   live in the run's report (the manifest) and the key only has to be
//!   unique within the run.
//!
//! The objects share the owner's storage quota with its caches: an upload
//! that does not fit evicts caches, oldest first, and never another
//! download (see [`super::caches::make_room`]).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use iwci_store::{MAX_OBJECT_SIZE, ObjectStore, RepoId};
use sha2::Digest;

use crate::schedule::{DownloadedFile, Downloads, PendingDownload};

/// Where downloads live in the bucket.
pub const PREFIX: &str = "artifacts";

/// What a runner allows `downloads:` (`--download-max-file`,
/// `--download-max-run`, `--download-max-retention`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadLimits {
    /// The largest one file may be. At most the store's object limit.
    pub max_file: u64,
    /// The most one run may keep, all of its jobs together.
    pub max_run: u64,
    /// The longest a file is kept, whatever its job asks for.
    pub max_retention_secs: u64,
}

impl Default for DownloadLimits {
    fn default() -> Self {
        Self {
            max_file: MAX_OBJECT_SIZE,
            max_run: 1 << 30,
            max_retention_secs: 90 * 86_400,
        }
    }
}

/// The expiry a download's key carries, or `None` for a key that is not
/// one (nothing this runner wrote).
pub fn expiry(key: &str) -> Option<u64> {
    let name = key.rsplit('/').next()?;
    let (expires, id) = name.split_once('-')?;
    (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| expires.parse().ok())
        .flatten()
}

/// The content type a download is served with, from its name, or from
/// whether it is text when the name says nothing.
pub fn content_type(path: &str, text: bool) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e);
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "txt" | "log" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "zst" => "application/zstd",
        "wasm" => "application/wasm",
        _ if text => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// One run's downloads, written to the store as its jobs finish.
pub struct StoreDownloads {
    store: Arc<dyn ObjectStore>,
    owner: String,
    repo: String,
    run: String,
    quota: Option<u64>,
    limits: DownloadLimits,
    /// Kept so far by the run's jobs, held to `limits.max_run`.
    used: AtomicU64,
}

impl StoreDownloads {
    pub fn new(
        store: Arc<dyn ObjectStore>,
        owner: &RepoId,
        repo: &RepoId,
        run: &RepoId,
        quota: Option<u64>,
        limits: DownloadLimits,
    ) -> Self {
        Self {
            store,
            owner: owner.as_str().to_string(),
            repo: repo.as_str().to_string(),
            run: run.as_str().to_string(),
            quota,
            limits,
            used: AtomicU64::new(0),
        }
    }

    fn key(&self, job: &str, path: &str, expires: u64) -> String {
        let mut hash = sha2::Sha256::new();
        hash.update(job.as_bytes());
        hash.update([0]);
        hash.update(path.as_bytes());
        let id = hex::encode(&hash.finalize()[..16]);
        format!(
            "{PREFIX}/{}/{}/{}/{expires}-{id}",
            self.owner, self.repo, self.run
        )
    }
}

fn mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / f64::from(1 << 20))
}

impl Downloads for StoreDownloads {
    fn upload(
        &self,
        job: &str,
        files: Vec<PendingDownload>,
        retention_secs: u64,
    ) -> (Vec<DownloadedFile>, Vec<String>) {
        let mut problems = Vec::new();
        let retention = if retention_secs > self.limits.max_retention_secs {
            problems.push(format!(
                "kept for {} day(s), the longest this runner keeps downloads",
                self.limits.max_retention_secs / 86_400
            ));
            self.limits.max_retention_secs
        } else {
            retention_secs
        };
        let expires = crate::runner::now_secs() + retention;

        // Per file, then the run's total, in the order the job left them.
        let mut accepted = Vec::new();
        for file in files {
            let size = file.data.len() as u64;
            let max_file = self.limits.max_file.min(MAX_OBJECT_SIZE);
            if size > max_file {
                problems.push(format!(
                    "`{}` is {}, over the {} one file may be",
                    file.path,
                    mib(size),
                    mib(max_file)
                ));
                continue;
            }
            let reserved = self
                .used
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                    (used + size <= self.limits.max_run).then_some(used + size)
                });
            if reserved.is_err() {
                problems.push(format!(
                    "`{}` ({}) would take the run past the {} its downloads may hold",
                    file.path,
                    mib(size),
                    mib(self.limits.max_run)
                ));
                continue;
            }
            accepted.push(file);
        }
        let incoming: u64 = accepted.iter().map(|f| f.data.len() as u64).sum();
        let give_back = |files: &[PendingDownload]| {
            let bytes: u64 = files.iter().map(|f| f.data.len() as u64).sum();
            self.used.fetch_sub(bytes, Ordering::SeqCst);
        };
        if accepted.is_empty() {
            return (Vec::new(), problems);
        }
        if let Err(e) = super::caches::make_room(
            self.store.as_ref(),
            &self.owner,
            self.quota,
            "",
            incoming,
            "the job's downloads",
        ) {
            give_back(&accepted);
            problems.push(format!("not kept: {e}"));
            return (Vec::new(), problems);
        }

        let mut kept = Vec::new();
        for file in accepted {
            let key = self.key(job, &file.path, expires);
            let content_type = content_type(&file.path, file.masked);
            match self.store.put(&key, &file.data, content_type) {
                Ok(()) => kept.push(DownloadedFile {
                    sha256: hex::encode(sha2::Sha256::digest(&file.data)),
                    size: file.data.len() as u64,
                    path: file.path,
                    content_type: content_type.to_string(),
                    expires_at: expires,
                    key,
                    masked: file.masked,
                }),
                Err(e) => {
                    give_back(std::slice::from_ref(&file));
                    problems.push(format!("`{}` could not be stored: {e}", file.path));
                }
            }
        }
        (kept, problems)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::caches::storage_usage;

    fn store() -> (Arc<dyn ObjectStore>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "iwci-downloads-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (Arc::new(iwci_store::LocalStore::new(&dir).unwrap()), dir)
    }

    fn id(text: &str) -> RepoId {
        RepoId::new(text).unwrap()
    }

    fn file(path: &str, data: &[u8], masked: bool) -> PendingDownload {
        PendingDownload {
            path: path.into(),
            data: data.to_vec(),
            masked,
        }
    }

    #[test]
    fn files_are_stored_under_the_run_with_a_manifest_and_counted() {
        let (store, dir) = store();
        let downloads = StoreDownloads::new(
            store.clone(),
            &id("github.com-acme"),
            &id("web"),
            &id("0123456789abcdef0123456789abcdef"),
            None,
            DownloadLimits::default(),
        );
        let before = crate::runner::now_secs();
        let (kept, problems) = downloads.upload(
            "build[app/web]",
            vec![
                file("dist/report.html", b"<p>ok</p>", true),
                file("dist/app bundle.bin", &[0, 1, 2], false),
            ],
            7 * 86_400,
        );
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(kept.len(), 2);
        let html = &kept[0];
        assert_eq!(html.path, "dist/report.html");
        assert_eq!(html.size, 9);
        assert_eq!(html.content_type, "text/html; charset=utf-8");
        assert_eq!(html.sha256, hex::encode(sha2::Sha256::digest(b"<p>ok</p>")));
        assert!(html.masked && !kept[1].masked);
        assert_eq!(kept[1].content_type, "application/octet-stream");
        assert!(html.expires_at >= before + 7 * 86_400);
        assert!(
            html.key
                .starts_with("artifacts/github.com-acme/web/0123456789abcdef0123456789abcdef/"),
            "{}",
            html.key
        );
        assert_eq!(expiry(&html.key), Some(html.expires_at));
        assert_ne!(html.key, kept[1].key);
        assert_eq!(store.get(&html.key).unwrap().unwrap(), b"<p>ok</p>");

        let usage = storage_usage(store.as_ref(), &id("github.com-acme"), None).unwrap();
        assert_eq!(usage.downloads, 2);
        assert_eq!(usage.download_bytes, 12);
        assert_eq!(usage.used_bytes, 12);
        assert_eq!(usage.repos["web"].download_bytes, 12);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn limits_and_retention_are_held_to_and_said() {
        let (store, dir) = store();
        let downloads = StoreDownloads::new(
            store.clone(),
            &id("o"),
            &id("r"),
            &id("run"),
            None,
            DownloadLimits {
                max_file: 10,
                max_run: 15,
                max_retention_secs: 86_400,
            },
        );
        let (kept, problems) = downloads.upload(
            "a",
            vec![
                file("big", &[1; 11], false),
                file("one", &[1; 10], false),
                file("two", &[1; 6], false),
                file("three", &[1; 5], false),
            ],
            30 * 86_400,
        );
        let names: Vec<&str> = kept.iter().map(|k| k.path.as_str()).collect();
        assert_eq!(names, ["one", "three"]);
        assert!(problems[0].contains("1 day(s)"), "{problems:?}");
        assert!(problems[1].contains("`big`") && problems[1].contains("one file may be"));
        assert!(problems[2].contains("`two`") && problems[2].contains("the run past"));
        assert!(kept[0].expires_at <= crate::runner::now_secs() + 86_400);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn downloads_share_the_quota_and_evict_caches_but_never_each_other() {
        let (store, dir) = store();
        store
            .put(
                "caches/o/r/b-1/entries/old.zst",
                &[0; 60],
                "application/zstd",
            )
            .unwrap();
        let downloads = |run: &str| {
            StoreDownloads::new(
                store.clone(),
                &id("o"),
                &id("r"),
                &id(run),
                Some(100),
                DownloadLimits::default(),
            )
        };
        // 60 of cache and 50 more do not fit in 100: the cache goes.
        let (kept, problems) = downloads("one").upload("a", vec![file("x", &[1; 50], false)], 3600);
        assert_eq!(kept.len(), 1, "{problems:?}");
        assert!(
            store
                .get("caches/o/r/b-1/entries/old.zst")
                .unwrap()
                .is_none()
        );
        // 50 more fit; 60 more do not, and the first download stays.
        let (kept, _) = downloads("two").upload("a", vec![file("y", &[1; 40], false)], 3600);
        assert_eq!(kept.len(), 1);
        let (kept, problems) =
            downloads("three").upload("a", vec![file("z", &[1; 60], false)], 3600);
        assert!(kept.is_empty());
        assert!(
            problems[0].contains("storage quota is full"),
            "{problems:?}"
        );
        let usage = storage_usage(store.as_ref(), &id("o"), Some(100)).unwrap();
        assert_eq!((usage.downloads, usage.used_bytes), (2, 90));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_expired_download_is_neither_counted_nor_billed() {
        let (store, dir) = store();
        let expired = format!("artifacts/o/r/run/100-{}", "a".repeat(32));
        store.put(&expired, &[0; 10], "text/plain").unwrap();
        assert_eq!(expiry(&expired), Some(100));
        assert_eq!(expiry("artifacts/o/r/run/notone"), None);
        let usage = storage_usage(store.as_ref(), &id("o"), None).unwrap();
        assert_eq!((usage.downloads, usage.used_bytes), (0, 0));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn content_types_come_from_the_name_or_the_text_check() {
        assert_eq!(content_type("a/B.JSON", true), "application/json");
        assert_eq!(content_type("junit", true), "text/plain; charset=utf-8");
        assert_eq!(content_type("core", false), "application/octet-stream");
        assert_eq!(content_type("app.tar.gz", false), "application/gzip");
    }
}
