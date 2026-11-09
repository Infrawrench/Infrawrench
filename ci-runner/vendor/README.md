# Vendored crates

Third-party crates the runner needs changed before upstream releases the
change. Each one is the published crate, checked against the checksum in
`Cargo.lock`, minus test files nothing builds, plus one reviewed patch. The
patch file beside it is the whole difference, so a reviewer reads that, not
the tree. Nothing here is formatted or linted as our code (the directory is
excluded from the workspace).

## wasmer-napi 0.705.0

From crates.io, sha256
`767be5e2ae1215f64f1fb60266fc2ae8fe40994194c32278230421ab331a073f`, with
`tests/` reduced to `manifest_tests.rs` (the one target its manifest names),
and `wasmer-napi.patch` applied.

**Why.** Every bridge call that runs JavaScript holds the process-wide
`g_mu` for as long as the script runs, and
`snapi_bridge_unofficial_terminate_execution` takes it too. A job whose
`node` script loops forever therefore could not be stopped: on timeout the
runner's call to `NapiRuntimeControl::terminate_all` blocked on that lock,
and the job ran (and held its slot) indefinitely. The patch adds
`snapi_bridge_host_terminate_execution`, which calls V8's thread-safe
`TerminateExecution` without `g_mu`, and uses it from the two host callers,
which already hold the Rust env registry lock that env release takes before
freeing anything.

**Also in the patch: no memory protection keys.** On a CPU with PKU (the
runner host has it), V8 tags the
process-wide JS dispatch table with a protection key and grants access in the
PKRU register of the thread that first initialises V8, and of the threads it
creates later. PKRU is per thread, so a second CI job's `node`, running on a
thread from an older pool, faulted reading that table in `Isolate::Init`
(SIGSEGV, PK in the error code) and took the whole runner down: two
`env:bash-node` jobs started together crashed every time.
`v8/src/unofficial_napi.cc` sets `--no-memory-protection-keys` before V8
initialises, after any guest flags, so V8 protects those pages with mprotect,
which every thread sees the same. Drop it once a release grants the key to
every thread that runs an isolate; two `env:bash-node` jobs started together
on a PKU host are the check.

**And: heap sizes for budgeted isolates.** Under a memory budget, which the
runner always sets (a job's `memory:`), an isolate's old generation started
at 64 MiB and grew in 32 MiB steps through the near-heap-limit callback.
V8 runs a full mark-compact before each grant, so Prettier over the monorepo
ran about 4x slower than native Node, and a burst of allocation could outrun
the grants: V8 died with "Reached heap limit" with most of the budget unused,
aborting the whole process. `src/budget.rs` now starts at 256 MiB, grows by
half the current limit per grant (at least 128 MiB), and gives a budget with
room for it a 192 MiB young generation (64 MiB semi-spaces), all still
charged against the budget. Revisit if a release makes these settings.

**And: `g_mu` only where state is shared.** Every per-env bridge call held
the process-wide `g_mu` for its whole duration, including the calls that run
JavaScript (`contextify_run_script`, module evaluation), so Node jobs on one
runner took turns: three CPU-bound jobs took 19 s together against 7 s
alone, and a job waiting on I/O inside a call froze the others (#922's
`astro check`). An env's own state is only used by the thread that runs it,
so `src/napi_bridge_init.cc` now takes `g_mu` only around what every env
shares, the env registry and the cross-env message table (6 sites; 62 per-env
sites no longer lock). The three jobs now take 7.6 s together. wasmerio/napi
main reworked `g_mu` the same way, with per-thread env ownership.

**Remove it** when a wasmer-napi release after 0.705.0 includes wasmerio/napi
main's rework of `g_mu` (envs owned per thread, termination outside the
lock): delete `vendor/wasmer-napi*`, the `[patch.crates-io]` entry in
`../Cargo.toml`, and bump the version. `builtins/test.sh bash-node` has a job
that must time out, which is the check.

To regenerate after editing: `diff -u` each changed file against the crate
from crates.io with `a/` and `b/` labels, as the existing patch is.
