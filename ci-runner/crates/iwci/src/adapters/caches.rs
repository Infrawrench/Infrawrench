//! `cache:` entries in the object store (`iwci-store`'s key table has the
//! layout). The same store as the tools, so on R2 every runner shares them.

use std::collections::BTreeMap;
use std::io::Read;
use std::sync::Arc;

use iwci_spec::Event;
use iwci_store::{ObjectStore, RepoId};
use iwci_vfs::{Entry, archive};
use sha2::Digest;

use crate::schedule::{Caches, Durations, History, Restored};

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
    /// Largest object an entry is stored in; a bigger entry is split into
    /// parts (see [`StoreCaches::save_with_modes`]). [`PART_BYTES`],
    /// smaller in tests.
    part_bytes: u64,
    /// How old another save's parts must be before a save of the same key
    /// removes them ([`STALE_PARTS_SECS`]; 0 in tests).
    stale_parts_secs: u64,
}

/// The most an entry's object holds before the entry is split. Well under
/// the store's cap ([`iwci_store::MAX_OBJECT_SIZE`]): R2's reader refuses
/// a body of exactly the cap, which a part filled to it was, so every split
/// entry was saved and then never read. Smaller parts also go up and come
/// down in parallel.
const PART_BYTES: u64 = 64 << 20;
const _: () = assert!(PART_BYTES < iwci_store::MAX_OBJECT_SIZE);

