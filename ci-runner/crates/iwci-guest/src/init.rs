//! The Linux machine's init: builds the job's root, starts the agent in it
//! and powers the machine off when the agent is done.
//!
//! The machine image is read-only and has the directories this needs:
//! `/.iwci/rw`, `/.iwci/ws`, `/.iwci/base` and `/.iwci/root`. The job's
//! root is an overlay file system on `/.iwci/root`:
//!
//! - upper: `/.iwci/rw/upper` on a tmpfs, so it holds exactly what changed;
//! - lower: the workspace image (the disk whose serial is `iwci-ws`, erofs,
//!   on `/.iwci/ws`) when the machine has one, over the machine image
//!   itself (`/` bound on `/.iwci/base`).
//!
//! Inside the new root `/.iwci/rw` is bound back in, so the agent can walk
//! the upper directory, and the two lower layers are bound read-only on
//! `/.iwci/ws` and `/.iwci/base`, so it can tell what a path was before
//! the job. Collects never look under `/.iwci`.

use std::ffi::CString;
use std::io;
use std::path::Path;

use crate::platform::LinuxMachine;
use crate::port::{open_linux, serve_port};
use crate::tree::Overlay;

const OVERLAY_OPTIONS: &str = "redirect_dir=off,metacopy=off,index=off,xino=off";

