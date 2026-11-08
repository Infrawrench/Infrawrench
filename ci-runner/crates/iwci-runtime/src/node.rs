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
    }
}

#[cfg(feature = "node")]
pub(crate) use imp::NodeHooks;

#[cfg(not(feature = "node"))]
#[derive(Debug, Clone)]
pub(crate) enum NodeHooks {}
