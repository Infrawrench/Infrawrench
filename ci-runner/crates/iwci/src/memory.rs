//! The host's memory, the process's own, and the share of it jobs get.
//!
//! Jobs run inside the runner's process, and so does everything the runner
//! keeps between them (compiled modules, the environments being used,
//! workspace snapshots, logs). `--memory` budgets only the jobs, so on a
//! server the budget is held to the host's memory less a reserve for the
//! rest (#1035): a busy moment then cannot take the host past what it has.

/// What a server keeps for itself by default, outside the job budget: room
/// for the compiled modules kept in memory at the default
/// `--pinned-module-memory` and `--module-memory`, the environments jobs
/// are using, workspace snapshots and logs.
pub const DEFAULT_RESERVE: u64 = 5 << 30;

/// The memory the process may use: the host's, or its cgroup's limit when
/// that is lower (a systemd `MemoryMax=`). `None` where neither can be
/// read.
pub fn host_memory() -> Option<u64> {
    let total = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| kib_field(&text, "MemTotal:"));
    let cgroup = std::fs::read_to_string("/proc/self/cgroup")
        .ok()
        .and_then(|text| cgroup_limit(&text));
    match (total, cgroup) {
        (Some(t), Some(c)) => Some(t.min(c)),
        (t, c) => t.or(c),
    }
}

/// The cgroup v2 `memory.max` of the process's own cgroup, or of the
/// nearest ancestor that sets one.
fn cgroup_limit(proc_self_cgroup: &str) -> Option<u64> {
    let path = proc_self_cgroup
        .lines()
        .find_map(|line| line.strip_prefix("0::"))?;
    let mut dir = std::path::PathBuf::from("/sys/fs/cgroup").join(path.trim_start_matches('/'));
    loop {
        if let Ok(text) = std::fs::read_to_string(dir.join("memory.max"))
            && let Ok(bytes) = text.trim().parse::<u64>()
        {
            return Some(bytes);
        }
        if dir == std::path::Path::new("/sys/fs/cgroup") || !dir.pop() {
            return None;
        }
    }
}

/// The process's resident memory and the anonymous part of it, from
/// `/proc/self/status`. File-backed pages (the binary, cached installs
/// mapped from disk) can be reclaimed; anonymous ones cannot.
pub fn process_memory() -> Option<ProcessMemory> {
    let text = std::fs::read_to_string("/proc/self/status").ok()?;
    Some(ProcessMemory {
        resident: kib_field(&text, "VmRSS:")?,
        anonymous: kib_field(&text, "RssAnon:")?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessMemory {
    pub resident: u64,
    pub anonymous: u64,
}

/// Gives back to the system the memory glibc's allocator holds free.
///
/// Every thread that allocates gets one of up to eight arenas per core, and
/// glibc returns an arena's free memory only from its top, so after a busy
/// hour the arenas held about 2 GB of freed job memory on ci-1, gone with
/// one call of this (#1035).
pub fn return_free_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim takes no pointers; it walks the allocator's own
    // free lists under the allocator's locks.
    unsafe {
        libc::malloc_trim(0);
    }
}

/// What a glibc arena may keep free at its top before a free gives it back.
pub const TRIM_THRESHOLD: usize = 2 << 20;
/// Allocations at least this large get a mapping of their own.
pub const MMAP_THRESHOLD: usize = 32 << 20;

/// Fixes glibc's allocator thresholds for a long-lived server, so that
/// [`return_free_memory`] gives back what an idle server no longer uses
/// (#1066).
///
/// glibc raises both thresholds as the process frees large mapped blocks,
/// up to a 32 MiB mmap threshold and a trim threshold of twice that. A
/// thread's arena is a series of 64 MiB heaps, so from then on no arena
/// heap but the main one is ever trimmed, and `malloc_trim` trims only the
/// main arena's top: each heap kept its top, the memory freed last in it,
/// resident for good. After two full Test pipelines that was 1 GB of the
/// server's 1.35 GB anonymous memory, in the tops of 64 arenas, holding the
/// last jobs' file contents (a `node_modules` source text among them) as
/// if it were live. Setting the thresholds turns their adjustment off: the
/// mmap threshold stays where glibc's own took it, and a free that leaves
/// more than [`TRIM_THRESHOLD`] at the top of any heap gives it back.
pub fn configure_allocator() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: mallopt takes plain integers and sets the allocator's
    // parameters under its own lock.
    unsafe {
        libc::mallopt(libc::M_MMAP_THRESHOLD, MMAP_THRESHOLD as libc::c_int);
        libc::mallopt(libc::M_TRIM_THRESHOLD, TRIM_THRESHOLD as libc::c_int);
    }
}

/// A `Name:   1234 kB` field of a `/proc` file, in bytes.
fn kib_field(text: &str, name: &str) -> Option<u64> {
    let rest = text.lines().find_map(|line| line.strip_prefix(name))?;
    let kib: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
    Some(kib << 10)
}

/// The job budget for a server: `--memory` if given, held to the host's
/// memory less `reserve`; without `--memory`, all of that. `Err` when the
/// host has no room for jobs at all.
pub fn job_budget(
    memory: Option<u64>,
    host: Option<u64>,
    reserve: u64,
) -> Result<Option<u64>, String> {
    let Some(host) = host else {
        return Ok(memory);
    };
    let room = host.saturating_sub(reserve);
    if room < iwci_spec::MIN_MEMORY {
        return Err(format!(
            "the host has {} MiB, which leaves no room for jobs after --memory-reserve {} MiB; lower the reserve",
            host >> 20,
            reserve >> 20
        ));
    }
    Ok(Some(memory.map_or(room, |m| m.min(room))))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    #[test]
    fn the_job_budget_leaves_the_reserve_to_the_runner() {
        // ci-2: 30 GiB visible, IWCI_MEMORY=26GiB.
        assert_eq!(
            job_budget(Some(26 * GIB), Some(30 * GIB), 4 * GIB),
            Ok(Some(26 * GIB))
        );
        // A budget the host cannot hold beside the runner is lowered.
        assert_eq!(
            job_budget(Some(28 * GIB), Some(30 * GIB), 4 * GIB),
            Ok(Some(26 * GIB))
        );
        // Without --memory, the host less the reserve.
        assert_eq!(
            job_budget(None, Some(30 * GIB), 4 * GIB),
            Ok(Some(26 * GIB))
        );
        // Where the host cannot be read, --memory stands as given.
        assert_eq!(job_budget(Some(8 * GIB), None, 4 * GIB), Ok(Some(8 * GIB)));
        assert_eq!(job_budget(None, None, 4 * GIB), Ok(None));
        assert!(job_budget(None, Some(4 * GIB), 4 * GIB).is_err());
    }

    #[test]
    fn proc_fields_are_read_in_bytes() {
        let status = "Name:\tiwci\nVmRSS:\t  4749260 kB\nRssAnon:\t 4714104 kB\n";
        assert_eq!(kib_field(status, "VmRSS:"), Some(4_749_260 << 10));
        assert_eq!(kib_field(status, "RssAnon:"), Some(4_714_104 << 10));
        assert_eq!(kib_field(status, "Swap:"), None);
        #[cfg(target_os = "linux")]
        {
            let me = process_memory().unwrap();
            assert!(me.resident >= me.anonymous && me.anonymous > 0, "{me:?}");
            assert!(host_memory().unwrap() > 0);
        }
    }
}
