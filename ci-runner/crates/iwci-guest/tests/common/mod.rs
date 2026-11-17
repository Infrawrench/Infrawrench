//! A runner's end of the conversation, over pipes to `serve` in a thread.

#![allow(dead_code)]

use std::io::{self, PipeReader, PipeWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;

use iwci_guest::{Ended, Manifest, Platform, Root, serve};
use iwci_vm_proto::{
    Collect, DataReader, DataWriter, Done, Exec, Exited, GuestMsg, Hello, HostMsg, Kind, Shell,
    read_frame, receive, send,
};

/// A directory under the system's temporary one, removed when dropped.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "iwci-guest-{name}-{}-{}-{nanos}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // The real path, so paths the scripts print compare equal.
        TempDir(dir.canonicalize().unwrap())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            // Directories a test made read-only would stop the removal.
            let _ = std::process::Command::new("chmod")
                .args(["-R", "u+rwx"])
                .arg(&self.0)
                .status();
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Host {
    pub to_guest: PipeWriter,
    pub from_guest: PipeReader,
    pub hello: Hello,
    thread: Option<JoinHandle<io::Result<Ended>>>,
}

impl Host {
    /// Starts `serve` with a manifest tree rooted at `root`.
    pub fn start(root: &Path, platform: Arc<dyn Platform>) -> Host {
        let (guest_in, to_guest) = io::pipe().unwrap();
        let (mut from_guest, guest_out) = io::pipe().unwrap();
        let root = root.to_owned();
        let thread = std::thread::spawn(move || {
            let mut tree = Manifest::new(Root::Dir(root));
            serve(guest_in, guest_out, &*platform, &mut tree)
        });
        let hello = match receive(&mut from_guest).unwrap() {
            GuestMsg::Hello(hello) => hello,
            other => panic!("expected hello, got {other:?}"),
        };
        Host {
            to_guest,
            from_guest,
            hello,
            thread: Some(thread),
        }
    }

    pub fn send(&mut self, msg: &HostMsg) {
        send(&mut self.to_guest, msg).unwrap();
    }

    pub fn receive(&mut self) -> GuestMsg {
        receive(&mut self.from_guest).unwrap()
    }

    pub fn put(&mut self, archive: &[u8]) -> GuestMsg {
        self.send(&HostMsg::Put);
        let mut data = DataWriter::new(&mut self.to_guest);
        data.write_all(archive).unwrap();
        data.finish().unwrap();
        self.receive()
    }

    pub fn put_ok(&mut self, archive: &[u8]) -> Done {
        match self.put(archive) {
            GuestMsg::Done(done) => done,
            other => panic!("expected done, got {other:?}"),
        }
    }

    /// A collect: the deleted paths, the archive's entries and `Done`, or
    /// the error message.
    pub fn collect(
        &mut self,
        paths: &[&str],
        max_bytes: u64,
    ) -> Result<(Vec<String>, Vec<Entry>, Done), String> {
        self.collect_in(None, paths, max_bytes)
    }

    /// A collect of a repository, without what git ignores in it, and of
    /// `paths`.
    pub fn collect_in(
        &mut self,
        repository: Option<&str>,
        paths: &[&str],
        max_bytes: u64,
    ) -> Result<(Vec<String>, Vec<Entry>, Done), String> {
        self.send(&HostMsg::Collect(Collect {
            paths: paths.iter().map(|p| p.to_string()).collect(),
            repository: repository.map(str::to_owned),
            max_bytes,
        }));
        let deleted = match self.receive() {
            GuestMsg::Collected(c) => c.deleted,
            GuestMsg::Error { message } => return Err(message),
            other => panic!("expected collected, got {other:?}"),
        };
        let mut archive = Vec::new();
        DataReader::new(&mut self.from_guest)
            .read_to_end(&mut archive)
            .unwrap();
        let entries = entries(&archive);
        match self.receive() {
            GuestMsg::Done(done) => Ok((deleted, entries, done)),
            GuestMsg::Error { message } => Err(message),
            other => panic!("expected done, got {other:?}"),
        }
    }

    /// Runs a script: stdout, stderr, and how it ended or the error.
    pub fn exec(
        &mut self,
        shell: Shell,
        script: &str,
        env: &[(&str, &str)],
        cwd: &str,
    ) -> (String, String, Result<Exited, String>) {
        self.send(&HostMsg::Exec(Exec {
            shell,
            script: script.into(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            cwd: cwd.into(),
        }));
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        loop {
            let (kind, payload) = read_frame(&mut self.from_guest).unwrap().unwrap();
            match kind {
                Kind::Stdout => stdout.extend(payload),
                Kind::Stderr => stderr.extend(payload),
                Kind::Message => {
                    let result = match iwci_vm_proto::decode(&payload).unwrap() {
                        GuestMsg::Exited(exited) => Ok(exited),
                        GuestMsg::Error { message } => Err(message),
                        other => panic!("expected exited, got {other:?}"),
                    };
                    return (
                        String::from_utf8(stdout).unwrap(),
                        String::from_utf8(stderr).unwrap(),
                        result,
                    );
                }
                other => panic!("unexpected {other:?} frame"),
            }
        }
    }

    /// Ends the stream and returns how `serve` ended.
    pub fn close(mut self) -> io::Result<Ended> {
        let thread = self.thread.take().unwrap();
        drop(self);
        thread.join().unwrap()
    }

    /// Asks for shutdown and returns how `serve` ended.
    pub fn shutdown(mut self) -> Ended {
        self.send(&HostMsg::Shutdown);
        self.thread.take().unwrap().join().unwrap().unwrap()
    }
}

/// One entry of a collected archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub kind: char,
    pub mode: u32,
    pub data: Vec<u8>,
    pub link: Option<String>,
}

pub fn entries(archive: &[u8]) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut ar = tar::Archive::new(archive);
    for entry in ar.entries().unwrap() {
        let mut entry = entry.unwrap();
        let header = entry.header().clone();
        let kind = match header.entry_type() {
            tar::EntryType::Regular => 'f',
            tar::EntryType::Directory => 'd',
            tar::EntryType::Symlink => 'l',
            other => panic!("unexpected entry type {other:?}"),
        };
        let path = String::from_utf8(entry.path_bytes().into_owned()).unwrap();
        let link = entry
            .link_name_bytes()
            .map(|l| String::from_utf8(l.into_owned()).unwrap());
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        out.push(Entry {
            path: path.trim_end_matches('/').to_owned(),
            kind,
            mode: header.mode().unwrap(),
            data,
            link,
        });
    }
    out
}

