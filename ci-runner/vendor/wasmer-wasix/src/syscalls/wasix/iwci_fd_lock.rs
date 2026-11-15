//! iwci patch (#1216): advisory file locking, which WASIX has no syscall
//! for. `iwci_fd_flock` is `flock(2)` and `iwci_fd_record_lock` is
//! `fcntl(2)`'s `F_GETLK`, `F_SETLK` and `F_SETLKW`; a C library calls them
//! where it would make those system calls. The locks are kept by the
//! process's control plane (`crate::fs::FileLocks`), so they arbitrate
//! between the processes of one job's command and nothing else.

use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicU64},
    time::Duration,
};

use super::*;
use crate::{
    fs::{FileLocks, FlockOp, RecordOwner, RecordType},
    syscalls::*,
};

/// How often a blocking lock looks again: a lock is released when its
/// holder closes it or exits, which nothing announces.
const RETRY: Duration = Duration::from_millis(10);

// The C library's values (musl's, which WASIX's is).
const LOCK_SH: u32 = 1;
const LOCK_EX: u32 = 2;
const LOCK_NB: u32 = 4;
const LOCK_UN: u32 = 8;
const F_RDLCK: i16 = 0;
const F_WRLCK: i16 = 1;
const F_UNLCK: i16 = 2;
const SEEK_SET: i16 = 0;
const SEEK_CUR: i16 = 1;
const SEEK_END: i16 = 2;

/// `struct flock` as wasm32 and wasm64 lay it out: `short l_type`, `short
/// l_whence`, `off_t l_start` (at 8), `off_t l_len` (at 16), `pid_t l_pid`
/// (at 24), 32 bytes in all.
const FLOCK_SIZE: usize = 32;

/// What a lock on `fd` is taken on: the file's path, the open file
/// description (its shared offset), and the file's size.
fn lock_target(env: &WasiEnv, fd: WasiFd) -> Result<(PathBuf, Arc<AtomicU64>, u64), Errno> {
    let state = env.state();
    let fd = state.fs.get_fd(fd)?;
    let guard = fd.inode.read();
    let (path, size) = match guard.deref() {
        Kind::File { path, handle, .. } => {
            let size = match handle {
                Some(handle) => handle.read().unwrap().size(),
                None => fd.inode.stat.read().unwrap().st_size,
            };
            (path.clone(), size)
        }
        Kind::Dir { path, .. } => (path.clone(), 0),
        _ => return Err(Errno::Inval),
    };
    Ok((path, fd.inner.offset.clone(), size))
}

fn file_locks(env: &WasiEnv) -> Result<Arc<FileLocks>, Errno> {
    env.process
        .compute
        .upgrade()
        .map(|plane| plane.file_locks().clone())
        .ok_or(Errno::Nolck)
}

/// Waits a little before a blocking lock looks again; a signal ends the wait
/// with `EINTR`, as it ends a blocked `flock` or `F_SETLKW` on Linux.
fn wait_to_retry(ctx: &mut FunctionEnvMut<'_, WasiEnv>) -> Result<Result<(), Errno>, WasiError> {
    let tasks = ctx.data().tasks().clone();
    __asyncify(ctx, None, async move {
        tasks.sleep_now(RETRY).await;
        Ok(())
    })
}

/// ### `iwci_fd_flock()`
/// `flock(2)`: takes (`LOCK_SH`, `LOCK_EX`), or releases (`LOCK_UN`), the
/// lock of `fd`'s open file description on its file, waiting for one in the
/// way unless `LOCK_NB` is set (`EAGAIN` then).
#[instrument(level = "trace", skip_all, fields(%fd, %op), ret)]
pub fn iwci_fd_flock(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    fd: WasiFd,
    op: u32,
) -> Result<Errno, WasiError> {
    WasiEnv::do_pending_operations(&mut ctx)?;

    let lock = match op & !LOCK_NB {
        LOCK_SH => FlockOp::Shared,
        LOCK_EX => FlockOp::Exclusive,
        LOCK_UN => FlockOp::Unlock,
        _ => return Ok(Errno::Inval),
    };
    let (path, holder, _) = wasi_try_ok!(lock_target(ctx.data(), fd));
    let locks = wasi_try_ok!(file_locks(ctx.data()));
    loop {
        match locks.flock(&path, &holder, lock) {
            Ok(()) => return Ok(Errno::Success),
            Err(Errno::Again) if op & LOCK_NB == 0 => {
                wasi_try_ok!(wait_to_retry(&mut ctx)?);
            }
            Err(err) => return Ok(err),
        }
    }
}

