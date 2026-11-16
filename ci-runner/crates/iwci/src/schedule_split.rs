//! One run on more than one runner (`split:`).
//!
//! The runner that has a run (the primary) and each runner helping it (a
//! helper) plan the same run from the same request, so they have the same
//! jobs, the same order and the same task cache keys. What they share is
//! a [`Split`]: a few small objects per job in the store every runner
//! reads.
//!
//! - **A job is run by whoever claims it first.** A task cache hit needs
//!   no claim: every runner replays it. A job that missed is claimed just
//!   before it starts, and the claim is a write that only one runner can
//!   make. The loser keeps the job in its graph as *remote*.
//! - **A finished job leaves a [`Done`]**: its report, masked, and where
//!   what it kept is. The other runners complete the job from it, so their
//!   dependents become ready as if it had run there.
//! - **Artifacts cross through the task cache entry** the job saved, or,
//!   for a job without one, as an object of their own when they are small
//!   enough (`split: { artifacts }`). What does not cross stays where it
//!   ran, and so do the jobs that need it.
//! - **A helper only ever uses what its own runs leave** ([`spare`]): a
//!   free slot and free memory while none of its runs' jobs wait for
//!   either, and a job it took gives way the moment one does
//!   ([`Helping`]). It hands that job back rather than report it.
//! - **The primary can always finish alone.** It takes back a job whose
//!   holder stopped answering, handed it back, or outlasted its timeout,
//!   and runs again one whose artifacts it cannot get. A store that does
//!   not answer is a job run here.
//!
//! Only a pipeline that says `split:` is shared: the run's scratch
//! directory does not cross runners, and nothing in a pipeline says
//! whether its jobs use it.

use super::*;

/// How a claim went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// This runner holds it now.
    Ours,
    /// The runner of that name wrote it first.
    Held(String),
}

/// What the runners of a run have written, as one look finds it.
#[derive(Debug, Clone, Default)]
pub struct Seen {
    /// The jobs with a [`Done`], by id.
    pub done: Vec<String>,
    /// Jobs a helper gave up after claiming them: the job, the helper, and
    /// a number that tells one time from the next.
    pub back: Vec<(String, String, u64)>,
    /// The primary is finished with the pipeline, or cancelled it.
    pub ended: bool,
    /// A number the primary changes for as long as it is alive.
    pub primary: Option<u64>,
    /// The same for each helper, by its name.
    pub helpers: HashMap<String, u64>,
}

/// How often a split run looks, and how long it waits.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// Between looks at what the other runners wrote.
    pub poll: Duration,
    /// How long a job the primary could share has to wait in its queue
    /// before the primary asks for help.
    pub ask_after: Duration,
    /// How long a runner may go without a sign of life before the others
    /// count it gone.
    pub lease: Duration,
    /// Between a helper's looks at a run that has not asked it for help.
    pub offer: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(1),
            ask_after: Duration::from_secs(2),
            lease: Duration::from_secs(45),
            offer: Duration::from_secs(5),
        }
    }
}

/// What the runners of one pipeline of a run share. An implementation
/// decides where it lives (`adapters::split` keeps it in the object
/// store) and keeps its own sign of life going.
///
/// Everything a job leaves by here has been through the run's [`Masker`]
/// already: a [`Done`] is built from the masked report, and artifacts
/// are only kept here when no file among them holds a secret's value.
pub trait Split: Send + Sync {
    /// This runner's name, as claims and reports carry it.
    fn runner(&self) -> &str;
    /// Whether this runner helps another's run rather than having it.
    fn helper(&self) -> bool;
    /// Claims `job`. Exactly one runner gets [`Claim::Ours`] until the
    /// claim is released.
    fn claim(&self, job: &str) -> Result<Claim, String>;
    /// Who holds the claim on `job`, if anyone, without claiming it.
    fn holder(&self, job: &str) -> Result<Option<String>, String>;
    /// Drops the claim on `job`, whoever holds it.
    fn release(&self, job: &str) -> Result<(), String>;
    /// Gives up a job this runner claimed, so the primary takes it. The
    /// word that it is given up is written before the claim is dropped,
    /// so a runner that dies between the two has still said so.
    fn hand_back(&self, job: &str) -> Result<(), String>;
    /// Records how `job` went. The first record stays.
    fn finish(&self, job: &str, done: &[u8]) -> Result<(), String>;
    /// The record of `job`, if it has one.
    fn done(&self, job: &str) -> Result<Option<Vec<u8>>, String>;
    /// Keeps what `job` kept on this runner, for the other runners.
    fn keep(&self, job: &str, entries: &[Entry]) -> Result<(), String>;
    /// What `runner` gave [`Split::keep`] for `job`, up to `max_bytes`: a
    /// job's record names the runner whose artifacts go with it, so a job
    /// that ran twice never pairs one runner's record with another's
    /// files.
    fn kept(&self, job: &str, runner: &str, max_bytes: u64) -> Result<Option<Vec<Entry>>, String>;
    /// The primary has more ready jobs than it can start: helpers may
    /// join.
    fn ask(&self);
    /// The primary is finished with this pipeline, or cancelled it.
    fn end(&self);
    fn seen(&self) -> Result<Seen, String>;
    fn timing(&self) -> Timing {
        Timing::default()
    }
}

