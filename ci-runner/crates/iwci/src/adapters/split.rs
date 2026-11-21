//! What the runners of a split run share, in the object store every
//! runner reads (`crate::schedule::Split` says what it is for).
//!
//! Everything of one run is under `splits/<owner>/<repo-id>/<run>/`,
//! `<run>` being the id of the run on the runner that has it:
//!
//! | Key | What |
//! |-----|------|
//! | `state/primary.<n>` | the primary is alive; `<n>` moves every [`BEAT`] |
//! | `state/helper/<runner>.<n>` | the same for a helper |
//! | `state/help.<version>` | the primary, a runner of that version, has more ready jobs than it can start |
//! | `state/end` | the run is over |
//! | `state/ended/<pipeline>` | that pipeline is over, or cancelled |
//! | `state/done/<pipeline>/<job>` | how a job went: a `schedule::Done`. The primary's are masked as its report is; a helper has no secrets to mask with, so the primary masks a helper's when it reads it |
//! | `state/commit.<sha>` | the commit the primary resolved the request to, which a helper runs and no other |
//! | `state/back/<pipeline>/<job>.<runner>.<n>` | that helper gave the job up |
//! | `claims/<pipeline>/<job>` | who runs the job: the runner's name |
//! | `artifacts/<pipeline>/<job>.<runner>` | what a job without a task cache entry kept on that runner, when small enough |
//! | `scratch/<pipeline>/<runner>/<layer>.list` | one of that runner's `/tmp/workflow` layers: what changed, and where each file is (`schedule::Layer`) |
//! | `scratch/<pipeline>/<runner>/<layer>.<n>` | some of that layer's files: one large file, or several small ones |
//! | `state/scratch/<pipeline>/<runner>.<layer>` | that runner's layers up to this one are stored; the last one only |
//! | `state/key/<runner>.<key>` | that helper has joined and wants the run's secrets sealed to this X25519 public key (hex) |
//! | `secrets/<runner>` | the run's secrets sealed to that helper's key (`crate::sealed`): never in the clear |
//!
//! `<pipeline>` is a hash of the pipeline's file name and `<job>` the job
//! id in hex, so every key stays inside the store's key grammar. All of
//! `state/` is one listing, which is all a runner reads to follow the
//! others: once a second while it runs a pipeline, every five while a
//! helper waits to be asked.
//!
//! The primary deletes everything but `state/end` when the run ends, and
//! [`sweep`] removes what a primary that died left behind.
//!
//! Runners only share a run when they are the same version: they have to
//! plan it alike and read each other's records, and a helper that finds
//! another version asking leaves at once. While a release rolls out,
//! runs are simply not shared.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use iwci_store::{ObjectStore, RepoId};
use iwci_vfs::{Entry, archive};
use sha2::Digest;

use crate::schedule::{Claim, Seen, Split, Timing, scratch_object_name};

/// The prefix of every split run's objects.
pub const PREFIX: &str = "splits";
/// How often a runner of a split run says it is alive.
pub const BEAT: Duration = Duration::from_secs(10);
/// What a primary of this build asks for help under.
fn help_key() -> String {
    format!("help.{}", crate::server::lifecycle::VERSION)
}

/// For this long after an offer a helper looks for an ask every
/// [`EAGER_OFFER_STEP`] rather than every [`Timing::offer`]: a run that
/// knows it wants help asks at its start.
pub const EAGER_OFFER: Duration = Duration::from_secs(15);
pub const EAGER_OFFER_STEP: Duration = Duration::from_millis(500);

/// After this long, what a split run left in the store is swept.
pub const SWEEP_AFTER_SECS: u64 = 24 * 60 * 60;
/// Objects deleted at once when a run's are cleared.
const CLEAR_THREADS: usize = 8;

/// A name fit for a key segment and a report: what the proxy calls the
/// runner, or something made up for a runner nothing named.
pub fn runner_name(given: Option<&str>) -> String {
    let ok = |n: &str| {
        (1..=40).contains(&n.len())
            && n.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    match given {
        Some(name) if ok(name) => name.to_string(),
        _ => format!("runner-{}", &crate::runner::random_id()[..8]),
    }
}

/// How a helper's wait to be asked ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Asked {
    /// The primary wants help and this runner has room: join, and run
    /// this commit, the one the primary resolved the request to.
    Join(String),
    /// The run ended, or its primary is gone, before that.
    Over,
}

