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
//! | `runs/<run>/<runner>.<n>` | that runner of the run is alive; `<n>` moves every [`BEAT`] for as long as it may hold a marker |
//!
//! `<run>` is the run's id, or for a runner helping a split run, the id of
//! the run it helps: the runners of a split run count as one. A marker
//! goes when its job ends; whatever a runner that died left is swept a day
//! later ([`sweep`]). None of it counts against an owner's storage quota.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use iwci_store::{ObjectStore, RepoId};

use crate::adapters::split::{BEAT, Beating, sweep_under};
use crate::schedule::{Holder, InFlight, InFlightTiming, Look, marker_id};

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

/// The markers of one run, as that run sees them and writes its own.
pub struct StoreInFlight {
    store: Arc<dyn ObjectStore>,
    /// `inflight/<owner>/<repo-id>`.
    root: String,
    write_scope: String,
    read_scopes: Vec<String>,
    run: String,
    runner: String,
    timing: InFlightTiming,
    /// Between this runner's signs of life.
    every: Duration,
    /// This runner's sign of life, from its first marker to its end.
    beat: Mutex<Option<Beating>>,
    /// Markers this runner wrote (`true`) or found its run's (`false`),
    /// by id, deleted at the end if their jobs did not.
    held: Mutex<HashMap<String, bool>>,
    /// The last look, for lookups that ask within half a poll of it.
    looked: Mutex<Option<(Instant, Look)>>,
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
            store,
            root: format!("{PREFIX}/{}/{}", owner.as_str(), repo.as_str()),
            write_scope: write_scope.to_string(),
            read_scopes: read_scopes.to_vec(),
            run: run.as_str().to_string(),
            runner: runner.to_string(),
            timing,
            every,
            beat: Mutex::new(None),
            held: Mutex::default(),
            looked: Mutex::new(None),
        }
    }

    fn marker(&self, scope: &str, id: &str) -> String {
        format!("{}/{scope}/keys/{id}", self.root)
    }

    /// Says this runner is alive, from now to its end; written before its
    /// first marker, so nobody finds that marker without it.
    fn alive(&self) {
        let mut beat = self.beat.lock().unwrap_or_else(|e| e.into_inner());
        if beat.is_none() {
            let key = format!(
                "{}/{}/runs/{}/{}",
                self.root, self.write_scope, self.run, self.runner
            );
            *beat = Some(Beating::start(self.store.clone(), key, self.every));
        }
    }

    /// The run holding marker `id` in `scope`. A marker that does not read
    /// as one, or names no run, is nobody's.
    fn read(&self, scope: &str, id: &str) -> Result<Option<Body>, String> {
        let Some(bytes) = self
            .store
            .get(&self.marker(scope, id))
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        Ok(serde_json::from_slice::<Body>(&bytes)
            .ok()
            .filter(|b| RepoId::new(b.run.as_str()).is_ok()))
    }

    fn holder(body: Body) -> Holder {
        Holder {
            run: body.run,
            expected_ms: body.expected_ms,
        }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, bool>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The markers and signs of life in every scope this run reads, one
    /// listing each.
    fn list(&self) -> Result<Look, String> {
        let mut look = Look::default();
        let mut signs: HashMap<String, Vec<String>> = HashMap::new();
        for scope in &self.read_scopes {
            let prefix = format!("{}/{scope}/", self.root);
            for key in self.store.list(&prefix).map_err(|e| e.to_string())? {
                let Some(rest) = key.strip_prefix(&prefix) else {
                    continue;
                };
                if let Some(id) = rest.strip_prefix("keys/") {
                    look.markers.insert(id.to_string());
                } else if let Some((run, beat)) =
                    rest.strip_prefix("runs/").and_then(|r| r.split_once('/'))
                {
                    signs
                        .entry(run.to_string())
                        .or_default()
                        .push(beat.to_string());
                }
            }
        }
        for (run, mut beats) in signs {
            beats.sort();
            look.alive.insert(run, beats.join(","));
        }
        Ok(look)
    }
}

impl InFlight for StoreInFlight {
    fn begin(&self, key: &str, expected_ms: Option<u64>) -> Result<Option<Holder>, String> {
        let id = marker_id(key);
        // A run of the default branch computing it, for a pull request.
        for scope in self.read_scopes.iter().filter(|s| **s != self.write_scope) {
            if let Some(body) = self.read(scope, &id)?
                && body.run != self.run
            {
                return Ok(Some(Self::holder(body)));
            }
        }
        self.alive();
        let body = serde_json::to_vec(&Body {
            run: self.run.clone(),
            runner: self.runner.clone(),
            expected_ms,
        })
        .map_err(|e| e.to_string())?;
        let own = self.marker(&self.write_scope, &id);
        // Twice, for a marker deleted between the write and the read.
        for _ in 0..2 {
            if self
                .store
                .put_if_absent(&own, &body, "application/json")
                .map_err(|e| e.to_string())?
            {
                self.held().insert(id, true);
                return Ok(None);
            }
            match self.read(&self.write_scope, &id)? {
                Some(body) if body.run != self.run => return Ok(Some(Self::holder(body))),
                // Another runner of this run's: whichever runs the job
                // deletes it.
                Some(_) => {
                    self.held().entry(id).or_insert(false);
                    return Ok(None);
                }
                None => {}
            }
        }
        Err("the key's marker keeps changing hands".into())
    }

    fn end(&self, key: &str) {
        let id = marker_id(key);
        // Kept for the end of the run when the store does not take it.
        if self
            .store
            .delete(&self.marker(&self.write_scope, &id))
            .is_ok()
        {
            self.held().remove(&id);
        }
    }

