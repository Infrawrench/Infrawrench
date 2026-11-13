//! Cloud jobs: a job with `cloud:` runs on one of the organisation's
//! connected cloud accounts, not on the runner.
//!
//! The runner keeps the pipeline graph (needs, `if:`, outputs, artifacts,
//! matrices, cancellation) and only hands over the job's execution. When
//! the job is ready it waits here as `external`, taking no slot and no
//! memory, until its executor (the app, which holds the cloud credentials)
//! claims it:
//!
//! 1. `POST /v1/runs/{id}/jobs/{job}/claim` gives the executor the job's
//!    spec, its environment with secrets filled in, a claim token, and the
//!    URLs its machine fetches the job's input artifacts from and uploads
//!    its own to (each carries the token, so the app can hand them to the
//!    machine without the runner's key).
//! 2. `POST .../log` sends output as it comes; every call, an empty one
//!    too, renews the claim's lease. The runner masks it like a local
//!    job's output before it reaches the live log or the report.
//! 3. `POST .../finish` says how it went: status, exit code, the text of
//!    `$IWCI_OUTPUT`, changed paths for `changes: fail`. The runner checks
//!    and masks it and carries on with the graph.
//!
//! A job nobody claims, a claim whose lease runs out, and a claimed job
//! past its timeout (plus [`BOOT_SECS`] for the machine to start) end on
//! the runner's side; so does a cancelled run. The executor learns it from
//! its next call, which answers `409` with the state, and tears down.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use iwci_spec::{ChangePolicy, CloneDepth, CloneSpec, CloudSpec};
use iwci_vfs::Entry;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::schedule::{ChangedFile, OutputSink};

/// How long a claim lasts without a call from its executor.
pub const LEASE_SECS: u64 = 300;
/// What a claimed job gets on top of its `timeout:` for its machine to
/// start: the executor holds the job itself to `timeout:` once it runs.
pub const BOOT_SECS: u64 = 600;
/// The least a cloud job waits to be claimed (or its `timeout:`, if
/// longer): an executor may queue it behind the organisation's limits.
pub const CLAIM_WAIT_SECS: u64 = 600;
/// The most of each stream a cloud job's report keeps.
pub const MAX_LOG_BYTES: usize = 16 << 20;
/// Cloud jobs of one run that wait or run at once.
pub const MAX_EXTERNAL: usize = 64;

/// Why a cloud job of an untrusted run fails.
pub const UNTRUSTED: &str = "Cloud jobs only run for trusted runs: this is a pull request from a fork, or the caller did not vouch for it.";

/// A cloud job, ready to hand over.
pub struct ExternalJob {
    pub id: String,
    pub name: String,
    pub cloud: CloudSpec,
    pub script: String,
    pub cwd: String,
    /// The job's whole environment, secrets and lent values filled in.
    pub env: Vec<(String, String)>,
    /// Which of `env`'s keys carry secret values.
    pub secret_keys: Vec<String>,
    /// Lent files: path, mode, content.
    pub files: Vec<(PathBuf, u32, Vec<u8>)>,
    pub timeout: Duration,
    pub outputs: Vec<String>,
    pub artifacts: Vec<String>,
    pub changes: ChangePolicy,
    pub clone: Option<CloneSpec>,
    /// What the jobs it needs kept, oldest first.
    pub inputs: Vec<(String, Arc<Vec<Entry>>)>,
    /// The most its uploaded artifacts may hold.
    pub max_artifact_bytes: u64,
    /// Called once, when it is claimed.
    pub on_claim: Box<dyn Fn() + Send + Sync>,
    /// Its output as it arrives; masked by the sink.
    pub log: Option<OutputSink>,
}

/// How a cloud job ended.
#[derive(Debug, Clone, PartialEq)]
pub enum End {
    /// Its executor said: `finish`.
    Finished(Finish),
    Cancelled,
    /// Never claimed, or its lease ran out: why.
    Lost(String),
    /// Claimed, and past its timeout and the time to start a machine.
    TimedOut,
}

