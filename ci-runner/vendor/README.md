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
shares, the env registry and the cross-env message table (62 per-env sites
no longer lock). The three jobs now take 7.6 s together. wasmerio/napi
main reworked `g_mu` the same way, with per-thread env ownership.

**And: the shared state `g_mu` used to cover, locked on its own (#947).**
Dropping `g_mu` from env creation and release left the registry itself
unlocked there: `g_envs.erase` in release (and `g_envs.insert` in the
unbudgeted create) ran while other threads looked envs up, which every
bridge call does, and the runner segfaulted in `LookupEnvState` under a
full Test pipeline (8.5 minutes into a run on the runner host; the
production crash had the same load). Insert and erase now take `g_mu`
themselves, the message table is locked only around the table, not
around serialization, which runs JavaScript, and the budgeted create no
longer holds `g_mu` while it builds an isolate. Two more pieces of the V8
provider relied on `g_mu` for safety and are backported from wasmerio/napi
832e57ec ("Let environments on different threads run JavaScript
concurrently"): the module-wrap maps in `v8/src/unofficial_napi_contextify.cc`
are always used under `g_module_wrap_mu` (an unlocked `operator[]` and
cleanup-hook `emplace` raced every env's bootstrap and module loading), and
`v8/src/unofficial_napi.cc` serializes isolate construction with V8
disposal (`g_isolate_lifecycle_mu`), because `EdgeV8Platform` keys
per-isolate state by address and a new isolate could take a just-freed
one's address between `Dispose()` and unregistration.

**And: env ids per application, so `worker_threads` work.** A WASIX
program runs one Wasmer store per thread over one shared linear memory, and
the bridge allocated N-API env ids per store. A Worker's isolate is created
on the worker's thread, so its env got the same id as its parent's, and
Edge.js, which keys its per-env state by that id in the shared memory,
overwrote the parent's state with the worker's: the worker's bootstrap threw
(`MessagePort` without its listener map) and the parent then failed to load
builtins (`primordials` undefined), so a `new Worker(...)` printed "Failed to
execute builtin 'internal/main/worker_thread':" and hung until the job's
timeout. `src/env.rs` allocates native ids from the application's shared
`EnvRegistry` instead, never reusing one, with each env's owner scope taking
its env's id, and `src/guest/napi.rs` resolves
`unofficial_napi_terminate_execution` through that registry, so a parent's
`Worker.terminate()` stops a busy worker on another thread (through the
lock-free terminate above, under the registry lock that keeps the target
alive). This is wasmerio/napi 9219367 ("Allocate env ids per application and
let stores stop each other's envs") without its `request_interrupt` change,
which needs the later callback rework; Edge.js 0.2.5 queues worker tasks
through its own environment, not that import.

With workers working, the heap reservations above made a pool of them
impossible: every isolate reserved 472 MiB up front, so a 2 GiB job started
four workers and refused the fifth. `src/budget.rs` now plans an isolate
created while others are live (a worker, or a second `node` of the job)
against a quarter of the remaining budget and from a 64 MiB old generation,
the published default, growing through the same grants; the first isolate
keeps the larger defaults. A clamped default reservation under 16 MiB is
refused, so the guest reports "cannot create" instead of getting an isolate
its first allocation terminates.

**And: a guest heap keeps its memory mapped (#955).** The bridge allocates
every `ArrayBuffer` backing store inside the guest's linear memory, through
one `GuestHeap` per memory, found in a process-wide registry keyed by the
memory's host address so that a `node`'s worker threads share one. The heap
did not keep the memory alive, and it outlives it: when a `node` ends, its
memory is unmapped while its env, which owns the heap, is dropped a moment
later, and a V8 thread freeing a backing store holds the heap a while
longer. Every `node` of every job is in the one runner process, and the
kernel hands the next 4 GiB reservation the address just freed, so a `node`
starting in that moment found the dead one's heap under its own memory's
address and used it. That heap believes it owns the pages the dead `node`
had grown into, which in the new one are where its own `malloc` puts its
first allocations: the next zero-filled `ArrayBuffer` wiped the main
thread's thread structure and whatever lay beside it. The `node` died as it
started, most often with `EACCES` from a `read` and then
`Program recieved fatal signal: Bad system call` from a thread that reads
its own id as 0 (a signal nobody sent). It took two `node`s ending and
starting at once in the runner, so suites that fork a `node` per test file
met it first: about one fork in 3,000 on both architectures, and half of
all two-copy runs of a 115-file Vitest suite on the ARM64 runner.
`src/guest_heap.rs` now has the heap hold the shared memory's own handle
(`SharedMemory`), so the mapping, and with it the address, lasts exactly as
long as the heap. Reported upstream as wasmerio/napi#144; drop this hunk
once a release includes a fix for it.

**And: the platform waits for an isolate's own work (#943).** The bridge
binds no foreground task target for a WASIX guest (Edge.js's enqueue hook
is guest code, which V8's threads cannot run), so a task V8 posts for an
isolate from another thread, such as the end of an async
`WebAssembly.compile`, waits in the platform's queue for the guest's next
event-loop checkpoint, and nothing here can wake the guest's libuv. Node
both wakes its loop for such a task (`uv_async_send`) and, before it treats
the loop as empty, waits for background tasks (`DrainTasks`). Edge.js did
neither through the bridge: under load about one `node` in five whose only
work was a compile exited silently with it unfinished, and one held open by
a long timer picked the result up when the timer fired.
`v8/src/edge_v8_platform.cc` now counts each worker task against the
isolate it is for (the isolate current on the posting thread, or the owner
of the worker task that posted it, so a compile's next step counts too),
from when it is posted until it is destroyed, and marks an isolate when an
immediate foreground task is posted for it. While either is outstanding,
the host-task checkpoint (`v8/src/unofficial_napi.cc`) waits for it on a
condition variable, woken as soon as the task is posted or the work ends,
and reports the work pending and the turn admitted, so Edge.js neither
sleeps in libuv past the task nor exits. The wait is bounded, so the loop's
own timers and I/O are looked at again: up to 1 ms when the loop has
nothing runnable, none on a turn that has something runnable, backing off
from 25 µs only over a run of such turns in which no task came (a loop with
nothing left in it reports itself runnable every turn). The checkpoint also
runs microtasks again after a pumped task, a few rounds at most: a task can
settle a promise, and its reactions used to wait for the next checkpoint,
which could be behind libuv's wait. This replaces
`crates/iwci-runtime/node/wasm-keep-alive.cjs`, a preload that held a 5 ms
interval while a compile was pending. wasmerio/napi main has a process-wide
waker instead (#139 there, "Wake the host when V8 queues a task only a
checkpoint runs"), for hosts that can end the guest's sleep themselves; it
neither keeps a loop alive nor knows the isolate. `builtins/test.sh`'s
`wasm-compile-passes` is the check.

**And: Linux ARM64.** The crate knows no prebuilt V8 for Linux ARM64, and
does not build there. `build.rs` maps it to `v8-linux-arm64.tar.xz` from the
`wasmerio/v8-custom-builds` release 11.9.9 (11.9.7 has none; both carry V8
13.6.233, and 11.9.8's notes name the ARM64 builds and shared-library-safe
TLS as the change), while every other target keeps 11.9.7. Two more
things only ARM64 needs: C strings are `std::ffi::c_char`, which is `u8`
there, where the crate wrote `i8` (46 uses and two scratch buffers; the
same type on x86_64), and V8's ARM64 build calls libatomic for its 16-byte
atomics, so Linux ARM64 links `atomic`. Built and run on a Graviton5 host
(`ci-2`), where #922's full Test pipeline (689 jobs) passed cold.

**And: no WebAssembly code GC.** V8 13.6 keeps compiled wasm-to-JS
wrappers in one cache for the whole process, and a lookup there
(`WasmImportWrapperCache::MaybeGet`, `FindWrapper`, the re-check before a
compile) adds the wrapper to the caller's `WasmCodeRefScope` before it
checks that the wrapper is dying. Once a wasm code GC cycle has freed that
wrapper on another isolate's thread, the scope frees it a second time on
its way out, and the runner segfaults in `WasmEngine::FreeDeadCode` with
every job in it (#970: `~WasmCodeRefScope` under
`Runtime_TierUpWasmToJSWrapper`). It needs two isolates on two threads,
which is any two jobs that run WebAssembly in Node (rolldown under tsdown
or Vitest). V8 fixed the lookup in 9b8ca54d5, "Fix lookup of wrappers
marked is_dying" (13.7, crbug 409379692); the bridge links a prebuilt
13.6.233, so `v8/src/unofficial_napi.cc` sets `--no-wasm-code-gc` before
V8 initialises, after any guest flags: the cycle that frees a dying
wrapper never runs, so nothing frees one twice.

It is a stopgap, and its cost is memory. Code a module no longer uses
(Liftoff code replaced by TurboFan's) stays until the module is freed,
which is when the last job using it ends. A wrapper nobody references any
more stays for the life of the runner, and the next job to need one
compiles it again. Measured with the cycle on over 640 jobs that bundle
with rolldown's wasm build: 11 cycles freed 3,913 module code objects, which
the flag leaves to their modules, and 58 wrappers, about one for every 11
jobs, which it leaves for good; a wrapper is a few hundred bytes of code.

Drop the flag when the linked V8 is 13.7 or later. The prebuilt releases
after 11.9.9 are V8 15.9 (`wasmerio/v8-custom-builds` 15.9.111.0 and
15.9.111.1, linux amd64 and arm64), but wasmerio/napi's main still pins
11.9.9: when a wasmer-napi release targets 15.9, rebase this patch onto it
without this hunk.

**And: whose a worker task is.** V8's garbage collection and background
compilation run on one process-wide worker pool, so their CPU time belongs
to no job, and the runner's stall check (#938, `iwci-runtime/src/stall.rs`)
counts a job's CPU time to tell a hung job from a quiet one: a job waiting
on a long background compile would look hung. `set_worker_task_hooks`
(`src/lib.rs`, through `snapi_bridge_set_worker_task_hooks` to
`EdgeV8Platform::SetWorkerTaskHooks`) takes four callbacks: `capture` on the
thread that posts a worker task, immediate or delayed, returning a token for
whoever that thread works for, `enter` and `exit` on the pool thread around
the task, and `release` when the task is destroyed. The runner counts the
pool thread's CPU time for the posting job between `enter` and `exit`.
Nothing upstream does this; a tree without it still builds if
`stall::node_hooks` goes, and the stall check then misses that work.

**Remove it** when a wasmer-napi release after 0.705.0 includes wasmerio/napi
main's rework of `g_mu` (envs owned per thread, termination outside the
lock, 832e57ec's provider locks) and its per-application env ids (9219367),
and either a guest's event loop is kept alive and woken for its isolate's
background work or the pinned Edge.js does that itself, and the stall check
has another way to count V8's worker threads or goes without: delete
`vendor/wasmer-napi*`, the `[patch.crates-io]` entry in `../Cargo.toml`, and
bump the version. `builtins/test.sh bash-node` has a job that must time out,
one that runs Workers, one that churns envs and one that compiles WebAssembly
in the background, which are the checks; check the heap sizes against a
Worker pool too.

To regenerate after editing: `diff -u` each changed file against the crate
from crates.io with `a/` and `b/` labels, as the existing patch is.

## wasmer-wasix 0.705.0

From crates.io, sha256
`1d5bbce1be073ab1e40f5ed2468653832c22aecfd73e2ba763c41a5d831a4475`, whole
(its tests are small and its manifest names them), with
`wasmer-wasix.patch` applied. `[patch.crates-io]` swaps it in for every
crate that depends on wasmer-wasix, the vendored bridge included.

**A script runs its `#!` interpreter (#958).** On Linux the kernel reads a
spawned file's `#!` line and runs the interpreter with the script's path;
WASIX has no kernel, and `BinFactory::spawn` handed the text to the Wasm
compiler, so `posix_spawn` of a script failed with `ENOEXEC`. bash hid it
by running a failed exec as a shell script itself, which also ran a
`#!/usr/bin/env node` script as bash; Node had no fallback, which is what
kept `plugingen`'s fake `gh` tests on GitHub Actions. `src/bin_factory/mod.rs`
now classifies a file that starts with `#!` as a script and spawns its
interpreter with `[interpreter, optional argument, script, arguments...]`,
up to five scripts deep (`ELOOP` after), as `execve` does; the interpreter
is looked up in the job's own file system like any other executable, so
nothing outside the job is reachable through one. `proc_spawn3` and
`proc_exec4` pass the path the caller spelled (`./s`), which is what the
interpreter is given, and report a missing interpreter as `ENOENT` and an
unusable line as `ENOEXEC`. A path that once failed to load is no longer
remembered as missing, since a job can create it afterwards. This is
wasmerio/wasmer#6958 (merged after 0.705.0, the newest release), cut down to
the shebang support: it keeps 0.705's path-based executable lookup rather
than that PR's lookup through the inode tree, and leaves out the PR's
unrelated changes (terminal scoping, `dup2` rights, `writev` ordering,
renames of hard-linked files, command environment defaults, which the
runtime crate already handles in `command_env_as_defaults`).

**`waitpid(-1, ..., WNOHANG)` does not block (#961).** `proc_join` with no
pid waited for any child to exit whatever the flags said, so it blocked
where the C library asked it not to. bash reaps finished background jobs
between commands with exactly that call, so after `cmd &` it ran one more
command and then sat in the host until the child exited: a script that
starts a server and polls it, or loops beside a background process, made
no progress (and the stall check rightly called it stalled).
`WasiProcess::try_join_any_child` joins a child that has already exited,
and `proc_join` answers "nothing yet" otherwise. The C library reads a
missing pid as `ECHILD`, so that answer names pid 0, which `waitpid` then
returns as 0, as Linux does. Upstream main still blocks there (checked
November 2026, not yet reported); drop the hunk with the release that has
a fix.

**Remove it** when a wasmer-wasix release after 0.705.0 has #6958 and a
non-blocking wait for any child: delete `vendor/wasmer-wasix*`, its
`[patch.crates-io]` entry in `../Cargo.toml`, and check
`builtins/test.sh`'s `background-passes` and `shebang-passes` (bash and
bash-node) and `shebang-missing-interpreter-fails`.

To regenerate after editing: `diff -u` each changed file against the crate
from crates.io with `a/` and `b/` labels.
