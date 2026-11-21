//! Writing a [`HostMsg::Put`](iwci_vm_proto::HostMsg::Put) archive into the
//! machine.
//!
//! Entries are named relative to `/`. Anything that is not a clean path
//! once `/` is put in front ([`is_clean_path`]), an absolute name, a hard
//! link, a device or a FIFO is refused, and so is writing through a symbolic
//! link the archive (or the machine) has where a directory should be.
//!
//! Every file gets the archive's modification time, so a later write by the
//! job, which stamps the time it happens, never looks unchanged.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use iwci_vm_proto::is_clean_path;
use tar::EntryType;

use crate::root::{Root, ancestors, under_any};

/// What [`extract`] wrote.
#[derive(Debug, Default)]
pub struct Extracted {
    /// Every Unix path written or created, parents included.
    pub written: BTreeSet<String>,
    /// Files, directories and links written.
    pub entries: u64,
    /// File content written, in bytes.
    pub bytes: u64,
    /// Symbolic links that could not be made (Windows without the
    /// privilege): left out rather than failing the job.
    pub skipped_links: u64,
}

fn refused(name: &str, why: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("the archive's entry {name:?} is refused: {why}"),
    )
}

/// Writes the tar archive `archive` under `root`. Paths under any of
/// `reserved` are refused.
pub fn extract(archive: &mut dyn Read, root: &Root, reserved: &[&str]) -> io::Result<Extracted> {
    let mut out = Extracted::default();
    let mut known_dirs: HashSet<String> = HashSet::new();
    let mut dir_modes: Vec<(String, u32)> = Vec::new();
    let mut archive = tar::Archive::new(archive);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() {
            continue;
        }
        let raw = entry.path_bytes().into_owned();
        let name = std::str::from_utf8(&raw)
            .map_err(|_| refused(&String::from_utf8_lossy(&raw), "the name is not UTF-8"))?;
        let trimmed = name.strip_suffix('/').unwrap_or(name);
        if trimmed.starts_with('/') {
            return Err(refused(name, "an absolute name"));
        }
        let unix = format!("/{trimmed}");
        if !is_clean_path(&unix) {
            return Err(refused(name, "not a clean path below /"));
        }
        if unix != "/" && under_any(&unix, reserved) {
            return Err(refused(name, "the agent's own files are there"));
        }
        match kind {
            EntryType::Regular | EntryType::Continuous => {
                ensure_parents(root, &unix, &mut known_dirs, &mut out)?;
                let path = root.native(&unix);
                make_room(&path, name)?;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(&path)
                    .map_err(|e| with_path(e, "writing", &path))?;
                let n = io::copy(&mut entry, &mut file)?;
                let mtime = entry.header().mtime().unwrap_or(0);
                file.set_modified(UNIX_EPOCH + Duration::from_secs(mtime))
                    .map_err(|e| with_path(e, "setting the time of", &path))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = entry.header().mode().unwrap_or(0o644) & 0o7777;
                    file.set_permissions(fs::Permissions::from_mode(mode))
                        .map_err(|e| with_path(e, "setting the mode of", &path))?;
                }
                out.bytes += n;
                out.entries += 1;
                out.written.insert(unix);
            }
            EntryType::Directory => {
                if unix == "/" {
                    continue;
                }
                ensure_parents(root, &unix, &mut known_dirs, &mut out)?;
                let path = root.native(&unix);
                match fs::symlink_metadata(&path) {
                    Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                    Ok(_) => {
                        return Err(refused(
                            name,
                            "something that is not a directory is in the way",
                        ));
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {
                        fs::create_dir(&path).map_err(|e| with_path(e, "making", &path))?
                    }
                    Err(e) => return Err(with_path(e, "reading", &path)),
                }
                known_dirs.insert(unix.clone());
                // Applied once everything is written, deepest first, so a
                // read-only directory still gets its contents.
                dir_modes.push((
                    unix.clone(),
                    entry.header().mode().unwrap_or(0o755) & 0o7777,
                ));
                out.entries += 1;
                out.written.insert(unix);
            }
            EntryType::Symlink => {
                let target = entry
                    .link_name_bytes()
                    .ok_or_else(|| refused(name, "a link with no target"))?;
                let target = std::str::from_utf8(&target)
                    .map_err(|_| refused(name, "the link's target is not UTF-8"))?
                    .to_owned();
                if unix == "/" {
                    return Err(refused(name, "a link in place of /"));
                }
                ensure_parents(root, &unix, &mut known_dirs, &mut out)?;
                let path = root.native(&unix);
                make_room(&path, name)?;
                let native_target = root.link_target_to_native(&target);
                match symlink(&native_target, &path) {
                    Ok(()) => {
                        out.entries += 1;
                        out.written.insert(unix);
                    }
                    Err(e) if cfg!(windows) => {
                        eprintln!("iwci-guest: left out the symbolic link {unix} -> {target}: {e}");
                        out.skipped_links += 1;
                    }
                    Err(e) => return Err(with_path(e, "linking", &path)),
                }
            }
            EntryType::Link => return Err(refused(name, "a hard link")),
            EntryType::Char | EntryType::Block => return Err(refused(name, "a device")),
            EntryType::Fifo => return Err(refused(name, "a FIFO")),
            other => return Err(refused(name, &format!("an entry of type {other:?}"))),
        }
    }
    #[cfg(unix)]
    for (unix, mode) in dir_modes.iter().rev() {
        use std::os::unix::fs::PermissionsExt;
        let path = root.native(unix);
        fs::set_permissions(&path, fs::Permissions::from_mode(*mode))
            .map_err(|e| with_path(e, "setting the mode of", &path))?;
    }
    #[cfg(not(unix))]
    let _ = dir_modes;
    Ok(out)
}

