//! Starting a program at fixed descriptors, in new namespaces or not
//! (`clone`, then system calls only until `execve`).

use std::ffi::{CString, c_char, c_int, c_void};
use std::fs;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// What the child needs, prepared before `clone` so that it allocates
/// nothing (it is a copy of a multi-threaded process).
struct Child {
    sync: RawFd,
    /// The binary, opened `O_PATH` by the runner: the child, once it is
    /// `nobody`, may not be able to reach it by path.
    exe: RawFd,
    argv: *const *const c_char,
    envp: *const *const c_char,
    /// (from, to) pairs; every `from` is above every `to`.
    fds: *const (RawFd, RawFd),
    nfds: usize,
    namespaces: Namespaces,
}

/// Where [`spawn`] starts its program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Namespaces {
    /// In new user, mount, PID, IPC, UTS and network namespaces, as
    /// `nobody` there, which is this host user and group, with [`CAPS`]:
    /// the Sentry.
    New { uid: u32, gid: u32 },
    /// In the caller's own, as the caller.
    Same,
}

impl Namespaces {
    /// New namespaces whose `nobody` is the caller's own user (or, for
    /// root, the host's `nobody`, as `runsc` does).
    pub fn as_caller() -> Self {
        // SAFETY: plain queries.
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        if uid == 0 {
            Self::New {
                uid: NOBODY,
                gid: NOBODY,
            }
        } else {
            Self::New { uid, gid }
        }
    }
}

/// `nobody`, in a sandbox's user namespace and on most hosts.
pub const NOBODY: u32 = 65534;

/// The capabilities the Sentry starts with: what building its empty root
/// takes. It drops them all before it runs anything of the job's.
const CAPS: [u32; 3] = [
    21, // CAP_SYS_ADMIN
    18, // CAP_SYS_CHROOT
    8,  // CAP_SETPCAP
];

/// Starts `exe` with `fds` as its descriptors 0, 1, 2, ..., in
/// `namespaces`, written into `cgroup` (an open `cgroup.procs`) before it
/// runs anything; its pid.
pub fn spawn(
    exe: &Path,
    args: &[String],
    env: &[String],
    fds: Vec<OwnedFd>,
    cgroup: Option<&fs::File>,
    namespaces: Namespaces,
) -> io::Result<libc::pid_t> {
    let exe_fd = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH)
        .open(exe)?;
    spawn_fd(exe_fd, args, env, fds, cgroup, namespaces)
}