/// What came back of a cloud job.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub end: End,
    /// Unmasked, as the executor sent them: the scheduler masks them.
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    /// What its machine uploaded under its `artifacts:` paths.
    pub artifacts: Vec<Entry>,
    /// From claim to end; `None` if it was never claimed.
    pub claimed_for: Option<Duration>,
    pub executor: Option<String>,
}

/// `POST .../finish`'s body.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    /// The token `claim` gave; without one, only an unclaimed job can be
    /// finished, and only with `error` (no connection to run it on).
    #[serde(default)]
    pub claim: Option<String>,
    pub status: FinishStatus,
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// The text of the file at `$IWCI_OUTPUT`.
    #[serde(default)]
    pub output: Option<String>,
    /// Why it failed, or why the executor could not run it.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub timed_out: bool,
    /// What it changed under the clone, for `changes: fail`.
    #[serde(default)]
    pub changes: Vec<FinishChange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinishStatus {
    /// Its script exited 0.
    Passed,
    /// Its script failed or timed out.
    Failed,
    /// The executor could not run it: no opted-in connection, a machine
    /// that would not start.
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinishChange {
    pub path: String,
    /// `added`, `modified` or `deleted`.
    pub kind: String,
}

impl FinishChange {
    pub fn changed_file(&self) -> ChangedFile {
        ChangedFile {
            path: self.path.clone(),
            kind: match self.kind.as_str() {
                "added" => "added",
                "deleted" => "deleted",
                _ => "modified",
            },
        }
    }
}

/// Hands a run's cloud jobs over and waits for them.
pub trait External: Send + Sync {
    fn run(&self, job: ExternalJob, cancel: Option<&iwci_runtime::Cancel>) -> Outcome;
}

/// The commit a run's cloud jobs start from.
#[derive(Debug, Clone, Default)]
pub struct RunInfo {
    pub run_id: String,
    /// The pipeline file the jobs are of (`request` for a pipeline sent as
    /// text).
    pub pipeline: String,
    /// Without credentials.
    pub repo: String,
    pub sha: String,
    pub branch: String,
    pub git_ref: String,
}

/// `url` without a `user:password@` part.
pub fn without_credentials(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
            let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
            if path.is_empty() && !rest.contains('/') {
                format!("{scheme}://{host}")
            } else {
                format!("{scheme}://{host}/{path}")
            }
        }
        None => url.rsplit_once('@').map_or(url, |(_, h)| h).to_string(),
    }
}

/// Every cloud job this runner is waiting on, by run and job id. The server
/// keeps one; each run hands its jobs over through a [`RunExternal`].
#[derive(Default)]
pub struct ExternalJobs {
    runs: Mutex<HashMap<String, HashMap<String, Arc<Slot>>>>,
}

struct Slot {
    run: RunInfo,
    job: ExternalJob,
    state: Mutex<SlotState>,
    changed: Condvar,
}

