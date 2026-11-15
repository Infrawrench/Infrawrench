//! Which task cache keys runs are computing now (`schedule::InFlight`
//! says what it is for), in the object store every runner reads.
//!
//! Everything is under `inflight/<owner>/<repo-id>/<scope>/`, `<scope>`
//! being the scope the run saves its task cache entries in
//! (`adapters::caches`). A run writes only in its own scope and looks in
//! every scope it reads entries from, so it waits only for runs whose
//! entries it would replay anyway: a pull request for runs of its own
//! branch and of the default branch, a push for runs of its own branch
//! (and of the default branch, when it is another). Nothing a pull request
//! writes is looked at by a push to the default branch.
//!
//! | Key | What |
//! |-----|------|
//! | `keys/<id>` | a run computes the key whose `schedule::marker_id` is `<id>`: JSON naming the run and its runner, and how long the job took last time. Written only if absent |
//! | `ended/<id>` | how the last job that held `<id>` ended, when it saved no entry: JSON naming the run |
//! | `runs/<run>/<runner>.<n>` | that runner of the run is alive; `<n>` moves every [`BEAT`] from its first marker or wait to the end of the run |
//!
//! `<run>` is the run's id, or for a runner helping a split run, the id of
//! the run it helps: the runners of a split run count as one. A marker is
//! deleted in the background once its job ends, and only while it still
//! names the run; what is left when the run ends is deleted then, also in
//! the background. Whatever a runner that died left is swept a day later
//! ([`sweep`]), and a run that sees another's sign of life older than its
//! own by more than a lease counts that run gone at once. None of it counts
//! against an owner's storage quota.

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use iwci_store::{ObjectStore, RepoId};

use crate::adapters::split::{BEAT, Beating, in_background, sweep_under};
use crate::schedule::{Ended, Holder, InFlight, InFlightTiming, Look, marker_id};

/// The prefix of every marker and sign of life.
pub const PREFIX: &str = "inflight";

/// What a marker holds.
#[derive(serde::Serialize, serde::Deserialize)]
struct Body {
    run: String,
    runner: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_ms: Option<u64>,
}

/// What `ended/<id>` holds.
#[derive(serde::Serialize, serde::Deserialize)]
struct EndedBody {
    run: String,
    ended: Ended,
}

/// What reading a marker found.
enum Read {
    Absent,
    /// Something that does not read as a marker, or names no run.
    Malformed,
    Body(Body),
}

/// What is left to do in the store, in the order it was asked for.
enum Task {
    /// A job is over: say how, when it saved nothing, and delete its
    /// marker. `None` deletes without a word.
    End { id: String, ended: Option<Ended> },
    /// The run is over.
    Finish(Option<Beating>),
}

/// What the run and its background writer share.
struct Inner {
    store: Arc<dyn ObjectStore>,
    /// `inflight/<owner>/<repo-id>`.
    root: String,
    write_scope: String,
    run: String,
    runner: String,
    /// Markers of this run's this runner wrote (`true`) or took on from
    /// another runner of the run (`false`), by id; whatever is left when
    /// the run ends is deleted if it still names the run.
    held: Mutex<HashMap<String, bool>>,
}

/// The markers of one run, as that run sees them and writes its own.
pub struct StoreInFlight {
    inner: Arc<Inner>,
    read_scopes: Vec<String>,
    timing: InFlightTiming,
    /// Between this runner's signs of life.
    every: Duration,
    /// This runner's sign of life, from its first marker or wait to its
    /// end.
    beat: Mutex<Option<Beating>>,
    /// Where marker deletes go, once something has been marked.
    tasks: Mutex<Option<Sender<Task>>>,
    /// The last look, for lookups that ask within half a poll of it.
    looked: Mutex<Option<(Instant, Look)>>,
}

impl Inner {
    fn marker(&self, scope: &str, id: &str) -> String {
        format!("{}/{scope}/keys/{id}", self.root)
    }

