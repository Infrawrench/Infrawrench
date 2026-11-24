mod file;
mod file_opener;
mod filesystem;
mod offloaded_file;
mod spill;
mod stdio;

use file::{File, FileHandle, ReadOnlyFile};
pub use filesystem::FileSystem;
pub use offloaded_file::OffloadBackingStore;
pub use spill::{Spill, SpillConfig};
#[cfg(not(feature = "js"))]
use std::time::{SystemTime, UNIX_EPOCH};
pub use stdio::{Stderr, Stdin, Stdout};
#[cfg(feature = "js")]
pub use web_time::{SystemTime, UNIX_EPOCH};

use crate::Metadata;
use std::{
    collections::{HashMap, hash_map},
    ffi::{OsStr, OsString},
    fmt,
    hash::{BuildHasher, BuildHasherDefault, Hasher, RandomState},
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};

use self::offloaded_file::OffloadedFile;

type Inode = usize;
const ROOT_INODE: Inode = 0;

#[derive(Debug, Default)]
struct FileLifecycle {
    open_handles: AtomicUsize,
    unlinked: AtomicBool,
    /// iwci patch: the inode number the file reports once it has been
    /// given a second name (`FileSystem::hard_link_numbered`), so every
    /// name reports the same one; 0 before, when the caller numbers it.
    ino: AtomicU64,
}

impl FileLifecycle {
    fn opened(&self) {
        self.open_handles.fetch_add(1, Ordering::AcqRel);
    }

    fn closed(&self) -> usize {
        let previous = self
            .open_handles
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                count.checked_sub(1)
            })
            .expect("FileLifecycle::closed called with zero open handles");
        previous - 1
    }

    fn open_handle_count(&self) -> usize {
        self.open_handles.load(Ordering::Acquire)
    }

    fn mark_unlinked(&self) {
        self.unlinked.store(true, Ordering::Release);
    }

    fn is_unlinked(&self) -> bool {
        self.unlinked.load(Ordering::Acquire)
    }

    fn ino(&self) -> u64 {
        self.ino.load(Ordering::Acquire)
    }

    /// Numbers the file `ino`, unless it has a number already.
    fn number(&self, ino: u64) {
        let _ = self
            .ino
            .compare_exchange(0, ino, Ordering::AcqRel, Ordering::Acquire);
    }
}

#[derive(Debug)]
struct FileNode {
    inode: Inode,
    name: OsString,
    file: File,
    metadata: Metadata,
    lifecycle: Arc<FileLifecycle>,
}

#[derive(Debug)]
struct ReadOnlyFileNode {
    inode: Inode,
    name: OsString,
    file: ReadOnlyFile,
    metadata: Metadata,
    lifecycle: Arc<FileLifecycle>,
}

#[derive(Debug)]
struct OffloadedFileNode {
    inode: Inode,
    name: OsString,
    file: OffloadedFile,
    metadata: Metadata,
    lifecycle: Arc<FileLifecycle>,
}

#[derive(Debug)]
struct ArcFileNode {
    inode: Inode,
    name: OsString,
    fs: Arc<dyn crate::FileSystem + Send + Sync>,
    path: PathBuf,
    metadata: Metadata,
    lifecycle: Arc<FileLifecycle>,
}

// FIXME: this is broken!!! A `VirtualFile` stores its own offset,
// so a file stored this way can only be read once!
#[derive(Debug)]
struct CustomFileNode {
    inode: Inode,
    name: OsString,
    file: Mutex<Box<dyn crate::VirtualFile + Send + Sync>>,
    metadata: Metadata,
    lifecycle: Arc<FileLifecycle>,
}

#[derive(Debug)]
struct DirectoryNode {
    inode: Inode,
    name: OsString,
    children: Children,
    metadata: Metadata,
}

/// iwci patch (#1408): a directory's entries, with an index by name.
/// Upstream keeps a `Vec<Inode>` and finds a name by reading every entry's
/// node, so a directory of n files took time in n² to fill or walk (40,000
/// files: 13 s to write, 10 s to walk).
///
/// Each entry is filed under a hash of its name, with a position: a number
/// it is given when it is added, larger than every earlier one. The
/// position is the handle `remove`, `rename` and `replace` take, and does
/// not change when other entries come or go; listing sorts by it, so a
/// directory lists in the order upstream lists in: the order entries were
/// added, an entry renamed in place where it was, one moved in from another
/// directory at the end.
///
/// Names are not stored here (the nodes have them), so two names with one
/// hash share a list, and `named` gives the entries that may have a name:
/// the caller compares the node's. One name has one entry unless something
/// gave a second entry a name that was taken (upstream lets a rename of a
/// file onto a directory's name do that); both are kept, and the earlier
/// comes first, as a search from the start found it.
#[derive(Default)]
pub(super) struct Children {
    entries: HashMap<u64, Named, BuildHasherDefault<NameHasher>>,
    next: usize,
}