/// Where what a finished job kept is, for another runner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(tag = "in", rename_all = "kebab-case")]
pub enum Kept {
    /// It kept nothing.
    None,
    /// In the task cache entry it saved under `key`.
    TaskCache { key: String },
    /// With the split, as [`Split::keep`] took it.
    Split,
    /// Only on the runner that ran it: too large to send, or of a job
    /// whose files are not sent at all.
    Local,
}

/// How a job went on the runner that ran it, for the others: its report
/// as that runner would store it, masked.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Done {
    pub runner: String,
    pub result: Status,
    pub blocks: bool,
    pub execution: Option<Execution>,
    /// Path and kind (`added`, `modified`, `deleted`).
    pub changes: Vec<(String, String)>,
    pub commit: Option<String>,
    pub outputs: BTreeMap<String, String>,
    pub caches: Vec<String>,
    pub downloads: Vec<DownloadedFile>,
    pub notes: Vec<String>,
    pub duration_ms: u64,
    pub peak_memory_mib: u64,
    /// What it held of that runner's memory (`JobReport::held_memory_mib`).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub held_memory_mib: u64,
    pub queued_ms: u64,
    pub kept: Kept,
}

impl Done {
    fn of(runner: &str, report: &JobReport, kept: Kept, mask: &Masker) -> Self {
        let text = |t: &String| mask.mask(t);
        Done {
            runner: runner.to_string(),
            result: match &report.status {
                Status::Passed => Status::Passed,
                Status::Failed { reason } => Status::Failed {
                    reason: text(reason),
                },
                Status::Skipped { reason } => Status::Skipped {
                    reason: text(reason),
                },
                Status::Error { message } => Status::Error {
                    message: text(message),
                },
                Status::Cancelled { reason } => Status::Cancelled {
                    reason: text(reason),
                },
            },
            blocks: report.blocks,
            execution: report.execution.as_ref().map(|e| Execution {
                stdout: text(&e.stdout),
                stderr: text(&e.stderr),
                service_failure: e.service_failure.as_ref().map(text),
                ..e.clone()
            }),
            changes: report
                .changes
                .iter()
                .map(|c| (text(&c.path), c.kind.to_string()))
                .collect(),
            commit: report.commit.clone(),
            outputs: report
                .outputs
                .iter()
                .map(|(k, v)| (k.clone(), text(v)))
                .collect(),
            caches: report.caches.iter().map(text).collect(),
            downloads: report.downloads.clone(),
            notes: report.notes.iter().map(text).collect(),
            duration_ms: report.duration_ms,
            peak_memory_mib: report.peak_memory_mib,
            held_memory_mib: report.held_memory_mib,
            queued_ms: report.queued_ms,
            kept,
        }
    }
}

/// The helper jobs running on this runner, every run's together, so that
/// one of the runner's own runs can have their slots and memory back.
///
/// A helper takes a job only from what the runner's own runs leave
/// ([`spare`]). That alone would still keep an own run waiting for as long
/// as the job a helper took a moment earlier runs. So an own run that
/// waits for a slot or for memory stops helper jobs, newest first, until
/// what it waits for is coming back; a job stopped this way is handed
/// back to the run's primary, never reported.
#[derive(Debug, Default)]
pub struct Helping {
    state: Mutex<HelpingState>,
    /// The runs of other runners this one has joined, and the most it may
    /// (`None` for no limit). A run counts from when it is asked for help
    /// and this runner has room, not from when it is offered.
    runs: Mutex<(usize, Option<usize>)>,
}

/// A run this runner helps, off the count when dropped.
#[derive(Debug)]
pub struct Joined(Arc<Helping>);

impl Drop for Joined {
    fn drop(&mut self) {
        let mut runs = self.0.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.0 = runs.0.saturating_sub(1);
    }
}

#[derive(Debug, Default)]
struct HelpingState {
    next: u64,
    jobs: Vec<HelpedJob>,
    /// Workers of the runner's own runs waiting for a slot.
    wanted_slots: usize,
}

#[derive(Debug)]
struct HelpedJob {
    id: u64,
    bytes: u64,
    cancel: iwci_runtime::Cancel,
    /// Stopped to give way; its slot and memory are on their way back.
    yielding: bool,
}

impl HelpingState {
    /// Stops the newest job not already giving way.
    fn stop_one(&mut self) -> Option<u64> {
        let job = self.jobs.iter_mut().rev().find(|j| !j.yielding)?;
        job.yielding = true;
        job.cancel.cancel();
        Some(job.bytes)
    }
}

