//! The host side of ts-rust's wasm ABI (`crates/ts_wasm` at v0.8.0), so the
//! TypeScript builtin runs natively over a job's virtual file system.
//!
//! This mirrors the JavaScript host, `npm/wasm/core.js`, with the real file
//! system semantics of `npm/wasm/node-run.js` (`nodeFileSystem`):
//!
//! - The module is a `wasm32-wasip1` cdylib driven through its exports: the
//!   host writes a request into the buffer `ts_input(len)` returns, calls
//!   `ts_run()`, and reads the JSON reply at `ts_output()` /
//!   `ts_output_len()`. One fresh instance per run, because the compiler
//!   keeps one program per process.
//! - The request is NUL-separated UTF-8: cwd, the decimal flags, then the tsc
//!   arguments.
//! - Only a small WASI preview1 shim is provided, exactly core.js's: no
//!   arguments, the given environment, wall and monotonic clocks, random
//!   bytes, writes to fds 1 and 2, `fd_fdstat_get` for fds 0 to 2 (never a
//!   terminal), no preopens, `proc_exit`, `sched_yield` and a `poll_oneoff`
//!   that reports no events. Every other WASI import answers ENOSYS. There
//!   is no WASI file access at all: every file operation is a
//!   `ts_host.fs(op, ptr, len)` call.
//! - `ts_host.fs` returns the result length and keeps the result for
//!   `ts_host.fs_take(ptr)`, or -1 on failure, or `-2 - n` when it keeps an
//!   error text of `n` bytes (Go's text, such as `open /a.js: is a
//!   directory`).
//! - A panic prints to stderr and leaves through `proc_exit`, whose code is
//!   the run's exit status; core.js still reads the (then empty) reply.
//!
//! One difference from core.js: when the module exports `_initialize` (the
//! WASI reactor entry wasm-ld adds to a cdylib), it is called before
//! `ts_input`, as the reactor ABI requires. core.js never calls it, so a
//! module that works there has nothing in it that depends on not calling it.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Instant, SystemTime};

use futures::executor::block_on;
use virtual_fs::{AsyncWriteExt, FileSystem, FsError};
use wasmer::{
    ExternType, Function, FunctionEnv, FunctionEnvMut, Imports, Instance, Memory, MemoryView,
    RuntimeError, Store, Type, Value,
};

use wasmer_types::TrapCode;

use crate::capture::Capture;
use crate::wasix::{CRASH_EXIT_CODE, TIMEOUT_EXIT_CODE, job_engine};
use crate::watchdog::Watchdog;
use crate::{DynFs, Error, Invocation, Result};

/// `crates/ts_wasm` `FLAG_DIAGNOSTICS_JSON`.
pub const FLAG_DIAGNOSTICS_JSON: u32 = 1;
/// `crates/ts_wasm` `FLAG_CASE_INSENSITIVE`. Never set: the job file system
/// is case sensitive.
pub const FLAG_CASE_INSENSITIVE: u32 = 2;

/// Native stack for the compiler. The checker recurses deeply; ts-rust's
/// Node host runs it in a worker with a 256 MB stack, and this matches it.
/// It is address space, not memory: pages are only committed when used.
pub const TSC_STACK: usize = 256 << 20;

const SUCCESS: i32 = 0;
const EBADF: i32 = 8;
const ENOSYS: i32 = 52;

const OP_READ: i32 = 0;
const OP_STAT: i32 = 1;
const OP_READ_DIR: i32 = 2;
const OP_REALPATH: i32 = 3;
const OP_WRITE: i32 = 4;
const OP_APPEND: i32 = 5;
const OP_REMOVE: i32 = 6;
const OP_CHTIMES: i32 = 7;