/// One split run, as one of its runners sees it. Says this runner is
/// alive from when it is made until it is dropped.
pub struct SplitRun {
    store: Arc<dyn ObjectStore>,
    /// `splits/<owner>/<repo-id>/<run>`.
    root: String,
    runner: String,
    helper: bool,
    asked: AtomicBool,
    timing: Timing,
    beat: Beating,
    /// A helper has opened the run's secrets.
    secrets: AtomicBool,
}

/// Work a run leaves to do in the store after it ends (deleting its
/// signs of life and what its jobs did not delete), counted so that a
/// process about to exit can wait for it a little ([`settle`]) and a server
/// never has to.
static PENDING: Mutex<usize> = Mutex::new(0);
static SETTLED: Condvar = Condvar::new();

/// Runs `work` on a thread of its own, counted until it is done.
pub(crate) fn in_background(name: &str, work: impl FnOnce() + Send + 'static) {
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) += 1;
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
            *pending = pending.saturating_sub(1);
            SETTLED.notify_all();
        }
    }
    let spawned = std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let _done = Done;
            work();
        });
    if spawned.is_err() {
        drop(Done);
    }
}

/// Waits up to `max` for what runs left to do in the store in the
/// background: for `iwci run`, which exits right after its run and would
/// otherwise leave it for the sweep. Returns whether it all finished.
pub fn settle(max: Duration) -> bool {
    let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let (pending, _) = SETTLED
        .wait_timeout_while(pending, max, |n| *n > 0)
        .unwrap_or_else(|e| e.into_inner());
    *pending == 0
}

/// A sign of life: `<key>.<n>`, with `<n>` moving on every beat from
/// when it starts until it is stopped or dropped, when it is deleted. A
/// reader that lists it and sees `<n>` stand still for a lease, by its own
/// clock, counts whoever wrote it gone; no clocks are compared and nothing
/// is read but the listing. Split runs and task cache markers
/// (`adapters::inflight`) both say they are alive this way.
///
/// Stopping it never waits for the store: the last one is deleted in the
/// background, which [`settle`] waits for.
pub struct Beating {
    beat: Arc<Beat>,
}

struct Beat {
    stop: Mutex<bool>,
    stopped: Condvar,
}

impl Beating {
    /// Writes `<key>.1` before it returns, so nobody looks for it in vain,
    /// and moves it on from a thread of its own.
    pub fn start(store: Arc<dyn ObjectStore>, key: String, every: Duration) -> Self {
        let beat = Arc::new(Beat {
            stop: Mutex::new(false),
            stopped: Condvar::new(),
        });
        let _ = store.put(&format!("{key}.1"), b"", "text/plain");
        let moving = beat.clone();
        in_background("iwci-beat", move || {
            let mut n = 1u64;
            loop {
                let stop = moving.stop.lock().unwrap_or_else(|e| e.into_inner());
                let (stop, _) = moving
                    .stopped
                    .wait_timeout_while(stop, every, |stop| !*stop)
                    .unwrap_or_else(|e| e.into_inner());
                if *stop {
                    break;
                }
                drop(stop);
                if store
                    .put(&format!("{key}.{}", n + 1), b"", "text/plain")
                    .is_ok()
                {
                    let _ = store.delete(&format!("{key}.{n}"));
                    n += 1;
                }
            }
            let _ = store.delete(&format!("{key}.{n}"));
        });
        Self { beat }
    }

    /// Stops moving it, and deletes it, in the background.
    pub fn stop(&self) {
        *self.beat.stop.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.beat.stopped.notify_all();
    }
}

impl Drop for Beating {
    fn drop(&mut self) {
        self.stop();
    }
}

impl SplitRun {
    /// This runner's part in the split of run `run` (the primary's id):
    /// the primary's own when `helper` is false.
    pub fn new(
        store: Arc<dyn ObjectStore>,
        owner: &RepoId,
        repo: &RepoId,
        run: &RepoId,
        runner: &str,
        helper: bool,
    ) -> Arc<Self> {
        Self::with_timing(store, owner, repo, run, runner, helper, Timing::default())
    }