impl Helping {
    fn lock(&self) -> MutexGuard<'_, HelpingState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Helps at most `max` runs at once.
    pub fn limit_runs(&self, max: usize) {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).1 = Some(max);
    }

    /// The runs this runner helps now.
    pub fn runs(&self) -> usize {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).0
    }

    /// Joins one more run, if this runner may help another.
    pub fn join(self: &Arc<Self>) -> Option<Joined> {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        if runs.1.is_some_and(|max| runs.0 >= max) {
            return None;
        }
        runs.0 += 1;
        Some(Joined(self.clone()))
    }

    /// Helper jobs running now: the slots they hold.
    pub fn running(&self) -> usize {
        self.lock().jobs.len()
    }

    /// The memory helper jobs hold.
    pub fn bytes(&self) -> u64 {
        self.lock().jobs.iter().map(|j| j.bytes).sum()
    }

    /// Whether one of the runner's own runs waits for a slot: no helper
    /// takes one meanwhile.
    pub(super) fn wanted(&self) -> bool {
        self.lock().wanted_slots > 0
    }

    /// A helper job starting with `bytes` of memory. Its `cancel` is set
    /// when `run`'s is, and when the job has to give way.
    pub(super) fn start(
        self: &Arc<Self>,
        bytes: u64,
        run: Option<&iwci_runtime::Cancel>,
    ) -> Helped {
        let cancel = iwci_runtime::Cancel::new();
        if let Some(run) = run {
            let job = cancel.clone();
            run.on_cancel(move || {
                job.cancel();
            });
        }
        let mut state = self.lock();
        state.next += 1;
        let id = state.next;
        state.jobs.push(HelpedJob {
            id,
            bytes,
            cancel: cancel.clone(),
            yielding: false,
        });
        Helped {
            helping: self.clone(),
            id,
            cancel,
        }
    }

    /// An own run's worker is about to wait for a slot: as many helper
    /// jobs give way as there are such workers.
    pub(super) fn want_slot(self: &Arc<Self>) -> SlotWant {
        let mut state = self.lock();
        state.wanted_slots += 1;
        while state.jobs.iter().filter(|j| j.yielding).count() < state.wanted_slots {
            if state.stop_one().is_none() {
                break;
            }
        }
        SlotWant(self.clone())
    }

    /// An own run's next job is `short` bytes short of fitting: helper
    /// jobs give way until that much is coming back.
    pub(super) fn want_memory(&self, short: u64) {
        let mut state = self.lock();
        let mut coming: u64 = state
            .jobs
            .iter()
            .filter(|j| j.yielding)
            .map(|j| j.bytes)
            .sum();
        while coming < short {
            match state.stop_one() {
                Some(bytes) => coming = coming.saturating_add(bytes),
                None => break,
            }
        }
    }
}

/// A running helper job, off the list when dropped.
pub(super) struct Helped {
    helping: Arc<Helping>,
    id: u64,
    pub(super) cancel: iwci_runtime::Cancel,
}

impl Drop for Helped {
    fn drop(&mut self) {
        self.helping.lock().jobs.retain(|j| j.id != self.id);
    }
}

/// An own run's worker waiting for a slot.
pub(super) struct SlotWant(Arc<Helping>);

impl Drop for SlotWant {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.wanted_slots = state.wanted_slots.saturating_sub(1);
    }
}

/// How often a helper with queued jobs looks again for spare room: a slot
/// freed, or an own run's queue emptied, wakes nobody.
pub(super) const SPARE_RECHECK: Duration = Duration::from_millis(250);

/// Records and artifacts fetched at once, per run: each is a read of the
/// store, as a task cache lookup is.
pub(super) const FETCHERS: usize = 8;

/// A job this runner does not run, or not yet: another runner holds its
/// claim, or it may only run where the run is.
pub(super) struct RemoteJob<'p> {
    pub template: &'p JobTemplate,
    pub job: PlannedJob,
    pub lookup: Lookup,
    pub rank: Rank,
    /// Who claimed it, when this runner lost the claim to them.
    pub holder: Option<String>,
    pub since: Instant,
}

/// Whether a job is given no secret and lent nothing, its services
/// included.
pub(super) fn secret_free(job: &PlannedJob) -> bool {
    job.secret_env.is_empty()
        && job.services.iter().all(|s| s.secret_env.is_empty())
        && job.access.is_empty()
}

/// Whether a job may run on a helper at all: nothing about it is tied to
/// the runner that has the run. A cloud job is claimed there by the app,
/// a commit lands in that runner's git cache, downloads are stored under
/// its run id, and a job that reads a secret or is lent anything needs
/// what only the primary is sent. A job that is handed what such a job
/// left stays too ([`runs_here`]).
pub(super) fn shareable(job: &PlannedJob) -> bool {
    job.cloud.is_none()
        && !matches!(job.changes, ChangePolicy::Commit { .. })
        && job.downloads.is_none()
        && secret_free(job)
}

/// What this runner still owes the others of a split run: something the
/// store would not take when it was first written.
enum Owed {
    Back(String),
    Done(String, Vec<u8>),
}

/// Tries `write` a few times, a little apart. `false` when none worked.
fn retried(mut write: impl FnMut() -> Result<(), String>) -> bool {
    for wait in [0u64, 50, 200] {
        std::thread::sleep(Duration::from_millis(wait));
        if write().is_ok() {
            return true;
        }
    }
    false
}

/// One pipeline's split, for the run's threads.
pub(super) struct Sharing<'a> {
    pub split: &'a dyn Split,
    pub spec: iwci_spec::SplitSpec,
    pub helper: bool,
    /// Jobs whose record this runner wrote or has taken in.
    settled: Mutex<HashSet<String>>,
    /// Jobs of the pipeline running on this runner now.
    pub running: AtomicU64,
    /// Set on a helper that could not run a job it took (its workspace
    /// would not build, a tool would not resolve): it takes no more, since
    /// the next would go the same way and each costs the primary a second.
    pub unfit: AtomicBool,
    /// Records and hand-backs the store would not take, tried again every
    /// time this runner looks at the store, for as long as the run lasts:
    /// a job whose word is lost is one the primary waits out.
    owed: Mutex<Vec<Owed>>,
}

/// What another runner's record of a job comes to here.
pub(super) enum Received {
    Report(Box<JobReport>),
    /// It passed, but what it kept cannot be had here.
    Elsewhere(Box<JobReport>, String),
    /// The record is not there yet, or the store did not answer: look
    /// again.
    Retry,
    /// There is a record and it does not read as one.
    Unreadable,
}

