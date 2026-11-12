//! Caching whole installs: `node_modules`, the `GOMODCACHE`, `vendor/`.
//!
//! The fetcher already caches every download by its hash, so a second run
//! never downloads a tarball twice. That still leaves unpacking and laying
//! out thousands of packages on every run. This caches the result.
//!
//! An install runs in a [`SnapshotBuilder::layer`] over the checkout. The
//! layer records every read that reaches the checkout (the lockfile, the
//! workspace settings, patch files, a missing `.npmrc`) and keeps every
//! write to itself, so after the install it holds exactly what the install
//! produced and knows exactly what that depended on. Both are stored. A
//! later run with the same key is a hit only when every recorded read still
//! sees the same thing in its checkout, which makes the cache correct
//! without any installer listing its inputs by hand: a bumped dependency,
//! an edited patch or a newly added `.npmrc` is a miss.
//!
//! Hits come from memory first (a runner process that stays up replays a
//! layer by sharing its buffers, without copying a byte) and then from disk.
//! On disk a layer is kept two ways:
//!
//! - **Unpacked** (`<inputs>.raw`) while it is in use: an index (the reads,
//!   the paths, each file's length, a SHA-256 per 8 MiB of data) and then
//!   every file's bytes back to back. A restore reads the index, maps the
//!   file and checks the hashes on every core, and the files go into the
//!   snapshot as views of the mapping, so nothing is decoded or copied.
//! - **Packed** (`<inputs>.layer`): the same bytes as one zstd stream with
//!   a frame checksum. A layer nobody has used for `keep_unpacked` (24 hours
//!   by default) is packed by [`LayerCache::compact`] and its unpacked copy
//!   removed; using it again unpacks it first.
//!
//! The files' modification times are when the layer was last used. A
//! damaged or truncated file of either kind is a miss and is removed, never
//! a corrupted workspace, and so is a file an older runner wrote.
//!
//! A mapped file is never written in place: files are written under a
//! temporary name and renamed, and removing one leaves the mapping valid
//! until the last view of it is dropped.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use iwci_vfs::{Entry, Input, SnapshotBuilder};
use sha2::Digest;
use shared_buffer::OwnedBuffer;

/// Bump when any installer's output changes for the same inputs, so layers
/// cached by an older runner are not reused.
pub const LAYOUT_VERSION: u32 = 1;

const MAGIC: &[u8; 8] = b"IWCILAYR";
/// 2: an index, then the files' bytes uncompressed and hashed in chunks
/// (#998). 1 was a zstd stream with each file's bytes inline in the
/// entries, which a runner now reads as a miss.
const FORMAT: u32 = 2;
/// The magic, the format, the index's length and the index's SHA-256.
const HEADER: usize = 8 + 4 + 8 + 32;
/// The data is hashed in chunks of this size, so a restore can check it on
/// every core.
const CHUNK: u64 = 8 << 20;
/// No index is anywhere near this; a larger length is a damaged file.
const MAX_INDEX: u64 = 1 << 30;
/// Layers kept per key, in memory and on disk: enough for a branch and its
/// base alternating on one runner, with a lockfile bump or two between.
const KEEP_PER_KEY: usize = 4;
/// Keys held in memory at once.
const MEMORY_KEYS: usize = 16;
/// How long a layer stays unpacked on disk after its last use.
pub const DEFAULT_KEEP_UNPACKED: Duration = Duration::from_secs(24 * 60 * 60);
/// A temporary file this old belongs to a write that never finished.
const STALE_TEMP: Duration = Duration::from_secs(60 * 60);

const UNPACKED: &str = "raw";
const PACKED: &str = "layer";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Replayed from this process's memory.
    Memory,
    /// Replayed from the disk cache.
    Disk,
    /// Installed, then cached.
    Installed,
}

#[derive(Debug)]
struct Layer {
    inputs: Vec<Input>,
    entries: Vec<Entry>,
    notes: Vec<String>,
    /// The stem of its files on disk.
    name: String,
}

/// Key to its layers (newest first), and the order keys were last used.
type Memory = (HashMap<String, Vec<Arc<Layer>>>, Vec<String>);

type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

pub struct LayerCache {
    dir: Option<PathBuf>,
    memory: Mutex<Memory>,
    keep_unpacked: Duration,
    clock: Clock,
    /// One per key: held while a key's layer is restored from disk, so two
    /// runs that need the same layer read it once and the second replays
    /// the first one's from memory.
    restoring: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Held while a last use is recorded and while [`LayerCache::compact`]
    /// decides that a layer is unused, so a use is never lost to a pack.
    disk: Mutex<()>,
}

impl std::fmt::Debug for LayerCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LayerCache")
            .field("dir", &self.dir)
            .field("keep_unpacked", &self.keep_unpacked)
            .finish_non_exhaustive()
    }
}

/// What one [`LayerCache::compact`] did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Compacted {
    /// Layers packed and their unpacked copies removed.
    pub packed: usize,
    /// Bytes of unpacked copies removed.
    pub freed: u64,
    pub problems: Vec<String>,
}

