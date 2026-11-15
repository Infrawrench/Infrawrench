//! Waiting for another run that computes the same task cache entry.
//!
//! Two pushes a minute apart each miss the task cache for every job the
//! first one changed: the second looks its entries up before the first
//! has saved them. So a job that misses asks first whether another run is
//! computing the same key right now, and if one is, waits for that run's
//! entry and replays it as a hit instead of computing it too.
//!
//! - **A marker per key, written just before the job starts** (see
//!   [`InFlight::begin`]), with a write only one run can make, and deleted
//!   once its entry is saved or the job ends without one. A run that finds
//!   another's marker, at its lookup or at that write, waits. A run's
//!   markers sit beside its entries' scope (`adapters::inflight`), so a run
//!   only ever waits for one whose entries it would read: a pull request
//!   for its own branch's runs and the default branch's, a push to the
//!   default branch for its own.
//! - **A waiting job holds nothing.** It is not queued, holds no slot and
//!   no memory, and counts only in its run's `running`, as a lookup in
//!   flight does. A marker is only ever held by a job that has started,
//!   and a started job waits for nothing, so waiting can never go round in
//!   a circle, whatever two runs wait on of each other's.
//! - **It stops waiting** when the marker goes (the entry is read again:
//!   a hit is replayed, a miss runs the job here), when the run that holds
//!   it stops saying it is alive, or past a deadline: twice that run's
//!   expected time for the job plus a margin, and never longer than the
//!   job's own `timeout:` plus two leases. Then it runs the job here and
//!   does not wait again.
//! - **A job that sat in the queue reads its entry again before it
//!   starts** ([`landed_meanwhile`]): another run may have saved it since
//!   the lookup, without this run ever seeing its marker, when that run
//!   started the job after the lookup and finished it while this job
//!   queued.
//! - **The runners of a split run count as one run**: they share a run
//!   identity, the primary's id, so none of them waits for the others'
//!   markers. Whoever claims the job runs it; the claim is taken after the
//!   marker and a runner that loses it leaves the marker to the winner
//!   (see [`InFlight::leave`]).

use super::*;
use sha2::Digest;

/// What [`InFlight`] says about another run computing a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    /// That run's id (a split run's primary's).
    pub run: String,
    /// How long that run expects the job to take, when it has run before.
    pub expected_ms: Option<u64>,
}

/// One look at the markers a run can see and who is alive.
#[derive(Debug, Clone, Default)]
pub struct Look {
    /// The keys being computed, as [`marker_id`] names them.
    pub markers: HashSet<String>,
    /// Per run with a marker anywhere this run looks: something that keeps
    /// changing while that run is alive.
    pub alive: HashMap<String, String>,
}

/// How often a waiting run looks, and how long it waits.
#[derive(Debug, Clone, Copy)]
pub struct InFlightTiming {
    /// Between looks while a job of the run waits.
    pub poll: Duration,
    /// How long a run may go without a sign of life before it is gone.
    pub lease: Duration,
    /// Added to twice the expected time of the job waited for.
    pub margin: Duration,
    /// How long a job that missed may queue before it reads its entry
    /// again as it starts.
    pub recheck: Duration,
}

impl Default for InFlightTiming {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(1),
            lease: Duration::from_secs(45),
            margin: Duration::from_secs(60),
            recheck: Duration::from_secs(5),
        }
    }
}