    fn held(&self) -> MutexGuard<'_, HashMap<String, bool>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read(&self, scope: &str, id: &str) -> Result<Read, String> {
        let Some(bytes) = self
            .store
            .get(&self.marker(scope, id))
            .map_err(|e| e.to_string())?
        else {
            return Ok(Read::Absent);
        };
        Ok(match serde_json::from_slice::<Body>(&bytes) {
            Ok(body) if RepoId::new(body.run.as_str()).is_ok() => Read::Body(body),
            _ => Read::Malformed,
        })
    }

    /// Deletes marker `id` if it still names this run and was written by
    /// this runner (or taken on from another runner of the run, when not
    /// `ours`). `true` once it is not this run's to delete any more.
    fn delete_if_ours(&self, id: &str, ours: bool) -> bool {
        match self.read(&self.write_scope, id) {
            Ok(Read::Body(body))
                if body.run == self.run && (body.runner == self.runner || !ours) =>
            {
                self.store
                    .delete(&self.marker(&self.write_scope, id))
                    .is_ok()
            }
            Ok(_) => true,
            Err(_) => false,
        }
    }

    /// Does what was asked, in order, until the run is over.
    fn work(&self, tasks: Receiver<Task>) {
        for task in tasks {
            match task {
                Task::End { id, ended } => {
                    if let Some(ended) = ended.filter(|e| *e != Ended::Saved) {
                        let body = EndedBody {
                            run: self.run.clone(),
                            ended,
                        };
                        let _ = self.store.put(
                            &format!("{}/{}/ended/{id}", self.root, self.write_scope),
                            &serde_json::to_vec(&body).unwrap_or_default(),
                            "application/json",
                        );
                    }
                    let ours = self.held().get(&id).copied().unwrap_or(true);
                    // A few times, a little apart; what still fails is
                    // tried again when the run ends.
                    for wait in [0u64, 200, 1000] {
                        std::thread::sleep(Duration::from_millis(wait));
                        if self.delete_if_ours(&id, ours) {
                            self.held().remove(&id);
                            break;
                        }
                    }
                }
                Task::Finish(beat) => {
                    let left: Vec<(String, bool)> = self.held().drain().collect();
                    for (id, ours) in left {
                        self.delete_if_ours(&id, ours);
                    }
                    // Its sign of life goes last, and in the background.
                    drop(beat);
                    return;
                }
            }
        }
    }
}

impl StoreInFlight {
    /// The markers of run `run` (a helper's: the run it helps) of
    /// `repo`, written into `write_scope` and read from `read_scopes`,
    /// which are its task cache entries' scopes. `runner` tells this
    /// runner's sign of life from another's of the same run.
    pub fn new(
        store: Arc<dyn ObjectStore>,
        owner: &RepoId,
        repo: &RepoId,
        (write_scope, read_scopes): (&str, &[String]),
        run: &RepoId,
        runner: &str,
    ) -> Self {
        Self::with_timing(
            store,
            owner,
            repo,
            (write_scope, read_scopes),
            run,
            runner,
            InFlightTiming::default(),
            BEAT,
        )
    }