/// How one tsc run ended.
#[derive(Debug, Clone)]
pub struct TscOutcome {
    /// tsc's exit status: 0 clean, 1 or 2 with errors (see tsc), 2 or 70
    /// after a panic, [`TIMEOUT_EXIT_CODE`] on timeout and
    /// [`CRASH_EXIT_CODE`] after a trap.
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Either stream hit the output cap.
    pub truncated: bool,
    /// With `diagnostics_json`, the reply: a JSON array of the API's
    /// `DiagnosticResponse` objects (`[]` when there were none or tsc
    /// panicked). `None` without the flag, on timeout and after a trap.
    pub diagnostics_json: Option<String>,
    pub duration: std::time::Duration,
    pub timed_out: bool,
    pub out_of_memory: bool,
    /// The trap, when the module crashed instead of returning or exiting
    /// (core.js throws in that case).
    pub error: Option<String>,
}

/// `proc_exit`, carried out of the guest as a trap.
#[derive(Debug, thiserror::Error)]
#[error("exit {0}")]
struct WasiExit(i32);

struct TscEnv {
    memory: Option<Memory>,
    fs: DynFs,
    staged: Vec<u8>,
    environ: Vec<Vec<u8>>,
    stdout: Capture,
    stderr: Capture,
    started: Instant,
}