enum Phase {
    Waiting {
        since: Instant,
    },
    Claimed {
        token: String,
        at: Instant,
        lease_until: Instant,
    },
    Done(&'static str),
}

struct SlotState {
    phase: Phase,
    finish: Option<Finish>,
    out: [String; 2],
    truncated: bool,
    artifacts: Vec<Entry>,
    executor: Option<String>,
    claimed_at: Option<Instant>,
}

/// A refusal of the HTTP API: status and body.
pub type Refusal = (u16, Value);

fn refusal(status: u16, error: impl Into<String>, state: Option<&str>) -> Refusal {
    let mut body = json!({ "error": error.into() });
    if let Some(state) = state {
        body["state"] = json!(state);
    }
    (status, body)
}

fn token_matches(given: &str, token: &str) -> bool {
    given.len() == token.len()
        && given
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn mode_text(mode: u32) -> String {
    format!("{mode:o}")
}

fn job_path(run: &str, job: &str) -> String {
    format!("/v1/runs/{run}/jobs/{}", percent_encode(job))
}

/// A job id as one path segment: matrix and package ids have `[`, `,`,
/// `/` and `]` in them.
pub fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A path segment, percent-decoded.
pub fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

impl Slot {
    fn state_word(phase: &Phase) -> &'static str {
        match phase {
            Phase::Waiting { .. } => "external",
            Phase::Claimed { .. } => "claimed",
            Phase::Done(word) => word,
        }
    }

    /// The job as the app sees it before it claims it: nothing secret.
    fn describe(&self, state: &SlotState) -> Value {
        let job = &self.job;
        let files: u64 = job
            .inputs
            .iter()
            .map(|(_, e)| e.iter().filter(|e| matches!(e, Entry::File { .. })).count() as u64)
            .sum();
        let bytes: u64 = job
            .inputs
            .iter()
            .flat_map(|(_, e)| e.iter())
            .map(|e| match e {
                Entry::File { data, .. } => data.len() as u64,
                _ => 0,
            })
            .sum();
        json!({
            "run": self.run.run_id,
            "job": job.id,
            "name": job.name,
            "pipeline": self.run.pipeline,
            "state": Self::state_word(&state.phase),
            "cloud": job.cloud,
            "commit": {
                "repo": self.run.repo,
                "sha": self.run.sha,
                "branch": self.run.branch,
                "ref": self.run.git_ref,
            },
            "clone": job.clone.as_ref().map(|c| json!({
                "depth": match c.depth {
                    CloneDepth::Shallow(n) => json!(n),
                    CloneDepth::Full => json!("full"),
                },
                "into": c.into,
            })),
            "cwd": job.cwd,
            "script": job.script,
            "env_keys": job.env.iter().map(|(k, _)| k).collect::<Vec<_>>(),
            "secret_env": job.secret_keys,
            "files": job.files.iter().map(|(p, m, d)| json!({
                "path": p.display().to_string(),
                "mode": mode_text(*m),
                "bytes": d.len(),
            })).collect::<Vec<_>>(),
            "timeout_secs": job.timeout.as_secs(),
            "deadline_secs": job.timeout.as_secs() + BOOT_SECS,
            "lease_secs": LEASE_SECS,
            "outputs": job.outputs,
            "changes": match job.changes {
                ChangePolicy::Fail => "fail",
                _ => "ignore",
            },
            "inputs": (files > 0).then(|| json!({ "files": files, "bytes": bytes })),
            "artifacts": (!job.artifacts.is_empty()).then(|| json!({
                "paths": job.artifacts,
                "max_bytes": job.max_artifact_bytes,
            })),
        })
    }
}

impl ExternalJobs {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(&self, run: &str, job: &str) -> Result<Arc<Slot>, Refusal> {
        self.runs
            .lock()
            .unwrap()
            .get(run)
            .and_then(|jobs| jobs.get(job))
            .cloned()
            .ok_or_else(|| {
                refusal(
                    404,
                    "no cloud job by that id in that run on this runner",
                    None,
                )
            })
    }

    /// Drops a finished run's jobs: calls about them answer `404` from now.
    pub fn forget_run(&self, run: &str) {
        self.runs.lock().unwrap().remove(run);
    }

    /// Every cloud job of a run, and its state.
    pub fn list(&self, run: &str) -> Vec<Value> {
        let jobs: Vec<Arc<Slot>> = self
            .runs
            .lock()
            .unwrap()
            .get(run)
            .map(|j| j.values().cloned().collect())
            .unwrap_or_default();
        let mut out: Vec<Value> = jobs
            .iter()
            .map(|s| s.describe(&s.state.lock().unwrap()))
            .collect();
        out.sort_by(|a, b| a["job"].as_str().cmp(&b["job"].as_str()));
        out
    }

    /// `GET /v1/runs/{id}/jobs/{job}`.
    pub fn describe(&self, run: &str, job: &str) -> Result<Value, Refusal> {
        let slot = self.slot(run, job)?;
        let state = slot.state.lock().unwrap();
        Ok(slot.describe(&state))
    }

