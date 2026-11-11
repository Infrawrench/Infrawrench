#!/usr/bin/env bash
# Tests the builtins and environments the way a user meets them: builds each
# with its own build.sh, publishes it to a throwaway store with
# `iwci publish`, then runs a pipeline through `iwci run` against a fixture
# repository. That covers the pinned sources, the build, the manifest,
# publishing, resolving `builtin:`/`env:` references and the tool's ABI in
# one go, and checks the tool really does its job (gofmt finds the file that
# is not formatted, tsc reports the type error).
#
#   builtins/test.sh                 gofmt, bash and tools (the default)
#   builtins/test.sh typescript oxfmt bash-node
#
# `tools` runs gofmt from a bash script (`tools:`), so it needs gofmt and
# bash earlier in the same list.
#
# Expectations live in the job names: a job whose key ends in `-passes`
# must pass and one ending in `-fails` must fail, for the reason
# `want_reason` gives (a formatter by changing files, not by exiting with an
# error). A tool that does not resolve or start is an `error`, not a
# failure, so it cannot hide behind an expected failure.
#
# IWCI is the `iwci` binary to use (default: target/debug/iwci; bash-node
# needs one built with `--features node`, and x86_64 Linux to build its
# Edge.js, see environments/edgejs/build.sh). SKIP_BUILD=1 publishes what is
# already in dist/ instead of building. Needs: git, jq, and whatever the
# named build scripts need.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