/// Parts of another save of the same key younger than this are left: jobs
/// of one run sharing a key save at the same moment, and the last to
/// write its header must find its parts. Older ones are what a replaced
/// save left, and go; eviction and clearing take the rest.
const STALE_PARTS_SECS: u64 = 3600;

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
            // A manual run builds a branch of the repository itself, as a
            // push to that branch would.
            Event::Manual => push_scope(branch),
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
            part_bytes: PART_BYTES,
            stale_parts_secs: STALE_PARTS_SECS,
        }
    }

    /// Where this run saves its entries, and where it reads them, in
    /// order: what a run computing a task cache key marks and looks at
    /// (`adapters::inflight`).
    pub fn scopes(&self) -> (&str, &[String]) {
        (&self.write_scope, &self.read_scopes)
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

    /// The entry at `object` if it is `key`'s, with its modes. One a runner
    /// of another archive format wrote is a miss: the next save replaces it,
    /// and so is one whose parts are not all there.
    fn load(
        &self,
        object: &str,
        key: &str,
        max_bytes: u64,
    ) -> Result<Option<(Vec<Entry>, archive::ModeList)>, String> {
        let Some(bytes) = self.store.get(object).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        // The stored key comes first, so a hash collision (or a stale
        // pointer) is noticed rather than restoring the wrong cache.
        let stored = read_header(&bytes)?;
        let bytes = if stored == key.as_bytes() {
            bytes
        } else if let Some((nonce, parts)) = parts_of(&stored, key) {
            // Not more parts than `max_bytes` could fill, whatever the
            // header says.
            let most = max_bytes.div_ceil(self.part_bytes.max(1)) + 2;
            if parts as u64 > most {
                return Ok(None);
            }
            match self.load_parts(object, nonce, parts, bytes)? {
                Some(all) => all,
                None => return Ok(None),
            }
        } else {
            return Ok(None);
        };
        let mut decoder =
            zstd::stream::Decoder::new(bytes.as_slice()).map_err(|e| e.to_string())?;
        skip_header(&mut decoder)?;
        match archive::decode_with_modes(&mut decoder, max_bytes) {
            Ok(found) => Ok(Some(found)),
            Err(e) if archive::is_other_format(&e) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// The first part of a split entry followed by the rest, read at once.
    /// `None` when one is missing: evicted, or replaced by another save.
    fn load_parts(
        &self,
        object: &str,
        nonce: &str,
        parts: usize,
        first: Vec<u8>,
    ) -> Result<Option<Vec<u8>>, String> {
        let rest: Vec<Result<Option<Vec<u8>>, String>> = std::thread::scope(|threads| {
            let reads: Vec<_> = (1..parts)
                .map(|i| {
                    let key = part_key(object, nonce, i);
                    threads.spawn(move || self.store.get(&key).map_err(|e| e.to_string()))
                })
                .collect();
            reads
                .into_iter()
                .map(|r| {
                    r.join()
                        .unwrap_or_else(|_| Err("a cache read panicked".into()))
                })
                .collect()
        });
        let mut all = first;
        for part in rest {
            match part? {
                Some(bytes) => all.extend_from_slice(&bytes),
                None => return Ok(None),
            }
        }
        Ok(Some(all))
    }
}

/// The key an entry was saved under, from the start of its first object.
fn read_header(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = zstd::stream::Decoder::new(bytes).map_err(|e| e.to_string())?;
    let mut len = [0u8; 4];
    decoder.read_exact(&mut len).map_err(|e| e.to_string())?;
    let mut stored = vec![0u8; u32::from_le_bytes(len) as usize];
    decoder.read_exact(&mut stored).map_err(|e| e.to_string())?;
    Ok(stored)
}

fn skip_header(decoder: &mut impl Read) -> Result<(), String> {
    let mut len = [0u8; 4];
    decoder.read_exact(&mut len).map_err(|e| e.to_string())?;
    let len = u64::from(u32::from_le_bytes(len));
    let skipped =
        std::io::copy(&mut decoder.take(len), &mut std::io::sink()).map_err(|e| e.to_string())?;
    if skipped != len {
        return Err("cache entry ends inside its header".into());
    }
    Ok(())
}

/// A split entry's header is its key, a NUL, the save's nonce, a NUL and
/// how many objects it spans. A runner from before split entries reads
/// that as another key, a clean miss, rather than a truncated archive.
fn split_header(key: &str, nonce: &str, parts: usize) -> Vec<u8> {
    format!("{key}\0{nonce}\0{parts}").into_bytes()
}

fn parts_of<'a>(stored: &'a [u8], key: &str) -> Option<(&'a str, usize)> {
    let rest = stored.strip_prefix(key.as_bytes())?.strip_prefix(b"\0")?;
    let rest = std::str::from_utf8(rest).ok()?;
    let (nonce, parts) = rest.split_once('\0')?;
    let valid = nonce.len() == 16 && nonce.bytes().all(|b| b.is_ascii_hexdigit());
    let parts: usize = parts.parse().ok()?;
    (valid && parts >= 2).then_some((nonce, parts))
}

/// Where part `i` (from 1; part 0 is the entry object itself) of a split
/// entry lives: beside it, under a name that does not end in `.zst`, so
/// it is never counted as an entry of its own.
fn part_key(object: &str, nonce: &str, i: usize) -> String {
    format!("{object}.{nonce}-{i}")
}

/// One zstd frame holding `header` with its length before it.
fn header_frame(header: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3).map_err(|e| e.to_string())?;
    encoder.include_checksum(true).map_err(|e| e.to_string())?;
    let len = u32::try_from(header.len()).map_err(|_| "key too long".to_string())?;
    std::io::Write::write_all(&mut encoder, &len.to_le_bytes()).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut encoder, header).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
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
    // One eviction per owner at a time: jobs that finish together would
    // otherwise each list the same oldest entries and delete them all over
    // again, one request at a time. The next finds the room already made.
    let lock = owner_lock(store, owner);
    let mut estimate = lock.lock().unwrap_or_else(|e| e.into_inner());
    let now = crate::runner::now_secs();
    // Listing every object an owner keeps (thousands of task cache entries)
    // for each save took longer than the save: a recent listing's total,
    // with what was saved since added on, says whether there is room. It
    // only overcounts on this runner (a replaced entry is not taken off);
    // another runner's saves since are what [`ESTIMATE_SECS`] bounds.
    if let Some(known) = estimate.as_mut()
        && now < known.listed_at.saturating_add(ESTIMATE_SECS)
        && known.used.saturating_add(incoming) <= quota
    {
        known.used += incoming;
        return Ok(());
    }
    let mut objects = store
        .list_detailed(&format!("caches/{owner}/"))
        .map_err(|e| e.to_string())?;
    // The entry being replaced frees its own bytes, its parts' too.
    let own_parts = format!("{object}.");
    objects.retain(|o| o.key != object && !o.key.starts_with(&own_parts));
    let downloads: u64 = store
        .list_detailed(&format!("{}/{owner}/", crate::adapters::downloads::PREFIX))
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|o| crate::adapters::downloads::expiry(&o.key).is_none_or(|e| e > now))
        .map(|o| o.size)
        .sum();
    let mut used: u64 = objects.iter().map(|o| o.size).sum::<u64>() + downloads;
    if used + incoming <= quota {
        *estimate = Some(Estimate {
            used: used + incoming,
            listed_at: now,
        });
        return Ok(());
    }
    // Oldest first; entries before the small prefix pointers, so a
    // pointer is only dropped when nothing else is left to drop. A split
    // entry goes with its parts.
    let (mut candidates, parts): (Vec<_>, Vec<_>) =
        objects.into_iter().partition(|o| o.key.ends_with(".zst"));
    candidates.sort_by_key(|o| (o.modified.unwrap_or(0), o.key.clone()));
    let mut doomed: Vec<String> = Vec::new();
    for victim in candidates {
        if used + incoming <= quota {
            break;
        }
        used = used.saturating_sub(victim.size);
        let its_parts = format!("{}.", victim.key);
        for part in parts.iter().filter(|p| p.key.starts_with(&its_parts)) {
            doomed.push(part.key.clone());
            used = used.saturating_sub(part.size);
        }
        doomed.push(victim.key);
    }
    if used + incoming > quota {
        return Err("the owner's storage quota is full".into());
    }
    // Small entries (a task cache's) can mean hundreds of deletes, each a
    // round trip: several at once. A part deleted before its entry only
    // makes that entry a miss.
    delete_all(store, &doomed)?;
    *estimate = Some(Estimate {
        used: used + incoming,
        listed_at: now,
    });
    Ok(())
}

