//! The helper that starts a sandbox's Sentry in its namespaces.
//!
//! Ubuntu keeps user namespaces from unprivileged programs unless an
//! AppArmor profile names the program. Naming the runner would give the
//! whole runner, and anything that came to run as its user, the right to
//! make them; so the profile names this helper instead, a root-owned copy
//! of the runner's binary at a path only root can change
//! (`/opt/iwci/lib/iwci-sandbox-spawn`), which does one thing: it starts
//! gVisor's Sentry, root-owned too, in new namespaces, the way the runner
//! would otherwise start it itself ([`crate::runsc`]), and waits for it.
//!
//! The runner starts the helper with the Sentry's descriptors already at
//! their numbers and the Sentry's environment, into the sandbox's cgroup:
//!
//! ```text
//! iwci-sandbox-spawn <protocol> <runner pid> <descriptors> <sentry> <sentry's argv...>
//! ```
//!
//! The helper is the Sentry's parent and lives as long as it does; the
//! Sentry dies with it (`PR_SET_PDEATHSIG`), it dies with the runner, and
//! its exit status is the Sentry's (`128 + n` for a signal `n`).
//!
//! On a host that restricts user namespaces, the helper starts only a
//! Sentry that only root could have put there (it and every directory
//! above it owned by root and writable by no one else), and only as
//! `boot --setup-root`, which drops every capability before it runs
//! anything of the job's. Where user namespaces are open to everyone, or
//! when it runs as root, it grants nothing new and checks nothing.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

use crate::runsc::{Namespaces, spawn_fd};

/// The helper's file name: a binary of the runner's under this name is the
/// helper (see [`invoked`]).
pub const NAME: &str = "iwci-sandbox-spawn";

/// What the runner and the helper agree on; a helper left from an older
/// release refuses a newer runner rather than guessing.
pub const PROTOCOL: &str = "1";

/// The helper's arguments before the Sentry's own.
pub(crate) fn args(sentry: &Path, fds: usize) -> Vec<String> {
    vec![
        NAME.into(),
        PROTOCOL.into(),
        std::process::id().to_string(),
        fds.to_string(),
        sentry.to_string_lossy().into_owned(),
    ]
}

/// Whether this process is the helper: whether the binary it runs from is
/// named [`NAME`]. Read from the kernel (`/proc/self/exe`), never from
/// `argv[0]`, which whoever starts a program chooses.
pub fn invoked() -> bool {
    fs::read_link("/proc/self/exe")
        .ok()
        .is_some_and(|exe| exe.file_name().is_some_and(|n| n == NAME))
}

/// The helper's `main`.
pub fn main() -> ExitCode {
    match run(std::env::args_os().collect()) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("{NAME}: {e}");
            ExitCode::from(125)
        }
    }
}

fn run(argv: Vec<OsString>) -> Result<u8, String> {
    let mut argv = argv.into_iter().skip(1).map(|a| a.into_vec());
    let mut next = |what: &str| argv.next().ok_or(format!("no {what}"));
    let protocol = next("protocol")?;
    // What the runner asks when it starts.
    if protocol == b"protocol" {
        println!("{PROTOCOL}");
        return Ok(0);
    }
    if protocol != PROTOCOL.as_bytes() {
        return Err(format!(
            "protocol {} is not this helper's ({PROTOCOL}); reinstall it from the runner's binary",
            String::from_utf8_lossy(&protocol)
        ));
    }
    let number = |b: Vec<u8>| -> Option<u32> { std::str::from_utf8(&b).ok()?.parse().ok() };
    let runner = number(next("runner pid")?).ok_or("a bad runner pid")?;
    let fds = number(next("descriptor count")?)
        .filter(|n| (3..=64).contains(n))
        .ok_or("a bad descriptor count")?;
    let sentry = PathBuf::from(OsString::from_vec(next("sentry")?));
    let rest: Vec<Vec<u8>> = argv.collect();

    // Gone with the runner, which may have gone already.
    // SAFETY: plain system calls.
    unsafe {
        libc::prctl(
            libc::PR_SET_PDEATHSIG,
            libc::SIGKILL as libc::c_ulong,
            0,
            0,
            0,
        );
        if libc::getppid() as u32 != runner {
            return Err("the runner is gone".into());
        }
    }

    let args = rest
        .into_iter()
        .map(|a| String::from_utf8(a).map_err(|_| "an argument that is not UTF-8".to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    if checked() {
        allowed(&args)?;
        trusted(&sentry).map_err(|e| format!("{}: {e}", sentry.display()))?;
    }
    let exe = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_NOFOLLOW)
        .open(&sentry)
        .map_err(|e| format!("{}: {e}", sentry.display()))?;
    let env: Vec<String> = std::env::vars_os()
        .filter_map(|(k, v)| {
            let mut kv = k.into_vec();
            kv.push(b'=');
            kv.extend(v.into_vec());
            String::from_utf8(kv).ok()
        })
        .collect();
    // SAFETY: the runner put exactly these descriptors here for the
    // Sentry, and nothing else of this process holds them.
    let fds: Vec<OwnedFd> = (0..fds as i32)
        .map(|fd| unsafe { OwnedFd::from_raw_fd(fd) })
        .collect();
    let pid = spawn_fd(exe, &args, &env, fds, None, Namespaces::New)
        .map_err(|e| format!("starting the sandbox: {e}"))?;
    let mut status = 0;
    loop {
        // SAFETY: waiting on our own child.
        let r = unsafe { libc::waitpid(pid, &mut status, 0) };
        if r == pid {
            break;
        }
        if r < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(format!("waiting: {}", io::Error::last_os_error()));
        }
    }
    Ok(if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status) as u8
    } else {
        128u8.saturating_add(libc::WTERMSIG(status) as u8)
    })
}

