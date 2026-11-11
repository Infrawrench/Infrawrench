//! The shared engine and the compiled-module cache.
//!
//! Compiling a large module (the TypeScript compiler is over 4 MB of wasm)
//! takes seconds, and jobs must start in milliseconds, so every module is
//! compiled once per machine. The artifact goes to disk keyed by the wasm's
//! sha256 and a fingerprint of everything that decides whether native code
//! is still valid (wasmer version, artifact format, compiler settings, target
//! and wasm features). Within a process the compiled `Module`s also stay in
//! memory, where a clone is a reference count.
//!
//! Nothing is compiled with the shared engine itself. wasmer holds an
//! engine's lock for the whole of a compile, and every job needs that lock
//! to start a process, so a compile on the shared engine stopped every job
//! until it ended (#963). See [`ModuleStore::compile`].
//!
//! Loading an artifact runs `Module::deserialize`, which in wasmer 7.5 trusts
//! its input completely: the bytes become executable code. The cache
//! directory is the runner's own, but a truncated write, a disk error or a
//! stray edit must still never reach that call, so every artifact has its
//! sha256 written next to it and the two are compared first. A mismatch
//! removes both and recompiles. The digest guards integrity, not
//! authenticity: whoever can write the cache directory can write both
//! files, and that directory must be as trusted as the runner binary.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use wasmer::sys::{Cranelift, EngineBuilder, NativeEngineExt};
use wasmer::{Engine, Module};
use wasmer_types::ModuleHash;
use wasmer_wasix::runtime::module_cache::{CacheError, ModuleCache};

use crate::{Error, Result};

/// How many compiled modules stay in memory. A CI run uses a handful (the
/// builtins and an environment's commands); the bound only matters for a
/// long-lived runner that sees many versions over time.
const MEMORY_ENTRIES: usize = 64;

/// The wasm sha256 that identifies a module.
pub(crate) type WasmHash = [u8; 32];

pub(crate) struct ModuleStore {
    engine: Engine,
    dir: PathBuf,
    fingerprint: String,
    memory: Mutex<Lru>,
    /// One lock per module being loaded, so two jobs that need the same
    /// uncached module wait for one compile instead of running two.
    loading: Mutex<HashMap<WasmHash, Arc<Mutex<()>>>>,
    /// Modules being loaded or compiled now, by anyone (see [`Working`]).
    working: AtomicUsize,
    stats: Stats,
}

/// Held while a module is loaded or compiled.
///
/// Loading an artifact into the shared engine holds the engine's lock, and
/// so does every instantiation: another job that starts a process meanwhile
/// waits on that lock, using no CPU and printing nothing. A compile no
/// longer holds it (see [`ModuleStore::compile`]), but the load at its end
/// does, so the stall check (stall.rs) still treats every job as busy while
/// this is held by anyone.
pub(crate) struct Working(Arc<ModuleStore>);

impl Drop for Working {
    fn drop(&mut self) {
        self.0.working.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Default)]
struct Stats {
    compiled: AtomicU64,
    from_disk: AtomicU64,
    from_memory: AtomicU64,
    rejected: AtomicU64,
}

/// Counters for tests and the orchestrator's logs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    /// Modules compiled from wasm in this process.
    pub compiled: u64,
    /// Modules loaded from a verified artifact on disk.
    pub from_disk: u64,
    /// Lookups answered by a module already in memory.
    pub from_memory: u64,
    /// Artifacts on disk that failed verification or deserialisation and
    /// were discarded.
    pub rejected: u64,
}

impl fmt::Debug for ModuleStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModuleStore")
            .field("dir", &self.dir)
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
struct Lru {
    modules: HashMap<WasmHash, Module>,
    order: VecDeque<WasmHash>,
}

impl Lru {
    fn get(&mut self, key: &WasmHash) -> Option<Module> {
        let module = self.modules.get(key)?.clone();
        if let Some(at) = self.order.iter().position(|k| k == key) {
            self.order.remove(at);
        }
        self.order.push_back(*key);
        Some(module)
    }

    fn put(&mut self, key: WasmHash, module: Module) {
        if self.modules.insert(key, module).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > MEMORY_ENTRIES {
            if let Some(old) = self.order.pop_front() {
                self.modules.remove(&old);
            }
        }
    }
}

/// An engine as every job's is built: cranelift, default features for the
/// host. Engines built here make artifacts any other one built here loads.
fn build_engine() -> Engine {
    EngineBuilder::new(Cranelift::new()).engine().into()
}