    /// [`StoreInFlight::new`], looking as `timing` says and saying it is
    /// alive every `every`.
    #[allow(clippy::too_many_arguments)]
    pub fn with_timing(
        store: Arc<dyn ObjectStore>,
        owner: &RepoId,
        repo: &RepoId,
        (write_scope, read_scopes): (&str, &[String]),
        run: &RepoId,
        runner: &str,
        timing: InFlightTiming,
        every: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                root: format!("{PREFIX}/{}/{}", owner.as_str(), repo.as_str()),
                write_scope: write_scope.to_string(),
                run: run.as_str().to_string(),
                runner: runner.to_string(),
                held: Mutex::default(),
            }),
            read_scopes: read_scopes.to_vec(),
            timing,
            every,
            beat: Mutex::new(None),
            tasks: Mutex::new(None),
            looked: Mutex::new(None),
        }
    }

    /// Says this runner is alive, from now to its end, and starts what
    /// deletes its markers. Before its first marker, so nobody finds that
    /// marker without it, and when it first waits, so its own sign of life
    /// is there to tell another's age by.
    fn alive(&self) {
        let mut beat = self.beat.lock().unwrap_or_else(|e| e.into_inner());
        if beat.is_some() {
            return;
        }
        let key = format!(
            "{}/{}/runs/{}/{}",
            self.inner.root, self.inner.write_scope, self.inner.run, self.inner.runner
        );
        *beat = Some(Beating::start(self.inner.store.clone(), key, self.every));
        let (send, receive) = channel();
        *self.tasks.lock().unwrap_or_else(|e| e.into_inner()) = Some(send);
        let inner = self.inner.clone();
        in_background("iwci-inflight", move || inner.work(receive));
    }

    fn send(&self, task: Task) {
        if let Some(tasks) = self
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = tasks.send(task);
        }
    }

    fn holder_of(&self, scope: &str, id: &str, body: Body, look: Option<&Look>) -> Holder {
        let at = format!("{scope}/{id}");
        Holder {
            run: body.run,
            expected_ms: body.expected_ms,
            version: look.and_then(|l| l.markers.get(&at).cloned()),
            at,
        }
    }

    /// The markers and signs of life in every scope this run reads, one
    /// listing each.
    fn list(&self) -> Result<Look, String> {
        let mut look = Look::default();
        // Per run, its signs of life and the newest one's age by the store.
        let mut signs: HashMap<String, (Vec<String>, u64)> = HashMap::new();
        for scope in &self.read_scopes {
            let prefix = format!("{}/{scope}/", self.inner.root);
            let objects = self
                .inner
                .store
                .list_detailed(&prefix)
                .map_err(|e| e.to_string())?;
            for object in objects {
                let Some(rest) = object.key.strip_prefix(&prefix) else {
                    continue;
                };
                if let Some(id) = rest.strip_prefix("keys/") {
                    let version = format!("{}:{}", object.modified.unwrap_or(0), object.size);
                    look.markers.insert(format!("{scope}/{id}"), version);
                } else if let Some((run, beat)) =
                    rest.strip_prefix("runs/").and_then(|r| r.split_once('/'))
                {
                    let sign = signs.entry(run.to_string()).or_default();
                    sign.0.push(beat.to_string());
                    sign.1 = sign.1.max(object.modified.unwrap_or(0));
                }
            }
        }
        // The store's own clock: this run's newest sign of life. Another
        // run's that is older by more than a lease belongs to a runner
        // that died without deleting it.
        let now = signs
            .get(&self.inner.run)
            .map(|(_, at)| *at)
            .filter(|at| *at > 0);
        let lease = self.timing.lease.as_secs().max(1);
        for (run, (mut beats, newest)) in signs {
            if now.is_some_and(|now| newest > 0 && newest.saturating_add(lease) < now) {
                look.gone.insert(run.clone());
            }
            beats.sort();
            look.alive.insert(run, beats.join(","));
        }
        Ok(look)
    }
}