pub(crate) fn run(
    engine: &wasmer::Engine,
    module: &wasmer::Module,
    inv: Invocation,
    diagnostics_json: bool,
    output_bytes: usize,
) -> Result<TscOutcome> {
    for value in std::iter::once(&inv.cwd)
        .chain(inv.args.iter())
        .chain(inv.env.iter().flat_map(|(k, v)| [k, v]))
    {
        if value.contains('\0') {
            return Err(Error::InvalidInput(format!(
                "cwd, args and env must not contain NUL bytes: {value:?}"
            )));
        }
    }
    let started = Instant::now();
    let (engine, hit_memory) = job_engine(engine, inv.limits.memory_bytes, TSC_STACK);
    let mut store = Store::new(engine);
    let interrupter = store.interrupter();

    let stdout = Capture::new(output_bytes).with_sink(inv.log.clone(), crate::Stream::Stdout);
    let stderr = Capture::new(output_bytes).with_sink(inv.log.clone(), crate::Stream::Stderr);
    let env = FunctionEnv::new(
        &mut store,
        TscEnv {
            memory: None,
            fs: with_scratch(inv.fs.clone(), inv.scratch.clone())?,
            staged: Vec::new(),
            environ: inv
                .env
                .iter()
                .map(|(k, v)| format!("{k}={v}\0").into_bytes())
                .collect(),
            stdout: stdout.clone(),
            stderr: stderr.clone(),
            started,
        },
    );

    let mut imports = Imports::new();
    for import in module.imports() {
        let ExternType::Function(ty) = import.ty() else {
            continue;
        };
        if import.module() != "wasi_snapshot_preview1" {
            continue;
        }
        let name = import.name().to_string();
        let returns_errno = ty.results() == [Type::I32];
        let func = Function::new_with_env(&mut store, &env, ty.clone(), move |env, args| {
            wasi_call(&name, env, args, returns_errno)
        });
        imports.define("wasi_snapshot_preview1", import.name(), func);
    }
    imports.define(
        "ts_host",
        "fs",
        Function::new_typed_with_env(&mut store, &env, host_fs),
    );
    imports.define(
        "ts_host",
        "fs_take",
        Function::new_typed_with_env(&mut store, &env, host_fs_take),
    );

    let instance = Instance::new(&mut store, module, &imports)
        .map_err(|e| Error::Setup(format!("instantiating the tsc module: {e}")))?;
    let memory = instance
        .exports
        .get_memory("memory")
        .map_err(|e| Error::Setup(format!("the tsc module exports no memory: {e}")))?
        .clone();
    env.as_mut(&mut store).memory = Some(memory.clone());

    let mut flags = 0;
    if diagnostics_json {
        flags |= FLAG_DIAGNOSTICS_JSON;
    }
    let mut request = Vec::new();
    request.extend_from_slice(inv.cwd.as_bytes());
    request.push(0);
    request.extend_from_slice(flags.to_string().as_bytes());
    for arg in &inv.args {
        request.push(0);
        request.extend_from_slice(arg.as_bytes());
    }

    let export = |name: &str| {
        instance
            .exports
            .get_function(name)
            .cloned()
            .map_err(|e| Error::Setup(format!("the tsc module lacks `{name}`: {e}")))
    };
    let ts_input = export("ts_input")?;
    let ts_run = export("ts_run")?;
    let ts_output = export("ts_output")?;
    let ts_output_len = export("ts_output_len")?;

    let watchdog = Watchdog::start(started + inv.limits.timeout, move || {
        interrupter.interrupt()
    });
    let ran = (|| -> std::result::Result<i32, RuntimeError> {
        if let Ok(initialize) = instance.exports.get_function("_initialize") {
            initialize.call(&mut store, &[])?;
        }
        let len = i32::try_from(request.len())
            .map_err(|_| RuntimeError::new("the tsc request is over 2 GiB"))?;
        let ptr = first_i32(&ts_input.call(&mut store, &[Value::I32(len)])?)?;
        memory
            .view(&store)
            .write(ptr as u32 as u64, &request)
            .map_err(|e| RuntimeError::new(e.to_string()))?;
        first_i32(&ts_run.call(&mut store, &[])?)
    })();
    let timed_out = watchdog.finish();

    let mut error = None;
    let mut read_reply = diagnostics_json;
    let exit_code = match ran {
        Ok(code) => code,
        Err(err) if timed_out || err.clone().to_trap() == Some(TrapCode::HostInterrupt) => {
            read_reply = false;
            TIMEOUT_EXIT_CODE
        }
        Err(err) => match err.downcast::<WasiExit>() {
            Ok(WasiExit(code)) => code,
            Err(err) => {
                read_reply = false;
                error = Some(err.to_string());
                CRASH_EXIT_CODE
            }
        },
    };
    let diagnostics_json = if read_reply {
        let reply = (|| -> std::result::Result<String, RuntimeError> {
            let ptr = first_i32(&ts_output.call(&mut store, &[])?)? as u32 as u64;
            let len = first_i32(&ts_output_len.call(&mut store, &[])?)? as u32 as usize;
            if len == 0 {
                return Ok("[]".into());
            }
            let mut bytes = vec![0; len];
            memory
                .view(&store)
                .read(ptr, &mut bytes)
                .map_err(|e| RuntimeError::new(e.to_string()))?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        })();
        match reply {
            Ok(reply) => Some(reply),
            Err(e) => {
                error = Some(format!("reading the diagnostics: {e}"));
                None
            }
        }
    } else {
        None
    };

    let out = stdout.take();
    let err = stderr.take();
    Ok(TscOutcome {
        exit_code,
        stdout: out.bytes,
        stderr: err.bytes,
        truncated: out.truncated || err.truncated,
        diagnostics_json,
        duration: started.elapsed(),
        timed_out,
        out_of_memory: hit_memory.load(Ordering::Acquire),
        error,
    })
}

fn first_i32(values: &[Value]) -> std::result::Result<i32, RuntimeError> {
    match values.first() {
        Some(Value::I32(v)) => Ok(*v),
        _ => Err(RuntimeError::new("expected an i32 result")),
    }
}

fn arg(args: &[Value], i: usize) -> u32 {
    match args.get(i) {
        Some(Value::I32(v)) => *v as u32,
        Some(Value::I64(v)) => *v as u32,
        _ => 0,
    }
}

fn mem_err(e: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::new(format!("guest memory: {e}"))
}

fn view<'a>(
    memory: &'a Option<Memory>,
    store: &'a impl wasmer::AsStoreRef,
) -> std::result::Result<MemoryView<'a>, RuntimeError> {
    memory
        .as_ref()
        .map(|m| m.view(store))
        .ok_or_else(|| RuntimeError::new("guest memory is not set up yet"))
}