/// The entries under one hash, as (position, inode), by position.
enum Named {
    One((usize, Inode)),
    Many(Vec<(usize, Inode)>),
}

impl Named {
    fn entries(&self) -> &[(usize, Inode)] {
        match self {
            Self::One(entry) => std::slice::from_ref(entry),
            Self::Many(entries) => entries,
        }
    }
}

/// A name's hash, keyed at random once per process, so names a job picks
/// cannot be made to collide.
fn name_hash(name: &OsStr) -> u64 {
    static STATE: OnceLock<RandomState> = OnceLock::new();
    STATE.get_or_init(RandomState::new).hash_one(name)
}

/// The keys of `Children::entries` are hashes already.
#[derive(Default)]
struct NameHasher(u64);

impl Hasher for NameHasher {
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = self.0.rotate_left(8) ^ u64::from(*byte);
        }
    }

    fn write_u64(&mut self, hash: u64) {
        self.0 = hash;
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

impl Children {
    pub(super) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Every entry, in position order.
    pub(super) fn in_order(&self) -> Vec<Inode> {
        let mut all: Vec<(usize, Inode)> = self
            .entries
            .values()
            .flat_map(|named| named.entries().iter().copied())
            .collect();
        all.sort_unstable();
        all.into_iter().map(|(_, inode)| inode).collect()
    }

    /// The entries that may be named `name`, as (position, inode), in
    /// position order. The caller compares the node's name.
    pub(super) fn named(&self, name: &OsStr) -> impl Iterator<Item = (usize, Inode)> + '_ {
        self.entries
            .get(&name_hash(name))
            .map_or(&[][..], Named::entries)
            .iter()
            .copied()
    }

    /// The position of the entry `inode`, which is named `name`.
    pub(super) fn position_of(&self, name: &OsStr, inode: Inode) -> Option<usize> {
        self.named(name)
            .find(|&(_, entry)| entry == inode)
            .map(|(position, _)| position)
    }

    /// Adds `inode`, named `name`, after every other entry.
    pub(super) fn push(&mut self, name: &OsStr, inode: Inode) -> usize {
        let position = self.next;
        self.next += 1;
        self.file(name_hash(name), position, inode);
        position
    }

    /// Removes the entry at `position`, which is named `name`.
    pub(super) fn remove(&mut self, name: &OsStr, position: usize) -> Option<Inode> {
        self.unfile(name_hash(name), position)
    }

    /// Names the entry at `position` `to` rather than `from`. It keeps its
    /// position.
    pub(super) fn rename(&mut self, from: &OsStr, position: usize, to: &OsStr) -> bool {
        match self.unfile(name_hash(from), position) {
            Some(inode) => {
                self.file(name_hash(to), position, inode);
                true
            }
            None => false,
        }
    }

    /// Puts `inode` in the place of the entry at `position`, which is
    /// named `name`.
    pub(super) fn replace(&mut self, name: &OsStr, position: usize, inode: Inode) -> bool {
        let entry = match self.entries.get_mut(&name_hash(name)) {
            Some(Named::One(entry)) => Some(entry).filter(|e| e.0 == position),
            Some(Named::Many(entries)) => entries.iter_mut().find(|e| e.0 == position),
            None => None,
        };
        match entry {
            Some(entry) => {
                entry.1 = inode;
                true
            }
            None => false,
        }
    }

    fn file(&mut self, hash: u64, position: usize, inode: Inode) {
        match self.entries.entry(hash) {
            hash_map::Entry::Vacant(vacant) => {
                vacant.insert(Named::One((position, inode)));
            }
            hash_map::Entry::Occupied(mut occupied) => {
                let named = occupied.get_mut();
                let mut entries = match std::mem::replace(named, Named::Many(Vec::new())) {
                    Named::One(entry) => vec![entry],
                    Named::Many(entries) => entries,
                };
                let at = entries.partition_point(|e| e.0 < position);
                entries.insert(at, (position, inode));
                *named = Named::Many(entries);
            }
        }
    }

    fn unfile(&mut self, hash: u64, position: usize) -> Option<Inode> {
        let named = self.entries.get_mut(&hash)?;
        let inode = match named {
            Named::One((at, inode)) if *at == position => {
                let inode = *inode;
                self.entries.remove(&hash);
                return Some(inode);
            }
            Named::One(_) => return None,
            Named::Many(entries) => {
                let at = entries.iter().position(|e| e.0 == position)?;
                entries.remove(at).1
            }
        };
        if let Named::Many(entries) = named {
            match entries[..] {
                [] => {
                    self.entries.remove(&hash);
                }
                [entry] => *named = Named::One(entry),
                _ => {}
            }
        }
        Some(inode)
    }
}