    /// `POST .../claim`: the spec, the environment with its secrets, the
    /// files, and a token for the rest.
    pub fn claim(&self, run: &str, job: &str, executor: Option<String>) -> Result<Value, Refusal> {
        let slot = self.slot(run, job)?;
        let mut state = slot.state.lock().unwrap();
        match &state.phase {
            Phase::Waiting { .. } => {}
            Phase::Claimed { .. } => {
                return Err(refusal(409, "already claimed", Some("claimed")));
            }
            Phase::Done(word) => return Err(refusal(409, format!("it is {word}"), Some(word))),
        }
        let token = crate::runner::random_id();
        let now = Instant::now();
        state.phase = Phase::Claimed {
            token: token.clone(),
            at: now,
            lease_until: now + Duration::from_secs(LEASE_SECS),
        };
        state.claimed_at = Some(now);
        state.executor = executor.filter(|e| !e.trim().is_empty()).map(|e| {
            let mut e: String = e.chars().filter(|c| !c.is_control()).take(200).collect();
            e.truncate(e.trim_end().len());
            e
        });
        let mut body = slot.describe(&state);
        let base = job_path(run, job);
        let job_spec = &slot.job;
        body["claim"] = json!(token);
        body["env"] = json!(
            job_spec
                .env
                .iter()
                .cloned()
                .collect::<std::collections::BTreeMap<_, _>>()
        );
        body["files"] = json!(
            job_spec
                .files
                .iter()
                .map(|(p, m, d)| json!({
                    "path": p.display().to_string(),
                    "mode": mode_text(*m),
                    "content": String::from_utf8_lossy(d),
                }))
                .collect::<Vec<_>>()
        );
        if let Some(inputs) = body.get_mut("inputs").filter(|v| !v.is_null()) {
            inputs["url"] = json!(format!("{base}/inputs?claim={token}"));
        }
        if let Some(artifacts) = body.get_mut("artifacts").filter(|v| !v.is_null()) {
            artifacts["url"] = json!(format!("{base}/artifacts?claim={token}"));
        }
        drop(state);
        slot.changed.notify_all();
        (slot.job.on_claim)();
        Ok(body)
    }

    /// The claim behind `token`, renewed, or why not.
    fn renew(state: &mut SlotState, token: &str) -> Result<(), Refusal> {
        match &mut state.phase {
            Phase::Claimed {
                token: held,
                lease_until,
                ..
            } => {
                if !token_matches(token, held) {
                    return Err(refusal(403, "that is not this job's claim", None));
                }
                *lease_until = Instant::now() + Duration::from_secs(LEASE_SECS);
                Ok(())
            }
            Phase::Waiting { .. } => Err(refusal(409, "it is not claimed", Some("external"))),
            Phase::Done(word) => Err(refusal(409, format!("it is {word}"), Some(word))),
        }
    }

    /// `POST .../log`: output (or nothing, a heartbeat), which renews the
    /// lease.
    pub fn log(
        &self,
        run: &str,
        job: &str,
        token: &str,
        stream: &str,
        text: &str,
    ) -> Result<Value, Refusal> {
        let stderr = match stream {
            "stdout" => false,
            "stderr" => true,
            other => {
                return Err(refusal(
                    400,
                    format!("stream is `stdout` or `stderr`, not `{other}`"),
                    None,
                ));
            }
        };
        let slot = self.slot(run, job)?;
        let mut state = slot.state.lock().unwrap();
        Self::renew(&mut state, token)?;
        if !text.is_empty() {
            let buf = &mut state.out[usize::from(stderr)];
            if buf.len() + text.len() <= MAX_LOG_BYTES {
                buf.push_str(text);
            } else {
                state.truncated = true;
            }
            if let Some(log) = &slot.job.log {
                log(stderr, text.as_bytes());
            }
        }
        Ok(json!({ "state": "claimed", "lease_secs": LEASE_SECS }))
    }

