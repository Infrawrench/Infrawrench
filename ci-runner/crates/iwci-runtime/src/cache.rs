//! The shared engine and the compiled-module cache.
//!
//! Compiling a large module (the TypeScript compiler is over 4 MB of wasm)
//! takes seconds, and jobs must start in milliseconds, so every module is
//! compiled once per machine. The artifact goes to disk keyed by the wasm's
//! sha256 and a fingerprint of everything that decides whether native code
//! is still valid (wasmer version, artifact format, compiler settings, target
//! and wasm features). Loading an artifact from disk takes tens of
//! milliseconds; within a process a bounded set of loaded `Module`s also
//! stays in memory, where a clone is a reference count.
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
//!
//! # Generations (#1035)
//!
//! wasmer 7.5 keeps the native code of every module loaded into an engine
//! until the engine itself is dropped (`EngineInner::code_memory` only ever
//! grows), so dropping a `Module` frees its copy of the artifact but never
//! its code, and loading it again copies the code in a second time. Memory
//! is therefore bounded by engine, not by module: modules are loaded into a
//! [`Generation`], an engine that a set of jobs shares, and once the
//! modules loaded into the current generation pass the store's limit
//! (`Runtime::with_module_memory`), new jobs get a fresh one. The old one,
//! with every module and all the code in it, is freed when the last job
//! that started on it ends. A job uses one generation from start to finish,
//! for every process, service and module it loads: modules of different
//! engines must never meet in one store, where their signature indices
//! would not agree. The jobs hold the engine (every store does), so a
//! module is never freed from under a job that runs it. At most two
//! generations are kept: while a retired one still has jobs, the current
//! one is not retired again, and grows past the limit instead.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use sha2::{Digest, Sha256};
use wasmer::sys::{Cranelift, EngineBuilder, NativeEngineExt};
use wasmer::{Engine, Module};
use wasmer_types::ModuleHash;
use wasmer_wasix::runtime::module_cache::{CacheError, ModuleCache};

use crate::{Error, Result};

/// How much compiled code a runner keeps loaded by default, counted as the
/// size of the artifacts (their native code takes about a third again).
pub const DEFAULT_MODULE_MEMORY: u64 = 1 << 30;

/// The wasm sha256 that identifies a module.
pub(crate) type WasmHash = [u8; 32];

/// The engine one job runs on from start to finish, with every module it
/// loads (see the module comment). Cloning it is cheap; holding a clone
/// keeps the generation's code alive.
#[derive(Clone)]
pub(crate) struct Generation {
    engine: Engine,
    id: u64,
    /// Held by everyone using the generation; the store sees through a
    /// `Weak` when the last of them is gone.
    alive: Arc<()>,
}

impl Generation {
    fn new(id: u64) -> Self {
        Self {
            engine: build_engine(),
            id,
            alive: Arc::new(()),
        }
    }

    pub(crate) fn engine(&self) -> &Engine {
        &self.engine
    }
}

impl fmt::Debug for Generation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Generation").field("id", &self.id).finish()
    }
}

pub(crate) struct ModuleStore {
    dir: PathBuf,
    fingerprint: String,
    resident: Mutex<Resident>,
    /// Bytes of artifacts the current generation may load before new jobs
    /// get a fresh one.
    limit: AtomicU64,
    /// One lock per module being loaded, so two jobs that need the same
    /// uncached module wait for one compile instead of running two.
    loading: Mutex<HashMap<WasmHash, Arc<Mutex<()>>>>,
    /// Artifacts this process has seen whole on disk, so warming does not
    /// read them again every round. A load still verifies its artifact.
    on_disk: Mutex<HashSet<WasmHash>>,
    /// Modules being loaded or compiled now, by anyone (see [`Working`]).
    working: AtomicUsize,
    stats: Stats,
}

/// The modules in memory, by generation.
struct Resident {
    current: Generation,
    /// The current generation's modules and a retired one's while it still
    /// has jobs. Never more than two.
    generations: Vec<Loaded>,
}

/// The modules loaded into one generation.
struct Loaded {
    // Declared before `engine`, so the modules are dropped before the code
    // they point into.
    modules: HashMap<WasmHash, Module>,
    _engine: Engine,
    id: u64,
    alive: Weak<()>,
    /// Artifact bytes loaded into it.
    bytes: u64,
}

impl Resident {
    /// Forgets retired generations whose jobs have all ended. Their engine
    /// (and its code) goes with the last job's store.
    fn prune(&mut self) {
        let current = self.current.id;
        self.generations
            .retain(|g| g.id == current || g.alive.strong_count() > 0);
    }