fn c(text: &str) -> io::Result<CString> {
    CString::new(text).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

fn mount(
    source: &str,
    target: &str,
    fstype: Option<&str>,
    flags: libc::c_ulong,
    data: Option<&str>,
) -> io::Result<()> {
    let (source_c, target_c) = (c(source)?, c(target)?);
    let fstype_c = fstype.map(c).transpose()?;
    let data_c = data.map(c).transpose()?;
    // SAFETY: every pointer is a NUL-terminated string that outlives the
    // call, or null where the kernel allows it.
    let result = unsafe {
        libc::mount(
            source_c.as_ptr(),
            target_c.as_ptr(),
            fstype_c.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
            flags,
            data_c
                .as_ref()
                .map_or(std::ptr::null(), |s| s.as_ptr().cast()),
        )
    };
    if result == 0 {
        Ok(())
    } else {
        let e = io::Error::last_os_error();
        Err(io::Error::new(
            e.kind(),
            format!("mounting {source} on {target}: {e}"),
        ))
    }
}

fn chown(path: &str, uid: u32, gid: u32) -> io::Result<()> {
    let path = c(path)?;
    // SAFETY: a plain system call on a NUL-terminated string.
    if unsafe { libc::chown(path.as_ptr(), uid, gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn mkdir(path: &str) -> io::Result<()> {
    match std::fs::create_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) => Err(io::Error::new(e.kind(), format!("making {path}: {e}"))),
    }
}

/// A read-only bind of `source` on `target`.
fn bind_read_only(source: &str, target: &str) -> io::Result<()> {
    mount(source, target, None, libc::MS_BIND, None)?;
    mount(
        "none",
        target,
        None,
        libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY,
        None,
    )
}

/// The serial the runner gives the workspace image's disk.
pub const WORKSPACE_SERIAL: &str = "iwci-ws";

/// The workspace image's disk (`/dev/vdX`), found by its serial rather
/// than its name: virtio-mmio devices are numbered in the reverse of the
/// order QEMU is given them, so only the root disk's name is fixed (the
/// runner puts it last, which makes it `vda`).
fn workspace_disk() -> Option<String> {
    let entries = std::fs::read_dir("/sys/block").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("vd") {
            continue;
        }
        let serial = std::fs::read_to_string(entry.path().join("serial")).unwrap_or_default();
        if serial.trim() == WORKSPACE_SERIAL {
            let dev = format!("/dev/{name}");
            return Path::new(&dev).exists().then_some(dev);
        }
    }
    None
}

/// The tag of the virtio-fs device the job's own files are served on,
/// when the kernel's command line names one (`iwci.files=<tag>`): the
/// runner streams them in rather than giving a workspace disk.
fn files_tag(cmdline: &str) -> Option<&str> {
    cmdline
        .split_whitespace()
        .find_map(|word| word.strip_prefix("iwci.files="))
        .filter(|tag| {
            !tag.is_empty()
                && tag.len() <= 36
                && tag
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// Mounts the job's root and changes into it.
pub fn build_root() -> io::Result<()> {
    let nosuid = libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC;
    mount("proc", "/proc", Some("proc"), nosuid, None)?;
    mount("sysfs", "/sys", Some("sysfs"), nosuid, None)?;
    // A kernel booted without an initramfs mounts devtmpfs on /dev itself
    // (CONFIG_DEVTMPFS_MOUNT), so it may be there already.
    match mount(
        "devtmpfs",
        "/dev",
        Some("devtmpfs"),
        libc::MS_NOSUID,
        Some("mode=0755"),
    ) {
        // `mount` keeps the kind of the error, not its number.
        Err(e) if e.kind() == io::ErrorKind::ResourceBusy => {}
        other => other?,
    }

    mount("tmpfs", "/.iwci/rw", Some("tmpfs"), 0, Some("mode=0755"))?;
    mkdir("/.iwci/rw/upper")?;
    // Jobs run as uid 1001. Everything they add is copied up into the
    // upper layer, so it has to be theirs to create files in.
    chown("/.iwci/rw/upper", 1001, 1001)?;
    mkdir("/.iwci/rw/work")?;
    // The job's files: streamed in over virtio-fs, read only, or a disk
    // image of the workspace. Either is the overlay's upper lower layer.
    let cmdline = std::fs::read_to_string("/proc/cmdline").unwrap_or_default();
    let workspace = if let Some(tag) = files_tag(&cmdline) {
        mount(tag, "/.iwci/ws", Some("virtiofs"), libc::MS_RDONLY, None)?;
        true
    } else if let Some(disk) = workspace_disk() {
        mount(&disk, "/.iwci/ws", Some("erofs"), libc::MS_RDONLY, None)?;
        true
    } else {
        false
    };
    mount("/", "/.iwci/base", None, libc::MS_BIND, None)?;
    let lower = if workspace {
        "/.iwci/ws:/.iwci/base"
    } else {
        "/.iwci/base"
    };
    mount(
        "overlay",
        "/.iwci/root",
        Some("overlay"),
        0,
        Some(&format!(
            "lowerdir={lower},upperdir=/.iwci/rw/upper,workdir=/.iwci/rw/work,{OVERLAY_OPTIONS}"
        )),
    )?;

    let root = "/.iwci/root";
    mount(
        "/.iwci/rw",
        &format!("{root}/.iwci/rw"),
        None,
        libc::MS_BIND,
        None,
    )?;
    if workspace {
        bind_read_only("/.iwci/ws", &format!("{root}/.iwci/ws"))?;
    }
    bind_read_only("/.iwci/base", &format!("{root}/.iwci/base"))?;
    mount("proc", &format!("{root}/proc"), Some("proc"), nosuid, None)?;
    mount("sysfs", &format!("{root}/sys"), Some("sysfs"), nosuid, None)?;
    mount(
        "devtmpfs",
        &format!("{root}/dev"),
        Some("devtmpfs"),
        libc::MS_NOSUID,
        Some("mode=0755"),
    )?;
    mkdir(&format!("{root}/dev/pts"))?;
    mount(
        "devpts",
        &format!("{root}/dev/pts"),
        Some("devpts"),
        libc::MS_NOSUID | libc::MS_NOEXEC,
        Some("ptmxmode=0666,mode=0620"),
    )?;
    mkdir(&format!("{root}/dev/shm"))?;
    mount(
        "tmpfs",
        &format!("{root}/dev/shm"),
        Some("tmpfs"),
        libc::MS_NOSUID | libc::MS_NODEV,
        Some("mode=1777"),
    )?;
    // devtmpfs has none of these; shells use them (`<(...)`).
    for (link, target) in [
        ("fd", "/proc/self/fd"),
        ("stdin", "/proc/self/fd/0"),
        ("stdout", "/proc/self/fd/1"),
        ("stderr", "/proc/self/fd/2"),
    ] {
        let _ = std::os::unix::fs::symlink(target, format!("{root}/dev/{link}"));
    }
    mount(
        "cgroup2",
        &format!("{root}/sys/fs/cgroup"),
        Some("cgroup2"),
        nosuid,
        None,
    )?;
    mount(
        "tmpfs",
        &format!("{root}/run"),
        Some("tmpfs"),
        libc::MS_NOSUID | libc::MS_NODEV,
        Some("mode=0755"),
    )?;

    std::env::set_current_dir(root)?;
    let dot = c(".")?;
    // SAFETY: a plain system call on a NUL-terminated string.
    if unsafe { libc::chroot(dot.as_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    std::env::set_current_dir("/")
}

/// The environment every script starts from, before the image's
/// `/etc/environment` ([`crate::exec::image_environment`]).
const ENVIRONMENT: [(&str, &str); 6] = [
    (
        "PATH",
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ),
    ("HOME", "/home/runner"),
    ("USER", "runner"),
    ("LANG", "C.UTF-8"),
    ("LC_ALL", "C.UTF-8"),
    ("DEBIAN_FRONTEND", "noninteractive"),
];

fn power_off() -> ! {
    // SAFETY: plain system calls; the machine stops here.
    unsafe {
        libc::sync();
        libc::reboot(libc::RB_POWER_OFF);
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

/// Serves the runner from inside the job's root.
/// Threads reading the streamed-in files ahead of the job.
const PREFETCH_THREADS: usize = 4;
/// Files larger than this are left for the job to read if it wants them.
const PREFETCH_LARGEST: u64 = 256 << 20;

pub fn agent() -> io::Result<()> {
    // The job's files streamed in from the runner: start pulling them in
    // now, in the background, while the runner sets the machine up and
    // the job starts; the job waits only for a file that has not come yet.
    let cmdline = std::fs::read_to_string("/proc/cmdline").unwrap_or_default();
    if files_tag(&cmdline).is_some() {
        let budget =
            crate::prefetch::budget(&std::fs::read_to_string("/proc/meminfo").unwrap_or_default());
        let _ = std::thread::Builder::new()
            .name("iwci-prefetch".into())
            .spawn(move || {
                let started = std::time::Instant::now();
                let got = crate::prefetch::prefetch(
                    std::path::Path::new("/.iwci/ws"),
                    PREFETCH_THREADS,
                    budget,
                    PREFETCH_LARGEST,
                );
                eprintln!(
                    "iwci-guest: read ahead {} files, {} KiB, in {} ms",
                    got.files,
                    got.bytes / 1024,
                    started.elapsed().as_millis()
                );
            });
    }
    let port = open_linux()?;
    mark("agent port open");
    let mut tree = Overlay::linux();
    serve_port(port, &LinuxMachine, &mut tree)
}

/// Runs as the machine's PID 1. Never returns: the machine powers off when
/// the agent ends, or when the root cannot be built.
/// With `iwci.times` on the kernel's command line (the runner adds it
/// under `IWCI_BOOT_TIMES`), the machine's uptime at `step` on the console.
pub fn mark(step: &str) {
    let cmdline = std::fs::read_to_string("/proc/cmdline").unwrap_or_default();
    if cmdline.split_whitespace().any(|w| w == "iwci.times") {
        let uptime = std::fs::read_to_string("/proc/uptime").unwrap_or_default();
        eprintln!(
            "iwci-guest: {step} at {} s of uptime",
            uptime.split_whitespace().next().unwrap_or("?")
        );
    }
}

pub fn run() -> ! {
    if let Err(e) = build_root() {
        eprintln!("iwci-guest: could not build the job's root: {e}");
        power_off();
    }
    mark("root built");
    for (key, value) in ENVIRONMENT {
        // SAFETY: the process has one thread so far.
        unsafe { std::env::set_var(key, value) };
    }
    // What the image sets for every job (rbenv's shims on the PATH,
    // NVM_DIR): it knows what it installed.
    let file = std::fs::read_to_string("/etc/environment").unwrap_or_default();
    for (key, value) in crate::exec::image_environment(&file) {
        // SAFETY: the process has one thread so far.
        unsafe { std::env::set_var(key, value) };
    }
    // SAFETY: the process has one thread, so the child may do anything.
    let agent_pid = unsafe { libc::fork() };
    if agent_pid < 0 {
        eprintln!(
            "iwci-guest: could not start the agent: {}",
            io::Error::last_os_error()
        );
        power_off();
    }
    if agent_pid == 0 {
        let code = match agent() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("iwci-guest: {e}");
                1
            }
        };
        std::process::exit(code);
    }
    // PID 1 reaps every orphan until the agent itself ends.
    loop {
        let mut status = 0;
        // SAFETY: a plain system call with a valid out pointer.
        let pid = unsafe { libc::waitpid(-1, &mut status, 0) };
        if pid == agent_pid {
            power_off();
        }
        if pid < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
            power_off();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::files_tag;

    #[test]
    fn the_files_tag_comes_from_the_command_line_and_only_a_plain_one() {
        let line = "console=hvc0 root=/dev/vda ro init=/usr/local/sbin/iwci-guest iwci.files=iwci-files quiet";
        assert_eq!(files_tag(line), Some("iwci-files"));
        assert_eq!(files_tag("console=hvc0 quiet"), None);
        assert_eq!(files_tag("iwci.files="), None);
        assert_eq!(files_tag("iwci.files=../x"), None);
    }
}