impl LayerCache {
    /// `dir` holds the layers on disk; `None` keeps them in memory only.
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self {
            dir,
            memory: Mutex::default(),
            keep_unpacked: DEFAULT_KEEP_UNPACKED,
            clock: Arc::new(SystemTime::now),
            restoring: Mutex::default(),
            disk: Mutex::default(),
        }
    }

    /// How long a layer stays unpacked on disk after it was last used
    /// before [`LayerCache::compact`] packs it.
    pub fn with_keep_unpacked(mut self, keep: Duration) -> Self {
        self.keep_unpacked = keep;
        self
    }

    #[cfg(test)]
    fn with_clock(mut self, clock: impl Fn() -> SystemTime + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    /// Fills `builder` with what `install` produces, from the cache when the
    /// checkout in `builder` still matches what a cached install read.
    ///
    /// `key` names the install: the ecosystem, its directory and every
    /// option that changes its output. `install` gets an empty layer over
    /// `builder` and returns notes (warnings) worth keeping with the result.
    pub fn install<E: std::fmt::Display>(
        &self,
        builder: &SnapshotBuilder,
        key: &str,
        install: impl FnOnce(&SnapshotBuilder) -> Result<Vec<String>, E>,
    ) -> Result<(Outcome, Vec<String>), String> {
        let key = format!("v{LAYOUT_VERSION}\0{key}");
        let holds = |inputs: &[Input]| inputs.iter().all(|input| input.holds(builder.fs()));

        if let Some(layer) = self.lookup_memory(&key, &holds) {
            return self.replay(builder, &key, &layer, Outcome::Memory);
        }
        if self.dir.is_some() {
            let gate = self
                .restoring
                .lock()
                .expect("cache lock")
                .entry(key.clone())
                .or_default()
                .clone();
            let _restoring = gate.lock().unwrap_or_else(|e| e.into_inner());
            // Another run may have restored it while this one waited.
            if let Some(layer) = self.lookup_memory(&key, &holds) {
                return self.replay(builder, &key, &layer, Outcome::Memory);
            }
            if let Some(layer) = self.lookup_disk(&key, &holds) {
                self.remember(&key, layer.clone());
                return self.replay(builder, &key, &layer, Outcome::Disk);
            }
        }

        let scratch = builder.layer();
        let notes = install(&scratch).map_err(|e| e.to_string())?;
        let inputs = scratch.reads();
        let layer = Arc::new(Layer {
            name: inputs_name(&inputs),
            inputs,
            entries: scratch.entries(),
            notes,
        });
        builder.apply(&layer.entries).map_err(|e| e.to_string())?;
        // A cache that cannot be written is a slower next run, not a failed
        // one.
        let mut kept = layer.clone();
        if let Some(dir) = &self.dir {
            let dir = dir.join(key_dir(&key));
            if self.save(&dir, &layer).is_ok() {
                // What memory keeps is the copy just written, as views of
                // its mapping, which the kernel can page out and reclaim.
                // The install's own buffers are the process's anonymous
                // memory, which nothing gives back while they are kept: an
                // idle server held a monorepo's node_modules, 2.8 GB of
                // it, after one cold run (#1063). They go with this run.
                let path = dir.join(format!("{}.{UNPACKED}", layer.name));
                if let Ok(Some(found)) = read_unpacked(&path, &|_| true) {
                    kept = Arc::new(found.into_layer(layer.name.clone()));
                }
            }
        }
        let notes = layer.notes.clone();
        self.remember(&key, kept);
        Ok((Outcome::Installed, notes))
    }

    fn replay(
        &self,
        builder: &SnapshotBuilder,
        key: &str,
        layer: &Layer,
        outcome: Outcome,
    ) -> Result<(Outcome, Vec<String>), String> {
        builder.apply(&layer.entries).map_err(|e| e.to_string())?;
        self.touch(key, &layer.name);
        Ok((outcome, layer.notes.clone()))
    }

    fn lookup_memory(&self, key: &str, holds: &dyn Fn(&[Input]) -> bool) -> Option<Arc<Layer>> {
        let mut memory = self.memory.lock().expect("cache lock");
        let layer = memory
            .0
            .get(key)?
            .iter()
            .find(|l| holds(&l.inputs))?
            .clone();
        touch_key(&mut memory.1, key);
        Some(layer)
    }

    fn lookup_disk(&self, key: &str, holds: &dyn Fn(&[Input]) -> bool) -> Option<Arc<Layer>> {
        let dir = self.dir.as_ref()?.join(key_dir(key));
        for (name, files) in list_layers(&dir) {
            let unpacked = dir.join(format!("{name}.{UNPACKED}"));
            let packed = dir.join(format!("{name}.{PACKED}"));
            if files.unpacked.is_some() {
                match read_unpacked(&unpacked, holds) {
                    Ok(Some(found)) => return Some(Arc::new(found.into_layer(name))),
                    // The packed copy has the same inputs.
                    Ok(None) => continue,
                    // Packed since it was listed.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    // Damaged or from an incompatible runner: drop it.
                    Err(_) => {
                        let _ = std::fs::remove_file(&unpacked);
                    }
                }
            }
            if files.packed.is_some() {
                match self.unpack(&packed, &unpacked, holds) {
                    Ok(true) => match read_unpacked(&unpacked, &|_| true) {
                        Ok(Some(found)) => {
                            prune(&dir);
                            return Some(Arc::new(found.into_layer(name)));
                        }
                        _ => {
                            let _ = std::fs::remove_file(&unpacked);
                            let _ = std::fs::remove_file(&packed);
                        }
                    },
                    Ok(false) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => {
                        let _ = std::fs::remove_file(&packed);
                    }
                }
            }
        }
        None
    }

    fn remember(&self, key: &str, layer: Arc<Layer>) {
        let mut memory = self.memory.lock().expect("cache lock");
        let (layers, order) = &mut *memory;
        let list = layers.entry(key.to_string()).or_default();
        list.retain(|l| l.inputs != layer.inputs);
        list.insert(0, layer);
        list.truncate(KEEP_PER_KEY);
        touch_key(order, key);
        while order.len() > MEMORY_KEYS {
            let oldest = order.remove(0);
            layers.remove(&oldest);
        }
    }

    /// Records a use of a layer on disk, where it outlives this process.
    fn touch(&self, key: &str, name: &str) {
        let Some(dir) = &self.dir else { return };
        let dir = dir.join(key_dir(key));
        let now = (self.clock)();
        let _disk = self.disk.lock().unwrap_or_else(|e| e.into_inner());
        for kind in [UNPACKED, PACKED] {
            if let Ok(file) = File::open(dir.join(format!("{name}.{kind}"))) {
                let _ = file.set_modified(now);
            }
        }
    }

    /// Writes a new layer unpacked, as used now.
    fn save(&self, dir: &Path, layer: &Layer) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{}.{UNPACKED}", layer.name));
        write_unpacked(&path, layer)?;
        File::open(&path)?.set_modified((self.clock)())?;
        prune(dir);
        Ok(())
    }

    /// Unpacks a packed layer next to it, when its inputs hold. The
    /// unpacked copy counts as used now; the packed one is kept, so packing
    /// it again later is only a removal.
    fn unpack(
        &self,
        packed: &Path,
        unpacked: &Path,
        holds: &dyn Fn(&[Input]) -> bool,
    ) -> std::io::Result<bool> {
        let mut r = zstd::stream::Decoder::new(BufReader::new(File::open(packed)?))?;
        let mut header = [0u8; HEADER];
        r.read_exact(&mut header)?;
        let (index_len, index_sha) = parse_header(&header)?;
        let mut index = Vec::new();
        (&mut r).take(index_len).read_to_end(&mut index)?;
        if index.len() as u64 != index_len || sha256(&index) != index_sha {
            return Err(bad("damaged index"));
        }
        let parsed = decode_index(&index)?;
        if !holds(&parsed.inputs) {
            return Ok(false);
        }
        let temp = Temp::new(unpacked.parent().ok_or_else(|| bad("no directory"))?);
        {
            let mut w = BufWriter::new(File::create(&temp.0)?);
            w.write_all(&header)?;
            w.write_all(&index)?;
            // Reading to the end is what makes zstd check the frame
            // checksum; a damaged or truncated stream fails here.
            let copied = std::io::copy(&mut r, &mut w)?;
            if copied != parsed.data_len {
                return Err(bad("data is not the length the index says"));
            }
            w.into_inner().map_err(|e| e.into_error())?;
        }
        temp.rename_to(unpacked)?;
        File::open(unpacked)?.set_modified((self.clock)())?;
        Ok(true)
    }

    /// Packs every layer on disk that has not been used for
    /// `keep_unpacked`, removes its unpacked copy and forgets it in memory,
    /// and clears out temporary files of writes that never finished.
    pub fn compact(&self) -> Compacted {
        let mut out = Compacted::default();
        let Some(root) = &self.dir else { return out };
        let Ok(dirs) = std::fs::read_dir(root) else {
            return out;
        };
        let now = (self.clock)();
        let idle = |used: SystemTime| now.duration_since(used).unwrap_or_default();
        for dir in dirs.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
            if let Ok(files) = std::fs::read_dir(&dir) {
                for file in files.flatten() {
                    let stale = file.file_name().to_string_lossy().ends_with(".tmp")
                        && modified(&file.path()).is_some_and(|m| idle(m) > STALE_TEMP);
                    if stale {
                        let _ = std::fs::remove_file(file.path());
                    }
                }
            }
            for (name, files) in list_layers(&dir) {
                let Some(used) = files.unpacked else { continue };
                if idle(used) <= self.keep_unpacked {
                    continue;
                }
                let unpacked = dir.join(format!("{name}.{UNPACKED}"));
                let packed = dir.join(format!("{name}.{PACKED}"));
                if files.packed.is_none() {
                    match pack(&unpacked, &packed, used) {
                        Ok(()) => {}
                        Err(e) => {
                            if e.kind() == std::io::ErrorKind::InvalidData {
                                let _ = std::fs::remove_file(&unpacked);
                            }
                            out.problems
                                .push(format!("packing {}: {e}", unpacked.display()));
                            continue;
                        }
                    }
                }
                let _disk = self.disk.lock().unwrap_or_else(|e| e.into_inner());
                // Used while it was being packed: keep it unpacked.
                if modified(&unpacked).is_some_and(|m| idle(m) <= self.keep_unpacked) {
                    continue;
                }
                let size = std::fs::metadata(&unpacked).map_or(0, |m| m.len());
                if std::fs::remove_file(&unpacked).is_ok() {
                    out.packed += 1;
                    out.freed += size;
                }
                self.forget(&dir, &name);
            }
        }
        out
    }

    /// Drops a layer from memory, so the mapping of its removed unpacked
    /// copy goes too.
    fn forget(&self, dir: &Path, name: &str) {
        let Some(dir_name) = dir.file_name().and_then(|n| n.to_str()) else {
            return;
        };
        let mut memory = self.memory.lock().expect("cache lock");
        let (layers, order) = &mut *memory;
        layers.retain(|key, list| {
            if key_dir(key) == dir_name {
                list.retain(|l| l.name != name);
            }
            !list.is_empty()
        });
        order.retain(|key| layers.contains_key(key));
    }
}