    /// `POST .../finish`.
    pub fn finish(&self, run: &str, job: &str, finish: Finish) -> Result<Value, Refusal> {
        let slot = self.slot(run, job)?;
        let mut state = slot.state.lock().unwrap();
        match (&finish.claim, &state.phase) {
            (Some(token), _) => Self::renew(&mut state, token)?,
            (None, Phase::Waiting { .. }) if finish.status == FinishStatus::Error => {}
            (None, Phase::Waiting { .. }) => {
                return Err(refusal(
                    400,
                    "an unclaimed job can only be finished with `status: error` and the reason",
                    None,
                ));
            }
            (None, _) => return Err(refusal(400, "give the job's `claim`", None)),
        }
        for text in [&finish.output, &finish.error] {
            if text
                .as_ref()
                .is_some_and(|t| t.len() > crate::schedule::MAX_OUTPUT_BYTES)
            {
                return Err(refusal(413, "over 1 MiB", None));
            }
        }
        if finish.changes.len() > 10_000 {
            return Err(refusal(413, "over 10000 changes", None));
        }
        state.finish = Some(finish);
        state.phase = Phase::Done("finished");
        drop(state);
        slot.changed.notify_all();
        Ok(json!({ "state": "finished" }))
    }

    /// `GET .../inputs?claim=`: the input artifacts as a tar archive,
    /// paths relative to `/`.
    pub fn inputs(&self, run: &str, job: &str, token: &str) -> Result<Vec<u8>, Refusal> {
        let slot = self.slot(run, job)?;
        Self::renew(&mut slot.state.lock().unwrap(), token)?;
        let mut tar = tar::Builder::new(Vec::new());
        let fail = |e: std::io::Error| refusal(500, format!("archive: {e}"), None);
        for (_, entries) in &slot.job.inputs {
            for entry in entries.iter() {
                let mut header = tar::Header::new_gnu();
                match entry {
                    Entry::Dir { path } => {
                        header.set_entry_type(tar::EntryType::Directory);
                        header.set_mode(0o755);
                        header.set_size(0);
                        tar.append_data(&mut header, relative(path), std::io::empty())
                            .map_err(fail)?;
                    }
                    Entry::File { path, data } => {
                        header.set_entry_type(tar::EntryType::Regular);
                        header.set_mode(0o644);
                        header.set_size(data.len() as u64);
                        tar.append_data(&mut header, relative(path), &data[..])
                            .map_err(fail)?;
                    }
                    Entry::Symlink { path, target } => {
                        header.set_entry_type(tar::EntryType::Symlink);
                        header.set_mode(0o777);
                        header.set_size(0);
                        tar.append_link(&mut header, relative(path), target)
                            .map_err(fail)?;
                    }
                }
            }
        }
        tar.into_inner().map_err(fail)
    }

