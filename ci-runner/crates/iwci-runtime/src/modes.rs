//! File modes for environment jobs (#959).
//!
//! The job's file systems keep modes (`iwci_vfs::modes`), but nothing in
//! WASIX carries one: `filestat` has no mode field, and wasix-libc's
//! `chmod` does nothing and its `stat` fills in only the file type. So the
//! runner gives jobs a way around the C library instead:
//!
//! - [`ModeControl`], mounted at [`MODES_DIR`], answers for any path in the
//!   job: reading `stat/<path>` or `lstat/<path>` gives its type, mode, size
//!   and times, and writing an octal mode to `mode/<path>` sets it. `<path>`
//!   is the absolute path with `%` written `%25` and `/` written `%2F`, so it
//!   is one file name whatever the target is.
//! - `chmod`, `stat` and `mktemp`, shell scripts in `modes/` that work
//!   through those files, on the default `PATH` ahead of coreutils (whose
//!   build has no `chmod` or `stat`, and whose `mktemp` cannot give its file
//!   mode `0600`).
//!
//! A program that calls `chmod(2)` or `stat(2)` itself, Node's `fs`
//! included, still sees no modes; that takes the C library.

use std::io::{self, Cursor, Seek};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use iwci_vfs::Modes;
use iwci_vfs::modes::EXECUTABLE_MODE;
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use virtual_fs::{
    DirEntry, FileSystem, FileType, FsError, Metadata, OpenOptionsConfig, ReadDir, VirtualFile,
};

/// Where [`ModeControl`] is mounted.
pub(crate) const MODES_DIR: &str = "/proc/iwci";

/// The commands, written to `/usr/local/bin`.
pub(crate) const MODE_COMMANDS: &[(&str, &[u8])] = &[
    ("chmod", include_bytes!("../modes/chmod")),
    ("stat", include_bytes!("../modes/stat")),
    ("mktemp", include_bytes!("../modes/mktemp")),
];

/// Directories whose files are commands, `0755` unless given another mode.
pub(crate) const COMMAND_DIRS: &[&str] = &["/bin", "/usr/bin", "/usr/local/bin"];

type DynFs = Arc<dyn FileSystem + Send + Sync>;

/// The three views [`ModeControl`] serves, one directory each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum View {
    /// `stat(2)`: symlinks followed.
    Stat,
    /// `lstat(2)`: a symlink is described as itself.
    Lstat,
    /// Write an octal mode to set it (symlinks followed, as `chmod` does);
    /// read to get it.
    Mode,
}

impl View {
    const ALL: [(&'static str, View); 3] = [
        ("stat", View::Stat),
        ("lstat", View::Lstat),
        ("mode", View::Mode),
    ];

    fn named(name: &str) -> Option<View> {
        Self::ALL.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
    }
}

/// The file system at [`MODES_DIR`]. See the module comment.
#[derive(Debug)]
pub(crate) struct ModeControl {
    /// The job's file system as the job sees it, without this mount.
    view: DynFs,
    modes: Modes,
}

impl ModeControl {
    pub(crate) fn new(view: DynFs, modes: Modes) -> Self {
        Self { view, modes }
    }

    /// Which view and which target path `path` (relative to the mount)
    /// names, if it names a file.
    fn target(path: &Path) -> Option<(View, PathBuf)> {
        let mut parts = path.components().filter(|c| *c != Component::RootDir);
        let view = match parts.next()? {
            Component::Normal(name) => View::named(name.to_str()?)?,
            _ => return None,
        };
        let name = match parts.next()? {
            Component::Normal(name) => name.to_str()?,
            _ => return None,
        };
        if parts.next().is_some() {
            return None;
        }
        Some((view, decode(name)?))
    }

    fn is_dir(path: &Path) -> bool {
        let mut parts = path.components().filter(|c| *c != Component::RootDir);
        match (parts.next(), parts.next()) {
            (None, _) => true,
            (Some(Component::Normal(name)), None) => name.to_str().and_then(View::named).is_some(),
            _ => false,
        }
    }