impl fmt::Debug for Children {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_list().entries(self.in_order()).finish()
    }
}

/// Compares the entries, in order, as upstream's tests compare its `Vec`.
impl<const N: usize> PartialEq<[Inode; N]> for Children {
    fn eq(&self, other: &[Inode; N]) -> bool {
        self.in_order() == other
    }
}

#[derive(Debug)]
struct ArcDirectoryNode {
    inode: Inode,
    name: OsString,
    fs: Arc<dyn crate::FileSystem + Send + Sync>,
    path: PathBuf,
    metadata: Metadata,
}

#[derive(Debug)]
struct SymlinkNode {
    inode: Inode,
    name: OsString,
    target: PathBuf,
    metadata: Metadata,
}

/// iwci patch: a second (or later) name of a file, a hard link. The file
/// itself stays listed under one name, its node's own; every other name is
/// one of these, in the directory `parent`, naming the file's node
/// `target`. `FileSystemInner::links` lists them by file, so the file's link
/// count is one more than that list's length, and removing the file's own
/// name moves the node into the place of one of these (see
/// `FileSystemInner::unlink_file_inode`), so the file is listed under a
/// name for as long as it has one.
#[derive(Debug)]
struct HardLinkNode {
    inode: Inode,
    name: OsString,
    target: Inode,
    parent: Inode,
    metadata: Metadata,
}

#[derive(Debug)]
enum Node {
    File(FileNode),
    OffloadedFile(OffloadedFileNode),
    ReadOnlyFile(ReadOnlyFileNode),
    ArcFile(ArcFileNode),
    CustomFile(CustomFileNode),
    Symlink(SymlinkNode),
    Directory(DirectoryNode),
    ArcDirectory(ArcDirectoryNode),
    HardLink(HardLinkNode),
}

impl Node {
    fn inode(&self) -> Inode {
        *match self {
            Self::File(FileNode { inode, .. }) => inode,
            Self::OffloadedFile(OffloadedFileNode { inode, .. }) => inode,
            Self::ReadOnlyFile(ReadOnlyFileNode { inode, .. }) => inode,
            Self::ArcFile(ArcFileNode { inode, .. }) => inode,
            Self::CustomFile(CustomFileNode { inode, .. }) => inode,
            Self::Symlink(SymlinkNode { inode, .. }) => inode,
            Self::Directory(DirectoryNode { inode, .. }) => inode,
            Self::ArcDirectory(ArcDirectoryNode { inode, .. }) => inode,
            Self::HardLink(HardLinkNode { inode, .. }) => inode,
        }
    }

    fn name(&self) -> &OsStr {
        match self {
            Self::File(FileNode { name, .. }) => name.as_os_str(),
            Self::OffloadedFile(OffloadedFileNode { name, .. }) => name.as_os_str(),
            Self::ReadOnlyFile(ReadOnlyFileNode { name, .. }) => name.as_os_str(),
            Self::ArcFile(ArcFileNode { name, .. }) => name.as_os_str(),
            Self::CustomFile(CustomFileNode { name, .. }) => name.as_os_str(),
            Self::Symlink(SymlinkNode { name, .. }) => name.as_os_str(),
            Self::Directory(DirectoryNode { name, .. }) => name.as_os_str(),
            Self::ArcDirectory(ArcDirectoryNode { name, .. }) => name.as_os_str(),
            Self::HardLink(HardLinkNode { name, .. }) => name.as_os_str(),
        }
    }

    fn metadata(&self) -> &Metadata {
        match self {
            Self::File(FileNode { metadata, .. }) => metadata,
            Self::OffloadedFile(OffloadedFileNode { metadata, .. }) => metadata,
            Self::ReadOnlyFile(ReadOnlyFileNode { metadata, .. }) => metadata,
            Self::ArcFile(ArcFileNode { metadata, .. }) => metadata,
            Self::CustomFile(CustomFileNode { metadata, .. }) => metadata,
            Self::Symlink(SymlinkNode { metadata, .. }) => metadata,
            Self::Directory(DirectoryNode { metadata, .. }) => metadata,
            Self::ArcDirectory(ArcDirectoryNode { metadata, .. }) => metadata,
            Self::HardLink(HardLinkNode { metadata, .. }) => metadata,
        }
    }

