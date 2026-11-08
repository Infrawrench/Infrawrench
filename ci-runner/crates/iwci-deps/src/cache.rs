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
//! layer by sharing its buffers, without copying a byte) and then from disk
//! (one zstd stream per layer with a frame checksum, so a damaged file is a
//! miss, never a corrupted workspace).

use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use iwci_vfs::{Entry, Input, SnapshotBuilder};
use sha2::Digest;

/// Bump when any installer's output changes for the same inputs, so layers
/// cached by an older runner are not reused.
pub const LAYOUT_VERSION: u32 = 1;

const MAGIC: &[u8; 8] = b"IWCILAYR";
const FORMAT: u32 = 1;
/// Layers kept per key, in memory and on disk: enough for a branch and its
/// base alternating on one runner, with a lockfile bump or two between.
const KEEP_PER_KEY: usize = 4;
/// Keys held in memory at once.
const MEMORY_KEYS: usize = 16;

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
}

/// Key to its layers (newest first), and the order keys were last used.
type Memory = (HashMap<String, Vec<Arc<Layer>>>, Vec<String>);

#[derive(Debug, Default)]
pub struct LayerCache {
    dir: Option<PathBuf>,
    memory: Mutex<Memory>,
}

impl LayerCache {
    /// `dir` holds the layers on disk; `None` keeps them in memory only.
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self {
            dir,
            memory: Mutex::default(),
        }
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
        let holds = |layer: &Layer| layer.inputs.iter().all(|input| input.holds(builder.fs()));

        if let Some(layer) = self.lookup_memory(&key, &holds) {
            builder.apply(&layer.entries).map_err(|e| e.to_string())?;
            return Ok((Outcome::Memory, layer.notes.clone()));
        }
        if let Some(layer) = self.lookup_disk(&key, &holds) {
            builder.apply(&layer.entries).map_err(|e| e.to_string())?;
            let notes = layer.notes.clone();
            self.remember(&key, layer);
            return Ok((Outcome::Disk, notes));
        }

