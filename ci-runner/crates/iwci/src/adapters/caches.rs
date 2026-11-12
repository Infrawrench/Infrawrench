//! `cache:` entries in the object store (`iwci-store`'s key table has the
//! layout). The same store as the tools, so on R2 every runner shares them.

use std::io::Read;
use std::sync::Arc;

use iwci_spec::Event;
use iwci_store::{ObjectStore, RepoId};
use iwci_vfs::{Entry, archive};
use sha2::Digest;

use crate::schedule::{Caches, Restored};

pub struct StoreCaches {
    store: Arc<dyn ObjectStore>,
    /// Who the caches are billed to and counted against: a GitHub
    /// organisation or user (see [`owner_from_url`]).
    owner: String,
    repo: String,
    /// The owner's storage quota in bytes, across all of its repositories.
    quota: Option<u64>,
    /// Where this run saves.
    write_scope: String,
    /// Where it looks, in order: its own scope, then the default branch's.
    read_scopes: Vec<String>,
}

fn short_hash(text: &str) -> String {
    hex::encode(&sha2::Sha256::digest(text.as_bytes())[..16])
}

impl StoreCaches {
    /// Caches for a run of `repo` on `branch`. A pull request saves into a
    /// scope of its own and reads the default branch's, but nothing it
    /// writes is ever read by a push to the default branch: an untrusted
    /// change cannot plant what the default branch builds from.
    pub fn new(
        store: Arc<dyn ObjectStore>,
        owner: &RepoId,
        repo: &RepoId,
        branch: &str,
        default_branch: &str,
        event: Event,
        quota: Option<u64>,
    ) -> Self {
        let push_scope = |b: &str| format!("b-{}", short_hash(b));
        let write_scope = match event {
            Event::Push => push_scope(branch),
            Event::PullRequest => format!("pr-{}", short_hash(branch)),
            // A scheduled run builds the default branch's own code.
            Event::Schedule => push_scope(branch),
        };
        let mut read_scopes = vec![write_scope.clone()];
        let default_scope = push_scope(default_branch);
        if !read_scopes.contains(&default_scope) {
            read_scopes.push(default_scope);
        }
        Self {
            store,
            owner: owner.as_str().to_string(),
            repo: repo.as_str().to_string(),
            quota,
            write_scope,
            read_scopes,
        }
    }

    fn entry_key(&self, scope: &str, key: &str) -> String {
        format!(
            "caches/{}/{}/{scope}/entries/{}.zst",
            self.owner,
            self.repo,
            short_hash(key)
        )
    }

    fn prefix_key(&self, scope: &str, prefix: &str) -> String {
        format!(
            "caches/{}/{}/{scope}/prefixes/{}",
            self.owner,
            self.repo,
            short_hash(prefix)
        )
    }

    /// Makes room for `incoming` bytes at `object` within the owner's
    /// quota by deleting the owner's least recently saved entries.
    fn make_room(&self, object: &str, incoming: u64) -> Result<(), String> {
        make_room(
            self.store.as_ref(),
            &self.owner,
            self.quota,
            object,
            incoming,
            "the cache",
        )
    }

    fn load(&self, object: &str, key: &str, max_bytes: u64) -> Result<Option<Vec<Entry>>, String> {
        let Some(bytes) = self.store.get(object).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let mut decoder =
            zstd::stream::Decoder::new(bytes.as_slice()).map_err(|e| e.to_string())?;
        // The stored key comes first, so a hash collision (or a stale
        // pointer) is noticed rather than restoring the wrong cache.
        let mut len = [0u8; 4];
        decoder.read_exact(&mut len).map_err(|e| e.to_string())?;
        let mut stored = vec![0u8; u32::from_le_bytes(len) as usize];
        decoder.read_exact(&mut stored).map_err(|e| e.to_string())?;
        if stored != key.as_bytes() {
            return Ok(None);
        }
        let entries = archive::decode(&mut decoder, max_bytes).map_err(|e| e.to_string())?;
        Ok(Some(entries))
    }
}