/// Whether masking left a job's outputs as the runner that ran it wrote
/// them.
fn sharing_outputs_agree(
    written: &BTreeMap<String, String>,
    masked: &BTreeMap<String, String>,
) -> bool {
    written == masked
}

fn file_bytes(entries: &[Entry]) -> u64 {
    entries
        .iter()
        .map(|e| match e {
            Entry::File { data, .. } => data.len() as u64,
            _ => 0,
        })
        .sum()
}

/// Whether a file among `entries` holds one of the run's secret values.
/// What a job kept is not text to mask: it reaches the jobs that need it
/// byte for byte or it is not sent.
fn holds_a_secret(entries: &[Entry], mask: &Masker) -> bool {
    entries
        .iter()
        .any(|entry| matches!(entry, Entry::File { data, .. } if mask.finds(data)))
}

impl<'a> Sharing<'a> {
    /// The split of `plan`'s run, when the run has one and the pipeline
    /// asks for it.
    pub fn of(plan: &Plan, options: &'a Options) -> Option<Self> {
        let split = options.split.as_deref()?;
        let mut spec = plan.split?;
        if !options.access.trusted {
            // A fork's pull request says how much its jobs may send no
            // more than a pipeline that says nothing does.
            spec.artifact_bytes = spec.artifact_bytes.min(iwci_spec::DEFAULT_SPLIT_ARTIFACTS);
        }
        Some(Sharing {
            split,
            spec,
            helper: split.helper(),
            settled: Mutex::default(),
            running: AtomicU64::new(0),
            unfit: AtomicBool::new(false),
            owed: Mutex::default(),
        })
    }

    /// Claims `job` before it starts. `false` when another runner has it.
    /// A store that does not answer is a job the primary runs and a helper
    /// leaves alone.
    pub fn claim(&self, job: &PlannedJob, local: bool) -> Result<(), Option<String>> {
        match self.split.claim(&job.id) {
            Ok(Claim::Ours) => Ok(()),
            // Taken back from a runner that is gone: run whatever the
            // claim says.
            Ok(Claim::Held(_)) | Err(_) if local && !self.helper => Ok(()),
            Ok(Claim::Held(by)) => Err(Some(by)),
            Err(_) if self.helper => Err(None),
            Err(_) => Ok(()),
        }
    }

    /// The runner that ran `job` in this run, when the task cache has just
    /// answered for it on the primary and another runner holds its claim:
    /// the entry is what that runner saved. The primary then takes the job
    /// from that runner's record, as it would have had its lookup come
    /// first, rather than as a hit: a hit is billed nothing and a helper's
    /// own report is zeroed, so the job would be paid for by nobody. A
    /// helper, and a store that does not answer, say nothing.
    pub fn ran_elsewhere(&self, job: &PlannedJob) -> Option<String> {
        if self.helper {
            return None;
        }
        match self.split.holder(&job.id) {
            Ok(Some(holder)) if holder != self.split.runner() => Some(holder),
            _ => None,
        }
    }

    /// Whether a helper gives a job it ran back rather than report it: it
    /// was stopped (to give way, or with the helper's run), or this runner
    /// could not run it, which says nothing about the job.
    pub fn hands_back(&self, report: &JobReport) -> bool {
        if !self.helper {
            return false;
        }
        if matches!(report.status, Status::Error { .. }) {
            self.unfit.store(true, Ordering::SeqCst);
        }
        matches!(
            report.status,
            Status::Cancelled { .. } | Status::Error { .. }
        )
    }

    /// Gives a job this helper claimed back to the primary. Kept and tried
    /// again when the store does not take it.
    pub fn hand_back(&self, job: &str) {
        if !retried(|| self.split.hand_back(job)) {
            self.owe(Owed::Back(job.to_string()));
        }
    }

    fn owe(&self, owed: Owed) {
        self.owed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(owed);
    }

    /// Writes again what the store would not take. `true` when nothing is
    /// owed any more.
    pub fn settle(&self) -> bool {
        let owed = std::mem::take(&mut *self.owed.lock().unwrap_or_else(|e| e.into_inner()));
        for item in owed {
            let written = match &item {
                Owed::Back(job) => self.split.hand_back(job),
                Owed::Done(job, body) => self.split.finish(job, body),
            };
            if written.is_err() {
                self.owe(item);
            }
        }
        self.owed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    }