    /// [`SplitRun::new`], looking and waiting as `timing` says.
    pub fn with_timing(
        store: Arc<dyn ObjectStore>,
        owner: &RepoId,
        repo: &RepoId,
        run: &RepoId,
        runner: &str,
        helper: bool,
        timing: Timing,
    ) -> Arc<Self> {
        let root = format!(
            "{PREFIX}/{}/{}/{}",
            owner.as_str(),
            repo.as_str(),
            run.as_str()
        );
        let key = if helper {
            format!("{root}/state/helper/{runner}")
        } else {
            format!("{root}/state/primary")
        };
        // The first one before anything else, so the other runners never
        // look for this one in vain.
        let beat = Beating::start(store.clone(), key, BEAT);
        Arc::new(Self {
            store,
            root,
            runner: runner.to_string(),
            helper,
            asked: AtomicBool::new(false),
            timing,
            beat,
            secrets: AtomicBool::new(false),
        })
    }

    /// The split of the pipeline in `file`.
    pub fn pipeline(self: &Arc<Self>, file: &str) -> Arc<PipelineSplit> {
        Arc::new(PipelineSplit {
            run: self.clone(),
            pipeline: pipeline_segment(file),
            back: AtomicU64::new(0),
            scratch_marker: AtomicU64::new(0),
        })
    }

    fn state(&self) -> Result<Vec<String>, String> {
        let prefix = format!("{}/state/", self.root);
        Ok(self
            .store
            .list(&prefix)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|key| key.strip_prefix(&prefix).map(str::to_string))
            .collect())
    }

    /// Waits, as a helper, until the primary asks for help and `room`
    /// says this runner has some, without reading anything of the run but
    /// one listing every [`Timing::offer`]. Over when the run ends first, its
    /// primary goes quiet, or `stopped` says so.
    pub fn wait_to_be_asked(&self, room: &dyn Fn() -> bool, stopped: &dyn Fn() -> bool) -> Asked {
        let offered = Instant::now();
        let mut beat: (Option<u64>, Instant) = (None, Instant::now());
        loop {
            if stopped() {
                return Asked::Over;
            }
            if let Ok(state) = self.state() {
                if state.iter().any(|k| k == "end") {
                    return Asked::Over;
                }
                let primary = state
                    .iter()
                    .filter_map(|k| k.strip_prefix("primary.")?.parse::<u64>().ok())
                    .max();
                if primary != beat.0 {
                    beat = (primary, Instant::now());
                }
                let help = help_key();
                // The commit is the primary's to say: a request without one
                // names a branch, whose head may have moved since the
                // primary read it. No commit, no joining.
                let commit = state
                    .iter()
                    .filter_map(|k| k.strip_prefix("commit."))
                    .find(|sha| is_commit(sha));
                if state.contains(&help) {
                    if let Some(commit) = commit
                        && room()
                    {
                        return Asked::Join(commit.to_string());
                    }
                } else if state.iter().any(|k| k.starts_with("help.")) {
                    // Asked by a runner of another version, which this one
                    // may not plan like.
                    return Asked::Over;
                }
            }
            if beat.1.elapsed() >= self.timing.lease {
                return Asked::Over;
            }
            // In short steps, so a drain or a cancel is not kept waiting.
            // Often at first, when a run that knows it wants help (one
            // with machine jobs) asks; then every `offer`.
            let every = if offered.elapsed() < EAGER_OFFER {
                self.timing.offer.min(EAGER_OFFER_STEP)
            } else {
                self.timing.offer
            };
            let until = Instant::now() + every;
            while Instant::now() < until && !stopped() {
                std::thread::sleep(Duration::from_millis(100).min(self.timing.offer));
            }
        }
    }

    /// Says, as a helper that has joined, that it wants the run's secrets
    /// sealed to `public` (`crate::sealed::Opener::public`).
    pub fn publish_key(&self, public: &[u8]) -> Result<(), String> {
        if !self.helper || public.len() != crate::sealed::PUBLIC_KEY_LEN {
            return Err("not a helper's key".into());
        }
        self.store
            .put(
                &format!(
                    "{}/state/key/{}.{}",
                    self.root,
                    self.runner,
                    hex::encode(public)
                ),
                b"",
                "text/plain",
            )
            .map_err(|e| e.to_string())
    }

    /// What the primary sealed to this helper, once it is there: looked
    /// for every 200 ms for up to `max`, and given up on with the run.
    pub fn wait_for_secrets(&self, max: Duration, stopped: &dyn Fn() -> bool) -> Option<Vec<u8>> {
        let key = format!("{}/secrets/{}", self.root, self.runner);
        let until = Instant::now() + max;
        while Instant::now() < until && !stopped() {
            if let Ok(Some(sealed)) = self.store.get(&key) {
                return Some(sealed);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        None
    }

    /// This helper has the run's secrets: it may take jobs given them.
    pub fn got_secrets(&self) {
        self.secrets.store(true, Ordering::SeqCst);
    }

    /// Says which commit the run is of, as the primary resolved it, for
    /// the helpers to run exactly that.
    pub fn publish_commit(&self, sha: &str) {
        if !self.helper && is_commit(sha) {
            let _ = self.store.put(
                &format!("{}/state/commit.{sha}", self.root),
                b"",
                "text/plain",
            );
        }
    }

    /// Whether the primary is done with the pipeline in `file`.
    pub fn ended(&self, file: &str) -> bool {
        let ended = format!("ended/{}", pipeline_segment(file));
        self.state()
            .is_ok_and(|state| state.iter().any(|k| *k == "end" || *k == ended))
    }

    /// The run is over. The primary says so and clears what the run left,
    /// in the background; either way this runner stops saying it is alive.
    pub fn finish(&self) {
        self.beat.stop();
        if self.helper {
            return;
        }
        let end = format!("{}/state/end", self.root);
        let _ = self.store.put(&end, b"", "text/plain");
        let (store, root) = (self.store.clone(), self.root.clone());
        in_background("iwci-split-clear", move || {
            let Ok(keys) = store.list(&format!("{root}/")) else {
                return;
            };
            let keys: Vec<String> = keys.into_iter().filter(|k| *k != end).collect();
            delete_all(store.as_ref(), &keys);
        });
    }
}

pub(crate) fn delete_all(store: &dyn ObjectStore, keys: &[String]) {
    let next = AtomicU64::new(0);
    std::thread::scope(|scope| {
        for _ in 0..CLEAR_THREADS.min(keys.len()) {
            scope.spawn(|| {
                while let Some(key) = keys.get(next.fetch_add(1, Ordering::SeqCst) as usize) {
                    let _ = store.delete(key);
                }
            });
        }
    });
}

/// Removes what split runs left in the store more than
/// [`SWEEP_AFTER_SECS`] ago: the `state/end` of every finished run, and
/// everything of a run whose primary died. Returns how many objects went.
/// A store that does not say when an object was written is left alone.
pub fn sweep(store: &dyn ObjectStore, now: u64) -> Result<usize, String> {
    sweep_under(store, PREFIX, now)
}

/// Removes every object under `prefix/` written more than
/// [`SWEEP_AFTER_SECS`] ago.
pub(crate) fn sweep_under(
    store: &dyn ObjectStore,
    prefix: &str,
    now: u64,
) -> Result<usize, String> {
    let old: Vec<String> = store
        .list_detailed(&format!("{prefix}/"))
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|o| {
            o.modified
                .is_some_and(|at| at.saturating_add(SWEEP_AFTER_SECS) < now)
        })
        .map(|o| o.key)
        .collect();
    delete_all(store, &old);
    Ok(old.len())
}