/// Makes room for `incoming` bytes (`what`, at `object`) within `owner`'s
/// storage quota, which its caches and its downloads share. Only caches are
/// ever evicted, least recently saved first: a cache can be rebuilt, and a
/// download is kept for as long as its job asked. A download past its
/// expiry is not counted, whether or not it has been swept yet.
pub fn make_room(
    store: &dyn ObjectStore,
    owner: &str,
    quota: Option<u64>,
    object: &str,
    incoming: u64,
    what: &str,
) -> Result<(), String> {
    let Some(quota) = quota else {
        return Ok(());
    };
    if incoming > quota {
        return Err(format!(
            "{what} is {} KiB, more than the owner's whole {} KiB storage quota",
            incoming.div_ceil(1024),
            quota.div_ceil(1024)
        ));
    }
    let mut objects = store
        .list_detailed(&format!("caches/{owner}/"))
        .map_err(|e| e.to_string())?;
    // The entry being replaced frees its own bytes.
    objects.retain(|o| o.key != object);
    let now = crate::runner::now_secs();
    let downloads: u64 = store
        .list_detailed(&format!("{}/{owner}/", crate::adapters::downloads::PREFIX))
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|o| crate::adapters::downloads::expiry(&o.key).is_none_or(|e| e > now))
        .map(|o| o.size)
        .sum();
    let mut used: u64 = objects.iter().map(|o| o.size).sum::<u64>() + downloads;
    if used + incoming <= quota {
        return Ok(());
    }
    // Oldest first; entries before the small prefix pointers, so a
    // pointer is only dropped when nothing else is left to drop.
    let mut candidates: Vec<_> = objects
        .into_iter()
        .filter(|o| o.key.ends_with(".zst"))
        .collect();
    candidates.sort_by_key(|o| (o.modified.unwrap_or(0), o.key.clone()));
    for victim in candidates {
        if used + incoming <= quota {
            break;
        }
        store.delete(&victim.key).map_err(|e| e.to_string())?;
        used = used.saturating_sub(victim.size);
    }
    if used + incoming > quota {
        return Err("the owner's storage quota is full".into());
    }
    Ok(())
}

/// What an owner stores (its caches and its downloads), for the storage
/// endpoint and billing.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct StorageUsage {
    pub owner: String,
    /// Caches and downloads together: what the quota holds and what is
    /// billed.
    pub used_bytes: u64,
    pub quota_bytes: Option<u64>,
    /// Cache entries.
    pub entries: u64,
    /// Of `used_bytes`, the downloads (`downloads:`) not yet expired.
    pub download_bytes: u64,
    pub downloads: u64,
    pub repos: std::collections::BTreeMap<String, RepoUsage>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct RepoUsage {
    /// Caches and downloads together.
    pub bytes: u64,
    pub entries: u64,
    pub download_bytes: u64,
    pub downloads: u64,
}

/// Everything stored for `owner`, broken down by repository.
pub fn storage_usage(
    store: &dyn ObjectStore,
    owner: &RepoId,
    quota: Option<u64>,
) -> Result<StorageUsage, String> {
    let prefix = format!("caches/{}/", owner.as_str());
    let mut usage = StorageUsage {
        owner: owner.as_str().to_string(),
        quota_bytes: quota,
        ..Default::default()
    };
    let repo_of = |key: &str, prefix: &str| {
        key[prefix.len()..]
            .split('/')
            .next()
            .unwrap_or_default()
            .to_string()
    };
    for object in store.list_detailed(&prefix).map_err(|e| e.to_string())? {
        let entry = usage
            .repos
            .entry(repo_of(&object.key, &prefix))
            .or_default();
        entry.bytes += object.size;
        usage.used_bytes += object.size;
        if object.key.ends_with(".zst") {
            entry.entries += 1;
            usage.entries += 1;
        }
    }
    let prefix = format!("{}/{}/", crate::adapters::downloads::PREFIX, owner.as_str());
    let now = crate::runner::now_secs();
    for object in store.list_detailed(&prefix).map_err(|e| e.to_string())? {
        // Expired and not swept yet: no longer served, so not billed.
        if crate::adapters::downloads::expiry(&object.key).is_some_and(|e| e <= now) {
            continue;
        }
        let entry = usage
            .repos
            .entry(repo_of(&object.key, &prefix))
            .or_default();
        entry.bytes += object.size;
        entry.download_bytes += object.size;
        entry.downloads += 1;
        usage.used_bytes += object.size;
        usage.download_bytes += object.size;
        usage.downloads += 1;
    }
    Ok(usage)
}