/// The WASI shim of core.js (see the module comment).
fn wasi_call(
    name: &str,
    mut env: FunctionEnvMut<TscEnv>,
    args: &[Value],
    returns_errno: bool,
) -> std::result::Result<Vec<Value>, RuntimeError> {
    let (data, store) = env.data_and_store_mut();
    let errno = |code: i32| Ok(vec![Value::I32(code)]);
    let set_u32 = |view: &MemoryView, at: u32, value: u32| {
        view.write(u64::from(at), &value.to_le_bytes())
            .map_err(mem_err)
    };
    let set_u64 = |view: &MemoryView, at: u32, value: u64| {
        view.write(u64::from(at), &value.to_le_bytes())
            .map_err(mem_err)
    };
    match name {
        "args_sizes_get" => {
            let view = view(&data.memory, &store)?;
            set_u32(&view, arg(args, 0), 0)?;
            set_u32(&view, arg(args, 1), 0)?;
            errno(SUCCESS)
        }
        "args_get" => errno(SUCCESS),
        "environ_sizes_get" => {
            let view = view(&data.memory, &store)?;
            let total: usize = data.environ.iter().map(Vec::len).sum();
            set_u32(&view, arg(args, 0), data.environ.len() as u32)?;
            set_u32(&view, arg(args, 1), total as u32)?;
            errno(SUCCESS)
        }
        "environ_get" => {
            let view = view(&data.memory, &store)?;
            let (ptrs, mut at) = (arg(args, 0), arg(args, 1));
            for (i, entry) in data.environ.iter().enumerate() {
                set_u32(&view, ptrs + i as u32 * 4, at)?;
                view.write(u64::from(at), entry).map_err(mem_err)?;
                at += entry.len() as u32;
            }
            errno(SUCCESS)
        }
        "clock_time_get" => {
            let view = view(&data.memory, &store)?;
            // Clock 0 is wall time; every other id is the monotonic clock,
            // counted from the start of the run as `performance.now()` is.
            let ns = if arg(args, 0) == 0 {
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map_or(0, |d| d.as_nanos() as u64)
            } else {
                data.started.elapsed().as_nanos() as u64
            };
            set_u64(&view, arg(args, 2), ns)?;
            errno(SUCCESS)
        }
        "clock_res_get" => {
            let view = view(&data.memory, &store)?;
            set_u64(&view, arg(args, 1), 1000)?;
            errno(SUCCESS)
        }
        "random_get" => {
            let view = view(&data.memory, &store)?;
            let (buf, len) = (arg(args, 0), arg(args, 1) as usize);
            let mut chunk = [0u8; 65536];
            let mut at = 0;
            while at < len {
                let n = (len - at).min(chunk.len());
                getrandom::fill(&mut chunk[..n]).map_err(|e| RuntimeError::new(e.to_string()))?;
                view.write(u64::from(buf) + at as u64, &chunk[..n])
                    .map_err(mem_err)?;
                at += n;
            }
            errno(SUCCESS)
        }
        "fd_write" => {
            let fd = arg(args, 0);
            if fd != 1 && fd != 2 {
                return errno(EBADF);
            }
            let view = view(&data.memory, &store)?;
            let (iovs, count, nwritten) = (arg(args, 1), arg(args, 2), arg(args, 3));
            let mut total = 0u32;
            for i in 0..count {
                let mut iov = [0u8; 8];
                view.read(u64::from(iovs) + u64::from(i) * 8, &mut iov)
                    .map_err(mem_err)?;
                let ptr = u32::from_le_bytes(iov[..4].try_into().unwrap_or_default());
                let len = u32::from_le_bytes(iov[4..].try_into().unwrap_or_default());
                let mut chunk = vec![0u8; len as usize];
                view.read(u64::from(ptr), &mut chunk).map_err(mem_err)?;
                if fd == 1 {
                    data.stdout.push(&chunk);
                } else {
                    data.stderr.push(&chunk);
                }
                total = total.wrapping_add(len);
            }
            set_u32(&view, nwritten, total)?;
            errno(SUCCESS)
        }
        "fd_fdstat_get" => {
            if arg(args, 0) > 2 {
                return errno(EBADF);
            }
            // All zero: filetype unknown, no rights, so never a terminal.
            let view = view(&data.memory, &store)?;
            view.write(u64::from(arg(args, 1)), &[0u8; 24])
                .map_err(mem_err)?;
            errno(SUCCESS)
        }
        "fd_prestat_get" => errno(EBADF),
        "proc_exit" => Err(RuntimeError::user(Box::new(WasiExit(arg(args, 0) as i32)))),
        "sched_yield" => errno(SUCCESS),
        "poll_oneoff" => {
            let view = view(&data.memory, &store)?;
            set_u32(&view, arg(args, 3), 0)?;
            errno(SUCCESS)
        }
        _ if returns_errno => errno(ENOSYS),
        _ => Ok(Vec::new()),
    }
}