fn touch_key(order: &mut Vec<String>, key: &str) {
    order.retain(|k| k != key);
    order.push(key.to_string());
}

fn key_dir(key: &str) -> String {
    hex::encode(&sha2::Sha256::digest(key.as_bytes())[..16])
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    sha2::Sha256::digest(bytes).into()
}

/// The stem of the files a layer is stored in: named by its inputs, so a
/// rewrite of the same layer replaces it rather than adding another.
fn inputs_name(inputs: &[Input]) -> String {
    let mut hash = sha2::Sha256::new();
    for input in inputs {
        hash.update(format!("{input:?}\n").as_bytes());
    }
    hex::encode(&hash.finalize()[..16])
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// A layer's files on disk, with when each was last used.
#[derive(Debug, Default)]
struct Files {
    unpacked: Option<SystemTime>,
    packed: Option<SystemTime>,
}

impl Files {
    fn last_use(&self) -> Option<SystemTime> {
        self.unpacked.max(self.packed)
    }
}

/// The layers in a key's directory, most recently used first.
fn list_layers(dir: &Path) -> Vec<(String, Files)> {
    let mut layers: HashMap<String, Files> = HashMap::new();
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in read.flatten() {
        let path = entry.path();
        let (Some(stem), Some(ext)) = (
            path.file_stem().and_then(|s| s.to_str()),
            path.extension().and_then(|s| s.to_str()),
        ) else {
            continue;
        };
        if stem.starts_with('.') {
            continue;
        }
        let Some(time) = entry.metadata().ok().and_then(|m| m.modified().ok()) else {
            continue;
        };
        let files = layers.entry(stem.to_string()).or_default();
        match ext {
            UNPACKED => files.unpacked = Some(time),
            PACKED => files.packed = Some(time),
            _ => {}
        }
    }
    let mut layers: Vec<_> = layers
        .into_iter()
        .filter(|(_, f)| f.last_use().is_some())
        .collect();
    layers.sort_by_key(|(_, f)| std::cmp::Reverse(f.last_use()));
    layers
}

/// Keeps the most recently used few layers of a key.
fn prune(dir: &Path) {
    for (name, _) in list_layers(dir).into_iter().skip(KEEP_PER_KEY) {
        for kind in [UNPACKED, PACKED] {
            let _ = std::fs::remove_file(dir.join(format!("{name}.{kind}")));
        }
    }
}

/// A file being written, removed unless it is renamed into place.
struct Temp(PathBuf);

impl Temp {
    fn new(dir: &Path) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        Temp(dir.join(format!(".{}.{n}.tmp", std::process::id())))
    }

    fn rename_to(self, path: &Path) -> std::io::Result<()> {
        std::fs::rename(&self.0, path)?;
        std::mem::forget(self);
        Ok(())
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Packs an unpacked layer, checked first so damage is not preserved, and
/// gives the packed file the same last use.
fn pack(unpacked: &Path, packed: &Path, used: SystemTime) -> std::io::Result<()> {
    read_unpacked(unpacked, &|_| true)?;
    let temp = Temp::new(packed.parent().ok_or_else(|| bad("no directory"))?);
    {
        // Level 1: zstd decompresses at the same speed whatever the level.
        let mut enc = zstd::stream::Encoder::new(BufWriter::new(File::create(&temp.0)?), 1)?;
        enc.include_checksum(true)?;
        std::io::copy(&mut File::open(unpacked)?, &mut enc)?;
        enc.finish()?.into_inner().map_err(|e| e.into_error())?;
    }
    temp.rename_to(packed)?;
    File::open(packed)?.set_modified(used)
}

/// A layer's index: everything but the files' bytes.
#[derive(Debug)]
struct Index {
    notes: Vec<String>,
    inputs: Vec<Input>,
    data_len: u64,
    /// SHA-256 of each `CHUNK` of the data.
    chunks: Vec<[u8; 32]>,
    entries: Vec<IndexEntry>,
}

#[derive(Debug)]
enum IndexEntry {
    Dir { path: PathBuf },
    File { path: PathBuf, len: u64 },
    Symlink { path: PathBuf, target: PathBuf },
}

/// An unpacked layer read and checked: its index and a mapping of its data.
struct Unpacked {
    index: Index,
    data: OwnedBuffer,
}

impl Unpacked {
    fn into_layer(self, name: String) -> Layer {
        let mut offset = 0usize;
        let entries = self
            .index
            .entries
            .into_iter()
            .map(|e| match e {
                IndexEntry::Dir { path } => Entry::Dir { path },
                IndexEntry::File { path, len } => {
                    // The index's lengths add up to the data's (`decode_index`).
                    let end = offset + len as usize;
                    let data = self.data.slice(offset..end);
                    offset = end;
                    Entry::File { path, data }
                }
                IndexEntry::Symlink { path, target } => Entry::Symlink { path, target },
            })
            .collect();
        Layer {
            inputs: self.index.inputs,
            entries,
            notes: self.index.notes,
            name,
        }
    }
}

/// Reads an unpacked layer. `Ok(None)` when its inputs do not hold, which
/// is found from the index alone, before the data is mapped.
fn read_unpacked(
    path: &Path,
    holds: &dyn Fn(&[Input]) -> bool,
) -> std::io::Result<Option<Unpacked>> {
    let mut file = File::open(path)?;
    let mut header = [0u8; HEADER];
    file.read_exact(&mut header)?;
    let (index_len, index_sha) = parse_header(&header)?;
    let file_len = file.metadata()?.len();
    let data_start = HEADER as u64 + index_len;
    if data_start > file_len {
        return Err(bad("truncated index"));
    }
    let mut index = vec![0u8; index_len as usize];
    file.read_exact(&mut index)?;
    if sha256(&index) != index_sha {
        return Err(bad("damaged index"));
    }
    let index = decode_index(&index)?;
    if !holds(&index.inputs) {
        return Ok(None);
    }
    if file_len != data_start + index.data_len {
        return Err(bad("data is not the length the index says"));
    }
    let map = OwnedBuffer::from_file(&file).map_err(std::io::Error::other)?;
    let data = map.slice(data_start as usize..);
    check_chunks(data.as_slice(), &index.chunks)?;
    Ok(Some(Unpacked { index, data }))
}

/// Checks the data against the index's hashes, on every core.
fn check_chunks(data: &[u8], hashes: &[[u8; 32]]) -> std::io::Result<()> {
    let chunks: Vec<&[u8]> = data.chunks(CHUNK as usize).collect();
    if chunks.len() != hashes.len() {
        return Err(bad("chunk count"));
    }
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, 8);
    let per = chunks.len().div_ceil(threads).max(1);
    let ok = std::thread::scope(|s| {
        let workers: Vec<_> = chunks
            .chunks(per)
            .zip(hashes.chunks(per))
            .map(|(chunks, hashes)| {
                s.spawn(move || chunks.iter().zip(hashes).all(|(c, h)| sha256(c) == *h))
            })
            .collect();
        workers.into_iter().all(|w| w.join().unwrap_or(false))
    });
    if ok { Ok(()) } else { Err(bad("damaged data")) }
}

fn parse_header(header: &[u8; HEADER]) -> std::io::Result<(u64, [u8; 32])> {
    if &header[..8] != MAGIC || header[8..12] != FORMAT.to_le_bytes() {
        return Err(bad("not a layer this runner writes"));
    }
    let index_len = u64::from_le_bytes(header[12..20].try_into().expect("8 bytes"));
    if index_len > MAX_INDEX {
        return Err(bad("index too large"));
    }
    Ok((index_len, header[20..].try_into().expect("32 bytes")))
}

/// Writes a layer unpacked: the header and the index (with the chunk
/// hashes left blank), the data, hashed as it goes, and then the index and
/// header again with the hashes in.
fn write_unpacked(path: &Path, layer: &Layer) -> std::io::Result<()> {
    let data_len: u64 = layer
        .entries
        .iter()
        .map(|e| match e {
            Entry::File { data, .. } => data.len() as u64,
            _ => 0,
        })
        .sum();
    let chunk_count = data_len.div_ceil(CHUNK) as usize;
    let blank = encode_index(layer, data_len, &vec![[0u8; 32]; chunk_count])?;
    let temp = Temp::new(path.parent().ok_or_else(|| bad("no directory"))?);
    let mut w = BufWriter::with_capacity(1 << 20, File::create(&temp.0)?);
    w.write_all(&[0u8; HEADER])?;
    w.write_all(&blank)?;
    let mut hasher = ChunkHasher::default();
    for entry in &layer.entries {
        if let Entry::File { data, .. } = entry {
            hasher.update(data);
            w.write_all(data)?;
        }
    }
    let index = encode_index(layer, data_len, &hasher.finish())?;
    debug_assert_eq!(index.len(), blank.len());
    let mut file = w.into_inner().map_err(|e| e.into_error())?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(MAGIC)?;
    file.write_all(&FORMAT.to_le_bytes())?;
    file.write_all(&(index.len() as u64).to_le_bytes())?;
    file.write_all(&sha256(&index))?;
    file.write_all(&index)?;
    drop(file);
    // Not synced: a file cut short or garbled by a crash fails its hashes
    // and is a miss.
    temp.rename_to(path)
}

#[derive(Default)]
struct ChunkHasher {
    hasher: sha2::Sha256,
    filled: u64,
    done: Vec<[u8; 32]>,
}

impl ChunkHasher {
    fn update(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let take = ((CHUNK - self.filled) as usize).min(bytes.len());
            self.hasher.update(&bytes[..take]);
            self.filled += take as u64;
            bytes = &bytes[take..];
            if self.filled == CHUNK {
                self.done.push(self.hasher.finalize_reset().into());
                self.filled = 0;
            }
        }
    }

    fn finish(mut self) -> Vec<[u8; 32]> {
        if self.filled > 0 {
            self.done.push(self.hasher.finalize().into());
        }
        self.done
    }
}

