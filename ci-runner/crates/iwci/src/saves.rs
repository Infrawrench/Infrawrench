//! A job's cache saves, made after it rather than as part of it.
//!
//! A save compresses the cache and uploads it, which for a package store
//! is seconds, and it used to come between a job's script and its end:
//! the jobs that need it, and the run if it was the last, waited for an
//! upload whose result none of them reads. Now a job's saves are queued
//! ([`Saves::deferred`]), the job is reported done, and the scheduler
//! makes them on a thread of the run's own, so:
//!
//! - the run is not finished until every save has landed or failed, and a
//!   failure is the job's `caches` line it always was;
//! - the job's memory reservation shrinks to what its saves hold
//!   ([`Saves::held_bytes`]) and is given back when they end;
//! - a save keeps its key claimed until it ends, and a restore of that key
//!   (or of a `restore-keys` prefix it falls under) on this runner waits
//!   for it (`adapters::caches`), so the next job or run reads what was
//!   saved rather than missing it;
//! - a drain, which waits for its runs, waits for their saves.
//!
//! A helper in a split run saves as it did, before its job ends
//! ([`Saves::now`]): what it holds is given back the moment one of its own
//! runner's runs wants it, which a save in flight could not be.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use iwci_vfs::Entry;

use crate::schedule::Caches;

/// What a save makes of its report line: how long it took, or why it
/// failed.
type Line = Box<dyn FnOnce(Result<Duration, String>) -> String + Send>;

/// One save: a job cache's or an environment cache's.
pub struct Save {
    pub key: String,
    pub restore_keys: Vec<String>,
    pub entries: Vec<Entry>,
    pub modes: Vec<(PathBuf, u32)>,
    /// The job's `caches` line while the save is still to be made.
    pub pending: String,
    /// The line once it is.
    pub line: Line,
}

impl Save {
    /// Bytes of file contents it saves.
    pub fn file_bytes(&self) -> u64 {
        self.entries
            .iter()
            .map(|e| match e {
                Entry::File { data, .. } => data.len() as u64,
                _ => 0,
            })
            .sum()
    }

    /// Makes the save, returning its report line.
    pub fn run(self, store: &dyn Caches) -> String {
        let started = Instant::now();
        let saved =
            store.save_with_modes(&self.key, &self.restore_keys, &self.entries, &self.modes);
        (self.line)(saved.map(|()| started.elapsed()))
    }
}

/// A job's saves: made at once, or queued for after it.
pub struct Saves {
    deferred: bool,
    queued: Vec<Save>,
}

impl Saves {
    /// Saves made as the job asks for them, before it ends.
    pub fn now() -> Self {
        Self {
            deferred: false,
            queued: Vec::new(),
        }
    }

    /// Saves queued for the scheduler to make once the job is reported.
    pub fn deferred() -> Self {
        Self {
            deferred: true,
            queued: Vec::new(),
        }
    }

    pub fn is_deferred(&self) -> bool {
        self.deferred
    }

    /// Makes `save` now, or queues it, with its line in `lines` either way:
    /// the final one, or the pending one that [`Saves::take`]'s caller
    /// replaces when the save is made.
    pub fn save(&mut self, store: &dyn Caches, save: Save, lines: &mut Vec<String>) {
        if self.deferred {
            lines.push(save.pending.clone());
            self.queued.push(save);
        } else {
            lines.push(save.run(store));
        }
    }

    /// The queued saves, to make after the job.
    pub fn take(&mut self) -> Vec<Save> {
        std::mem::take(&mut self.queued)
    }
}

/// What `saves` hold in memory until they end: the files, and the
/// compressed copy made of them before upload, which for what is cached
/// (package stores, build output, toolchains) is well under half as much.
pub fn held_bytes(saves: &[Save]) -> u64 {
    let files: u64 = saves.iter().map(Save::file_bytes).sum();
    files.saturating_add(files / 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Store(Mutex<Vec<String>>);

    impl Caches for Store {
        fn restore(
            &self,
            _key: &str,
            _restore_keys: &[String],
            _max_bytes: u64,
        ) -> Result<Option<crate::schedule::Restored>, String> {
            Ok(None)
        }
        fn save_with_modes(
            &self,
            key: &str,
            _restore_keys: &[String],
            _entries: &[Entry],
            _modes: &[(PathBuf, u32)],
        ) -> Result<(), String> {
            if key == "broken" {
                return Err("the store said no".into());
            }
            self.0.lock().unwrap().push(key.into());
            Ok(())
        }
    }

    fn save(key: &str) -> Save {
        let shown = key.to_string();
        Save {
            key: key.into(),
            restore_keys: Vec::new(),
            entries: vec![Entry::File {
                path: "/root/.store/a".into(),
                data: vec![0u8; 1000].into(),
            }],
            modes: Vec::new(),
            pending: format!("cache `{key}`: saving after the job"),
            line: Box::new(move |saved| match saved {
                Ok(_) => format!("cache `{shown}`: saved"),
                Err(e) => format!("cache `{shown}`: could not save ({e})"),
            }),
        }
    }

    #[test]
    fn saves_made_now_leave_their_final_line() {
        let store = Store::default();
        let mut saves = Saves::now();
        let mut lines = Vec::new();
        saves.save(&store, save("a"), &mut lines);
        saves.save(&store, save("broken"), &mut lines);
        assert_eq!(
            lines,
            [
                "cache `a`: saved",
                "cache `broken`: could not save (the store said no)"
            ]
        );
        assert!(saves.take().is_empty());
        assert_eq!(*store.0.lock().unwrap(), ["a"]);
    }

    #[test]
    fn deferred_saves_wait_with_a_pending_line_and_count_what_they_hold() {
        let store = Store::default();
        let mut saves = Saves::deferred();
        let mut lines = Vec::new();
        saves.save(&store, save("a"), &mut lines);
        assert_eq!(lines, ["cache `a`: saving after the job"]);
        assert!(store.0.lock().unwrap().is_empty(), "nothing saved yet");
        let queued = saves.take();
        assert_eq!(held_bytes(&queued), 1500);
        let made: Vec<String> = queued.into_iter().map(|s| s.run(&store)).collect();
        assert_eq!(made, ["cache `a`: saved"]);
        assert_eq!(*store.0.lock().unwrap(), ["a"]);
    }
}
