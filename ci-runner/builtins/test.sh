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
# needs one built with `--features node`). SKIP_BUILD=1 publishes what is
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
        bash "$here/environments/build.sh"
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
      out="$(node /tmp/wasi.js 2>/dev/null; node /tmp/wasi-named.mjs 2>/dev/null)"
      echo "$out"
      test "$(grep -c '^hi$' <<<"$out")" = 4

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
  # A script that never yields must still be stopped by the job's timeout.
  spin-fails:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 40s
    run: |
      node -e 'for (;;) {}'
YAML
      ;;
  esac
}

# What a `-fails` job's failure reason must contain.
want_reason() {
  case "$1" in
    gofmt/dirty-fails | oxfmt/dirty-fails) echo "changed 1 file" ;;
    typescript/type-error-fails) echo "exited with 2" ;;
    bash/false-fails | bash-node/throw-fails | tools/gofmt-finds-dirty-fails) echo "exited with 1" ;;
    bash-node/spin-fails) echo "timed out" ;;
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
  out="$("$IWCI" run --repo "$repo" --branch main --pipeline "$file" --json \
    --store "$SCRATCH/store" --cache "$SCRATCH/cache")" || status=$?
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