fn encode_index(layer: &Layer, data_len: u64, chunks: &[[u8; 32]]) -> std::io::Result<Vec<u8>> {
    let mut w = Vec::new();
    write_u32(&mut w, layer.notes.len())?;
    for note in &layer.notes {
        write_str(&mut w, note)?;
    }
    write_u32(&mut w, layer.inputs.len())?;
    for input in &layer.inputs {
        match input {
            Input::File { path, sha256 } => {
                w.write_all(&[0])?;
                write_path(&mut w, path)?;
                w.write_all(sha256)?;
            }
            Input::Dir { path } => {
                w.write_all(&[1])?;
                write_path(&mut w, path)?;
            }
            Input::Absent { path } => {
                w.write_all(&[2])?;
                write_path(&mut w, path)?;
            }
        }
    }
    w.write_all(&data_len.to_le_bytes())?;
    write_u32(&mut w, chunks.len())?;
    for chunk in chunks {
        w.write_all(chunk)?;
    }
    w.write_all(&(layer.entries.len() as u64).to_le_bytes())?;
    for entry in &layer.entries {
        match entry {
            Entry::Dir { path } => {
                w.write_all(&[0])?;
                write_path(&mut w, path)?;
            }
            Entry::File { path, data } => {
                w.write_all(&[1])?;
                write_path(&mut w, path)?;
                w.write_all(&(data.len() as u64).to_le_bytes())?;
            }
            Entry::Symlink { path, target } => {
                w.write_all(&[2])?;
                write_path(&mut w, path)?;
                write_path(&mut w, target)?;
            }
        }
    }
    Ok(w)
}

