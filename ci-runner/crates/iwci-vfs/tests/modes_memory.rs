//! What the record of file modes holds of the runner's memory: bounded per
//! file, whatever the depth, in the snapshot's record and in a job's, and
//! all of it gone with them.
//!
//! One test in its own binary, because it counts every allocation.

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};

use iwci_vfs::SnapshotBuilder;

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

#[test]
fn what_the_modes_of_deep_files_hold_is_bounded_and_freed() {
    const FILES: usize = 4000;
    // Fifteen directories of 255-byte names: a path of nearly 4 KiB.
    let mut dir = PathBuf::from("/work");
    for _ in 0..15 {
        dir.push("d".repeat(255));
    }
    let top = PathBuf::from("/work").join("d".repeat(255));
    let moved_top = PathBuf::from("/work/moved");
    let moved = moved_top.join(dir.strip_prefix(&top).unwrap());
    let paths: Vec<PathBuf> = (0..FILES).map(|i| dir.join(format!("f{i:07}"))).collect();
    let moved_paths: Vec<PathBuf> = (0..FILES).map(|i| moved.join(format!("f{i:07}"))).collect();
    let start = live();

    // The snapshot's record: a checkout with that many executables.
    let b = SnapshotBuilder::new();
    let before = live();
    for path in &paths {
        b.set_mode(path, 0o755).unwrap();
    }
    let held = live() - before;
    let per_file = held / FILES as i64;
    eprintln!("snapshot: {FILES} modes at depth 15, {held} bytes ({per_file} per file)");
    assert!(
        per_file < 256,
        "the snapshot holds {per_file} bytes per mode, which should not grow with the path"
    );
    let snapshot = b.freeze();

    // A job's record: it chmods every one of them.
    let job = snapshot.fork();
    let modes = job.modes();
    let before = live();
    for path in &paths {
        modes.set(path, 0o600);
    }
    let held = live() - before;
    let per_file = held / FILES as i64;
    eprintln!("job: {FILES} chmods at depth 15, {held} bytes ({per_file} per file)");
    assert!(
        per_file < 256,
        "a job holds {per_file} bytes per chmod, which should not grow with the path"
    );
    assert_eq!(modes.get(&paths[7]), Some(0o600));

    // Renaming the tree hides each snapshot mode where it was and records
    // each at its new path: still bounded per file.
    modes.renamed(&top, &moved_top);
    let after_rename = live() - before;
    eprintln!("job: after moving the tree, {after_rename} bytes");
    assert!(
        after_rename / (FILES as i64) < 512,
        "{} bytes per file after a rename",
        after_rename / FILES as i64
    );
    assert_eq!(modes.get(&paths[7]), None);
    assert_eq!(modes.get(&moved_paths[7]), Some(0o600));

    // Removing the files lets their own entries go; what stays hides the
    // snapshot's modes at the old paths, and nothing is recorded.
    for path in &moved_paths {
        modes.removed(path);
    }
    assert!(modes.recorded().is_empty());
    assert_eq!(modes.get(&moved_paths[7]), None);
    let kept = live() - before;
    assert!(
        kept <= held + (16 << 10),
        "{kept} bytes kept after removing every file, against {held} for its modes"
    );

    drop(modes);
    drop(job);
    drop(snapshot);
    assert!(
        live() - start < 16 << 10,
        "{} bytes left after the records went",
        live() - start
    );
}
