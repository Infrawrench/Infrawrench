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

That 64 MiB start was meant for workers, but it also caught every `node` a
job's `node` spawns, such as Vitest's forks, one per test file, and those
never grew out of it. V8 starts a full mark-compact when the old generation
reaches halfway from its live size to the limit, and asks the
near-heap-limit callback for more only past 80% of the limit: a jsdom test
file's 40 MB of live heap sat between the two, so the fork ran a full
mark-compact every few megabytes it allocated, with a young generation of a
few MiB promoting nearly everything into it (V8 sizes the young generation
from the old one when the guest names none). That was half of the CPU time
of a jsdom Vitest run: 2,075 mark-compacts over 24 of `ui`'s test files.
`src/env.rs` now tells a process's main isolate from a worker's (the first
env on a guest process's linear memory is the only session holding its
guest heap), and `src/budget.rs` gives the former the first isolate's
256 MiB old generation, still against a quarter of what is left, and a
64 MiB young generation where the 192 MiB default does not fit: 61
mark-compacts over the same files. Workers keep the small start.

**And: an env lookup takes no lock (#994).** Every bridge call checks the
env pointer it is given against the env registry (`LookupEnvState`) before
it touches it, and that check took `g_mu`, about a hundred times per Node
`fs.statSync` (two per host call for the callback context, one or more for
the call itself). Every Node job on the runner took that one lock in turn
on every host call, a fifth of a `statSync` loop's cycles even with one job
running. `src/napi_bridge_init.cc` now bumps an epoch (`g_envs_epoch`)
under `g_mu` before every erase from the registry, and each thread
remembers the last env it found there and the epoch it found it in: while
the epoch has not moved, nothing has left the registry since, so the
answer is the one the lock would give, and the lookup is an atomic load.
Any erase sends every thread back to the locked lookup once, and an env
freed and replaced at the same address is looked up afresh. The cache is
two plain `thread_local`s of trivial types, so nothing is registered to run
at thread exit (#968's crash was such a registration). wasmerio/napi main
validates env handles per owning thread instead; drop this hunk with the
`g_mu` rework above. Two smaller costs of the same path went with it:
`snapi_bridge_swap_active_callback_ctx`, which every import that can run
JavaScript calls on the way in and out, swaps with a load and a store
instead of a locked exchange, whose full barrier was a tenth of the loop's
cycles once the lookup stopped locking (only the env's own thread installs
a context: it points into that thread's stack, and the save and restore
around each call already assume no other thread swaps in between; upstream
still exchanges), and `src/env.rs` hashes the guest's env ids, which every
import resolves, with a multiplication instead of SipHash.

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

**And: V8 running out of memory is the job's, not the runner's (#972).**
V8 ends the process when an isolate runs out of heap where it cannot
recover, and the process is the runner: one job's `node` took every job
with it, with no report. It happened two ways. A stopped isolate (its heap
refused growth by the job's budget) got 16 MiB of slack to unwind in, and an
allocation bigger than that, such as the next string of a string that
doubles, met V8's own limit ("Reached heap limit"). And V8 only asks the
near-heap-limit callback on the isolate's own thread: an allocation on a
background compile thread that finds the heap within a page of its limit
fails after its garbage collections without the callback ever being asked
(`HeapAllocator::AllocateRawWithRetryOrFailSlowPath` in V8 13.6, with
`Heap::CollectGarbageFromAnyThread`; a Maglev compile on ci-1, the
"CALL_AND_RETRY_LAST" in #972). There is no public way to raise a heap limit
outside that callback (`RemoveNearHeapLimitCallback` only lowers it), so the
gap cannot be closed from here. Three changes:

- `src/budget.rs`: after the slack, each further callback on a stopped
  isolate raises V8's limit by 32 MiB, uncharged, up to 128 MiB
  (`STOP_OVERDRAFT_STEP`, `MAX_STOP_OVERDRAFT`), so a stopped isolate rarely
  meets V8's limit while it unwinds. It terminates with the lock-free
  `snapi_bridge_host_terminate_execution`, since it runs inside a garbage
  collection in whatever bridge call the thread was in.
- `v8/src/unofficial_napi.cc`: every isolate gets an OOM handler from its
  creation (it had none: the bridge attaches no embedder hooks), and V8 the
  process-wide one (`V8::SetFatalMemoryErrorCallback`, for what it reports
  without an isolate). V8 calls them before it aborts and aborts only if
  they return. For an isolate the host budgets, the handler finds the
  isolate (current on the job's thread; on a V8 worker thread, the owner
  of the task it runs, from the platform's #943 bookkeeping), tells the
  host (`napi_host_isolate_out_of_memory`), terminates the isolate and
  parks the thread for good instead of returning. The isolate is
  abandoned: its event loop stops waiting for the parked thread's task
  (`EdgeV8Platform::AbandonIsolate`), and when its program releases its env
  it is neither torn down nor disposed (a parked thread holds a running
  local heap, so a garbage collection would wait for it forever, and
  Dispose would join it forever while holding the lock every isolate
  creation takes). Each one costs the parked thread (a V8 worker, or the
  job's own) and the isolate's memory for the life of the process; a
  stopped isolate's overdraft is what makes it rare. It does not park
  where that would stop every job instead: while the thread holds
  `g_isolate_lifecycle_mu` (an isolate being created or disposed) or once
  the isolate is being disposed; V8 aborts there as before. Isolates the
  host does not budget are left to V8.
- `v8/src/js_native_api_v8.cc` and `v8/src/unofficial_napi_contextify.cc`:
  `napi_create_arraybuffer`, `napi_create_buffer` and the contextify buffer
  allocate with `ArrayBuffer::MaybeNew` and
  `BackingStoreOnFailureMode::kReturnNull` and fail the call, where
  `ArrayBuffer::New` and the default `NewBackingStore` call V8's fatal
  out-of-memory when the guest's heap, which the job's budget can refuse,
  has no room.

The budget also counts what it refused or stopped (`MemoryExhaustion`:
heaps stopped, heaps lost, isolates refused, guest-heap growth refused), so
the runner can end a job whose JavaScript is over and say it ran out of
memory (#964). Nothing upstream does any of this. `builtins/test.sh
bash-node`'s `heap-*-fails` run beside the other jobs and must fail as out
of memory with the runner still there.

**And: what that costs, counted (#990).** A parked thread and an abandoned
isolate are lost until the process ends, and a parked V8 worker thread
leaves the pool every job shares one thread short.
`v8/src/unofficial_napi.cc` counts the threads it parks, and which of them
had no isolate current (V8's own workers), beside `g_lost_isolates`, and
`out_of_memory_losses` (`src/lib.rs`, through
`snapi_bridge_out_of_memory_losses`) reads them, so `iwci serve` can report
them and restart before the losses add up (`../README.md`, "Deploying,
draining and updating").

**And: an isolate stopped at its limit is disposed with room to spare,
and the handler never gives up on a lock (#1021).** The runner still
aborted now and then under load ("Reached heap limit" or "Ineffective
mark-compacts near heap limit", then "API fatal error handler returned
after process out of memory"). Disposing an isolate ends an incremental
marking with a full collection (`CppHeap::StartDetachingIsolate`, from
`Isolate::Deinit`), and an isolate the budget stopped at its limit, the
usual state of one being torn down after it ran out, met V8's limit
there: by then the env's near-heap-limit callback found nothing to grant,
and the isolate was being disposed, where it cannot be confined, so V8
aborted the process. `v8/src/unofficial_napi.cc` now swaps the budget's
callback for one that grants up to 128 MiB more, uncharged, in 32 MiB
steps, when the env is released: no JavaScript runs after that, so the
heap only has to finish collecting. The budget's callback also no longer
outlives its data (its data was the env, freed before the disposal), and
`src/env.rs` frees an env's heap tracker after the bridge releases the env
when a store is dropped, as the guest's own release already did, so
neither that callback nor the out-of-memory handler reads it freed.

Two smaller changes on the same path. The isolate's handler looked up the
embedder's callback under `g_runtime_mu`, but V8 can run out of memory in
a thread that holds it, so it tried for a second and then returned. Every
place that locks `g_runtime_mu` now goes through `RuntimeLock`, which marks
the thread as holding it (`t_holds_runtime_mu`): the handler waits without
a time limit when another thread holds it, which always lets go, and reads
the maps as they are when this thread does, and parking then unlocks it,
since the frame that took it never resumes. And an abandoned isolate stays
confined after its env is released, which erases its host data, since
another of its threads can still run out. The cases that still return (no
isolate known on the thread, one the host does not budget, one being
disposed, or a thread creating or disposing one) print which from the
process-wide handler, the last thing before V8 aborts. In V8 13.6 that
handler runs after the isolate's own one returns, so the one-second
timeout alone never aborted the runner.

**And: code cache comes back as a Buffer of its own (#1007).**
`vm.Script#createCachedData()`, a module's cached data and the code cache
Edge.js records for its built-ins all go through `CreateNodeBufferFromBytes`
in `v8/src/unofficial_napi_contextify.cc`, which called the global
`Buffer.from` from C++. Under 4 KiB that copies into Buffer's shared pool,
and renewing the pool calls the guest's `createUnsafeArrayBuffer`; these
host calls lend the guest no store, so that call failed ("[callback
trampoline] no store lent to this thread"), returned `undefined`, and the
new pool was empty. Every pooled allocation in the process threw from then
on (`RangeError: Invalid typed array length`): 200 `createCachedData()`
calls failed 10 runs in 10, and recording the built-ins cache killed
`node` in its bootstrap. The bytes now get a backing store of their own,
viewed as a Uint8Array whose prototype is set to `Buffer.prototype`, as
`napi_create_buffer` does, with no JavaScript run: `Buffer` and its
`prototype` are read only as data properties (a getter or a proxy reads as
absent, and the result is then a plain Uint8Array, which Edge.js turns into
a Buffer itself). Reported as wasmerio/napi#146; drop the hunk with the
release that fixes it.

**Remove it** when a wasmer-napi release after 0.705.0 includes wasmerio/napi
main's rework of `g_mu` (envs owned per thread, termination outside the
lock, 832e57ec's provider locks) and its per-application env ids (9219367),
and #146's fix, and either a guest's event loop is kept alive and woken
for its isolate's background work or the pinned Edge.js does that itself,
and the stall check has another way to count V8's worker threads or goes
without: delete
`vendor/wasmer-napi*`, the `[patch.crates-io]` entry in `../Cargo.toml`, and
bump the version. `builtins/test.sh bash-node` has a job that must time out,
one that runs Workers, one that churns envs, one that compiles WebAssembly
in the background and one that makes code cache (`cached-data-passes`),
which are the checks; check the heap sizes against a Worker pool too.

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
November 2026); wasmerio/wasmer#6982, open, fixes it. Drop the hunk with
the release that has it.

**Nothing is a terminal unless the runtime has one (#1008).** The C
library's `isatty` asks `fd_fdstat_get` and takes a character device that
cannot seek for a terminal, and `WasiFs::fdstat` answered exactly that for
descriptors 0, 1 and 2 before looking at what they held. So in a job every
standard stream was a terminal, and so was a pipe, a file or `/dev/null`
put in its place: `echo 'print(1)' | python` started Python's interactive
prompt and read the script line by line, and tools that colour or prompt
only on a terminal did both into the log. `src/fs/mod.rs` now looks the
descriptor up first, and answers "character device" only for one of the
standard streams the environment was built with (under any number, after
`dup2` or opened as `/dev/stdout`) and only when the runtime's terminal
(`Runtime::tty`) says that stream is a terminal. The runner has none, so
nothing in a job is one. Everything else is what it holds: the job's own
stdin and output are files, a pipe is of unknown type.

That alone would have broken Node. Edge.js's libuv, like Node's,
classifies a standard stream that is not a terminal by `fstat` and, for a
socket, `getsockname` and `getsockopt(SO_TYPE)`, and Node meets an answer
it does not know with a stream that discards everything written to it (and
an empty stdin). Three answers were wrong, all hidden while every stdio
descriptor was a terminal, and each silenced a `node`:

- WASI has no file type for a pipe, so `fstat` of one gave no type at all
  (`node ... | cat`, `$(node -e ...)`). `src/syscalls/wasi/fd_filestat_get.rs`
  reports a pipe as a character device, which libuv takes for a stream it
  can read and write, as it does `/dev/null`; `isatty` still says it is not
  a terminal, since `fd_fdstat_get` calls a pipe unknown.
- A child's piped stdio is a socket pair. Its `fd_filestat_get` already said
  stream socket (wasmerio/wasmer#6784), but the C library reads `SO_TYPE`
  from `fd_fdstat_get`, which said unknown, so `getsockopt` failed. `fdstat`
  now says stream socket for it too (`getsockname` already answers
  `AF_LOCAL`), and libuv opens it as a pipe.
- A child's inherited stdio is moved into place by `dup2`, which gave the
  new descriptor the old one's _inheriting_ rights, empty for stdio, so the
  child's `fstat` of its own stdout failed with `EACCES`. `dup2_at` keeps the
  descriptor's rights, backported from wasmerio/wasmer 2fc27ff21 ("preserve
  descriptor rights in dup2", on `main`, in no release yet).

Upstream main still answers the first two as 0.705.0 does (checked
November 2026).

**A program can use descriptors 3 and 4 (#1019).** They are the preopens,
the virtual root and the job's `/`, and `dup2_at` refused to replace one
with `ENOTSUP`, so bash's `exec 3>&1` (`dup2(1, 3)`) and `exec 4< file`
failed with "Not supported" while 5 and up worked. Letting it is not
enough on its own: a C library finds its preopens once, at start-up, by
asking `fd_prestat_get` from 3 up until one is not a preopen, and sends
every path through the one it picked from then on, as an absolute path
(wasix-libc) or relative to the preopen after asking `fd_fdstat_get` for
the rights to open with (older wasix-libc, bash's, and wasi-libc). The
program does not know. So in `src/fs/mod.rs`:

- `dup2_at` replaces a preopen and keeps it aside for its number;
  closing what was put there puts the preopen back
  (`restore_displaced_preopen_locked`), as a preopen cannot be closed.
- Path calls take their directory from `get_path_base_fd`: an absolute
  path resolves from the virtual root whatever the descriptor is (as
  `openat` ignores `dirfd` for one; resolution already did, only the rights
  check and the lookup of the descriptor did not), and a relative one
  from the preopen kept aside when what is on the descriptor is not a
  directory. `fd_fdstat_get` of such a descriptor gives the preopen's
  inheriting rights, which the older libraries open with.
- `fd_prestat_get` answers only for a directory. The standard streams'
  inodes are marked preopened, so a stream on 4, or on 5 with the
  original two in place (`exec 5>&1`, which already worked), read as a
  preopen whose name could not be read, and every C library started
  after it exited with `EX_OSERR` (71) before `main` (#1026). Descriptor 3 keeps
  answering as the root even when the program has put something else on
  it, since a child inherits that and finds its preopens from there.
- `fd_fdstat_get` and `fd_filestat_get` describe what is on 3, rather
  than the virtual root whatever it holds.

Upstream main still refuses the `dup2` (checked November 2026).

**A symlink the job did not make can be renamed (#1005).** `path_rename`
resolved its source following symlinks, so a dangling link was `ENOENT`,
and then took the source out of its parent's cached entries, where a link
found in the backing file system never is (`get_inode_at_path_inner`
resolves it as `BackingSymlink` and does not insert it): renaming pnpm's
`node_modules/<name>`, or any link the checkout holds, was `ENOENT` too.
The source is now resolved without following, a link missing from the
cache is the inode just resolved, and the target is looked up afterwards
without following as well (following a dangling link there would have hit
the `expect`). Upstream main is unchanged (checked November 2026).

**A guest's CPU clocks are its own (#1038).** `clock_time_get` answered
`CLOCK_PROCESS_CPUTIME_ID` and `CLOCK_THREAD_CPUTIME_ID` with the host's
clocks: the runner's whole CPU time, every job's together, which no job
should see, and the time of whichever pooled host thread runs the guest
thread, its earlier tenants' work included. `src/syscalls/unix/mod.rs`
now asks an embedder's hook first (`set_cpu_clocks`), which the runtime
crate answers from the same per-thread clocks its stall check reads
(`iwci-runtime/src/stall.rs` `guest_cpu`): a guest thread's CPU time since
it started on its host thread, and its process's summed over the threads
it ran on. Upstream has no such hook (checked November 2026); drop the
hunk when a release keeps per-guest CPU time itself.

**A blocking accept or receive waits as long as it takes (#1046).**
`sock_accept`, `sock_recv`, `sock_recv_from` and `fd_read` of a socket
used the socket's timeout option and, when the program had set none,
30 seconds, after which they failed with `ETIMEDOUT` (`listen` also wrote
that default into the listener as if the program had set it). On Linux
they wait until a client or data comes. So a server that waited longer
than that for its first client gave up: pglite as a service exited
("could not accept new connection: Operation timed out") when the job
installed packages before connecting, and a connection idle for 30 s
between queries was dropped the same way. These now take no timeout
unless the program set one (`SO_RCVTIMEO`, or WASIX's accept timeout);
the 30 s defaults for bind, connect and sends are unchanged.

A wait that can last forever has to end when the program is stopped, and
these waited in the host with no ear for signals: a SIGTERM or SIGKILL
reached them only when the 30 s ran out. `__sock_wait`
(`src/syscalls/mod.rs`) now also ends the wait, with `EINTR`, when a
signal is queued for the thread or the thread or its process is made to
finish (the runner's timeout, stall check and service teardown signal
and then terminate), and `__sock_wait_restarts` decides what the program
sees: it does the dynamic linker's pending work (another thread's
`dlopen` waits for every thread with a `Sigwakeup`), runs the signal
handlers or exits, and returns `EINTR` only for a signal the program's
own handler ran on this thread, as Linux does for a handler without
`SA_RESTART`; otherwise the call starts over. With no time limit, a
`readv` whose first buffer fills exactly no longer waits for data for the
next one: only the first buffer waits, the rest take what has arrived (it
used to sit out the 30 s before returning the first buffer's bytes).
Upstream main still defaults to 30 s (checked November 2026).

**Remove it** when a wasmer-wasix release after 0.705.0 has #6958 and
#6982 (a non-blocking wait for any child), 2fc27ff21, a standard stream
that is not a terminal does not say it is one while pipes and socket pairs
still classify as streams, a program can put its own descriptors on the
preopens' numbers and keep its paths, a backing or dangling symlink
can be renamed, a guest's CPU clocks are its own, and a blocking accept
or receive waits with no timeout of its own and still ends for a signal:
delete `vendor/wasmer-wasix*`, its `[patch.crates-io]`
entry in `../Cargo.toml`, and check `builtins/test.sh`'s
`background-passes` and `shebang-passes` (bash and bash-node),
`shebang-missing-interpreter-fails`, `no-terminal-passes` (bash and
bash-node), `low-fds-passes`, `rename-passes` (bash and bash-node),
`bash-node/cpu-time-passes`, `bash-node/idle-server-passes`,
`python/idle-server-passes`, `python/idle-server-timeout-fails` and
`postgres/idle-client-passes`, and `iwci-runtime`'s
`no_descriptor_is_a_terminal`, `a_program_can_replace_the_preopens_and_keep_its_paths`,
`a_bash_script_can_use_descriptors_3_and_4`,
`a_blocking_accept_or_recv_is_stopped_by_the_timeout`,
`an_accept_timeout_the_program_sets_still_applies` and
`a_service_blocked_in_accept_takes_its_sigterm`.

To regenerate after editing: `diff -u` each changed file against the crate
from crates.io with `a/` and `b/` labels.

## wasmer-vm 7.5.0

From crates.io, sha256
`3b60bc87e4993702174a81a6dd4503d915331b1d50caf868fd0998f61f34afa5`
(it has no tests), and `wasmer-vm.patch` applied.

**Why (#968).** The runner stops a job's spinning processes with Wasmer's
host interrupt (`Store::interrupter`, behind `experimental-host-interrupt`):
a SIGUSR1 to the thread running the store, whose handler makes the thread
trap whenever its stack pointer is on the store's Wasm stack. Compiled Wasm
is not all that runs there. A host function's return path does too
(`StoreContext::get_current_transient`, then `interrupt_registry::is_interrupted`,
which takes the registry's `DashMap` lock), and so do the libcalls. A trap
there abandons that code where it stands. `interrupt()` holds the same
`DashMap` shard while it sends the signal, so a thread returning from a
syscall at that moment is waiting for that lock, in `parking_lot`, when the
signal lands. The first time a thread parks, `parking_lot` sets up its
thread data, whose destructor glibc registers with a list node that it
links first and gives its owner (`map`) after taking the loader's lock; a
trap in between left a node with no owner, and the thread segfaulted in
`__call_tls_dtors` as it exited (`segfault at 498`, a null `map`'s
`l_tls_dtor_count`). That is what killed the test binaries, which drop
their pool threads after each `Runtime`, after a job whose forked subshell
spun until its timeout: that subshell makes a syscall every few
instructions, and the runner interrupts it every 50 ms for up to five
seconds. A long-lived runner never ends its pool threads, so it would not
crash this way, but the same abandonment leaves `parking_lot`'s queues and
the store context's `RefCell` in whatever state the trap found them.

`src/trap/traphandlers.rs` now records the executable segments of every
loaded object when it installs its handlers (`dl_iterate_phdr`; the program,
libc, the vDSO), and the SIGUSR1 handler traps only when the interrupted
`pc` is outside all of them, which is to say in compiled Wasm, mapped
anonymously. Elsewhere it still takes the request (so the next one can be
sent) and returns; the store stays marked interrupted, and the host
function's return path raises the trap at its own check, where nothing is
half done. A store spinning in Wasm is trapped by the next interrupt the
runner sends. One thing this gives up: a guest blocked in a
`memory.atomic.wait` libcall is no longer trapped out of it (which left its
lock taken), so it waits until it is notified; no guest the runner ships
waits that way (WASIX's futexes are syscalls). Linux only: elsewhere no
segment is recorded and the handler behaves as before.

`crates/iwci-runtime`'s `killing_a_syscall_spinner_leaves_its_threads_whole`
is the check: without this patch it failed ten runs in ten (aborts on a null
pointer dereference, a segfault, `RefCell already borrowed`, deadlocks), and
with it ten in ten pass.

**And: a host call takes no process-wide lock on its way back (#994).**
Every host function's return path asks `interrupt_registry::is_interrupted`
whether its store was interrupted, and that took a write lock on the
registry `DashMap`'s shard (`entry`), so every store's thread in the runner
wrote the same few cache lines on every host call: 9% of a Node
`fs.statSync` loop's cycles. A store's `interrupted` flag is now an
`Arc<AtomicBool>` that its entry and each of its installations on its
thread's stack share (`src/interrupt_registry/unix.rs`), and
`is_interrupted` reads the flag from the calling thread's stack, which is
where the returning host function's store is installed, falling back to a
shared read of the map for a store installed elsewhere. `interrupt()` sets
the flag under the shard lock as before and only then signals, so the
return path above still sees every interrupt the handler leaves to it, and
an uninstall that removes the entry still resets the flag for the store's
next call. Reported upstream as wasmerio/wasmer#7161.

**And: a shared memory's view takes no lock (#994).** Every host function
that reads or writes guest memory makes a `MemoryView`, which asks the
memory for its size and its definition, and for a shared memory, which
every WASIX program has, each took the read lock of the one `RwLock` the
program's threads share: 12% of a `statSync` loop's cycles. A `WasmMmap`
never replaces its definition, so `VMSharedMemory` (`src/memory.rs`) keeps
the pointer from when it was made and answers both from it without the
lock, reading `current_length` as `MemoryView` already does beside it. A
`grow` still takes the write lock, and a size read without the lock is no
staler than one read under it, which nothing held once it returned.

**Remove it** when a wasmer-vm release has the interrupt handler leave host
code alone (wasmerio/wasmer `main` still traps on the stack pointer alone as
of November 2026), reads the interrupted flag without a write lock
(#7161) and answers a shared memory's size and definition without its
lock: delete `vendor/wasmer-vm*` and its `[patch.crates-io]` entry. A
release with only the first is still worth taking for the rest of this
patch's sake; check a `statSync` loop (#994) against the patched build
before dropping the other two.

To regenerate after editing: `diff -u` the changed file against the crate
from crates.io with `a/` and `b/` labels, as for wasmer-napi.

## virtual-net 0.705.0

From crates.io, sha256
`bd95d7124df8647ae6d74b8074ac683479f14a8ee0cdc909a0a21a171052b566`, whole
(its tests are in `src/`), with `virtual-net.patch` applied.

**Why (#1009).** A job's loopback is wasmer's `LoopbackNetworking`, which
puts every listener in its `tcp_listeners` map so connections can find it,
and nothing ever took one out: a port a job listened on stayed taken until
the job ended, after the socket was closed and after its process exited, and
binding it again failed with `EADDRINUSE`. A test suite that starts and stops
a server on a fixed port, or a service restarted inside a job, could not.
`src/loopback.rs` now hands out the listener wrapped in a
`LoopbackListeningSocket` that removes its own entry when it is dropped,
which is when the guest's last descriptor for it closes, as connected sockets
already released their port. The runtime's own listener set
(`iwci-runtime/src/network.rs`) already did the same, so connections to a
closed port were refused; only the address stayed taken.
`a_closed_listener_frees_its_port_for_the_next_one` there and
`builtins/test.sh bash-node`'s `rebind-passes` are the checks, and the patch
adds `test_loopback_closed_listener_releases_its_port` beside upstream's
loopback tests.

**Remove it** when a virtual-net release after 0.705.0 releases a closed
listener's address (wasmerio/wasmer `main` still keeps it as of November
2026): delete `vendor/virtual-net*` and its `[patch.crates-io]` entry.

To regenerate after editing: `diff -u` the changed files against the crate
from crates.io with `a/` and `b/` labels.
