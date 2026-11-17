//! The virtio-serial port the runner talks to the agent over
//! ([`AGENT_PORT`](iwci_vm_proto::AGENT_PORT)).
//!
//! The port is opened once and kept: on Windows only one handle to it may
//! be open, so the writer is a duplicate of the reader's handle, never a
//! second open. While no one is on the host's end a read fails (Windows)
//! or ends at once (Linux), and a write waits until someone is. So each
//! conversation starts with `Hello`, which waits for the runner, and reads
//! that fail before the runner's first byte are retried rather than taken
//! for the end; a failure after it ends the conversation and the next one
//! begins with `Hello` again.

use std::fs::File;
use std::io::{self, Read};
use std::time::Duration;

use crate::{Ended, Platform, Tree, serve};

/// How long to wait before trying a port with no one on the other end
/// again.
const RETRY: Duration = Duration::from_millis(200);

/// A reader that waits out a port with no one on the other end until the
/// first byte of a conversation arrives.
pub struct Patient<R> {
    inner: R,
    started: bool,
}

impl<R: Read> Patient<R> {
    pub fn new(inner: R) -> Patient<R> {
        Patient {
            inner,
            started: false,
        }
    }
}

impl<R: Read> Read for Patient<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            match self.inner.read(buf) {
                Ok(0) if !self.started => std::thread::sleep(RETRY),
                Err(e) if !self.started && e.kind() != io::ErrorKind::Interrupted => {
                    std::thread::sleep(RETRY)
                }
                Ok(n) => {
                    self.started = n > 0 || self.started;
                    return Ok(n);
                }
                Err(e) => return Err(e),
            }
        }
    }
}

/// Serves conversation after conversation over `port` until one asks the
/// machine to power off.
pub fn serve_port(port: File, platform: &dyn Platform, tree: &mut dyn Tree) -> io::Result<()> {
    loop {
        let writer = port.try_clone()?;
        match serve(Patient::new(&port), writer, platform, tree) {
            Ok(Ended::Shutdown) => return Ok(()),
            Ok(Ended::Closed) => {}
            Err(e) => eprintln!("iwci-guest: the conversation ended: {e}"),
        }
        std::thread::sleep(RETRY);
    }
}

/// Opens the Linux machine's agent port: the virtio port whose name is
/// [`AGENT_PORT`](iwci_vm_proto::AGENT_PORT), trying for up to ten seconds
/// while the driver comes up.
#[cfg(target_os = "linux")]
pub fn open_linux() -> io::Result<File> {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(device) = find_linux_port() {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&device)
            {
                Ok(file) => return Ok(file),
                Err(e) if std::time::Instant::now() >= deadline => return Err(e),
                Err(_) => {}
            }
        } else if std::time::Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("no virtio port is named {}", iwci_vm_proto::AGENT_PORT),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(target_os = "linux")]
fn find_linux_port() -> Option<std::path::PathBuf> {
    for entry in std::fs::read_dir("/sys/class/virtio-ports").ok()?.flatten() {
        let name = std::fs::read_to_string(entry.path().join("name")).unwrap_or_default();
        if name.trim() == iwci_vm_proto::AGENT_PORT {
            return Some(std::path::Path::new("/dev").join(entry.file_name()));
        }
    }
    None
}

/// Opens the Windows machine's agent port, trying every half second until
/// the driver has it (the scheduled task starts the agent at boot).
#[cfg(windows)]
pub fn open_windows() -> File {
    let name = format!("\\\\.\\Global\\{}", iwci_vm_proto::AGENT_PORT);
    loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&name)
        {
            Ok(file) => return file,
            Err(_) => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Flaky {
        script: Vec<io::Result<Vec<u8>>>,
    }

    impl Read for Flaky {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.script.is_empty() {
                return Ok(0);
            }
            match self.script.remove(0) {
                Ok(bytes) => {
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
                Err(e) => Err(e),
            }
        }
    }

    #[test]
    fn waits_for_the_first_byte_then_passes_failures_on() {
        let mut r = Patient::new(Flaky {
            script: vec![
                Err(io::ErrorKind::BrokenPipe.into()),
                Ok(vec![]),
                Ok(vec![7]),
                Err(io::ErrorKind::BrokenPipe.into()),
            ],
        });
        let mut buf = [0u8; 4];
        assert_eq!(r.read(&mut buf).unwrap(), 1);
        assert_eq!(buf[0], 7);
        assert!(r.read(&mut buf).is_err());
        assert_eq!(r.read(&mut buf).unwrap(), 0);
    }
}
