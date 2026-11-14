//! The engines and the compiled-module cache.
//!
//! Compiling a large module (the TypeScript compiler is over 4 MB of wasm)
//! takes seconds, and jobs must start in milliseconds, so every module is
//! compiled once per machine. The artifact goes to disk keyed by the wasm's
//! sha256 and a fingerprint of everything that decides whether native code
//! is still valid (wasmer version, artifact format, compiler settings, target
//! and wasm features). Loading an artifact from disk takes tens of
//! milliseconds; within a process the modules jobs use most also stay in
//! memory (below), where getting one is a reference count.
//!
//! Nothing is compiled with an engine a job uses. wasmer holds an engine's
//! lock for the whole of a compile, and a compile on the engine every job
//! shared stopped every job until it ended (#963). See
//! [`ModuleStore::compile`].
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
//! # Engines, pinning and the LRU
//!
//! wasmer 7.5 keeps the native code of every module loaded into an engine
//! until the engine itself is dropped (`EngineInner::code_memory` only ever
//! grows), so dropping a `Module` frees its copy of the artifact but never
//! its code. What can be freed on its own is an engine, so every module is
//! loaded into an engine of its own ([`Compiled`]), and freeing the module
//! is dropping the two together.
//!
//! A job's stores are made from an engine of the job's own ([`JobModules`]),
//! which holds the signatures of host functions and of the modules the job
//! loaded, not their code. Modules of different engines meet in one store
//! safely because wasmer 7.5 identifies a function signature by a hash of
//! its type (`FunctionType::signature_hash`), the same in every engine, not
//! by an index into one engine's registry. What a store's engine must still
//! know is every signature a funcref in it can have (host code reading a
//! table looks the hash up there and panics on a miss), so a module's
//! signatures are registered with the job's engine when the job gets it.
//! Side modules a job links at run time go through the same path.
//!
//! The job holds every module it got until the last of its stores is gone:
//! the job's engine carries a reference to them in its tunables
//! (`LimitingTunables`), which every store of the job holds. So a module is
//! never freed while anything of a job can still run its code.
//!
//! The store keeps modules in memory between jobs in two ways:
//!
//! - **Pinned**: a module whose artifact is at most `pin_under` bytes stays
//!   loaded for the life of the process, while the pinned modules together
//!   stay within `pinned_budget`. tsc-rs, gofmt, oxfmt, bash and git are
//!   tens of megabytes each, and a job of any environment starts several.
//! - **The LRU**: every other module. When the modules in it pass
//!   `lru_budget`, the least recently used of those no job is using are
//!   freed until they fit again. A module in use is never freed, so the
//!   LRU can be over its budget while jobs use more than it holds; the
//!   next load or idle sweep brings it back within it.
//!
//! Both are counted as the size of the modules' artifacts, and both are
//! reported (`/v1/capacity`), pinned and LRU apart.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use sha2::{Digest, Sha256};
use wasmer::sys::{Cranelift, EngineBuilder, NativeEngineExt};
use wasmer::{Engine, Module};
use wasmer_types::ModuleHash;
use wasmer_wasix::runtime::module_cache::{CacheError, ModuleCache};

use crate::{Error, Result};

/// How many bytes of artifacts the LRU keeps by default (see the module
/// comment). Two or three Edge.js versions with Python, PHP, Go and
/// ClickHouse beside them.
pub const DEFAULT_MODULE_MEMORY: u64 = 2 << 30;

/// The largest artifact pinned by default.
pub const DEFAULT_PIN_UNDER: u64 = 64 << 20;

/// How many bytes of artifacts are pinned at most by default.
pub const DEFAULT_PINNED_MEMORY: u64 = 512 << 20;

/// The wasm sha256 that identifies a module.
pub(crate) type WasmHash = [u8; 32];