impl InFlight for StoreInFlight {
    fn begin(
        &self,
        key: &str,
        expected_ms: Option<u64>,
        replacing: Option<&str>,
    ) -> Result<Option<Holder>, String> {
        let inner = &self.inner;
        let id = marker_id(key);
        // A run of the default branch computing it, for a pull request:
        // read only when the last look saw a marker there.
        let others: Vec<&String> = self
            .read_scopes
            .iter()
            .filter(|s| **s != inner.write_scope)
            .collect();
        if !others.is_empty() {
            let look = self.look()?;
            for scope in others {
                if look.markers.contains_key(&format!("{scope}/{id}"))
                    && let Read::Body(body) = inner.read(scope, &id)?
                    && body.run != inner.run
                    && Some(body.run.as_str()) != replacing
                {
                    return Ok(Some(self.holder_of(scope, &id, body, Some(&look))));
                }
            }
        }
        self.alive();
        let body = serde_json::to_vec(&Body {
            run: inner.run.clone(),
            runner: inner.runner.clone(),
            expected_ms,
        })
        .map_err(|e| e.to_string())?;
        let own = inner.marker(&inner.write_scope, &id);
        // Twice, for a marker deleted between the write and the read.
        for _ in 0..2 {
            match inner.store.put_if_absent(&own, &body, "application/json") {
                Ok(true) => {
                    inner.held().insert(id, true);
                    return Ok(None);
                }
                Ok(false) => {}
                Err(e) => {
                    // A write whose answer was lost may have landed: the
                    // end of the run deletes it if it names this runner.
                    inner.held().insert(id.clone(), true);
                    return match inner.read(&inner.write_scope, &id) {
                        Ok(Read::Body(b)) if b.run == inner.run && b.runner == inner.runner => {
                            Ok(None)
                        }
                        _ => Err(e.to_string()),
                    };
                }
            }
            match inner.read(&inner.write_scope, &id)? {
                // Another runner of this run's: whichever runs the job
                // deletes it.
                Read::Body(b) if b.run == inner.run => {
                    inner.held().entry(id).or_insert(false);
                    return Ok(None);
                }
                // A run that is gone: its marker is taken over.
                Read::Body(b) if Some(b.run.as_str()) == replacing => {
                    let _ = inner.store.delete(&own);
                }
                Read::Body(b) => {
                    return Ok(Some(self.holder_of(&inner.write_scope, &id, b, None)));
                }
                Read::Malformed => {
                    return Err("its marker in the store does not name a run".into());
                }
                Read::Absent => {}
            }
        }
        Err("the key's marker keeps changing hands".into())
    }

    fn end(&self, key: &str, ended: Ended) {
        self.send(Task::End {
            id: marker_id(key),
            ended: Some(ended),
        });
    }

    fn leave(&self, key: &str, done: bool) {
        let id = marker_id(key);
        let wrote = self.inner.held().get(&id).copied().unwrap_or(false);
        if !wrote {
            // The winner's own: it deletes it.
            self.inner.held().remove(&id);
        } else if done {
            // Written after the winner's had gone: nobody else will.
            self.send(Task::End { id, ended: None });
        }
        // Otherwise the winner began after this runner wrote it and
        // deletes it; failing that, the end of this run does.
    }

    fn holder(&self, key: &str) -> Result<Option<Holder>, String> {
        let id = marker_id(key);
        let look = self.look()?;
        for scope in &self.read_scopes {
            if !look.markers.contains_key(&format!("{scope}/{id}")) {
                continue;
            }
            if let Read::Body(body) = self.inner.read(scope, &id)?
                && body.run != self.inner.run
            {
                // This run waits: its own sign of life is the clock the
                // holder's is timed by.
                self.alive();
                return Ok(Some(self.holder_of(scope, &id, body, Some(&look))));
            }
        }
        Ok(None)
    }

    fn ended(&self, key: &str, holder: &Holder) -> Option<Ended> {
        let (scope, _) = holder.at.split_once('/')?;
        let bytes = self
            .inner
            .store
            .get(&format!(
                "{}/{scope}/ended/{}",
                self.inner.root,
                marker_id(key)
            ))
            .ok()??;
        let body: EndedBody = serde_json::from_slice(&bytes).ok()?;
        (body.run == holder.run).then_some(body.ended)
    }

    fn look(&self) -> Result<Look, String> {
        // Held while listing, so the lookups of one run list once between
        // them.
        let mut looked = self.looked.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, look)) = looked.as_ref()
            && at.elapsed() < self.timing.poll / 2
        {
            return Ok(look.clone());
        }
        let look = self.list()?;
        *looked = Some((Instant::now(), look.clone()));
        Ok(look)
    }

    fn timing(&self) -> InFlightTiming {
        self.timing
    }
}