    /// Tells the other runners how a job this runner ran went, and puts
    /// what it kept where they can get it. `handed` when the job started
    /// with what a job that reads secrets left.
    pub fn publish(
        &self,
        job: &PlannedJob,
        report: &mut JobReport,
        kept: &[Entry],
        saved: Option<&str>,
        handed: bool,
        mask: &Masker,
    ) {
        self.settled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job.id.clone());
        let bytes = file_bytes(kept);
        let cap = self.spec.artifact_bytes;
        let mut stays = None;
        let kept_in = if report.status != Status::Passed || kept.is_empty() {
            Kept::None
        } else if let Some(key) = saved {
            Kept::TaskCache {
                key: key.to_string(),
            }
        } else if !shareable(job) {
            stays = Some("a job that reads secrets, commits or keeps downloads sends none".into());
            Kept::Local
        } else if handed {
            stays = Some("it was handed what a job that reads secrets left".into());
            Kept::Local
        } else if bytes > cap {
            stays = Some(format!(
                "{} KiB is over the pipeline's `split: artifacts` of {} KiB",
                bytes.div_ceil(1024),
                cap.div_ceil(1024)
            ));
            Kept::Local
        } else if holds_a_secret(kept, mask) {
            stays = Some("a file among them holds a secret's value".into());
            Kept::Local
        } else {
            match self.split.keep(&job.id, kept) {
                Ok(()) => Kept::Split,
                Err(e) => {
                    stays = Some(format!("they could not be stored: {}", mask.mask(&e)));
                    Kept::Local
                }
            }
        };
        if let Some(why) = stays {
            report.notes.push(format!(
                "split: its artifacts stay on `{}` ({why}), so the jobs that need them run there",
                self.split.runner()
            ));
        }
        let done = Done::of(self.split.runner(), report, kept_in, mask);
        let body = serde_json::to_vec(&done).expect("serialisable");
        if !retried(|| self.split.finish(&job.id, &body)) {
            self.owe(Owed::Done(job.id.clone(), body));
        }
    }

    /// The job as the runner that ran it reports it, with what it kept.
    pub fn receive(
        &self,
        job: &PlannedJob,
        plan: &Plan,
        options: &Options,
        shared: &RunShared<'_>,
        kept: &mut Vec<Entry>,
    ) -> Received {
        let done = match self.split.done(&job.id) {
            Ok(Some(bytes)) => match serde_json::from_slice::<Done>(&bytes) {
                Ok(done) => done,
                Err(_) => return Received::Unreadable,
            },
            Ok(None) | Err(_) => return Received::Retry,
        };
        // The runner that wrote it may not have had the run's secrets (a
        // helper is sent none), so every piece of text in it is masked
        // here, as this runner's own report of the job would be.
        let mask = |t: &str| shared.mask.mask(t);
        let texts = |lines: Vec<String>| -> Vec<String> { lines.iter().map(|l| mask(l)).collect() };
        let done = Done {
            result: match done.result {
                Status::Passed => Status::Passed,
                Status::Failed { reason } => Status::Failed {
                    reason: mask(&reason),
                },
                Status::Skipped { reason } => Status::Skipped {
                    reason: mask(&reason),
                },
                Status::Error { message } => Status::Error {
                    message: mask(&message),
                },
                Status::Cancelled { reason } => Status::Cancelled {
                    reason: mask(&reason),
                },
            },
            changes: done
                .changes
                .into_iter()
                .map(|(path, kind)| (mask(&path), kind))
                .collect(),
            commit: done.commit.map(|c| mask(&c)),
            caches: texts(done.caches),
            notes: texts(done.notes),
            ..done
        };
        let execution = done.execution.map(|e| Execution {
            stdout: mask(&e.stdout),
            stderr: mask(&e.stderr),
            service_failure: e.service_failure.as_deref().map(mask),
            ..e
        });
        if let (Some(logs), Some(e)) = (&options.logs, &execution) {
            for (stream, text) in [("stdout", &e.stdout), ("stderr", &e.stderr)] {
                for line in text.lines() {
                    logs(LogEvent::Output {
                        job: job.id.clone(),
                        stream,
                        line: line.to_string(),
                    });
                }
            }
        }
        let done_outputs = done.outputs.clone();
        let mut notes = done.notes;
        notes.push(format!("split: ran on `{}`", done.runner));
        let passed = done.result == Status::Passed;
        let mut report = JobReport {
            id: job.id.clone(),
            name: job.display_name.clone(),
            tool: job.tool.to_string(),
            status: done.result,
            execution,
            changes: done
                .changes
                .into_iter()
                .map(|(path, kind)| ChangedFile {
                    path,
                    kind: match kind.as_str() {
                        "added" => "added",
                        "deleted" => "deleted",
                        _ => "modified",
                    },
                })
                .collect(),
            commit: done.commit,
            outputs: done
                .outputs
                .into_iter()
                .map(|(k, v)| (k, mask(&v)))
                .collect(),
            caches: done.caches,
            downloads: done.downloads,
            notes,
            duration_ms: done.duration_ms,
            // What it reserved where it ran: the same plan, so the same
            // `memory:`. It is billed with the run, like any of its jobs.
            memory_mib: job.memory_bytes >> 20,
            peak_memory_mib: done.peak_memory_mib,
            held_memory_mib: done.held_memory_mib,
            queued_ms: done.queued_ms,
            cached: false,
            needs: Vec::new(),
            blocks: done.blocks,
            access: job.access.clone(),
            cloud: None,
            remote: Some(done.runner.clone()),
            waited_for: None,
            elsewhere: false,
        };
        // A runner that plans from this job's outputs (a matrix another
        // job sets, an `if:`) has to plan from the same text as the runner
        // that ran it. A helper could not mask, so where masking changes
        // an output the two would differ: the primary does not take the
        // helper's word for the job then and runs it itself, as it would
        // have without a helper, with the outputs masked.
        if !sharing_outputs_agree(&done_outputs, &report.outputs) {
            return Received::Elsewhere(
                Box::new(report),
                format!(
                    "an output it wrote on `{}` holds one of the run's secret values",
                    done.runner
                ),
            );
        }
        if !passed {
            return Received::Report(Box::new(report));
        }
        let files = match &done.kept {
            Kept::None => Ok(Vec::new()),
            Kept::Local => Err(format!("its artifacts stayed on `{}`", done.runner)),
            Kept::TaskCache { key } => match &options.caches {
                None => Err("this runner keeps no task cache".into()),
                Some(store) => match store.restore(key, &[], plan.scratch_bytes + MAX_TASK_LOG) {
                    Ok(Some(hit)) => Ok(hit
                        .entries
                        .into_iter()
                        .filter(|e| entry_path(e) != std::path::Path::new(TASK_RECORD))
                        .collect()),
                    Ok(None) => Err(format!(
                        "the task cache entry `{}` it saved is gone",
                        short_key(key)
                    )),
                    Err(e) => Err(format!("could not read its task cache entry: {e}")),
                },
            },
            Kept::Split => match self.split.kept(&job.id, &done.runner, plan.scratch_bytes) {
                Ok(Some(entries)) => Ok(entries),
                Ok(None) => Err("the artifacts it sent are gone".into()),
                Err(e) => Err(format!("could not read the artifacts it sent: {e}")),
            },
        };
        let files = files.and_then(|files| {
            // Only ever what the job kept: anything else is not this job's.
            if files
                .iter()
                .any(|e| !job.artifacts.iter().any(|a| entry_path(e).starts_with(a)))
            {
                return Err("what it sent holds files outside the job's `artifacts:`".into());
            }
            let bytes = file_bytes(&files);
            let total = shared.artifact_bytes.fetch_add(bytes, Ordering::SeqCst) + bytes;
            if total > plan.scratch_bytes {
                shared.artifact_bytes.fetch_sub(bytes, Ordering::SeqCst);
                return Err("its artifacts would take the run past its `scratch:` limit".into());
            }
            Ok(files)
        });
        match files {
            Ok(files) => {
                {
                    // A job another runner ran counts as one run here: its
                    // time, and what it held there.
                    let mut measured = shared.measured.lock().unwrap();
                    measured
                        .durations
                        .insert(job.id.clone(), report.duration_ms);
                    if report.held_memory_mib != 0 {
                        measured.held.insert(job.id.clone(), report.held_memory_mib);
                    }
                }
                let count = files
                    .iter()
                    .filter(|e| matches!(e, Entry::File { .. }))
                    .count();
                if count > 0 {
                    report.notes.push(format!(
                        "artifacts: kept {count} file(s), {} KiB, from `{}`",
                        file_bytes(&files).div_ceil(1024),
                        done.runner
                    ));
                }
                *kept = files;
                Received::Report(Box::new(report))
            }
            Err(why) => Received::Elsewhere(Box::new(report), mask(&why)),
        }
    }
}

