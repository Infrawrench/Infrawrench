//! Running a job's script ([`HostMsg::Exec`](iwci_vm_proto::HostMsg::Exec)).

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use iwci_vm_proto::{Exec, Exited, Kind, Shell, write_frame};

use crate::{Failure, lock};

/// The most one output frame carries.
const CHUNK: usize = 64 * 1024;

/// How long output may still arrive after the script and everything it
/// left running have ended. Past it, a pipe something still holds open is
/// abandoned.
const DRAIN_GRACE: Duration = Duration::from_secs(5);

static SCRIPTS: AtomicU64 = AtomicU64::new(0);

/// Where and how a script runs.
pub struct Context<'a> {
    /// Where the script's file goes (`/iwci/run`).
    pub run_dir: &'a Path,
    /// The working directory, already mapped onto the machine.
    pub cwd: &'a Path,
    /// Run the script in a cgroup of its own (Linux machines only).
    pub cgroups: bool,
}

/// The script file's extension and content for `shell`.
pub fn script_file(shell: Shell, script: &str) -> (&'static str, String) {
    match shell {
        Shell::Bash => ("bash", script.to_owned()),
        Shell::Sh => ("sh", script.to_owned()),
        // Windows PowerShell reads a file without a byte order mark in the
        // legacy code page; both read one with it as UTF-8.
        Shell::Pwsh | Shell::Powershell => (
            "ps1",
            format!(
                "\u{feff}$ErrorActionPreference = 'Stop'\n\
                 $ProgressPreference = 'SilentlyContinue'\n\
                 {script}\n\
                 if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) {{ exit $LASTEXITCODE }}\n"
            ),
        ),
        // cmd misreads labels in a file with bare line feeds.
        Shell::Cmd => ("cmd", script.replace("\r\n", "\n").replace('\n', "\r\n")),
    }
}

/// The command that runs `file` with `shell`.
pub fn command(shell: Shell, file: &Path) -> Command {
    match shell {
        Shell::Bash => {
            let mut cmd = Command::new("bash");
            cmd.args(["--noprofile", "--norc", "-euo", "pipefail"])
                .arg(file);
            cmd
        }
        Shell::Sh => {
            let mut cmd = Command::new("sh");
            cmd.arg("-eu").arg(file);
            cmd
        }
        Shell::Pwsh | Shell::Powershell => {
            let mut cmd = Command::new(shell.name());
            cmd.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(file);
            cmd
        }
        Shell::Cmd => {
            let mut cmd = Command::new("cmd");
            cmd.args(["/D", "/E:ON", "/V:OFF", "/S", "/C"]);
            let call = format!("\"CALL \"{}\"\"", file.display());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.raw_arg(call);
            }
            #[cfg(not(windows))]
            cmd.arg(call);
            cmd
        }
    }
}