/// A full commit id: 40 or 64 lowercase hex digits.
fn is_commit(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64)
        && sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn pipeline_segment(file: &str) -> String {
    hex::encode(&sha2::Sha256::digest(file.as_bytes())[..8])
}

/// One pipeline of a [`SplitRun`].
pub struct PipelineSplit {
    run: Arc<SplitRun>,
    pipeline: String,
    /// Jobs this runner handed back, to tell each time apart.
    back: AtomicU64,
    /// The last scratch layer this runner said it stored.
    scratch_marker: AtomicU64,
}

impl PipelineSplit {
    fn key(&self, kind: &str, job: &str) -> String {
        format!(
            "{}/{kind}/{}/{}",
            self.run.root,
            self.pipeline,
            hex::encode(job)
        )
    }
}

impl PipelineSplit {
    fn scratch_key(&self, runner: &str, name: &str) -> String {
        format!(
            "{}/scratch/{}/{runner}/{name}",
            self.run.root, self.pipeline
        )
    }
}

fn job_id(hex_id: &str) -> Option<String> {
    String::from_utf8(hex::decode(hex_id).ok()?).ok()
}

impl Split for PipelineSplit {
    fn runner(&self) -> &str {
        &self.run.runner
    }

    fn helper(&self) -> bool {
        self.run.helper
    }