fn host_fs(
    mut env: FunctionEnvMut<TscEnv>,
    op: i32,
    ptr: i32,
    len: i32,
) -> std::result::Result<i32, RuntimeError> {
    let (data, store) = env.data_and_store_mut();
    let view = view(&data.memory, &store)?;
    let mut request = vec![0u8; len as u32 as usize];
    view.read(u64::from(ptr as u32), &mut request)
        .map_err(mem_err)?;
    match fs_call(data.fs.as_ref(), op, &request) {
        Reply::Failed => Ok(-1),
        Reply::Error(text) => {
            data.staged = text.into_bytes();
            Ok(-2 - data.staged.len() as i32)
        }
        Reply::Ok(bytes) => {
            data.staged = bytes;
            Ok(data.staged.len() as i32)
        }
    }
}

fn host_fs_take(
    mut env: FunctionEnvMut<TscEnv>,
    ptr: i32,
) -> std::result::Result<(), RuntimeError> {
    let (data, store) = env.data_and_store_mut();
    let view = view(&data.memory, &store)?;
    let staged = std::mem::take(&mut data.staged);
    view.write(u64::from(ptr as u32), &staged).map_err(mem_err)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reply {
    Ok(Vec<u8>),
    /// Failed with no text (-1).
    Failed,
    /// Failed with Go's error text.
    Error(String),
}

/// `path` made absolute-normal lexically, as Node's path functions do:
/// `.` dropped, `..` climbing (and stopping at `/`). `None` for a relative
/// path.
fn lexical(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    if !path.has_root() {
        return None;
    }
    let mut out = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                out.pop();
            }
            _ => {}
        }
    }
    Some(out)
}

/// `path` with every symlink resolved, the way the kernel resolves it.
fn real(fs: &(dyn FileSystem + Send + Sync), path: &str) -> Option<PathBuf> {
    iwci_vfs::resolve(fs, lexical(path)?).ok()
}

/// Go's syscall error text for a file system error (node-run.js `ERRNO_TEXT`).
fn errno_text(error: &FsError) -> String {
    match error {
        FsError::PermissionDenied => "permission denied".into(),
        FsError::AlreadyExists => "file exists".into(),
        FsError::EntryNotFound => "no such file or directory".into(),
        FsError::BaseNotDirectory => "not a directory".into(),
        FsError::NotAFile => "is a directory".into(),
        FsError::DirectoryNotEmpty => "directory not empty".into(),
        other => other.to_string(),
    }
}