/// [`spawn`] with the program already open (`O_PATH`).
pub fn spawn_fd(
    exe_fd: fs::File,
    args: &[String],
    env: &[String],
    fds: Vec<OwnedFd>,
    cgroup: Option<&fs::File>,
    namespaces: Namespaces,
) -> io::Result<libc::pid_t> {
    let cstr = |s: &[u8]| CString::new(s).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput));
    let args_c = args
        .iter()
        .map(|a| cstr(a.as_bytes()))
        .collect::<io::Result<Vec<_>>>()?;
    let env_c = env
        .iter()
        .map(|e| cstr(e.as_bytes()))
        .collect::<io::Result<Vec<_>>>()?;
    let mut argv: Vec<*const c_char> = args_c.iter().map(|a| a.as_ptr()).collect();
    argv.push(std::ptr::null());
    let mut envp: Vec<*const c_char> = env_c.iter().map(|e| e.as_ptr()).collect();
    envp.push(std::ptr::null());

    // Move every descriptor well above the numbers it is going to, so the
    // child's dup2s never overwrite one not yet moved, nor the program,
    // which it runs after them.
    let raise = |fd: RawFd| -> io::Result<OwnedFd> {
        // SAFETY: duplicating a descriptor we hold; checked below.
        let raw = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 512) };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: just created and ours.
        Ok(unsafe { OwnedFd::from_raw_fd(raw) })
    };
    let high: Vec<OwnedFd> = fds
        .iter()
        .map(|fd| raise(fd.as_raw_fd()))
        .collect::<io::Result<_>>()?;
    let exe_fd = raise(exe_fd.as_raw_fd())?;
    drop(fds);
    let pairs: Vec<(RawFd, RawFd)> = high
        .iter()
        .enumerate()
        .map(|(to, fd)| (fd.as_raw_fd(), to as RawFd))
        .collect();

    let mut sync = [0 as RawFd; 2];
    // SAFETY: `sync` has room for both ends.
    if unsafe { libc::pipe2(sync.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both were just created and are ours.
    let (sync_r, sync_w) =
        unsafe { (OwnedFd::from_raw_fd(sync[0]), OwnedFd::from_raw_fd(sync[1])) };

    let child = Child {
        sync: sync_r.as_raw_fd(),
        exe: exe_fd.as_raw_fd(),
        argv: argv.as_ptr(),
        envp: envp.as_ptr(),
        fds: pairs.as_ptr(),
        nfds: pairs.len(),
        namespaces,
    };
    let flags = match namespaces {
        Namespaces::New { .. } => {
            libc::CLONE_NEWUSER
                | libc::CLONE_NEWNS
                | libc::CLONE_NEWPID
                | libc::CLONE_NEWIPC
                | libc::CLONE_NEWUTS
                | libc::CLONE_NEWNET
        }
        Namespaces::Same => 0,
    };
    let mut stack = vec![0u8; 256 * 1024];
    // SAFETY: the stack grows down from its end, aligned to 16; `child`
    // and everything it points to outlive the call, and the child gets a
    // copy of this address space, not a share of it.
    let pid = unsafe {
        let top = stack.as_mut_ptr().add(stack.len());
        let top = top.sub(top as usize % 16);
        libc::clone(
            run_child,
            top.cast(),
            flags | libc::SIGCHLD,
            (&child as *const Child).cast_mut().cast(),
        )
    };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    drop(sync_r);
    // Into its cgroup while it still waits for its user to be mapped, so
    // it has run nothing outside it.
    let joined = match cgroup {
        Some(mut procs) => procs.write_all(pid.to_string().as_bytes()),
        None => Ok(()),
    };
    let mapped = joined
        .and_then(|()| match namespaces {
            Namespaces::New { uid, gid } => map_user(pid, uid, gid),
            Namespaces::Same => Ok(()),
        })
        .and_then(|()| {
            let mut w = fs::File::from(sync_w);
            w.write_all(&[1])
        });
    if let Err(e) = mapped {
        // SAFETY: our own child; reaped right after.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        return Err(e);
    }
    drop(high);
    drop(exe_fd);
    Ok(pid)
}

/// Maps `nobody` in the child's user namespace to host `uid` and `gid`.
fn map_user(pid: libc::pid_t, uid: u32, gid: u32) -> io::Result<()> {
    let proc = PathBuf::from(format!("/proc/{pid}"));
    fs::write(proc.join("setgroups"), "deny")?;
    fs::write(proc.join("uid_map"), format!("{NOBODY} {uid} 1\n"))?;
    fs::write(proc.join("gid_map"), format!("{NOBODY} {gid} 1\n"))?;
    Ok(())
}

/// The child, between `clone` and `execve`: system calls only.
extern "C" fn run_child(arg: *mut c_void) -> c_int {
    // SAFETY: `arg` is the parent's `Child`, at the same address in our
    // copy of its memory; everything below is a plain system call.
    unsafe {
        let child = &*(arg as *const Child);
        // Wait for the parent to map our user.
        let mut byte = 0u8;
        loop {
            let n = libc::read(child.sync, (&mut byte as *mut u8).cast(), 1);
            if n == 1 {
                break;
            }
            if n < 0 && *libc::__errno_location() == libc::EINTR {
                continue;
            }
            libc::_exit(120);
        }
        if matches!(child.namespaces, Namespaces::New { .. }) {
            become_nobody();
            // Nothing the Sentry or anything under it runs gains a
            // privilege by being run (set-user-ID files and the like),
            // whatever the caller allows itself.
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, 0, 0, 0) < 0 {
                libc::_exit(119);
            }
        }
        // Gone with the runner.
        libc::prctl(
            libc::PR_SET_PDEATHSIG,
            libc::SIGKILL as libc::c_ulong,
            0,
            0,
            0,
        );
        libc::setsid();
        // What the runner ignores (a broken pipe) is not ignored here.
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
        let pairs = std::slice::from_raw_parts(child.fds, child.nfds);
        for &(from, to) in pairs {
            if libc::dup2(from, to) < 0 {
                libc::_exit(124);
            }
        }
        libc::syscall(
            libc::SYS_execveat,
            child.exe,
            c"".as_ptr(),
            child.argv,
            child.envp,
            libc::AT_EMPTY_PATH,
        );
        libc::_exit(127)
    }
}

/// In the new user namespace: becomes the mapped `nobody`, keeping the
/// capabilities the namespace gave through the change, and makes the
/// Sentry's [`CAPS`] ambient so they survive `execve`.
///
/// # Safety
///
/// Only from [`run_child`]: system calls only.
unsafe fn become_nobody() {
    // SAFETY: plain system calls, as the caller's.
    unsafe {
        libc::prctl(libc::PR_SET_KEEPCAPS, 1 as libc::c_ulong, 0, 0, 0);
        // The system calls, not the C library's wrappers, which are not
        // for a copy of a multi-threaded process.
        if libc::syscall(libc::SYS_setresgid, NOBODY, NOBODY, NOBODY) < 0
            || libc::syscall(libc::SYS_setresuid, NOBODY, NOBODY, NOBODY) < 0
        {
            libc::_exit(125);
        }
        // Keep the capabilities the Sentry needs across execve: they have
        // to be inheritable to be made ambient.
        let mut header = CapHeader {
            version: 0x2008_0522,
            pid: 0,
        };
        let mut data = [CapData::default(); 2];
        if libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) < 0 {
            libc::_exit(121);
        }
        for (cap_word, word) in data.iter_mut().enumerate() {
            word.effective = word.permitted;
            for cap in CAPS {
                if (cap / 32) as usize == cap_word {
                    word.inheritable |= 1 << (cap % 32);
                }
            }
        }
        if libc::syscall(libc::SYS_capset, &mut header, data.as_ptr()) < 0 {
            libc::_exit(122);
        }
        for cap in CAPS {
            if libc::prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_RAISE,
                cap as libc::c_ulong,
                0,
                0,
            ) < 0
            {
                libc::_exit(123);
            }
        }
    }
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}