/// Builds tar archives the way the runner would.
pub struct Archive(tar::Builder<Vec<u8>>);

pub const OLD_MTIME: u64 = 1_600_000_000;

impl Archive {
    pub fn new() -> Archive {
        Archive(tar::Builder::new(Vec::new()))
    }

    pub fn file(mut self, path: &str, content: &[u8], mode: u32) -> Archive {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Regular);
        h.set_size(content.len() as u64);
        h.set_mode(mode);
        h.set_mtime(OLD_MTIME);
        self.0.append_data(&mut h, path, content).unwrap();
        self
    }

    pub fn dir(mut self, path: &str, mode: u32) -> Archive {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Directory);
        h.set_size(0);
        h.set_mode(mode);
        h.set_mtime(OLD_MTIME);
        self.0.append_data(&mut h, path, io::empty()).unwrap();
        self
    }

    pub fn symlink(mut self, path: &str, target: &str) -> Archive {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        h.set_mode(0o777);
        self.0.append_link(&mut h, path, target).unwrap();
        self
    }

    /// An entry whose name is written as is, bypassing the builder's own
    /// checks, so the agent's can be tested.
    pub fn raw(mut self, name: &str, kind: tar::EntryType, link: Option<&str>) -> Archive {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(kind);
        h.set_size(0);
        h.set_mode(0o644);
        let gnu = h.as_gnu_mut().unwrap();
        gnu.name[..name.len()].copy_from_slice(name.as_bytes());
        if let Some(link) = link {
            gnu.linkname[..link.len()].copy_from_slice(link.as_bytes());
        }
        h.set_cksum();
        self.0.append(&h, io::empty()).unwrap();
        self
    }

    pub fn build(self) -> Vec<u8> {
        self.0.into_inner().unwrap()
    }
}