/// One compiled module, loaded into an engine of its own: dropping it frees
/// its native code.
pub(crate) struct Compiled {
    // Declared before `_engine`, so the module is dropped before the code
    // it points into.
    module: Module,
    _engine: Engine,
    /// Artifact bytes, what the budgets count.
    bytes: u64,
}

/// The engine one job's stores are made from, and every module the job has
/// loaded, which it holds until the job and all of its stores are gone (see
/// the module comment). Cloning it is cheap.
#[derive(Clone)]
pub(crate) struct JobModules(Arc<JobModulesInner>);

struct JobModulesInner {
    /// Holds signatures, and code only when wasmer-wasix compiles on it
    /// itself (a linked module the disk cache does not have), which goes
    /// with the job. Every store of the job is made from a clone of it with
    /// the job's tunables, which hold this.
    engine: Engine,
    held: Mutex<HashMap<WasmHash, Arc<Compiled>>>,
}

impl JobModules {
    pub(crate) fn new() -> Self {
        Self(Arc::new(JobModulesInner {
            engine: build_engine(),
            held: Mutex::default(),
        }))
    }

    pub(crate) fn engine(&self) -> &Engine {
        &self.0.engine
    }

    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<WasmHash, Arc<Compiled>>> {
        self.0.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn module(&self, key: &WasmHash) -> Option<Module> {
        self.held().get(key).map(|c| c.module.clone())
    }

    /// Keeps `compiled` for the job and teaches the job's engine its
    /// signatures, so a store of the job can run it.
    fn hold(&self, key: WasmHash, compiled: Arc<Compiled>) -> Module {
        let mut held = self.held();
        if let Some(already) = held.get(&key) {
            return already.module.clone();
        }
        let engine = self.0.engine.as_sys();
        // `Module::info` is wasmer's own view of the module (doc-hidden,
        // and its shape changes between releases): a wasmer bump checks
        // this still lists every signature the module's code uses.
        for (_, signature) in compiled.module.info().signatures.iter() {
            engine.register_signature(signature);
        }
        let module = compiled.module.clone();
        held.insert(key, compiled);
        module
    }
}

impl fmt::Debug for JobModules {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JobModules")
            .field("modules", &self.held().len())
            .finish()
    }
}

/// How the store keeps modules in memory (see the module comment).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModuleLimits {
    /// Bytes of artifacts the LRU keeps.
    pub lru_budget: u64,
    /// A module whose artifact is at most this is pinned; 0 pins nothing.
    pub pin_under: u64,
    /// Bytes of artifacts pinned at most.
    pub pinned_budget: u64,
}

impl Default for ModuleLimits {
    fn default() -> Self {
        Self {
            lru_budget: DEFAULT_MODULE_MEMORY,
            pin_under: DEFAULT_PIN_UNDER,
            pinned_budget: DEFAULT_PINNED_MEMORY,
        }
    }
}

pub(crate) struct ModuleStore {
    dir: PathBuf,
    fingerprint: String,
    resident: Mutex<Resident>,
    limits: Mutex<ModuleLimits>,
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

/// The modules in memory.
#[derive(Default)]
struct Resident {
    pinned: HashMap<WasmHash, Kept>,
    lru: HashMap<WasmHash, Kept>,
    /// Ticks on every use, for the LRU's order.
    clock: u64,
}

struct Kept {
    compiled: Arc<Compiled>,
    /// The clock at its last use.
    used: u64,
    used_at: Instant,
    /// What it was last loaded as, for `/v1/capacity`.
    name: String,
}

impl Kept {
    /// Whether a job holds it: the store's is then not the only reference.
    fn in_use(&self) -> bool {
        Arc::strong_count(&self.compiled) > 1
    }
}

impl Resident {
    fn bytes(map: &HashMap<WasmHash, Kept>) -> u64 {
        map.values().map(|k| k.compiled.bytes).sum()
    }