/// One host file operation over the job file system.
pub(crate) fn fs_call(fs: &(dyn FileSystem + Send + Sync), op: i32, request: &[u8]) -> Reply {
    let text = String::from_utf8_lossy(request);
    match op {
        OP_READ => match real(fs, &text).and_then(|p| iwci_vfs::read_file(fs, p).ok()) {
            Some(bytes) => Reply::Ok(bytes),
            None => Reply::Failed,
        },
        OP_STAT => {
            let Some(meta) = real(fs, &text).and_then(|p| fs.metadata(&p).ok()) else {
                return Reply::Failed;
            };
            let kind = if meta.is_dir() {
                "d"
            } else if meta.is_file() {
                "f"
            } else {
                "o"
            };
            Reply::Ok(format!("{kind} {} {}", meta.len, meta.modified).into_bytes())
        }
        OP_READ_DIR => {
            let Some(dir) = real(fs, &text) else {
                return Reply::Failed;
            };
            let Ok(entries) = fs.read_dir(&dir) else {
                return Reply::Failed;
            };
            let mut out = Vec::new();
            for entry in entries.flatten() {
                let Some(name) = entry.path.file_name() else {
                    continue;
                };
                // Directory entries do not follow links, as Node's
                // `withFileTypes` dirents do not.
                let kind = match fs.symlink_metadata(&entry.path) {
                    Ok(m) if m.file_type().is_symlink() => 'l',
                    Ok(m) if m.is_dir() => 'd',
                    Ok(m) if m.is_file() => 'f',
                    _ => 'o',
                };
                out.push(kind as u8);
                out.extend_from_slice(name.to_string_lossy().as_bytes());
                out.push(0);
            }
            Reply::Ok(out)
        }
        OP_REALPATH => match real(fs, &text) {
            Some(path) if path == Path::new("/") || fs.symlink_metadata(&path).is_ok() => {
                Reply::Ok(path.to_string_lossy().into_owned().into_bytes())
            }
            _ => Reply::Failed,
        },
        OP_WRITE | OP_APPEND => {
            let nul = request
                .iter()
                .position(|&b| b == 0)
                .unwrap_or(request.len());
            let path = String::from_utf8_lossy(&request[..nul]).into_owned();
            let data = request.get(nul + 1..).unwrap_or_default();
            write_file(fs, &path, data, op == OP_APPEND)
        }
        OP_REMOVE => {
            let Some(path) = lexical(&text) else {
                return Reply::Failed;
            };
            match remove_all(fs, &path) {
                Ok(()) => Reply::Ok(Vec::new()),
                Err(_) => Reply::Failed,
            }
        }
        OP_CHTIMES => {
            let mut parts = text.split('\0');
            let path = parts.next().unwrap_or_default();
            let ns = |s: Option<&str>| {
                s.filter(|s| !s.is_empty())
                    .and_then(|s| s.parse::<u64>().ok())
            };
            let (atime, mtime) = (ns(parts.next()), ns(parts.next()));
            chtimes(fs, path, atime, mtime)
        }
        _ => Reply::Failed,
    }
}

/// node-run.js `writeFile` (Go's `writeFileEnsuringDir`): write; when that
/// fails, make the parent directories and write again.
fn write_file(fs: &(dyn FileSystem + Send + Sync), path: &str, data: &[u8], append: bool) -> Reply {
    let Some(target) = real(fs, path) else {
        return Reply::Error(format!("open {path}: no such file or directory"));
    };
    let attempt = |target: &Path| -> std::result::Result<(), FsError> {
        if fs.metadata(target).is_ok_and(|m| m.is_dir()) {
            return Err(FsError::NotAFile);
        }
        // The overlay would make a missing or non-directory parent into a
        // directory on its own; the OS refuses, and so does this.
        match target.parent().map(|parent| fs.metadata(parent)) {
            Some(Ok(m)) if !m.is_dir() => return Err(FsError::BaseNotDirectory),
            Some(Err(e)) => return Err(e),
            _ => {}
        }
        let mut file = fs
            .new_open_options()
            .write(true)
            .create(true)
            .append(append)
            .truncate(!append)
            .open(target)?;
        block_on(async {
            file.write_all(data).await?;
            file.flush().await
        })
        .map_err(FsError::from)
    };
    if attempt(&target).is_ok() {
        return Reply::Ok(Vec::new());
    }
    if let Some(parent) = target.parent()
        && let Err(text) = mkdir_all(fs, parent)
    {
        return Reply::Error(text);
    }
    match attempt(&target) {
        Ok(()) => Reply::Ok(Vec::new()),
        Err(e) => Reply::Error(format!("open {path}: {}", errno_text(&e))),
    }
}