/// Which task cache keys other runs are computing now, in the store every
/// runner reads, scoped as the entries are. `adapters::inflight` keeps it
/// in the object store; an implementation says this run is alive for as
/// long as it holds a marker.
pub trait InFlight: Send + Sync {
    /// Says this run computes `key` from now. `Ok(None)` when it holds the
    /// key's marker now (or another runner of the same run did already);
    /// `Ok(Some(holder))` when another run does, writing nothing.
    fn begin(&self, key: &str, expected_ms: Option<u64>) -> Result<Option<Holder>, String>;
    /// This run is done computing `key` (its entry is saved, or it did not
    /// pass): the marker goes.
    fn end(&self, key: &str);
    /// This runner lost the job's split claim to another runner of the
    /// same run: the marker is left for that one to delete, unless this
    /// runner wrote it. The winner began before it claimed, so a marker
    /// written after that went up once the winner's was gone, and would
    /// outlive the job.
    fn leave(&self, key: &str);
    /// The other run computing `key`, if one is.
    fn holder(&self, key: &str) -> Result<Option<Holder>, String>;
    fn look(&self) -> Result<Look, String>;
    fn timing(&self) -> InFlightTiming {
        InFlightTiming::default()
    }
}

/// How a task cache key is named among the markers: a hash, so every key
/// fits a store key.
pub fn marker_id(key: &str) -> String {
    hex::encode(&sha2::Sha256::digest(key.as_bytes())[..16])
}

/// A job that missed while another run computes its key.
pub(super) struct Waiting {
    pub key: String,
    pub holder: Holder,
    /// Its task cache lines so far.
    pub lines: Vec<String>,
}

/// A job waiting for another run's entry; counted in `running`.
pub(super) struct Awaiting<'p> {
    pub template: &'p JobTemplate,
    pub job: PlannedJob,
    pub rank: Rank,
    pub waiting: Waiting,
    pub since: Instant,
    /// How long it waits at most.
    pub limit: Duration,
}

/// A job that is done waiting, on its way back to the lookups.
pub(super) struct Waited {
    pub waiting: Waiting,
    pub since: Instant,
    /// Why it stopped waiting before the marker went, if it did.
    pub why: Option<String>,
}

/// The run computing `key`, when it is not this one and this run may wait
/// for it. A store that does not answer is no other run.
pub(super) fn holder(options: &Options, key: &str) -> Option<Holder> {
    if options.skip_task_cache {
        return None;
    }
    options.inflight.as_ref()?.holder(key).ok().flatten()
}

/// Puts a job among those waiting for another run. The caller counts it
/// in `running` already.
pub(super) fn wait<'p>(
    s: &mut State<'p>,
    options: &Options,
    template: &'p JobTemplate,
    job: PlannedJob,
    rank: Rank,
    waiting: Waiting,
) {
    let timing = options
        .inflight
        .as_ref()
        .map(|i| i.timing())
        .unwrap_or_default();
    // Never past the job's own timeout, which stops the other run's copy
    // too, whatever that run says to expect.
    let cap = job.timeout + timing.lease * 2;
    let limit = waiting.holder.expected_ms.map_or(cap, |ms| {
        (Duration::from_millis(ms) * 2 + timing.margin).min(cap)
    });
    s.awaiting.push(Awaiting {
        template,
        job,
        rank,
        waiting,
        since: Instant::now(),
        limit,
    });
}

/// The report of a job about to start whose entry another run saved
/// while it queued: read again once it has queued for
/// [`InFlightTiming::recheck`], one read of the store against a run of
/// the job. `None` runs it.
#[allow(clippy::too_many_arguments)]
pub(super) fn landed_meanwhile(
    job: &PlannedJob,
    plan: &Plan,
    options: &Options,
    shared: &RunShared<'_>,
    lookup: &Lookup,
    kept: &mut Vec<Entry>,
) -> Option<JobReport> {
    let inflight = options.inflight.as_ref()?;
    let queued = lookup.queued?.elapsed();
    if options.skip_task_cache || queued < inflight.timing().recheck {
        return None;
    }
    let key = lookup.key.as_deref()?;
    let started = Instant::now();
    let hit = options
        .caches
        .as_ref()?
        .restore(key, &[], plan.scratch_bytes + MAX_TASK_LOG)
        .ok()??;
    let mut report = replay(job, plan, options, shared, key, hit.entries, started, kept).ok()?;
    report.queued_ms = millis(queued);
    report.caches = lookup.lines.clone();
    report.caches.push(format!(
        "task cache `{}`: hit, saved by another run while this one queued {}",
        short_key(key),
        secs(queued)
    ));
    Some(report)
}

