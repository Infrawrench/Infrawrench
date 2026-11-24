//! A directory of tens of thousands of files costs time in proportion to
//! them, not to their square (#1408). The in-memory file system found a
//! child by name with a linear search, once per file, so writing 40,000
//! files into one directory took 12.9 s (release) and walking them 9.6 s.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use iwci_vfs::virtual_fs::{AsyncReadExt, AsyncWriteExt, FileSystem, FsError, mem_fs};
use iwci_vfs::{Entry, SnapshotBuilder};

const FILES: usize = 50_000;

/// Far above what the indexed file system takes for `FILES` (about a
/// second for each test in a debug build, under half of one in a release
/// build), far below what the searching one took in a release build (240 s
/// for the first test, 22 s for the second).
const BOUND: Duration = Duration::from_secs(10);

fn file(n: usize) -> PathBuf {
    PathBuf::from(format!("/work/out/f{n:05}"))
}

#[test]
fn fifty_thousand_files_in_one_directory_apply_walk_rename_and_remove_in_linear_time() {
    let job = SnapshotBuilder::new().freeze().fork();
    let mut entries = vec![Entry::Dir {
        path: "/work/out".into(),
    }];
    entries.extend((0..FILES).map(|n| Entry::File {
        path: file(n),
        data: format!("file {n}").into_bytes().into(),
    }));

    // One entry at a time, as `machines::apply` writes what a machine sent.
    let start = Instant::now();
    for entry in &entries {
        job.apply(std::slice::from_ref(entry)).unwrap();
    }
    let applied = start.elapsed();

    let start = Instant::now();
    let walked = job.entries_under(&["/work/out"]);
    let walk = start.elapsed();
    assert_eq!(walked.len(), FILES + 1);
    let files = walked
        .iter()
        .filter(|e| matches!(e, Entry::File { .. }))
        .count();
    assert_eq!(files, FILES);

    let fs = job.as_dyn();
    let start = Instant::now();
    for n in (0..FILES).step_by(2) {
        let to = PathBuf::from(format!("/work/out/renamed{n:05}"));
        block_on(fs.rename(&file(n), &to)).unwrap();
    }
    let renamed = start.elapsed();
    assert_eq!(job.read("/work/out/renamed00000").unwrap(), b"file 0");
    assert!(fs.metadata(&file(0)).is_err());
    assert_eq!(job.read(file(1)).unwrap(), b"file 1");

    let start = Instant::now();
    for n in 0..FILES {
        let path = if n % 2 == 0 {
            PathBuf::from(format!("/work/out/renamed{n:05}"))
        } else {
            file(n)
        };
        fs.remove_file(&path).unwrap();
    }
    let removed = start.elapsed();
    assert_eq!(fs.read_dir(Path::new("/work/out")).unwrap().count(), 0);

    eprintln!(
        "{FILES} files in one directory: apply {applied:?}, walk {walk:?}, \
         rename half {renamed:?}, remove all {removed:?}"
    );
    let total = applied + walk + renamed + removed;
    assert!(
        total < BOUND,
        "{FILES} files took {total:?}: apply {applied:?}, walk {walk:?}, \
         rename {renamed:?}, remove {removed:?}"
    );
}

/// The same in the in-memory file system itself, with open files unlinked
/// by their handle (how WASIX removes a file it has open).
#[test]
fn fifty_thousand_files_in_one_in_memory_directory_take_linear_time() {
    let fs = mem_fs::FileSystem::default();
    fs.create_dir(Path::new("/d")).unwrap();
    let start = Instant::now();
    let mut handles = Vec::with_capacity(FILES);
    for n in 0..FILES {
        let path = PathBuf::from(format!("/d/f{n:05}"));
        let handle = fs
            .new_open_options()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        if n % 10 == 0 {
            handles.push(handle);
        }
    }
    for n in 0..FILES {
        let path = PathBuf::from(format!("/d/f{n:05}"));
        assert!(fs.metadata(&path).unwrap().is_file());
    }
    for mut handle in handles {
        handle.unlink().unwrap();
    }
    let listed = fs.read_dir(Path::new("/d")).unwrap().count();
    assert_eq!(listed, FILES - FILES / 10);
    let elapsed = start.elapsed();
    eprintln!("{FILES} in-memory files: create, stat and unlink a tenth by handle in {elapsed:?}");
    assert!(elapsed < BOUND, "{FILES} in-memory files took {elapsed:?}");
}

