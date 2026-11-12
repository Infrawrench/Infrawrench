//! N-API for Edge.js.
//!
//! Edge.js's engine-free WASIX build (`node`, `npm`, `pnpm`) runs JavaScript
//! on a V8 that the host provides through the `napi` and
//! `napi_extension_wasmer_v0` imports. `wasmer-napi` implements those over a
//! native V8 and plugs into wasmer-wasix as an instantiation hook, which runs
//! for every instance a job creates (the shell, and each `node` it spawns).
//! One context per job, so a timeout stops exactly that job's isolates.
//!
//! Without the `node` feature this type is uninhabited, and a module that
//! imports N-API fails to instantiate with a missing-import error.

#[cfg(feature = "node")]
mod imp {
    use wasmer_napi::NapiCtx;
    use wasmer_wasix::PluggableRuntime;

    #[derive(Debug, Clone)]
    pub(crate) struct NodeHooks {
        ctx: NapiCtx,
    }

    impl NodeHooks {
        /// A context whose V8 heaps together stay under `memory_bytes`.
        pub(crate) fn new(memory_bytes: u64) -> Self {
            // V8's worker threads are counted for the job whose task they
            // run (stall.rs).
            crate::stall::node_hooks::install();
            Self {
                ctx: NapiCtx::builder()
                    .max_total_heap_bytes(memory_bytes)
                    .build(),
            }
        }

        pub(crate) fn attach(&self, runtime: &mut PluggableRuntime) {
            runtime.with_instantiation_hook(self.ctx.runtime_hooks());
        }

        /// Stops every isolate of the job; sticky, so isolates created
        /// afterwards start stopped.
        pub(crate) fn terminate(&self) {
            self.ctx.runtime_control().terminate_all();
        }

        /// What the job's V8 heaps were refused or stopped for, against
        /// its `memory:` (#964, #972).
        pub(crate) fn exhaustion(&self) -> super::Exhaustion {
            let e = self.ctx.budget().exhaustion();
            super::Exhaustion {
                heaps_stopped: e.heaps_stopped,
                heaps_lost: e.heaps_lost,
                isolates_refused: e.isolates_refused,
                buffers_refused: e.buffers_refused,
                heap_space_full: e.heap_space_full,
            }
        }
    }
}

#[cfg(feature = "node")]
pub(crate) use imp::NodeHooks;

#[cfg(not(feature = "node"))]
#[derive(Debug, Clone)]
pub(crate) enum NodeHooks {}

#[cfg(not(feature = "node"))]
impl NodeHooks {
    pub(crate) fn exhaustion(&self) -> Exhaustion {
        match *self {}
    }
}

/// How a job's Node ran short of its `memory:`, which its own output does
/// not say: V8 heaps, the isolates of `node`s and worker threads, and the
/// `ArrayBuffer` memory they share are all held to it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Exhaustion {
    /// Heaps that could not grow: the isolate and every later one were
    /// stopped, so the job's JavaScript is over.
    pub(crate) heaps_stopped: u64,
    /// Heaps V8 ran out of anyway where it treats that as fatal. The bridge
    /// kept it from ending the runner by parking the thread that ran out
    /// (vendor/README.md), which never returns, so the job cannot finish.
    pub(crate) heaps_lost: u64,
    /// `node`s or worker threads that could not start: no room for a heap.
    pub(crate) isolates_refused: u64,
    /// `ArrayBuffer` and `Buffer` allocations refused.
    pub(crate) buffers_refused: u64,
    /// Of the heaps stopped and `node`s refused, those the job's own
    /// `memory:` had room for but the V8 heap space every job shares
    /// (`v8_heap_space`) did not, for as long as they waited (#1063).
    pub(crate) heap_space_full: u64,
}

impl Exhaustion {
    /// The job's JavaScript was stopped for memory, so the runner stops the
    /// job: nothing it runs from now on gets anywhere, and a lost heap's
    /// thread never returns.
    pub(crate) fn stops_the_job(&self) -> bool {
        self.heaps_stopped != 0 || self.heaps_lost != 0
    }

    pub(crate) fn any(&self) -> bool {
        self.stops_the_job()
            || self.isolates_refused != 0
            || self.buffers_refused != 0
            || self.heap_space_full != 0
    }

    /// The note for the end of the job's stderr, or `None` when memory never
    /// ran short.
    pub(crate) fn note(&self, memory_bytes: u64) -> Option<String> {
        if !self.any() {
            return None;
        }
        let mut what = Vec::new();
        let n = |count: u64, one: &str, many: &str| {
            if count == 1 {
                one.to_string()
            } else {
                format!("{count} {many}")
            }
        };
        if self.heaps_stopped != 0 {
            what.push(format!(
                "{} could not grow, so the runner stopped the job's JavaScript",
                n(self.heaps_stopped, "a JavaScript heap", "JavaScript heaps")
            ));
        }
        if self.heaps_lost != 0 {
            what.push(format!(
                "V8 ran out of heap in {} where it cannot recover; the runner kept that to this job and stopped it",
                n(self.heaps_lost, "an isolate", "isolates")
            ));
        }
        if self.isolates_refused != 0 {
            what.push(format!(
                "{} could not start, with no room left for another JavaScript heap (`Failed to create worker env`, `Failed to initialize runtime environment`)",
                n(
                    self.isolates_refused,
                    "a `node` or worker thread",
                    "`node`s or worker threads"
                )
            ));
        }
        if self.buffers_refused != 0 {
            what.push(format!(
                "{} refused",
                n(
                    self.buffers_refused,
                    "an `ArrayBuffer` or `Buffer` allocation was",
                    "`ArrayBuffer` or `Buffer` allocations were"
                )
            ));
        }
        if self.heap_space_full != 0 {
            what.push(format!(
                "{} within the job's `memory:`, but not within the {} MiB of V8 heap that every job on this runner shares, which stayed full while it waited; the job may pass when it runs again",
                n(self.heap_space_full, "one of them was", "of them were"),
                crate::v8_heap_space().total >> 20,
            ));
        }
        Some(format!(
            "iwci: the job ran out of its {} MiB of memory (`memory:`):\n{}\n  Give it more `memory:`, or have it start fewer `node`s and worker threads at once.\n",
            memory_bytes >> 20,
            what.iter()
                .map(|w| format!("  - {w}"))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::Exhaustion;

    #[test]
    fn a_heap_the_shared_v8_heap_could_not_hold_is_told_apart() {
        let e = Exhaustion {
            heaps_stopped: 1,
            heap_space_full: 1,
            ..Exhaustion::default()
        };
        assert!(e.stops_the_job());
        let note = e.note(6 << 30).unwrap();
        assert!(note.contains("ran out of its 6144 MiB of memory"), "{note}");
        assert!(
            note.contains("one of them was within the job's `memory:`, but not within the"),
            "{note}"
        );
        let e = Exhaustion {
            isolates_refused: 3,
            heap_space_full: 3,
            ..Exhaustion::default()
        };
        assert!(!e.stops_the_job() && e.any());
        assert!(e.note(1 << 30).unwrap().contains("3 of them were within"));
    }
}
