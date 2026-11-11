#![allow(clippy::result_large_err)]
use std::{
    collections::HashMap,
    future::Future,
    ops::Deref,
    path::Path,
    pin::Pin,
    sync::{Arc, RwLock},
};

use anyhow::Context;
use shared_buffer::OwnedBuffer;
use virtual_fs::{AsyncReadExt, FileSystem};
use wasmer::FunctionEnvMut;
use wasmer_package::utils::from_bytes;

mod binary_package;
mod exec;

pub use self::{
    binary_package::*,
    exec::{
        import_package_mounts, package_command_by_name, run_exec, spawn_exec, spawn_exec_module,
        spawn_exec_wasm, spawn_load_module,
    },
};
use crate::{
    Runtime, SpawnError, WasiEnv,
    os::{
        command::{Commands, VirtualCommand},
        task::TaskJoinHandle,
    },
    runtime::module_cache::HashedModuleData,
};

#[derive(Debug, Clone)]
pub struct BinFactory {
    pub(crate) commands: Commands,
    runtime: Arc<dyn Runtime + Send + Sync + 'static>,
    pub(crate) local: Arc<RwLock<HashMap<String, Option<Arc<BinaryPackage>>>>>,
}

impl BinFactory {
    pub fn new(runtime: Arc<dyn Runtime + Send + Sync + 'static>) -> BinFactory {
        BinFactory {
            commands: Commands::new_with_builtins(runtime.clone()),
            runtime,
            local: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn runtime(&self) -> &(dyn Runtime + Send + Sync) {
        self.runtime.deref()
    }

    /// Register a builtin command.
    pub fn register_builtin_command<C>(&mut self, cmd: C)
    where
        C: VirtualCommand + Send + Sync + 'static,
    {
        self.commands.register_command(cmd);
    }

    /// Register a builtin command at a custom path.
    pub fn register_builtin_command_with_path<C, P>(&mut self, cmd: C, path: P)
    where
        C: VirtualCommand + Send + Sync + 'static,
        P: Into<String>,
    {
        self.commands.register_command_with_path(cmd, path.into());
    }

    /// Register a builtin command behind an [`Arc`] at a custom path.
    pub(crate) fn register_builtin_command_with_path_shared<P>(
        &mut self,
        cmd: Arc<dyn VirtualCommand + Send + Sync + 'static>,
        path: P,
    ) where
        P: Into<String>,
    {
        self.commands
            .register_command_with_path_shared(cmd, path.into());
    }

    /// Remove all registered builtin commands.
    pub fn clear_builtin_commands(&mut self) {
        self.commands.clear();
    }

    pub fn set_binary(&self, name: &str, binary: &Arc<BinaryPackage>) {
        let mut cache = self.local.write().unwrap();
        cache.insert(name.to_string(), Some(binary.clone()));
    }

    #[allow(clippy::await_holding_lock)]
    pub async fn get_binary(
        &self,
        name: &str,
        fs: Option<&dyn FileSystem>,
    ) -> Option<Arc<BinaryPackage>> {
        self.get_executable(name, fs)
            .await
            .and_then(|executable| match executable {
                Executable::Wasm(_) | Executable::Script(_) => None,
                Executable::BinaryPackage(pkg) => Some(pkg),
            })
    }

    /// Starts `name` in `env`. A file that starts with `#!` is a script: its
    /// interpreter runs instead, given the script's path before the
    /// arguments, as `execve` does on Linux.
    ///
    /// `invoked_as` is the path the guest spelled, which is what the
    /// interpreter is handed. `None` selects the resolved path, which is what
    /// a PATH search produces on Unix.
    ///
    /// The interpreter is looked up on the filesystem (or among the packages
    /// already loaded), never among the builtin commands: a caller reaches
    /// those through [`Self::try_built_in`] before it gets here, and only for
    /// the name it started with.
    pub fn spawn<'a>(
        &'a self,
        name: String,
        invoked_as: Option<String>,
        env: WasiEnv,
    ) -> Pin<Box<dyn Future<Output = Result<TaskJoinHandle, SpawnError>> + 'a>> {
        Box::pin(async move {
            let mut name = name;
            let mut invoked_as = invoked_as;
            // Held back until the interpreter is known to resolve. On
            // `proc_exec4`'s non-vfork path this state is shared with a caller
            // that keeps running when the spawn fails, and a shebang rewrite
            // adds arguments that were never in its argv.
            let mut rewritten_args: Option<Vec<String>> = None;

            for _ in 0..MAX_SHEBANG_DEPTH {
                // Find the binary (or die trying) and make the spawn type
                let executable = self
                    .find_executable(name.as_str(), Some(env.fs_root()))
                    .await?
                    .ok_or_else(|| SpawnError::BinaryNotFound {
                        binary: name.clone(),
                    })?;

                match executable {
                    Executable::Wasm(bytes) => {
                        let data = HashedModuleData::new(bytes.clone());
                        commit_script_args(&env, rewritten_args);
                        return spawn_exec_wasm(data, name.as_str(), env, &self.runtime).await;
                    }
                    Executable::BinaryPackage(pkg) => {
                        {
                            // Resolve the command first: a package without
                            // this entrypoint is a failed spawn, not a rewrite.
                            let cmd = package_command_by_name(&pkg, name.as_str())?;
                            commit_script_args(&env, rewritten_args);
                            env.prepare_spawn(cmd);
                        }

                        return spawn_exec(pkg.as_ref().clone(), name.as_str(), env, &self.runtime)
                            .await;
                    }
                    Executable::Script(script) => {
                        let script_path = invoked_as.take().unwrap_or_else(|| name.clone());
                        let args = match rewritten_args.take() {
                            Some(args) => args,
                            None => env.state.args.lock().unwrap().clone(),
                        };
                        let (interpreter, args) = script_command(&script_path, script, &args);
                        rewritten_args = Some(args);
                        // As on Linux, the interpreter is a path: a relative
                        // one is relative to the working directory, and is not
                        // looked up on PATH.
                        name = if interpreter.starts_with('/') {
                            interpreter.clone()
                        } else {
                            env.state.fs.relative_path_to_absolute(interpreter.clone())
                        };
                        // An interpreter that is itself a script is handed on
                        // under the name the shebang line gave it.
                        invoked_as = Some(interpreter);
                    }
                }
            }

            Err(SpawnError::ShebangLoop)
        })
    }