/// The names in `dir`, in the order it lists them.
fn names(fs: &mem_fs::FileSystem, dir: &str) -> Vec<String> {
    fs.read_dir(Path::new(dir))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

fn write(fs: &mem_fs::FileSystem, path: &str, bytes: &[u8]) {
    let mut f = fs
        .new_open_options()
        .write(true)
        .create(true)
        .truncate(true)
        .open(Path::new(path))
        .unwrap();
    block_on(f.write_all(bytes)).unwrap();
}

fn read(fs: &mem_fs::FileSystem, path: &str) -> Result<Vec<u8>, FsError> {
    let mut f = fs.new_open_options().read(true).open(Path::new(path))?;
    let mut out = Vec::new();
    block_on(f.read_to_end(&mut out)).unwrap();
    Ok(out)
}

fn missing(fs: &mem_fs::FileSystem, path: &str) -> bool {
    matches!(fs.metadata(Path::new(path)), Err(FsError::EntryNotFound))
}

/// A directory of `a`, `b`, `c`, `d` and `e`, each holding its own name.
fn abcde() -> mem_fs::FileSystem {
    let fs = mem_fs::FileSystem::default();
    fs.create_dir(Path::new("/d")).unwrap();
    for name in ["a", "b", "c", "d", "e"] {
        write(&fs, &format!("/d/{name}"), name.as_bytes());
    }
    fs
}

#[test]
fn a_renamed_name_is_found_under_its_new_name_only_and_keeps_its_place() {
    let fs = abcde();
    block_on(fs.rename(Path::new("/d/b"), Path::new("/d/x"))).unwrap();
    assert!(missing(&fs, "/d/b"));
    assert_eq!(read(&fs, "/d/x").unwrap(), b"b");
    assert_eq!(names(&fs, "/d"), ["a", "x", "c", "d", "e"]);

    // The old name is free, and a file made under it goes last.
    write(&fs, "/d/b", b"new b");
    assert_eq!(read(&fs, "/d/b").unwrap(), b"new b");
    assert_eq!(read(&fs, "/d/x").unwrap(), b"b");
    assert_eq!(names(&fs, "/d"), ["a", "x", "c", "d", "e", "b"]);

    // Renamed back and forth, to itself, and through a name that was taken.
    block_on(fs.rename(Path::new("/d/x"), Path::new("/d/x"))).unwrap();
    block_on(fs.rename(Path::new("/d/x"), Path::new("/d/y"))).unwrap();
    block_on(fs.rename(Path::new("/d/y"), Path::new("/d/x"))).unwrap();
    assert!(missing(&fs, "/d/y"));
    assert_eq!(read(&fs, "/d/x").unwrap(), b"b");
    assert_eq!(names(&fs, "/d"), ["a", "x", "c", "d", "e", "b"]);
}

#[test]
fn a_rename_onto_a_name_replaces_it_and_leaves_one_entry() {
    let fs = abcde();
    block_on(fs.rename(Path::new("/d/a"), Path::new("/d/d"))).unwrap();
    assert!(missing(&fs, "/d/a"));
    assert_eq!(read(&fs, "/d/d").unwrap(), b"a");
    // The moved file keeps its place; the one it replaced is gone.
    assert_eq!(names(&fs, "/d"), ["d", "b", "c", "e"]);
    fs.remove_file(Path::new("/d/d")).unwrap();
    assert!(missing(&fs, "/d/d"));
    assert_eq!(names(&fs, "/d"), ["b", "c", "e"]);
}

#[test]
fn a_name_moved_to_another_directory_is_found_there_only() {
    let fs = abcde();
    fs.create_dir(Path::new("/e")).unwrap();
    write(&fs, "/e/z", b"z");
    block_on(fs.rename(Path::new("/d/c"), Path::new("/e/c"))).unwrap();
    assert!(missing(&fs, "/d/c"));
    assert_eq!(read(&fs, "/e/c").unwrap(), b"c");
    assert_eq!(names(&fs, "/d"), ["a", "b", "d", "e"]);
    assert_eq!(names(&fs, "/e"), ["z", "c"]);

    // Onto a name there, and a directory with what is in it.
    block_on(fs.rename(Path::new("/d/a"), Path::new("/e/z"))).unwrap();
    assert_eq!(read(&fs, "/e/z").unwrap(), b"a");
    assert_eq!(names(&fs, "/e"), ["c", "z"]);
    fs.create_dir(Path::new("/d/sub")).unwrap();
    write(&fs, "/d/sub/f", b"f");
    block_on(fs.rename(Path::new("/d/sub"), Path::new("/e/sub2"))).unwrap();
    assert!(missing(&fs, "/d/sub"));
    assert!(missing(&fs, "/d/sub/f"));
    assert_eq!(read(&fs, "/e/sub2/f").unwrap(), b"f");
    write(&fs, "/d/sub", b"a file now");
    assert_eq!(read(&fs, "/d/sub").unwrap(), b"a file now");
}

#[test]
fn a_removed_name_is_gone_and_can_be_made_again() {
    let fs = abcde();
    fs.remove_file(Path::new("/d/c")).unwrap();
    assert!(missing(&fs, "/d/c"));
    assert!(matches!(
        fs.remove_file(Path::new("/d/c")),
        Err(FsError::EntryNotFound)
    ));
    assert_eq!(names(&fs, "/d"), ["a", "b", "d", "e"]);
    assert_eq!(read(&fs, "/d/d").unwrap(), b"d");
    write(&fs, "/d/c", b"again");
    assert_eq!(read(&fs, "/d/c").unwrap(), b"again");
    assert_eq!(names(&fs, "/d"), ["a", "b", "d", "e", "c"]);

    // A directory, too, with something in it made again.
    fs.create_dir(Path::new("/d/sub")).unwrap();
    assert!(matches!(
        fs.create_dir(Path::new("/d/sub")),
        Err(FsError::AlreadyExists)
    ));
    fs.remove_dir(Path::new("/d/sub")).unwrap();
    assert!(missing(&fs, "/d/sub"));
    fs.create_dir(Path::new("/d/sub")).unwrap();
    write(&fs, "/d/sub/f", b"f");
    assert_eq!(read(&fs, "/d/sub/f").unwrap(), b"f");
}

#[test]
fn an_open_file_unlinked_by_its_handle_leaves_its_neighbours() {
    let fs = abcde();
    let mut f = fs
        .new_open_options()
        .read(true)
        .open(Path::new("/d/c"))
        .unwrap();
    block_on(fs.rename(Path::new("/d/c"), Path::new("/d/renamed"))).unwrap();
    fs.remove_file(Path::new("/d/a")).unwrap();
    f.unlink().unwrap();
    assert!(missing(&fs, "/d/renamed"));
    assert_eq!(names(&fs, "/d"), ["b", "d", "e"]);
    let mut out = Vec::new();
    block_on(f.read_to_end(&mut out)).unwrap();
    assert_eq!(out, b"c");
    write(&fs, "/d/renamed", b"new");
    assert_eq!(read(&fs, "/d/renamed").unwrap(), b"new");
}

#[test]
fn every_name_of_a_linked_file_is_found_as_its_names_come_and_go() {
    let fs = abcde();
    fs.create_dir(Path::new("/e")).unwrap();
    fs.hard_link_numbered(Path::new("/d/b"), Path::new("/e/link"), 7)
        .unwrap();
    fs.hard_link_numbered(Path::new("/d/b"), Path::new("/d/link"), 7)
        .unwrap();
    assert_eq!(fs.metadata(Path::new("/e/link")).unwrap().nlink, 3);

    // The file's own name goes: it takes the place of its last link.
    fs.remove_file(Path::new("/d/b")).unwrap();
    assert!(missing(&fs, "/d/b"));
    assert_eq!(names(&fs, "/d"), ["a", "c", "d", "e", "link"]);
    assert_eq!(read(&fs, "/d/link").unwrap(), b"b");
    assert_eq!(read(&fs, "/e/link").unwrap(), b"b");
    assert_eq!(fs.metadata(Path::new("/d/link")).unwrap().nlink, 2);

    // Renamed, then unlinked through an open handle, by whichever name.
    block_on(fs.rename(Path::new("/d/link"), Path::new("/d/moved"))).unwrap();
    assert!(missing(&fs, "/d/link"));
    let mut f = fs
        .new_open_options()
        .read(true)
        .open(Path::new("/d/moved"))
        .unwrap();
    f.unlink().unwrap();
    assert!(missing(&fs, "/d/moved"));
    assert_eq!(names(&fs, "/d"), ["a", "c", "d", "e"]);
    assert_eq!(read(&fs, "/e/link").unwrap(), b"b");
    assert_eq!(fs.metadata(Path::new("/e/link")).unwrap().nlink, 1);
    fs.remove_file(Path::new("/e/link")).unwrap();
    assert!(missing(&fs, "/e/link"));
    assert_eq!(names(&fs, "/e"), Vec::<String>::new());
}