    fn claim(&self, job: &str) -> Result<Claim, String> {
        let key = self.key("claims", job);
        let store = &self.run.store;
        // Twice, for a claim released between the write and the read.
        for _ in 0..2 {
            if store
                .put_if_absent(&key, self.run.runner.as_bytes(), "text/plain")
                .map_err(|e| e.to_string())?
            {
                return Ok(Claim::Ours);
            }
            if let Some(holder) = store.get(&key).map_err(|e| e.to_string())? {
                let holder = String::from_utf8_lossy(&holder).into_owned();
                return Ok(if holder == self.run.runner {
                    Claim::Ours
                } else {
                    Claim::Held(holder)
                });
            }
        }
        Err("the job's claim keeps changing hands".into())
    }

    fn holder(&self, job: &str) -> Result<Option<String>, String> {
        let holder = self
            .run
            .store
            .get(&self.key("claims", job))
            .map_err(|e| e.to_string())?;
        Ok(holder.map(|h| String::from_utf8_lossy(&h).into_owned()))
    }

    fn release(&self, job: &str) -> Result<(), String> {
        self.run
            .store
            .delete(&self.key("claims", job))
            .map_err(|e| e.to_string())
    }

    fn hand_back(&self, job: &str) -> Result<(), String> {
        // The time, then a count for two in the same instant.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos() as u64);
        let n = nanos.wrapping_add(self.back.fetch_add(1, Ordering::SeqCst));
        // The marker first: once it is written the primary takes the job
        // (and drops the claim itself) whatever becomes of this runner.
        self.run
            .store
            .put(
                &format!("{}.{}.{n}", self.key("state/back", job), self.run.runner),
                b"",
                "text/plain",
            )
            .map_err(|e| e.to_string())?;
        // Only this runner's own claim: the primary may have taken the
        // job already.
        let key = self.key("claims", job);
        if let Ok(Some(holder)) = self.run.store.get(&key)
            && holder == self.run.runner.as_bytes()
        {
            let _ = self.run.store.delete(&key);
        }
        Ok(())
    }

    fn finish(&self, job: &str, done: &[u8]) -> Result<(), String> {
        self.run
            .store
            .put_if_absent(&self.key("state/done", job), done, "application/json")
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn done(&self, job: &str) -> Result<Option<Vec<u8>>, String> {
        self.run
            .store
            .get(&self.key("state/done", job))
            .map_err(|e| e.to_string())
    }

    fn keep(&self, job: &str, entries: &[Entry]) -> Result<(), String> {
        let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3).map_err(|e| e.to_string())?;
        encoder.include_checksum(true).map_err(|e| e.to_string())?;
        archive::encode(&mut encoder, entries).map_err(|e| e.to_string())?;
        let bytes = encoder.finish().map_err(|e| e.to_string())?;
        self.run
            .store
            .put(
                &format!("{}.{}", self.key("artifacts", job), self.run.runner),
                &bytes,
                "application/zstd",
            )
            .map_err(|e| e.to_string())
    }

    fn kept(&self, job: &str, runner: &str, max_bytes: u64) -> Result<Option<Vec<Entry>>, String> {
        if runner_name(Some(runner)) != runner {
            return Err("the record names no runner".into());
        }
        let Some(bytes) = self
            .run
            .store
            .get(&format!("{}.{runner}", self.key("artifacts", job)))
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let mut decoder =
            zstd::stream::Decoder::new(bytes.as_slice()).map_err(|e| e.to_string())?;
        archive::decode(&mut decoder, max_bytes)
            .map(Some)
            .map_err(|e| e.to_string())
    }

    fn ask(&self) {
        if !self.run.asked.swap(true, Ordering::SeqCst) {
            let _ = self.run.store.put(
                &format!("{}/state/{}", self.run.root, help_key()),
                b"",
                "text/plain",
            );
        }
    }

    fn end(&self) {
        let _ = self.run.store.put(
            &format!("{}/state/ended/{}", self.run.root, self.pipeline),
            b"",
            "text/plain",
        );
    }

