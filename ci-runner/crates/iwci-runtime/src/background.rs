//! A job's services (`services:`): programs the runner starts beside the
//! job, waits for, and stops once the job has ended.
//!
//! Each service is started the way the job's own first process is
//! ([`Starter`]), on the job's runtime: so on its loopback (a service
//! listening on `127.0.0.1:5432` is what the job connects to), over its
//! files, under its memory limit and watchdog, and counted in its CPU time.
//! Nothing runs on the host. What a service does not share is its WASIX
//! control plane, so its process ids are its own and stopping it touches
//! nothing of the job's, and its `/bin`, `/tmp` and `/dev`, which hold its
//! own environment's commands as a container's would.
//!
//! - **Output.** Both of a service's streams go to the job's stderr, a line
//!   at a time, each after `[service <name>] `, so the scheduler masks them
//!   with everything else the job prints. A partial line waits for the rest
//!   (or the end), so a service's line never lands in the middle of
//!   another's.
//! - **Readiness.** The job starts once every service is ready: started
//!   (no check), listening on a port (the listener table, never a
//!   connection: `wasmer/pglite` serves one client and exits when it
//!   leaves), a line of output matching a pattern, or a probe script in the
//!   service's environment exiting 0. A service that exits first, or is not
//!   ready in time, fails the job without starting it, naming the service.
//! - **While the job runs**, a service that exits is reported in the log
//!   as it happens; whether that fails the job is up to the job.
//! - **Stopping.** When the job's first process ends (passed, failed or
//!   stopped), every process of every service gets SIGTERM, then after
//!   [`STOP_GRACE`] SIGKILL, and is then marked finished whatever it is
//!   doing, so a service never keeps a job alive.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use wasmer_wasix::WasiControlPlane;
use wasmer_wasix::bin_factory::BinaryPackage;
use wasmer_wasix::os::task::TaskJoinHandle;
use wasmer_wasix::wasmer_wasix_types::wasi::{ExitCode, Signal};

use crate::capture::{Capture, Sink, sink_file};
use crate::wasix::{Process, Program, Starter, for_each_process};
use crate::{Error, Ready, Result, Service, ServiceProgram};

/// How often readiness is checked.
const READY_POLL: Duration = Duration::from_millis(25);

/// How long a `ready: { command }` probe waits between attempts, and how
/// long one attempt may take before it counts as failed.
const PROBE_EVERY: Duration = Duration::from_millis(500);
const PROBE_LIMIT: Duration = Duration::from_secs(10);

/// What a probe's output keeps, for the log when the service is never ready.
const PROBE_OUTPUT: usize = 16 << 10;

/// How long services get to exit after SIGTERM, and then after SIGKILL,
/// before they are marked finished regardless.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(2);
const KILL_GRACE: Duration = Duration::from_secs(1);
const KILL_POLL: Duration = Duration::from_millis(20);

/// The longest partial line a service's log holds before passing it on.
const MAX_LINE: usize = 16 << 10;

/// The job's services, once started.
#[derive(Default)]
pub(crate) struct Services {
    running: Vec<Running>,
}

struct Running {
    name: String,
    handle: TaskJoinHandle,
    plane: WasiControlPlane,
    log: Arc<ServiceLog>,
    ready: Ready,
    timeout: Duration,
    started: Instant,
    is_ready: bool,
    /// Said in the log already, so it is said once.
    exit_reported: AtomicBool,
    probe: Option<Probe>,
}

/// A `ready: { command }` check: the service's environment, and the
/// attempt in flight.
struct Probe {
    uses: Vec<BinaryPackage>,
    entry: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: String,
    attempt: Option<Attempt>,
    next: Instant,
    /// How the last attempt ended, and what it printed.
    last: Option<(String, Vec<u8>)>,
}

struct Attempt {
    handle: TaskJoinHandle,
    plane: WasiControlPlane,
    output: Capture,
    started: Instant,
}

impl Services {
    pub(crate) fn is_empty(&self) -> bool {
        self.running.is_empty()
    }

    /// Starts `services` in order, each writing to the job's `stderr`. One
    /// that cannot be started stops those already running.
    pub(crate) fn start(
        starter: &Starter<'_>,
        services: &[Service],
        stderr: &Capture,
        cwd: &str,
    ) -> Result<Self> {
        let mut out = Services::default();
        for service in services {
            match start_one(starter, service, stderr, cwd) {
                Ok(running) => out.running.push(running),
                Err(e) => {
                    out.stop(&|| {});
                    return Err(Error::Setup(format!("service `{}`: {e}", service.name)));
                }
            }
        }
        Ok(out)
    }

