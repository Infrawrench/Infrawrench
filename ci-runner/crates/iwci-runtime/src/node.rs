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
            // V8 is the runner's, configured before any of the job's
            // instances can ask for it; a failure here already stopped
            // start-up (`configure_node_runtime`).
            let _ = crate::configure_node_runtime();
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
                heaps_at_limit: e.heaps_at_limit,
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

/// The most one V8 heap is grown to, in MiB, for the note below.
#[cfg(feature = "node")]
const MAX_HEAP_MIB: u64 = wasmer_napi::budget::MAX_ISOLATE_HEAP >> 20;
#[cfg(not(feature = "node"))]
const MAX_HEAP_MIB: u64 = 3584;

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
    /// Of the heaps stopped, those the job's `memory:` had room to grow
    /// but that had reached the most one V8 heap holds, 3.5 GiB of its
    /// 4 GiB pointer-compression cage (#1158). More `memory:` does not
    /// change that; nothing else is shared or capped between heaps.
    pub(crate) heaps_at_limit: u64,
}

impl Exhaustion {
    /// The job's JavaScript was stopped for memory, so the runner stops the
    /// job: nothing it runs from now on gets anywhere, and a lost heap's
    /// thread never returns.
    pub(crate) fn stops_the_job(&self) -> bool {
        self.heaps_stopped != 0 || self.heaps_lost != 0
    }

    pub(crate) fn any(&self) -> bool {
        self.stops_the_job() || self.isolates_refused != 0 || self.buffers_refused != 0
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
        if self.heaps_at_limit != 0 {
            what.push(format!(
                "{} within the job's `memory:`, but had reached the most one JavaScript heap can hold on this runner, {} MiB, which more `memory:` does not raise; split the work across `node`s or worker threads",
                n(self.heaps_at_limit, "that heap was", "of those heaps were"),
                MAX_HEAP_MIB,
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
    fn a_job_out_of_memory_is_told_what_ran_out_of_its_own_memory() {
        // Every refusal is the job's `memory:`: nothing is shared between
        // jobs' heaps to run out of instead (#1158).
        assert_eq!(Exhaustion::default().note(6 << 30), None);
        let e = Exhaustion {
            heaps_stopped: 1,
            ..Exhaustion::default()
        };
        assert!(e.stops_the_job());
        let note = e.note(6 << 30).unwrap();
        assert!(note.contains("ran out of its 6144 MiB of memory"), "{note}");
        assert!(note.contains("a JavaScript heap could not grow"), "{note}");
        let e = Exhaustion {
            isolates_refused: 3,
            ..Exhaustion::default()
        };
        assert!(!e.stops_the_job() && e.any());
        let note = e.note(1 << 30).unwrap();
        assert!(
            note.contains("3 `node`s or worker threads could not start"),
            "{note}"
        );
        assert!(!note.contains("can hold on this runner"), "{note}");
        // One heap at the most V8 gives a heap is told apart: more
        // `memory:` would not have helped it.
        let e = Exhaustion {
            heaps_stopped: 1,
            heaps_at_limit: 1,
            ..Exhaustion::default()
        };
        let note = e.note(8 << 30).unwrap();
        assert!(
            note.contains("that heap was within the job's `memory:`, but had reached the most one JavaScript heap can hold on this runner, 3584 MiB"),
            "{note}"
        );
    }
}