/// The one engine every job runs on. Its fingerprint names the cache
/// subdirectory.
pub(crate) fn new_engine() -> (Engine, String) {
    let engine = build_engine();
    let features = engine.as_sys().inner().features().clone();
    let target = engine.target().clone();
    let description = format!(
        "wasmer-vm {} | artifact v{} | {} | {} | {} | {:?} | {:?}",
        wasmer::sys::vm::VERSION,
        wasmer_types::MetadataHeader::CURRENT_VERSION,
        engine.deterministic_id(),
        engine.artifact_format(),
        target.triple(),
        target.cpu_features(),
        features,
    );
    let digest = hex::encode(Sha256::digest(description.as_bytes()));
    (engine, digest[..24].to_string())
}

impl ModuleStore {
    pub(crate) fn new(engine: Engine, fingerprint: String, cache_dir: &Path) -> Result<Self> {
        let dir = cache_dir.join(format!("modules-{fingerprint}"));
        std::fs::create_dir_all(&dir).map_err(|e| Error::Cache {
            path: dir.clone(),
            source: e,
        })?;
        Ok(Self {
            engine,
            dir,
            fingerprint,
            memory: Mutex::default(),
            loading: Mutex::default(),
            working: AtomicUsize::new(0),
            stats: Stats::default(),
        })
    }

    /// Marks a module as being loaded or compiled until the guard drops.
    pub(crate) fn working(self: &Arc<Self>) -> Working {
        self.working.fetch_add(1, Ordering::AcqRel);
        Working(self.clone())
    }

    /// Whether any module is being loaded or compiled.
    pub(crate) fn is_working(&self) -> bool {
        self.working.load(Ordering::Acquire) > 0
    }

    pub(crate) fn engine(&self) -> &Engine {
        &self.engine
    }

    pub(crate) fn stats(&self) -> CacheStats {
        CacheStats {
            compiled: self.stats.compiled.load(Ordering::Relaxed),
            from_disk: self.stats.from_disk.load(Ordering::Relaxed),
            from_memory: self.stats.from_memory.load(Ordering::Relaxed),
            rejected: self.stats.rejected.load(Ordering::Relaxed),
        }
    }

    fn artifact_path(&self, key: &WasmHash) -> PathBuf {
        self.dir.join(format!("{}.wasmu", hex::encode(key)))
    }

    fn digest_path(&self, key: &WasmHash) -> PathBuf {
        self.dir.join(format!("{}.wasmu.sha256", hex::encode(key)))
    }