    fn loaded(&mut self, id: u64) -> Option<&mut Loaded> {
        self.generations.iter_mut().find(|g| g.id == id)
    }

    fn bytes(&self) -> u64 {
        self.generations.iter().map(|g| g.bytes).sum()
    }
}

/// Held while a module is loaded or compiled.
///
/// Loading an artifact into an engine holds the engine's lock, and so does
/// every instantiation: another job that starts a process meanwhile waits
/// on that lock, using no CPU and printing nothing. A compile no longer
/// holds it (see [`ModuleStore::compile`]), but the load at its end does,
/// so the stall check (stall.rs) still treats every job as busy while this
/// is held by anyone.
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
    retired: AtomicU64,
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
    /// Generations retired for passing the memory limit.
    pub retired: u64,
    /// Artifact bytes loaded into the generations still in memory.
    pub resident_bytes: u64,
}

impl fmt::Debug for ModuleStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModuleStore")
            .field("dir", &self.dir)
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

/// An engine as every job's is built: cranelift, default features for the
/// host. Engines built here make artifacts any other one built here loads.
pub(crate) fn build_engine() -> Engine {
    EngineBuilder::new(Cranelift::new()).engine().into()
}

/// The fingerprint of the engines built here, which names the cache
/// subdirectory.
pub(crate) fn fingerprint() -> String {
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
    digest[..24].to_string()
}

impl ModuleStore {
    pub(crate) fn new(fingerprint: String, cache_dir: &Path) -> Result<Self> {
        let dir = cache_dir.join(format!("modules-{fingerprint}"));
        std::fs::create_dir_all(&dir).map_err(|e| Error::Cache {
            path: dir.clone(),
            source: e,
        })?;
        let current = Generation::new(0);
        let loaded = Loaded {
            modules: HashMap::new(),
            _engine: current.engine.clone(),
            id: current.id,
            alive: Arc::downgrade(&current.alive),
            bytes: 0,
        };
        Ok(Self {
            dir,
            fingerprint,
            resident: Mutex::new(Resident {
                current,
                generations: vec![loaded],
            }),
            limit: AtomicU64::new(DEFAULT_MODULE_MEMORY),
            loading: Mutex::default(),
            on_disk: Mutex::default(),
            working: AtomicUsize::new(0),
            stats: Stats::default(),
        })
    }

    /// Sets how many bytes of artifacts the current generation loads before
    /// new jobs get a fresh one.
    pub(crate) fn set_limit(&self, bytes: u64) {
        self.limit.store(bytes, Ordering::Relaxed);
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

    /// The generation a job starting now runs on.
    pub(crate) fn generation(&self) -> Generation {
        self.resident().current.clone()
    }

    fn resident(&self) -> std::sync::MutexGuard<'_, Resident> {
        self.resident.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forgets a retired generation whose jobs have all ended.
    pub(crate) fn release_idle(&self) {
        self.resident().prune();
    }

    pub(crate) fn stats(&self) -> CacheStats {
        let resident_bytes = {
            let mut resident = self.resident();
            resident.prune();
            resident.bytes()
        };
        CacheStats {
            compiled: self.stats.compiled.load(Ordering::Relaxed),
            from_disk: self.stats.from_disk.load(Ordering::Relaxed),
            from_memory: self.stats.from_memory.load(Ordering::Relaxed),
            rejected: self.stats.rejected.load(Ordering::Relaxed),
            retired: self.stats.retired.load(Ordering::Relaxed),
            resident_bytes,
        }
    }

    fn artifact_path(&self, key: &WasmHash) -> PathBuf {
        self.dir.join(format!("{}.wasmu", hex::encode(key)))
    }

    fn digest_path(&self, key: &WasmHash) -> PathBuf {
        self.dir.join(format!("{}.wasmu.sha256", hex::encode(key)))
    }

    fn slot(&self, key: &WasmHash) -> Arc<Mutex<()>> {
        let mut loading = self.loading.lock().unwrap_or_else(|e| e.into_inner());
        loading.entry(*key).or_default().clone()
    }

    fn release_slot(&self, key: &WasmHash) {
        self.loading
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(key);
    }

    /// The compiled module for `wasm`, whose sha256 is `key`, in `generation`.
    pub(crate) fn get(
        self: &Arc<Self>,
        generation: &Generation,
        key: WasmHash,
        wasm: &[u8],
    ) -> Result<Module> {
        if let Some(module) = self.in_memory(generation, &key) {
            return Ok(module);
        }
        let _working = self.working();
        let slot = self.slot(&key);
        let _guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        // Whoever held the slot before us may have finished the work.
        if let Some(module) = self.in_memory(generation, &key) {
            return Ok(module);
        }
        let result = match self.on_disk(generation, &key) {
            Some(loaded) => Ok(loaded),
            None => self.check_and_compile(&key, wasm).and_then(|artifact| {
                let compiled = self.load_compiled(generation, &key, wasm, artifact);
                self.stats.compiled.fetch_add(1, Ordering::Relaxed);
                compiled
            }),
        };
        self.release_slot(&key);
        let (module, bytes) = result?;
        self.keep(generation, key, &module, bytes);
        Ok(module)
    }

    /// Makes sure `wasm`'s artifact is on disk, compiling it if it is not,
    /// without loading it into any generation: warming fills the disk
    /// cache, and a job loads what it uses.
    pub(crate) fn ensure_compiled(self: &Arc<Self>, key: WasmHash, wasm: &[u8]) -> Result<()> {
        if self.known_on_disk(&key) {
            return Ok(());
        }
        let _working = self.working();
        let slot = self.slot(&key);
        let _guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        let result = if self.known_on_disk(&key) || self.read_verified(&key).is_some() {
            Ok(())
        } else {
            self.check_and_compile(&key, wasm).map(|artifact| {
                self.stats.compiled.fetch_add(1, Ordering::Relaxed);
                drop(artifact);
            })
        };
        self.release_slot(&key);
        if result.is_ok() && self.artifact_path(&key).exists() {
            self.on_disk
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key);
        }
        result
    }

