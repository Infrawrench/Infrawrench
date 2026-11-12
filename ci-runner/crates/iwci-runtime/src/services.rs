//! Waiting for a job's background services.
//!
//! A job starts a service the way a shell script does (`server > log &`),
//! on its own loopback (network.rs), and then has to wait until it is
//! ready before using it. Environments get two commands for that, scripts
//! in `services/` on the default `PATH` beside the mode commands:
//!
//! - `wait-for-log FILE PATTERN`: until a line of the file matches.
//! - `wait-for-port PORT`: until something in the job listens on the port,
//!   which it reads from [`PortControl`], mounted at [`PORTS_DIR`]: reading
//!   `<address>` (`127.0.0.1:5432`, `[::1]:5432`) gives `listening` when a
//!   connection to it would reach a listener, and `closed` otherwise.
//!
//! The job's loopback is in memory and every listener in it is registered
//! with [`JobNetwork`](crate::network::JobNetwork), so a listener is exactly
//! a port a connection would be accepted on, and nobody has to connect to
//! find out. That matters for services that take one client at a time and
//! stop when it leaves: `wasmer/pglite` exits once its first connection
//! closes, so a probe that connected would end the service it waited for.
//! bash's own `/dev/tcp` could not have done the probe anyway: the connect
//! is made, then moving the socket to the descriptor asked for fails.

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};

use virtual_fs::{
    DirEntry, FileSystem, FsError, Metadata, OpenOptionsConfig, ReadDir, VirtualFile,
};

use crate::modes::{ControlFile, dir_meta, file_meta};
use crate::network::Listeners;

/// Where [`PortControl`] is mounted.
pub(crate) const PORTS_DIR: &str = "/proc/iwci/tcp";

/// The commands, written to `/usr/local/bin`.
pub(crate) const SERVICE_COMMANDS: &[(&str, &[u8])] = &[
    ("wait-for-port", include_bytes!("../services/wait-for-port")),
    ("wait-for-log", include_bytes!("../services/wait-for-log")),
];

/// The file system at [`PORTS_DIR`]. See the module comment.
#[derive(Debug)]
pub(crate) struct PortControl {
    listeners: Listeners,
}

impl PortControl {
    pub(crate) fn new(listeners: Listeners) -> Self {
        Self { listeners }
    }

    /// The address `path` names, if it names a file.
    fn target(path: &Path) -> Option<SocketAddr> {
        let mut parts = path.components().filter(|c| *c != Component::RootDir);
        let name = match parts.next()? {
            Component::Normal(name) => name.to_str()?,
            _ => return None,
        };
        if parts.next().is_some() {
            return None;
        }
        name.parse().ok()
    }

    fn is_root(path: &Path) -> bool {
        path.components().all(|c| c == Component::RootDir)
    }

    fn describe(&self, addr: SocketAddr) -> String {
        if self.listeners.reaches(addr) {
            "listening\n".into()
        } else {
            "closed\n".into()
        }
    }
}

impl FileSystem for PortControl {
    fn readlink(&self, _: &Path) -> virtual_fs::Result<PathBuf> {
        Err(FsError::InvalidInput)
    }
    fn read_dir(&self, path: &Path) -> virtual_fs::Result<ReadDir> {
        if !Self::is_root(path) {
            return Err(FsError::EntryNotFound);
        }
        // What is listening now; any other address can be read as well.
        let entries = self
            .listeners
            .addrs()
            .into_iter()
            .map(|addr| DirEntry {
                path: Path::new("/").join(addr.to_string()),
                metadata: Ok(file_meta()),
            })
            .collect();
        Ok(ReadDir::new(entries))
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
        if Self::is_root(path) {
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

impl virtual_fs::FileOpener for PortControl {
    fn open(
        &self,
        path: &Path,
        conf: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        let Some(addr) = Self::target(path) else {
            return Err(if Self::is_root(path) {
                FsError::NotAFile
            } else {
                FsError::EntryNotFound
            });
        };
        if conf.write || conf.append || conf.truncate {
            return Err(FsError::PermissionDenied);
        }
        Ok(Box::new(ControlFile::read_only(self.describe(addr))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::JobNetwork;
    use futures::executor::block_on;
    use virtual_fs::AsyncReadExt;
    use wasmer_wasix::virtual_net::{VirtualNetworking, VirtualTcpListener};

    fn read(fs: &PortControl, path: &str) -> String {
        let mut file = fs
            .new_open_options()
            .read(true)
            .open(Path::new(path))
            .unwrap();
        let mut out = String::new();
        block_on(file.read_to_string(&mut out)).unwrap();
        out
    }

    fn listen(net: &JobNetwork, addr: &str) -> Box<dyn VirtualTcpListener + Sync> {
        block_on(net.listen_tcp(addr.parse().unwrap(), false, false, false)).unwrap()
    }

    #[test]
    fn it_says_whether_a_connection_would_reach_a_listener() {
        let net = JobNetwork::new(None);
        let fs = PortControl::new(net.listeners());
        assert_eq!(read(&fs, "/127.0.0.1:5432"), "closed\n");

        let listener = listen(&net, "127.0.0.1:5432");
        assert_eq!(read(&fs, "/127.0.0.1:5432"), "listening\n");
        assert_eq!(read(&fs, "/127.0.0.1:5433"), "closed\n");
        assert_eq!(read(&fs, "/[::1]:5432"), "closed\n");
        // Only the job's own loopback: never another address, the
        // unspecified one included (a connect there is not to the loopback).
        assert_eq!(read(&fs, "/10.0.0.1:5432"), "closed\n");
        assert_eq!(read(&fs, "/0.0.0.0:5432"), "closed\n");
        let names: Vec<_> = fs
            .read_dir(Path::new("/"))
            .unwrap()
            .map(|e| e.unwrap().path)
            .collect();
        assert_eq!(names, vec![PathBuf::from("/127.0.0.1:5432")]);

        // A listener that closes is gone.
        drop(listener);
        assert_eq!(read(&fs, "/127.0.0.1:5432"), "closed\n");

        // Every interface is the loopback, and a dual-stack `::` takes the
        // IPv4 loopback too, as a connect would route them.
        let _all = listen(&net, "0.0.0.0:8080");
        assert_eq!(read(&fs, "/127.0.0.1:8080"), "listening\n");
        let _dual = listen(&net, "[::]:9090");
        assert_eq!(read(&fs, "/[::1]:9090"), "listening\n");
        assert_eq!(read(&fs, "/127.0.0.1:9090"), "listening\n");
    }

    #[test]
    fn its_files_are_addresses_and_read_only() {
        let fs = PortControl::new(JobNetwork::new(None).listeners());
        assert!(fs.metadata(Path::new("/")).unwrap().is_dir());
        assert!(fs.metadata(Path::new("/127.0.0.1:1")).unwrap().is_file());
        assert!(fs.metadata(Path::new("/localhost:1")).is_err());
        assert!(fs.metadata(Path::new("/127.0.0.1")).is_err());
        assert!(fs.metadata(Path::new("/127.0.0.1:1/x")).is_err());
        assert!(
            fs.new_open_options()
                .write(true)
                .open(Path::new("/127.0.0.1:1"))
                .is_err()
        );
    }
}