/// What [`begin`] decided for a job about to start.
pub(super) enum Begun<'a> {
    /// It runs, holding the key's marker when it got one.
    Run(Option<Marker<'a>>),
    /// Another run computes the key: it waits.
    Wait(Holder),
}

/// Says a job that is about to start computes its task cache key, unless
/// another run does already and the job may wait for it. A job that has
/// waited once, or whose run skips the task cache, runs whatever; a store
/// that does not answer is a job that runs without a marker.
pub(super) fn begin<'a>(options: &'a Options, lookup: &Lookup) -> Begun<'a> {
    let (Some(inflight), Some(key)) = (options.inflight.as_deref(), lookup.key.as_deref()) else {
        return Begun::Run(None);
    };
    match inflight.begin(key, lookup.history_ms) {
        Ok(None) => Begun::Run(Some(Marker {
            inflight,
            key: key.to_string(),
            left: false,
        })),
        Ok(Some(holder)) if !options.skip_task_cache && !lookup.waited => Begun::Wait(holder),
        Ok(Some(_)) | Err(_) => Begun::Run(None),
    }
}

/// A key this runner computes: the marker goes when this is dropped.
pub(super) struct Marker<'a> {
    inflight: &'a dyn InFlight,
    key: String,
    left: bool,
}

impl Marker<'_> {
    /// Another runner of the same run claimed the job: the marker is that
    /// runner's to delete.
    pub fn leave(mut self) {
        self.inflight.leave(&self.key);
        self.left = true;
    }
}

impl Drop for Marker<'_> {
    fn drop(&mut self) {
        if !self.left {
            self.inflight.end(&self.key);
        }
    }
}

fn secs(d: Duration) -> String {
    format!("{:.1}s", d.as_secs_f64())
}

/// Reads the entry a job waited for: a hit is replayed as one, with whom
/// it waited for; anything else runs the job here, which does not wait
/// again.
#[allow(clippy::too_many_arguments)]
pub(super) fn look_again(
    job: &PlannedJob,
    plan: &Plan,
    options: &Options,
    shared: &RunShared<'_>,
    waited: Waited,
    kept: &mut Vec<Entry>,
) -> Looked {
    let started = Instant::now();
    let Waited {
        waiting: Waiting {
            key,
            holder,
            mut lines,
        },
        since,
        why,
    } = waited;
    let waited_for = started.saturating_duration_since(since);
    // Whatever another run wrote is masked like anything else that ends up
    // in a report.
    let run = shared.mask.mask(&holder.run);
    let short = short_key(&key);
    let found = match &options.caches {
        Some(store) => store.restore(&key, &[], plan.scratch_bytes + MAX_TASK_LOG),
        None => Ok(None),
    };
    match found {
        Ok(Some(hit)) => match replay(job, plan, options, shared, &key, hit.entries, started, kept)
        {
            Ok(mut report) => {
                report.waited_for = Some(run.clone());
                report.queued_ms = millis(waited_for);
                report.caches = vec![format!(
                    "task cache `{short}`: hit, saved by run `{run}` while this one waited {}",
                    secs(waited_for)
                )];
                report.notes.insert(
                    0,
                    format!(
                        "task cache: run `{run}` was running it with the same inputs, so this run waited {} for its result rather than run it too",
                        secs(waited_for)
                    ),
                );
                return Looked::Done(Box::new(report));
            }
            Err(e) => lines.push(format!(
                "task cache `{short}`: could not use the entry run `{run}` saved ({e}); running it"
            )),
        },
        Ok(None) => lines.push(match why {
            None => format!(
                "task cache `{short}`: waited {} for run `{run}`, which saved no entry (it did not pass); running it",
                secs(waited_for)
            ),
            Some(why) => format!(
                "task cache `{short}`: waited {} for run `{run}`, which {why}; running it",
                secs(waited_for)
            ),
        }),
        Err(e) => lines.push(format!(
            "task cache `{short}`: waited {} for run `{run}`, then could not read the cache ({e}); running it",
            secs(waited_for)
        )),
    }
    Looked::Run(Lookup {
        key: Some(key),
        lines,
        waited: true,
        ..Lookup::default()
    })
}