    pub fn try_built_in(
        &self,
        name: String,
        parent_ctx: Option<&FunctionEnvMut<'_, WasiEnv>>,
        builder: &mut Option<WasiEnv>,
    ) -> Result<TaskJoinHandle, SpawnError> {
        // We check for built in commands
        if let Some(parent_ctx) = parent_ctx {
            if self.commands.exists(name.as_str()) {
                return self.commands.exec(parent_ctx, name.as_str(), builder);
            }
        } else if self.commands.exists(name.as_str()) {
            tracing::warn!("builtin command without a parent ctx - {}", name);
        }
        Err(SpawnError::BinaryNotFound { binary: name })
    }

    // TODO: remove allow once BinFactory is refactored
    // currently fine because a BinFactory is only used by a single process tree
    #[allow(clippy::await_holding_lock)]
    pub async fn get_executable(
        &self,
        name: &str,
        fs: Option<&dyn FileSystem>,
    ) -> Option<Executable> {
        self.find_executable(name, fs).await.ok().flatten()
    }

    /// [`Self::get_executable`], telling a script whose shebang line cannot
    /// be used (ENOEXEC) from a file that is not there.
    #[allow(clippy::await_holding_lock)]
    async fn find_executable(
        &self,
        name: &str,
        fs: Option<&dyn FileSystem>,
    ) -> Result<Option<Executable>, SpawnError> {
        let name = name.to_string();

        // Return early if the path is already cached
        {
            let cache = self.local.read().unwrap();
            if let Some(data) = cache.get(&name) {
                return Ok(data.clone().map(Executable::BinaryPackage));
            }
        }

        let mut cache = self.local.write().unwrap();

        // Check the cache again to avoid a race condition where the cache was populated inbetween the fast path and here
        if let Some(data) = cache.get(&name) {
            return Ok(data.clone().map(Executable::BinaryPackage));
        }

        // Check the filesystem for the file
        if name.starts_with('/')
            && let Some(fs) = fs
        {
            match load_executable_from_filesystem(fs, name.as_ref(), self.runtime()).await {
                Ok(executable) => {
                    if let Executable::BinaryPackage(pkg) = &executable {
                        cache.insert(name, Some(pkg.clone()));
                    }

                    return Ok(Some(executable));
                }
                Err(e) if e.downcast_ref::<MalformedShebang>().is_some() => {
                    return Err(SpawnError::InvalidShebang { path: name });
                }
                Err(e) => {
                    tracing::warn!(
                        path = name,
                        error = &*e,
                        "Unable to load the package from disk"
                    );
                }
            }
        }

        // Do not negatively cache filesystem lookups: a guest can create an
        // executable at a path after an earlier miss.
        Ok(None)
    }
}

pub enum Executable {
    Wasm(OwnedBuffer),
    BinaryPackage(Arc<BinaryPackage>),
    Script(Shebang),
}

/// Executables a single spawn may walk through: five nested scripts and the
/// thing the last one names. Linux runs a chain of five and answers `ELOOP` at
/// six, whatever the last one names.
const MAX_SHEBANG_DEPTH: usize = 6;

/// Linux reads the shebang out of a buffer of `BINPRM_BUF_SIZE` bytes and
/// refuses to exec an interpreter path that the buffer truncated.
const MAX_SHEBANG_LINE: usize = 256;

