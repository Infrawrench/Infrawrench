//! What a job's files hold of the runner's memory, beside their bytes:
//! bounded per file, whatever the depth, covered by what the job is
//! charged, and all of it gone when the job's file system is.
//!
//! One test in its own binary, because it counts every allocation.

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use iwci_vfs::{ENTRY_COST, SnapshotBuilder, WriteBudget};

struct Counting;

static LIVE: AtomicI64 = AtomicI64::new(0);

// SAFETY: forwards to the system allocator, counting what is live.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size() as i64, Ordering::Relaxed);
        // SAFETY: as the caller's.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as i64, Ordering::Relaxed);
        // SAFETY: as the caller's.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new: usize) -> *mut u8 {
        LIVE.fetch_add(new as i64 - layout.size() as i64, Ordering::Relaxed);
        // SAFETY: as the caller's.
        unsafe { System.realloc(ptr, layout, new) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

fn live() -> i64 {
    LIVE.load(Ordering::Relaxed)
}

#[derive(Debug, Default)]
struct Budget {
    used: AtomicU64,
}

impl WriteBudget for Budget {
    fn take(&self, bytes: u64) -> bool {
        self.used.fetch_add(bytes, Ordering::SeqCst);
        true
    }
    fn give(&self, bytes: u64) {
        self.used.fetch_sub(bytes, Ordering::SeqCst);
    }
}

#[test]
fn what_a_jobs_files_hold_is_bounded_charged_and_freed() {
    const FILES: usize = 4000;
    let b = SnapshotBuilder::new();
    b.mkdir_all("/work").unwrap();
    let snapshot = b.freeze();
    let budget = Arc::new(Budget::default());
    let start = live();
    let job = snapshot.fork_limited(budget.clone());
    let fs = job.as_dyn();

    // Fifteen directories of 255-byte names: a path of nearly 4 KiB.
    let mut dir = PathBuf::from("/work");
    for _ in 0..15 {
        dir.push("d".repeat(255));
        fs.create_dir(&dir).unwrap();
    }
    let charged_before = budget.used.load(Ordering::SeqCst);
    let names: Vec<String> = (0..FILES).map(|i| format!("f{i:07}")).collect();
    let names_bytes: i64 = names.iter().map(|n| n.len() as i64).sum();
    let held_before_files = live();
    for name in &names {
        let file = fs
            .new_open_options()
            .write(true)
            .create(true)
            .open(dir.join(name))
            .unwrap();
        drop(file);
    }
    // What the names list itself took is not the job's.
    let held = live() - held_before_files;
    let per_file = held / FILES as i64;
    let charged = (budget.used.load(Ordering::SeqCst) - charged_before) as i64;
    eprintln!(
        "{FILES} files at depth 15: {held} bytes held ({per_file} per file), {charged} charged"
    );
    assert!(
        per_file < 1024,
        "{per_file} bytes per file, which should not grow with the path"
    );
    assert!(
        charged >= held,
        "charged {charged} for {held} held: the job holds more than it pays for"
    );
    assert_eq!(charged, FILES as i64 * ENTRY_COST as i64 + names_bytes);

    // Removing them gives the charge back, and their memory is either
    // freed or kept for the next files (the upper layer keeps its slots):
    // making them again takes nothing more.
    for name in &names {
        fs.remove_file(&dir.join(name)).unwrap();
    }
    assert_eq!(budget.used.load(Ordering::SeqCst), charged_before);
    let kept = live() - held_before_files;
    assert!(
        kept < held / 2,
        "{kept} of {held} bytes kept after removing every file"
    );
    for name in &names {
        drop(
            fs.new_open_options()
                .write(true)
                .create(true)
                .open(dir.join(name))
                .unwrap(),
        );
    }
    let again = live() - held_before_files;
    assert!(
        again <= held + (16 << 10),
        "{again} bytes for the same files again, against {held} the first time"
    );

    // And a job's file system that ends with its files still there frees
    // them when it goes.
    drop(names);
    drop(fs);
    drop(job);
    assert!(
        live() - start < 64 << 10,
        "{} bytes left after the job's file system went",
        live() - start
    );
}
