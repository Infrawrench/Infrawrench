//! The machine images a runner has, and the workspace images it makes.
//!
//! `--machines <dir>` holds one directory per kind of machine, as
//! `ci-runner/images/` builds them:
//!
//! ```text
//! <dir>/linux/image.json      {"os":"linux","image":"ubuntu-24.04","arch":"x86_64",...}
//! <dir>/linux/vmlinux         the kernel (`Image` on aarch64)
//! <dir>/linux/rootfs.erofs    the root file system, read only
//! <dir>/windows/image.json    {"os":"windows","image":"windows-11-arm","arch":"aarch64","states":[...]}
//! <dir>/windows/disk.qcow2    the installed system, never written to
//! <dir>/windows/efi-code.fd   UEFI, read only
//! <dir>/windows/efi-vars.fd   UEFI's variables, copied per machine
//! <dir>/windows/<state>.mig   states saved just after boot, per size
//! ```
//!
//! A workspace image is the workspace's files (the clone) as an erofs
//! image, made once per commit and workspace and shared by every Linux
//! machine of it: the machine reads it as a lower layer, so a job starts
//! with the whole checkout without a byte of it being copied, and what
//! the job writes goes to its own upper layer.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// `image.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageInfo {
    pub os: String,
    pub image: String,
    pub arch: String,
    #[serde(default)]
    pub version: String,
    /// What its agent can do beyond the first images' (`files-virtiofs`).
    /// An older image lists none.
    #[serde(default)]
    pub features: Vec<String>,
    /// Windows: the versioned machine type the states were saved with
    /// (`virt-8.2,gic-version=host`): `virt` alone moves with QEMU
    /// upgrades, and a state restores only into the type it was saved on.
    #[serde(default)]
    pub machine: Option<String>,
    /// Windows: states saved just after boot, one per size.
    #[serde(default)]
    pub states: Vec<SavedState>,
    /// Directories whose additions a job keeps between runs, as an
    /// isolate environment's `caches` (the versions nvm and rbenv
    /// install). Checked by [`check_caches`].
    #[serde(default)]
    pub caches: Vec<ImageCache>,
}

/// One of an image's caches.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageCache {
    /// What `env-cache:` and the report call it.
    pub name: String,
    /// An absolute directory in the machine.
    pub path: String,
    /// The most a saved cache holds, in bytes of file content.
    #[serde(rename = "max-bytes")]
    pub max_bytes: u64,
}

/// How many directories a machine image may keep between runs. The Linux
/// image declares the three version managers, two package-manager stores,
/// two JVM repositories and uv's two directories.
pub const MAX_IMAGE_CACHES: usize = 10;