/// Whether a helper may run `job` of `template` at all: one any runner
/// may run, that fits this runner, whose artifacts would cross, and whose
/// needs all left their artifacts here.
pub(super) fn runs_here(
    sharing: &Sharing<'_>,
    template: &JobTemplate,
    job: &PlannedJob,
    finished: &HashMap<String, Finished>,
    options: &Options,
) -> bool {
    shareable(job)
        && options
            .memory
            .as_ref()
            .is_none_or(|b| job.memory_bytes <= b.total())
        && (job.artifacts.is_empty()
            || sharing.spec.artifact_bytes > 0
            || (job.task_cache.is_some() && options.caches.is_some()))
        && template
            .needs
            .iter()
            .all(|n| finished.get(n).is_none_or(|f| !f.elsewhere && !f.tainted))
}

/// Puts a job among those another runner has, or will have. It shows as
/// running from here on. The caller counts it in `running`.
pub(super) fn defer<'p>(s: &mut State<'p>, options: &Options, remote: RemoteJob<'p>) {
    if let Some(logs) = &options.logs {
        logs(LogEvent::JobStarted {
            job: remote.job.id.clone(),
            name: remote.job.display_name.clone(),
        });
    }
    s.remote.insert(remote.job.id.clone(), remote);
}

/// Takes a remote job back into this run's queue, to run here whatever
/// its claim says.
fn requeue<'p>(s: &mut State<'p>, mut remote: RemoteJob<'p>, why: String) {
    s.running -= 1;
    remote
        .lookup
        .lines
        .push(format!("split: {why}; running it here"));
    remote.lookup.local = true;
    s.enqueue(remote.rank, (remote.template, remote.job, remote.lookup));
}

/// The queued job a helper may start now, with its memory and the slot
/// for it: only when none of this runner's own runs waits for a slot or
/// for memory, a slot is free and the job's memory fits. Never waits for
/// either, and never has the claim on memory coming back that the first
/// job of a run has.
pub(super) fn spare(
    sharing: &Sharing<'_>,
    options: &Options,
    queue: &[(Rank, (&JobTemplate, PlannedJob, Lookup))],
    slot: &mut Option<SlotGuard>,
) -> Option<(usize, Option<Arc<Lease>>)> {
    if queue.is_empty() || sharing.unfit.load(Ordering::SeqCst) {
        return None;
    }
    if options.helping.as_ref().is_some_and(|h| h.wanted()) {
        return None;
    }
    let taken = match &options.slots {
        Some(slots) => Some(slots.try_acquire()?),
        None => None,
    };
    let found = match &options.memory {
        None => (queue.len() - 1, None),
        Some(budget) => {
            let asks = queue.iter().rev().map(|(_, (_, j, l))| Ask {
                bytes: l.reserve,
                limit: j.memory_bytes,
                expected: l.expected,
            });
            let (nth, lease) = budget.admit_spare(asks)?;
            (queue.len() - 1 - nth, Some(lease))
        }
    };
    *slot = taken;
    Some(found)
}