fn decode_index(mut r: &[u8]) -> std::io::Result<Index> {
    let r = &mut r;
    let notes = (0..read_u32(r)?)
        .map(|_| read_string(r))
        .collect::<std::io::Result<_>>()?;
    let mut inputs = Vec::new();
    for _ in 0..read_u32(r)? {
        let kind = read_u8(r)?;
        let path = PathBuf::from(read_string(r)?);
        inputs.push(match kind {
            0 => {
                let mut sha256 = [0u8; 32];
                r.read_exact(&mut sha256)?;
                Input::File { path, sha256 }
            }
            1 => Input::Dir { path },
            2 => Input::Absent { path },
            _ => return Err(bad("unknown input kind")),
        });
    }
    let data_len = read_u64(r)?;
    let chunk_count = read_u32(r)? as u64;
    if chunk_count != data_len.div_ceil(CHUNK) {
        return Err(bad("chunk count"));
    }
    let mut chunks = Vec::new();
    for _ in 0..chunk_count {
        let mut hash = [0u8; 32];
        r.read_exact(&mut hash)?;
        chunks.push(hash);
    }
    let mut entries = Vec::new();
    let mut total: u64 = 0;
    for _ in 0..read_u64(r)? {
        let kind = read_u8(r)?;
        let path = PathBuf::from(read_string(r)?);
        entries.push(match kind {
            0 => IndexEntry::Dir { path },
            1 => {
                let len = read_u64(r)?;
                total = total
                    .checked_add(len)
                    .ok_or_else(|| bad("file too large"))?;
                IndexEntry::File { path, len }
            }
            2 => IndexEntry::Symlink {
                path,
                target: PathBuf::from(read_string(r)?),
            },
            _ => return Err(bad("unknown entry kind")),
        });
    }
    if total != data_len || usize::try_from(data_len).is_err() {
        return Err(bad("files are not the length of the data"));
    }
    if !r.is_empty() {
        return Err(bad("trailing bytes in the index"));
    }
    Ok(Index {
        notes,
        inputs,
        data_len,
        chunks,
        entries,
    })
}