    fn file_lifecycle(&self) -> Option<&Arc<FileLifecycle>> {
        match self {
            Self::File(FileNode { lifecycle, .. })
            | Self::OffloadedFile(OffloadedFileNode { lifecycle, .. })
            | Self::ReadOnlyFile(ReadOnlyFileNode { lifecycle, .. })
            | Self::ArcFile(ArcFileNode { lifecycle, .. })
            | Self::CustomFile(CustomFileNode { lifecycle, .. }) => Some(lifecycle),
            _ => None,
        }
    }

    fn metadata_mut(&mut self) -> &mut Metadata {
        match self {
            Self::File(FileNode { metadata, .. }) => metadata,
            Self::OffloadedFile(OffloadedFileNode { metadata, .. }) => metadata,
            Self::ReadOnlyFile(ReadOnlyFileNode { metadata, .. }) => metadata,
            Self::ArcFile(ArcFileNode { metadata, .. }) => metadata,
            Self::CustomFile(CustomFileNode { metadata, .. }) => metadata,
            Self::Symlink(SymlinkNode { metadata, .. }) => metadata,
            Self::Directory(DirectoryNode { metadata, .. }) => metadata,
            Self::ArcDirectory(ArcDirectoryNode { metadata, .. }) => metadata,
            Self::HardLink(HardLinkNode { metadata, .. }) => metadata,
        }
    }

    fn set_name(&mut self, new_name: OsString) {
        match self {
            Self::File(FileNode { name, .. }) => *name = new_name,
            Self::OffloadedFile(OffloadedFileNode { name, .. }) => *name = new_name,
            Self::ReadOnlyFile(ReadOnlyFileNode { name, .. }) => *name = new_name,
            Self::ArcFile(ArcFileNode { name, .. }) => *name = new_name,
            Self::CustomFile(CustomFileNode { name, .. }) => *name = new_name,
            Self::Symlink(SymlinkNode { name, .. }) => *name = new_name,
            Self::Directory(DirectoryNode { name, .. }) => *name = new_name,
            Self::ArcDirectory(ArcDirectoryNode { name, .. }) => *name = new_name,
            Self::HardLink(HardLinkNode { name, .. }) => *name = new_name,
        }
    }
}

fn time() -> u64 {
    // SAFETY: It's very unlikely that the system returns a time that
    // is before `UNIX_EPOCH` :-).
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

/// iwci patch (#1408).
#[cfg(test)]
mod test_children {
    use super::Children;
    use std::ffi::OsStr;

    fn named(children: &Children, name: &str) -> Vec<(usize, usize)> {
        children.named(OsStr::new(name)).collect()
    }

    #[test]
    fn names_are_found_in_place_order_and_a_taken_name_keeps_both_entries() {
        let mut c = Children::default();
        let a = c.push(OsStr::new("a"), 10);
        let b = c.push(OsStr::new("b"), 11);
        let a2 = c.push(OsStr::new("a"), 12);
        assert_eq!(named(&c, "a"), [(a, 10), (a2, 12)]);
        assert!(c.rename(OsStr::new("b"), b, OsStr::new("a")));
        assert_eq!(named(&c, "a"), [(a, 10), (b, 11), (a2, 12)]);
        assert!(named(&c, "b").is_empty());
        assert_eq!(c, [10, 11, 12]);

        assert_eq!(c.remove(OsStr::new("a"), a), Some(10));
        assert_eq!(c.position_of(OsStr::new("a"), 12), Some(a2));
        assert!(c.replace(OsStr::new("a"), a2, 13));
        assert_eq!(c, [11, 13]);
        assert_eq!(c.remove(OsStr::new("a"), b), Some(11));
        assert_eq!(named(&c, "a"), [(a2, 13)]);
        assert_eq!(c.remove(OsStr::new("a"), a2), Some(13));
        assert!(c.is_empty());
        assert!(named(&c, "a").is_empty());
        assert_eq!(c.remove(OsStr::new("a"), a2), None);
        assert!(!c.rename(OsStr::new("a"), a2, OsStr::new("z")));

        // Positions only grow, so what is added later lists later.
        let z = c.push(OsStr::new("z"), 20);
        assert!(z > a2);
        assert_eq!(c, [20]);
    }
}