/// How long a listing of an owner's storage stands in for a new one.
const ESTIMATE_SECS: u64 = 120;

/// An owner's storage as last listed, with what this process saved since.
struct Estimate {
    used: u64,
    listed_at: u64,
}

/// The lock that keeps one eviction per owner at a time in this process,
/// with the owner's [`Estimate`].
fn owner_lock(store: &dyn ObjectStore, owner: &str) -> Arc<std::sync::Mutex<Option<Estimate>>> {
    type Locks = std::sync::Mutex<BTreeMap<String, Arc<std::sync::Mutex<Option<Estimate>>>>>;
    static LOCKS: std::sync::OnceLock<Locks> = std::sync::OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // By store too: one process has one, but tests open many.
    let store = store as *const dyn ObjectStore as *const () as usize;
    locks
        .entry(format!("{store:x}/{owner}"))
        .or_default()
        .clone()
}

/// Deletes `keys` on [`CLEAR_THREADS`] threads; the first error wins.
fn delete_all(store: &dyn ObjectStore, keys: &[String]) -> Result<(), String> {
    if keys.is_empty() {
        return Ok(());
    }
    let chunk = keys.len().div_ceil(CLEAR_THREADS).max(1);
    std::thread::scope(|threads| {
        let handles: Vec<_> = keys
            .chunks(chunk)
            .map(|part| {
                threads.spawn(move || {
                    for key in part {
                        store.delete(key).map_err(|e| e.to_string())?;
                    }
                    Ok::<(), String>(())
                })
            })
            .collect();
        handles
            .into_iter()
            .try_for_each(|h| h.join().unwrap_or_else(|_| Err("a delete panicked".into())))
    })
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
        if let Some((entries, modes)) = found {
            return Ok(Some(Restored {
                key: key.to_string(),
                exact: true,
                entries,
                modes,
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
                if let Some((entries, modes)) =
                    self.load(&self.entry_key(scope, &found), &found, max_bytes)?
                {
                    return Ok(Some(Restored {
                        key: found,
                        exact: false,
                        entries,
                        modes,
                    }));
                }
            }
        }
        Ok(None)
    }

    /// Saves an entry as a header frame (its key) followed by the archive.
    /// One bigger than an object may be is split: the first object keeps
    /// the entry's key and says how many parts follow, and the parts sit
    /// beside it, written before it so a reader that sees the new header
    /// finds them. A save's parts carry a nonce, so two runners saving the
    /// same key never mix theirs, and the last save's parts are the ones kept.
    fn has(&self, key: &str) -> bool {
        self.store
            .head(&self.entry_key(&self.write_scope, key))
            .is_ok_and(|meta| meta.is_some())
    }

    fn claim(&self, key: &str) -> bool {
        saving()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(self.entry_key(&self.write_scope, key))
    }

    fn save_with_modes(
        &self,
        key: &str,
        restore_keys: &[String],
        entries: &[Entry],
        modes: &[(std::path::PathBuf, u32)],
    ) -> Result<(), String> {
        let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3).map_err(|e| e.to_string())?;
        encoder.include_checksum(true).map_err(|e| e.to_string())?;
        archive::encode_with_modes(&mut encoder, entries, modes).map_err(|e| e.to_string())?;
        let body = encoder.finish().map_err(|e| e.to_string())?;
        let scope = &self.write_scope;
        let object = self.entry_key(scope, key);
        // A claim on the key ([`Caches::claim`]) ends with the save.
        let _claimed = Claimed(object.clone());
        let part = usize::try_from(self.part_bytes)
            .unwrap_or(usize::MAX)
            .max(1);

        let mut header = header_frame(key.as_bytes())?;
        let mut nonce = None;
        if header.len() + body.len() > part {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
            let fresh = hex::encode(bytes);
            // The part count is in the header, whose length changes the
            // count: settle on one that holds both.
            let mut parts = 2;
            loop {
                header = header_frame(&split_header(key, &fresh, parts))?;
                let need = (header.len() + body.len()).div_ceil(part);
                if need <= parts {
                    break;
                }
                parts = need;
            }
            nonce = Some(fresh);
        }
        let total = (header.len() + body.len()) as u64;
        self.make_room(&object, total)?;

        // The first object is the header and as much body as fits.
        let first_body = part.saturating_sub(header.len()).min(body.len());
        let (head, tail) = body.split_at(first_body);
        if let Some(nonce) = &nonce {
            let chunks: Vec<&[u8]> = tail.chunks(part).collect();
            let written: Vec<Result<(), String>> = std::thread::scope(|threads| {
                let puts: Vec<_> = chunks
                    .iter()
                    .enumerate()
                    .map(|(i, chunk)| {
                        let key = part_key(&object, nonce, i + 1);
                        threads.spawn(move || {
                            self.store
                                .put(&key, chunk, "application/octet-stream")
                                .map_err(|e| e.to_string())
                        })
                    })
                    .collect();
                puts.into_iter()
                    .map(|p| {
                        p.join()
                            .unwrap_or_else(|_| Err("a cache write panicked".into()))
                    })
                    .collect()
            });
            written.into_iter().collect::<Result<(), String>>()?;
        }
        let mut first = header;
        first.extend_from_slice(head);
        self.store
            .put(&object, &first, "application/zstd")
            .map_err(|e| e.to_string())?;
        // Parts an earlier save of this key left: replaced now. Not a
        // concurrent save's, whose header may yet land after this one's.
        let mine = nonce.as_deref().map(|n| format!("{object}.{n}-"));
        let now = crate::runner::now_secs();
        let stale = self
            .store
            .list_detailed(&format!("{object}."))
            .map_err(|e| e.to_string())?;
        for old in stale {
            let replaced = old
                .modified
                .is_some_and(|m| m.saturating_add(self.stale_parts_secs) <= now);
            if replaced && mine.as_deref().is_none_or(|m| !old.key.starts_with(m)) {
                self.store.delete(&old.key).map_err(|e| e.to_string())?;
            }
        }
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

/// The entries a job of this process is saving now, by object.
fn saving() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static SAVING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    SAVING.get_or_init(Default::default)
}

/// Releases a claim on an entry when its save ends, however it ends.
struct Claimed(String);

impl Drop for Claimed {
    fn drop(&mut self) {
        saving()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// Where a pipeline's job durations live among the caches, and the one
/// file of the entry.
fn durations_key(pipeline: &str) -> String {
    format!("iwci-durations/{pipeline}")
}
const DURATIONS_FILE: &str = "/iwci/durations.json";
/// More than any pipeline's durations take; a bigger entry is not read.
const MAX_DURATIONS: u64 = 4 << 20;

/// What the durations entry holds. A runner from before `held_mib` reads
/// the entry without it and writes it back without it, which costs the
/// next run its estimates and nothing else, so the version stays 1.
#[derive(serde::Serialize, serde::Deserialize)]
struct DurationsRecord {
    version: u32,
    /// Milliseconds each job took, by job id.
    jobs: BTreeMap<String, u64>,
    /// What each job held of the runner's memory, in MiB, by job id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    held_mib: BTreeMap<String, u64>,
}

/// Job durations kept beside the caches, in the same scopes: a branch reads
/// its own, then the default branch's, and a pull request's never reach
/// the default branch. One small entry per pipeline, counted toward the
/// owner's quota like any other.
impl Durations for StoreCaches {
    fn load_history(&self, pipeline: &str) -> History {
        let Ok(Some(found)) = self.restore(&durations_key(pipeline), &[], MAX_DURATIONS) else {
            return History::default();
        };
        found
            .entries
            .into_iter()
            .find_map(|e| match e {
                Entry::File { path, data } if path == std::path::Path::new(DURATIONS_FILE) => {
                    serde_json::from_slice::<DurationsRecord>(&data).ok()
                }
                _ => None,
            })
            .filter(|r| r.version == 1)
            .map(|r| History {
                durations: r.jobs,
                held: r.held_mib,
            })
            .unwrap_or_default()
    }

    fn save_history(&self, pipeline: &str, history: &History) {
        let record = DurationsRecord {
            version: 1,
            jobs: history.durations.clone(),
            held_mib: history.held.clone(),
        };
        let Ok(data) = serde_json::to_vec(&record) else {
            return;
        };
        let entry = Entry::File {
            path: DURATIONS_FILE.into(),
            data: data.into(),
        };
        // Only a hint: a store that refuses it costs the next run its
        // order and its estimates, nothing else.
        let _ = Caches::save(self, &durations_key(pipeline), &[], &[entry]);
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
    fn an_entry_from_before_held_memory_was_kept_still_reads() {
        let old: DurationsRecord = serde_json::from_str(r#"{"version":1,"jobs":{"a":5}}"#).unwrap();
        assert_eq!(old.jobs["a"], 5);
        assert!(old.held_mib.is_empty());
        // And one that keeps none is written as it always was.
        assert_eq!(
            serde_json::to_string(&old).unwrap(),
            r#"{"version":1,"jobs":{"a":5}}"#
        );
    }

    #[test]
    fn durations_follow_the_cache_scopes() {
        let (store, dir) = store();
        let repo = RepoId::new("repo_1").unwrap();
        let org = RepoId::new("github.com-acme").unwrap();
        let at = |branch: &str, event: Event| {
            StoreCaches::new(store.clone(), &org, &repo, branch, "main", event, None)
        };
        let main = at("main", Event::Push);
        let pr = at("feature", Event::PullRequest);
        assert_eq!(main.load_history("Test"), History::default());
        let history = History {
            durations: [("a".to_string(), 5), ("b[x]".to_string(), 7)].into(),
            held: [("a".to_string(), 300)].into(),
        };
        main.save_history("Test", &history);
        assert_eq!(main.load_history("Test"), history);
        assert_eq!(
            main.load_history("Lint"),
            History::default(),
            "one entry per pipeline"
        );
        // A pull request starts from the default branch's, and what it
        // saves never reaches the default branch.
        assert_eq!(pr.load_history("Test"), history);
        let own = History {
            durations: [("a".to_string(), 1)].into(),
            held: BTreeMap::new(),
        };
        pr.save_history("Test", &own);
        assert_eq!(pr.load_history("Test"), own);
        assert_eq!(main.load_history("Test"), history);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A cache kept no modes, so a program saved `755` came back `644` and
    /// a native one (from Bun's install cache) would not start. The modes
    /// come back with the entries; an entry an older runner wrote (archive
    /// format 1) is a miss, which the next save replaces.
    #[test]
    fn modes_come_back_and_an_older_runners_entry_is_a_miss() {
        let (store, dir) = store();
        let repo = RepoId::new("repo_1").unwrap();
        let org = RepoId::new("github.com-acme").unwrap();
        let caches = StoreCaches::new(
            store.clone(),
            &org,
            &repo,
            "main",
            "main",
            Event::Push,
            None,
        );
        let modes = vec![
            (std::path::PathBuf::from("/app/.cache"), 0o750),
            (std::path::PathBuf::from("/app/.cache/x"), 0o755),
        ];
        caches
            .save_with_modes("bun-1", &[], &entries("main"), &modes)
            .unwrap();
        let hit = caches.restore("bun-1", &[], 1 << 20).unwrap().unwrap();
        assert_eq!(hit.entries, entries("main"));
        assert_eq!(hit.modes, modes);

        // What a runner before modes wrote under the same key.
        let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3).unwrap();
        std::io::Write::write_all(&mut encoder, &5u32.to_le_bytes()).unwrap();
        std::io::Write::write_all(&mut encoder, b"bun-1").unwrap();
        std::io::Write::write_all(&mut encoder, b"IWCIENTS").unwrap();
        std::io::Write::write_all(&mut encoder, &1u32.to_le_bytes()).unwrap();
        std::io::Write::write_all(&mut encoder, &0u64.to_le_bytes()).unwrap();
        let old = encoder.finish().unwrap();
        store
            .put(
                &caches.entry_key(&caches.write_scope, "bun-1"),
                &old,
                "application/zstd",
            )
            .unwrap();
        assert!(caches.restore("bun-1", &[], 1 << 20).unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
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

    /// A pnpm store compresses to more than an object may be, so its
    /// entry never saved and every run downloaded every package. An entry
    /// that big is split into parts; a part gone is a miss, a save of the
    /// same key replaces the parts, and eviction takes them with it.
    #[test]
    fn an_entry_bigger_than_an_object_is_split_into_parts() {
        let (store, dir) = store();
        let org = RepoId::new("github.com-acme").unwrap();
        let caches = |quota| {
            let mut c = StoreCaches::new(
                store.clone(),
                &org,
                &RepoId::new("web").unwrap(),
                "main",
                "main",
                Event::Push,
                quota,
            );
            c.part_bytes = 40 << 10;
            c.stale_parts_secs = 0;
            c
        };
        let parts = |c: &StoreCaches, key: &str| {
            let object = c.entry_key(&c.write_scope, key);
            let mut found = store.list(&format!("{object}.")).unwrap();
            found.sort();
            found
        };
        let c = caches(None);
        c.save("pnpm", &[], &big(100 << 10)).unwrap();
        assert_eq!(parts(&c, "pnpm").len(), 2, "100 KiB over 40 KiB objects");
        assert!(c.has("pnpm") && !c.has("npm"));
        let hit = c.restore("pnpm", &[], 1 << 20).unwrap().unwrap();
        assert_eq!(hit.entries, big(100 << 10));
        assert_eq!(
            storage_usage(store.as_ref(), &org, None).unwrap().entries,
            1,
            "parts are not entries"
        );

        // A runner from before parts reads the header as another key.
        let object = c.entry_key(&c.write_scope, "pnpm");
        let first = store.get(&object).unwrap().unwrap();
        assert_ne!(read_header(&first).unwrap(), b"pnpm");

        // Saved again: the new parts replace the old.
        let before = parts(&c, "pnpm");
        c.save("pnpm", &[], &big(90 << 10)).unwrap();
        let after = parts(&c, "pnpm");
        assert_eq!(after.len(), 2);
        assert!(
            before.iter().all(|p| !after.contains(p)),
            "{before:?} {after:?}"
        );
        assert_eq!(
            c.restore("pnpm", &[], 1 << 20).unwrap().unwrap().entries,
            big(90 << 10)
        );

        // Shrunk below one object: no parts left behind.
        c.save("pnpm", &[], &entries("small")).unwrap();
        assert!(parts(&c, "pnpm").is_empty());
        assert_eq!(
            c.restore("pnpm", &[], 1 << 20).unwrap().unwrap().entries,
            entries("small")
        );

        // A part gone is a miss, not an error.
        c.save("pnpm", &[], &big(100 << 10)).unwrap();
        store.delete(&parts(&c, "pnpm")[0]).unwrap();
        assert!(c.restore("pnpm", &[], 1 << 20).unwrap().is_none());

        // Evicting a split entry frees its parts too.
        c.save("pnpm", &[], &big(100 << 10)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let tight = caches(Some(150 << 10));
        tight.save("next", &[], &big(100 << 10)).unwrap();
        assert!(tight.restore("pnpm", &[], 1 << 20).unwrap().is_none());
        assert!(parts(&tight, "pnpm").is_empty());
        let usage = storage_usage(store.as_ref(), &org, None).unwrap();
        assert!(usage.used_bytes <= 150 << 10, "{usage:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Jobs of one run sharing a key save it at the same moment: one save
    /// must not remove the parts of another whose header lands after its
    /// own, or that entry points at nothing. Only parts older than
    /// [`STALE_PARTS_SECS`] are another save's leftovers.
    #[test]
    fn a_concurrent_save_keeps_the_other_saves_parts() {
        let (store, dir) = store();
        let mut c = StoreCaches::new(
            store.clone(),
            &RepoId::new("github.com-acme").unwrap(),
            &RepoId::new("web").unwrap(),
            "main",
            "main",
            Event::Push,
            None,
        );
        c.part_bytes = 40 << 10;
        let object = c.entry_key(&c.write_scope, "pnpm");
        c.save("pnpm", &[], &big(100 << 10)).unwrap();
        let first = store.get(&object).unwrap().unwrap();
        c.save("pnpm", &[], &big(90 << 10)).unwrap();
        // The first save's header lands last.
        store.put(&object, &first, "application/zstd").unwrap();
        assert_eq!(
            c.restore("pnpm", &[], 1 << 20).unwrap().unwrap().entries,
            big(100 << 10)
        );
        assert_eq!(store.list(&format!("{object}.")).unwrap().len(), 4);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Jobs of one runner that finish together save a shared key once: a
    /// claim holds the key until that save ends.
    #[test]
    fn a_key_being_saved_is_claimed_once() {
        let (store, dir) = store();
        let org = RepoId::new("github.com-acme").unwrap();
        let caches = || {
            StoreCaches::new(
                store.clone(),
                &org,
                &RepoId::new("claims").unwrap(),
                "main",
                "main",
                Event::Push,
                None,
            )
        };
        let (a, b) = (caches(), caches());
        assert!(a.claim("pnpm"));
        assert!(!b.claim("pnpm"), "another job is saving it");
        assert!(b.claim("npm"), "another key is free");
        a.save("pnpm", &[], &entries("x")).unwrap();
        b.save("npm", &[], &entries("y")).unwrap();
        assert!(b.claim("pnpm"), "released when the save ended");
        b.save("pnpm", &[], &entries("x")).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Counts the listings of an owner's whole storage a store is asked for.
    struct Listings {
        inner: iwci_store::LocalStore,
        detailed: std::sync::atomic::AtomicUsize,
    }

    impl ObjectStore for Listings {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, iwci_store::StoreError> {
            self.inner.get(key)
        }
        fn head(
            &self,
            key: &str,
        ) -> Result<Option<iwci_store::ObjectMeta>, iwci_store::StoreError> {
            self.inner.head(key)
        }
        fn put(&self, key: &str, bytes: &[u8], kind: &str) -> Result<(), iwci_store::StoreError> {
            self.inner.put(key, bytes, kind)
        }
        fn put_if_absent(
            &self,
            key: &str,
            bytes: &[u8],
            kind: &str,
        ) -> Result<bool, iwci_store::StoreError> {
            self.inner.put_if_absent(key, bytes, kind)
        }
        fn list(&self, prefix: &str) -> Result<Vec<String>, iwci_store::StoreError> {
            self.inner.list(prefix)
        }
        fn delete(&self, key: &str) -> Result<(), iwci_store::StoreError> {
            self.inner.delete(key)
        }
        fn list_detailed(
            &self,
            prefix: &str,
        ) -> Result<Vec<iwci_store::ObjectInfo>, iwci_store::StoreError> {
            // The owner's whole storage, not one entry's parts.
            if prefix == "caches/github.com-listings/" {
                self.detailed
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            self.inner.list_detailed(prefix)
        }
    }

    /// Making room listed every object the owner keeps for every save,
    /// which with thousands of task cache entries took longer than the save.
    /// A recent listing stands in, with what was saved since added on, until
    /// it says the quota would be passed.
    #[test]
    fn saves_with_room_to_spare_do_not_list_the_owner_again() {
        let dir = std::env::temp_dir().join(format!("iwci-caches-listings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let listings = Arc::new(Listings {
            inner: iwci_store::LocalStore::new(&dir).unwrap(),
            detailed: Default::default(),
        });
        let store: Arc<dyn ObjectStore> = listings.clone();
        let caches = StoreCaches::new(
            store,
            &RepoId::new("github.com-listings").unwrap(),
            &RepoId::new("web").unwrap(),
            "main",
            "main",
            Event::Push,
            Some(300 << 10),
        );
        let count = || listings.detailed.load(std::sync::atomic::Ordering::SeqCst);
        caches.save("one", &[], &big(100 << 10)).unwrap();
        let first = count();
        assert!(first > 0);
        // Stores keep modification times to the second.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        caches.save("two", &[], &big(100 << 10)).unwrap();
        assert_eq!(count(), first, "room to spare: no listing");
        // Past the quota by the estimate: listed again, and the oldest goes.
        caches.save("three", &[], &big(150 << 10)).unwrap();
        assert!(count() > first);
        assert!(caches.restore("one", &[], 1 << 30).unwrap().is_none());
        assert!(caches.restore("three", &[], 1 << 30).unwrap().is_some());
        let _ = std::fs::remove_dir_all(dir);
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