/// What clearing a repository's caches removed.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Cleared {
    pub owner: String,
    #[serde(rename = "repo-id")]
    pub repo_id: String,
    /// Objects deleted: cache entries and the pointers `restore-keys` read.
    pub deleted_objects: u64,
    pub deleted_bytes: u64,
    /// Of those, cache entries (`cache:` and `task-cache:` alike).
    pub deleted_entries: u64,
}

/// How many deletes run at once when clearing: each is a round trip to the
/// store, and a repository can hold thousands of entries.
const CLEAR_THREADS: usize = 8;

/// Deletes everything stored for one repository of `owner`: every branch's
/// and pull request's `cache:` and `task-cache:` entries and their prefix
/// pointers, which is what [`storage_usage`] counts for it as caches.
/// Nothing outside `caches/<owner>/<repo>/` is touched, so its downloads
/// (`artifacts/`, which keep their own retention), other repositories,
/// other owners and the runners' own caches (git objects, installs,
/// compiled modules) stay. A run saving while this runs may leave its entry behind.
pub fn clear_repository(
    store: &dyn ObjectStore,
    owner: &RepoId,
    repo: &RepoId,
) -> Result<Cleared, String> {
    // The trailing slash keeps `web` from matching `web-admin`.
    let prefix = format!("caches/{}/{}/", owner.as_str(), repo.as_str());
    let objects = store.list_detailed(&prefix).map_err(|e| e.to_string())?;
    let mut cleared = Cleared {
        owner: owner.as_str().to_string(),
        repo_id: repo.as_str().to_string(),
        ..Default::default()
    };
    let chunk = objects.len().div_ceil(CLEAR_THREADS).max(1);
    let prefix = prefix.as_str();
    let results: Vec<Result<Cleared, String>> = std::thread::scope(|threads| {
        let handles: Vec<_> = objects
            .chunks(chunk)
            .map(|part| {
                threads.spawn(move || {
                    let mut done = Cleared::default();
                    for object in part {
                        debug_assert!(object.key.starts_with(prefix));
                        store.delete(&object.key).map_err(|e| e.to_string())?;
                        done.deleted_objects += 1;
                        done.deleted_bytes += object.size;
                        if object.key.ends_with(".zst") {
                            done.deleted_entries += 1;
                        }
                    }
                    Ok(done)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err("a delete panicked".into())))
            .collect()
    });
    let mut first_error = None;
    for result in results {
        match result {
            Ok(done) => {
                cleared.deleted_objects += done.deleted_objects;
                cleared.deleted_bytes += done.deleted_bytes;
                cleared.deleted_entries += done.deleted_entries;
            }
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    match first_error {
        // Some deletes may have landed; the next clear finishes the rest.
        Some(e) => Err(format!(
            "{e} (deleted {} of {} objects first)",
            cleared.deleted_objects,
            objects.len()
        )),
        None => Ok(cleared),
    }
}

/// The owner a repository's usage belongs to: `github.com-<org>` for
/// `https://github.com/<org>/<repo>` (also `git@github.com:<org>/...`),
/// lowercased so `Infrawrench` and `infrawrench` are one owner. `None`
/// when the URL has no owner segment.
pub fn owner_from_url(url: &str) -> Option<String> {
    // `scheme://[user@]host[:port]/org/...`, or scp-style
    // `user@host:org/...`, where the colon separates the path.
    let (rest, scp) = match url.split_once("://") {
        Some((_, rest)) => (rest, false),
        None => (url, true),
    };
    let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
    let (host, path) = if scp {
        rest.split_once(':')?
    } else {
        rest.split_once('/')?
    };
    let host = host.split(':').next().unwrap_or(host);
    let org = path.trim_start_matches('/').split('/').next()?;
    if host.is_empty() || org.is_empty() {
        return None;
    }
    let owner: String = format!("{host}-{org}")
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    RepoId::new(&owner).ok().map(|_| owner)
}

impl Caches for StoreCaches {
    fn restore(
        &self,
        key: &str,
        restore_keys: &[String],
        max_bytes: u64,
    ) -> Result<Option<Restored>, String> {
        // The exact key is read in every scope at once (a pull request has
        // two: its own, then the default branch's), so an entry the default
        // branch saved does not cost a miss in the other first. The answer
        // is still the first scope's that has one, and an error in a scope
        // only counts if no scope before it had the entry.
        let found = match self.read_scopes.as_slice() {
            [only] => self.load(&self.entry_key(only, key), key, max_bytes)?,
            scopes => std::thread::scope(|threads| {
                let loads: Vec<_> = scopes[1..]
                    .iter()
                    .map(|scope| {
                        let object = self.entry_key(scope, key);
                        threads.spawn(move || self.load(&object, key, max_bytes))
                    })
                    .collect();
                let mut found = self.load(&self.entry_key(&scopes[0], key), key, max_bytes);
                for load in loads {
                    let next = load
                        .join()
                        .unwrap_or_else(|_| Err("the cache read panicked".into()));
                    if matches!(found, Ok(None)) {
                        found = next;
                    }
                }
                found
            })?,
        };
        if let Some(entries) = found {
            return Ok(Some(Restored {
                key: key.to_string(),
                exact: true,
                entries,
            }));
        }
        for prefix in restore_keys {
            for scope in &self.read_scopes {
                let Some(pointer) = self
                    .store
                    .get(&self.prefix_key(scope, prefix))
                    .map_err(|e| e.to_string())?
                else {
                    continue;
                };
                let Ok(found) = String::from_utf8(pointer) else {
                    continue;
                };
                if !found.starts_with(prefix.as_str()) {
                    continue;
                }
                if let Some(entries) =
                    self.load(&self.entry_key(scope, &found), &found, max_bytes)?
                {
                    return Ok(Some(Restored {
                        key: found,
                        exact: false,
                        entries,
                    }));
                }
            }
        }
        Ok(None)
    }

    fn save(&self, key: &str, restore_keys: &[String], entries: &[Entry]) -> Result<(), String> {
        let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3).map_err(|e| e.to_string())?;
        encoder.include_checksum(true).map_err(|e| e.to_string())?;
        let header = u32::try_from(key.len()).map_err(|_| "key too long".to_string())?;
        std::io::Write::write_all(&mut encoder, &header.to_le_bytes())
            .map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut encoder, key.as_bytes()).map_err(|e| e.to_string())?;
        archive::encode(&mut encoder, entries).map_err(|e| e.to_string())?;
        let bytes = encoder.finish().map_err(|e| e.to_string())?;
        let scope = &self.write_scope;
        let object = self.entry_key(scope, key);
        self.make_room(&object, bytes.len() as u64)?;
        self.store
            .put(&object, &bytes, "application/zstd")
            .map_err(|e| e.to_string())?;
        // Point each prefix this key falls under at it, so the next run's
        // `restore-keys` finds the newest without listing anything.
        for prefix in restore_keys.iter().filter(|p| key.starts_with(p.as_str())) {
            self.store
                .put(
                    &self.prefix_key(scope, prefix),
                    key.as_bytes(),
                    "text/plain",
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn store() -> (Arc<dyn ObjectStore>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "iwci-caches-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (Arc::new(iwci_store::LocalStore::new(&dir).unwrap()), dir)
    }

    fn entries(text: &str) -> Vec<Entry> {
        vec![
            Entry::Dir {
                path: "/app/.cache".into(),
            },
            Entry::File {
                path: "/app/.cache/x".into(),
                data: text.as_bytes().to_vec().into(),
            },
        ]
    }

    #[test]
    fn exact_keys_prefixes_and_branch_scopes() {
        let (store, dir) = store();
        let repo = RepoId::new("repo_1").unwrap();
        let org = RepoId::new("github.com-acme").unwrap();
        let main = StoreCaches::new(
            store.clone(),
            &org,
            &repo,
            "main",
            "main",
            Event::Push,
            None,
        );
        main.save("tsc-web-aaa", &["tsc-web-".into()], &entries("main"))
            .unwrap();

        // Exact hit, and the newest under a prefix.
        let hit = main.restore("tsc-web-aaa", &[], 1 << 20).unwrap().unwrap();
        assert!(hit.exact);
        let partial = main
            .restore("tsc-web-bbb", &["tsc-web-".into()], 1 << 20)
            .unwrap()
            .unwrap();
        assert_eq!(
            (partial.key.as_str(), partial.exact),
            ("tsc-web-aaa", false)
        );
        assert!(
            main.restore("tsc-web-bbb", &["other-".into()], 1 << 20)
                .unwrap()
                .is_none()
        );

        // A feature branch reads the default branch's cache...
        let feature = StoreCaches::new(
            store.clone(),
            &org,
            &repo,
            "feature",
            "main",
            Event::Push,
            None,
        );
        assert!(
            feature
                .restore("tsc-web-aaa", &[], 1 << 20)
                .unwrap()
                .is_some()
        );
        // ...and its own saves stay in its own scope.
        feature
            .save("tsc-web-ccc", &["tsc-web-".into()], &entries("feature"))
            .unwrap();
        assert!(main.restore("tsc-web-ccc", &[], 1 << 20).unwrap().is_none());
        let newest = feature
            .restore("tsc-web-ddd", &["tsc-web-".into()], 1 << 20)
            .unwrap()
            .unwrap();
        assert_eq!(newest.key, "tsc-web-ccc", "own scope first");

        // A pull request from a branch named `main` still cannot write
        // where pushes to main read.
        let pr = StoreCaches::new(
            store.clone(),
            &org,
            &repo,
            "main",
            "main",
            Event::PullRequest,
            None,
        );
        pr.save("tsc-web-aaa", &[], &entries("poisoned")).unwrap();
        let after = main.restore("tsc-web-aaa", &[], 1 << 20).unwrap().unwrap();
        assert_eq!(after.entries, entries("main"));
        assert_eq!(
            pr.restore("tsc-web-aaa", &[], 1 << 20)
                .unwrap()
                .unwrap()
                .entries,
            entries("poisoned")
        );

        // Another repository sees nothing.
        let other = StoreCaches::new(
            store,
            &org,
            &RepoId::new("repo_2").unwrap(),
            "main",
            "main",
            Event::Push,
            None,
        );
        assert!(
            other
                .restore("tsc-web-aaa", &["tsc-web-".into()], 1 << 20)
                .unwrap()
                .is_none()
        );

        // A cache bigger than the job may hold is refused, not loaded.
        assert!(main.restore("tsc-web-aaa", &[], 2).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn big(n: usize) -> Vec<Entry> {
        // Pseudo-random bytes (xorshift), which zstd cannot shrink.
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15 ^ n as u64;
        let data: Vec<u8> = (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        vec![Entry::File {
            path: "/app/blob".into(),
            data: data.into(),
        }]
    }

    #[test]
    fn the_owners_quota_evicts_its_oldest_caches_first() {
        let (store, dir) = store();
        let org = RepoId::new("github.com-acme").unwrap();
        let caches = |repo: &str| {
            StoreCaches::new(
                store.clone(),
                &org,
                &RepoId::new(repo).unwrap(),
                "main",
                "main",
                Event::Push,
                Some(300 << 10),
            )
        };
        caches("web").save("one", &[], &big(100 << 10)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        caches("api").save("two", &[], &big(100 << 10)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // A third entry would pass 300 KiB: the oldest, in another repo of
        // the same owner, goes.
        caches("web").save("three", &[], &big(150 << 10)).unwrap();
        assert!(
            caches("web")
                .restore("one", &[], 1 << 30)
                .unwrap()
                .is_none()
        );
        assert!(
            caches("api")
                .restore("two", &[], 1 << 30)
                .unwrap()
                .is_some()
        );
        assert!(
            caches("web")
                .restore("three", &[], 1 << 30)
                .unwrap()
                .is_some()
        );

        let usage = storage_usage(store.as_ref(), &org, Some(300 << 10)).unwrap();
        assert!(usage.used_bytes <= 300 << 10, "{usage:?}");
        assert_eq!(usage.entries, 2);
        assert_eq!(
            usage.repos.keys().cloned().collect::<Vec<_>>(),
            vec!["api", "web"]
        );

        // Larger than the whole quota: refused, nothing evicted.
        let err = caches("web")
            .save("huge", &[], &big(400 << 10))
            .unwrap_err();
        assert!(err.contains("storage quota"), "{err}");
        assert_eq!(
            storage_usage(store.as_ref(), &org, None).unwrap().entries,
            2
        );

        // Another owner's caches are untouched by this owner's quota.
        let other = RepoId::new("github.com-other").unwrap();
        assert_eq!(
            storage_usage(store.as_ref(), &other, None)
                .unwrap()
                .used_bytes,
            0
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn clearing_a_repository_removes_only_its_caches() {
        let (store, dir) = store();
        let acme = RepoId::new("github.com-acme").unwrap();
        let other = RepoId::new("github.com-other").unwrap();
        let caches = |owner: &RepoId, repo: &str, branch: &str, event: Event| {
            StoreCaches::new(
                store.clone(),
                owner,
                &RepoId::new(repo).unwrap(),
                branch,
                "main",
                event,
                None,
            )
        };
        // `web` on two branches and a pull request, with prefix pointers.
        caches(&acme, "web", "main", Event::Push)
            .save("deps-1", &["deps-".into()], &entries("main"))
            .unwrap();
        caches(&acme, "web", "feature", Event::Push)
            .save("deps-2", &["deps-".into()], &entries("feature"))
            .unwrap();
        caches(&acme, "web", "pull/3", Event::PullRequest)
            .save("deps-3", &[], &entries("pr"))
            .unwrap();
        // A repository whose name starts with `web`, and another owner's `web`.
        caches(&acme, "web-admin", "main", Event::Push)
            .save("deps-1", &[], &entries("admin"))
            .unwrap();
        caches(&other, "web", "main", Event::Push)
            .save("deps-1", &[], &entries("theirs"))
            .unwrap();
        // Something outside `caches/` entirely.
        store
            .put("usage/github.com-acme/x.json", b"{}", "application/json")
            .unwrap();
        // A download of `web`'s, which is not a cache.
        let download = format!(
            "artifacts/github.com-acme/web/run/99999999999-{}",
            "a".repeat(32)
        );
        store.put(&download, b"report", "text/plain").unwrap();

        let before = storage_usage(store.as_ref(), &acme, None).unwrap();
        let web = before.repos["web"].clone();
        assert_eq!(web.entries, 3);

        let cleared =
            clear_repository(store.as_ref(), &acme, &RepoId::new("web").unwrap()).unwrap();
        assert_eq!(cleared.deleted_entries, 3);
        assert_eq!(cleared.deleted_objects, 5, "three entries and two pointers");
        assert_eq!(cleared.deleted_bytes, web.bytes - web.download_bytes);

        let after = storage_usage(store.as_ref(), &acme, None).unwrap();
        // Only the download is left of `web`.
        assert_eq!(after.repos["web"].entries, 0, "{after:?}");
        assert_eq!(after.repos["web"].bytes, 6);
        assert_eq!(after.repos["web"].downloads, 1);
        assert!(store.get(&download).unwrap().is_some());
        assert_eq!(after.repos["web-admin"].entries, 1);
        assert!(
            caches(&acme, "web", "main", Event::Push)
                .restore("deps-1", &["deps-".into()], 1 << 20)
                .unwrap()
                .is_none()
        );
        assert!(
            caches(&other, "web", "main", Event::Push)
                .restore("deps-1", &[], 1 << 20)
                .unwrap()
                .is_some()
        );
        assert!(store.get("usage/github.com-acme/x.json").unwrap().is_some());

        // Clearing again finds nothing, and is not an error.
        let again = clear_repository(store.as_ref(), &acme, &RepoId::new("web").unwrap()).unwrap();
        assert_eq!((again.deleted_objects, again.deleted_bytes), (0, 0));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn owners_come_from_the_repository_url() {
        assert_eq!(
            owner_from_url("https://github.com/Infrawrench/Infrawrench").as_deref(),
            Some("github.com-infrawrench")
        );
        assert_eq!(
            owner_from_url("https://github.com/acme/web.git").as_deref(),
            Some("github.com-acme")
        );
        assert_eq!(
            owner_from_url("git@github.com:acme/web.git").as_deref(),
            Some("github.com-acme")
        );
        assert_eq!(
            owner_from_url("https://x-access-token:t@github.com/acme/web").as_deref(),
            Some("github.com-acme")
        );
        assert_eq!(
            owner_from_url("https://gitlab.example.com:8443/team/proj").as_deref(),
            Some("gitlab.example.com-team")
        );
        // A local path has no organisation; the caller falls back to `local`.
        assert!(owner_from_url("file:///tmp/repo").is_none_or(|o| !o.contains("github")));
    }
}