/// Runs `exec`, sending its output through `out` as it arrives, and
/// returns how it ended once the script has exited and its output is all
/// sent.
pub fn run<W: Write + Send + 'static>(
    out: &Arc<Mutex<W>>,
    exec: &Exec,
    ctx: &Context<'_>,
) -> Result<Exited, Failure> {
    if !ctx.cwd.is_dir() {
        return Err(Failure::Refused(format!(
            "the working directory {} does not exist",
            exec.cwd
        )));
    }
    fs::create_dir_all(ctx.run_dir)
        .map_err(|e| Failure::Refused(format!("making {}: {e}", ctx.run_dir.display())))?;
    let n = SCRIPTS.fetch_add(1, Ordering::Relaxed) + 1;
    let (ext, body) = script_file(exec.shell, &exec.script);
    let file: PathBuf = ctx.run_dir.join(format!("script-{n}.{ext}"));
    fs::write(&file, body)
        .map_err(|e| Failure::Refused(format!("writing {}: {e}", file.display())))?;

    let mut cmd = command(exec.shell, &file);
    cmd.current_dir(ctx.cwd)
        .envs(exec.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so what it leaves running can be ended.
        cmd.process_group(0);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::chown;
        use std::os::unix::process::CommandExt;
        // Linux jobs run as an unprivileged user, like GitHub's hosted
        // runners, so suites that rely on chmod and ownership behaving
        // normally pass. The agent wrote the script and the output file as
        // root; hand them to that user before the shell starts.
        let _ = chown(&file, 1001, 1001);
        let _ = chown(Path::new("/iwci/output"), 1001, 1001);
        // The GH token's git config is lent as root-owned 0600 at this path.
        let _ = chown(Path::new("/root/.gitconfig"), 1001, 1001);
        cmd.uid(1001).gid(1001);
    }
    #[cfg(target_os = "linux")]
    let cgroup = if ctx.cgroups {
        cgroup::JobCgroup::create(n)
    } else {
        None
    };
    #[cfg(target_os = "linux")]
    if let Some(group) = &cgroup {
        group.enter_on_exec(&mut cmd);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = ctx.cgroups;

    let mut child = cmd
        .spawn()
        .map_err(|e| Failure::Refused(format!("starting {}: {e}", exec.shell.name())))?;

    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<io::Result<()>>();
    let pipes: [(Option<Box<dyn Read + Send>>, Kind); 2] = [
        (
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
            Kind::Stdout,
        ),
        (
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
            Kind::Stderr,
        ),
    ];
    let mut pumps = 0;
    for (pipe, kind) in pipes {
        let Some(pipe) = pipe else { continue };
        let (out, stop, tx) = (Arc::clone(out), Arc::clone(&stop), tx.clone());
        pumps += 1;
        std::thread::spawn(move || {
            let _ = tx.send(pump(pipe, kind, &out, &stop));
        });
    }
    drop(tx);

    let status = child.wait();
    let mut exited = Exited::default();
    #[cfg(target_os = "linux")]
    if let Some(group) = &cgroup {
        group.read_usage(&mut exited);
        group.end();
    }
    #[cfg(unix)]
    // SAFETY: a plain system call; the group is the script's, which has
    // been waited for, so its number names only what it left running.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let status = status.map_err(|e| Failure::Refused(format!("waiting for the script: {e}")))?;
    exited.code = status.code().unwrap_or(-1);
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            exited.code = 128 + signal;
            exited.signal = Some(signal);
        }
    }

    let deadline = Instant::now() + DRAIN_GRACE;
    let mut broken = None;
    for _ in 0..pumps {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => broken = Some(e),
            Err(_) => break,
        }
    }
    if let Some(e) = broken {
        return Err(Failure::Broken(e));
    }
    // Under the lock: no output frame can follow `Exited`.
    let guard = lock(out);
    stop.store(true, Ordering::SeqCst);
    drop(guard);
    let _ = fs::remove_file(&file);
    Ok(exited)
}

fn pump<W: Write>(
    mut pipe: Box<dyn Read + Send>,
    kind: Kind,
    out: &Mutex<W>,
    stop: &AtomicBool,
) -> io::Result<()> {
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            // The pipe failing ends this output, not the conversation.
            Err(_) => return Ok(()),
        };
        let mut guard = lock(out);
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        write_frame(&mut *guard, kind, &buf[..n])?;
    }
}

