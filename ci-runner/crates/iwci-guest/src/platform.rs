//! What the agent does to the machine itself, behind a trait so tests (and
//! `serve-stdio` on a developer's computer) do none of it.

use iwci_vm_proto::Setup;

/// The machine-wide effects of the conversation.
pub trait Platform: Send + Sync {
    /// The machine image's name for [`Hello::image`](iwci_vm_proto::Hello),
    /// or empty.
    fn image(&self) -> String {
        String::new()
    }

    /// Applies [`Setup`]: the clock, the host name, the network. Returns
    /// the job paths it wrote, so a collect does not take them for the
    /// job's.
    fn setup(&self, setup: &Setup) -> Result<Vec<String>, String>;

    /// Called once, after the first `Ready` is sent.
    fn ready(&self) {}

    /// Whether each script runs in a cgroup of its own.
    fn job_cgroups(&self) -> bool {
        false
    }

    /// Whether it can mount a virtio-fs device.
    fn virtiofs(&self) -> bool {
        false
    }

    /// Mounts the virtio-fs device `tag` at `at` (the run's
    /// `/tmp/workflow`, served by the runner).
    fn mount_scratch(&self, _tag: &str, _at: &std::path::Path) -> Result<(), String> {
        Err("this machine cannot mount a virtio-fs device".into())
    }
}

/// No effects at all: tests and `serve-stdio`.
#[derive(Debug, Default)]
pub struct Local;

impl Platform for Local {
    fn setup(&self, _setup: &Setup) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

#[cfg(any(target_os = "linux", windows))]
fn read_image(path: &str) -> String {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

/// The Linux machine the init started (see `main.rs`).
#[cfg(target_os = "linux")]
#[derive(Debug, Default)]
pub struct LinuxMachine;

#[cfg(target_os = "linux")]
impl LinuxMachine {
    fn write_etc(path: &str, text: &str) -> Result<(), String> {
        // `/etc/resolv.conf` is often a link into `/run`, which is empty
        // here: replace the link rather than write through it.
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            let _ = std::fs::remove_file(path);
        }
        std::fs::write(path, text).map_err(|e| format!("writing {path}: {e}"))
    }
}

#[cfg(target_os = "linux")]
impl Platform for LinuxMachine {
    fn image(&self) -> String {
        read_image("/etc/iwci-image")
    }

    fn setup(&self, setup: &Setup) -> Result<Vec<String>, String> {
        let time = libc::timespec {
            tv_sec: (setup.time_ms / 1000) as _,
            tv_nsec: ((setup.time_ms % 1000) * 1_000_000) as _,
        };
        // SAFETY: a plain system call on a value that lives through it.
        if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &time) } != 0 {
            return Err(format!(
                "setting the clock: {}",
                std::io::Error::last_os_error()
            ));
        }
        let name = setup.hostname.as_bytes();
        // SAFETY: the pointer and length describe `name`.
        if unsafe { libc::sethostname(name.as_ptr().cast(), name.len()) } != 0 {
            return Err(format!(
                "setting the host name: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut written = vec!["/etc/hostname".to_owned(), "/etc/hosts".to_owned()];
        Self::write_etc("/etc/hostname", &format!("{}\n", setup.hostname))?;
        Self::write_etc(
            "/etc/hosts",
            &format!("127.0.0.1\tlocalhost {0}\n::1\tlocalhost\n", setup.hostname),
        )?;
        if let Some(network) = &setup.network {
            let text: String = network
                .dns
                .iter()
                .map(|server| format!("nameserver {server}\n"))
                .collect();
            Self::write_etc("/etc/resolv.conf", &text)?;
            written.push("/etc/resolv.conf".to_owned());
        }
        let _ = std::process::Command::new("ip")
            .args(["link", "set", "lo", "up"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        Ok(written)
    }

    fn ready(&self) {
        use std::os::unix::process::CommandExt;
        if !std::path::Path::new("/usr/bin/dockerd").exists() {
            return;
        }
        // The image's `iwci-dockerd` puts Docker's storage on the scratch
        // disk (or a tmpfs) before it starts the daemon. Started bare, the
        // daemon kept its storage on the overlay the job's root is, where
        // the kernel refuses the whiteouts every image layer has, so no
        // `docker run` could pull an image; and `iwci-dockerd`, finding it
        // running, left it so.
        let wrapper = "/usr/local/bin/iwci-dockerd";
        if std::path::Path::new(wrapper).exists() {
            // It logs the daemon itself, and waits for it; nothing waits
            // for the wrapper.
            let _ = std::process::Command::new(wrapper)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .process_group(0)
                .spawn();
            return;
        }
        let Ok(log) = std::fs::File::create("/var/log/dockerd.log") else {
            return;
        };
        let Ok(log2) = log.try_clone() else { return };
        // Outside any job's cgroup and process group, so it outlives each
        // script; nothing waits for it.
        let _ = std::process::Command::new("/usr/bin/dockerd")
            .stdin(std::process::Stdio::null())
            .stdout(log)
            .stderr(log2)
            .process_group(0)
            .spawn();
    }

    fn job_cgroups(&self) -> bool {
        true
    }

    fn virtiofs(&self) -> bool {
        std::fs::read_to_string("/proc/filesystems").is_ok_and(|text| {
            text.lines()
                .any(|l| l.split_whitespace().last() == Some("virtiofs"))
        })
    }

    fn mount_scratch(&self, tag: &str, at: &std::path::Path) -> Result<(), String> {
        use std::os::unix::ffi::OsStrExt;
        std::fs::create_dir_all(at).map_err(|e| format!("making {}: {e}", at.display()))?;
        let source = std::ffi::CString::new(tag).map_err(|_| "a tag with a NUL in it")?;
        let target = std::ffi::CString::new(at.as_os_str().as_bytes())
            .map_err(|_| "a path with a NUL in it")?;
        let kind = c"virtiofs";
        // SAFETY: every pointer is a NUL-terminated string that lives
        // through the call, and no data is passed.
        let done = unsafe {
            libc::mount(
                source.as_ptr(),
                target.as_ptr(),
                kind.as_ptr(),
                libc::MS_NOSUID | libc::MS_NODEV,
                std::ptr::null(),
            )
        };
        if done != 0 {
            return Err(format!(
                "mounting {tag} at {}: {}",
                at.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

/// The Windows machine.
#[cfg(windows)]
#[derive(Debug, Default)]
pub struct WindowsMachine;

#[cfg(windows)]
impl Platform for WindowsMachine {
    fn image(&self) -> String {
        read_image("C:\\iwci\\image")
    }

    fn setup(&self, setup: &Setup) -> Result<Vec<String>, String> {
        // The image keeps the network configured statically, and a new
        // host name would need a restart: only the clock changes.
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Set-Date -Date ([DateTimeOffset]::FromUnixTimeMilliseconds({}).LocalDateTime)",
                    setup.time_ms
                ),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        Ok(Vec::new())
    }
}
