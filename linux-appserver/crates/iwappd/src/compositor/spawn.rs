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

use std::os::unix::process::CommandExt;

use crate::backend::{BackendError, LaunchSpec};

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

    pub fn terminate_all(&mut self) {
        for running in &mut self.children {
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
        self.children.clear();
    }
}