    /// What reading `view` for `target` gives.
    fn describe(&self, view: View, target: &Path) -> String {
        let follow = view != View::Lstat;
        let Some(described) = describe(self.view.as_ref(), &self.modes, target, follow) else {
            return "missing\n".into();
        };
        if view == View::Mode {
            return format!("{:o}\n", described.mode & iwci_vfs::modes::MODE_BITS);
        }
        let mut line = format!(
            "{} {:o} {} {} {} {}\n",
            described.kind,
            described.mode,
            described.meta.len,
            described.meta.accessed,
            described.meta.modified,
            described.meta.created,
        );
        if let Some(link) = described.link {
            line.push_str(&link.to_string_lossy());
            line.push('\n');
        }
        line
    }
}

/// A path as one file name: `%` as `%25`, `/` as `%2F`.
#[cfg(test)]
fn encode(path: &str) -> String {
    path.replace('%', "%25").replace('/', "%2F")
}

/// The path [`encode`] made `name` from, made absolute and lexically
/// normal (`.` and `..` resolved; `..` stops at the root).
fn decode(name: &str) -> Option<PathBuf> {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let text = String::from_utf8(out).ok()?;
    if !text.starts_with('/') || text.contains('\0') {
        return None;
    }
    let mut path = PathBuf::from("/");
    for part in Path::new(&text).components() {
        match part {
            Component::Normal(part) => path.push(part),
            Component::ParentDir => {
                path.pop();
            }
            _ => {}
        }
    }
    Some(path)
}

/// What a job sees of a path.
struct Described {
    /// `stat -c %F`'s letter: `f`, `d`, `l`, `c`, `b`, `p` or `s`.
    kind: char,
    /// Type bits and permission bits, as `st_mode`.
    mode: u32,
    meta: Metadata,
    link: Option<PathBuf>,
}

fn describe(
    fs: &(dyn FileSystem + Send + Sync),
    modes: &Modes,
    path: &Path,
    follow: bool,
) -> Option<Described> {
    let (meta, perm) = iwci_vfs::modes::mode_of(fs, modes, path, follow)?;
    let ft = meta.file_type();
    let (kind, bits) = if ft.is_symlink() {
        ('l', 0o120_000)
    } else if ft.is_dir() {
        ('d', 0o040_000)
    } else if ft.is_char_device() {
        ('c', 0o020_000)
    } else if ft.is_block_device() {
        ('b', 0o060_000)
    } else if ft.fifo {
        ('p', 0o010_000)
    } else if ft.is_socket() {
        ('s', 0o140_000)
    } else {
        ('f', 0o100_000)
    };
    let link = (kind == 'l').then(|| fs.readlink(path).ok()).flatten();
    // A command nobody gave a mode is executable.
    let resolved = if follow {
        iwci_vfs::resolve(fs, path).ok()
    } else {
        Some(path.to_path_buf())
    };
    let perm = match resolved {
        Some(p)
            if kind == 'f'
                && modes.get(&p).is_none()
                && p.parent()
                    .is_some_and(|d| COMMAND_DIRS.iter().any(|c| d == Path::new(c))) =>
        {
            EXECUTABLE_MODE
        }
        _ => perm,
    };
    Some(Described {
        kind,
        mode: bits | perm,
        meta,
        link,
    })
}

pub(crate) fn dir_meta() -> Metadata {
    Metadata {
        ft: FileType::new_dir(),
        ..Default::default()
    }
}

pub(crate) fn file_meta() -> Metadata {
    Metadata {
        ft: FileType::new_file(),
        ..Default::default()
    }
}

impl FileSystem for ModeControl {
    fn readlink(&self, _: &Path) -> virtual_fs::Result<PathBuf> {
        Err(FsError::InvalidInput)
    }
    fn read_dir(&self, path: &Path) -> virtual_fs::Result<ReadDir> {
        if path.components().all(|c| c == Component::RootDir) {
            let entries = View::ALL
                .iter()
                .map(|(name, _)| DirEntry {
                    path: Path::new("/").join(name),
                    metadata: Ok(dir_meta()),
                })
                .collect();
            return Ok(ReadDir::new(entries));
        }
        if Self::is_dir(path) {
            return Ok(ReadDir::new(Vec::new()));
        }
        Err(FsError::EntryNotFound)
    }
    fn create_dir(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn create_symlink(&self, _: &Path, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn hard_link(&self, _: &Path, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn remove_dir(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn rename<'a>(
        &'a self,
        _: &'a Path,
        _: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        Box::pin(async { Err(FsError::PermissionDenied) })
    }
    fn metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        if Self::is_dir(path) {
            Ok(dir_meta())
        } else if Self::target(path).is_some() {
            Ok(file_meta())
        } else {
            Err(FsError::EntryNotFound)
        }
    }
    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        self.metadata(path)
    }
    fn remove_file(&self, _: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

impl virtual_fs::FileOpener for ModeControl {
    fn open(
        &self,
        path: &Path,
        conf: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        let Some((view, target)) = Self::target(path) else {
            return Err(if Self::is_dir(path) {
                FsError::NotAFile
            } else {
                FsError::EntryNotFound
            });
        };
        let writes = conf.write || conf.append;
        if writes && view != View::Mode {
            return Err(FsError::PermissionDenied);
        }
        let setter = writes.then(|| Setter {
            fs: self.view.clone(),
            modes: self.modes.clone(),
            target: target.clone(),
            written: Vec::new(),
        });
        let content = if conf.truncate {
            String::new()
        } else {
            self.describe(view, &target)
        };
        Ok(Box::new(ControlFile {
            data: Cursor::new(content.into_bytes()),
            setter,
        }))
    }
}

/// Where a write to `mode/<path>` goes.
#[derive(Debug)]
struct Setter {
    fs: DynFs,
    modes: Modes,
    target: PathBuf,
    written: Vec<u8>,
}

impl Setter {
    /// Applies what has been written so far: an octal mode, optionally
    /// followed by a newline.
    fn write(&mut self, buf: &[u8]) -> io::Result<()> {
        self.written.extend_from_slice(buf);
        let text = std::str::from_utf8(&self.written)
            .ok()
            .map(str::trim)
            .filter(|t| !t.is_empty() && t.len() <= 6);
        let mode = text
            .and_then(|t| u32::from_str_radix(t, 8).ok())
            .filter(|m| *m <= iwci_vfs::modes::MODE_BITS)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not an octal mode"))?;
        let resolved = iwci_vfs::resolve(self.fs.as_ref(), &self.target)
            .ok()
            .filter(|p| self.fs.metadata(p).is_ok())
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        self.modes.set(&resolved, mode);
        Ok(())
    }
}

/// An open file of [`ModeControl`]: what it described when it was opened,
/// and for `mode/` a [`Setter`]. `services.rs` serves its files with it too.
#[derive(Debug)]
pub(crate) struct ControlFile {
    data: Cursor<Vec<u8>>,
    setter: Option<Setter>,
}

impl ControlFile {
    /// A file that reads `content` and refuses writes.
    pub(crate) fn read_only(content: String) -> Self {
        Self {
            data: Cursor::new(content.into_bytes()),
            setter: None,
        }
    }
}

impl AsyncRead for ControlFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.data).poll_read(cx, buf)
    }
}

impl AsyncWrite for ControlFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let Some(setter) = self.setter.as_mut() else {
            return Poll::Ready(Err(io::ErrorKind::PermissionDenied.into()));
        };
        Poll::Ready(setter.write(buf).map(|()| buf.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for ControlFile {
    fn start_seek(mut self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        Pin::new(&mut self.data).start_seek(position)
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Pin::new(&mut self.data).poll_complete(cx)
    }
}

impl VirtualFile for ControlFile {
    fn last_accessed(&self) -> u64 {
        0
    }
    fn last_modified(&self) -> u64 {
        0
    }
    fn created_time(&self) -> u64 {
        0
    }
    fn size(&self) -> u64 {
        self.data.get_ref().len() as u64
    }
    fn set_len(&mut self, _: u64) -> virtual_fs::Result<()> {
        Ok(())
    }
    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
    fn poll_read_ready(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let at = self.data.stream_position().unwrap_or_default() as usize;
        Poll::Ready(Ok(self.data.get_ref().len().saturating_sub(at)))
    }
    fn poll_write_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(4096))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;
    use virtual_fs::{AsyncReadExt, AsyncWriteExt};

    fn control() -> (ModeControl, iwci_vfs::JobFs) {
        let builder = iwci_vfs::SnapshotBuilder::new();
        builder.write("/app/run.sh", b"#!/bin/sh\n").unwrap();
        builder.write("/app/data.txt", b"12345").unwrap();
        builder.set_mode("/app/run.sh", 0o755).unwrap();
        let job = builder.freeze().fork();
        iwci_vfs::symlink(job.as_dyn().as_ref(), "/app/link", "run.sh").unwrap();
        (ModeControl::new(job.as_dyn(), job.modes()), job)
    }

    fn read(fs: &ModeControl, path: &str) -> String {
        let mut file = fs
            .new_open_options()
            .read(true)
            .open(Path::new(path))
            .unwrap();
        let mut out = String::new();
        block_on(file.read_to_string(&mut out)).unwrap();
        out
    }

    fn write(fs: &ModeControl, path: &str, text: &str) -> io::Result<()> {
        let mut file = fs
            .new_open_options()
            .write(true)
            .truncate(true)
            .create(true)
            .open(Path::new(path))
            .map_err(io::Error::from)?;
        block_on(file.write_all(text.as_bytes()))
    }

    #[test]
    fn paths_are_one_name_and_cannot_be_relative() {
        let name = encode("/app/a%2Fb/c");
        assert_eq!(name, "%2Fapp%2Fa%252Fb%2Fc");
        assert_eq!(decode(&name), Some(PathBuf::from("/app/a%2Fb/c")));
        assert_eq!(decode("%2Fa%2F..%2F..%2Fb"), Some(PathBuf::from("/b")));
        assert_eq!(decode("app"), None);
        assert_eq!(decode("%2Fa%2"), None);
        assert_eq!(decode("%2Fa%00"), None);
    }

    #[test]
    fn it_describes_files_with_their_modes_and_sets_them() {
        let (fs, job) = control();
        assert!(fs.metadata(Path::new("/stat")).unwrap().is_dir());
        let run = format!("/stat/{}", encode("/app/run.sh"));
        assert!(fs.metadata(Path::new(&run)).unwrap().is_file());

        let line = read(&fs, &run);
        assert!(line.starts_with("f 100755 10 "), "{line}");
        let line = read(&fs, &format!("/stat/{}", encode("/app/data.txt")));
        assert!(line.starts_with("f 100644 5 "), "{line}");
        let line = read(&fs, &format!("/stat/{}", encode("/app")));
        assert!(line.starts_with("d 40755 "), "{line}");
        assert_eq!(
            read(&fs, &format!("/stat/{}", encode("/app/nope"))),
            "missing\n"
        );

        // A symlink: followed by stat, described by lstat.
        let line = read(&fs, &format!("/stat/{}", encode("/app/link")));
        assert!(line.starts_with("f 100755 "), "{line}");
        let line = read(&fs, &format!("/lstat/{}", encode("/app/link")));
        assert!(line.starts_with("l 120777 "), "{line}");
        assert!(line.ends_with("\nrun.sh\n"), "{line}");

        // chmod 600 through the link sets the target's mode.
        write(&fs, &format!("/mode/{}", encode("/app/link")), "600\n").unwrap();
        assert_eq!(job.modes().get(Path::new("/app/run.sh")), Some(0o600));
        assert_eq!(
            read(&fs, &format!("/mode/{}", encode("/app/run.sh"))),
            "600\n"
        );

        // Nonsense and missing targets are refused; describing is read-only.
        assert!(write(&fs, &format!("/mode/{}", encode("/app/data.txt")), "rw").is_err());
        assert!(write(&fs, &format!("/mode/{}", encode("/app/data.txt")), "17777").is_err());
        assert!(write(&fs, &format!("/mode/{}", encode("/app/nope")), "644").is_err());
        assert!(write(&fs, &run, "644").is_err());
        assert_eq!(job.modes().get(Path::new("/app/data.txt")), None);
    }
}
