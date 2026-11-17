//! The job's files as tar archives, both ways, with their Unix modes.
//!
//! Paths inside an archive are the job's Unix paths relative to `/`, as
//! the agent expects ([`iwci_vm_proto`]). Going in, every entry carries
//! the mode the job's file system has for it (a checked-out script stays
//! executable); coming back, each entry's mode is read from its header
//! and kept when the machine has modes to give.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use iwci_vfs::{Entry, JobFs, Modes, Snapshot};

/// An entry and its mode, when known.
pub type Moded = (Entry, Option<u32>);

fn entry_path(entry: &Entry) -> &Path {
    match entry {
        Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => path,
    }
}

fn relative(path: &Path) -> &Path {
    path.strip_prefix("/").unwrap_or(path)
}

/// Writes `entries` as a tar archive, each under `prefix` (a Unix path,
/// `/` for none). Entries whose mode is unknown get `0o644` (files) or
/// `0o755` (directories); links always `0o777`.
pub fn write(w: impl Write, prefix: &str, entries: &[Moded]) -> io::Result<()> {
    let mut tar = tar::Builder::new(w);
    tar.mode(tar::HeaderMode::Deterministic);
    let prefix = Path::new(prefix);
    for (entry, mode) in entries {
        let path = prefix.join(relative(entry_path(entry)));
        let name = relative(&path);
        if name.as_os_str().is_empty() {
            continue;
        }
        let mut header = tar::Header::new_gnu();
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        match entry {
            Entry::Dir { .. } => {
                header.set_entry_type(tar::EntryType::Directory);
                header.set_mode(mode.unwrap_or(0o755) & 0o7777);
                header.set_size(0);
                tar.append_data(&mut header, name, io::empty())?;
            }
            Entry::File { data, .. } => {
                header.set_entry_type(tar::EntryType::Regular);
                header.set_mode(mode.unwrap_or(0o644) & 0o7777);
                header.set_size(data.len() as u64);
                tar.append_data(&mut header, name, &data[..])?;
            }
            Entry::Symlink { target, .. } => {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_mode(0o777);
                header.set_size(0);
                tar.append_link(&mut header, name, target)?;
            }
        }
    }
    tar.into_inner()?.flush()
}

/// What a job's own layer holds (what it starts with on top of the
/// workspace image), with modes.
pub fn own(fs: &JobFs) -> Vec<Moded> {
    with_modes(fs.own_entries(), &fs.modes())
}

/// Everything the job sees, snapshot included, with modes: what a machine
/// without the workspace image (Windows) is given.
pub fn whole(fs: &JobFs) -> Vec<Moded> {
    with_modes(fs.entries_under(&["/"]), &fs.modes())
}

fn with_modes(entries: Vec<Entry>, modes: &Modes) -> Vec<Moded> {
    entries
        .into_iter()
        .map(|e| {
            let mode = modes.get(entry_path(&e));
            (e, mode)
        })
        .collect()
}

/// Every directory, file and link of a frozen workspace, parents first,
/// with modes: the workspace image's contents.
pub fn snapshot(snapshot: &Snapshot) -> Vec<Moded> {
    let fs = snapshot.read_only();
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from("/")];
    while let Some(dir) = stack.pop() {
        let Ok(children) = fs.read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = children.flatten().map(|e| e.path).collect();
        children.sort();
        for path in children.into_iter().rev() {
            let Ok(meta) = fs.symlink_metadata(&path) else {
                continue;
            };
            let mode = snapshot.mode(&path);
            let ft = meta.file_type();
            if ft.is_symlink() {
                if let Ok(target) = fs.readlink(&path) {
                    out.push((Entry::Symlink { path, target }, None));
                }
            } else if ft.is_dir() {
                stack.push(path.clone());
                out.push((Entry::Dir { path }, mode));
            } else if let Ok(bytes) = snapshot.read(&path) {
                out.push((
                    Entry::File {
                        path,
                        data: bytes.into(),
                    },
                    mode,
                ));
            }
        }
    }
    out.sort_by_key(|(e, _)| entry_path(e).components().count());
    out
}