IWCI="${IWCI:-$here/../target/debug/iwci}"
if [[ $# -eq 0 ]]; then
  set -- gofmt bash tools
fi

# A secret the bash pipeline reads, which must never show up in a report.
export IWCI_SECRET_FIXTURE_TOKEN="fixture-secret-value-0451"

# Build each requested builtin once, then publish everything it produced.
built_envs=false
for name in "$@"; do
  case "$name" in
    gofmt | oxfmt | typescript)
      [[ "${SKIP_BUILD:-}" == 1 ]] || bash "$here/$name/build.sh"
      dirs=("$dist"/builtin/"$name"/*)
      ;;
    bash | bash-node)
      if [[ "${SKIP_BUILD:-}" != 1 && "$built_envs" == false ]]; then
        envs=()
        for env in "$@"; do
          [[ "$env" == bash || "$env" == bash-node ]] && envs+=("$env")
        done
        bash "$here/environments/build.sh" "${envs[@]}"
        built_envs=true
      fi
      dirs=("$dist"/environment/"$name"/*)
      ;;
    tools)
      # Uses what gofmt and bash published.
      continue
      ;;
    *)
      echo "error: no test for \`$name\`; know gofmt, oxfmt, typescript, bash, bash-node, tools" >&2
      exit 2
      ;;
  esac
  "$IWCI" publish "${dirs[@]}" --store "$SCRATCH/store" --cache "$SCRATCH/cache"
done

# The fixture repository: one directory per tool, each with something that
# passes and something that must fail.
repo="$SCRATCH/repo"
mkdir -p "$repo"/go/{clean,dirty} "$repo"/ts/{ok,bad} "$repo"/js/{clean,dirty}
printf 'package main\n\nfunc main() {\n\tprintln(1)\n}\n' >"$repo/go/clean/main.go"
printf 'package main\nfunc main(){\nprintln( 1 )}\n' >"$repo/go/dirty/main.go"
for dir in ok bad; do
  printf '{ "compilerOptions": { "strict": true, "noEmit": true, "types": [] }, "files": ["a.ts"] }\n' \
    >"$repo/ts/$dir/tsconfig.json"
done
printf 'export const n: number = 1;\n' >"$repo/ts/ok/a.ts"
printf "export const n: number = 'one';\n" >"$repo/ts/bad/a.ts"
printf 'export const a = { b: 1 };\n' >"$repo/js/clean/a.js"
printf 'export const a={b:1}\n' >"$repo/js/dirty/a.js"
printf 'fixture line\n' >"$repo/data.txt"
printf '#!/bin/sh\necho run\n' >"$repo/run.sh"
chmod +x "$repo/run.sh"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name=iwci -c user.email=ci@example.com commit -qm fixture

pipeline() {
  case "$1" in
    gofmt)
      cat <<'YAML'
name: gofmt
jobs:
  clean-passes:
    using: builtin:gofmt@1.27
    cwd: /app/go/clean
    args: [-l, -w, .]
    changes: fail
  dirty-fails:
    using: builtin:gofmt@1.27
    cwd: /app/go/dirty
    args: [-l, -w, .]
    changes: fail
YAML
      ;;
    typescript)
      cat <<'YAML'
name: typescript
jobs:
  ok-passes:
    using: builtin:typescript@7.1
    cwd: /app/ts/ok
    args: [-p, .]
  type-error-fails:
    using: builtin:typescript@7.1
    cwd: /app/ts/bad
    args: [-p, .]
YAML
      ;;
    oxfmt)
      cat <<'YAML'
name: oxfmt
jobs:
  clean-passes:
    using: builtin:oxfmt@0.69
    cwd: /app/js/clean
    args: [--write, .]
    changes: fail
  dirty-fails:
    using: builtin:oxfmt@0.69
    cwd: /app/js/dirty
    args: [--write, .]
    changes: fail
YAML
      ;;
    bash)
      cat <<'YAML'
name: bash
jobs:
  coreutils-passes:
    using: env:bash@5
    run: |
      test "$(printf 'b\na\n' | sort | head -n 1)" = a
      sed -n 1p data.txt | grep -q '^fixture'
      test "$(find . -name data.txt)" = ./data.txt
      mkdir -p out && echo hello > out/x && test "$(cat out/x)" = hello
  false-fails:
    using: env:bash@5
    run: |
      false
      echo unreachable
  # A process killed by a signal it does not handle: wasix-libc says which
  # and aborts with 127, and the runner adds who sent it (#955) to the
  # job's stderr, which is masked like the rest of it: the token printed
  # just before must not be in the report (checked for the whole report
  # below).
  signal-fails:
    using: env:bash@5
    env:
      TOKEN: ${{ secrets.FIXTURE_TOKEN }}
    run: |
      echo "dying with $TOKEN" >&2
      kill -s SYS $$
      echo unreachable
  scratch-write-passes:
    using: env:bash@5
    run: |
      mkdir -p "$IWCI_SCRATCH/build"
      echo from-write > "$IWCI_SCRATCH/build/out.txt"
  scratch-read-passes:
    using: env:bash@5
    needs: [scratch-write-passes]
    run: test "$(cat /tmp/workflow/build/out.txt)" = from-write
  secret-passes:
    using: env:bash@5
    env:
      TOKEN: ${{ secrets.FIXTURE_TOKEN }}
    run: |
      test "$TOKEN" = fixture-secret-value-0451
      echo "the token is $TOKEN"
  # The rest of the script runs beside a background child (#961): bash
  # used to wait for it after the next command, so the loop only ended
  # once `done` existed.
  background-passes:
    using: env:bash@5
    run: |
      (sleep 3; touch done) &
      i=0; while [ "$i" -lt 2000 ]; do i=$((i + 1)); done
      test ! -e done
      wait
      test -e done
  # A script runs its `#!` interpreter (#958), here `cat`, which prints it:
  # bash on its own would have run the file as a shell script.
  shebang-passes:
    using: env:bash@5
    run: |
      printf '#!/bin/cat\nhello\n' > s
      test "$(./s)" = "$(printf '#!/bin/cat\nhello')"
  # File modes are kept (#959): set by chmod and mktemp, read by stat,
  # moved by mv, and a checked-out executable is one.
  modes-passes:
    using: env:bash@5
    run: |
      test "$(stat -c %a run.sh)" = 755
      test "$(stat -c %a data.txt)" = 644
      echo secret > f
      chmod 600 f
      test "$(stat -c %a f)" = 600
      test "$(stat -c '%A %F %s' f)" = "-rw------- regular file 7"
      chmod u+x,go+r f
      test "$(stat -c %a f)" = 744
      chmod -x f
      test "$(stat -c %a f)" = 644
      chmod 640 f
      mv f g
      test "$(stat -c %a g)" = 640
      mkdir -p tree/sub
      touch tree/sub/x
      chmod -R go-rwx tree
      test "$(stat -c %a tree tree/sub/x)" = "$(printf '700\n600')"
      umask 077
      key="$(mktemp)"
      test "$(stat -c %a "$key")" = 600
      dir="$(mktemp -d)"
      test "$(stat -c %a "$dir")" = 700
      rm "$key"
      touch "$key"
      test "$(stat -c %a "$key")" = 644
      stat run.sh
  stat-missing-fails:
    using: env:bash@5
    run: stat no-such-file
YAML
      ;;
    tools)
      cat <<'YAML'
name: tools
jobs:
  gofmt-on-path-passes:
    using: env:bash@5
    tools: [builtin:gofmt@1.27]
    run: test "$(gofmt -l go/dirty)" = go/dirty/main.go
  gofmt-finds-dirty-fails:
    using: env:bash@5
    tools: [builtin:gofmt@1.27]
    run: test -z "$(gofmt -l go/dirty)"
YAML
      ;;
    bash-node)
      cat <<'YAML'
name: bash-node
jobs:
  node-passes:
    using: env:bash-node@24
    run: |
      test "$(node -e 'console.log(6 * 7)')" = 42
      node --version
  package-managers-passes:
    using: env:bash-node@24
    run: |
      npm --version
      pnpm --version
  throw-fails:
    using: env:bash-node@24
    run: |
      node -e 'throw new Error("expected")'
  # Two isolates alive at once, each growing its heap well past where it
  # starts: two jobs' `node` once crashed the runner on a CPU with memory
  # protection keys, and a burst of allocation outran fixed heap grants and
  # aborted it ("Reached heap limit"). See vendor/README.md.
  allocate-a-passes:
    using: env:bash-node@24
    run: |
      node -e 'const k = []; for (let i = 0; i < 4e6; i++) k.push({ i, s: "x" + i }); console.log(k.length)'
  allocate-b-passes:
    using: env:bash-node@24
    run: |
      node -e 'const k = []; for (let i = 0; i < 4e6; i++) k.push({ i, s: "y" + i }); console.log(k.length)'
  # Edge.js has `node:wasi` without the binding behind it; the runner's
  # support files (iwci-runtime/node) make it work, which the wasm32-wasi
  # builds of native packages need (rolldown, and so Vite, Vitest and
  # tsdown). A 131-byte WASI program that prints `hi` runs through it under
  # `require`, under `import` (dynamic and named) and in a worker thread.
  node-wasi-passes:
    using: env:bash-node@24
    timeout: 3m
    run: |
      printf '%s' '0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a1d011b004110410836020041144103360200410141104101411810001a0b0b09010041080b0368690a' > /tmp/hi.hex
      cat > /tmp/wasi.js <<'JS'
      const { readFileSync } = require("node:fs");
      const { Worker } = require("node:worker_threads");
      const bytes = Buffer.from(readFileSync("/tmp/hi.hex", "utf8"), "hex");
      async function run(WASI) {
        const wasi = new WASI({ version: "preview1" });
        const { instance } = await WebAssembly.instantiate(bytes, wasi.getImportObject());
        wasi.start(instance);
      }
      (async () => {
        await run(require("node:wasi").WASI);
        await run((await import("node:wasi")).WASI);
        await new Promise((resolve, reject) => {
          const worker = new Worker(
            `const { WASI } = require("node:wasi");
            const wasi = new WASI({ version: "preview1" });
            const bytes = Buffer.from(require("node:fs").readFileSync("/tmp/hi.hex", "utf8"), "hex");
            WebAssembly.instantiate(bytes, wasi.getImportObject()).then(({ instance }) => wasi.start(instance));`,
            { eval: true },
          );
          worker.on("exit", resolve);
          worker.on("error", reject);
        });
      })();
      JS
      # A static named import, as rolldown's worker threads write it: Node
      # only offers a CommonJS module's names to one when it can see them.
      cat > /tmp/wasi-named.mjs <<'JS'
      import { readFileSync } from "node:fs";
      import { WASI } from "node:wasi";
      const wasi = new WASI({ version: "preview1" });
      const bytes = Buffer.from(readFileSync("/tmp/hi.hex", "utf8"), "hex");
      const { instance } = await WebAssembly.instantiate(bytes, wasi.getImportObject());
      wasi.start(instance);
      JS
      # stderr stays on: a failure's reason is all a log has to go on.
      out="$(node /tmp/wasi.js; node /tmp/wasi-named.mjs)"
      echo "$out"
      test "$(grep -c '^hi$' <<<"$out")" = 4
  # An async WebAssembly compile as a program's only pending work (#943).
  # Edge.js neither waited for V8's background compile before treating its
  # loop as empty nor heard when it finished, so under load about one
  # `node` in five exited with the compile unfinished, and one held open by
  # a long timer picked the result up only when the timer fired. The
  # bridge's V8 platform covers both (vendor/README.md). Twenty bare
  # compiles, then one beside a 20s timer that must not be what wakes it.
  wasm-compile-passes:
    using: env:bash-node@24
    timeout: 3m
    run: |
      cat > /tmp/compile.js <<'JS'
      const bytes = Buffer.from("0061736d01000000010401600000030201000a040102000b", "hex");
      const timer = process.argv[2] === "timer" ? setTimeout(() => console.log("timer fired"), 20000) : null;
      WebAssembly.instantiate(bytes).then(() => { console.log("done"); clearTimeout(timer); });
      JS
      for i in $(seq 20); do test "$(node /tmp/compile.js)" = done; done
      test "$(node /tmp/compile.js timer)" = done

  # Relative paths read from many threads at once (#937): wasix-libc made
  # them absolute in one buffer every thread shares, so a read could open
  # the working directory (EISDIR) or another file. The environment's
  # Edge.js is built on a C library without that buffer
  # (environments/edgejs/build.sh), and nothing in the runner stands in for
  # it. Four files of the same length, 40,000 reads, every one checked for
  # its own contents: 40 to 69 per run came back wrong before.
  relative-reads-passes:
    using: env:bash-node@24
    timeout: 3m
    run: |
      mkdir -p /tmp/reads && cd /tmp/reads
      for n in a b c d; do printf '%s' "$n$n$n$n" > "$n.txt"; done
      cat > /tmp/reads.js <<'JS'
      const fs = require("node:fs");
      const names = ["a.txt", "b.txt", "c.txt", "d.txt"];
      let bad = 0;
      (async () => {
        for (let round = 0; round < 10; round++)
          await Promise.all(Array.from({ length: 4000 }, (_, i) => {
            const name = names[i % names.length];
            return fs.promises.readFile(name, "utf8").then(
              (text) => { if (text !== name[0].repeat(4)) bad++; },
              () => bad++,
            );
          }));
        console.log(`bad reads: ${bad}`);
        process.exit(bad === 0 ? 0 : 1);
      })();
      JS
      UV_THREADPOOL_SIZE=64 node /tmp/reads.js

  # A blob with an empty part streams to its end (#940): Edge.js's
  # `Blob.stream()` stopped at the first empty part and never finished, so
  # gzipping an empty blob hung. The runner's preload reads past them.
  blob-stream-passes:
    using: env:bash-node@24
    timeout: 2m
    run: |
      cat > /tmp/blob.mjs <<'JS'
      import { openAsBlob, writeFileSync } from "node:fs";
      setTimeout(() => { console.error("a blob stream never ended"); process.exit(1); }, 30_000).unref();
      const length = async (stream) => (await new Response(stream).arrayBuffer()).byteLength;
      writeFileSync("/tmp/empty.txt", "");
      const lengths = [
        await length(new Blob([""]).stream()),
        await length(new Blob(["a", "", "b"]).stream()),
        await length((await openAsBlob("/tmp/empty.txt")).stream()),
        await length(new Blob([""]).stream().pipeThrough(new CompressionStream("gzip"))),
      ];
      console.log(lengths.join(" "));
      JS
      test "$(node /tmp/blob.mjs)" = "0 2 0 20"

  # Another job's spinning script must not hold this one up: Node jobs once
  # took turns behind the bridge's process-wide lock, so this `node`, started
  # while spin-fails runs for 40s, could not begin until it was stopped. Both
  # wait for node-passes, which compiles Edge.js, and the timeouts leave room
  # for a debug build's slow start: held up, this waits ~38s and times out at
  # 25s; not held up, it has over 20s to start node.
  not-held-up-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 25s
    run: |
      sleep 2
      node -e 'console.log("not held up")'
  # worker_threads: a round trip, a pool sharing work, a worker that throws
  # (reported as an error, not a hang) and a busy worker stopped by
  # terminate(). Each Worker's isolate is created on another WASIX thread,
  # whose store once allocated the same env id as its parent's, so the
  # worker's bootstrap failed and the parent waited forever; the generous
  # timeout is for a debug build, a hang still fails it. See vendor/README.md.
  worker-threads-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 180s
    run: |
      cat > /tmp/workers.js <<'JS'
      const assert = require("assert");
      const { Worker } = require("worker_threads");
      const run = (src, opts = {}) => new Worker(src, { eval: true, ...opts });
      const once = (w, ev) => new Promise((resolve) => w.once(ev, resolve));
      (async () => {
        const echo = run('const { parentPort } = require("worker_threads"); parentPort.once("message", (m) => parentPort.postMessage(m * 2))');
        echo.postMessage(21);
        assert.equal(await once(echo, "message"), 42);
        assert.equal(await once(echo, "exit"), 0);

        const sab = new SharedArrayBuffer(4);
        const pool = [1, 2, 3, 4].map(() => run('const { workerData } = require("worker_threads"); const a = new Int32Array(workerData); for (let i = 0; i < 1e5; i++) Atomics.add(a, 0, 1)', { workerData: sab }));
        assert.deepEqual(await Promise.all(pool.map((w) => once(w, "exit"))), [0, 0, 0, 0]);
        assert.equal(Atomics.load(new Int32Array(sab), 0), 4e5);

        const thrower = run('throw new Error("from the worker")');
        assert.equal((await once(thrower, "error")).message, "from the worker");
        assert.equal(await once(thrower, "exit"), 1);

        const busy = run('require("worker_threads").parentPort.postMessage("busy"); for (;;) {}');
        assert.equal(await once(busy, "message"), "busy");
        assert.equal(await busy.terminate(), 1);
        console.log("worker threads ok");
      })().catch((e) => { console.error(e); process.exit(1); });
      JS
      node /tmp/workers.js
  # A worker stopped while it blocks in `Atomics.wait` with another message
  # queued, by terminate() and by its parent exiting. The stop wakes the
  # wait, V8 lifts the termination once the handler has unwound, and Edge.js
  # went on to dispatch the queued message, whose handler blocked again: the
  # parent waited forever in `pthread_join` (#938: rolldown's wasm worker
  # threads, about one tsdown bundle in 300 to 600). `env:bash-node` 24.0.3
  # drops a stopped worker's queued messages (environments/edgejs).
  worker-stop-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 3m
    run: |
      cat > /tmp/stop.js <<'JS'
      const assert = require("assert");
      const { Worker } = require("worker_threads");
      const waiter = () => {
        const w = new Worker(`
          const { parentPort } = require("worker_threads");
          const cell = new Int32Array(new SharedArrayBuffer(4));
          parentPort.on("message", (m) => {
            parentPort.postMessage(m);
            Atomics.wait(cell, 0, 0);
          });
        `, { eval: true });
        w.postMessage(1);
        w.postMessage(2);
        return w;
      };
      const terminated = waiter();
      terminated.once("message", async () => {
        assert.equal(await terminated.terminate(), 1);
        // Left running, unreferenced: stopped as this process exits.
        const left = waiter();
        left.once("message", () => {
          left.unref();
          console.log("worker stop ok");
        });
      });
      JS
      node /tmp/stop.js
  # Isolates made and released on many threads at once while they load
  # ES modules: the bridge's env registry and the module-wrap maps are
  # shared by every isolate in the runner, and were once changed without a
  # lock, which segfaulted the runner under a full Test pipeline (#947). A
  # race does not fail every time, so this is a smoke check; the decisive
  # one is a big pipeline on the runner host. It is also where the guest's
  # own thread-exit race showed (#967: a Worker's thread trapping as it
  # started, the `node` exiting 1 in silence), which the environment's C
  # library no longer has (environments/edgejs/build.sh).
  env-churn-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 5m
    run: |
      mkdir -p /tmp/churn && cd /tmp/churn
      for n in 0 1 2 3; do echo "export default () => $n;" > "m$n.mjs"; done
      cat > w.mjs <<'JS'
      import { parentPort } from "node:worker_threads";
      const mods = await Promise.all([0, 1, 2, 3].map((n) => import(`/tmp/churn/m${n}.mjs`)));
      parentPort.postMessage(mods.reduce((sum, m) => sum + m.default(), 0));
      JS
      cat > churn.mjs <<'JS'
      import { Worker } from "node:worker_threads";
      let started = 0, done = 0;
      await new Promise((resolve, reject) => {
        const next = () => {
          if (done === 48) return resolve();
          if (started === 48) return;
          started++;
          const w = new Worker("/tmp/churn/w.mjs");
          w.once("message", (sum) => sum === 6 || reject(new Error(`sum ${sum}`)));
          w.once("error", reject);
          w.once("exit", () => { done++; next(); });
        };
        for (let i = 0; i < 6; i++) next();
      });
      console.log("churned");
      JS
      # Two at once; WASIX bash may not report a background job's status, so
      # each one's output is the check.
      node churn.mjs > a.out &
      node churn.mjs > b.out &
      wait
      test "$(cat a.out b.out | grep -c '^churned$')" = 2
  # A `node` that waits on nothing, the way a hung one looks (#938): no
  # output, no CPU, a timer far in the future. It is stopped as stalled long before its
  # timeout, and says so (this pipeline runs with --stall-after 15s).
  hang-fails:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 10m
    run: |
      echo waiting
      node -e 'setTimeout(() => {}, 2 ** 31 - 1)'
  # Silent work is not a hang: 25s of computing that prints only at the
  # end, longer than the stall window, must pass. It waits for the jobs
  # that churn threads: a core spinning beside them makes the guest's
  # thread exit race (#967) fail them more often, as it did on GitHub's
  # four cores.
  quiet-work-passes:
    using: env:bash-node@24
    needs: [worker-threads-passes, env-churn-passes]
    timeout: 3m
    run: |
      node -e 'let n = 0; const end = Date.now() + 25000; while (Date.now() < end) n++; console.log(n > 0)'
  # `node`s forked and ended in quick succession by two parents at once, as
  # a test runner's pool of forked workers does. The bridge once kept a dead
  # `node`'s guest heap in a registry under its memory's address, and a
  # `node` whose memory was mapped there next was given it: the host then
  # wrote over the start of the new guest's own heap, and that `node` died
  # as it started ("Bad system call", #955), about one fork in 3,000. A race
  # does not fail every time, so this is a smoke check.
  fork-churn-passes:
    using: env:bash-node@24
    needs: [node-passes]
    memory: 3GiB
    timeout: 5m
    run: |
      mkdir -p /tmp/forks && cd /tmp/forks
      cat > child.js <<'JS'
      const buf = Buffer.alloc(1 << 16, 1);
      process.send({ ok: buf.length });
      setInterval(() => {}, 1000);
      JS
      cat > parent.js <<'JS'
      const { fork } = require("node:child_process");
      const total = 60, width = 2;
      let started = 0, done = 0, bad = 0;
      const next = () => {
        if (done === total) {
          console.log(bad === 0 ? "forked" : `${bad} of ${total} forks died`);
          return;
        }
        if (started === total) return;
        started++;
        const child = fork("/tmp/forks/child.js", { stdio: ["ignore", "inherit", "pipe", "ipc"] });
        let err = "", answered = false;
        child.stderr.on("data", (d) => (err += d));
        child.on("message", () => { answered = true; child.kill("SIGTERM"); });
        child.on("exit", () => {
          if (!answered) { bad++; console.error(err.slice(0, 600)); }
          done++; next();
        });
      };
      for (let i = 0; i < width; i++) next();
      JS
      # Two at once; WASIX bash may not report a background job's status, so
      # each one's output is the check.
      node parent.js > a.out &
      node parent.js > b.out &
      wait
      cat a.out b.out
      test "$(cat a.out b.out | grep -c '^forked$')" = 2
  # Node runs a script by its `#!` line, as Linux does (#958): by path,
  # through `/usr/bin/env`, and found on PATH, with its arguments.
  shebang-passes:
    using: env:bash-node@24
    run: |
      printf '#!/bin/bash\necho hi "$@"\n' > s
      test "$(node -e 'require("child_process").execFileSync("./s",{stdio:"inherit"})')" = hi
      printf '#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join(" "))\n' > n.js
      test "$(node -e 'require("child_process").execFileSync("./n.js",["a","b"],{stdio:"inherit"})')" = "a b"
      test "$(PATH="$PWD:$PATH" node -e 'require("child_process").execFileSync("s",["c"],{stdio:"inherit"})')" = "hi c"
      test "$(./n.js d)" = d
  # An interpreter that is not there is ENOENT, as on Linux.
  shebang-missing-interpreter-fails:
    using: env:bash-node@24
    run: |
      printf '#!/bin/no-such-interpreter\necho ran\n' > s
      node -e 'try { require("child_process").execFileSync("./s") } catch (e) { console.error(e.code); process.exit(e.code === "ENOENT" ? 1 : 2) }'
  # A `node` that another `node` forks gets the first isolate's old
  # generation; a Worker keeps the small start. Forks once started from
  # 64 MiB like workers, where a test file's working set never grew the heap
  # and V8 collected all of it every few megabytes allocated, half of a
  # jsdom Vitest run's CPU (vendor/README.md).
  child-heap-passes:
    using: env:bash-node@24
    needs: [node-passes]
    memory: 2GiB
    timeout: 3m
    run: |
      cat > /tmp/heap.js <<'JS'
      const { fork } = require("node:child_process");
      const { Worker } = require("node:worker_threads");
      const limit = 'Math.round(require("node:v8").getHeapStatistics().heap_size_limit / 2 ** 20)';
      if (process.argv[2] === "child") {
        process.send(eval(limit));
      } else {
        const child = fork(__filename, ["child"]);
        child.once("message", (forked) => {
          const w = new Worker(`require("node:worker_threads").parentPort.postMessage(${limit})`, { eval: true });
          w.once("message", (worker) => {
            console.log(`forked ${forked} worker ${worker}`);
            const ok = forked >= 256 && worker < 256;
            child.kill();
            w.terminate().then(() => process.exit(ok ? 0 : 1));
          });
        });
      }
      JS
      node /tmp/heap.js
  # A script that never yields must still be stopped by the job's timeout.
  spin-fails:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 40s
    run: |
      node -e 'for (;;) {}'
  # A `node` that outgrows the job's memory, while the jobs above run in the
  # same runner (#972). Its heap is refused growth, it is stopped, and the
  # job fails saying memory (#964). At 1 GiB, a string that doubles needs
  # more in one allocation than a stopped isolate is given, so V8 reaches
  # its own limit: 0.3.4 aborted the whole runner there every time, and the
  # bridge now parks that thread and ends only this job.
  heap-objects-fails:
    using: env:bash-node@24
    memory: 512MiB
    timeout: 3m
    run: |
      node -e 'const a = []; for (;;) a.push({ x: Math.random(), s: "abc" + a.length })'
  heap-strings-fails:
    using: env:bash-node@24
    memory: 1GiB
    timeout: 3m
    run: |
      node -e 'const a = []; let s = "x"; for (;;) { s = s + s.slice(0, 1e6) + Math.random(); a.push(s.slice(1)); }'
  # More worker threads than the job's memory holds: the rest fail to start
  # (ERR_WORKER_INIT_FAILED), and when the program then fails, its report
  # says memory rather than only "exited with 1" (#964).
  workers-refused-fails:
    using: env:bash-node@24
    needs: [node-passes]
    memory: 512MiB
    timeout: 3m
    run: |
      cat > /tmp/many.js <<'JS'
      const { Worker } = require("node:worker_threads");
      let refused = 0, settled = 0;
      const workers = [];
      for (let i = 0; i < 12; i++) {
        const w = new Worker("setTimeout(() => {}, 1e9)", { eval: true });
        w.on("online", () => ++settled === 12 && done());
        w.on("error", (e) => { refused++; console.error(e.code); ++settled === 12 && done(); });
        workers.push(w);
      }
      function done() {
        console.log(`${refused} of 12 refused`);
        for (const w of workers) w.terminate();
        process.exitCode = refused > 0 ? 1 : 0;
      }
      JS
      node /tmp/many.js
YAML
      ;;
  esac
}

# What a `-fails` job's failure reason must contain.
want_reason() {
  case "$1" in
    gofmt/dirty-fails | oxfmt/dirty-fails) echo "changed 1 file" ;;
    typescript/type-error-fails) echo "exited with 2" ;;
    bash/false-fails | bash/stat-missing-fails | bash-node/throw-fails | bash-node/shebang-missing-interpreter-fails | tools/gofmt-finds-dirty-fails) echo "exited with 1" ;;
    bash-node/spin-fails) echo "timed out" ;;
    bash/signal-fails) echo "exited with 127" ;;
    bash-node/hang-fails) echo "stalled: no output and no CPU use for 15s" ;;
    bash-node/heap-objects-fails | bash-node/workers-refused-fails) echo "ran out of its 512 MiB of memory" ;;
    bash-node/heap-strings-fails) echo "ran out of its 1024 MiB of memory" ;;
    *) echo "" ;;
  esac
}

# What a job's stderr must contain, as an extended regular expression.
want_stderr() {
  case "$1" in
    bash/signal-fails) echo "dying with \\*\\*\\*.*Program recieved fatal signal: Bad system call.*iwci: the job exited with 127 after a signal.*a guest called [a-z_]+\\(.*Sigsys" ;;
    bash-node/heap-objects-fails) echo "iwci: the job ran out of its 512 MiB of memory.*JavaScript heap could not grow" ;;
    bash-node/heap-strings-fails) echo "iwci: the job ran out of its 1024 MiB of memory.*V8 ran out of heap in an isolate" ;;
    bash-node/workers-refused-fails) echo "ERR_WORKER_INIT_FAILED.*iwci: the job ran out of its 512 MiB of memory.*worker threads could not start" ;;
    *) echo "" ;;
  esac
}

failed=0
for name in "$@"; do
  file="$SCRATCH/$name.yml"
  pipeline "$name" >"$file"
  echo "== $name"
  # iwci exits non-zero when any job fails, which some jobs here must do,
  # so its status only matters when there is no report.
  status=0
  # A short stall window where a job checks it (hang-fails); the default
  # is minutes.
  stall_after=5m
  if [[ "$name" == bash-node ]]; then
    stall_after=15s
  fi
  out="$("$IWCI" run --repo "$repo" --branch main --pipeline "$file" --json \
    --store "$SCRATCH/store" --cache "$SCRATCH/cache" --stall-after "$stall_after")" || status=$?
  if ! jq -e '.pipelines[0].outcome == "ran"' >/dev/null 2>&1 <<<"$out"; then
    if ((status > 128)); then
      echo "error: iwci was killed by signal $((status - 128)) before reporting" >&2
    else
      echo "error: the pipeline did not run (iwci exited $status):" >&2
    fi
    printf '%s\n' "$out" >&2
    failed=1
    continue
  fi
  # One line per job: its id, the status it had, and the status it needed.
  while IFS=$'\t' read -r id status want reason; do
    reason_wanted="$(want_reason "$name/$id")"
    if [[ "$status" == "$want" && "$reason" == *"$reason_wanted"* ]]; then
      echo "  ok   $id: $status${reason:+ ($reason)}"
    elif [[ "$status" == "$want" ]]; then
      echo "  FAIL $id: $status as expected, but because \"$reason\", not \"$reason_wanted\""
      failed=1
    else
      echo "  FAIL $id: $status, expected $want ($reason)"
      failed=1
    fi
  done < <(jq -r '.pipelines[0].report.jobs[]
      | [.id, .status,
         (if (.id | endswith("-passes")) then "passed" else "failed" end),
         (.reason // .message // "")]
      | @tsv' <<<"$out")
  # What some jobs' logs must say.
  while read -r id; do
    stderr_wanted="$(want_stderr "$name/$id")"
    [[ -n "$stderr_wanted" ]] || continue
    if ! jq -r --arg id "$id" \
      '.pipelines[0].report.jobs[] | select(.id == $id) | .execution.stderr // ""' <<<"$out" |
      tr '\n' ' ' | grep -Eq "$stderr_wanted"; then
      echo "  FAIL $id: its stderr does not match \"$stderr_wanted\""
      failed=1
    fi
  done < <(jq -r '.pipelines[0].report.jobs[].id' <<<"$out")
  if grep -q "$IWCI_SECRET_FIXTURE_TOKEN" <<<"$out"; then
    echo "  FAIL the secret's value appears in the report"
    failed=1
  fi
  if [[ "$failed" == 1 ]]; then
    # The whole report, for the tool's own output.
    jq '.pipelines[0].report.jobs[] | {id, status, reason, message, execution}' <<<"$out" >&2
  fi
done
exit "$failed"
