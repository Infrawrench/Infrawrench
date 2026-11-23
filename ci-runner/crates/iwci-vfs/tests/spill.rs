//! A job's files past a memory limit move to disk and read back the same.

use std::path::PathBuf;
use std::sync::Arc;

use iwci_vfs::virtual_fs::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, FileSystem};
use iwci_vfs::{Change, SnapshotBuilder, SpillConfig, WriteBudget};

#[derive(Debug, Default)]
struct Unlimited;

impl WriteBudget for Unlimited {
    fn take(&self, _: u64) -> bool {
        true
    }
    fn give(&self, _: u64) {}
}

/// A fresh, empty directory for one test's disk files.
fn spill_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("iwci-spill-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn content(n: usize, len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 + n * 7) as u8).collect()
}

const KIB: usize = 1024;

#[test]
fn files_past_the_limit_move_to_disk_and_read_back_the_same() {
    let dir = spill_dir("limit");
    let b = SnapshotBuilder::new();
    b.mkdir_all("/app").unwrap();
    let job = b.freeze().fork_spilling(
        Arc::new(Unlimited),
        SpillConfig {
            dir: dir.clone(),
            resident_max: (256 * KIB) as u64,
        },
    );

    for n in 0..10 {
        job.write(format!("/app/f{n}"), &content(n, 64 * KIB))
            .unwrap();
    }
    let (resident, spilled) = job.spill_usage().unwrap();
    assert!(resident <= (256 * KIB) as u64, "{resident} in memory");
    assert_eq!(resident + spilled, (640 * KIB) as u64);
    for n in 0..10 {
        assert_eq!(
            job.read(format!("/app/f{n}")).unwrap(),
            content(n, 64 * KIB)
        );
    }
    // The disk files are unlinked as soon as they are made.
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);

    // A spilled file can be written in place, grown and read again.
    futures::executor::block_on(async {
        let mut f = job
            .as_dyn()
            .new_open_options()
            .read(true)
            .write(true)
            .open(std::path::Path::new("/app/f0"))
            .unwrap();
        f.seek(std::io::SeekFrom::Start(10)).await.unwrap();
        f.write_all(b"XYZ").await.unwrap();
        f.seek(std::io::SeekFrom::End(0)).await.unwrap();
        f.write_all(b"tail").await.unwrap();
        f.flush().await.unwrap();
        let mut all = Vec::new();
        f.seek(std::io::SeekFrom::Start(0)).await.unwrap();
        f.read_to_end(&mut all).await.unwrap();
        let mut want = content(0, 64 * KIB);
        want[10..13].copy_from_slice(b"XYZ");
        want.extend_from_slice(b"tail");
        assert_eq!(all, want);
    });

    // A job's changes read spilled files like any other.
    let changes = job.changes("/app");
    assert_eq!(changes.len(), 10);
    assert!(changes.iter().all(|c| matches!(c, Change::Added { .. })));

    // Rewritten from nothing, a file is back in memory; removed, it is
    // gone from both counts.
    job.write("/app/f1", b"small").unwrap();
    assert_eq!(job.read("/app/f1").unwrap(), b"small");
    for n in 0..10 {
        job.remove_file(format!("/app/f{n}")).unwrap();
    }
    assert_eq!(job.spill_usage(), Some((0, 0)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn without_a_spill_config_nothing_is_counted() {
    let b = SnapshotBuilder::new();
    let job = b.freeze().fork_limited(Arc::new(Unlimited));
    job.write("/a", &content(1, 8 * KIB)).unwrap();
    assert_eq!(job.spill_usage(), None);
    assert_eq!(job.read("/a").unwrap(), content(1, 8 * KIB));
}

#[test]
fn a_disk_that_cannot_take_the_files_keeps_them_in_memory() {
    // A spill directory that does not exist: moving fails, so the files
    // stay where they were and every write still succeeds.
    let dir = std::env::temp_dir().join(format!("iwci-spill-missing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let job = SnapshotBuilder::new().freeze().fork_spilling(
        Arc::new(Unlimited),
        SpillConfig {
            dir,
            resident_max: (16 * KIB) as u64,
        },
    );
    for n in 0..4 {
        job.write(format!("/f{n}"), &content(n, 16 * KIB)).unwrap();
    }
    assert_eq!(job.spill_usage(), Some(((64 * KIB) as u64, 0)));
    for n in 0..4 {
        assert_eq!(job.read(format!("/f{n}")).unwrap(), content(n, 16 * KIB));
    }
}
