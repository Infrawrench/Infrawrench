//! What the agent remembers about a path, to tell later whether the job
//! changed it.
//!
//! A file counts as changed when its kind, size, modification time, change
//! time or mode differs. The change time is the part that makes this exact:
//! the kernel sets it on every write, rename onto, truncate or chmod, and
//! nothing a job can do (`touch -d`, `cp -p`, `tar x`) sets it back. On Unix
//! it is `st_ctime`; on Windows it is the `ChangeTime` of `FILE_BASIC_INFO`.
//! Both are at nanosecond (Unix) or 100 ns (Windows) precision, but the
//! clock that sets them ticks more coarsely (a few milliseconds on Linux
//! file systems without fine-grained times, about 15.6 ms on Windows), so a
//! rewrite of the same size within the tick of the put, with its
//! modification time put back, would look unchanged. No job starts that
//! soon after its tree arrives.
//!
//! A directory counts as changed when its mode differs, and as made again
//! when its identity does (device and inode on Unix, volume and file index
//! on Windows, plus the birth time where the system keeps one, so a reused
//! inode number is not taken for the same directory).

use std::fs::Metadata;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// What a path is, as far as a job's tree goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    /// A FIFO, socket, device or (on Windows) a junction: never sent.
    Other,
}

/// A path's state at one moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub kind: EntryKind,
    pub size: u64,
    /// Nanoseconds since the Unix epoch.
    pub mtime_ns: i128,
    /// The change time (see the module), nanoseconds since the Unix epoch.
    pub change_ns: i128,
    /// Device (or volume), inode (or file index) and birth time.
    pub ident: (u64, u64, i128),
    /// Unix permission bits; 0 on Windows.
    pub mode: u32,
    /// A symbolic link's target as the system has it.
    pub target: Option<String>,
}

impl Stamp {
    /// Reads `path`'s stamp without following a final symbolic link.
    pub fn read(path: &Path) -> io::Result<Stamp> {
        let meta = std::fs::symlink_metadata(path)?;
        Stamp::from_meta(path, &meta)
    }

    /// The stamp of `path`, whose `symlink_metadata` is `meta`.
    pub fn from_meta(path: &Path, meta: &Metadata) -> io::Result<Stamp> {
        let kind = kind_of(meta);
        let target = if kind == EntryKind::Symlink {
            let target = std::fs::read_link(path)?;
            Some(target.to_str().map(str::to_owned).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "the symbolic link {} points at a name that is not UTF-8",
                        path.display()
                    ),
                )
            })?)
        } else {
            None
        };
        let mtime_ns = meta.modified().map(nanos).unwrap_or(0);
        let born = meta.created().map(nanos).unwrap_or(0);
        let (change_ns, dev, ino, mode) = system_parts(path, meta, mtime_ns);
        Ok(Stamp {
            kind,
            size: if kind == EntryKind::File {
                meta.len()
            } else {
                0
            },
            mtime_ns,
            change_ns,
            ident: (dev, ino, born),
            mode,
            target,
        })
    }

    /// Whether a file or link with this stamp differs from `old` in a way
    /// that means it must be sent again. Directories compare by mode only.
    pub fn content_differs(&self, old: &Stamp) -> bool {
        match self.kind {
            EntryKind::File => {
                self.size != old.size
                    || self.mtime_ns != old.mtime_ns
                    || self.change_ns != old.change_ns
                    || self.mode != old.mode
            }
            EntryKind::Symlink => self.target != old.target,
            EntryKind::Dir => self.mode != old.mode,
            EntryKind::Other => false,
        }
    }
}

/// Nanoseconds since the Unix epoch, negative before it.
pub fn nanos(time: SystemTime) -> i128 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    }
}

pub fn kind_of(meta: &Metadata) -> EntryKind {
    let ft = meta.file_type();
    if ft.is_symlink() {
        return EntryKind::Symlink;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        // A junction or another reparse point that is not a link: following
        // one can loop (`C:\Users\All Users`), and a job cannot make one
        // with the paths it is given.
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return EntryKind::Other;
        }
    }
    if ft.is_dir() {
        EntryKind::Dir
    } else if ft.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

#[cfg(unix)]
fn system_parts(_path: &Path, meta: &Metadata, _mtime_ns: i128) -> (i128, u64, u64, u32) {
    use std::os::unix::fs::MetadataExt;
    let change = meta.ctime() as i128 * 1_000_000_000 + meta.ctime_nsec() as i128;
    (change, meta.dev(), meta.ino(), meta.mode() & 0o7777)
}

#[cfg(windows)]
fn system_parts(path: &Path, _meta: &Metadata, mtime_ns: i128) -> (i128, u64, u64, u32) {
    match windows::change_and_index(path) {
        Some((change, volume, index)) => (change, volume, index, 0),
        None => (mtime_ns, 0, 0, 0),
    }
}

#[cfg(not(any(unix, windows)))]
fn system_parts(_path: &Path, _meta: &Metadata, mtime_ns: i128) -> (i128, u64, u64, u32) {
    (mtime_ns, 0, 0, 0)
}

#[cfg(windows)]
mod windows {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    };

    /// 100 ns intervals from 1601-01-01 to 1970-01-01.
    const EPOCH_DIFFERENCE: i64 = 116_444_736_000_000_000;

    /// The change time (ns since the Unix epoch), volume serial and file
    /// index of `path`, without following a final link.
    pub fn change_and_index(path: &Path) -> Option<(i128, u64, u64)> {
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .ok()?;
        let handle = file.as_raw_handle() as HANDLE;
        // SAFETY: both structures are plain data, the handle is open for
        // the duration and the sizes passed are the structures' own.
        unsafe {
            let mut basic: FILE_BASIC_INFO = std::mem::zeroed();
            if GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            ) == 0
            {
                return None;
            }
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            if GetFileInformationByHandle(handle, &mut info) == 0 {
                return None;
            }
            let change = (basic.ChangeTime as i128 - EPOCH_DIFFERENCE as i128) * 100;
            let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
            Some((change, info.dwVolumeSerialNumber as u64, index))
        }
    }
}
