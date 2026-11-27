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

/// What every entry object's name ends in: a `cache:` or `task-cache:`
/// entry's (`.zst`) or a Turborepo artifact's. What eviction may delete
/// and what usage counts as entries; their parts and prefix pointers end
/// in neither.
fn is_entry(key: &str) -> bool {
    key.ends_with(".zst") || key.ends_with(TURBO_SUFFIX)
}

const TURBO_SUFFIX: &str = ".turbo";

/// The first line of a stored Turborepo artifact; the hash, its duration
/// and its tag follow, a line each, then the artifact as `turbo` sent it
/// (compressed already, so kept as it is).
const TURBO_MAGIC: &str = "iwci-turbo 1";

fn encode_turbo(hash: &str, artifact: &crate::turbo::Artifact) -> Vec<u8> {
    let mut bytes = format!(
        "{TURBO_MAGIC}\n{hash}\n{}\n{}\n",
        artifact.duration_ms,
        artifact.tag.as_deref().unwrap_or("")
    )
    .into_bytes();
    bytes.extend_from_slice(&artifact.body);
    bytes
}

/// The artifact in `bytes` if it is `hash`'s: one written by another
/// format, or for another hash, is a miss.
fn decode_turbo(hash: &str, mut bytes: Vec<u8>) -> Option<crate::turbo::Artifact> {
    let mut lines = Vec::with_capacity(4);
    let mut at = 0;
    for _ in 0..4 {
        let end = at
            + bytes
                .get(at..)?
                .iter()
                .take(1024)
                .position(|b| *b == b'\n')?;
        lines.push(std::str::from_utf8(&bytes[at..end]).ok()?.to_string());
        at = end + 1;
    }
    if lines[0] != TURBO_MAGIC || lines[1] != hash {
        return None;
    }
    let duration_ms = lines[2].parse().ok()?;
    let tag = (!lines[3].is_empty()).then(|| lines[3].clone());
    bytes.drain(..at);
    Some(crate::turbo::Artifact {
        body: bytes,
        duration_ms,
        tag,
    })
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

    /// Where a Turborepo artifact ([`crate::turbo`]) is kept: an entry of
    /// its scope like any other, under the hash `turbo` gave it.
    fn turbo_key(&self, scope: &str, hash: &str) -> String {
        format!(
            "caches/{}/{}/{scope}/turbo/{hash}{TURBO_SUFFIX}",
            self.owner, self.repo
        )
    }

    /// Where a scope's entries and prefixes live, in this process's saves
    /// in flight ([`saving`]).
    fn scope_dir(&self, scope: &str) -> String {
        self.claim_key(&format!("caches/{}/{}/{scope}", self.owner, self.repo))
    }

    /// `object` among this process's saves in flight ([`saving`]): in the
    /// store's own namespace, since two stores (a test's) may hold the
    /// same names. A runner has one store, which every run shares.
    fn claim_key(&self, object: &str) -> String {
        format!(
            "{:x}/{object}",
            Arc::as_ptr(&self.store) as *const () as usize
        )
    }

    /// Waits while this process saves an entry a restore of `key`, or of
    /// a `restore_keys` prefix, would read: a job's saves are made after
    /// it is reported ([`crate::saves`]), so the next job or run that wants
    /// the cache can start before its upload ends, and reading then would
    /// miss it or take an older entry.
    fn wait_for_saves(&self, key: &str, restore_keys: &[String]) {
        let dirs: Vec<String> = self.read_scopes.iter().map(|s| self.scope_dir(s)).collect();
        let wanted = |(dir, saved): &(String, String)| {
            dirs.contains(dir)
                && (saved == key || restore_keys.iter().any(|p| saved.starts_with(p.as_str())))
        };
        let saving = saving();
        let deadline = std::time::Instant::now() + SAVE_WAIT;
        let mut entries = saving.entries.lock().unwrap_or_else(|e| e.into_inner());
        while entries.values().any(wanted) {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return;
            }
            entries = saving
                .ended
                .wait_timeout(entries, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
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
            &self.store,
            &self.owner,
            self.quota,
            object,
            incoming,
            "the cache",
        )
    }

    /// The entry at `object` if it is `key`'s, with its modes. Jobs of a
    /// run that restore the same entry at the same moment (a matrix sharing
    /// a package store) share one read: three jobs reading and unpacking
    /// one 1.1 GiB store at once each took twice as long as one alone.
    fn load(&self, object: &str, key: &str, max_bytes: u64) -> Loaded {
        // By store too: one process has one, but tests open many.
        let store = self.store.as_ref() as *const dyn ObjectStore as *const () as usize;
        let id = (format!("{store:x}/{object}"), key.to_string(), max_bytes);
        let cell = {
            let mut loading = loading().lock().unwrap_or_else(|e| e.into_inner());
            loading.entry(id.clone()).or_default().clone()
        };
        // The first caller reads; the others wait for its answer.
        let loaded = cell
            .get_or_init(|| self.load_now(object, key, max_bytes))
            .clone();
        let mut loading = loading().lock().unwrap_or_else(|e| e.into_inner());
        if loading.get(&id).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            loading.remove(&id);
        }
        loaded
    }

    /// [`StoreCaches::load`], read now. One a runner of another archive
    /// format wrote is a miss: the next save replaces it, and so is one
    /// whose parts are not all there.
    fn load_now(&self, object: &str, key: &str, max_bytes: u64) -> Loaded {
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
        // Decompressed on a thread of its own while this one parses what
        // comes out, rather than the two taking turns.
        let (tx, rx) = std::sync::mpsc::sync_channel::<std::io::Result<Vec<u8>>>(DECODE_AHEAD);
        let bytes = Arc::new(bytes);
        let source = bytes.clone();
        let decoding = std::thread::Builder::new()
            .name("iwci-cache-decode".into())
            .spawn(move || {
                let mut decoder = match zstd::stream::Decoder::new(source.as_slice()) {
                    Ok(d) => d,
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return;
                    }
                };
                loop {
                    let mut chunk = vec![0u8; DECODE_CHUNK];
                    match read_full(&mut decoder, &mut chunk) {
                        Ok(0) => return,
                        Ok(n) => {
                            chunk.truncate(n);
                            // The reader stopped early (an error, or an
                            // archive over `max_bytes`): stop too.
                            if tx.send(Ok(chunk)).is_err() {
                                return;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            return;
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let mut reader = Chunks {
            rx,
            chunk: Vec::new(),
            at: 0,
        };
        let parsed = skip_header(&mut reader).and_then(|()| {
            archive::decode_with_modes(&mut reader, max_bytes).map_err(|e| {
                if archive::is_other_format(&e) {
                    OTHER_FORMAT.to_string()
                } else {
                    e.to_string()
                }
            })
        });
        drop(reader);
        let _ = decoding.join();
        match parsed {
            Ok(found) => Ok(Some(found)),
            Err(e) if e == OTHER_FORMAT => Ok(None),
            Err(e) => Err(e),
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

/// What a load of an entry answers.
type Loaded = Result<Option<(Vec<Entry>, archive::ModeList)>, String>;

/// Loads in progress, by object, key and size limit ([`StoreCaches::load`]).
#[allow(clippy::type_complexity)]
fn loading()
-> &'static std::sync::Mutex<BTreeMap<(String, String, u64), Arc<std::sync::OnceLock<Loaded>>>> {
    static LOADING: std::sync::OnceLock<
        std::sync::Mutex<BTreeMap<(String, String, u64), Arc<std::sync::OnceLock<Loaded>>>>,
    > = std::sync::OnceLock::new();
    LOADING.get_or_init(Default::default)
}

/// How much decompressed archive is handed over at a time, and how many
/// such pieces may wait for the parser.
const DECODE_CHUNK: usize = 1 << 20;
const DECODE_AHEAD: usize = 8;
/// Stands for an archive another runner's format wrote, a miss.
const OTHER_FORMAT: &str = "\0other format";

/// Reads until `buf` is full or the stream ends.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(m) => n += m,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// The decompressed archive as it arrives from the decoding thread.
struct Chunks {
    rx: std::sync::mpsc::Receiver<std::io::Result<Vec<u8>>>,
    chunk: Vec<u8>,
    at: usize,
}

impl Read for Chunks {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.at == self.chunk.len() {
            match self.rx.recv() {
                Ok(Ok(chunk)) => {
                    self.chunk = chunk;
                    self.at = 0;
                }
                Ok(Err(e)) => return Err(e),
                // The decoder is done.
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.chunk.len() - self.at);
        buf[..n].copy_from_slice(&self.chunk[self.at..self.at + n]);
        self.at += n;
        Ok(n)
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

/// Contents past which a cache is compressed on several threads.
const MULTITHREAD_BYTES: u64 = 16 << 20;
/// The most threads one save compresses on.
const MAX_COMPRESS_WORKERS: u32 = 8;

/// How many threads compress `entries` (0: the caller's own). A save runs
/// after its job and before the job is done, so it is on the run's
/// critical path: a package store of a gigabyte took 3 to 4 s on one
/// thread and well under one on eight. The output is the one zstd frame
/// it always was, which any runner reads, one thread at a time.
fn compress_workers(entries: &[Entry]) -> u32 {
    let bytes: u64 = entries
        .iter()
        .map(|e| match e {
            Entry::File { data, .. } => data.len() as u64,
            _ => 0,
        })
        .sum();
    if bytes < MULTITHREAD_BYTES {
        return 0;
    }
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
    u32::try_from(cpus)
        .unwrap_or(u32::MAX)
        .min(MAX_COMPRESS_WORKERS)
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
    store: &Arc<dyn ObjectStore>,
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
    let lock = owner_lock(store.as_ref(), owner);
    let mut estimate = lock.lock().unwrap_or_else(|e| e.into_inner());
    let now = crate::runner::now_secs();
    // Listing every object an owner keeps (tens of thousands of task cache
    // entries, a request per thousand) took longer than the save: 40 s on
    // every run's first save, inside its jobs and after its last one. A
    // listing's total, with what was saved since added on, says whether
    // there is room. It only overcounts on this runner (a replaced entry
    // is not taken off); another runner's saves since are what its age
    // bounds. One under [`ESTIMATE_SECS`] old stands; one under
    // [`STALE_SECS`] stands while a tenth of the quota is left over, and
    // the owner is listed again in the background.
    if let Some(known) = estimate.as_mut() {
        let age = now.saturating_sub(known.listed_at);
        let after = known.used.saturating_add(incoming);
        let fresh = age < ESTIMATE_SECS && after <= quota;
        let roomy = age < STALE_SECS && after <= quota - quota / HEADROOM;
        if fresh || roomy {
            known.used = after;
            if known.refreshing {
                known.during = known.during.saturating_add(incoming);
            } else if age >= ESTIMATE_SECS {
                // This save lands after the listing may have looked.
                known.refreshing = true;
                known.during = incoming;
                refresh(store.clone(), owner.to_string(), lock.clone(), now);
            }
            return Ok(());
        }
    }
    let mut objects = store
        .list_detailed(&format!("caches/{owner}/"))
        .map_err(|e| e.to_string())?;
    // The entry being replaced frees its own bytes, its parts' too.
    let own_parts = format!("{object}.");
    objects.retain(|o| o.key != object && !o.key.starts_with(&own_parts));
    let downloads = live_downloads(store.as_ref(), owner, now)?;
    let mut used: u64 = objects.iter().map(|o| o.size).sum::<u64>() + downloads;
    if used + incoming <= quota {
        *estimate = Some(Estimate::listed(used + incoming, now));
        return Ok(());
    }
    // Oldest first; entries before the small prefix pointers, so a
    // pointer is only dropped when nothing else is left to drop. A split
    // entry goes with its parts.
    let (mut candidates, parts): (Vec<_>, Vec<_>) =
        objects.into_iter().partition(|o| is_entry(&o.key));
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
    delete_all(store.as_ref(), &doomed)?;
    *estimate = Some(Estimate::listed(used + incoming, now));
    Ok(())
}

/// Lists every owner's storage once, in the background, and gives each
/// owner nobody has counted yet the total as its estimate: a runner that
/// had just started (every release restarts it) made its first save for an
/// owner wait for that owner's whole listing, 40 s for one with tens of
/// thousands of task cache entries.
pub fn warm_estimates(store: Arc<dyn ObjectStore>) {
    let job = move || {
        let started = crate::runner::now_secs();
        let owner_of = |key: &str, prefix: &str| {
            key.strip_prefix(prefix)
                .and_then(|rest| rest.split('/').next())
                .map(str::to_string)
        };
        let mut used: BTreeMap<String, u64> = BTreeMap::new();
        let Ok(caches) = store.list_detailed("caches/") else {
            return;
        };
        for object in caches {
            if let Some(owner) = owner_of(&object.key, "caches/") {
                *used.entry(owner).or_default() += object.size;
            }
        }
        let downloads = format!("{}/", crate::adapters::downloads::PREFIX);
        let Ok(kept) = store.list_detailed(&downloads) else {
            return;
        };
        for object in kept {
            let live = crate::adapters::downloads::expiry(&object.key).is_none_or(|e| e > started);
            if let (true, Some(owner)) = (live, owner_of(&object.key, &downloads)) {
                *used.entry(owner).or_default() += object.size;
            }
        }
        for (owner, bytes) in used {
            let lock = owner_lock(store.as_ref(), &owner);
            let mut estimate = lock.lock().unwrap_or_else(|e| e.into_inner());
            // A save that listed meanwhile knows better.
            if estimate.is_none() {
                *estimate = Some(Estimate::listed(bytes, started));
            }
        }
    };
    let _ = std::thread::Builder::new()
        .name("iwci-quota-warm".into())
        .spawn(job);
}

/// What `owner`'s downloads hold that has not expired.
fn live_downloads(store: &dyn ObjectStore, owner: &str, now: u64) -> Result<u64, String> {
    Ok(store
        .list_detailed(&format!("{}/{owner}/", crate::adapters::downloads::PREFIX))
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|o| crate::adapters::downloads::expiry(&o.key).is_none_or(|e| e > now))
        .map(|o| o.size)
        .sum())
}

/// Lists `owner` again on a thread of its own, the saves going on with
/// the estimate meanwhile, and puts the total (with what they saved while
/// it listed) in its place.
fn refresh(
    store: Arc<dyn ObjectStore>,
    owner: String,
    lock: Arc<std::sync::Mutex<Option<Estimate>>>,
    started: u64,
) {
    let job = {
        let lock = lock.clone();
        move || {
            let listed = store
                .list_detailed(&format!("caches/{owner}/"))
                .map_err(|e| e.to_string())
                .and_then(|objects| {
                    let downloads = live_downloads(store.as_ref(), &owner, started)?;
                    Ok(objects.iter().map(|o| o.size).sum::<u64>() + downloads)
                });
            let mut estimate = lock.lock().unwrap_or_else(|e| e.into_inner());
            match (listed, estimate.as_mut()) {
                (Ok(used), Some(known)) if known.refreshing => {
                    *known = Estimate::listed(used.saturating_add(known.during), started);
                }
                // A save listed in the meantime, which is newer.
                (Ok(_), _) => {}
                (Err(_), Some(known)) => known.refreshing = false,
                (Err(_), None) => {}
            }
        }
    };
    if std::thread::Builder::new()
        .name("iwci-quota-listing".into())
        .spawn(job)
        .is_err()
        && let Some(known) = lock.lock().unwrap_or_else(|e| e.into_inner()).as_mut()
    {
        known.refreshing = false;
    }
}

/// How long a listing of an owner's storage stands in for a new one.
const ESTIMATE_SECS: u64 = 120;
/// How long one stands while the owner has room to spare, listed again
/// in the background meanwhile.
const STALE_SECS: u64 = 3600;
/// Room to spare is a tenth of the quota.
const HEADROOM: u64 = 10;

/// An owner's storage as last listed, with what this process saved since.
struct Estimate {
    used: u64,
    listed_at: u64,
    /// A listing is going on in the background ([`refresh`]).
    refreshing: bool,
    /// What was saved while it listed, which it may not have seen.
    during: u64,
}

impl Estimate {
    fn listed(used: u64, at: u64) -> Self {
        Self {
            used,
            listed_at: at,
            refreshing: false,
            during: 0,
        }
    }
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
        if is_entry(&object.key) {
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

/// An owner's storage as last listed, kept so the storage endpoint answers
/// at once: listing an owner with tens of thousands of entries took 30 s,
/// longer than the app waits, so its storage was never sampled and every
/// attempt listed the whole owner again.
pub struct StorageSamples {
    store: Arc<dyn ObjectStore>,
    state: Arc<(
        std::sync::Mutex<BTreeMap<String, Sample>>,
        std::sync::Condvar,
    )>,
}

#[derive(Default)]
struct Sample {
    /// The last listing's usage and when it started, in seconds.
    usage: Option<(StorageUsage, u64)>,
    /// A listing is going on.
    listing: bool,
    /// Why the last listing failed, while there is no usage to show.
    error: Option<String>,
}

/// A listing younger than this is answered as it is.
const SAMPLE_FRESH_SECS: u64 = 60;

impl StorageSamples {
    pub fn new(store: Arc<dyn ObjectStore>) -> Self {
        Self {
            store,
            state: Arc::default(),
        }
    }

    /// `owner`'s storage. A listing under [`SAMPLE_FRESH_SECS`] old is the
    /// answer; an older one is too, while the owner is listed again in the
    /// background. With none yet, the first listing is waited for up to
    /// `wait`: `Ok(None)` when it is still going, for the caller to ask
    /// again.
    pub fn get(
        &self,
        owner: &RepoId,
        quota: Option<u64>,
        wait: std::time::Duration,
    ) -> Result<Option<StorageUsage>, String> {
        let key = owner.as_str().to_string();
        let (lock, changed) = &*self.state;
        let mut samples = lock.lock().unwrap_or_else(|e| e.into_inner());
        let now = crate::runner::now_secs();
        let sample = samples.entry(key.clone()).or_default();
        let stale = sample
            .usage
            .as_ref()
            .is_none_or(|(_, at)| now.saturating_sub(*at) >= SAMPLE_FRESH_SECS);
        if stale && !sample.listing {
            sample.listing = true;
            self.list(owner.clone(), now);
        }
        let deadline = std::time::Instant::now() + wait;
        loop {
            let sample = samples.entry(key.clone()).or_default();
            if let Some((usage, _)) = &sample.usage {
                let mut usage = usage.clone();
                usage.quota_bytes = quota;
                return Ok(Some(usage));
            }
            if !sample.listing {
                return Err(sample
                    .error
                    .clone()
                    .unwrap_or_else(|| "the listing ended with nothing".into()));
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            samples = changed
                .wait_timeout(samples, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Forgets `owner`'s listing, after its storage changed by more than
    /// a save (a repository cleared).
    pub fn forget(&self, owner: &RepoId) {
        let (lock, _) = &*self.state;
        let mut samples = lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sample) = samples.get_mut(owner.as_str()) {
            sample.usage = None;
        }
    }

    fn list(&self, owner: RepoId, started: u64) {
        let key = owner.as_str().to_string();
        let (store, state) = (self.store.clone(), self.state.clone());
        let job = move || {
            let listed = storage_usage(store.as_ref(), &owner, None);
            let (lock, changed) = &*state;
            let mut samples = lock.lock().unwrap_or_else(|e| e.into_inner());
            let sample = samples.entry(owner.as_str().to_string()).or_default();
            sample.listing = false;
            match listed {
                Ok(usage) => {
                    sample.usage = Some((usage, started));
                    sample.error = None;
                }
                Err(e) => sample.error = Some(e),
            }
            changed.notify_all();
        };
        if let Err(e) = std::thread::Builder::new()
            .name("iwci-storage-listing".into())
            .spawn(job)
        {
            let (lock, changed) = &*self.state;
            let mut samples = lock.lock().unwrap_or_else(|e| e.into_inner());
            let sample = samples.entry(key).or_default();
            sample.listing = false;
            sample.error = Some(e.to_string());
            changed.notify_all();
        }
    }
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
                        if is_entry(&object.key) {
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
        self.wait_for_saves(key, restore_keys);
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
        let object = self.claim_key(&self.entry_key(&self.write_scope, key));
        let mut saving = saving().entries.lock().unwrap_or_else(|e| e.into_inner());
        if saving.contains_key(&object) {
            return false;
        }
        saving.insert(object, (self.scope_dir(&self.write_scope), key.to_string()));
        true
    }

    fn save_with_modes(
        &self,
        key: &str,
        restore_keys: &[String],
        entries: &[Entry],
        modes: &[(std::path::PathBuf, u32)],
    ) -> Result<(), String> {
        let scope = &self.write_scope;
        let object = self.entry_key(scope, key);
        // A claim on the key ([`Caches::claim`]) ends with the save,
        // however it ends.
        let _claimed = Claimed(self.claim_key(&object));
        let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3).map_err(|e| e.to_string())?;
        encoder.include_checksum(true).map_err(|e| e.to_string())?;
        let workers = compress_workers(entries);
        if workers > 0 {
            encoder.multithread(workers).map_err(|e| e.to_string())?;
        }
        archive::encode_with_modes(&mut encoder, entries, modes).map_err(|e| e.to_string())?;
        let body = encoder.finish().map_err(|e| e.to_string())?;
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

/// A run's Turborepo artifacts ([`crate::turbo`]), where its `cache:`
/// entries are: read from its own scope, then the default branch's, and
/// written to its own.
impl crate::turbo::Artifacts for StoreCaches {
    fn get(&self, hash: &str) -> Result<Option<crate::turbo::Artifact>, String> {
        if !crate::turbo::valid_hash(hash) {
            return Ok(None);
        }
        for scope in &self.read_scopes {
            let object = self.turbo_key(scope, hash);
            if let Some(bytes) = self.store.get(&object).map_err(|e| e.to_string())?
                && let Some(artifact) = decode_turbo(hash, bytes)
            {
                return Ok(Some(artifact));
            }
        }
        Ok(None)
    }

    fn put(&self, hash: &str, artifact: &crate::turbo::Artifact) -> Result<(), String> {
        if !crate::turbo::valid_hash(hash) {
            return Err("not an artifact hash".into());
        }
        let object = self.turbo_key(&self.write_scope, hash);
        let bytes = encode_turbo(hash, artifact);
        self.make_room(&object, bytes.len() as u64)?;
        self.store
            .put(&object, &bytes, "application/octet-stream")
            .map_err(|e| e.to_string())
    }
}

/// The entries jobs of this process are saving now ([`Caches::claim`]).
#[derive(Default)]
struct Saving {
    /// By object: the scope's directory and the key.
    entries: std::sync::Mutex<BTreeMap<String, (String, String)>>,
    /// Signalled when a save ends.
    ended: std::sync::Condvar,
}

fn saving() -> &'static Saving {
    static SAVING: std::sync::OnceLock<Saving> = std::sync::OnceLock::new();
    SAVING.get_or_init(Default::default)
}

/// The longest a restore waits for saves in flight before it reads what
/// is there without them. Saves end by themselves, so this only bounds a
/// store that hangs.
const SAVE_WAIT: std::time::Duration = std::time::Duration::from_secs(600);

/// Releases a claim on an entry when its save ends, however it ends, and
/// wakes the restores waiting for it.
struct Claimed(String);

impl Drop for Claimed {
    fn drop(&mut self) {
        let saving = saving();
        saving
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
        saving.ended.notify_all();
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

    /// Turborepo's artifacts keep to the cache scopes: a pull request reads
    /// the default branch's and its own, and nothing it writes reaches the
    /// default branch. They count as entries, so eviction and clearing
    /// take them with the rest.
    #[test]
    fn turbo_artifacts_follow_the_cache_scopes_and_count_as_entries() {
        use crate::turbo::{Artifact, Artifacts};
        let (store, dir) = store();
        let repo = RepoId::new("repo_1").unwrap();
        let org = RepoId::new("github.com-acme").unwrap();
        let at = |branch: &str, event: Event| {
            StoreCaches::new(store.clone(), &org, &repo, branch, "main", event, None)
        };
        let main = at("main", Event::Push);
        let pr = at("feature", Event::PullRequest);
        let built = Artifact {
            body: b"\x28\xb5\x2f\xfd tarball\nwith lines".to_vec(),
            duration_ms: 4200,
            tag: Some("c2ln/bmF0+dXJl=".into()),
        };
        assert_eq!(Artifacts::get(&main, "abc123").unwrap(), None);
        Artifacts::put(&main, "abc123", &built).unwrap();
        assert_eq!(
            Artifacts::get(&main, "abc123").unwrap(),
            Some(built.clone())
        );
        assert_eq!(Artifacts::get(&pr, "abc123").unwrap(), Some(built.clone()));
        let planted = Artifact {
            body: b"planted".to_vec(),
            duration_ms: 1,
            tag: None,
        };
        Artifacts::put(&pr, "abc123", &planted).unwrap();
        Artifacts::put(&pr, "def456", &planted).unwrap();
        assert_eq!(
            Artifacts::get(&pr, "abc123").unwrap(),
            Some(planted.clone())
        );
        assert_eq!(Artifacts::get(&main, "abc123").unwrap(), Some(built));
        assert_eq!(Artifacts::get(&main, "def456").unwrap(), None);
        // Not a hash: never a key.
        assert!(Artifacts::put(&main, "../x", &planted).is_err());
        assert_eq!(Artifacts::get(&main, "../x").unwrap(), None);

        let usage = storage_usage(store.as_ref(), &org, None).unwrap();
        assert_eq!(usage.entries, 3);
        let cleared = clear_repository(store.as_ref(), &org, &repo).unwrap();
        assert_eq!(cleared.deleted_entries, 3);
        assert_eq!(Artifacts::get(&pr, "def456").unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An artifact is evicted like any entry when the owner's quota fills.
    #[test]
    fn turbo_artifacts_are_evicted_to_make_room() {
        use crate::turbo::{Artifact, Artifacts};
        let (store, dir) = store();
        let repo = RepoId::new("repo_1").unwrap();
        let org = RepoId::new("github.com-quota").unwrap();
        let caches = StoreCaches::new(
            store.clone(),
            &org,
            &repo,
            "main",
            "main",
            Event::Push,
            Some(3000),
        );
        let big = |n: u8| Artifact {
            body: vec![n; 1200],
            duration_ms: 0,
            tag: None,
        };
        Artifacts::put(&caches, "aa", &big(1)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        Artifacts::put(&caches, "bb", &big(2)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // Past the estimate's window, so the third save lists and evicts.
        owner_lock(store.as_ref(), org.as_str())
            .lock()
            .unwrap()
            .take();
        Artifacts::put(&caches, "cc", &big(3)).unwrap();
        assert_eq!(
            Artifacts::get(&caches, "aa").unwrap(),
            None,
            "the oldest went"
        );
        assert!(Artifacts::get(&caches, "bb").unwrap().is_some());
        assert!(Artifacts::get(&caches, "cc").unwrap().is_some());
        let _ = std::fs::remove_dir_all(dir);
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

    /// A job's saves are made after it is reported, so the next job can
    /// ask for the cache while the upload is still going: a restore of
    /// the key, or of a prefix it falls under, waits for the save rather
    /// than missing it, and one of another key does not wait.
    #[test]
    fn a_restore_waits_for_a_save_of_its_key_in_flight() {
        let (store, dir) = store();
        let org = RepoId::new("github.com-acme").unwrap();
        let caches = || {
            StoreCaches::new(
                store.clone(),
                &org,
                &RepoId::new("in-flight").unwrap(),
                "main",
                "main",
                Event::Push,
                None,
            )
        };
        for (saved, asked, prefixes) in [
            ("pnpm-abc", "pnpm-abc", vec![]),
            ("yarn-abc", "yarn-def", vec!["yarn-".to_string()]),
        ] {
            let saver = caches();
            assert!(saver.claim(saved));
            let keys = prefixes.clone();
            let saving = std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                saver.save(saved, &keys, &entries("x")).unwrap();
            });
            let started = std::time::Instant::now();
            // Another key is read at once.
            assert!(caches().restore("npm", &[], 1 << 20).unwrap().is_none());
            assert!(started.elapsed() < std::time::Duration::from_millis(250));
            let restored = caches()
                .restore(asked, &prefixes, 1 << 20)
                .unwrap()
                .expect("the save it waited for");
            assert_eq!(restored.key, saved);
            assert!(started.elapsed() >= std::time::Duration::from_millis(300));
            saving.join().unwrap();
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Counts the listings of an owner's whole storage a store is asked for.
    struct Listings {
        inner: iwci_store::LocalStore,
        detailed: std::sync::atomic::AtomicUsize,
        /// How long a listing of an owner's whole storage takes, in ms.
        slow: std::sync::atomic::AtomicU64,
    }

    /// Reads of entry objects, slowed so concurrent ones overlap.
    struct SlowGets {
        inner: iwci_store::LocalStore,
        gets: std::sync::atomic::AtomicUsize,
    }

    impl ObjectStore for SlowGets {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, iwci_store::StoreError> {
            if key.ends_with(".zst") {
                self.gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
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
            self.inner.list_detailed(prefix)
        }
    }

    /// Jobs restoring one entry at the same moment read and unpack it
    /// once; one that comes after reads it again.
    #[test]
    fn concurrent_restores_of_one_entry_share_a_read() {
        let dir = std::env::temp_dir().join(format!("iwci-caches-shared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let gets = Arc::new(SlowGets {
            inner: iwci_store::LocalStore::new(&dir).unwrap(),
            gets: Default::default(),
        });
        let store: Arc<dyn ObjectStore> = gets.clone();
        let caches = Arc::new(StoreCaches::new(
            store,
            &RepoId::new("github.com-shared").unwrap(),
            &RepoId::new("web").unwrap(),
            "main",
            "main",
            Event::Push,
            None,
        ));
        caches.save("store", &[], &entries("packages")).unwrap();
        let count = || gets.gets.load(std::sync::atomic::Ordering::SeqCst);
        let restored: Vec<_> = (0..3)
            .map(|_| {
                let caches = caches.clone();
                std::thread::spawn(move || caches.restore("store", &[], 1 << 30).unwrap().unwrap())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        assert_eq!(count(), 1, "one read for three restores");
        for r in &restored {
            assert!(r.exact);
            assert_eq!(r.entries, entries("packages"));
        }
        caches.restore("store", &[], 1 << 30).unwrap().unwrap();
        assert_eq!(count(), 2, "a later restore reads again");
        let _ = std::fs::remove_dir_all(dir);
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
            // Owners of their own per test: the estimates are kept by store
            // address, which a later test's store can reuse.
            if [
                "caches/github.com-listings/",
                "caches/github.com-stale/",
                "caches/github.com-warmed/",
            ]
            .contains(&prefix)
            {
                self.detailed
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            if prefix.starts_with("caches/") && prefix.matches('/').count() == 2 {
                let ms = self.slow.load(std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(ms));
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
            slow: Default::default(),
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

    /// A listing a few minutes old stands while the owner has room to
    /// spare, and the owner is listed again in the background: the first
    /// save of every run waited 40 s for an owner's listing. Older, or
    /// without the room, the save lists first, as before.
    #[test]
    fn an_older_listing_stands_with_room_to_spare_and_is_redone_in_the_background() {
        let dir = std::env::temp_dir().join(format!("iwci-caches-stale-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let listings = Arc::new(Listings {
            inner: iwci_store::LocalStore::new(&dir).unwrap(),
            detailed: Default::default(),
            slow: Default::default(),
        });
        let store: Arc<dyn ObjectStore> = listings.clone();
        let owner = "github.com-stale";
        let caches = StoreCaches::new(
            store.clone(),
            &RepoId::new(owner).unwrap(),
            &RepoId::new("web").unwrap(),
            "main",
            "main",
            Event::Push,
            Some(1000 << 10),
        );
        let count = || listings.detailed.load(std::sync::atomic::Ordering::SeqCst);
        let age = |secs: u64| {
            let lock = owner_lock(store.as_ref(), owner);
            let mut estimate = lock.lock().unwrap();
            let known = estimate.as_mut().unwrap();
            known.listed_at = crate::runner::now_secs() - secs;
        };
        let known = || {
            let lock = owner_lock(store.as_ref(), owner);
            let estimate = lock.lock().unwrap();
            let known = estimate.as_ref().unwrap();
            (known.used, known.refreshing, known.listed_at)
        };
        caches.save("one", &[], &big(100 << 10)).unwrap();
        let first = count();
        assert!(first > 0);

        age(600);
        caches.save("two", &[], &big(100 << 10)).unwrap();
        // Saved without waiting for a listing; one goes on behind it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while known().1 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let (used, refreshing, listed_at) = known();
        assert!(!refreshing);
        assert!(count() > first, "listed again in the background");
        assert!(crate::runner::now_secs() - listed_at < ESTIMATE_SECS);
        assert!(used >= 200 << 10, "both entries counted: {used}");

        // Too old to stand at all: listed before the save.
        age(STALE_SECS + 1);
        let before = count();
        caches.save("three", &[], &big(100 << 10)).unwrap();
        assert!(count() > before);
        assert!(!known().1, "no listing in the background");

        // Recent enough, but into the last tenth of the quota: listed first.
        age(600);
        let before = count();
        caches.save("four", &[], &big(650 << 10)).unwrap();
        assert!(count() > before);
        assert!(!known().1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The storage endpoint answers from the last listing: the first is
    /// waited for a while, an old one is answered at once and redone
    /// behind it. Listing an owner with tens of thousands of entries took
    /// longer than the app waits, so it was never sampled.
    #[test]
    fn storage_samples_answer_from_the_last_listing() {
        use std::sync::atomic::Ordering::SeqCst;
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!("iwci-caches-samples-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let listings = Arc::new(Listings {
            inner: iwci_store::LocalStore::new(&dir).unwrap(),
            detailed: Default::default(),
            slow: Default::default(),
        });
        let store: Arc<dyn ObjectStore> = listings.clone();
        let owner = RepoId::new("github.com-sampled").unwrap();
        store
            .put(
                "caches/github.com-sampled/web/b-1/entries/a.zst",
                &[0; 100],
                "x",
            )
            .unwrap();
        let samples = StorageSamples::new(store.clone());
        listings.slow.store(400, SeqCst);
        // The first listing outlasts a short wait: ask again.
        assert!(
            samples
                .get(&owner, None, Duration::from_millis(50))
                .unwrap()
                .is_none()
        );
        let usage = samples
            .get(&owner, Some(1000), Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(
            (usage.used_bytes, usage.entries, usage.quota_bytes),
            (100, 1, Some(1000))
        );
        // Fresh: answered without listing, even with more stored since.
        store
            .put(
                "caches/github.com-sampled/web/b-1/entries/b.zst",
                &[0; 50],
                "x",
            )
            .unwrap();
        let t = std::time::Instant::now();
        let usage = samples
            .get(&owner, None, Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(t.elapsed() < Duration::from_millis(200));
        assert_eq!(usage.used_bytes, 100);
        // Old: the old answer at once, and a new listing behind it.
        {
            let (lock, _) = &*samples.state;
            let mut s = lock.lock().unwrap();
            s.get_mut("github.com-sampled")
                .unwrap()
                .usage
                .as_mut()
                .unwrap()
                .1 -= SAMPLE_FRESH_SECS;
        }
        let t = std::time::Instant::now();
        let usage = samples
            .get(&owner, None, Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(t.elapsed() < Duration::from_millis(200));
        assert_eq!(usage.used_bytes, 100);
        std::thread::sleep(Duration::from_millis(800));
        let usage = samples
            .get(&owner, None, Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(usage.used_bytes, 150, "the new listing is the answer now");
        // Forgotten (a repository cleared): the next ask lists again.
        samples.forget(&owner);
        listings.slow.store(0, SeqCst);
        store
            .delete("caches/github.com-sampled/web/b-1/entries/a.zst")
            .unwrap();
        let usage = samples
            .get(&owner, None, Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(usage.used_bytes, 50);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A runner that has just started counts every owner in the
    /// background, so its first save for one does not list it first.
    #[test]
    fn warmed_estimates_spare_the_first_save_a_listing() {
        let dir = std::env::temp_dir().join(format!("iwci-caches-warm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let listings = Arc::new(Listings {
            inner: iwci_store::LocalStore::new(&dir).unwrap(),
            detailed: Default::default(),
            slow: Default::default(),
        });
        let store: Arc<dyn ObjectStore> = listings.clone();
        store
            .put(
                "caches/github.com-warmed/web/b-1/entries/a.zst",
                &[0; 100],
                "x",
            )
            .unwrap();
        warm_estimates(store.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let warmed = || {
            owner_lock(store.as_ref(), "github.com-warmed")
                .lock()
                .unwrap()
                .as_ref()
                .map(|e| e.used)
        };
        while warmed().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(warmed(), Some(100));
        let caches = StoreCaches::new(
            store.clone(),
            &RepoId::new("github.com-warmed").unwrap(),
            &RepoId::new("web").unwrap(),
            "main",
            "main",
            Event::Push,
            Some(1 << 20),
        );
        let before = listings.detailed.load(std::sync::atomic::Ordering::SeqCst);
        caches.save("one", &[], &big(10 << 10)).unwrap();
        assert_eq!(
            listings.detailed.load(std::sync::atomic::Ordering::SeqCst),
            before,
            "no listing for the first save"
        );
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
