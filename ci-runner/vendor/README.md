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

**Still true with the patch.** `g_mu` is shared by every job in the process,
so a long-running script in one job still serialises the lock-taking bridge
calls (module evaluation, contextify) of other jobs' `node` processes until
it finishes or is stopped.

**Remove it** when a wasmer-napi release after 0.705.0 includes wasmerio/napi
main's rework of `g_mu` (envs owned per thread, termination outside the
lock): delete `vendor/wasmer-napi*`, the `[patch.crates-io]` entry in
`../Cargo.toml`, and bump the version. `builtins/test.sh bash-node` has a job
that must time out, which is the check.

To regenerate after editing: `diff -u` each changed file against the crate
from crates.io with `a/` and `b/` labels, as the existing patch is.