/// A slot for a job of one of this runner's own runs: a free one, or else
/// one a helper job gives up for it.
pub(super) fn own_slot(options: &Options, slots: &Arc<Slots>) -> SlotGuard {
    if let Some(slot) = slots.try_acquire() {
        return slot;
    }
    let _want = options.helping.as_ref().map(|h| h.want_slot());
    slots.acquire()
}

/// An own run's next job does not fit the runner's memory: helper jobs
/// give way until it would.
pub(super) fn reclaim_memory(
    options: &Options,
    queue: &[(Rank, (&JobTemplate, PlannedJob, Lookup))],
) {
    let (Some(helping), Some(budget), Some((_, (_, _, lookup)))) =
        (&options.helping, &options.memory, queue.last())
    else {
        return;
    };
    // What the job reserves: its `memory:`, or its estimate.
    let free = budget.total().saturating_sub(budget.used());
    if lookup.reserve > free {
        helping.want_memory(lookup.reserve - free);
    }
}

/// A helper job as it starts: on the runner's list of them, with a
/// cancel of its own that the run's also sets.
pub(super) fn helped(options: &Options, reserved: u64) -> Option<Helped> {
    options
        .helping
        .as_ref()
        .map(|h| h.start(reserved, options.cancel.as_ref()))
}

/// Follows what the other runners of the run write, once every
/// [`Timing::poll`]: moves the jobs they finished to the fetchers, takes
/// back what a helper gave up or died holding, asks for help when this
/// runner's queue backs up, and ends a helper whose primary is done or
/// gone.
pub(super) fn watch<'p>(
    sharing: &Sharing<'_>,
    state: &Mutex<State<'p>>,
    wake: &Wake,
    plan: &'p Plan,
    options: &Options,
) {
    let split = sharing.split;
    let timing = split.timing();
    let mut back: HashSet<(String, String, u64)> = HashSet::new();
    // Each runner's last number and when it changed, by this clock: the
    // primary under the empty name.
    let mut beats: HashMap<String, (Option<u64>, Instant)> = HashMap::new();
    let mut silent = |name: &str, beat: Option<Option<u64>>, now: Instant| -> Duration {
        let entry = beats.entry(name.to_string()).or_insert((None, now));
        if let Some(beat) = beat
            && beat != entry.0
        {
            *entry = (beat, now);
        }
        now.saturating_duration_since(entry.1)
    };
    let mut asked = false;
    let mut ended = false;
    loop {
        {
            let s = state.lock().unwrap();
            if s.done {
                break;
            }
            let seen = wake.seen();
            let s = wake.wait_at_most(s, state, seen, Some(timing.poll));
            if s.done {
                break;
            }
        }
        if let Some(reason) = options.stopped() {
            if !ended && !sharing.helper && options.cancelled() {
                ended = true;
                split.end();
            }
            // What other runners have is not waited for.
            let left: Vec<RemoteJob<'p>> = {
                let mut s = state.lock().unwrap();
                let mut left: Vec<RemoteJob<'p>> = s.remote.drain().map(|(_, r)| r).collect();
                left.append(&mut s.arrived);
                left
            };
            for remote in left {
                let report = cancelled_report(&remote.job, reason);
                complete(
                    state,
                    wake,
                    plan,
                    options,
                    remote.template,
                    report,
                    Vec::new(),
                );
            }
            continue;
        }
        let seen = split.seen().ok();
        let now = Instant::now();
        if sharing.helper && silent("", seen.as_ref().map(|s| s.primary), now) >= timing.lease {
            // The primary is gone: so is this runner.
            if let Some(cancel) = &options.cancel {
                cancel.cancel();
            }
            continue;
        }
        let mut released = Vec::new();
        let mut ask = false;
        let mut left_behind = false;
        {
            let mut s = state.lock().unwrap();
            let mut settled = sharing.settled.lock().unwrap_or_else(|e| e.into_inner());
            for id in seen.iter().flat_map(|s| &s.done) {
                if settled.contains(id) {
                    continue;
                }
                if let Some(remote) = s.remote.remove(id) {
                    s.arrived.push(remote);
                } else if let Some(pos) = s.queue.iter().position(|(_, (_, j, _))| j.id == *id) {
                    // Finished elsewhere before this runner got to it.
                    let rank = s.queue[pos].0;
                    let (template, job, lookup) = s.dequeue(pos);
                    s.running += 1;
                    if let Some(logs) = &options.logs {
                        logs(LogEvent::JobStarted {
                            job: job.id.clone(),
                            name: job.display_name.clone(),
                        });
                    }
                    s.arrived.push(RemoteJob {
                        template,
                        job,
                        lookup,
                        rank,
                        holder: None,
                        since: now,
                    });
                } else if let Some(pos) = s.awaiting.iter().position(|a| a.job.id == *id) {
                    // Finished elsewhere while this runner waited for
                    // another run's task cache entry: counted in
                    // `running` already.
                    let a = s.awaiting.swap_remove(pos);
                    if let Some(logs) = &options.logs {
                        logs(LogEvent::JobStarted {
                            job: a.job.id.clone(),
                            name: a.job.display_name.clone(),
                        });
                    }
                    s.arrived.push(RemoteJob {
                        template: a.template,
                        job: a.job,
                        lookup: Lookup {
                            key: Some(a.waiting.key),
                            lines: a.waiting.lines,
                            waited: true,
                            ..Lookup::default()
                        },
                        rank: a.rank,
                        holder: None,
                        since: now,
                    });
                } else {
                    // Not ready here yet, or running here too: looked at
                    // again next time.
                    continue;
                }
                settled.insert(id.clone());
            }
            drop(settled);
            if !sharing.helper {
                for marker in seen.iter().flat_map(|s| &s.back) {
                    // Only once the job is seen here as that helper's: a
                    // hand-back that arrives while a worker is still
                    // losing the claim to it is looked at again.
                    let (job, by, _) = marker;
                    if !back.contains(marker)
                        && s.remote
                            .get(job)
                            .is_some_and(|r| r.holder.as_ref() == Some(by))
                        && let Some(remote) = s.remote.remove(job)
                    {
                        back.insert(marker.clone());
                        requeue(&mut s, remote, format!("`{by}` handed it back"));
                    }
                }
                let gone: Vec<(String, String)> = s
                    .remote
                    .iter()
                    .filter_map(|(id, remote)| {
                        let holder = remote.holder.as_ref()?;
                        let beat = seen.as_ref().map(|s| s.helpers.get(holder).copied());
                        let quiet = silent(holder, beat, now);
                        let limit = remote.job.timeout + timing.lease * 2;
                        if quiet >= timing.lease {
                            Some((id.clone(), format!("`{holder}` stopped answering")))
                        } else if now.saturating_duration_since(remote.since) >= limit {
                            Some((
                                id.clone(),
                                format!("`{holder}` held it past its timeout without a result"),
                            ))
                        } else {
                            None
                        }
                    })
                    .collect();
                for (id, why) in gone {
                    if let Some(remote) = s.remote.remove(&id) {
                        requeue(&mut s, remote, why);
                        released.push(id);
                    }
                }
            } else if seen.as_ref().is_some_and(|s| s.ended) {
                // The primary is done with the pipeline. When it finished
                // it, every job has a record and this run ends by taking
                // them in. Anything still without one, or running here,
                // was cut short there: so it is here.
                left_behind = !s.remote.is_empty()
                    || !s.queue.is_empty()
                    || !s.awaiting.is_empty()
                    || sharing.running.load(Ordering::SeqCst) > 0;
            }
            if !sharing.helper {
                ask = !asked
                    && s.queue.iter().any(|(_, (_, job, lookup))| {
                        shareable(job)
                            && lookup.sandbox.is_none()
                            && lookup
                                .queued
                                .is_some_and(|at| at.elapsed() >= timing.ask_after)
                    });
            }
        }
        if left_behind && let Some(cancel) = &options.cancel {
            cancel.cancel();
        }
        sharing.settle();
        for id in released {
            let _ = split.release(&id);
        }
        if ask {
            asked = true;
            split.ask();
        }
        wake.notify_all();
    }
    // What is still owed is tried for a little longer: a job handed back
    // as the run ends is one the primary would otherwise wait out.
    for _ in 0..20 {
        if sharing.settle() {
            break;
        }
        std::thread::sleep(timing.poll.min(Duration::from_millis(250)));
    }
    if !ended && !sharing.helper {
        split.end();
    }
}