        let scratch = builder.layer();
        let notes = install(&scratch).map_err(|e| e.to_string())?;
        let layer = Arc::new(Layer {
            inputs: scratch.reads(),
            entries: scratch.entries(),
            notes,
        });
        builder.apply(&layer.entries).map_err(|e| e.to_string())?;
        // A cache that cannot be written is a slower next run, not a failed
        // one.
        if let Some(dir) = &self.dir {
            let _ = save(&dir.join(key_dir(&key)), &layer);
        }
        let notes = layer.notes.clone();
        self.remember(&key, layer);
        Ok((Outcome::Installed, notes))
    }

    fn lookup_memory(&self, key: &str, holds: &dyn Fn(&Layer) -> bool) -> Option<Arc<Layer>> {
        let mut memory = self.memory.lock().expect("cache lock");
        let layer = memory.0.get(key)?.iter().find(|l| holds(l))?.clone();
        touch(&mut memory.1, key);
        Some(layer)
    }

    fn lookup_disk(&self, key: &str, holds: &dyn Fn(&Layer) -> bool) -> Option<Arc<Layer>> {
        let dir = self.dir.as_ref()?.join(key_dir(key));
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)
            .ok()?
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "layer"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        files.sort_by_key(|f| std::cmp::Reverse(f.0));
        for (_, path) in files {
            match load(&path, holds) {
                Ok(Some(layer)) => return Some(Arc::new(layer)),
                Ok(None) => {}
                // Damaged or from an incompatible runner: drop it.
                Err(_) => {
                    let _ = std::fs::remove_file(&path);
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
        touch(order, key);
        while order.len() > MEMORY_KEYS {
            let oldest = order.remove(0);
            layers.remove(&oldest);
        }
    }
}

fn touch(order: &mut Vec<String>, key: &str) {
    order.retain(|k| k != key);
    order.push(key.to_string());
}

fn key_dir(key: &str) -> String {
    hex::encode(&sha2::Sha256::digest(key.as_bytes())[..16])
}

/// The file a layer is stored in: named by its inputs, so a rewrite of the
/// same layer replaces it rather than adding another.
fn inputs_name(inputs: &[Input]) -> String {
    let mut hash = sha2::Sha256::new();
    for input in inputs {
        hash.update(format!("{input:?}\n").as_bytes());
    }
    format!("{}.layer", hex::encode(&hash.finalize()[..16]))
}

fn save(dir: &Path, layer: &Layer) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let final_path = dir.join(inputs_name(&layer.inputs));
    let temp = dir.join(format!(".{}.tmp", std::process::id()));
    {
        let file = std::fs::File::create(&temp)?;
        // Level 1: the layer is written once and read many times, and zstd
        // decompresses at the same speed whatever the level.
        let mut enc = zstd::stream::Encoder::new(BufWriter::new(file), 1)?;
        enc.include_checksum(true)?;
        encode(&mut enc, layer)?;
        enc.finish()?
            .into_inner()
            .map_err(|e| e.into_error())?
            .sync_all()?;
    }
    std::fs::rename(&temp, &final_path)?;
    // Keep the newest few.
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "layer"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    for (_, path) in files.into_iter().skip(KEEP_PER_KEY) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Reads a stored layer. `Ok(None)` when its inputs do not hold, which is
/// found from the header alone, before the entries are decompressed.
fn load(path: &Path, holds: &dyn Fn(&Layer) -> bool) -> std::io::Result<Option<Layer>> {
    let file = std::fs::File::open(path)?;
    let mut r = zstd::stream::Decoder::new(BufReader::new(file))?;
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic)?;
    if &magic != MAGIC || read_u32(&mut r)? != FORMAT {
        return Err(bad("not a layer this runner writes"));
    }
    let notes = (0..read_u32(&mut r)?)
        .map(|_| read_string(&mut r))
        .collect::<std::io::Result<_>>()?;
    let mut inputs = Vec::new();
    for _ in 0..read_u32(&mut r)? {
        let kind = read_u8(&mut r)?;
        let path = PathBuf::from(read_string(&mut r)?);
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
    let mut layer = Layer {
        inputs,
        entries: Vec::new(),
        notes,
    };
    if !holds(&layer) {
        return Ok(None);
    }
    let count = read_u64(&mut r)?;
    for _ in 0..count {
        let kind = read_u8(&mut r)?;
        let path = PathBuf::from(read_string(&mut r)?);
        layer.entries.push(match kind {
            0 => Entry::Dir { path },
            1 => {
                let len = usize::try_from(read_u64(&mut r)?).map_err(|_| bad("file too large"))?;
                let mut data = vec![0u8; len];
                r.read_exact(&mut data)?;
                Entry::File {
                    path,
                    data: data.into(),
                }
            }
            2 => Entry::Symlink {
                path,
                target: PathBuf::from(read_string(&mut r)?),
            },
            _ => return Err(bad("unknown entry kind")),
        });
    }
    // Reading to the end is what makes zstd check the frame checksum; a
    // truncated or damaged file fails here, before anything is applied.
    let mut rest = Vec::new();
    r.read_to_end(&mut rest)?;
    if !rest.is_empty() {
        return Err(bad("trailing bytes"));
    }
    Ok(Some(layer))
}

fn encode(w: &mut impl Write, layer: &Layer) -> std::io::Result<()> {
    w.write_all(MAGIC)?;
    w.write_all(&FORMAT.to_le_bytes())?;
    write_u32(w, layer.notes.len())?;
    for note in &layer.notes {
        write_str(w, note)?;
    }
    write_u32(w, layer.inputs.len())?;
    for input in &layer.inputs {
        match input {
            Input::File { path, sha256 } => {
                w.write_all(&[0])?;
                write_path(w, path)?;
                w.write_all(sha256)?;
            }
            Input::Dir { path } => {
                w.write_all(&[1])?;
                write_path(w, path)?;
            }
            Input::Absent { path } => {
                w.write_all(&[2])?;
                write_path(w, path)?;
            }
        }
    }
    w.write_all(&(layer.entries.len() as u64).to_le_bytes())?;
    for entry in &layer.entries {
        match entry {
            Entry::Dir { path } => {
                w.write_all(&[0])?;
                write_path(w, path)?;
            }
            Entry::File { path, data } => {
                w.write_all(&[1])?;
                write_path(w, path)?;
                w.write_all(&(data.len() as u64).to_le_bytes())?;
                w.write_all(data)?;
            }
            Entry::Symlink { path, target } => {
                w.write_all(&[2])?;
                write_path(w, path)?;
                write_path(w, target)?;
            }
        }
    }
    Ok(())
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
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        let runs = AtomicUsize::new(0);
        LayerCache::new(Some(dir.clone()))
            .install(&checkout(), "k", install(&runs))
            .unwrap();
        let file = std::fs::read_dir(dir.join(key_dir(&format!("v{LAYOUT_VERSION}\0k"))))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "layer"))
            .unwrap();
        let mut bytes = std::fs::read(&file).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xff;
        std::fs::write(&file, bytes).unwrap();

        let fresh = LayerCache::new(Some(dir.clone()));
        let target = checkout();
        assert_eq!(
            fresh.install(&target, "k", install(&runs)).unwrap().0,
            Outcome::Installed
        );
        assert_eq!(
            target.read("/app/node_modules/a/index.js").unwrap(),
            b"lock v1default"
        );
        assert_eq!(runs.load(Ordering::SeqCst), 2);
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
