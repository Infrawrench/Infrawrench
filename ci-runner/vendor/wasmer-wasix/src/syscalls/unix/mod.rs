use std::mem;

use libc::{
    CLOCK_MONOTONIC, CLOCK_PROCESS_CPUTIME_ID, CLOCK_REALTIME, CLOCK_THREAD_CPUTIME_ID,
    clock_getres, clock_gettime, timespec,
};
use wasmer::WasmRef;
use wasmer_wasix_types::wasi::{Errno, Snapshot0Clockid, Timestamp};

use crate::syscalls::types::*;

pub fn platform_clock_res_get(
    clock_id: Snapshot0Clockid,
    resolution: WasmRef<Timestamp>,
) -> Result<i64, Errno> {
    let unix_clock_id = match clock_id {
        Snapshot0Clockid::Monotonic => CLOCK_MONOTONIC,
        Snapshot0Clockid::ProcessCputimeId => CLOCK_PROCESS_CPUTIME_ID,
        Snapshot0Clockid::Realtime => CLOCK_REALTIME,
        Snapshot0Clockid::ThreadCputimeId => CLOCK_THREAD_CPUTIME_ID,
        _ => return Err(Errno::Inval),
    };

    let (output, timespec_out) = unsafe {
        let mut timespec_out: timespec = timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        (clock_getres(unix_clock_id, &mut timespec_out), timespec_out)
    };

    let t_out = (timespec_out.tv_sec * 1_000_000_000).wrapping_add(timespec_out.tv_nsec);
    Ok(t_out)
}

/// What a guest's CPU clocks read, when the embedder says (iwci patch,
/// #1038): `Some(nanoseconds)` for the process or the thread asking, on the
/// thread that runs it, or `None` for the host's clock as before.
pub type CpuClocks = fn(thread: bool) -> Option<u64>;

static CPU_CLOCKS: std::sync::OnceLock<CpuClocks> = std::sync::OnceLock::new();

/// Answers `CLOCK_PROCESS_CPUTIME_ID` and `CLOCK_THREAD_CPUTIME_ID` with
/// `clocks` from now on, for every guest (iwci patch, #1038). The host's
/// clocks are the whole host process's CPU time, every guest's together,
/// and the CPU time of whichever host thread runs the guest thread, work it
/// did for others before included; an embedder that runs guests of
/// different users in one process knows better. Set once; later calls are
/// ignored.
pub fn set_cpu_clocks(clocks: CpuClocks) {
    let _ = CPU_CLOCKS.set(clocks);
}

pub fn platform_clock_time_get(
    clock_id: Snapshot0Clockid,
    precision: Timestamp,
) -> Result<i64, Errno> {
    let thread = match clock_id {
        Snapshot0Clockid::ProcessCputimeId => Some(false),
        Snapshot0Clockid::ThreadCputimeId => Some(true),
        _ => None,
    };
    if let (Some(thread), Some(clocks)) = (thread, CPU_CLOCKS.get())
        && let Some(nanos) = clocks(thread)
    {
        return Ok(i64::try_from(nanos).unwrap_or(i64::MAX));
    }
    let unix_clock_id = match clock_id {
        Snapshot0Clockid::Monotonic => CLOCK_MONOTONIC,
        Snapshot0Clockid::ProcessCputimeId => CLOCK_PROCESS_CPUTIME_ID,
        Snapshot0Clockid::Realtime => CLOCK_REALTIME,
        Snapshot0Clockid::ThreadCputimeId => CLOCK_THREAD_CPUTIME_ID,
        _ => return Err(Errno::Inval),
    };

    let (output, timespec_out) = unsafe {
        let mut timespec_out: timespec = timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        (
            clock_gettime(unix_clock_id, &mut timespec_out),
            timespec_out,
        )
    };

    let t_out = (timespec_out.tv_sec * 1_000_000_000).wrapping_add(timespec_out.tv_nsec);
    Ok(t_out)
}
