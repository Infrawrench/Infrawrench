//! A restored cache's files are older than anything the job writes.

use iwci_vfs::virtual_fs::FileSystem;
use iwci_vfs::{Entry, SnapshotBuilder};

/// pnpm hashes a store file again when its modification time is newer than
/// when pnpm last checked it; a restore stamped every file "now".
#[test]
fn restored_files_have_the_epoch_as_their_modification_time() {
    let job = SnapshotBuilder::new().freeze().fork();
    let entries = vec![
        Entry::Dir {
            path: "/root/.pnpm-store".into(),
        },
        Entry::File {
            path: "/root/.pnpm-store/a".into(),
            data: b"a".to_vec().into(),
        },
    ];
    job.apply(&entries).unwrap();
    job.write("/root/own.txt", b"mine").unwrap();
    job.set_restored_times(&entries);
    let fs = job.as_dyn();
    let restored = fs.metadata("/root/.pnpm-store/a".as_ref()).unwrap();
    assert_eq!(restored.modified, 0);
    let own = fs.metadata("/root/own.txt".as_ref()).unwrap();
    assert!(own.modified > 0, "the job's own writes keep theirs");
    assert_eq!(job.read("/root/.pnpm-store/a").unwrap(), b"a");
}