    /// `PUT .../artifacts?claim=`: the job's artifacts as a tar archive,
    /// paths relative to `/`, each under one of its `artifacts:` paths. A
    /// second upload replaces the first. Kept only if the job passes.
    pub fn upload(
        &self,
        run: &str,
        job: &str,
        token: &str,
        body: &mut dyn Read,
    ) -> Result<Value, Refusal> {
        let slot = self.slot(run, job)?;
        Self::renew(&mut slot.state.lock().unwrap(), token)?;
        let limit = slot.job.max_artifact_bytes;
        let entries =
            read_upload(body, &slot.job.artifacts, limit).map_err(|e| refusal(400, e, None))?;
        let files = entries
            .iter()
            .filter(|e| matches!(e, Entry::File { .. }))
            .count();
        let bytes: u64 = entries
            .iter()
            .map(|e| match e {
                Entry::File { data, .. } => data.len() as u64,
                _ => 0,
            })
            .sum();
        let mut state = slot.state.lock().unwrap();
        Self::renew(&mut state, token)?;
        state.artifacts = entries;
        Ok(json!({ "files": files, "bytes": bytes }))
    }
}

/// A guest path as a tar path: relative to `/`.
fn relative(path: &Path) -> &Path {
    path.strip_prefix("/").unwrap_or(path)
}

/// The entries of an uploaded tar archive, each under one of `allowed`
/// (absolute guest paths), at most `limit` bytes of files together.
pub fn read_upload(
    body: &mut dyn Read,
    allowed: &[String],
    limit: u64,
) -> Result<Vec<Entry>, String> {
    let mut archive = tar::Archive::new(body.take(limit.saturating_add(64 << 20)));
    let mut out = Vec::new();
    let mut total = 0u64;
    let entries = archive
        .entries()
        .map_err(|e| format!("not a tar archive: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("not a tar archive: {e}"))?;
        let raw = entry
            .path()
            .map_err(|e| format!("an entry's path: {e}"))?
            .into_owned();
        let shown = raw.display().to_string();
        if shown.split('/').any(|c| c == "..") {
            return Err(format!("`{shown}` climbs out with `..`"));
        }
        let path = iwci_vfs::normalise(Path::new("/").join(&raw))
            .map_err(|_| format!("`{shown}` is not a path"))?;
        if path == Path::new("/") {
            continue;
        }
        let under = allowed
            .iter()
            .any(|a| path.starts_with(a) || Path::new(a).starts_with(&path));
        if !under {
            return Err(format!(
                "`{}` is under none of the job's `artifacts:` paths",
                path.display()
            ));
        }
        // A parent of an artifact path (`/app` for `/app/out`) is only
        // a directory on the way: kept as one, never as content.
        let inside = allowed.iter().any(|a| path.starts_with(a));
        match entry.header().entry_type() {
            tar::EntryType::Directory => out.push(Entry::Dir { path }),
            tar::EntryType::Regular | tar::EntryType::Continuous if inside => {
                let size = entry.header().size().unwrap_or(0);
                total = total.saturating_add(size);
                if total > limit {
                    return Err(format!(
                        "the artifacts are over the run's `scratch:` room of {} KiB",
                        limit.div_ceil(1024)
                    ));
                }
                let mut data = Vec::with_capacity(size.min(64 << 20) as usize);
                entry
                    .read_to_end(&mut data)
                    .map_err(|e| format!("`{}`: {e}", path.display()))?;
                out.push(Entry::File {
                    path,
                    data: data.into(),
                });
            }
            tar::EntryType::Symlink if inside => {
                let target = entry
                    .link_name()
                    .map_err(|e| format!("`{}`: {e}", path.display()))?
                    .ok_or_else(|| format!("`{}` links nowhere", path.display()))?
                    .into_owned();
                out.push(Entry::Symlink { path, target });
            }
            _ => {
                return Err(format!(
                    "`{}` is not a file, directory or symbolic link under an artifact path",
                    path.display()
                ));
            }
        }
    }
    Ok(out)
}

/// One run's handle on the registry: what [`crate::schedule`] hands its
/// cloud jobs to.
pub struct RunExternal {
    pub jobs: Arc<ExternalJobs>,
    pub run: RunInfo,
}

impl External for RunExternal {
    fn run(&self, job: ExternalJob, cancel: Option<&iwci_runtime::Cancel>) -> Outcome {
        let id = job.id.clone();
        let claim_wait = Duration::from_secs(CLAIM_WAIT_SECS.max(job.timeout.as_secs()));
        let deadline = job.timeout + Duration::from_secs(BOOT_SECS);
        let slot = Arc::new(Slot {
            run: self.run.clone(),
            job,
            state: Mutex::new(SlotState {
                phase: Phase::Waiting {
                    since: Instant::now(),
                },
                finish: None,
                out: Default::default(),
                truncated: false,
                artifacts: Vec::new(),
                executor: None,
                claimed_at: None,
            }),
            changed: Condvar::new(),
        });
        self.jobs
            .runs
            .lock()
            .unwrap()
            .entry(self.run.run_id.clone())
            .or_default()
            .insert(id.clone(), slot.clone());
        if let Some(cancel) = cancel {
            let weak = Arc::downgrade(&slot);
            cancel.on_cancel(move || {
                if let Some(slot) = weak.upgrade() {
                    slot.changed.notify_all();
                }
            });
        }
        let mut state = slot.state.lock().unwrap();
        let end = loop {
            let now = Instant::now();
            if cancel.is_some_and(|c| c.is_cancelled()) && !matches!(state.phase, Phase::Done(_)) {
                state.phase = Phase::Done("cancelled");
                break End::Cancelled;
            }
            match &state.phase {
                Phase::Done(_) => {
                    break match state.finish.clone() {
                        Some(f) => End::Finished(f),
                        None => End::Cancelled,
                    };
                }
                Phase::Waiting { since } if now >= *since + claim_wait => {
                    state.phase = Phase::Done("lost");
                    break End::Lost(format!(
                        "nothing claimed it in {} minutes: is a connection for `{}` opted in to cloud jobs for this repository?",
                        claim_wait.as_secs() / 60,
                        slot.job.cloud.provider
                    ));
                }
                Phase::Claimed { lease_until, .. } if now >= *lease_until => {
                    state.phase = Phase::Done("lost");
                    break End::Lost(format!(
                        "lost: its executor sent nothing for {} minutes",
                        LEASE_SECS / 60
                    ));
                }
                Phase::Claimed { at, .. } if now >= *at + deadline => {
                    state.phase = Phase::Done("timed-out");
                    break End::TimedOut;
                }
                _ => {}
            }
            state = slot
                .changed
                .wait_timeout(state, Duration::from_secs(1))
                .unwrap()
                .0;
        };
        slot.changed.notify_all();
        let [stdout, stderr] = std::mem::take(&mut state.out);
        Outcome {
            end,
            stdout,
            stderr,
            truncated: state.truncated,
            artifacts: std::mem::take(&mut state.artifacts),
            claimed_for: state.claimed_at.map(|at| at.elapsed()),
            executor: state.executor.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_never_reach_the_spec() {
        assert_eq!(
            without_credentials("https://x-access-token:ghs_abc@github.com/acme/web.git"),
            "https://github.com/acme/web.git"
        );
        assert_eq!(
            without_credentials("https://github.com/acme/web"),
            "https://github.com/acme/web"
        );
        assert_eq!(without_credentials("https://u:p@host"), "https://host");
    }

    #[test]
    fn job_ids_survive_a_path_segment() {
        for id in ["build", "build[app/web]", "test[linux,strict]", "a%b"] {
            assert_eq!(percent_decode(&percent_encode(id)).unwrap(), id);
        }
        assert_eq!(percent_encode("build[app/web]"), "build%5Bapp%2Fweb%5D");
        assert!(percent_decode("bad%zz").is_none());
    }

    fn tar_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            tar.append_data(&mut header, path, *data).unwrap();
        }
        tar.into_inner().unwrap()
    }

    #[test]
    fn an_upload_keeps_only_files_under_the_artifact_paths() {
        let allowed = vec!["/app/out".to_string()];
        let body = tar_of(&[("app/out/sbom.json", b"{}"), ("app/out/x/y", b"z")]);
        let entries = read_upload(&mut &body[..], &allowed, 1 << 20).unwrap();
        assert_eq!(entries.len(), 2);
        let outside = tar_of(&[("root/.ssh/id_deploy", b"key")]);
        assert!(
            read_upload(&mut &outside[..], &allowed, 1 << 20)
                .unwrap_err()
                .contains("under none of the job's `artifacts:` paths")
        );
        let big = tar_of(&[("app/out/big", &[0u8; 2048])]);
        assert!(
            read_upload(&mut &big[..], &allowed, 1024)
                .unwrap_err()
                .contains("scratch")
        );
        assert!(read_upload(&mut &b"not a tar"[..], &allowed, 1024).is_err());
    }
}