/// Go's `os.MkdirAll`, with Go's error text naming the part that failed.
fn mkdir_all(fs: &(dyn FileSystem + Send + Sync), path: &Path) -> std::result::Result<(), String> {
    match fs.metadata(path) {
        Ok(m) if m.is_dir() => return Ok(()),
        Ok(_) => return Err(format!("mkdir {}: not a directory", path.display())),
        Err(_) => {}
    }
    if let Some(parent) = path.parent()
        && parent != Path::new("/")
    {
        mkdir_all(fs, parent)?;
    }
    match fs.create_dir(path) {
        Ok(()) | Err(FsError::AlreadyExists) => Ok(()),
        Err(e) => Err(format!("mkdir {}: {}", path.display(), errno_text(&e))),
    }
}

/// `rm -rf`: links are removed, not followed, and a missing path is fine.
///
/// A directory is first removed whole. wasmer's overlay whites out a
/// directory that only the frozen snapshot has without looking inside, but
/// once a child of it has been removed the job layer holds a directory of
/// whiteouts that it then refuses to delete as not empty. So children are
/// only removed one by one when the whole removal fails, which is when the
/// job itself wrote into the directory.
fn remove_all(
    fs: &(dyn FileSystem + Send + Sync),
    path: &Path,
) -> std::result::Result<(), FsError> {
    let meta = match fs.symlink_metadata(path) {
        Ok(meta) => meta,
        Err(FsError::EntryNotFound) => return Ok(()),
        Err(e) => return Err(e),
    };
    if !meta.is_dir() {
        return fs.remove_file(path);
    }
    if fs.remove_dir(path).is_ok() {
        return Ok(());
    }
    let children: Vec<PathBuf> = fs.read_dir(path)?.flatten().map(|e| e.path).collect();
    for child in children {
        remove_all(fs, &child)?;
    }
    fs.remove_dir(path)
}

/// Go's `os.Chtimes`. A time that is not given stays as it is. On a file
/// that only the frozen snapshot has, the overlay keeps times per handle, so
/// the change lasts as long as the call; tsc only touches files it wrote,
/// which live in the job's own layer, where it sticks.
fn chtimes(
    fs: &(dyn FileSystem + Send + Sync),
    path: &str,
    atime: Option<u64>,
    mtime: Option<u64>,
) -> Reply {
    let Some(target) = real(fs, path) else {
        return Reply::Error(format!("chtimes {path}: no such file or directory"));
    };
    match fs.metadata(&target) {
        Err(e) => return Reply::Error(format!("chtimes {path}: {}", errno_text(&e))),
        Ok(m) if m.is_dir() => return Reply::Ok(Vec::new()),
        Ok(_) => {}
    }
    let result = fs
        .new_open_options()
        .write(true)
        .open(&target)
        .and_then(|mut file| file.set_times(atime, mtime));
    match result {
        Ok(()) => Reply::Ok(Vec::new()),
        Err(e) => Reply::Error(format!("chtimes {path}: {}", errno_text(&e))),
    }
}

/// The compiler reads files straight from the job's file system, not
/// through wasmer-wasix's root, so the run's scratch is mounted here too.
fn with_scratch(fs: crate::DynFs, scratch: Option<crate::DynFs>) -> crate::Result<crate::DynFs> {
    let Some(scratch) = scratch else {
        return Ok(fs);
    };
    let root = virtual_fs::MountFileSystem::new();
    let err = |e| crate::Error::Setup(format!("mounting the job file system: {e}"));
    root.mount(Path::new("/"), fs).map_err(err)?;
    root.mount(Path::new(crate::SCRATCH_MOUNT), scratch)
        .map_err(err)?;
    Ok(std::sync::Arc::new(root))
}