    fn seen(&self) -> Result<Seen, String> {
        let mut seen = Seen::default();
        let mut helpers: HashMap<String, u64> = HashMap::new();
        let mine = |rest: &str| -> Option<String> {
            rest.strip_prefix(self.pipeline.as_str())?
                .strip_prefix('/')
                .map(str::to_string)
        };
        for key in self.run.state()? {
            if key == "end" {
                seen.ended = true;
            } else if let Some(rest) = key.strip_prefix("ended/") {
                seen.ended |= rest == self.pipeline;
            } else if let Some(n) = key.strip_prefix("primary.") {
                seen.primary = seen.primary.max(n.parse().ok());
            } else if let Some(rest) = key.strip_prefix("helper/") {
                if let Some((name, n)) = rest.rsplit_once('.')
                    && let Ok(n) = n.parse::<u64>()
                {
                    let beat = helpers.entry(name.to_string()).or_default();
                    *beat = (*beat).max(n);
                }
            } else if let Some(rest) = key.strip_prefix("done/") {
                if let Some(id) = mine(rest).and_then(|hex_id| job_id(&hex_id)) {
                    seen.done.push(id);
                }
            } else if let Some(rest) = key.strip_prefix("key/") {
                if let Some((runner, hex_key)) = rest.rsplit_once('.')
                    && runner_name(Some(runner)) == runner
                    && let Ok(public) = hex::decode(hex_key)
                    && public.len() == crate::sealed::PUBLIC_KEY_LEN
                {
                    seen.keys.push((runner.to_string(), public));
                }
            } else if let Some(rest) = key.strip_prefix("scratch/") {
                if let Some(rest) = mine(rest)
                    && let Some((runner, n)) = rest.rsplit_once('.')
                    && let Ok(n) = n.parse::<u64>()
                {
                    let layers = seen.scratch.entry(runner.to_string()).or_default();
                    *layers = (*layers).max(n);
                }
            } else if let Some(rest) = key.strip_prefix("back/")
                && let Some(rest) = mine(rest)
                && let Some((rest, n)) = rest.rsplit_once('.')
                && let Some((hex_id, runner)) = rest.rsplit_once('.')
                && let (Some(id), Ok(n)) = (job_id(hex_id), n.parse::<u64>())
            {
                seen.back.push((id, runner.to_string(), n));
            }
        }
        seen.helpers = helpers;
        Ok(seen)
    }

    fn has_secrets(&self) -> bool {
        !self.run.helper || self.run.secrets.load(Ordering::SeqCst)
    }

