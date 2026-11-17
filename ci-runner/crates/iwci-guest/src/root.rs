//! Where a job's Unix paths live on this machine.

use std::path::{Path, PathBuf};

use iwci_vm_proto::{is_under, unix_path, windows_path};

/// Maps a job's Unix paths (`/app/x`) onto the machine's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Root {
    /// Below a directory: `/app/x` is `<dir>/app/x` (`/` itself on Linux).
    Dir(PathBuf),
    /// The Windows system drive: `/app/x` is `C:\app\x` ([`windows_path`]).
    SystemDrive,
}

impl Root {
    /// The machine's path for the job's (clean) Unix path `unix`.
    pub fn native(&self, unix: &str) -> PathBuf {
        match self {
            Root::SystemDrive => PathBuf::from(windows_path(unix)),
            Root::Dir(dir) => {
                let mut path = dir.clone();
                for part in unix.split('/').filter(|p| !p.is_empty()) {
                    path.push(part);
                }
                path
            }
        }
    }

    /// A symbolic link's target as the archive has it (Unix form) turned
    /// into what to write on this machine.
    pub fn link_target_to_native(&self, target: &str) -> String {
        if cfg!(windows) {
            if target.starts_with('/') {
                self.native(target).to_string_lossy().into_owned()
            } else {
                target.replace('/', "\\")
            }
        } else if target.starts_with('/') {
            match self {
                // On a machine's own root the job's paths are the real ones.
                Root::Dir(dir) if dir == Path::new("/") => target.to_owned(),
                _ => self.native(target).to_string_lossy().into_owned(),
            }
        } else {
            target.to_owned()
        }
    }

    /// The reverse of [`Root::link_target_to_native`]: a link's target read
    /// from this machine, in the Unix form the runner keeps.
    pub fn link_target_to_unix(&self, native: &str) -> String {
        if cfg!(windows) {
            let absolute =
                native.len() >= 2 && native.as_bytes()[1] == b':' || native.starts_with('\\');
            if !absolute {
                return native.replace('\\', "/");
            }
            match self {
                Root::SystemDrive => unix_path(native).unwrap_or_else(|| native.replace('\\', "/")),
                Root::Dir(dir) => {
                    strip_dir(dir, Path::new(native)).unwrap_or_else(|| native.replace('\\', "/"))
                }
            }
        } else {
            match self {
                Root::Dir(dir) if dir != Path::new("/") && native.starts_with('/') => {
                    strip_dir(dir, Path::new(native)).unwrap_or_else(|| native.to_owned())
                }
                _ => native.to_owned(),
            }
        }
    }
}

fn strip_dir(dir: &Path, path: &Path) -> Option<String> {
    let rest = path.strip_prefix(dir).ok()?;
    let mut unix = String::new();
    for part in rest.components() {
        unix.push('/');
        unix.push_str(part.as_os_str().to_str()?);
    }
    Some(if unix.is_empty() { "/".into() } else { unix })
}

/// Whether `path` is one of `prefixes` or below one.
pub fn under_any(path: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| is_under(path, p))
}

/// `/a/b/c` as `["/a", "/a/b"]`: the ancestors below `/`, top first.
pub fn ancestors(unix: &str) -> Vec<&str> {
    unix.match_indices('/')
        .skip(1)
        .map(|(i, _)| &unix[..i])
        .collect()
}

/// `parent` joined with one more name.
pub fn join(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_map_under_a_directory() {
        let root = Root::Dir(PathBuf::from("/tmp/r"));
        assert_eq!(root.native("/app/x"), PathBuf::from("/tmp/r/app/x"));
        assert_eq!(root.native("/"), PathBuf::from("/tmp/r"));
        assert_eq!(ancestors("/a/b/c"), vec!["/a", "/a/b"]);
        assert!(ancestors("/a").is_empty());
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/a", "b"), "/a/b");
    }

    #[cfg(unix)]
    #[test]
    fn link_targets_round_trip_under_a_directory() {
        let root = Root::Dir(PathBuf::from("/tmp/r"));
        assert_eq!(root.link_target_to_native("/usr/lib"), "/tmp/r/usr/lib");
        assert_eq!(root.link_target_to_unix("/tmp/r/usr/lib"), "/usr/lib");
        assert_eq!(root.link_target_to_native("../x"), "../x");
        let real = Root::Dir(PathBuf::from("/"));
        assert_eq!(real.link_target_to_native("/usr/lib"), "/usr/lib");
        assert_eq!(real.link_target_to_unix("/usr/lib"), "/usr/lib");
    }
}