    /// Waits until every service is ready. Each has its own `timeout`, from
    /// when it started, within `deadline` (the job's own). The error says
    /// which service failed and how; the log has what it printed.
    pub(crate) fn wait_ready(
        &mut self,
        starter: &Starter<'_>,
        deadline: Instant,
        cancel: Option<&crate::Cancel>,
    ) -> std::result::Result<(), String> {
        loop {
            if cancel.is_some_and(|c| c.is_cancelled()) {
                return Err("the run was cancelled before its services were ready".into());
            }
            let now = Instant::now();
            let mut waiting = false;
            for service in &mut self.running {
                if service.is_ready {
                    continue;
                }
                if let Some(exit) = finished(&service.handle) {
                    service.exit_reported.store(true, Ordering::Relaxed);
                    return Err(format!(
                        "service `{}` {} before it was ready",
                        service.name,
                        describe(&exit)
                    ));
                }
                let ready = match &service.ready {
                    Ready::Started => true,
                    Ready::Port(port) => {
                        starter
                            .listeners
                            .reaches(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), *port))
                            || starter
                                .listeners
                                .reaches(SocketAddr::new(Ipv6Addr::LOCALHOST.into(), *port))
                    }
                    Ready::Log(_) => service.log.matched.load(Ordering::Acquire),
                    Ready::Command(_) => match &mut service.probe {
                        Some(probe) => probe
                            .step(starter, now)
                            .map_err(|e| format!("service `{}`: {e}", service.name))?,
                        None => true,
                    },
                };
                if ready {
                    service.is_ready = true;
                    service.stop_probe();
                    continue;
                }
                let own = service.started + service.timeout;
                if now >= own.min(deadline) {
                    return Err(service.not_ready(now, own > deadline));
                }
                waiting = true;
            }
            if !waiting {
                return Ok(());
            }
            std::thread::sleep(READY_POLL);
        }
    }

    /// Says in the job's log, once, which services have exited while the
    /// job ran.
    pub(crate) fn report_exits(&self, stderr: &Capture) {
        for service in &self.running {
            if service.exit_reported.load(Ordering::Relaxed) {
                continue;
            }
            if let Some(exit) = finished(&service.handle) {
                service.exit_reported.store(true, Ordering::Relaxed);
                service.log.flush();
                stderr.push(
                    format!(
                        "iwci: service `{}` {} while the job ran\n",
                        service.name,
                        describe(&exit)
                    )
                    .as_bytes(),
                );
            }
        }
    }

    /// SIGKILL to every process of every service, for a job being stopped.
    pub(crate) fn kill(&self) {
        for plane in self.planes() {
            for_each_process(&plane, |process| process.signal_process(Signal::Sigkill));
        }
    }

    /// Stops every service (see the module comment) and passes on what is
    /// left of their output. `interrupt` stops the job's guests where they
    /// are (its watchdog), for services that SIGKILL does not end.
    pub(crate) fn stop(&mut self, interrupt: &dyn Fn()) {
        if self.running.is_empty() {
            return;
        }
        let planes = self.planes();
        let alive = || {
            planes.iter().any(|plane| {
                let mut any = false;
                for_each_process(plane, |process| any |= process.try_join().is_none());
                any
            })
        };
        for plane in &planes {
            for_each_process(plane, |process| process.signal_process(Signal::Sigterm));
        }
        let until = Instant::now() + STOP_GRACE;
        while alive() && Instant::now() < until {
            std::thread::sleep(KILL_POLL);
        }
        if alive() {
            let until = Instant::now() + KILL_GRACE;
            loop {
                interrupt();
                self.kill();
                if !alive() || Instant::now() >= until {
                    break;
                }
                std::thread::sleep(KILL_POLL);
            }
            for plane in &planes {
                for_each_process(plane, |process| {
                    process.terminate(ExitCode::from(crate::TIMEOUT_EXIT_CODE as u16))
                });
            }
        }
        for service in &self.running {
            service.log.flush();
        }
        self.running.clear();
    }

    /// Every service's control plane, and its probe's.
    fn planes(&self) -> Vec<WasiControlPlane> {
        let mut planes = Vec::new();
        for service in &self.running {
            planes.push(service.plane.clone());
            if let Some(attempt) = service.probe.as_ref().and_then(|p| p.attempt.as_ref()) {
                planes.push(attempt.plane.clone());
            }
        }
        planes
    }
}