fn with_path(e: io::Error, doing: &str, path: &Path) -> io::Error {
    io::Error::new(e.kind(), format!("{doing} {}: {e}", path.display()))
}

/// Makes the directories above `unix` that are missing, refusing to go
/// through anything that is not a directory.
fn ensure_parents(
    root: &Root,
    unix: &str,
    known: &mut HashSet<String>,
    out: &mut Extracted,
) -> io::Result<()> {
    for dir in ancestors(unix) {
        if known.contains(dir) {
            continue;
        }
        let path = root.native(dir);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(refused(unix, &format!("{dir} is a symbolic link")));
            }
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(refused(unix, &format!("{dir} is not a directory"))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&path).map_err(|e| with_path(e, "making", &path))?;
                out.written.insert(dir.to_owned());
            }
            Err(e) => return Err(with_path(e, "reading", &path)),
        }
        known.insert(dir.to_owned());
    }
    Ok(())
}

/// Removes a file or link at `path` so something else can be written
/// there. A directory in the way is refused.
fn make_room(path: &Path, name: &str) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            // A Windows link to a directory is removed as a directory.
            fs::remove_file(path).or_else(|_| fs::remove_dir(path))
        }
        Ok(meta) if meta.is_dir() => Err(refused(name, "a directory is in the way")),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(with_path(e, "reading", path)),
    }
}

#[cfg(unix)]
fn symlink(target: &str, path: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

#[cfg(windows)]
fn symlink(target: &str, path: &Path) -> io::Result<()> {
    let resolved = match path.parent() {
        Some(parent) => parent.join(target),
        None => Path::new(target).to_path_buf(),
    };
    if fs::metadata(&resolved).map(|m| m.is_dir()).unwrap_or(false) {
        std::os::windows::fs::symlink_dir(target, path)
    } else {
        std::os::windows::fs::symlink_file(target, path)
    }
}

#[cfg(not(any(unix, windows)))]
fn symlink(_target: &str, _path: &Path) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}