#[derive(Debug)]
pub struct Shebang {
    interpreter: String,
    argument: Option<String>,
}

/// A file that starts with `#!` is a script and nothing else: Linux commits to
/// the script handler on those two bytes and never falls back to another
/// format. A line this runtime cannot use is therefore ENOEXEC, not something
/// to hand to the Wasm compiler.
#[derive(Debug, thiserror::Error)]
#[error("the shebang line cannot be used")]
struct MalformedShebang;

enum ShebangLine {
    Absent,
    Malformed,
    Parsed(Shebang),
}

fn parse_shebang(bytes: &[u8]) -> ShebangLine {
    if !bytes.starts_with(b"#!") {
        return ShebangLine::Absent;
    }

    let window = &bytes[..bytes.len().min(MAX_SHEBANG_LINE)];
    let line = match window.iter().position(|byte| *byte == b'\n') {
        Some(end) => &window[..end],
        // Without a newline the line ends where the file does, so anything
        // reaching the end of the window is truncated.
        None if bytes.len() < MAX_SHEBANG_LINE => window,
        None => return ShebangLine::Malformed,
    };

    // WASIX resolves paths as UTF-8 strings. Linux takes them as bytes, so a
    // path this runtime cannot represent is reported rather than ignored.
    let Ok(line) = std::str::from_utf8(&line[2..]) else {
        return ShebangLine::Malformed;
    };
    let line = line.trim_end_matches('\r').trim();

    let (interpreter, argument) = line
        .split_once(char::is_whitespace)
        .map(|(interpreter, argument)| (interpreter, Some(argument.trim().to_string())))
        .unwrap_or((line, None));

    if interpreter.is_empty() {
        return ShebangLine::Malformed;
    }

    ShebangLine::Parsed(Shebang {
        interpreter: interpreter.to_string(),
        argument: argument.filter(|argument| !argument.is_empty()),
    })
}

/// Applies the argv a shebang rewrote, once the executable it named has been
/// found. Nothing before this point may disturb the caller's argv.
fn commit_script_args(env: &WasiEnv, args: Option<Vec<String>>) {
    if let Some(args) = args {
        *env.state.args.lock().unwrap() = args;
    }
}

/// The interpreter a script names and the argv it runs with: the
/// interpreter, the shebang line's argument if it has one, the script, then
/// the arguments the script was given (its own argv[0] is dropped).
fn script_command(
    script_name: &str,
    script: Shebang,
    original_args: &[String],
) -> (String, Vec<String>) {
    let user_args = original_args.iter().skip(1).cloned();

    // As on Linux, whatever follows the interpreter on the shebang line is a
    // single argument. `/usr/bin/env` needs no special case: it resolves like
    // any other interpreter, and `env` finds its command on PATH.
    let args = std::iter::once(script.interpreter.clone())
        .chain(script.argument)
        .chain(std::iter::once(script_name.to_string()))
        .chain(user_args)
        .collect();

    (script.interpreter, args)
}

/// What a file that is not a webc package is: a script, or (anything else)
/// WebAssembly for the compiler to judge.
fn classify_file(buffer: OwnedBuffer) -> Result<Executable, anyhow::Error> {
    match parse_shebang(buffer.as_slice()) {
        ShebangLine::Parsed(script) => Ok(Executable::Script(script)),
        ShebangLine::Malformed => Err(MalformedShebang.into()),
        ShebangLine::Absent => Ok(Executable::Wasm(buffer)),
    }
}

async fn load_executable_from_filesystem(
    fs: &dyn FileSystem,
    path: &Path,
    rt: &(dyn Runtime + Send + Sync),
) -> Result<Executable, anyhow::Error> {
    let mut f = fs
        .new_open_options()
        .read(true)
        .open(path)
        .context("Unable to open the file")?;

    // Fast path if the file is fully available in memory.
    // Prevents redundant copying of the file data.
    if let Some(buf) = f.as_owned_buffer() {
        if wasmer_package::utils::is_container(buf.as_slice()) {
            let bytes = buf.clone().into_bytes();
            if let Ok(container) = from_bytes(bytes.clone()) {
                let pkg = BinaryPackage::from_webc(&container, rt)
                    .await
                    .context("Unable to load the package")?;

                return Ok(Executable::BinaryPackage(Arc::new(pkg)));
            }
        }

        classify_file(buf)
    } else {
        let mut data = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut data).await.context("Read failed")?;

        let bytes: bytes::Bytes = data.into();

        if let Ok(container) = from_bytes(bytes.clone()) {
            let pkg = BinaryPackage::from_webc(&container, rt)
                .await
                .context("Unable to load the package")?;

            Ok(Executable::BinaryPackage(Arc::new(pkg)))
        } else {
            classify_file(OwnedBuffer::from_bytes(bytes))
        }
    }
}