impl Running {
    fn not_ready(&mut self, now: Instant, job_timeout: bool) -> String {
        let waited = now.duration_since(self.started).as_secs();
        let limit = if job_timeout {
            format!("when the job's timeout ran out ({waited}s)")
        } else {
            format!("after {waited}s")
        };
        let why = match &self.ready {
            Ready::Started => "it had not started".to_string(),
            Ready::Port(port) => format!("nothing listened on port {port}"),
            Ready::Log(pattern) => format!("no line of its output matched `{pattern}`"),
            Ready::Command(_) => {
                let last = self.probe.as_mut().and_then(|p| p.last.take());
                match last {
                    Some((how, output)) => {
                        // Through the service's log, so it is masked and
                        // prefixed like the rest of what it printed.
                        for line in output.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
                            let mut text = b"ready check: ".to_vec();
                            text.extend_from_slice(line);
                            self.log.line(&text);
                        }
                        format!("its ready check never passed (the last one {how})")
                    }
                    None => "its ready check never finished".to_string(),
                }
            }
        };
        format!("service `{}` was not ready {limit}: {why}", self.name)
    }

    fn stop_probe(&mut self) {
        if let Some(attempt) = self.probe.as_mut().and_then(|p| p.attempt.take()) {
            kill_now(&attempt.plane);
        }
    }
}

impl Probe {
    /// Moves the check along: whether the last attempt passed, starting the
    /// next one when it is due.
    fn step(&mut self, starter: &Starter<'_>, now: Instant) -> Result<bool> {
        if let Some(attempt) = &self.attempt {
            if let Some(exit) = finished(&attempt.handle) {
                let passed = matches!(&exit, Exit::Code(0));
                self.last = Some((describe(&exit), attempt.output.take().bytes));
                self.attempt = None;
                if passed {
                    return Ok(true);
                }
                self.next = now + PROBE_EVERY;
            } else if now.duration_since(attempt.started) >= PROBE_LIMIT {
                kill_now(&attempt.plane);
                self.last = Some((
                    format!("ran past {}s and was stopped", PROBE_LIMIT.as_secs()),
                    attempt.output.take().bytes,
                ));
                self.attempt = None;
                self.next = now + PROBE_EVERY;
            }
            return Ok(false);
        }
        if now >= self.next {
            let output = Capture::new(PROBE_OUTPUT);
            let (handle, plane) = starter.start(Process {
                name: &self.entry,
                program: Program::Command {
                    uses: self.uses.clone(),
                    name: self.entry.clone(),
                },
                args: self.args.clone(),
                env: self.env.clone(),
                cwd: &self.cwd,
                commands: &[],
                stdout: output.file(),
                stderr: output.file(),
                own_dirs: true,
            })?;
            self.attempt = Some(Attempt {
                handle,
                plane,
                output,
                started: now,
            });
        }
        Ok(false)
    }
}

fn start_one(
    starter: &Starter<'_>,
    service: &Service,
    stderr: &Capture,
    cwd: &str,
) -> Result<Running> {
    let pattern = match &service.ready {
        Ready::Log(pattern) => Some(
            regex::bytes::RegexBuilder::new(pattern)
                .size_limit(1 << 20)
                .build()
                .map_err(|e| Error::InvalidInput(format!("`ready: log` pattern: {e}")))?,
        ),
        _ => None,
    };
    let log = Arc::new(ServiceLog {
        prefix: format!("[service {}] ", service.name).into_bytes(),
        job: stderr.clone(),
        pattern,
        matched: AtomicBool::new(false),
        pending: Mutex::default(),
    });
    let mut env = service.env.clone();
    let (name, program, args, probe) = match &service.program {
        ServiceProgram::Command { module, args } => {
            if matches!(service.ready, Ready::Command(_)) {
                return Err(Error::InvalidInput(
                    "a `ready: command` check runs in an environment, which a tool has not".into(),
                ));
            }
            let compiled =
                starter
                    .shared
                    .store
                    .get(starter.generation, module.sha256, &module.bytes)?;
            (
                module.name.clone(),
                Program::Module(compiled),
                args.clone(),
                None,
            )
        }
        ServiceProgram::Script {
            packages,
            entry,
            script,
        } => {
            if !env.iter().any(|(k, _)| k == "PATH") {
                env.push(("PATH".into(), crate::DEFAULT_PATH.into()));
            }
            crate::script_shell(&mut env, entry);
            if starter.node {
                let options = crate::wasix::node_options(&env);
                env.retain(|(k, _)| k != "NODE_OPTIONS");
                env.push(("NODE_OPTIONS".into(), options));
            }
            let uses = starter.load(packages, &env)?;
            let probe = match &service.ready {
                Ready::Command(check) => Some(Probe {
                    uses: uses.clone(),
                    entry: entry.clone(),
                    args: crate::script_args(entry, check),
                    env: env.clone(),
                    cwd: cwd.to_string(),
                    attempt: None,
                    next: Instant::now(),
                    last: None,
                }),
                _ => None,
            };
            (
                entry.clone(),
                Program::Command {
                    uses,
                    name: entry.clone(),
                },
                crate::script_args(entry, script),
                probe,
            )
        }
    };
    let (handle, plane) = starter.start(Process {
        name: &name,
        program,
        args,
        env,
        cwd,
        commands: &[],
        stdout: sink_file(LogStream(log.clone(), 0)),
        stderr: sink_file(LogStream(log.clone(), 1)),
        own_dirs: true,
    })?;
    Ok(Running {
        name: service.name.clone(),
        handle,
        plane,
        log,
        ready: service.ready.clone(),
        timeout: service.ready_timeout,
        started: Instant::now(),
        is_ready: false,
        exit_reported: AtomicBool::new(false),
        probe,
    })
}