    fn leave(&self, key: &str) {
        let id = marker_id(key);
        // The runner that won the claim began before it claimed, so a
        // marker this one wrote went up after that runner's: that runner
        // has finished the job already, or holds none.
        if self.held().remove(&id) == Some(true) {
            self.end(key);
        }
    }

    fn holder(&self, key: &str) -> Result<Option<Holder>, String> {
        let id = marker_id(key);
        if !self.look()?.markers.contains(&id) {
            return Ok(None);
        }
        for scope in &self.read_scopes {
            if let Some(body) = self.read(scope, &id)?
                && body.run != self.run
            {
                return Ok(Some(Self::holder(body)));
            }
        }
        Ok(None)
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
    /// of life.
    fn drop(&mut self) {
        let held: Vec<String> = self.held().drain().map(|(id, _)| id).collect();
        for id in held {
            let _ = self.store.delete(&self.marker(&self.write_scope, &id));
        }
        self.beat.lock().unwrap_or_else(|e| e.into_inner()).take();
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

    #[test]
    fn one_run_holds_a_key_and_others_see_it_until_it_ends() {
        let (store, dir) = store("hold");
        let a = run_of(&store, "run-a", "b-main", "ci-1");
        let b = run_of(&store, "run-b", "b-main", "ci-2");
        assert_eq!(b.holder("task/x/1").unwrap(), None);
        assert_eq!(a.begin("task/x/1", Some(1500)).unwrap(), None);
        let held = Holder {
            run: "run-a".into(),
            expected_ms: Some(1500),
        };
        assert_eq!(b.begin("task/x/1", None).unwrap(), Some(held.clone()));
        // Looked at again only once the last look is old enough.
        std::thread::sleep(FAST.poll);
        assert_eq!(b.holder("task/x/1").unwrap(), Some(held));
        let look = b.look().unwrap();
        assert!(look.markers.contains(&marker_id("task/x/1")));
        assert!(look.alive.contains_key("run-a"));
        // A run never waits for itself.
        assert_eq!(a.holder("task/x/1").unwrap(), None);
        assert_eq!(a.begin("task/x/1", None).unwrap(), None);
        // Another key is free.
        assert_eq!(b.begin("task/y/1", None).unwrap(), None);
        a.end("task/x/1");
        std::thread::sleep(FAST.poll);
        assert_eq!(b.holder("task/x/1").unwrap(), None);
        assert!(!b.look().unwrap().markers.contains(&marker_id("task/x/1")));
        // A's sign of life moves while it lives, and goes with it.
        let first = b.look().unwrap().alive["run-a"].clone();
        let until = Instant::now() + Duration::from_secs(5);
        while b.look().unwrap().alive.get("run-a") == Some(&first) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_ne!(b.look().unwrap().alive.get("run-a"), Some(&first));
        drop(a);
        let until = Instant::now() + Duration::from_secs(5);
        while b.look().unwrap().alive.contains_key("run-a") && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!b.look().unwrap().alive.contains_key("run-a"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn markers_are_scoped_as_task_cache_entries_are() {
        let (store, dir) = store("scopes");
        let main = run_of(&store, "run-main", "b-main", "ci-1");
        let pr = run_of(&store, "run-pr", "pr-1", "ci-2");
        let fork = run_of(&store, "run-fork", "pr-2", "ci-2");
        // A pull request waits for the default branch, which it reads.
        assert_eq!(main.begin("task/x/1", None).unwrap(), None);
        assert_eq!(
            pr.begin("task/x/1", None).unwrap().map(|h| h.run),
            Some("run-main".into())
        );
        // The default branch never waits for a pull request, nor does a
        // pull request for another's.
        assert_eq!(pr.begin("task/y/1", None).unwrap(), None);
        assert_eq!(main.holder("task/y/1").unwrap(), None);
        assert_eq!(fork.holder("task/y/1").unwrap(), None);
        assert_eq!(fork.begin("task/y/1", None).unwrap(), None);
        assert_eq!(main.begin("task/y/1", None).unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_runners_of_a_split_run_count_as_one_and_the_end_clears_what_is_left() {
        let (store, dir) = store("split");
        let primary = run_of(&store, "run-a", "b-main", "ci-1");
        let helper = run_of(&store, "run-a", "b-main", "ci-2");
        let other = run_of(&store, "run-b", "b-main", "ci-3");
        assert_eq!(primary.begin("task/x/1", None).unwrap(), None);
        assert_eq!(helper.begin("task/x/1", None).unwrap(), None);
        // The helper lost the job's claim: the primary deletes the marker.
        helper.leave("task/x/1");
        assert!(other.begin("task/x/1", None).unwrap().is_some());
        // A runner that writes the marker after the winner finished and
        // deleted its own, and then loses the claim, deletes it again.
        assert_eq!(primary.begin("task/w/1", None).unwrap(), None);
        primary.end("task/w/1");
        assert_eq!(helper.begin("task/w/1", None).unwrap(), None);
        helper.leave("task/w/1");
        drop(helper);
        assert_eq!(other.begin("task/w/1", None).unwrap(), None);
        // A marker its job never deleted goes with the run.
        assert_eq!(primary.begin("task/z/1", None).unwrap(), None);
        drop(primary);
        assert_eq!(other.begin("task/x/1", None).unwrap(), None);
        assert_eq!(other.begin("task/z/1", None).unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_marker_that_names_no_run_is_nobodys() {
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
        assert!(b.begin("task/x/1", None).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
