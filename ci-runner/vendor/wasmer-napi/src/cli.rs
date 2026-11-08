use anyhow::{Context, Result};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use virtual_fs::{AsyncReadExt, FileSystem};
use wasmer::sys::{Cranelift, EngineBuilder, Features};
use wasmer::{Module, Store};
use wasmer_cache::{Cache, FileSystemCache, Hash as CacheHash};
use wasmer_types::ModuleHash;
use wasmer_wasix::{
    Pipe, PluggableRuntime, WasiError,
    os::{TtyBridge, tty_sys::SysTty},
    runners::wasi::{RuntimeOrEngine, WasiRunner},
    runtime::task_manager::tokio::TokioTaskManager,
};

use crate::{
    NapiCtx, budget::ResourceBudget, budget::budgeted_tunables, guest::napi::register_env_imports,
};
use wasmer_c_api_imports::WasmCapiRuntimeHooks;

#[derive(Debug, Clone)]
pub struct GuestMount {
    pub host_path: PathBuf,
    pub guest_path: PathBuf,
}

pub struct LoadedWasm {
    pub store: Store,
    pub module: Module,
    pub module_hash: ModuleHash,
}

fn create_cli_store(budget: Arc<ResourceBudget>) -> Store {
    let mut features = Features::default();
    features.exceptions(true);

    let mut engine = EngineBuilder::new(Cranelift::default())
        .set_features(Some(features))
        .engine();
    // Charge the guest's (imported) wasm linear memory against the app budget.
    // The runtime instantiates the guest with this engine, so its budgeted
    // tunables cover the main store and every worker store cloned from it.
    let tunables = budgeted_tunables(budget);
    engine.set_tunables(tunables);
    Store::new(engine)
}

fn wasmer_cache_dir() -> PathBuf {
    std::env::var_os("WASMER_NAPI_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("wasmer-napi-cache"))
}

fn load_or_compile_module(store: &Store, wasm_bytes: &[u8]) -> Result<Module> {
    let key = CacheHash::generate(wasm_bytes);
    let mut cache = FileSystemCache::new(wasmer_cache_dir())
        .context("failed to create/access Wasmer cache directory")?;

    if let Ok(module) = unsafe { cache.load(store, key) } {
        return Ok(module);
    }

    let module = Module::new(store, wasm_bytes).context("failed to compile wasm module")?;
    let _ = cache.store(key, &module);
    Ok(module)
}

fn spawn_pipe_drain_thread(
    mut pipe: Pipe,
    mut sink: Box<dyn Write + Send>,
) -> std::thread::JoinHandle<Result<String>> {
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("failed to create stdio drain runtime")?;
        let mut captured = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = runtime
                .block_on(pipe.read(&mut chunk))
                .context("failed reading WASIX stdio pipe")?;
            if n == 0 {
                break;
            }
            sink.write_all(&chunk[..n])
                .context("failed writing drained WASIX stdio")?;
            sink.flush()
                .context("failed flushing drained WASIX stdio")?;
            captured.extend_from_slice(&chunk[..n]);
        }
        String::from_utf8(captured).context("WASIX stdio was not valid UTF-8")
    })
}

fn configure_system_tty(runtime: &mut PluggableRuntime, enabled: bool) {
    if !enabled {
        return;
    }

    let tty = Arc::new(SysTty);
    tty.reset();
    runtime.set_tty(tty);
}

pub fn load_wasix_module(wasm_path: &Path) -> Result<LoadedWasm> {
    load_wasix_module_with_budget(wasm_path, ResourceBudget::unlimited())
}

pub fn load_wasix_module_with_budget(
    wasm_path: &Path,
    budget: Arc<ResourceBudget>,
) -> Result<LoadedWasm> {
    let wasm_bytes = std::fs::read(wasm_path)
        .with_context(|| format!("failed to read wasm file at {}", wasm_path.display()))?;

    let store = create_cli_store(budget);

    let module = load_or_compile_module(&store, &wasm_bytes)?;

    let module_hash = ModuleHash::sha256(&wasm_bytes);

    Ok(LoadedWasm {
        store,
        module,
        module_hash,
    })
}

pub fn configure_runner_mounts(
    runner: &mut WasiRunner,
    _wasm_path: &Path,
    extra_mounts: &[GuestMount],
) -> Result<()> {
    if extra_mounts.is_empty() {
        return Ok(());
    }

    let host_handle = tokio::runtime::Handle::current();
    for mount in extra_mounts {
        let host_fs: Arc<dyn FileSystem + Send + Sync> = Arc::new(
            virtual_fs::host_fs::FileSystem::new(host_handle.clone(), mount.host_path.clone())
                .with_context(|| {
                    format!("failed to create host fs for {}", mount.host_path.display())
                })?,
        );
        runner.with_mount(mount.guest_path.display().to_string(), host_fs);
    }

    Ok(())
}

pub fn run_wasix_main_capture_stdio(
    wasm_path: &Path,
    args: &[String],
    extra_mounts: &[GuestMount],
) -> Result<(i32, String, String)> {
    let ctx = NapiCtx::default();
    run_wasix_main_capture_stdio_with_ctx(&ctx, wasm_path, args, extra_mounts)
}