impl Drop for StoreInFlight {
    /// The run is over: what its jobs did not delete goes, then its sign
    /// of life, both in the background, after what was asked before.
    fn drop(&mut self) {
        let beat = self.beat.lock().unwrap_or_else(|e| e.into_inner()).take();
        match self.tasks.lock().unwrap_or_else(|e| e.into_inner()).take() {
            Some(tasks) => {
                let _ = tasks.send(Task::Finish(beat));
            }
            None => drop(beat),
        }
    }
}

/// Removes markers and signs of life written more than a day ago: what a
/// runner that died left.
pub fn sweep(store: &dyn ObjectStore, now: u64) -> Result<usize, String> {
    sweep_under(store, PREFIX, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn store(name: &str) -> (Arc<dyn ObjectStore>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("iwci-inflight-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Arc::new(iwci_store::LocalStore::new(&dir).unwrap()), dir)
    }

    fn id(text: &str) -> RepoId {
        RepoId::new(text).unwrap()
    }

    const FAST: InFlightTiming = InFlightTiming {
        poll: Duration::from_millis(20),
        lease: Duration::from_millis(500),
        margin: Duration::from_millis(100),
        recheck: Duration::from_millis(50),
    };

    /// A run on `branch` (`pr` for a pull request), with the scopes the
    /// task cache gives it: a push reads its own and `main`'s.
    fn run_of(store: &Arc<dyn ObjectStore>, run: &str, scope: &str, runner: &str) -> StoreInFlight {
        let reads: Vec<String> = if scope == "b-main" {
            vec!["b-main".into()]
        } else {
            vec![scope.into(), "b-main".into()]
        };
        StoreInFlight::with_timing(
            store.clone(),
            &id("acme"),
            &id("app"),
            (scope, &reads),
            &id(run),
            runner,
            FAST,
            Duration::from_millis(20),
        )
    }

    /// Waits up to five seconds for `done`.
    fn eventually(what: &str, done: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn marked(store: &Arc<dyn ObjectStore>, scope: &str, key: &str) -> bool {
        store
            .get(&format!(
                "inflight/acme/app/{scope}/keys/{}",
                marker_id(key)
            ))
            .unwrap()
            .is_some()
    }

    fn run_of_holder(h: Option<Holder>) -> Option<String> {
        h.map(|h| h.run)
    }

    #[test]
    fn one_run_holds_a_key_and_others_see_it_until_it_ends() {
        let (store, dir) = store("hold");
        let a = run_of(&store, "run-a", "b-main", "ci-1");
        let b = run_of(&store, "run-b", "b-main", "ci-2");
        assert_eq!(b.holder("task/x/1").unwrap(), None);
        assert_eq!(a.begin("task/x/1", Some(1500), None).unwrap(), None);
        let held = b.begin("task/x/1", None, None).unwrap().unwrap();
        assert_eq!((held.run.as_str(), held.expected_ms), ("run-a", Some(1500)));
        assert_eq!(held.at, format!("b-main/{}", marker_id("task/x/1")));
        // Looked at again only once the last look is old enough.
        std::thread::sleep(FAST.poll);
        let found = b.holder("task/x/1").unwrap().unwrap();
        assert_eq!(found.run, "run-a");
        assert!(found.version.is_some());
        let look = b.look().unwrap();
        assert!(look.markers.contains_key(&found.at));
        assert!(look.alive.contains_key("run-a") && look.gone.is_empty());
        // A run never waits for itself.
        assert_eq!(a.holder("task/x/1").unwrap(), None);
        assert_eq!(a.begin("task/x/1", None, None).unwrap(), None);
        // Another key is free.
        assert_eq!(b.begin("task/y/1", None, None).unwrap(), None);
        // A job that did not pass says so, and its marker goes, in the
        // background.
        a.end("task/x/1", Ended::Failed);
        eventually("the marker to go", || !marked(&store, "b-main", "task/x/1"));
        assert_eq!(b.ended("task/x/1", &held), Some(Ended::Failed));
        std::thread::sleep(FAST.poll);
        assert_eq!(b.holder("task/x/1").unwrap(), None);
        // A's sign of life moves while it lives, and goes with it.
        let first = b.look().unwrap().alive["run-a"].clone();
        eventually("a's sign of life to move", || {
            b.look().unwrap().alive.get("run-a") != Some(&first)
        });
        drop(a);
        eventually("a's sign of life to go", || {
            !b.look().unwrap().alive.contains_key("run-a")
        });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn markers_are_scoped_as_task_cache_entries_are() {
        let (store, dir) = store("scopes");
        let main = run_of(&store, "run-main", "b-main", "ci-1");
        let pr = run_of(&store, "run-pr", "pr-1", "ci-2");
        let fork = run_of(&store, "run-fork", "pr-2", "ci-2");
        // A pull request waits for the default branch, which it reads.
        assert_eq!(main.begin("task/x/1", None, None).unwrap(), None);
        std::thread::sleep(FAST.poll);
        assert_eq!(
            run_of_holder(pr.begin("task/x/1", None, None).unwrap()),
            Some("run-main".into())
        );
        // The default branch never waits for a pull request, nor does a
        // pull request for another's.
        assert_eq!(pr.begin("task/y/1", None, None).unwrap(), None);
        assert_eq!(main.holder("task/y/1").unwrap(), None);
        std::thread::sleep(FAST.poll);
        assert_eq!(fork.holder("task/y/1").unwrap(), None);
        assert_eq!(fork.begin("task/y/1", None, None).unwrap(), None);
        assert_eq!(main.begin("task/y/1", None, None).unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_runner_that_loses_the_claim_leaves_a_marker_its_partner_runs_under() {
        let (store, dir) = store("leave-running");
        let (primary, helper) = (
            run_of(&store, "run-a", "b-main", "ci-1"),
            run_of(&store, "run-a", "b-main", "ci-2"),
        );
        let other = run_of(&store, "run-b", "b-main", "ci-3");
        // The helper writes it, the primary begins after and claims the
        // job: the helper leaves it while the job is not done.
        assert_eq!(helper.begin("task/x/1", None, None).unwrap(), None);
        assert_eq!(primary.begin("task/x/1", None, None).unwrap(), None);
        helper.leave("task/x/1", false);
        std::thread::sleep(Duration::from_millis(100));
        assert!(marked(&store, "b-main", "task/x/1"));
        assert!(other.begin("task/x/1", None, None).unwrap().is_some());
        // The primary, which took it on, deletes it as the job ends.
        primary.end("task/x/1", Ended::Saved);
        eventually("the marker to go", || !marked(&store, "b-main", "task/x/1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_runner_that_loses_the_claim_to_a_finished_job_deletes_what_it_wrote() {
        let (store, dir) = store("leave-done");
        let (primary, helper) = (
            run_of(&store, "run-a", "b-main", "ci-1"),
            run_of(&store, "run-a", "b-main", "ci-2"),
        );
        let other = run_of(&store, "run-b", "b-main", "ci-3");
        // The primary ran it and deleted its marker; the helper writes one
        // after that and then finds the job done.
        assert_eq!(primary.begin("task/w/1", None, None).unwrap(), None);
        primary.end("task/w/1", Ended::Saved);
        eventually("the marker to go", || !marked(&store, "b-main", "task/w/1"));
        assert_eq!(helper.begin("task/w/1", None, None).unwrap(), None);
        helper.leave("task/w/1", true);
        eventually("the late marker to go", || {
            !marked(&store, "b-main", "task/w/1")
        });
        assert_eq!(other.begin("task/w/1", None, None).unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_deletes_only_markers_that_name_it_and_the_rest_when_it_ends() {
        let (store, dir) = store("end");
        let a = run_of(&store, "run-a", "b-main", "ci-1");
        let b = run_of(&store, "run-b", "b-main", "ci-2");
        assert_eq!(a.begin("task/x/1", None, None).unwrap(), None);
        // Gone, and taken by another run, before `a`'s delete runs.
        let marker = format!("inflight/acme/app/b-main/keys/{}", marker_id("task/x/1"));
        store.delete(&marker).unwrap();
        assert_eq!(b.begin("task/x/1", None, None).unwrap(), None);
        a.end("task/x/1", Ended::Saved);
        std::thread::sleep(Duration::from_millis(100));
        assert!(marked(&store, "b-main", "task/x/1"), "b's marker stays");
        // A marker its job never deleted goes with the run.
        assert_eq!(b.begin("task/z/1", None, None).unwrap(), None);
        drop(b);
        eventually("b's markers to go", || {
            !marked(&store, "b-main", "task/x/1") && !marked(&store, "b-main", "task/z/1")
        });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_marker_of_a_run_that_is_gone_is_taken_over() {
        let (store, dir) = store("replace");
        let b = run_of(&store, "run-b", "b-main", "ci-2");
        // What a runner that died leaves: a marker, and no one to end it.
        store
            .put(
                &format!("inflight/acme/app/b-main/keys/{}", marker_id("task/x/1")),
                b"{\"run\":\"run-dead\",\"runner\":\"ci-9\"}",
                "application/json",
            )
            .unwrap();
        assert!(b.begin("task/x/1", None, None).unwrap().is_some());
        assert_eq!(b.begin("task/x/1", None, Some("run-dead")).unwrap(), None);
        let body = store
            .get(&format!(
                "inflight/acme/app/b-main/keys/{}",
                marker_id("task/x/1")
            ))
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains("run-b"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_marker_that_names_no_run_is_nobodys_and_says_so() {
        let (store, dir) = store("garbage");
        let b = run_of(&store, "run-b", "b-main", "ci-2");
        let key = format!("inflight/acme/app/b-main/keys/{}", marker_id("task/x/1"));
        store
            .put(
                &key,
                b"{\"run\":\"../x\",\"runner\":\"r\"}",
                "application/json",
            )
            .unwrap();
        assert_eq!(b.holder("task/x/1").unwrap(), None);
        // Held all the same: nothing is written over it.
        let e = b.begin("task/x/1", None, None).unwrap_err();
        assert!(e.contains("does not name a run"), "{e}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A store whose answer to a conditional write is lost after the write
    /// lands.
    struct LostAnswers(Arc<dyn ObjectStore>);

    impl ObjectStore for LostAnswers {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, iwci_store::StoreError> {
            self.0.get(key)
        }
        fn head(
            &self,
            key: &str,
        ) -> Result<Option<iwci_store::ObjectMeta>, iwci_store::StoreError> {
            self.0.head(key)
        }
        fn put(&self, key: &str, bytes: &[u8], ct: &str) -> Result<(), iwci_store::StoreError> {
            self.0.put(key, bytes, ct)
        }
        fn put_if_absent(
            &self,
            key: &str,
            bytes: &[u8],
            ct: &str,
        ) -> Result<bool, iwci_store::StoreError> {
            self.0.put_if_absent(key, bytes, ct)?;
            Err(iwci_store::StoreError::Transport {
                method: "PUT",
                key: key.into(),
                message: "connection reset".into(),
            })
        }
        fn list(&self, prefix: &str) -> Result<Vec<String>, iwci_store::StoreError> {
            self.0.list(prefix)
        }
        fn delete(&self, key: &str) -> Result<(), iwci_store::StoreError> {
            self.0.delete(key)
        }
    }

    #[test]
    fn a_marker_whose_write_lost_its_answer_is_still_this_runs() {
        let (store, dir) = store("lost");
        let lossy: Arc<dyn ObjectStore> = Arc::new(LostAnswers(store.clone()));
        let a = run_of(&lossy, "run-a", "b-main", "ci-1");
        assert_eq!(a.begin("task/x/1", None, None).unwrap(), None);
        a.end("task/x/1", Ended::Saved);
        eventually("the marker to go", || !marked(&store, "b-main", "task/x/1"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