#[cfg(target_os = "linux")]
mod cgroup {
    use std::ffi::CString;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant};

    use iwci_vm_proto::Exited;

    const ROOT: &str = "/sys/fs/cgroup";

    /// A job's own cgroup: what its processes used, and a way to end every
    /// one of them. All of it best-effort.
    pub struct JobCgroup {
        dir: PathBuf,
        procs: CString,
    }

    impl JobCgroup {
        pub fn create(n: u64) -> Option<JobCgroup> {
            if !std::path::Path::new(ROOT)
                .join("cgroup.controllers")
                .exists()
            {
                return None;
            }
            let control = format!("{ROOT}/cgroup.subtree_control");
            for controller in ["+memory", "+cpu"] {
                let _ = fs::write(&control, controller);
            }
            let dir = PathBuf::from(format!("{ROOT}/iwci-job-{n}"));
            if let Err(e) = fs::create_dir(&dir)
                && e.kind() != std::io::ErrorKind::AlreadyExists
            {
                return None;
            }
            let procs = CString::new(format!("{}/cgroup.procs", dir.display())).ok()?;
            Some(JobCgroup { dir, procs })
        }

        /// Moves the script into the cgroup between fork and exec.
        pub fn enter_on_exec(&self, cmd: &mut Command) {
            use std::os::unix::process::CommandExt;
            let procs = self.procs.clone();
            // SAFETY: only async-signal-safe calls (open, write, close) on
            // memory allocated before the fork.
            unsafe {
                cmd.pre_exec(move || {
                    let fd = libc::open(procs.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                    if fd >= 0 {
                        libc::write(fd, b"0".as_ptr().cast(), 1);
                        libc::close(fd);
                    }
                    Ok(())
                });
            }
        }

        fn read(&self, name: &str) -> String {
            fs::read_to_string(self.dir.join(name)).unwrap_or_default()
        }

        fn field(text: &str, key: &str) -> u64 {
            text.lines()
                .filter_map(|line| line.split_once(' '))
                .find(|(k, _)| *k == key)
                .and_then(|(_, v)| v.trim().parse().ok())
                .unwrap_or(0)
        }

        pub fn read_usage(&self, exited: &mut Exited) {
            exited.peak_memory_bytes = self.read("memory.peak").trim().parse().unwrap_or(0);
            exited.oom_killed = Self::field(&self.read("memory.events"), "oom_kill") > 0;
            exited.cpu_ms = Self::field(&self.read("cpu.stat"), "usage_usec") / 1000;
        }

        /// Ends everything still in the cgroup and removes it.
        pub fn end(&self) {
            if fs::write(self.dir.join("cgroup.kill"), "1").is_err() {
                // Before Linux 5.14: one process at a time.
                for pid in self.read("cgroup.procs").lines() {
                    if let Ok(pid) = pid.trim().parse::<i32>() {
                        // SAFETY: a plain system call.
                        unsafe {
                            libc::kill(pid, libc::SIGKILL);
                        }
                    }
                }
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            while !self.read("cgroup.procs").trim().is_empty() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = fs::remove_dir(&self.dir);
        }
    }
}

/// The variables of an `/etc/environment` (pam_env's format): `KEY=value`
/// lines, the value optionally in double or single quotes, `#` comments
/// and `export ` tolerated. Nothing is expanded.
pub fn image_environment(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let valid = !key.is_empty()
                && !key.starts_with(|c: char| c.is_ascii_digit())
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !valid {
                return None;
            }
            let value = value.trim();
            let value = [('"', '"'), ('\'', '\'')]
                .iter()
                .find_map(|&(open, close)| {
                    value.strip_prefix(open).and_then(|v| v.strip_suffix(close))
                })
                .unwrap_or(value);
            Some((key.to_owned(), value.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_images_environment_file_is_read_as_pam_env_reads_it() {
        let text = "# comment\nPATH=\"/root/.rbenv/shims:/usr/bin\"\n\nNVM_DIR='/root/.nvm'\nexport LANG=C.UTF-8\nbad key=x\n1X=y\nnot a line\n";
        assert_eq!(
            image_environment(text),
            vec![
                ("PATH".into(), "/root/.rbenv/shims:/usr/bin".into()),
                ("NVM_DIR".into(), "/root/.nvm".into()),
                ("LANG".into(), "C.UTF-8".into()),
            ]
        );
        assert!(image_environment("").is_empty());
    }

    #[test]
    fn powershell_scripts_stop_on_errors_and_keep_the_exit_code() {
        let (ext, body) = script_file(Shell::Pwsh, "Write-Output hi");
        assert_eq!(ext, "ps1");
        assert!(body.starts_with("\u{feff}$ErrorActionPreference = 'Stop'\n"));
        assert!(body.contains("$ProgressPreference = 'SilentlyContinue'\nWrite-Output hi\n"));
        assert!(body.ends_with(
            "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n"
        ));
    }

    #[test]
    fn cmd_scripts_get_crlf_line_ends() {
        let (ext, body) = script_file(Shell::Cmd, "echo a\necho b\r\n");
        assert_eq!(ext, "cmd");
        assert_eq!(body, "echo a\r\necho b\r\n");
    }

    #[test]
    fn commands_are_the_documented_ones() {
        let file = Path::new("/iwci/run/script-1.bash");
        let args = |cmd: &Command| -> Vec<String> {
            std::iter::once(cmd.get_program())
                .chain(cmd.get_args())
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(
            args(&command(Shell::Bash, file)),
            [
                "bash",
                "--noprofile",
                "--norc",
                "-euo",
                "pipefail",
                "/iwci/run/script-1.bash"
            ]
        );
        assert_eq!(
            args(&command(Shell::Sh, file)),
            ["sh", "-eu", "/iwci/run/script-1.bash"]
        );
        assert_eq!(
            args(&command(Shell::Powershell, file))[..6],
            [
                "powershell",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass"
            ]
        );
    }
}