/// ### `iwci_fd_record_lock()`
/// `fcntl(2)`'s record locks on `fd`'s file, owned by the calling process:
/// `cmd` 0 is `F_GETLK`, 1 `F_SETLK` and 2 `F_SETLKW`; `lock` points at a
/// `struct flock` (see [`FLOCK_SIZE`]). `F_SETLK` answers `EAGAIN` for a
/// lock of another process in the way, `F_SETLKW` waits for it, and
/// `F_GETLK` writes the first such lock back, or `F_UNLCK` for none.
#[instrument(level = "trace", skip_all, fields(%fd, %cmd), ret)]
pub fn iwci_fd_record_lock<M: MemorySize>(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    fd: WasiFd,
    cmd: u32,
    lock: WasmPtr<u8, M>,
) -> Result<Errno, WasiError> {
    WasiEnv::do_pending_operations(&mut ctx)?;

    let env = ctx.data();
    let memory = unsafe { env.memory_view(&ctx) };
    let slice = wasi_try_mem_ok!(lock.slice(&memory, wasi_try_ok!(to_offset::<M>(FLOCK_SIZE))));
    let bytes = wasi_try_mem_ok!(slice.read_to_vec());
    let short = |at: usize| i16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let long = |at: usize| i64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    let (kind, whence, l_start, l_len) = (short(0), short(2), long(8), long(16));

    let (path, _, size) = wasi_try_ok!(lock_target(env, fd));
    let base = match whence {
        SEEK_SET => 0,
        SEEK_CUR => {
            let fd = wasi_try_ok!(env.state().fs.get_fd(fd));
            fd.inner.offset.load(std::sync::atomic::Ordering::Acquire) as i64
        }
        SEEK_END => size as i64,
        _ => return Ok(Errno::Inval),
    };
    // A negative length covers the bytes before `l_start`, as POSIX allows.
    let Some(start) = base.checked_add(l_start) else {
        return Ok(Errno::Overflow);
    };
    let (start, end) = match l_len {
        0 => (start, u64::MAX),
        len if len > 0 => (start, start.saturating_add(len) as u64),
        len => (start + len, start as u64),
    };
    if start < 0 {
        return Ok(Errno::Inval);
    }
    let start = start as u64;
    let kind = match kind {
        F_RDLCK => RecordType::Read,
        F_WRLCK => RecordType::Write,
        F_UNLCK => RecordType::Unlock,
        _ => return Ok(Errno::Inval),
    };
    let locks = wasi_try_ok!(file_locks(env));
    let pid = env.process.pid();

    if cmd == 0 {
        if kind == RecordType::Unlock {
            return Ok(Errno::Inval);
        }
        let mut out = bytes.clone();
        match locks.conflicting_record(&path, pid, start, end, kind == RecordType::Write) {
            Some(conflict) => {
                let kind = if conflict.write { F_WRLCK } else { F_RDLCK };
                let len = if conflict.end == u64::MAX {
                    0
                } else {
                    (conflict.end - conflict.start) as i64
                };
                out[0..2].copy_from_slice(&kind.to_le_bytes());
                out[2..4].copy_from_slice(&SEEK_SET.to_le_bytes());
                out[8..16].copy_from_slice(&(conflict.start as i64).to_le_bytes());
                out[16..24].copy_from_slice(&len.to_le_bytes());
                out[24..28].copy_from_slice(&(conflict.pid.raw() as i32).to_le_bytes());
            }
            None => out[0..2].copy_from_slice(&F_UNLCK.to_le_bytes()),
        }
        wasi_try_mem_ok!(slice.write_slice(&out));
        return Ok(Errno::Success);
    }
    if cmd != 1 && cmd != 2 {
        return Ok(Errno::Inval);
    }
    let owner = RecordOwner {
        pid,
        alive: Arc::downgrade(&env.process.finished),
    };
    loop {
        match locks.set_record(&path, &owner, start, end, kind) {
            Ok(()) => return Ok(Errno::Success),
            Err(Errno::Again) if cmd == 2 => {
                wasi_try_ok!(wait_to_retry(&mut ctx)?);
            }
            Err(err) => return Ok(err),
        }
    }
}