fn bad(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.to_string())
}

fn write_u32(w: &mut impl Write, n: usize) -> std::io::Result<()> {
    let n = u32::try_from(n).map_err(|_| bad("count too large"))?;
    w.write_all(&n.to_le_bytes())
}

fn write_str(w: &mut impl Write, s: &str) -> std::io::Result<()> {
    write_u32(w, s.len())?;
    w.write_all(s.as_bytes())
}

fn write_path(w: &mut impl Write, path: &Path) -> std::io::Result<()> {
    write_str(w, path.to_str().ok_or_else(|| bad("path is not UTF-8"))?)
}

fn read_u8(r: &mut impl Read) -> std::io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}

fn read_u32(r: &mut impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64(r: &mut impl Read) -> std::io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

fn read_string(r: &mut impl Read) -> std::io::Result<String> {
    let len = read_u32(r)? as usize;
    // Paths and notes are short; a huge length is a damaged file.
    if len > 1 << 20 {
        return Err(bad("string too long"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|_| bad("not UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn checkout() -> SnapshotBuilder {
        let b = SnapshotBuilder::new();
        b.write("/app/pnpm-lock.yaml", b"lock v1").unwrap();
        b
    }

    /// A stand-in install: reads the lockfile, checks for `.npmrc`, writes a
    /// package and a link, and counts how often it really ran.
    fn install(
        runs: &AtomicUsize,
    ) -> impl FnOnce(&SnapshotBuilder) -> Result<Vec<String>, String> + '_ {
        move |layer| {
            runs.fetch_add(1, Ordering::SeqCst);
            let lock = layer
                .read("/app/pnpm-lock.yaml")
                .map_err(|e| e.to_string())?;
            let registry = if layer.is_file("/app/.npmrc") {
                "custom"
            } else {
                "default"
            };
            layer
                .write(
                    "/app/node_modules/.pnpm/a@1/node_modules/a/index.js",
                    &[lock, registry.as_bytes().to_vec()].concat(),
                )
                .unwrap();
            layer
                .symlink("/app/node_modules/a", ".pnpm/a@1/node_modules/a")
                .unwrap();
            Ok(vec!["a note".into()])
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("iwci-layer-cache-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn layer_dir(dir: &Path, key: &str) -> PathBuf {
        dir.join(key_dir(&format!("v{LAYOUT_VERSION}\0{key}")))
    }

    /// The one file of `kind` in a key's directory, if there is one.
    fn file_of(dir: &Path, key: &str, kind: &str) -> Option<PathBuf> {
        std::fs::read_dir(layer_dir(dir, key))
            .ok()?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == kind))
    }

    /// A clock tests move by hand.
    #[derive(Clone)]
    struct Clock(Arc<Mutex<SystemTime>>);

    impl Clock {
        fn new() -> Self {
            Clock(Arc::new(Mutex::new(
                SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000),
            )))
        }
        fn now(&self) -> SystemTime {
            *self.0.lock().unwrap()
        }
        fn advance(&self, hours: u64) {
            *self.0.lock().unwrap() += Duration::from_secs(hours * 3600);
        }
        fn cache(&self, dir: &Path) -> LayerCache {
            let clock = self.clone();
            LayerCache::new(Some(dir.to_path_buf())).with_clock(move || clock.now())
        }
    }

    fn damage(path: &Path) {
        let mut bytes = std::fs::read(path).unwrap();
        let at = bytes.len() - 3;
        bytes[at] ^= 0xff;
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_second_install_with_the_same_inputs_comes_from_memory_then_disk() {
        let dir = temp_dir("hit");
        let runs = AtomicUsize::new(0);
        let cache = LayerCache::new(Some(dir.clone()));

        let first = checkout();
        assert_eq!(
            cache.install(&first, "pnpm /app", install(&runs)).unwrap(),
            (Outcome::Installed, vec!["a note".to_string()])
        );
        assert_eq!(
            first.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1default"
        );

        let second = checkout();
        assert_eq!(
            cache
                .install(&second, "pnpm /app", install(&runs))
                .unwrap()
                .0,
            Outcome::Memory
        );
        assert_eq!(
            second.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1default"
        );

        // A new process: nothing in memory, the layer comes off disk.
        let cache = LayerCache::new(Some(dir.clone()));
        let third = checkout();
        assert_eq!(
            cache.install(&third, "pnpm /app", install(&runs)).unwrap(),
            (Outcome::Disk, vec!["a note".to_string()])
        );
        assert_eq!(
            third.freeze().read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1default"
        );
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Whether every file of the layers kept in memory for `key` is a view
    /// of a mapped file, and how many files there are.
    fn kept_mapped(cache: &LayerCache, key: &str) -> (bool, usize) {
        let memory = cache.memory.lock().unwrap();
        let files: Vec<bool> = memory.0[&format!("v{LAYOUT_VERSION}\0{key}")]
            .iter()
            .flat_map(|l| &l.entries)
            .filter_map(|e| match e {
                Entry::File { data, .. } => Some(data.is_mmapped()),
                _ => None,
            })
            .collect();
        (files.iter().all(|m| *m), files.len())
    }

    #[test]
    fn a_fresh_install_is_kept_as_its_copy_on_disk() {
        // #1063: the install's own buffers are anonymous memory, which an
        // idle server kept for good; memory keeps the mapped copy instead.
        let dir = temp_dir("mapped");
        let runs = AtomicUsize::new(0);
        let cache = LayerCache::new(Some(dir.clone()));
        let first = checkout();
        assert_eq!(
            cache
                .install(&first, "pnpm /app", install(&runs))
                .unwrap()
                .0,
            Outcome::Installed
        );
        assert_eq!(kept_mapped(&cache, "pnpm /app"), (true, 1));
        let second = checkout();
        assert_eq!(
            cache
                .install(&second, "pnpm /app", install(&runs))
                .unwrap()
                .0,
            Outcome::Memory
        );
        assert_eq!(
            second.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1default"
        );
        // Without a directory, memory is the only copy.
        let cache = LayerCache::new(None);
        cache
            .install(&checkout(), "pnpm /app", install(&runs))
            .unwrap();
        assert_eq!(kept_mapped(&cache, "pnpm /app"), (false, 1));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_changed_or_new_input_is_a_miss() {
        let runs = AtomicUsize::new(0);
        let cache = LayerCache::new(None);
        cache
            .install(&checkout(), "pnpm /app", install(&runs))
            .unwrap();

        let bumped = SnapshotBuilder::new();
        bumped.write("/app/pnpm-lock.yaml", b"lock v2").unwrap();
        assert_eq!(
            cache
                .install(&bumped, "pnpm /app", install(&runs))
                .unwrap()
                .0,
            Outcome::Installed
        );
        assert_eq!(
            bumped.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v2default"
        );

        // The install looked for `.npmrc` and did not find it; adding one
        // must not reuse the old result.
        let with_npmrc = checkout();
        with_npmrc.write("/app/.npmrc", b"registry=x").unwrap();
        assert_eq!(
            cache
                .install(&with_npmrc, "pnpm /app", install(&runs))
                .unwrap()
                .0,
            Outcome::Installed
        );
        assert_eq!(
            with_npmrc.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1custom"
        );

        // A different key never shares a layer.
        assert_eq!(
            cache
                .install(&checkout(), "pnpm /app/sub", install(&runs))
                .unwrap()
                .0,
            Outcome::Installed
        );
        // But the original is still cached alongside the bumped one.
        assert_eq!(
            cache
                .install(&checkout(), "pnpm /app", install(&runs))
                .unwrap()
                .0,
            Outcome::Memory
        );
        assert_eq!(runs.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn a_damaged_layer_file_is_a_miss_and_is_removed() {
        let dir = temp_dir("damaged");
        let clock = Clock::new();
        let runs = AtomicUsize::new(0);
        clock
            .cache(&dir)
            .install(&checkout(), "k", install(&runs))
            .unwrap();
        let unpacked = file_of(&dir, "k", UNPACKED).unwrap();
        damage(&unpacked);

        let target = checkout();
        assert_eq!(
            clock
                .cache(&dir)
                .install(&target, "k", install(&runs))
                .unwrap()
                .0,
            Outcome::Installed
        );
        assert_eq!(
            target.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1default"
        );
        assert_eq!(runs.load(Ordering::SeqCst), 2);

        // The same for a packed copy.
        clock.advance(25);
        assert_eq!(clock.cache(&dir).compact().packed, 1);
        let packed = file_of(&dir, "k", PACKED).unwrap();
        assert!(file_of(&dir, "k", UNPACKED).is_none());
        damage(&packed);
        assert_eq!(
            clock
                .cache(&dir)
                .install(&checkout(), "k", install(&runs))
                .unwrap()
                .0,
            Outcome::Installed
        );
        assert!(!packed.exists());
        assert_eq!(runs.load(Ordering::SeqCst), 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_layer_an_older_runner_wrote_is_a_miss_and_is_removed() {
        let dir = temp_dir("old-format");
        let runs = AtomicUsize::new(0);
        // Format 1: a zstd stream of the magic, the format and the entries.
        let old = layer_dir(&dir, "k").join("0123456789abcdef0123456789abcdef.layer");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        let mut stream = MAGIC.to_vec();
        stream.extend_from_slice(&1u32.to_le_bytes());
        stream.extend_from_slice(&[0u8; 64]);
        std::fs::write(&old, zstd::encode_all(&stream[..], 1).unwrap()).unwrap();

        let target = checkout();
        assert_eq!(
            LayerCache::new(Some(dir.clone()))
                .install(&target, "k", install(&runs))
                .unwrap()
                .0,
            Outcome::Installed
        );
        assert!(!old.exists());
        assert_eq!(
            target.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1default"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_layer_unused_for_the_window_is_packed_and_unpacked_again_on_use() {
        let dir = temp_dir("window");
        let clock = Clock::new();
        let runs = AtomicUsize::new(0);
        let cache = clock.cache(&dir);
        cache.install(&checkout(), "k", install(&runs)).unwrap();
        let unpacked = file_of(&dir, "k", UNPACKED).unwrap();

        clock.advance(23);
        assert_eq!(cache.compact(), Compacted::default());
        assert!(unpacked.exists());

        clock.advance(2);
        let compacted = cache.compact();
        assert_eq!(compacted.packed, 1);
        assert!(compacted.freed > 0);
        assert!(!unpacked.exists());
        let packed = file_of(&dir, "k", PACKED).unwrap();
        // Packing keeps when it was last used.
        assert_eq!(
            modified(&packed).unwrap(),
            clock.now() - Duration::from_secs(25 * 3600)
        );

        // Packed, it has left memory too: the next use reads the disk and
        // unpacks it, keeping the packed copy.
        let target = checkout();
        assert_eq!(
            cache.install(&target, "k", install(&runs)).unwrap(),
            (Outcome::Disk, vec!["a note".to_string()])
        );
        assert_eq!(
            target.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1default"
        );
        assert_eq!(modified(&unpacked).unwrap(), clock.now());
        assert_eq!(modified(&packed).unwrap(), clock.now());
        assert_eq!(runs.load(Ordering::SeqCst), 1);

        // Packing it again is only a removal.
        clock.advance(25);
        assert_eq!(cache.compact().packed, 1);
        assert!(!unpacked.exists() && packed.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn each_use_restarts_the_window_even_from_memory() {
        let dir = temp_dir("use");
        let clock = Clock::new();
        let runs = AtomicUsize::new(0);
        let cache = clock.cache(&dir);
        cache.install(&checkout(), "k", install(&runs)).unwrap();
        let unpacked = file_of(&dir, "k", UNPACKED).unwrap();

        clock.advance(20);
        assert_eq!(
            cache.install(&checkout(), "k", install(&runs)).unwrap().0,
            Outcome::Memory
        );
        assert_eq!(modified(&unpacked).unwrap(), clock.now());

        clock.advance(10);
        assert_eq!(cache.compact().packed, 0);
        clock.advance(15);
        assert_eq!(cache.compact().packed, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_last_use_survives_a_restart() {
        let dir = temp_dir("restart");
        let clock = Clock::new();
        let runs = AtomicUsize::new(0);
        clock
            .cache(&dir)
            .install(&checkout(), "k", install(&runs))
            .unwrap();

        // A new process uses it 20 hours later, from the unpacked copy.
        clock.advance(20);
        assert_eq!(
            clock
                .cache(&dir)
                .install(&checkout(), "k", install(&runs))
                .unwrap()
                .0,
            Outcome::Disk
        );

        // Another one, 10 hours after that, finds it used 10 hours ago.
        clock.advance(10);
        assert_eq!(clock.cache(&dir).compact().packed, 0);
        clock.advance(15);
        assert_eq!(clock.cache(&dir).compact().packed, 1);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_window_is_configurable() {
        let dir = temp_dir("configured");
        let clock = Clock::new();
        let runs = AtomicUsize::new(0);
        let cache = clock
            .cache(&dir)
            .with_keep_unpacked(Duration::from_secs(3600));
        cache.install(&checkout(), "k", install(&runs)).unwrap();
        clock.advance(2);
        assert_eq!(cache.compact().packed, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_restore_waited_for_is_not_read_twice() {
        let dir = temp_dir("together");
        let runs = AtomicUsize::new(0);
        LayerCache::new(Some(dir.clone()))
            .install(&checkout(), "k", install(&runs))
            .unwrap();
        let cache = LayerCache::new(Some(dir.clone()));
        let mut outcomes: Vec<Outcome> = std::thread::scope(|s| {
            let a = s.spawn(|| cache.install(&checkout(), "k", install(&runs)).unwrap().0);
            let b = s.spawn(|| cache.install(&checkout(), "k", install(&runs)).unwrap().0);
            vec![a.join().unwrap(), b.join().unwrap()]
        });
        outcomes.sort_by_key(|o| *o as u8);
        assert_eq!(outcomes, [Outcome::Memory, Outcome::Disk]);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn large_files_span_chunks_and_round_trip() {
        let dir = temp_dir("chunks");
        let big: Vec<u8> = (0..(CHUNK as usize * 2 + 12345))
            .map(|i| (i % 251) as u8)
            .collect();
        let cache = LayerCache::new(Some(dir.clone()));
        cache
            .install(&checkout(), "k", |layer: &SnapshotBuilder| {
                layer.read("/app/pnpm-lock.yaml").unwrap();
                layer.write("/app/node_modules/small", b"x").unwrap();
                layer.write("/app/node_modules/big", &big).unwrap();
                layer.write("/app/node_modules/empty", b"").unwrap();
                Ok::<_, String>(Vec::new())
            })
            .unwrap();
        let target = checkout();
        assert_eq!(
            LayerCache::new(Some(dir.clone()))
                .install(&target, "k", |_| Err::<Vec<String>, _>("not cached"))
                .unwrap()
                .0,
            Outcome::Disk
        );
        assert_eq!(target.read("/app/node_modules/big").unwrap(), big);
        assert_eq!(target.read("/app/node_modules/small").unwrap(), b"x");
        assert_eq!(target.read("/app/node_modules/empty").unwrap(), b"");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_install_caches_nothing() {
        let cache = LayerCache::new(None);
        let b = checkout();
        let err = cache
            .install(&b, "k", |_| Err::<Vec<String>, _>("lockfile is broken"))
            .unwrap_err();
        assert!(err.contains("broken"));
        assert!(!b.is_dir("/app/node_modules"));
        let runs = AtomicUsize::new(0);
        assert_eq!(
            cache.install(&b, "k", install(&runs)).unwrap().0,
            Outcome::Installed
        );
    }
}