    fn find(&mut self, key: &WasmHash, name: Option<&str>) -> Option<Arc<Compiled>> {
        self.clock += 1;
        let clock = self.clock;
        let kept = match self.pinned.get_mut(key) {
            Some(kept) => kept,
            None => self.lru.get_mut(key)?,
        };
        kept.used = clock;
        kept.used_at = Instant::now();
        if let Some(name) = name {
            name.clone_into(&mut kept.name);
        }
        Some(kept.compiled.clone())
    }

    /// Takes in a module just loaded: pinned when it is small enough and
    /// there is room, into the LRU otherwise.
    fn admit(&mut self, key: WasmHash, compiled: Arc<Compiled>, name: &str, limits: &ModuleLimits) {
        self.clock += 1;
        let pin = compiled.bytes <= limits.pin_under
            && Self::bytes(&self.pinned) + compiled.bytes <= limits.pinned_budget;
        let kept = Kept {
            compiled,
            used: self.clock,
            used_at: Instant::now(),
            name: name.to_owned(),
        };
        if pin {
            self.pinned.insert(key, kept);
        } else {
            self.lru.insert(key, kept);
        }
    }

    /// Takes the least recently used modules no job is using out of the
    /// LRU until it is within `budget`, or only modules in use are left.
    /// The caller drops them, outside the lock: dropping an engine unmaps
    /// its code.
    fn evict(&mut self, budget: u64) -> Vec<Arc<Compiled>> {
        let mut bytes = Self::bytes(&self.lru);
        let mut freed = Vec::new();
        while bytes > budget {
            let Some(key) = self
                .lru
                .iter()
                .filter(|(_, kept)| !kept.in_use())
                .min_by_key(|(_, kept)| kept.used)
                .map(|(key, _)| *key)
            else {
                break;
            };
            let kept = self.lru.remove(&key).expect("just found");
            bytes -= kept.compiled.bytes;
            freed.push(kept.compiled);
        }
        freed
    }
}

/// Held while a module is loaded or compiled.
///
/// Loading an artifact holds its engine's lock while its code is copied in.
/// Each module has an engine of its own, so that no longer stops other
/// jobs, but the stall check (stall.rs) still treats every job as busy
/// while this is held by anyone, as it did when it did.
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
    evicted: AtomicU64,
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
    /// Modules the LRU freed to stay within its budget.
    pub evicted: u64,
    /// Artifact bytes of the pinned modules.
    pub pinned_bytes: u64,
    /// Artifact bytes of the modules in the LRU, in use or not.
    pub lru_bytes: u64,
    /// The part of `lru_bytes` jobs are using now.
    pub lru_in_use_bytes: u64,
    /// Every module in memory: `pinned_bytes` plus `lru_bytes`.
    pub resident_bytes: u64,
}