    fn known_on_disk(&self, key: &WasmHash) -> bool {
        self.on_disk
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(key)
            && self.artifact_path(key).exists()
    }

    /// Checks `wasm` against `key` and compiles it into an artifact.
    fn check_and_compile(&self, key: &WasmHash, wasm: &[u8]) -> Result<Option<bytes::Bytes>> {
        let actual: WasmHash = Sha256::digest(wasm).into();
        if actual != *key {
            return Err(Error::HashMismatch {
                expected: hex::encode(key),
                actual: hex::encode(actual),
            });
        }
        self.compile(key, wasm)
    }

    /// Compiles `wasm` without holding any engine a job uses, and writes the
    /// artifact to disk. `None` when the artifact could not be serialised,
    /// which is not expected; the caller then compiles in place.
    ///
    /// wasmer 7.5's `Engine::compile` holds its engine's lock from start to
    /// finish (`Artifact::new` takes `inner_mut()` for the compiler and keeps
    /// it), and every instantiation, signature registration and artifact
    /// load takes the same lock. So the compile runs on an engine of its
    /// own, built as the jobs' are (same compiler, target and features,
    /// which the fingerprint describes), and its artifact is loaded into a
    /// job's generation exactly as one from disk would be, which holds that
    /// engine's lock only while the code is copied in and registered. The
    /// private engine, and the code it kept, go when this returns.
    fn compile(&self, key: &WasmHash, wasm: &[u8]) -> Result<Option<bytes::Bytes>> {
        let engine = build_engine();
        let module = Module::new(&engine, wasm).map_err(Error::Compile)?;
        let Ok(artifact) = module.serialize() else {
            return Ok(None);
        };
        // A cache that cannot be written only costs the next load a
        // compile, so the job goes on.
        let _ = self.write_artifact(key, &artifact);
        Ok(Some(artifact))
    }

    /// Loads a fresh artifact into `generation`.
    fn load_compiled(
        &self,
        generation: &Generation,
        key: &WasmHash,
        wasm: &[u8],
        artifact: Option<bytes::Bytes>,
    ) -> Result<(Module, u64)> {
        if let Some(artifact) = artifact {
            let bytes = artifact.len() as u64;
            // SAFETY: the bytes are what `Module::serialize` produced a
            // moment ago, in this process, for an engine built as every
            // generation's is.
            if let Ok(module) = unsafe { Module::deserialize(&generation.engine, artifact) } {
                return Ok((module, bytes));
            }
        }
        let module = Module::new(&generation.engine, wasm).map_err(Error::Compile)?;
        let _ = self.to_disk(key, &module);
        Ok((module, wasm.len() as u64))
    }

    fn in_memory(&self, generation: &Generation, key: &WasmHash) -> Option<Module> {
        let module = self
            .resident()
            .loaded(generation.id)?
            .modules
            .get(key)?
            .clone();
        self.stats.from_memory.fetch_add(1, Ordering::Relaxed);
        Some(module)
    }