/// SIGKILL to every process of `plane`, then finished regardless: for a
/// probe, which has nothing to say on its way out.
fn kill_now(plane: &WasiControlPlane) {
    for_each_process(plane, |process| {
        process.signal_process(Signal::Sigkill);
        process.terminate(ExitCode::from(crate::TIMEOUT_EXIT_CODE as u16));
    });
}

/// How a process ended.
enum Exit {
    Code(i32),
    Crashed(String),
}

fn finished(handle: &TaskJoinHandle) -> Option<Exit> {
    let result = handle.status().into_finished()?;
    Some(match result {
        Ok(code) => Exit::Code(code.raw()),
        Err(err) => match err.as_exit_code() {
            Some(code) => Exit::Code(code.raw()),
            None => Exit::Crashed(err.to_string()),
        },
    })
}

fn describe(exit: &Exit) -> String {
    match exit {
        Exit::Code(code) => format!("exited with {code}"),
        Exit::Crashed(error) => format!("crashed ({error})"),
    }
}

/// A service's output on its way into the job's stderr. See the module
/// comment.
#[derive(Debug)]
struct ServiceLog {
    /// `[service <name>] `.
    prefix: Vec<u8>,
    job: Capture,
    /// `ready: { log }`, and whether a line has matched it.
    pattern: Option<regex::bytes::Regex>,
    matched: AtomicBool,
    /// A partial line per stream.
    pending: Mutex<[Vec<u8>; 2]>,
}

impl ServiceLog {
    fn push(&self, stream: usize, data: &[u8]) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let buf = &mut pending[stream];
        buf.extend_from_slice(data);
        while let Some(end) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=end).collect();
            self.line(&line[..line.len() - 1]);
        }
        if buf.len() > MAX_LINE {
            let line = std::mem::take(buf);
            self.line(&line);
        }
    }

    fn line(&self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(pattern) = &self.pattern
            && !self.matched.load(Ordering::Relaxed)
            && pattern.is_match(line)
        {
            self.matched.store(true, Ordering::Release);
        }
        let mut out = Vec::with_capacity(self.prefix.len() + line.len() + 1);
        out.extend_from_slice(&self.prefix);
        out.extend_from_slice(line);
        out.push(b'\n');
        self.job.push(&out);
    }

    fn flush(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        for buf in pending.iter_mut() {
            if !buf.is_empty() {
                let line = std::mem::take(buf);
                self.line(&line);
            }
        }
    }
}

/// One of a service's streams (0 stdout, 1 stderr).
#[derive(Debug)]
struct LogStream(Arc<ServiceLog>, usize);

impl Sink for LogStream {
    fn push(&self, data: &[u8]) {
        self.0.push(self.1, data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(pattern: Option<&str>) -> (Arc<ServiceLog>, Capture) {
        let job = Capture::new(1 << 20);
        let log = Arc::new(ServiceLog {
            prefix: b"[service db] ".to_vec(),
            job: job.clone(),
            pattern: pattern.map(|p| regex::bytes::Regex::new(p).unwrap()),
            matched: AtomicBool::new(false),
            pending: Mutex::default(),
        });
        (log, job)
    }

    #[test]
    fn a_services_lines_reach_the_job_whole_and_prefixed() {
        let (log, job) = log(Some("READY [0-9]+$"));
        log.push(0, b"start");
        log.push(1, b"warn: a\r\n");
        assert!(!log.matched.load(Ordering::Acquire));
        log.push(0, b"ing\nREADY 54");
        // A line is only checked once it is whole.
        assert!(!log.matched.load(Ordering::Acquire));
        log.push(0, b"32\nlast");
        assert!(log.matched.load(Ordering::Acquire));
        log.flush();
        assert_eq!(
            String::from_utf8(job.take().bytes).unwrap(),
            "[service db] warn: a\n[service db] starting\n[service db] READY 5432\n[service db] last\n"
        );
    }

    #[test]
    fn a_line_with_no_end_is_passed_on_in_pieces() {
        let (log, job) = log(None);
        log.push(0, &vec![b'x'; MAX_LINE + 1]);
        let out = job.take().bytes;
        assert!(out.starts_with(b"[service db] xxx") && out.ends_with(b"x\n"));
    }
}
