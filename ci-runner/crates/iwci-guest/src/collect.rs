//! Sending a [`Plan`]'s entries as a tar archive.

use std::fs::File;
use std::io::{self, Read, Write};

use iwci_vm_proto::Done;
use tar::{EntryType, Header};

use crate::plan::Item;
use crate::root::Root;
use crate::stamp::EntryKind;

/// Why sending stopped.
pub enum EmitError {
    /// Writing to the runner failed: the conversation is over.
    Stream(io::Error),
    /// Reading the machine's files failed: the request fails.
    Files(String),
}

/// A writer that remembers whether it failed, so a failure inside the tar
/// builder can be told apart from one reading a file.
struct Watched<'a, W: Write + ?Sized> {
    inner: &'a mut W,
    failed: Option<io::Error>,
}

impl<W: Write + ?Sized> Write for Watched<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf).inspect_err(|e| {
            self.failed = Some(io::Error::new(e.kind(), e.to_string()));
        })
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush().inspect_err(|e| {
            self.failed = Some(io::Error::new(e.kind(), e.to_string()));
        })
    }
}

/// Reads exactly `left` bytes, failing if the file ends sooner.
struct Exact<R> {
    inner: R,
    left: u64,
    name: String,
}

impl<R: Read> Read for Exact<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.left == 0 {
            return Ok(0);
        }
        let want = buf.len().min(self.left.min(usize::MAX as u64) as usize);
        let n = self.inner.read(&mut buf[..want])?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("{} got shorter while it was being sent", self.name),
            ));
        }
        self.left -= n as u64;
        Ok(n)
    }
}

/// Writes `items` as a tar archive to `out`, stopping before a file whose
/// content would take the total past `max_bytes`. `modes` says whether the
/// entries' Unix modes are real; without them files go as 0644 and
/// directories as 0755. `root` turns link targets back into Unix form.
pub fn emit(
    items: &[Item],
    max_bytes: u64,
    modes: bool,
    root: &Root,
    out: &mut dyn Write,
) -> Result<Done, EmitError> {
    let mut watched = Watched {
        inner: out,
        failed: None,
    };
    let mut done = Done::default();
    let result = write_all(items, max_bytes, modes, root, &mut watched, &mut done);
    if let Some(e) = watched.failed.take() {
        return Err(EmitError::Stream(e));
    }
    result.map(|()| done)
}

fn write_all<W: Write + ?Sized>(
    items: &[Item],
    max_bytes: u64,
    modes: bool,
    root: &Root,
    out: &mut Watched<'_, W>,
    done: &mut Done,
) -> Result<(), EmitError> {
    let mut builder = tar::Builder::new(&mut *out);
    let mut failure = None;
    for item in items {
        let path = item.unix.trim_start_matches('/');
        let stamp = &item.stamp;
        let mut header = Header::new_gnu();
        header.set_mtime(u64::try_from(stamp.mtime_ns / 1_000_000_000).unwrap_or(0));
        header.set_uid(0);
        header.set_gid(0);
        let result = match stamp.kind {
            EntryKind::Dir => {
                header.set_entry_type(EntryType::Directory);
                header.set_mode(if modes { stamp.mode } else { 0o755 });
                header.set_size(0);
                builder.append_data(&mut header, path, io::empty())
            }
            EntryKind::Symlink => {
                header.set_entry_type(EntryType::Symlink);
                header.set_mode(0o777);
                header.set_size(0);
                let target = root.link_target_to_unix(stamp.target.as_deref().unwrap_or(""));
                builder.append_link(&mut header, path, target)
            }
            EntryKind::File => {
                let file = match File::open(&item.native) {
                    Ok(file) => file,
                    Err(e) => {
                        failure = Some(format!("reading {}: {e}", item.unix));
                        break;
                    }
                };
                // The size now, which a job's leftover writer may have
                // changed since the walk.
                let size = match file.metadata() {
                    Ok(meta) => meta.len(),
                    Err(e) => {
                        failure = Some(format!("reading {}: {e}", item.unix));
                        break;
                    }
                };
                if done.bytes.saturating_add(size) > max_bytes {
                    done.truncated = true;
                    break;
                }
                header.set_entry_type(EntryType::Regular);
                header.set_mode(if modes { stamp.mode } else { 0o644 });
                header.set_size(size);
                let data = Exact {
                    inner: file,
                    left: size,
                    name: item.unix.clone(),
                };
                let result = builder.append_data(&mut header, path, data);
                if result.is_ok() {
                    done.bytes += size;
                }
                result
            }
            EntryKind::Other => continue,
        };
        if let Err(e) = result {
            failure = Some(format!("sending {}: {e}", item.unix));
            break;
        }
        done.entries += 1;
    }
    let finished = builder.into_inner();
    if let Some(message) = failure {
        return Err(EmitError::Files(message));
    }
    finished
        .map(|_| ())
        .map_err(|e| EmitError::Files(format!("ending the archive: {e}")))
}