/// The limits an environment's caches have, [`MAX_IMAGE_CACHES`] of them,
/// names `[a-z0-9][a-z0-9_-]*`, absolute paths none inside another, and
/// `max-bytes` between 1 MiB and 4 GiB.
pub fn check_caches(caches: &[ImageCache]) -> Result<(), String> {
    if caches.len() > MAX_IMAGE_CACHES {
        return Err(format!(
            "{} caches, more than {MAX_IMAGE_CACHES}",
            caches.len()
        ));
    }
    for (n, cache) in caches.iter().enumerate() {
        let name_ok = cache
            .name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && cache
                .name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
        if !name_ok {
            return Err(format!(
                "cache name `{}` is not [a-z0-9][a-z0-9_-]*",
                cache.name
            ));
        }
        let path_ok = cache.path.starts_with('/')
            && cache.path.len() > 1
            && !cache.path.ends_with('/')
            && !cache
                .path
                .split('/')
                .any(|part| part == "." || part == "..");
        if !path_ok {
            return Err(format!(
                "cache `{}`: `{}` is not an absolute directory",
                cache.name, cache.path
            ));
        }
        if !(1 << 20..=4 << 30).contains(&cache.max_bytes) {
            return Err(format!(
                "cache `{}`: max-bytes is not between 1 MiB and 4 GiB",
                cache.name
            ));
        }
        for other in &caches[..n] {
            let inside = |a: &str, b: &str| a == b || a.starts_with(&format!("{b}/"));
            if other.name == cache.name {
                return Err(format!("two caches are called `{}`", cache.name));
            }
            if inside(&cache.path, &other.path) || inside(&other.path, &cache.path) {
                return Err(format!(
                    "caches `{}` and `{}` overlap",
                    other.name, cache.name
                ));
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct SavedState {
    pub memory_mib: u64,
    pub cpus: u32,
    /// The saved machine (`file:` migration).
    pub file: String,
    /// What that boot wrote to the disk, an overlay on `disk.qcow2`: the
    /// saved memory remembers those writes, so a restored machine's own
    /// overlay goes on this, never on `disk.qcow2` itself.
    pub disk: String,
}

/// A saved state to restore, and the disk it goes with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restore {
    pub state: PathBuf,
    pub disk: PathBuf,
}

fn read_info(dir: &Path, os: &str, arch: &str) -> Result<ImageInfo, String> {
    let path = dir.join("image.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let info: ImageInfo =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    if info.os != os {
        return Err(format!(
            "{} is a {} image, not {os}",
            path.display(),
            info.os
        ));
    }
    if info.arch != arch {
        return Err(format!(
            "{} is for {}, and this host is {arch}: a machine runs the host's own architecture",
            path.display(),
            info.arch
        ));
    }
    Ok(info)
}

fn need(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("{} is missing", path.display()))
    }
}

/// A Linux image.
#[derive(Debug, Clone)]
pub struct LinuxImage {
    pub info: ImageInfo,
    pub kernel: PathBuf,
    pub rootfs: PathBuf,
}

impl LinuxImage {
    pub fn open(dir: &Path, arch: &str) -> Result<LinuxImage, String> {
        let info = read_info(dir, "linux", arch)?;
        check_caches(&info.caches)
            .map_err(|e| format!("{}: {e}", dir.join("image.json").display()))?;
        let kernel = if arch == "aarch64" {
            "Image"
        } else {
            "vmlinux"
        };
        Ok(LinuxImage {
            kernel: need(dir.join(kernel))?,
            rootfs: need(dir.join("rootfs.erofs"))?,
            info,
        })
    }
}

/// A Windows image.
#[derive(Debug, Clone)]
pub struct WindowsImage {
    pub info: ImageInfo,
    pub dir: PathBuf,
    pub disk: PathBuf,
    pub firmware: PathBuf,
    pub vars: PathBuf,
}

impl WindowsImage {
    pub fn open(dir: &Path, arch: &str) -> Result<WindowsImage, String> {
        if arch != "aarch64" {
            return Err(
                "Windows machines are Windows 11 on Arm, which needs an aarch64 host (a Graviton `.metal` instance)"
                    .into(),
            );
        }
        let info = read_info(dir, "windows", arch)?;
        Ok(WindowsImage {
            disk: need(dir.join("disk.qcow2"))?,
            firmware: need(dir.join("efi-code.fd"))?,
            vars: need(dir.join("efi-vars.fd"))?,
            dir: dir.to_path_buf(),
            info,
        })
    }

    /// The saved state a machine of this size can be restored from, with
    /// its disk.
    pub fn state(&self, memory_mib: u64, cpus: u32) -> Option<Restore> {
        self.info
            .states
            .iter()
            .find(|s| s.memory_mib == memory_mib && s.cpus == cpus)
            .map(|s| Restore {
                state: self.dir.join(&s.file),
                disk: self.dir.join(&s.disk),
            })
            .filter(|r| r.state.is_file() && r.disk.is_file())
    }

    /// The machine type to start with: the one the states were saved on.
    pub fn machine(&self) -> &str {
        self.info
            .machine
            .as_deref()
            .unwrap_or("virt,gic-version=host")
    }
}

/// Workspace images, made with `mkfs.erofs` (erofs-utils 1.7 or later,
/// for `--tar`) and kept on disk, the least recently used dropped once
/// they pass `max_bytes`.
pub struct Workspaces {
    dir: PathBuf,
    mkfs: PathBuf,
    max_bytes: u64,
    /// One lock per image being made, so two machines of one workspace
    /// wait for one `mkfs.erofs` rather than run two.
    making: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Workspaces {
    pub fn new(dir: PathBuf, mkfs: PathBuf, max_bytes: u64) -> Workspaces {
        Workspaces {
            dir,
            mkfs,
            max_bytes,
            making: Mutex::default(),
        }
    }

    /// The image of `snapshot`, which `key` names, made if it is not on
    /// disk yet. `None` for a workspace with no files at all.
    pub fn image(
        &self,
        key: &str,
        snapshot: &iwci_vfs::Snapshot,
    ) -> Result<Option<PathBuf>, String> {
        let entries = crate::archive::snapshot(snapshot);
        if entries.is_empty() {
            return Ok(None);
        }
        let name = hex::encode(Sha256::digest(key.as_bytes()));
        let path = self.dir.join(format!("{name}.erofs"));
        let lock = self
            .making
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(name.clone())
            .or_default()
            .clone();
        let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
        if path.is_file() {
            // Used now: the last to be dropped.
            let _ = std::fs::File::options()
                .append(true)
                .open(&path)
                .and_then(|f| f.set_modified(std::time::SystemTime::now()));
            return Ok(Some(path));
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))?;
        let tar_path = self.dir.join(format!("{name}.tar.part"));
        let image_part = self.dir.join(format!("{name}.erofs.part"));
        let made = (|| {
            let file = std::fs::File::create(&tar_path)
                .map_err(|e| format!("{}: {e}", tar_path.display()))?;
            let mut w = std::io::BufWriter::new(file);
            crate::archive::write(&mut w, "/", &entries).map_err(|e| e.to_string())?;
            w.flush().map_err(|e| e.to_string())?;
            drop(w);
            // Owners and times are fixed, so one commit's image is the
            // same bytes on every runner.
            let out = std::process::Command::new(&self.mkfs)
                .arg("--tar=f")
                .arg("-T0")
                .arg("--all-root")
                .arg(&image_part)
                .arg(&tar_path)
                .output()
                .map_err(|e| format!("{}: {e}", self.mkfs.display()))?;
            if !out.status.success() {
                return Err(format!(
                    "mkfs.erofs failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            std::fs::rename(&image_part, &path).map_err(|e| e.to_string())
        })();
        let _ = std::fs::remove_file(&tar_path);
        if let Err(e) = made {
            let _ = std::fs::remove_file(&image_part);
            return Err(format!("the workspace's machine image: {e}"));
        }
        self.trim(&path);
        Ok(Some(path))
    }

    /// Drops the least recently used images past `max_bytes`, never
    /// `keep`. A machine using one keeps it open, so dropping it there
    /// takes nothing from that machine.
    fn trim(&self, keep: &Path) {
        let Ok(list) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut images: Vec<(std::time::SystemTime, u64, PathBuf)> = list
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "erofs"))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((meta.modified().ok()?, meta.len(), e.path()))
            })
            .collect();
        let mut total: u64 = images.iter().map(|i| i.1).sum();
        images.sort();
        for (_, size, path) in images {
            if total <= self.max_bytes {
                break;
            }
            if path != keep && std::fs::remove_file(&path).is_ok() {
                total -= size;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "iwci-vm-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_images_caches_are_read_and_checked() {
        let dir = temp("caches");
        std::fs::write(dir.join("vmlinux"), b"k").unwrap();
        std::fs::write(dir.join("rootfs.erofs"), b"r").unwrap();
        let write = |caches: &str| {
            std::fs::write(
                dir.join("image.json"),
                format!(
                    r#"{{"os":"linux","image":"ubuntu-24.04","arch":"x86_64","caches":[{caches}]}}"#
                ),
            )
            .unwrap();
        };
        write(
            r#"{"name":"nvm","path":"/root/.nvm/versions","max-bytes":1048576},{"name":"rbenv","path":"/root/.rbenv","max-bytes":4294967296}"#,
        );
        let image = LinuxImage::open(&dir, "x86_64").unwrap();
        assert_eq!(
            image.info.caches[0],
            ImageCache {
                name: "nvm".into(),
                path: "/root/.nvm/versions".into(),
                max_bytes: 1 << 20,
            }
        );
        for (bad, why) in [
            (
                r#"{"name":"Nvm","path":"/a","max-bytes":1048576}"#,
                "is not [a-z0-9]",
            ),
            (
                r#"{"name":"a","path":"a","max-bytes":1048576}"#,
                "not an absolute",
            ),
            (
                r#"{"name":"a","path":"/a/../b","max-bytes":1048576}"#,
                "not an absolute",
            ),
            (r#"{"name":"a","path":"/a","max-bytes":1}"#, "between 1 MiB"),
            (
                r#"{"name":"a","path":"/a","max-bytes":1048576},{"name":"b","path":"/a/b","max-bytes":1048576}"#,
                "overlap",
            ),
            (
                r#"{"name":"a","path":"/a","max-bytes":1048576},{"name":"a","path":"/b","max-bytes":1048576}"#,
                "two caches",
            ),
        ] {
            write(bad);
            let e = LinuxImage::open(&dir, "x86_64").unwrap_err();
            assert!(e.contains(why), "{bad}: {e}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opens_a_linux_image_for_the_hosts_architecture_only() {
        let dir = temp("linux");
        std::fs::write(
            dir.join("image.json"),
            r#"{"os":"linux","image":"ubuntu-24.04","arch":"x86_64","version":"20261117"}"#,
        )
        .unwrap();
        assert!(
            LinuxImage::open(&dir, "x86_64")
                .unwrap_err()
                .contains("vmlinux is missing")
        );
        std::fs::write(dir.join("vmlinux"), b"k").unwrap();
        std::fs::write(dir.join("rootfs.erofs"), b"r").unwrap();
        let image = LinuxImage::open(&dir, "x86_64").unwrap();
        assert_eq!(image.info.image, "ubuntu-24.04");
        assert!(
            LinuxImage::open(&dir, "aarch64")
                .unwrap_err()
                .contains("is for x86_64")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_windows_image_restores_only_a_state_of_the_same_size() {
        let dir = temp("windows");
        std::fs::write(
            dir.join("image.json"),
            r#"{"os":"windows","image":"windows-11-arm","arch":"aarch64","machine":"virt-8.2,gic-version=host","states":[{"memory_mib":4096,"cpus":4,"file":"s.mig","disk":"s.qcow2","sha256":"00"}]}"#,
        )
        .unwrap();
        for f in [
            "disk.qcow2",
            "efi-code.fd",
            "efi-vars.fd",
            "s.mig",
            "s.qcow2",
        ] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        assert!(
            WindowsImage::open(&dir, "x86_64")
                .unwrap_err()
                .contains("aarch64 host")
        );
        let image = WindowsImage::open(&dir, "aarch64").unwrap();
        assert_eq!(image.machine(), "virt-8.2,gic-version=host");
        assert_eq!(
            image.state(4096, 4),
            Some(Restore {
                state: dir.join("s.mig"),
                disk: dir.join("s.qcow2"),
            })
        );
        assert_eq!(image.state(8192, 4), None);
        assert_eq!(image.state(4096, 2), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_empty_workspace_has_no_image() {
        let dir = temp("ws");
        let ws = Workspaces::new(dir.clone(), "/nonexistent/mkfs.erofs".into(), 1 << 30);
        let empty = iwci_vfs::SnapshotBuilder::new().freeze();
        assert_eq!(ws.image("k", &empty).unwrap(), None);
        let b = iwci_vfs::SnapshotBuilder::new();
        b.write("/app/a", b"a").unwrap();
        // With no mkfs.erofs the image cannot be made, and nothing is left.
        assert!(
            ws.image("k", &b.freeze())
                .unwrap_err()
                .contains("mkfs.erofs")
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