/// Whether the helper is what lets this process make user namespaces: not
/// root, on a host that keeps them from unprivileged programs.
fn checked() -> bool {
    // SAFETY: a plain query.
    let root = unsafe { libc::getuid() } == 0;
    !root
        && restricted(
            fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").ok(),
        )
}

fn restricted(setting: Option<String>) -> bool {
    setting.is_some_and(|s| s.trim() != "0")
}

/// The Sentry's arguments start it as `boot --setup-root`, the only way
/// the runner starts it: the Sentry then builds an empty root and drops
/// every capability before anything of the job's runs. No test-only flag.
fn allowed(args: &[String]) -> Result<(), String> {
    let boot = args
        .iter()
        .position(|a| a == "boot")
        .ok_or("the Sentry is only started to boot")?;
    if !args[boot..].iter().any(|a| a == "--setup-root") {
        return Err("the Sentry is only started with --setup-root".into());
    }
    if let Some(a) = args
        .iter()
        .find(|a| a.to_ascii_lowercase().starts_with("--testonly"))
    {
        return Err(format!("{a} is not for a runner's sandbox"));
    }
    Ok(())
}

/// `path` is a file only root could have put there: it and every directory
/// above it are owned by root and writable by no one else, and nothing on
/// the way is a symbolic link.
fn trusted(path: &Path) -> io::Result<()> {
    let refuse = |why: String| Err(io::Error::new(io::ErrorKind::PermissionDenied, why));
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return refuse("not a plain absolute path".into());
    }
    let mut at = PathBuf::from("/");
    let check = |p: &Path, last: bool| -> io::Result<()> {
        let m = fs::symlink_metadata(p)?;
        let kind = m.file_type();
        if kind.is_symlink() || (last && !kind.is_file()) || (!last && !kind.is_dir()) {
            return refuse(format!("{} is not a plain file or directory", p.display()));
        }
        if m.uid() != 0 || m.mode() & 0o022 != 0 {
            return refuse(format!("{} is not root's alone", p.display()));
        }
        Ok(())
    };
    check(&at, false)?;
    let parts: Vec<_> = path.components().skip(1).collect();
    for (i, c) in parts.iter().enumerate() {
        at.push(c);
        check(&at, i + 1 == parts.len())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_restricting_host_is_checked() {
        assert!(!restricted(None));
        assert!(!restricted(Some("0\n".into())));
        assert!(restricted(Some("1\n".into())));
    }

    #[test]
    fn the_sentry_is_only_started_to_boot_into_an_empty_root() {
        let ok = |a: &[&str]| allowed(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(ok(&["runsc-sandbox", "--root=/x", "boot", "--setup-root", "id"]).is_ok());
        assert!(ok(&["runsc-sandbox", "boot", "id"]).is_err());
        assert!(ok(&["runsc-sandbox", "--setup-root", "do", "sh"]).is_err());
        assert!(ok(&["runsc-sandbox", "do", "sh"]).is_err());
        assert!(
            ok(&[
                "runsc-sandbox",
                "--TESTONLY-unsafe-nonroot",
                "boot",
                "--setup-root"
            ])
            .is_err()
        );
    }

    #[test]
    fn only_roots_files_are_trusted() {
        // The system's own directories and a file in them are root's.
        let sh = ["/bin/sh", "/usr/bin/env"]
            .into_iter()
            .map(Path::new)
            .find(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_file()));
        if let Some(sh) = sh
            && fs::metadata("/usr").is_ok_and(|m| m.uid() == 0)
            && !Path::new("/usr").is_symlink()
        {
            let canon = fs::canonicalize(sh).unwrap();
            assert!(trusted(&canon).is_ok(), "{}", canon.display());
        }
        // A file of someone else's, a link on the way, a relative path: no.
        let dir = std::env::temp_dir().join(format!("iwci-helper-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sentry");
        fs::write(&file, b"").unwrap();
        // SAFETY: a plain query.
        if unsafe { libc::getuid() } != 0 {
            assert!(trusted(&file).is_err());
        }
        std::os::unix::fs::symlink(&file, dir.join("link")).unwrap();
        assert!(trusted(&dir.join("link")).is_err());
        assert!(trusted(Path::new("bin/sh")).is_err());
        assert!(trusted(Path::new("/usr/../bin/sh")).is_err());
        // A directory anyone may write to on the way: no, though root's.
        if fs::metadata("/tmp").is_ok_and(|m| m.uid() == 0 && m.mode() & 0o002 != 0) {
            assert!(trusted(Path::new("/tmp")).is_err());
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