/// Follows the markers the run's waiting jobs wait for, once every
/// [`InFlightTiming::poll`] while any does: a job whose marker went, whose
/// holder stopped saying it is alive, or that has waited past its limit
/// goes back to the lookups. Lists the store and reads nothing else.
pub(super) fn watch<'p>(
    inflight: &dyn InFlight,
    state: &Mutex<State<'p>>,
    wake: &Wake,
    plan: &'p Plan,
    options: &Options,
) {
    let timing = inflight.timing();
    // Each holder's sign of life and when it last changed, by this clock.
    let mut alive: HashMap<String, (String, Instant)> = HashMap::new();
    let mut next = Instant::now();
    loop {
        {
            let mut s = state.lock().unwrap();
            loop {
                if s.done {
                    return;
                }
                let now = Instant::now();
                if !s.awaiting.is_empty() && (now >= next || options.stopped().is_some()) {
                    break;
                }
                // Nothing waits: whatever starts a wait, ends the run or
                // cancels it wakes this.
                let seen = wake.seen();
                let limit = (!s.awaiting.is_empty()).then(|| next.saturating_duration_since(now));
                s = wake.wait_at_most(s, state, seen, limit);
            }
        }
        next = Instant::now() + timing.poll;
        if let Some(reason) = options.stopped() {
            let left = std::mem::take(&mut state.lock().unwrap().awaiting);
            for a in left {
                let report = cancelled_report(&a.job, reason);
                complete(state, wake, plan, options, a.template, report, Vec::new());
            }
            continue;
        }
        let look = inflight.look();
        let now = Instant::now();
        if let Ok(look) = &look {
            for (run, sign) in &look.alive {
                if alive.get(run).is_none_or(|(was, _)| was != sign) {
                    alive.insert(run.clone(), (sign.clone(), now));
                }
            }
        }
        let mut s = state.lock().unwrap();
        let mut back = Vec::new();
        let mut i = 0;
        while i < s.awaiting.len() {
            let a = &s.awaiting[i];
            let run = &a.waiting.holder.run;
            let late = now.saturating_duration_since(a.since) >= a.limit;
            let why = match &look {
                // Saved, or given up: the entry says which.
                Ok(look) if !look.markers.contains(&marker_id(&a.waiting.key)) => Some(None),
                Ok(look) if !look.alive.contains_key(run) => {
                    Some(Some("is no longer running".to_string()))
                }
                Ok(_)
                    if alive.get(run).is_some_and(|(_, at)| {
                        now.saturating_duration_since(*at) >= timing.lease
                    }) =>
                {
                    Some(Some(format!(
                        "had not said it was alive for {}",
                        secs(timing.lease)
                    )))
                }
                _ if late => Some(Some(format!("had not finished it after {}", secs(a.limit)))),
                _ => None,
            };
            match why {
                Some(why) => back.push((s.awaiting.swap_remove(i), why)),
                None => i += 1,
            }
        }
        for (a, why) in back {
            // Counted again when a lookup thread takes it.
            s.running -= 1;
            enqueue(
                &mut s.lookups,
                a.rank,
                (
                    a.template,
                    a.job,
                    Some(Box::new(Waited {
                        waiting: a.waiting,
                        since: a.since,
                        why,
                    })),
                ),
            );
        }
        drop(s);
        wake.notify_all();
    }
}
