//! Spawning applications, and noticing when they die.
//!
//! An app that exits immediately is the single most common failure on a bare
//! host — a missing shared library, a toolkit that cannot find a backend — so
//! its stderr is captured and reported rather than swallowed. "Firefox failed
//! to start" helps nobody; `libgtk-4.so.1: cannot open shared object file`
//! is the whole answer.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use std::os::unix::process::CommandExt;

use crate::backend::{BackendError, LaunchSpec};

/// How long an application has to exit on its own before it is killed.
///
/// Long enough for a browser to write its session out, short enough that
/// closing a tab does not feel like it hung.
const GRACE: Duration = Duration::from_millis(1500);

const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

/// Signal a child's whole process group.
///
/// Negating the pid is what makes it the group; each child leads its own, set
/// at spawn time.
fn signal_group(child: &Child, signal: i32) {
    let pid = child.id() as i32;
    if pid <= 0 {
        return;
    }
    // SAFETY: `kill` reads no memory we own and cannot fail in a way that
    // matters here — the process may already be gone, which is the outcome we
    // wanted anyway.
    unsafe {
        libc_kill(-pid, signal);
    }
}

unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

struct Running {
    app_id: Option<String>,
    child: Child,
}

#[derive(Default)]
pub struct Nursery {
    children: Vec<Running>,
}

impl Nursery {
    pub fn spawn(
        &mut self,
        spec: &LaunchSpec,
        env: &BTreeMap<String, String>,
    ) -> Result<(), BackendError> {
        let (program, args) = spec
            .argv
            .split_first()
            .ok_or_else(|| BackendError::Launch("empty command".into()))?;

        let mut command = Command::new(program);
        command
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        // Its own process group, so a crashed app's children go with it and a
        // signal aimed at us does not reach the user's application.
        command.process_group(0);

        let child = command
            .spawn()
            .map_err(|e| BackendError::Launch(format!("{}: {e}", program)))?;

        self.children.push(Running {
            app_id: spec.app_id.clone(),
            child,
        });
        Ok(())
    }

    /// Collect any application that has exited. Returns one entry per death
    /// that looks like a failure — a clean exit after the user closed the
    /// window is not news.
    pub fn reap(&mut self) -> Vec<(Option<String>, String)> {
        let mut failures = Vec::new();
        let mut still_running = Vec::new();

        for mut running in self.children.drain(..) {
            match running.child.try_wait() {
                Ok(Some(status)) => {
                    if status.success() {
                        continue;
                    }
                    let mut stderr = String::new();
                    if let Some(mut pipe) = running.child.stderr.take() {
                        let _ = pipe.read_to_string(&mut stderr);
                    }
                    let tail: String = stderr
                        .lines()
                        .rfind(|line| !line.trim().is_empty())
                        .unwrap_or("exited without output")
                        .chars()
                        .take(400)
                        .collect();
                    failures.push((
                        running.app_id.clone(),
                        format!("exited with {status}: {tail}"),
                    ));
                }
                Ok(None) => still_running.push(running),
                // The child is unreachable; treat it as gone rather than
                // holding a handle we can never wait on.
                Err(_) => {}
            }
        }

        self.children = still_running;
        failures
    }

    pub fn any_alive(&mut self) -> bool {
        self.children
            .iter_mut()
            .any(|running| matches!(running.child.try_wait(), Ok(None)))
    }

    /// Ask everything to exit, then insist.
    ///
    /// The asking matters. `Child::kill` is SIGKILL, and an application killed
    /// outright never saves anything or tidies up — Firefox in particular
    /// counts it as a crash and greets the *next* session with "we're having
    /// trouble getting your pages back", which is how a clean shutdown of ours
    /// shows up as a broken window of theirs.
    ///
    /// The signal goes to the process *group*, not the process: an application
    /// is rarely one process, and signalling only the one we spawned leaves its
    /// children running on the customer's machine. Each was given its own group
    /// at spawn time precisely so this could address them.
    pub fn terminate_all(&mut self) {
        for running in &mut self.children {
            signal_group(&running.child, SIGTERM);
        }

        // Poll rather than sleep the whole grace period: the common case is
        // everything gone in a few milliseconds, and this runs while an SSH
        // channel is waiting to close.
        let deadline = Instant::now() + GRACE;
        while Instant::now() < deadline {
            if self
                .children
                .iter_mut()
                .all(|r| !matches!(r.child.try_wait(), Ok(None)))
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        for running in &mut self.children {
            if matches!(running.child.try_wait(), Ok(None)) {
                signal_group(&running.child, SIGKILL);
                let _ = running.child.kill();
            }
            let _ = running.child.wait();
        }
        self.children.clear();
    }
}