/// Reads a tar archive a machine sent: entries back at their Unix paths,
/// each with its mode. At most `limit` bytes of file content; a path that
/// is not clean, a hard link, a device or anything else is refused.
pub fn read(r: impl Read, limit: u64) -> Result<Vec<Moded>, String> {
    let mut archive = tar::Archive::new(r);
    let mut out = Vec::new();
    let mut total = 0u64;
    let entries = archive
        .entries()
        .map_err(|e| format!("not a tar archive: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("not a tar archive: {e}"))?;
        let raw = entry
            .path()
            .map_err(|e| format!("an entry's path: {e}"))?
            .into_owned();
        let text = raw.to_string_lossy();
        let unix = format!("/{}", text.trim_end_matches('/'));
        if unix == "/" {
            continue;
        }
        if !iwci_vm_proto::is_clean_path(&unix) {
            return Err(format!("`{text}` is not a clean path"));
        }
        let path = PathBuf::from(&unix);
        let mode = entry.header().mode().ok();
        match entry.header().entry_type() {
            tar::EntryType::Directory => out.push((Entry::Dir { path }, mode)),
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                let size = entry.header().size().unwrap_or(0);
                total = total.saturating_add(size);
                if total > limit {
                    return Err(format!(
                        "what the job left is over {} MiB",
                        limit.div_ceil(1 << 20)
                    ));
                }
                let mut data = Vec::with_capacity(size.min(64 << 20) as usize);
                entry
                    .read_to_end(&mut data)
                    .map_err(|e| format!("`{unix}`: {e}"))?;
                out.push((
                    Entry::File {
                        path,
                        data: data.into(),
                    },
                    mode,
                ));
            }
            tar::EntryType::Symlink => {
                let target = entry
                    .link_name()
                    .map_err(|e| format!("`{unix}`: {e}"))?
                    .ok_or_else(|| format!("`{unix}` links nowhere"))?
                    .into_owned();
                out.push((Entry::Symlink { path, target }, None));
            }
            other => {
                return Err(format!(
                    "`{unix}` is a {other:?}, not a file, directory or link"
                ));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_modes_and_a_prefix() {
        let entries = vec![
            (
                Entry::Dir {
                    path: "/app".into(),
                },
                Some(0o755),
            ),
            (
                Entry::File {
                    path: "/app/run.sh".into(),
                    data: b"#!/bin/sh\n".to_vec().into(),
                },
                Some(0o100755),
            ),
            (
                Entry::File {
                    path: "/app/a.txt".into(),
                    data: b"a".to_vec().into(),
                },
                None,
            ),
            (
                Entry::Symlink {
                    path: "/app/link".into(),
                    target: "a.txt".into(),
                },
                None,
            ),
        ];
        let mut tar = Vec::new();
        write(&mut tar, "/tmp/workflow", &entries).unwrap();
        let back = read(tar.as_slice(), 1 << 20).unwrap();
        let shown: Vec<(String, Option<u32>)> = back
            .iter()
            .map(|(e, m)| (entry_path(e).display().to_string(), *m))
            .collect();
        assert_eq!(
            shown,
            [
                ("/tmp/workflow/app".to_string(), Some(0o755)),
                ("/tmp/workflow/app/run.sh".to_string(), Some(0o755)),
                ("/tmp/workflow/app/a.txt".to_string(), Some(0o644)),
                ("/tmp/workflow/app/link".to_string(), None),
            ]
        );
    }

    #[test]
    fn refuses_what_is_too_big_or_not_a_plain_path() {
        let big = vec![(
            Entry::File {
                path: "/a".into(),
                data: vec![0u8; 2048].into(),
            },
            None,
        )];
        let mut tar = Vec::new();
        write(&mut tar, "/", &big).unwrap();
        assert!(read(tar.as_slice(), 1024).unwrap_err().contains("over"));

        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Link);
        header.set_size(0);
        builder
            .append_link(&mut header, "hard", "/etc/passwd")
            .unwrap();
        let tar = builder.into_inner().unwrap();
        assert!(read(tar.as_slice(), 1024).unwrap_err().contains("Link"));
    }

    #[test]
    fn a_snapshot_is_listed_parents_first_with_modes() {
        let b = iwci_vfs::SnapshotBuilder::new();
        b.write("/app/bin/run", b"x").unwrap();
        b.set_mode("/app/bin/run", 0o755).unwrap();
        b.symlink("/app/latest", "bin/run").unwrap();
        let listed: Vec<String> = snapshot(&b.freeze())
            .iter()
            .map(|(e, m)| match e {
                Entry::Dir { path } => format!("d {}", path.display()),
                Entry::File { path, .. } => format!("f {} {:o}", path.display(), m.unwrap_or(0)),
                Entry::Symlink { path, target } => {
                    format!("l {} {}", path.display(), target.display())
                }
            })
            .collect();
        // Parents before children; within a depth, as the walk met them.
        assert_eq!(
            listed,
            [
                "d /app",
                "l /app/latest bin/run",
                "d /app/bin",
                "f /app/bin/run 755"
            ]
        );
    }
}