    /// Remembers `module`, loaded into `generation`, and retires the
    /// current generation once it holds more than the limit.
    fn keep(&self, generation: &Generation, key: WasmHash, module: &Module, bytes: u64) {
        let limit = self.limit.load(Ordering::Relaxed);
        let mut resident = self.resident();
        resident.prune();
        let Some(loaded) = resident.loaded(generation.id) else {
            return;
        };
        if loaded.modules.insert(key, module.clone()).is_none() {
            loaded.bytes += bytes;
        }
        let full = loaded.bytes > limit;
        if generation.id == resident.current.id && full && resident.generations.len() == 1 {
            let next = Generation::new(generation.id + 1);
            resident.generations.push(Loaded {
                modules: HashMap::new(),
                _engine: next.engine.clone(),
                id: next.id,
                alive: Arc::downgrade(&next.alive),
                bytes: 0,
            });
            resident.current = next;
            // Without jobs, the old generation goes now.
            resident.prune();
            self.stats.retired.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The artifact for `key` if it is on disk and its digest matches;
    /// otherwise `None`, and a mismatched one is deleted.
    fn read_verified(&self, key: &WasmHash) -> Option<Vec<u8>> {
        let artifact_path = self.artifact_path(key);
        let digest_path = self.digest_path(key);
        let artifact = std::fs::read(&artifact_path).ok()?;
        let expected = std::fs::read_to_string(&digest_path).unwrap_or_default();
        let actual = hex::encode(Sha256::digest(&artifact));
        if expected.trim() != actual {
            self.reject(&artifact_path, &digest_path);
            return None;
        }
        Some(artifact)
    }

    /// The verified artifact for `key`, loaded into `generation`, with its
    /// size; `None` when there is none or it failed verification (in which
    /// case it is deleted).
    fn on_disk(&self, generation: &Generation, key: &WasmHash) -> Option<(Module, u64)> {
        let artifact = self.read_verified(key)?;
        let bytes = artifact.len() as u64;
        // SAFETY: the bytes are an artifact this runner serialised with an
        // engine of the same fingerprint (the directory name), and their
        // digest matches the one written alongside them, so they are the
        // bytes `Module::serialize` produced.
        match unsafe { Module::deserialize(&generation.engine, artifact) } {
            Ok(module) => {
                self.stats.from_disk.fetch_add(1, Ordering::Relaxed);
                Some((module, bytes))
            }
            Err(_) => {
                self.reject(&self.artifact_path(key), &self.digest_path(key));
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

    /// The module for `key` in `generation` if it is already compiled, in
    /// memory or on disk. The wasix cache adapter uses this: it has only
    /// the hash.
    fn lookup(&self, generation: &Generation, key: &WasmHash) -> Option<Module> {
        if let Some(module) = self.in_memory(generation, key) {
            return Some(module);
        }
        let (module, bytes) = self.on_disk(generation, key)?;
        self.keep(generation, *key, &module, bytes);
        Some(module)
    }

    /// A module wasmer-wasix compiled itself, with an engine it chose: it
    /// goes to disk only, and a job loads it into its own generation.
    fn store(&self, key: &WasmHash, module: &Module) {
        self.stats.compiled.fetch_add(1, Ordering::Relaxed);
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
/// commands an environment's shell spawns: one job's, so modules load into
/// that job's generation, whatever engine wasix passes (a clone of it).
#[derive(Debug, Clone)]
pub(crate) struct WasixCache(pub(crate) Arc<ModuleStore>, pub(crate) Generation);

#[async_trait::async_trait]
impl ModuleCache for WasixCache {
    async fn load(&self, key: ModuleHash, _engine: &Engine) -> Result<Module, CacheError> {
        let key: WasmHash = key
            .as_bytes()
            .try_into()
            .map_err(|_| CacheError::NotFound)?;
        self.0.lookup(&self.1, &key).ok_or(CacheError::NotFound)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A module whose artifact is about `functions` KiB.
    fn sample(seed: u32, functions: u32) -> (WasmHash, Vec<u8>) {
        let mut wat = String::from("(module");
        for f in 0..functions {
            wat.push_str(&format!(
                "(func (export \"f{f}\") (result i32) i32.const {seed} {} )",
                "i32.const 1 i32.add ".repeat(64)
            ));
        }
        wat.push(')');
        let wasm = wat::parse_str(&wat).unwrap();
        (Sha256::digest(&wasm).into(), wasm)
    }

    fn store(limit: u64) -> (PathBuf, Arc<ModuleStore>) {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "iwci-module-store-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let store = Arc::new(ModuleStore::new(fingerprint(), &dir).unwrap());
        store.set_limit(limit);
        (dir, store)
    }

    #[test]
    fn warming_fills_the_disk_and_nothing_stays_in_memory() {
        let (dir, store) = store(u64::MAX);
        let (key, wasm) = sample(1, 4);
        store.ensure_compiled(key, &wasm).unwrap();
        store.ensure_compiled(key, &wasm).unwrap();
        let stats = store.stats();
        assert_eq!((stats.compiled, stats.resident_bytes), (1, 0), "{stats:?}");
        // A job then loads the artifact rather than compiling.
        let generation = store.generation();
        store.get(&generation, key, &wasm).unwrap();
        let stats = store.stats();
        assert_eq!((stats.compiled, stats.from_disk), (1, 1), "{stats:?}");
        assert!(stats.resident_bytes > 0);
        // A new process finds the artifact and compiles nothing.
        let again = Arc::new(ModuleStore::new(fingerprint(), &dir).unwrap());
        again.ensure_compiled(key, &wasm).unwrap();
        assert_eq!(again.stats().compiled, 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn memory_is_bounded_by_retiring_a_generation_and_modules_reload_from_disk() {
        let (dir, store) = store(0);
        let (key, wasm) = sample(1, 4);
        let (other, other_wasm) = sample(2, 4);
        store.ensure_compiled(key, &wasm).unwrap();
        store.ensure_compiled(other, &other_wasm).unwrap();

        // Over a zero limit, one module retires the generation that loaded
        // it, and with no job left on it, it is freed at once.
        let first = store.generation();
        store.get(&first, key, &wasm).unwrap();
        drop(first);
        let stats = store.stats();
        assert_eq!((stats.retired, stats.resident_bytes), (1, 0), "{stats:?}");

        // The next job gets a new generation and loads from disk again.
        let second = store.generation();
        store.get(&second, key, &wasm).unwrap();
        assert_eq!(store.stats().from_disk, 2);
        assert_eq!(store.stats().compiled, 2, "only the two warming compiles");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_running_job_keeps_its_generation_and_its_modules() {
        let (dir, store) = store(0);
        let (key, wasm) = sample(1, 4);
        let (other, other_wasm) = sample(2, 4);
        // A job on the generation about to be retired.
        let running = store.generation();
        let module = store.get(&running, key, &wasm).unwrap();
        assert_eq!(store.stats().retired, 1);
        // Its modules stay in memory for it, and what it loads next joins
        // them, in its own generation.
        let again = store.get(&running, key, &wasm).unwrap();
        assert_eq!(store.stats().from_memory, 1);
        store.get(&running, other, &other_wasm).unwrap();
        assert!(store.stats().resident_bytes > 0);
        // While it runs, the generation after it is not retired in turn:
        // at most two are kept.
        let next = store.generation();
        store.get(&next, key, &wasm).unwrap();
        store.get(&next, other, &other_wasm).unwrap();
        assert_eq!(store.stats().retired, 1);
        // The job's module still runs.
        let mut s = wasmer::Store::new(running.engine().clone());
        let instance = wasmer::Instance::new(&mut s, &module, &wasmer::imports! {}).unwrap();
        let f = instance.exports.get_function("f0").unwrap();
        assert_eq!(f.call(&mut s, &[]).unwrap()[0].unwrap_i32(), 65);
        drop((s, instance, module, again, running));
        // Once it ends, its generation goes, and the current one retires
        // on its next load; when the last job on that one ends, nothing is
        // left in memory.
        let (third, third_wasm) = sample(3, 1);
        store.get(&next, third, &third_wasm).unwrap();
        assert_eq!(store.stats().retired, 2);
        drop(next);
        let stats = store.stats();
        assert_eq!(stats.resident_bytes, 0, "{stats:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn under_the_limit_a_generation_keeps_its_modules() {
        let (dir, store) = store(u64::MAX);
        let (key, wasm) = sample(1, 4);
        let generation = store.generation();
        store.get(&generation, key, &wasm).unwrap();
        drop(generation);
        let later = store.generation();
        store.get(&later, key, &wasm).unwrap();
        let stats = store.stats();
        assert_eq!(
            (stats.compiled, stats.from_memory, stats.retired),
            (1, 1, 0),
            "{stats:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
