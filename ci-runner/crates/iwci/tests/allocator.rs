//! An idle server gives back what its threads freed (#1066).
//!
//! Its own test binary, so no other test allocates in the same arenas.

#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn memory_a_thread_freed_leaves_its_arena() {
    iwci::memory::configure_allocator();
    // What raises glibc's thresholds when they are left to adjust: a large
    // mapped block freed (the server frees many: compiled modules, reports).
    drop(std::hint::black_box(vec![1u8; 30 << 20]));

    // A job's thread fills its arena with file contents, then ends.
    let (start, resident_after) = std::thread::spawn(|| {
        let blocks: Vec<Vec<u8>> = (0..96).map(|i| vec![i as u8; 512 << 10]).collect();
        let start = blocks[0].as_ptr() as usize;
        drop(std::hint::black_box(blocks));
        iwci::memory::return_free_memory();
        (start, anonymous_kib_around(start))
    })
    .join()
    .unwrap();
    let resident_after = resident_after.expect("the arena's mapping");
    // 48 MiB were written there; what stays is under the trim threshold
    // and the arena's own bookkeeping.
    assert!(
        resident_after < (2 * iwci::memory::TRIM_THRESHOLD as u64) >> 10,
        "{resident_after} KiB of the mapping at {start:#x} still resident"
    );
}

/// The `Anonymous:` KiB of the mapping that holds `addr`, from smaps.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn anonymous_kib_around(addr: usize) -> Option<u64> {
    let smaps = std::fs::read_to_string("/proc/self/smaps").ok()?;
    let mut inside = false;
    for line in smaps.lines() {
        if let Some((range, _)) = line.split_once(' ')
            && let Some((lo, hi)) = range.split_once('-')
            && let (Ok(lo), Ok(hi)) = (usize::from_str_radix(lo, 16), usize::from_str_radix(hi, 16))
        {
            inside = lo <= addr && addr < hi;
            continue;
        }
        if inside && let Some(kib) = line.strip_prefix("Anonymous:") {
            return kib.trim().trim_end_matches("kB").trim().parse().ok();
        }
    }
    None
}