pub fn run_wasix_main_capture_stdio_with_ctx(
    ctx: &NapiCtx,
    wasm_path: &Path,
    args: &[String],
    extra_mounts: &[GuestMount],
) -> Result<(i32, String, String)> {
    let (stdout_tx, stdout_rx) = Pipe::channel();
    let (stderr_tx, stderr_rx) = Pipe::channel();
    let stdout_thread = spawn_pipe_drain_thread(stdout_rx, Box::new(std::io::stdout()));
    let stderr_thread = spawn_pipe_drain_thread(stderr_rx, Box::new(std::io::stderr()));
    let exit_code = run_wasix_main_with_runner(
        ctx,
        wasm_path,
        "guest-test",
        args,
        extra_mounts,
        |runner| {
            runner
                .with_stdout(Box::new(stdout_tx))
                .with_stderr(Box::new(stderr_tx));
        },
        false,
    )?;

    let stdout = stdout_thread
        .join()
        .map_err(|_| anyhow::anyhow!("stdout drain thread panicked"))??;
    let stderr = stderr_thread
        .join()
        .map_err(|_| anyhow::anyhow!("stderr drain thread panicked"))??;
    Ok((exit_code, stdout, stderr))
}

pub fn run_wasix_main_with_ctx(
    ctx: &NapiCtx,
    wasm_path: &Path,
    program_name: &str,
    args: &[String],
    extra_mounts: &[GuestMount],
    envs: &[(String, String)],
    current_dir: Option<&Path>,
) -> Result<i32> {
    run_wasix_main_with_runner(
        ctx,
        wasm_path,
        program_name,
        args,
        extra_mounts,
        |runner| {
            runner
                .with_stdin(Box::new(virtual_fs::host_fs::Stdin::default()))
                .with_stdout(Box::new(virtual_fs::host_fs::Stdout::default()))
                .with_stderr(Box::new(virtual_fs::host_fs::Stderr::default()))
                .with_envs(envs.iter().cloned());
            if let Some(current_dir) = current_dir {
                runner.with_current_dir(current_dir);
            }
        },
        true,
    )
}

fn run_wasix_main_with_runner(
    ctx: &NapiCtx,
    wasm_path: &Path,
    program_name: &str,
    args: &[String],
    extra_mounts: &[GuestMount],
    configure_runner: impl FnOnce(&mut WasiRunner),
    use_system_tty: bool,
) -> Result<i32> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to create tokio runtime for WASIX")?;
    let guard = runtime.enter();

    let exit_code = {
        let loaded = load_wasix_module_with_budget(wasm_path, ctx.budget())?;
        let engine = loaded.store.engine().clone();
        let module = loaded.module;
        let module_hash = loaded.module_hash;

        let mut runner = WasiRunner::new();
        runner.with_args(args.iter().cloned());
        configure_runner_mounts(&mut runner, wasm_path, extra_mounts)?;
        configure_runner(&mut runner);

        let task_manager = Arc::new(TokioTaskManager::new(tokio::runtime::Handle::current()));
        let mut runtime = PluggableRuntime::new(task_manager);
        runtime.set_engine(engine.clone());
        configure_system_tty(&mut runtime, use_system_tty);

        let (napi_version, napi_extension_version) = NapiCtx::module_needs_napi(&module);
        if napi_version.is_some() || napi_extension_version.is_some() {
            runner
                .capabilities_mut()
                .threading
                .enable_asynchronous_threading = false;
        }
        runtime
            .with_instantiation_hook(ctx.runtime_hooks())
            .with_instantiation_hook(WasmCapiRuntimeHooks::new())
            .with_additional_imports(|_module, store| {
                let mut imports = wasmer::Imports::new();
                register_env_imports(store, &mut imports);
                Ok(imports)
            });

        match runner.run_wasm(
            RuntimeOrEngine::Runtime(Arc::new(runtime)),
            program_name,
            module,
            module_hash,
        ) {
            Ok(()) => 0,
            Err(err) => {
                if let Some(WasiError::Exit(code)) = err.downcast_ref::<WasiError>() {
                    i32::from(*code)
                } else {
                    return Err(err).context("failed to run WASIX module through WasiRunner");
                }
            }
        }
    };

    drop(guard);
    if use_system_tty {
        // A host stdin read may still occupy Tokio's blocking pool after the
        // guest closes its TTY. Waiting for that OS read while dropping the
        // runtime would keep the standalone CLI alive indefinitely even
        // though the guest has exited.
        runtime.shutdown_background();
    }

    Ok(exit_code)
}

pub fn run_wasix_main_capture_stdout(
    wasm_path: &Path,
    args: &[String],
    extra_mounts: &[GuestMount],
) -> Result<(i32, String)> {
    let ctx = NapiCtx::default();
    run_wasix_main_capture_stdout_with_ctx(&ctx, wasm_path, args, extra_mounts)
}

pub fn run_wasix_main_capture_stdout_with_ctx(
    ctx: &NapiCtx,
    wasm_path: &Path,
    args: &[String],
    extra_mounts: &[GuestMount],
) -> Result<(i32, String)> {
    let (exit_code, stdout, _stderr) =
        run_wasix_main_capture_stdio_with_ctx(ctx, wasm_path, args, extra_mounts)?;
    Ok((exit_code, stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmer_wasix::runtime::Runtime;

    #[test]
    fn system_tty_is_only_installed_for_direct_stdio() {
        let tokio_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test tokio runtime");
        let _guard = tokio_runtime.enter();
        let task_manager = Arc::new(TokioTaskManager::new(tokio::runtime::Handle::current()));
        let mut runtime = PluggableRuntime::new(task_manager);

        configure_system_tty(&mut runtime, false);
        assert!(runtime.tty().is_none());

        configure_system_tty(&mut runtime, true);
        assert!(runtime.tty().is_some());
    }
}