    /// The compiled module for `wasm`, whose sha256 is `key`.
    pub(crate) fn get(self: &Arc<Self>, key: WasmHash, wasm: &[u8]) -> Result<Module> {
        if let Some(module) = self.in_memory(&key) {
            return Ok(module);
        }
        let _working = self.working();
        let slot = {
            let mut loading = self.loading.lock().unwrap_or_else(|e| e.into_inner());
            loading.entry(key).or_default().clone()
        };
        let _guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        // Whoever held the slot before us may have finished the work.
        if let Some(module) = self.in_memory(&key) {
            return Ok(module);
        }
        let module = match self.on_disk(&key) {
            Some(module) => module,
            None => {
                let actual: WasmHash = Sha256::digest(wasm).into();
                if actual != key {
                    return Err(Error::HashMismatch {
                        expected: hex::encode(key),
                        actual: hex::encode(actual),
                    });
                }
                let module = self.compile(&key, wasm)?;
                self.stats.compiled.fetch_add(1, Ordering::Relaxed);
                module
            }
        };
        self.memory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .put(key, module.clone());
        self.loading
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key);
        Ok(module)
    }

    /// Compiles `wasm` without holding the shared engine, and writes the
    /// artifact to disk.
    ///
    /// wasmer 7.5's `Engine::compile` holds its engine's lock from start to
    /// finish (`Artifact::new` takes `inner_mut()` for the compiler and keeps
    /// it), and every instantiation, signature registration and artifact
    /// load takes the same lock. So the compile runs on an engine of its
    /// own, built as the shared one is (same compiler, target and features,
    /// which the fingerprint describes), and its artifact is loaded into the
    /// shared engine exactly as one from disk would be, which holds the
    /// shared lock only while the code is copied in and registered. The
    /// private engine, and the code it kept, go when this returns.
    fn compile(&self, key: &WasmHash, wasm: &[u8]) -> Result<Module> {
        let artifact = {
            let engine = build_engine();
            let module = Module::new(&engine, wasm).map_err(Error::Compile)?;
            module.serialize()
        };
        let Ok(artifact) = artifact else {
            // Not expected; compiling with the shared engine still works.
            let module = Module::new(&self.engine, wasm).map_err(Error::Compile)?;
            let _ = self.to_disk(key, &module);
            return Ok(module);
        };
        // A cache that cannot be written only costs the next process a
        // compile, so the job goes on.
        let _ = self.write_artifact(key, &artifact);
        // SAFETY: the bytes are what `Module::serialize` produced a moment
        // ago, in this process, for an engine built as the shared one is.
        match unsafe { Module::deserialize(&self.engine, artifact) } {
            Ok(module) => Ok(module),
            Err(_) => Module::new(&self.engine, wasm).map_err(Error::Compile),
        }
    }

    fn in_memory(&self, key: &WasmHash) -> Option<Module> {
        let module = self
            .memory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)?;
        self.stats.from_memory.fetch_add(1, Ordering::Relaxed);
        Some(module)
    }

    /// The verified artifact for `key`, or `None` when there is none or it
    /// failed verification (in which case it is deleted).
    fn on_disk(&self, key: &WasmHash) -> Option<Module> {
        let artifact_path = self.artifact_path(key);
        let digest_path = self.digest_path(key);
        let artifact = std::fs::read(&artifact_path).ok()?;
        let expected = std::fs::read_to_string(&digest_path).unwrap_or_default();
        let actual = hex::encode(Sha256::digest(&artifact));
        if expected.trim() != actual {
            self.reject(&artifact_path, &digest_path);
            return None;
        }
        // SAFETY: the bytes are an artifact this runner serialised with an
        // engine of the same fingerprint (the directory name), and their
        // digest matches the one written alongside them, so they are the
        // bytes `Module::serialize` produced.
        match unsafe { Module::deserialize(&self.engine, artifact) } {
            Ok(module) => {
                self.stats.from_disk.fetch_add(1, Ordering::Relaxed);
                Some(module)
            }
            Err(_) => {
                self.reject(&artifact_path, &digest_path);
                None
            }
        }
    }

    fn reject(&self, artifact: &Path, digest: &Path) {
        self.stats.rejected.fetch_add(1, Ordering::Relaxed);
        let _ = std::fs::remove_file(artifact);
        let _ = std::fs::remove_file(digest);
    }

    fn to_disk(&self, key: &WasmHash, module: &Module) -> std::io::Result<()> {
        let bytes = module.serialize().map_err(std::io::Error::other)?;
        self.write_artifact(key, &bytes)
    }

    fn write_artifact(&self, key: &WasmHash, bytes: &[u8]) -> std::io::Result<()> {
        let digest = hex::encode(Sha256::digest(bytes));
        // Each file is written under a unique name and renamed into place,
        // so a reader sees a whole file or none. A reader that sees the new
        // artifact before the new digest fails verification and recompiles,
        // which is slow but safe.
        write_atomically(&self.artifact_path(key), bytes)?;
        write_atomically(&self.digest_path(key), digest.as_bytes())
    }

    /// The module for `key` if it is already compiled, in memory or on disk.
    /// The wasix cache adapter uses this: it has only the hash.
    fn lookup(&self, key: &WasmHash) -> Option<Module> {
        if let Some(module) = self.in_memory(key) {
            return Some(module);
        }
        let module = self.on_disk(key)?;
        self.memory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .put(*key, module.clone());
        Some(module)
    }

    fn store(&self, key: &WasmHash, module: &Module) {
        self.stats.compiled.fetch_add(1, Ordering::Relaxed);
        self.memory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .put(*key, module.clone());
        let _ = self.to_disk(key, module);
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp-{}-{n}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// The same cache, seen through wasmer-wasix's `ModuleCache`, for the
/// commands an environment's shell spawns. The engine wasix passes is a
/// job's clone of ours; clones share compiled code, so artifacts are always
/// loaded with the shared engine.
#[derive(Debug, Clone)]
pub(crate) struct WasixCache(pub(crate) Arc<ModuleStore>);

#[async_trait::async_trait]
impl ModuleCache for WasixCache {
    async fn load(&self, key: ModuleHash, _engine: &Engine) -> Result<Module, CacheError> {
        let key: WasmHash = key
            .as_bytes()
            .try_into()
            .map_err(|_| CacheError::NotFound)?;
        self.0.lookup(&key).ok_or(CacheError::NotFound)
    }

    async fn contains(&self, key: ModuleHash, engine: &Engine) -> Result<bool, CacheError> {
        Ok(self.load(key, engine).await.is_ok())
    }

    async fn save(
        &self,
        key: ModuleHash,
        _engine: &Engine,
        module: &Module,
    ) -> Result<(), CacheError> {
        if let Ok(key) = <WasmHash>::try_from(key.as_bytes()) {
            self.0.store(&key, module);
        }
        Ok(())
    }
}