/// One module in memory, for `/v1/capacity`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidentModule {
    /// The command or module it was last loaded as (`node`, `bash`), or
    /// empty when the loader did not say.
    pub name: String,
    /// The wasm's sha256, in hex.
    pub sha256: String,
    /// Its artifact's size.
    pub bytes: u64,
    pub pinned: bool,
    /// Whether a job is using it now.
    pub in_use: bool,
    /// Seconds since a job last got it.
    pub idle_secs: u64,
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
        Ok(Self {
            dir,
            fingerprint,
            resident: Mutex::default(),
            limits: Mutex::new(ModuleLimits::default()),
            loading: Mutex::default(),
            on_disk: Mutex::default(),
            working: AtomicUsize::new(0),
            stats: Stats::default(),
        })
    }

    /// Sets how modules are kept in memory; the LRU is brought within its
    /// new budget at once. Pinned modules stay pinned.
    pub(crate) fn set_limits(&self, limits: ModuleLimits) {
        *self.limits.lock().unwrap_or_else(|e| e.into_inner()) = limits;
        self.release_idle();
    }

    pub(crate) fn limits(&self) -> ModuleLimits {
        *self.limits.lock().unwrap_or_else(|e| e.into_inner())
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

    fn resident(&self) -> std::sync::MutexGuard<'_, Resident> {
        self.resident.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Frees the least recently used modules no job is using, while the
    /// LRU is over its budget.
    pub(crate) fn release_idle(&self) {
        let budget = self.limits().lru_budget;
        let freed = self.resident().evict(budget);
        self.stats
            .evicted
            .fetch_add(freed.len() as u64, Ordering::Relaxed);
        drop(freed);
    }

    pub(crate) fn stats(&self) -> CacheStats {
        self.release_idle();
        let (pinned_bytes, lru_bytes, lru_in_use_bytes) = {
            let resident = self.resident();
            let in_use = resident
                .lru
                .values()
                .filter(|k| k.in_use())
                .map(|k| k.compiled.bytes)
                .sum();
            (
                Resident::bytes(&resident.pinned),
                Resident::bytes(&resident.lru),
                in_use,
            )
        };
        CacheStats {
            compiled: self.stats.compiled.load(Ordering::Relaxed),
            from_disk: self.stats.from_disk.load(Ordering::Relaxed),
            from_memory: self.stats.from_memory.load(Ordering::Relaxed),
            rejected: self.stats.rejected.load(Ordering::Relaxed),
            evicted: self.stats.evicted.load(Ordering::Relaxed),
            pinned_bytes,
            lru_bytes,
            lru_in_use_bytes,
            resident_bytes: pinned_bytes + lru_bytes,
        }
    }

    /// Every module in memory, pinned ones first, then the LRU from the
    /// most recently used.
    pub(crate) fn modules(&self) -> Vec<ResidentModule> {
        let resident = self.resident();
        let describe = |key: &WasmHash, kept: &Kept, pinned: bool| ResidentModule {
            name: kept.name.clone(),
            sha256: hex::encode(key),
            bytes: kept.compiled.bytes,
            pinned,
            in_use: kept.in_use(),
            idle_secs: kept.used_at.elapsed().as_secs(),
        };
        let mut pinned: Vec<_> = resident.pinned.iter().collect();
        pinned.sort_by_key(|(_, k)| std::cmp::Reverse(k.used));
        let mut lru: Vec<_> = resident.lru.iter().collect();
        lru.sort_by_key(|(_, k)| std::cmp::Reverse(k.used));
        pinned
            .into_iter()
            .map(|(key, kept)| describe(key, kept, true))
            .chain(
                lru.into_iter()
                    .map(|(key, kept)| describe(key, kept, false)),
            )
            .collect()
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

    /// The compiled module for `wasm`, whose sha256 is `key`, for `job`,
    /// which holds it from now until it ends. `name` is what the module is
    /// run as, for `/v1/capacity`.
    pub(crate) fn get(
        self: &Arc<Self>,
        job: &JobModules,
        key: WasmHash,
        wasm: &[u8],
        name: Option<&str>,
    ) -> Result<Module> {
        if let Some(module) = self.in_memory(job, &key, name) {
            return Ok(module);
        }
        let _working = self.working();
        let slot = self.slot(&key);
        let _guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        // Whoever held the slot before us may have finished the work.
        if let Some(module) = self.in_memory(job, &key, name) {
            return Ok(module);
        }
        let result = match self.on_disk(&key) {
            Some(loaded) => Ok(loaded),
            None => self.check_and_compile(&key, wasm).and_then(|artifact| {
                let compiled = self.load_compiled(&key, wasm, artifact);
                self.stats.compiled.fetch_add(1, Ordering::Relaxed);
                compiled
            }),
        };
        let result = result.map(|compiled| self.keep(job, key, compiled, name));
        self.release_slot(&key);
        result
    }

    /// Makes sure `wasm`'s artifact is on disk, compiling it if it is not,
    /// without loading it: warming fills the disk cache, and a job loads
    /// what it uses.
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

    /// Compiles `wasm` on an engine of its own and writes the artifact to
    /// disk. `None` when the artifact could not be serialised, which is not
    /// expected; the caller then compiles in place.
    ///
    /// wasmer 7.5's `Engine::compile` holds its engine's lock from start to
    /// finish (`Artifact::new` takes `inner_mut()` for the compiler and keeps
    /// it), so the compile must not hold an engine anyone else uses. The
    /// artifact is then loaded as one from disk would be, and the compile's
    /// engine, with the code it kept, goes when this returns.
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

    /// Loads a fresh artifact into an engine of its own.
    fn load_compiled(
        &self,
        key: &WasmHash,
        wasm: &[u8],
        artifact: Option<bytes::Bytes>,
    ) -> Result<Compiled> {
        let engine = build_engine();
        if let Some(artifact) = artifact {
            let bytes = artifact.len() as u64;
            // SAFETY: the bytes are what `Module::serialize` produced a
            // moment ago, in this process, for an engine built as this one
            // is.
            if let Ok(module) = unsafe { Module::deserialize(&engine, artifact) } {
                return Ok(Compiled {
                    module,
                    _engine: engine,
                    bytes,
                });
            }
        }
        let module = Module::new(&engine, wasm).map_err(Error::Compile)?;
        let _ = self.to_disk(key, &module);
        Ok(Compiled {
            module,
            _engine: engine,
            bytes: wasm.len() as u64,
        })
    }

    fn in_memory(&self, job: &JobModules, key: &WasmHash, name: Option<&str>) -> Option<Module> {
        let module = match job.module(key) {
            Some(module) => module,
            None => {
                let compiled = self.resident().find(key, name)?;
                job.hold(*key, compiled)
            }
        };
        self.stats.from_memory.fetch_add(1, Ordering::Relaxed);
        Some(module)
    }

    /// Keeps `compiled`, just loaded, in memory and gives it to `job`; the
    /// LRU then frees what it must to stay within its budget.
    fn keep(
        &self,
        job: &JobModules,
        key: WasmHash,
        compiled: Compiled,
        name: Option<&str>,
    ) -> Module {
        let limits = self.limits();
        let compiled = Arc::new(compiled);
        // The job holds it before the LRU looks for something to free, so
        // it is never the module freed.
        let module = job.hold(key, compiled.clone());
        let freed = {
            let mut resident = self.resident();
            resident.admit(key, compiled, name.unwrap_or_default(), &limits);
            resident.evict(limits.lru_budget)
        };
        self.stats
            .evicted
            .fetch_add(freed.len() as u64, Ordering::Relaxed);
        drop(freed);
        module
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

    /// The verified artifact for `key`, loaded into an engine of its own;
    /// `None` when there is none or it failed verification (in which case
    /// it is deleted).
    fn on_disk(&self, key: &WasmHash) -> Option<Compiled> {
        let artifact = self.read_verified(key)?;
        let bytes = artifact.len() as u64;
        let engine = build_engine();
        // SAFETY: the bytes are an artifact this runner serialised with an
        // engine of the same fingerprint (the directory name), and their
        // digest matches the one written alongside them, so they are the
        // bytes `Module::serialize` produced.
        match unsafe { Module::deserialize(&engine, artifact) } {
            Ok(module) => {
                self.stats.from_disk.fetch_add(1, Ordering::Relaxed);
                Some(Compiled {
                    module,
                    _engine: engine,
                    bytes,
                })
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

    /// The module for `key` for `job` if it is already compiled, in memory
    /// or on disk. The wasix cache adapter uses this: it has only the hash.
    fn lookup(self: &Arc<Self>, job: &JobModules, key: &WasmHash) -> Option<Module> {
        if let Some(module) = self.in_memory(job, key, None) {
            return Some(module);
        }
        let _working = self.working();
        let slot = self.slot(key);
        let _guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(module) = self.in_memory(job, key, None) {
            return Some(module);
        }
        let module = self
            .on_disk(key)
            .map(|compiled| self.keep(job, *key, compiled, None));
        self.release_slot(key);
        module
    }

    /// A module wasmer-wasix compiled itself, with an engine it chose: it
    /// goes to disk only, and a job loads it into an engine of its own.
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
/// commands an environment's shell spawns: one job's, so the job holds what
/// it loads, whatever engine wasix passes (one of the job's).
#[derive(Debug, Clone)]
pub(crate) struct WasixCache(pub(crate) Arc<ModuleStore>, pub(crate) JobModules);

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

    fn store(limits: ModuleLimits) -> (PathBuf, Arc<ModuleStore>) {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "iwci-module-store-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let store = Arc::new(ModuleStore::new(fingerprint(), &dir).unwrap());
        store.set_limits(limits);
        (dir, store)
    }

    /// Only the LRU, with `budget`.
    fn lru(budget: u64) -> ModuleLimits {
        ModuleLimits {
            lru_budget: budget,
            pin_under: 0,
            pinned_budget: 0,
        }
    }

    /// Runs export `f0` of `module` in a store of `job`'s, as a job would.
    fn call(job: &JobModules, module: &Module) -> i32 {
        let (engine, _) = crate::wasix::job_engine(job, 1 << 20, 1 << 20);
        let mut store = wasmer::Store::new(engine);
        let instance = wasmer::Instance::new(&mut store, module, &wasmer::imports! {}).unwrap();
        let f = instance.exports.get_function("f0").unwrap();
        f.call(&mut store, &[]).unwrap()[0].unwrap_i32()
    }

    /// The artifact size of the module `wasm`, loaded alone.
    fn artifact_bytes(key: WasmHash, wasm: &[u8]) -> u64 {
        let (dir, store) = store(lru(u64::MAX));
        store.get(&JobModules::new(), key, wasm, None).unwrap();
        let bytes = store.stats().lru_bytes;
        let _ = std::fs::remove_dir_all(dir);
        bytes
    }

    #[test]
    fn warming_fills_the_disk_and_nothing_stays_in_memory() {
        let (dir, store) = store(lru(u64::MAX));
        let (key, wasm) = sample(1, 4);
        store.ensure_compiled(key, &wasm).unwrap();
        store.ensure_compiled(key, &wasm).unwrap();
        let stats = store.stats();
        assert_eq!((stats.compiled, stats.resident_bytes), (1, 0), "{stats:?}");
        // A job then loads the artifact rather than compiling.
        store.get(&JobModules::new(), key, &wasm, None).unwrap();
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
    fn under_the_budget_the_lru_keeps_a_module_between_jobs() {
        let (dir, store) = store(lru(u64::MAX));
        let (key, wasm) = sample(1, 4);
        store
            .get(&JobModules::new(), key, &wasm, Some("tool"))
            .unwrap();
        let later = JobModules::new();
        let module = store.get(&later, key, &wasm, None).unwrap();
        assert_eq!(call(&later, &module), 65);
        let stats = store.stats();
        assert_eq!(
            (stats.compiled, stats.from_memory, stats.evicted),
            (1, 1, 0),
            "{stats:?}"
        );
        let modules = store.modules();
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].name, "tool", "the name it was first loaded as");
        assert_eq!(modules[0].sha256, hex::encode(key));
        assert!(!modules[0].pinned);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_lru_frees_the_least_recently_used_module_first() {
        let a = sample(1, 8);
        let b = sample(2, 8);
        let c = sample(3, 8);
        let size = artifact_bytes(a.0, &a.1);
        // Room for two of the three.
        let (dir, store) = store(lru(size * 2 + size / 2));
        for (key, wasm) in [&a, &b] {
            store.get(&JobModules::new(), *key, wasm, None).unwrap();
        }
        // `a` is used again, so `b` is now the least recently used.
        store.get(&JobModules::new(), a.0, &a.1, None).unwrap();
        store.get(&JobModules::new(), c.0, &c.1, None).unwrap();
        let kept: HashSet<String> = store.modules().into_iter().map(|m| m.sha256).collect();
        let expected: HashSet<String> = [hex::encode(a.0), hex::encode(c.0)].into();
        assert_eq!(kept, expected);
        let stats = store.stats();
        assert_eq!(stats.evicted, 1, "{stats:?}");
        assert!(stats.lru_bytes <= size * 2 + size / 2, "{stats:?}");
        // `b` comes back from disk, and `a`, least recently used now, goes.
        store.get(&JobModules::new(), b.0, &b.1, None).unwrap();
        let kept: HashSet<String> = store.modules().into_iter().map(|m| m.sha256).collect();
        let expected: HashSet<String> = [hex::encode(b.0), hex::encode(c.0)].into();
        assert_eq!(kept, expected);
        assert_eq!(store.stats().from_disk, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_module_in_use_is_never_freed() {
        // Nothing fits, so every module goes as soon as no job uses it.
        let (dir, store) = store(lru(0));
        let (key, wasm) = sample(1, 4);
        let (other, other_wasm) = sample(2, 4);
        let running = JobModules::new();
        let module = store.get(&running, key, &wasm, None).unwrap();
        // Other jobs load and free modules meanwhile, and the idle sweep
        // runs: the running job's module stays, in the LRU and in use.
        store
            .get(&JobModules::new(), other, &other_wasm, None)
            .unwrap();
        store.release_idle();
        let stats = store.stats();
        assert_eq!(stats.evicted, 1, "only the other one: {stats:?}");
        assert!(stats.lru_in_use_bytes > 0, "{stats:?}");
        assert_eq!(stats.lru_in_use_bytes, stats.lru_bytes, "{stats:?}");
        assert!(store.modules()[0].in_use);
        // Another job that starts now shares it rather than loading it.
        let second = JobModules::new();
        let shared = store.get(&second, key, &wasm, None).unwrap();
        assert_eq!(store.stats().from_disk, 0);
        assert_eq!(call(&second, &shared), 65);
        drop((shared, second));
        // The job's module still runs, from a store that outlives the job's
        // own handle: the store holds the job's modules.
        let (engine, _) = crate::wasix::job_engine(&running, 1 << 20, 1 << 20);
        drop(running);
        let mut s = wasmer::Store::new(engine);
        let instance = wasmer::Instance::new(&mut s, &module, &wasmer::imports! {}).unwrap();
        store.release_idle();
        assert!(store.stats().lru_in_use_bytes > 0);
        let f = instance.exports.get_function("f0").unwrap();
        assert_eq!(f.call(&mut s, &[]).unwrap()[0].unwrap_i32(), 65);
        // Once the last store of the job is gone, it is freed.
        drop((instance, module, s));
        let stats = store.stats();
        assert_eq!((stats.resident_bytes, stats.evicted), (0, 2), "{stats:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn small_modules_are_pinned_and_never_freed() {
        let small = sample(1, 2);
        let large = sample(2, 32);
        let small_bytes = artifact_bytes(small.0, &small.1);
        let large_bytes = artifact_bytes(large.0, &large.1);
        assert!(small_bytes < large_bytes);
        let (dir, store) = store(ModuleLimits {
            lru_budget: 0,
            pin_under: small_bytes,
            pinned_budget: u64::MAX,
        });
        store
            .get(&JobModules::new(), small.0, &small.1, None)
            .unwrap();
        store
            .get(&JobModules::new(), large.0, &large.1, None)
            .unwrap();
        store.release_idle();
        let stats = store.stats();
        assert_eq!(
            (stats.pinned_bytes, stats.lru_bytes, stats.evicted),
            (small_bytes, 0, 1),
            "{stats:?}"
        );
        // Each job after that gets it from memory, however long it was idle.
        for _ in 0..3 {
            let job = JobModules::new();
            let module = store.get(&job, small.0, &small.1, None).unwrap();
            assert_eq!(call(&job, &module), 65);
            store.release_idle();
        }
        let stats = store.stats();
        assert_eq!((stats.compiled, stats.from_memory), (2, 3), "{stats:?}");
        assert!(store.modules()[0].pinned);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pinning_stops_at_its_budget_and_the_rest_go_to_the_lru() {
        let a = sample(1, 2);
        let b = sample(2, 2);
        let size = artifact_bytes(a.0, &a.1);
        let (dir, store) = store(ModuleLimits {
            lru_budget: u64::MAX,
            pin_under: size * 2,
            pinned_budget: size + size / 2,
        });
        store.get(&JobModules::new(), a.0, &a.1, None).unwrap();
        store.get(&JobModules::new(), b.0, &b.1, None).unwrap();
        let stats = store.stats();
        assert!(stats.pinned_bytes > 0 && stats.lru_bytes > 0, "{stats:?}");
        assert_eq!(stats.resident_bytes, stats.pinned_bytes + stats.lru_bytes);
        let pinned: Vec<bool> = store.modules().iter().map(|m| m.pinned).collect();
        assert_eq!(pinned, [true, false]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Modules of different engines run together in one job's store: a
    /// host function, a function of one module and one of another meet in
    /// one table and are called through it, and the host reads them back
    /// out of it, which looks their signatures up in the store's engine.
    #[test]
    fn modules_of_different_engines_link_in_one_store() {
        let (dir, store) = store(lru(u64::MAX));
        let lib = wat::parse_str(
            r#"(module
                (table (export "table") 3 funcref)
                (func (export "double") (param i64) (result i64)
                    local.get 0 i64.const 2 i64.mul))"#,
        )
        .unwrap();
        let main = wat::parse_str(
            r#"(module
                (import "env" "host" (func $host (param f64) (result f64)))
                (import "lib" "double" (func $double (param i64) (result i64)))
                (import "lib" "table" (table 3 funcref))
                (elem (i32.const 0) $host $double)
                (type $h (func (param f64) (result f64)))
                (type $d (func (param i64) (result i64)))
                (func (export "f0") (result i32)
                    f64.const 20 i32.const 0 call_indirect (type $h)
                    i32.trunc_f64_s
                    i64.const 11 i32.const 1 call_indirect (type $d)
                    i32.wrap_i64
                    i32.add))"#,
        )
        .unwrap();
        let job = JobModules::new();
        let lib_key: WasmHash = Sha256::digest(&lib).into();
        let main_key: WasmHash = Sha256::digest(&main).into();
        let lib = store.get(&job, lib_key, &lib, None).unwrap();
        let main = store.get(&job, main_key, &main, None).unwrap();
        let (engine, _) = crate::wasix::job_engine(&job, 1 << 20, 1 << 20);
        let mut s = wasmer::Store::new(engine);
        let host = wasmer::Function::new_typed(&mut s, |x: f64| x + 1.0);
        let lib = wasmer::Instance::new(&mut s, &lib, &wasmer::imports! {}).unwrap();
        let table = lib.exports.get_table("table").unwrap().clone();
        let double = lib.exports.get_function("double").unwrap().clone();
        let imports = wasmer::imports! {
            "env" => { "host" => host },
            "lib" => { "double" => double, "table" => table.clone() },
        };
        let main = wasmer::Instance::new(&mut s, &main, &imports).unwrap();
        let f = main.exports.get_function("f0").unwrap();
        assert_eq!(f.call(&mut s, &[]).unwrap()[0].unwrap_i32(), 21 + 22);
        for i in 0..2 {
            let Some(wasmer::Value::FuncRef(Some(function))) = table.get(&mut s, i) else {
                panic!("slot {i} holds no function");
            };
            assert_eq!(function.ty(&s).params().len(), 1);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