    fn seal_for(&self, runner: &str, sealed: &[u8]) -> Result<(), String> {
        if runner_name(Some(runner)) != runner {
            return Err("not a runner's name".into());
        }
        self.run
            .store
            .put_if_absent(
                &format!("{}/secrets/{runner}", self.run.root),
                sealed,
                "application/octet-stream",
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn put_scratch(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if !scratch_object_name(name) {
            return Err(format!("`{name}` is not a scratch object"));
        }
        self.run
            .store
            .put(
                &self.scratch_key(&self.run.runner, name),
                bytes,
                "application/octet-stream",
            )
            .map_err(|e| e.to_string())
    }

    fn get_scratch(&self, runner: &str, name: &str) -> Result<Option<Vec<u8>>, String> {
        if runner_name(Some(runner)) != runner {
            return Err("the record names no runner".into());
        }
        if !scratch_object_name(name) {
            return Err(format!("`{name}` is not a scratch object"));
        }
        self.run
            .store
            .get(&self.scratch_key(runner, name))
            .map_err(|e| e.to_string())
    }

    fn scratch_layer(&self, layer: u64) -> Result<(), String> {
        let marker = |n: u64| {
            format!(
                "{}/state/scratch/{}/{}.{n}",
                self.run.root, self.pipeline, self.run.runner
            )
        };
        self.run
            .store
            .put(&marker(layer), b"", "text/plain")
            .map_err(|e| e.to_string())?;
        // One marker each, so the listing every runner reads stays short.
        let before = self.scratch_marker.swap(layer, Ordering::SeqCst);
        if before != 0 && before < layer {
            let _ = self.run.store.delete(&marker(before));
        }
        Ok(())
    }

    fn timing(&self) -> Timing {
        self.run.timing
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn store(name: &str) -> (Arc<dyn ObjectStore>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("iwci-split-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Arc::new(iwci_store::LocalStore::new(&dir).unwrap()), dir)
    }

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    fn id(text: &str) -> RepoId {
        RepoId::new(text).unwrap()
    }

    fn pair(store: &Arc<dyn ObjectStore>) -> (Arc<SplitRun>, Arc<SplitRun>) {
        let new = |runner: &str, helper| {
            SplitRun::new(
                store.clone(),
                &id("acme"),
                &id("app"),
                &id("run1"),
                runner,
                helper,
            )
        };
        (new("ci-1", false), new("ci-2", true))
    }

    #[test]
    fn a_helper_gets_the_runs_secrets_sealed_and_the_store_never_holds_them() {
        let (objects, dir) = store("secrets");
        let (primary, helper) = pair(&objects);
        let (p, h) = (primary.pipeline("test.yml"), helper.pipeline("test.yml"));
        assert!(p.has_secrets() && !h.has_secrets());
        let opener = crate::sealed::Opener::new().unwrap();
        // Only a helper asks, and only with a key.
        assert!(primary.publish_key(opener.public()).is_err());
        assert!(helper.publish_key(b"short").is_err());
        helper.publish_key(opener.public()).unwrap();
        let keys = p.seen().unwrap().keys;
        assert_eq!(keys, vec![("ci-2".to_string(), opener.public().to_vec())]);

        let secrets = br#"{"TOKEN":"t0k3n-value"}"#;
        let sealed = crate::sealed::seal(&keys[0].1, secrets).unwrap();
        p.seal_for("ci-2", &sealed).unwrap();
        // The first one stays.
        p.seal_for("ci-2", b"another").unwrap();
        let got = helper
            .wait_for_secrets(Duration::from_secs(2), &|| false)
            .unwrap();
        assert_eq!(opener.open(&got).unwrap(), secrets);
        helper.got_secrets();
        assert!(h.has_secrets());

        // Nothing under the store's directory holds the value.
        let mut todo = vec![dir.clone()];
        while let Some(at) = todo.pop() {
            for entry in std::fs::read_dir(&at).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    todo.push(path);
                } else {
                    let bytes = std::fs::read(&path).unwrap();
                    assert!(
                        !bytes.windows(11).any(|w| w == b"t0k3n-value"),
                        "{}",
                        path.display()
                    );
                }
            }
        }
        // A helper with no secrets sealed to it gives up when told to.
        let (_, other) = pair(&store("secrets-none").0);
        assert!(
            other
                .wait_for_secrets(Duration::from_secs(5), &|| true)
                .is_none()
        );
    }

    #[test]
    fn one_runner_gets_a_claim_until_it_is_released_or_handed_back() {
        let (store, dir) = store("claims");
        let (primary, helper) = pair(&store);
        let (p, h) = (primary.pipeline("test.yml"), helper.pipeline("test.yml"));
        // Ids with characters no key may hold go in as hex.
        let job = "test[web, strict]";
        assert_eq!(h.claim(job).unwrap(), Claim::Ours);
        assert_eq!(p.claim(job).unwrap(), Claim::Held("ci-2".into()));
        assert_eq!(h.claim(job).unwrap(), Claim::Ours);
        // Another pipeline's job of the same id is another claim.
        assert_eq!(
            primary.pipeline("other.yml").claim(job).unwrap(),
            Claim::Ours
        );
        h.hand_back(job).unwrap();
        let seen = p.seen().unwrap();
        assert_eq!(seen.back.len(), 1);
        assert_eq!(
            (seen.back[0].0.as_str(), seen.back[0].1.as_str()),
            (job, "ci-2")
        );
        assert_eq!(p.claim(job).unwrap(), Claim::Ours);
        // Handing back a job the primary has since taken says so again,
        // and leaves the primary's claim where it is.
        h.hand_back(job).unwrap();
        assert_eq!(p.seen().unwrap().back.len(), 2);
        assert_eq!(h.claim(job).unwrap(), Claim::Held("ci-1".into()));
        p.release(job).unwrap();
        assert_eq!(h.claim(job).unwrap(), Claim::Ours);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn records_artifacts_and_markers_are_seen_by_the_other_runner() {
        let (store, dir) = store("seen");
        let (primary, helper) = pair(&store);
        let (p, h) = (primary.pipeline("test.yml"), helper.pipeline("test.yml"));
        let seen = h.seen().unwrap();
        assert_eq!(seen.primary, Some(1));
        assert_eq!(p.seen().unwrap().helpers.get("ci-2"), Some(&1));
        assert!(!seen.ended && seen.done.is_empty());

        h.finish("build", b"first").unwrap();
        // The first record stays.
        p.finish("build", b"second").unwrap();
        assert_eq!(p.done("build").unwrap().unwrap(), b"first");
        assert_eq!(p.done("other").unwrap(), None);
        assert_eq!(p.seen().unwrap().done, vec!["build".to_string()]);
        // Not another pipeline's.
        assert!(
            primary
                .pipeline("other.yml")
                .seen()
                .unwrap()
                .done
                .is_empty()
        );

        let entries = vec![Entry::File {
            path: "/app/dist/a.txt".into(),
            data: b"built".to_vec().into(),
        }];
        h.keep("build", &entries).unwrap();
        assert_eq!(p.kept("build", "ci-2", 1 << 20).unwrap().unwrap(), entries);
        assert!(p.kept("build", "ci-2", 2).is_err());
        assert_eq!(p.kept("other", "ci-2", 1 << 20).unwrap(), None);
        // A job two runners ran keeps each one's files apart, so a record
        // is never read with the other runner's.
        let other = vec![Entry::File {
            path: "/app/dist/a.txt".into(),
            data: b"built again".to_vec().into(),
        }];
        p.keep("build", &other).unwrap();
        assert_eq!(h.kept("build", "ci-2", 1 << 20).unwrap().unwrap(), entries);
        assert_eq!(h.kept("build", "ci-1", 1 << 20).unwrap().unwrap(), other);
        assert!(h.kept("build", "../ci-1", 1 << 20).is_err());

        assert!(!helper.ended("test.yml"));
        p.end();
        assert!(h.seen().unwrap().ended);
        assert!(helper.ended("test.yml"));
        assert!(!helper.ended("other.yml"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_helper_joins_only_when_asked_and_with_room_and_leaves_when_the_run_ends() {
        let (store, dir) = store("asked");
        let (primary, helper) = pair(&store);
        let p = primary.pipeline("test.yml");
        // Not asked: over as soon as it is told to stop.
        let polls = AtomicU64::new(0);
        let stopped = || polls.fetch_add(1, Ordering::SeqCst) >= 1;
        assert_eq!(helper.wait_to_be_asked(&|| true, &stopped), Asked::Over);
        p.ask();
        // Asked, but the primary has not said which commit: a request
        // that names a branch must not be resolved a second time, later.
        polls.store(0, Ordering::SeqCst);
        assert_eq!(helper.wait_to_be_asked(&|| true, &stopped), Asked::Over);
        // Only the primary says, and only a whole commit id.
        helper.publish_commit(COMMIT);
        primary.publish_commit("main");
        polls.store(0, Ordering::SeqCst);
        assert_eq!(helper.wait_to_be_asked(&|| true, &stopped), Asked::Over);
        primary.publish_commit(COMMIT);
        // Asked, but no room: still waiting when told to stop.
        polls.store(0, Ordering::SeqCst);
        assert_eq!(helper.wait_to_be_asked(&|| false, &stopped), Asked::Over);
        assert_eq!(
            helper.wait_to_be_asked(&|| true, &|| false),
            Asked::Join(COMMIT.into())
        );
        // A runner of another version asking is not for this one.
        let help = format!("splits/acme/app/run1/state/{}", help_key());
        store.delete(&help).unwrap();
        store
            .put(
                "splits/acme/app/run1/state/help.0.0.0-other",
                b"",
                "text/plain",
            )
            .unwrap();
        assert_eq!(helper.wait_to_be_asked(&|| true, &|| false), Asked::Over);
        // The end of the run is all that is left of it, and ends the wait.
        p.finish("build", b"{}").unwrap();
        primary.finish();
        let until = Instant::now() + Duration::from_secs(10);
        while store
            .list("splits/")
            .unwrap()
            .iter()
            .any(|k| !k.ends_with("/state/end"))
            && Instant::now() < until
        {
            // The helper's own sign of life goes when it is dropped.
            helper.finish();
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            store.list("splits/").unwrap(),
            vec!["splits/acme/app/run1/state/end".to_string()]
        );
        assert_eq!(helper.wait_to_be_asked(&|| true, &|| false), Asked::Over);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_runner_name_is_what_it_was_given_when_that_fits_a_key() {
        assert_eq!(runner_name(Some("ci-2")), "ci-2");
        for bad in [None, Some(""), Some("CI 2"), Some("a/b"), Some("a.b")] {
            let name = runner_name(bad);
            assert!(name.starts_with("runner-") && name.len() == 15, "{name}");
        }
    }
}