/// Takes in the jobs other runners finished: reads each one's record and
/// what it kept, and completes it here.
pub(super) fn fetch<'p>(
    sharing: &Sharing<'_>,
    state: &Mutex<State<'p>>,
    wake: &Wake,
    plan: &'p Plan,
    options: &Options,
    shared: &RunShared<'_>,
) {
    loop {
        let remote = {
            let mut s = state.lock().unwrap();
            loop {
                let seen = wake.seen();
                if let Some(remote) = s.arrived.pop() {
                    break remote;
                }
                if s.done {
                    return;
                }
                s = wake.wait(s, state, seen);
            }
        };
        let mut kept = Vec::new();
        match sharing.receive(&remote.job, plan, options, shared, &mut kept) {
            Received::Report(report) => {
                complete(state, wake, plan, options, remote.template, *report, kept)
            }
            // A helper goes on without them: the jobs that need them stay
            // where they are.
            Received::Elsewhere(mut report, why) if sharing.helper => {
                report.elsewhere = true;
                report.notes.push(format!("split: {why}"));
                complete(
                    state,
                    wake,
                    plan,
                    options,
                    remote.template,
                    *report,
                    Vec::new(),
                );
            }
            // The primary has to have them: it runs the job itself.
            Received::Elsewhere(_, why) => {
                let _ = sharing.split.release(&remote.job.id);
                let mut s = state.lock().unwrap();
                requeue(&mut s, remote, why);
                drop(s);
                wake.notify_all();
            }
            Received::Retry => {
                sharing
                    .settled
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&remote.job.id);
                let mut s = state.lock().unwrap();
                s.remote.insert(remote.job.id.clone(), remote);
            }
            // Nothing to go on: the primary runs the job itself, and a
            // helper leaves it to the primary until the run ends.
            Received::Unreadable if sharing.helper => {
                let mut s = state.lock().unwrap();
                s.remote.insert(remote.job.id.clone(), remote);
            }
            Received::Unreadable => {
                let _ = sharing.split.release(&remote.job.id);
                let mut s = state.lock().unwrap();
                requeue(&mut s, remote, "its record could not be read".into());
                drop(s);
                wake.notify_all();
            }
        }
    }
}
