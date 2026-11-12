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
#   builtins/test.sh typescript oxfmt bash-node python php
#   builtins/test.sh go              every Go minor; go@1.25 for one
#   builtins/test.sh python postgres
#
# `tools` runs gofmt from a bash script (`tools:`), so it needs gofmt and
# bash earlier in the same list. `postgres` runs PostgreSQL as a service
# (`services:`) for Python jobs, so it needs python in the same list.
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
# already in dist/ instead of building. python, php and go need the internet:
# python and php install packages (from PyPI and Wasmer's wheel index, and
# from Packagist, in jobs and through `deps:`), and go fetches its fixture's
# module and an HTTPS page. Needs: git, jq, and
# whatever the named build scripts need.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

IWCI="${IWCI:-$here/../target/debug/iwci}"
if [[ $# -eq 0 ]]; then
  set -- gofmt bash tools
fi

# A secret the bash pipeline reads, which must never show up in a report.
export IWCI_SECRET_FIXTURE_TOKEN="fixture-secret-value-0451"

# `go` is every Go minor the environments build.
names=()
for name in "$@"; do
  if [[ "$name" == go ]]; then
    read -ra minors <<<"$(sed -n 's/^GO_MINORS=(\(.*\))$/\1/p' "$here/environments/build.sh")"
    for minor in "${minors[@]}"; do
      names+=("go@$minor")
    done
  else
    names+=("$name")
  fi
done
set -- "${names[@]}"

# Build each requested builtin once, then publish everything it produced.
built_envs=false
for name in "$@"; do
  case "$name" in
    gofmt | oxfmt | typescript)
      [[ "${SKIP_BUILD:-}" == 1 ]] || bash "$here/$name/build.sh"
      dirs=("$dist"/builtin/"$name"/*)
      ;;
    bash | bash-node | python | php | go@* | postgres)
      if [[ "${SKIP_BUILD:-}" != 1 && "$built_envs" == false ]]; then
        envs=()
        for env in "$@"; do
          case "$env" in bash | bash-node | python | php | go@* | postgres) envs+=("$env") ;; esac
        done
        bash "$here/environments/build.sh" "${envs[@]}"
        built_envs=true
      fi
      if [[ "$name" == go@* ]]; then
        dirs=("$dist"/environment/go/"${name#go@}".*)
      else
        dirs=("$dist"/environment/"$name"/*)
      fi
      ;;
    tools)
      # Uses what gofmt and bash published.
      continue
      ;;
    *)
      echo "error: no test for \`$name\`; know gofmt, oxfmt, typescript, bash, bash-node, python, php, go (or go@<minor>), postgres, tools" >&2
      exit 2
      ;;
  esac
  "$IWCI" publish "${dirs[@]}" --store "$SCRATCH/store" --cache "$SCRATCH/cache"
done

# The fixture repository: one directory per tool, each with something that
# passes and something that must fail.
repo="$SCRATCH/repo"
mkdir -p "$repo"/go/{clean,dirty} "$repo"/ts/{ok,bad} "$repo"/js/{clean,dirty} "$repo"/py/{ok,bad}
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
for dir in ok bad; do
  printf 'def add(a, b):\n    return a + b\n' >"$repo/py/$dir/calc.py"
done
printf 'from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n' >"$repo/py/ok/test_calc.py"
printf 'from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 6\n' >"$repo/py/bad/test_calc.py"
# A repository's own addopts, which the environment's must not replace.
printf '[pytest]\naddopts = -ra\n' >"$repo/py/ok/pytest.ini"
# A Composer project with a dependency it uses, tested by PHPUnit; the bad
# one expects the wrong greeting. No lock file: each PHP version resolves
# the PHPUnit it supports.
for dir in ok bad; do
  mkdir -p "$repo/php/$dir/src" "$repo/php/$dir/tests"
  cat >"$repo/php/$dir/composer.json" <<'JSON'
{
  "require": { "monolog/monolog": "^3.0" },
  "require-dev": { "phpunit/phpunit": "^10.5 || ^11.5 || ^12.0" },
  "autoload": { "psr-4": { "App\\": "src/" } },
  "scripts": { "test": "phpunit" }
}
JSON
  cat >"$repo/php/$dir/phpunit.xml" <<'XML'
<?xml version="1.0"?>
<phpunit bootstrap="vendor/autoload.php">
  <testsuites><testsuite name="app"><directory>tests</directory></testsuite></testsuites>
</phpunit>
XML
  cat >"$repo/php/$dir/src/Greeter.php" <<'PHP'
<?php
namespace App;

use Monolog\Logger;

final class Greeter
{
    public function __construct(private Logger $log) {}

    public function greet(string $name): string
    {
        $this->log->info('greeting', ['name' => $name]);
        return "Hello, $name";
    }
}
PHP
done
for want in "ok:Hello, Ada" "bad:Goodbye, Ada"; do
  cat >"$repo/php/${want%%:*}/tests/GreeterTest.php" <<PHP
<?php
use App\\Greeter;
use Monolog\\Handler\\TestHandler;
use Monolog\\Logger;
use PHPUnit\\Framework\\TestCase;

final class GreeterTest extends TestCase
{
    public function testGreets(): void
    {
        \$log = new TestHandler();
        \$this->assertSame('${want#*:}', (new Greeter(new Logger('t', [\$log])))->greet('Ada'));
        \$this->assertTrue(\$log->hasInfoThatContains('greeting'));
    }
}
PHP
done
# A Go module with a dependency, which the Go installer puts in the module
# cache before the job, and tests that need what a WASIX toolchain has to
# get right: children's exit statuses and working directories, sockets that
# close promptly, and names that resolve.
mkdir -p "$repo"/gomod/{testdata,sub/testdata,cmd/fetch}
cat >"$repo/gomod/go.mod" <<'EOF'
module example.com/iwci

go 1.23

require github.com/google/uuid v1.6.0
EOF
cat >"$repo/gomod/go.sum" <<'EOF'
github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=
github.com/google/uuid v1.6.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=
EOF
cat >"$repo/gomod/main.go" <<'EOF'
package main

import (
	"fmt"

	"github.com/google/uuid"
)

func main() {
	fmt.Println(len(uuid.NewString()))
}
EOF
cat >"$repo/gomod/main_test.go" <<'EOF'
package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestUUID(t *testing.T) {
	if _, err := uuid.Parse(uuid.NewString()); err != nil {
		t.Fatal(err)
	}
}

// A test runs in its package's directory.
func TestTestdata(t *testing.T) {
	b, err := os.ReadFile("testdata/hello.txt")
	if err != nil || string(b) != "root\n" {
		t.Fatalf("%q, %v", b, err)
	}
}

// A child's output, its exit status and its working directory.
func TestExec(t *testing.T) {
	out, err := exec.Command("bash", "-c", "echo hi").Output()
	if err != nil || string(out) != "hi\n" {
		t.Fatalf("output %q, %v", out, err)
	}
	var exit *exec.ExitError
	if err := exec.Command("bash", "-c", "exit 3").Run(); !errors.As(err, &exit) || exit.ExitCode() != 3 {
		t.Fatalf("exit status: %v", err)
	}
	cmd := exec.Command("bash", "-c", "pwd")
	cmd.Dir = "/tmp"
	if out, err := cmd.Output(); err != nil || string(out) != "/tmp\n" {
		t.Fatalf("Dir: %q, %v", out, err)
	}
	// An argument and a variable with line feeds in them arrive whole.
	cmd = exec.Command("bash", "-c", "printf '%s|%s' \"$1\" \"$MULTI\"", "bash", "a\nb")
	cmd.Env = append(os.Environ(), "MULTI=c\nd")
	if out, err := cmd.Output(); err != nil || string(out) != "a\nb|c\nd" {
		t.Fatalf("line feeds: %q, %v", out, err)
	}
}

// A round trip to a server on the job's loopback, and both ends closed:
// closing used to wait out a 30 second timeout in the host, twice.
func TestHTTPTest(t *testing.T) {
	start := time.Now()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "pong")
	}))
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	srv.Close()
	if string(body) != "pong" {
		t.Fatalf("body %q", body)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("took %v", d)
	}
	t.Logf("took %v", time.Since(start))
}

// A duplicate descriptor writes to the same file.
func TestDup(t *testing.T) {
	f, err := os.CreateTemp("", "dup")
	if err != nil {
		t.Fatal(err)
	}
	fd, err := syscall.Dup(int(f.Fd()))
	if err != nil || fd == int(f.Fd()) {
		t.Fatalf("Dup: %d, %v", fd, err)
	}
	os.NewFile(uintptr(fd), "dup").WriteString("dup")
	if b, _ := os.ReadFile(f.Name()); string(b) != "dup" {
		t.Fatalf("read %q", b)
	}
}

func TestFail(t *testing.T) {
	if os.Getenv("GO_FIXTURE_FAIL") != "" {
		t.Fatal(strings.Repeat("expected ", 2))
	}
}
EOF
printf 'root\n' >"$repo/gomod/testdata/hello.txt"
printf 'sub\n' >"$repo/gomod/sub/testdata/hello.txt"
printf 'package sub\n\nfunc Name() string { return "sub" }\n' >"$repo/gomod/sub/sub.go"
cat >"$repo/gomod/sub/sub_test.go" <<'EOF'
package sub

import (
	"os"
	"testing"
)

func TestTestdata(t *testing.T) {
	if b, err := os.ReadFile("testdata/hello.txt"); err != nil || string(b) != "sub\n" {
		t.Fatalf("%q, %v", b, err)
	}
}
EOF
cat >"$repo/gomod/cmd/fetch/main.go" <<'EOF'
// Fetches a URL and prints the status: a name resolved, a connection out
// of the job, and a certificate checked.
package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	resp, err := http.Get(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	resp.Body.Close()
	fmt.Println(resp.Status)
}
EOF
# A Python project installed by `deps: [pip]`: requests and what it needs
# from PyPI, and numpy as Wasmer's WASIX wheel, in pip-compile's format
# with the WASIX wheel's hash beside PyPI's sdist (README, "WASIX wheels in
# a lock"): the installer must pass over the sdist, and colorama is for
# Windows only, so it must not be installed.
mkdir -p "$repo/py/locked"
cat >"$repo/py/locked/requirements.txt" <<'TXT'
--extra-index-url https://python-registry.wasix.org/simple/

certifi==2026.10.23 \
    --hash=sha256:e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1
    # via requests
charset-normalizer==3.5.2 \
    --hash=sha256:b6b751274acb69d77b3323d6b7dbaa3c7fdfc1eb829b7eb61d262f32e1af9685
    # via requests
colorama==0.4.6 ; sys_platform == "win32" \
    --hash=sha256:4f1d9991f5acc0ca119f9d443620b77f9d6b33703e51011c16baf57afb285fc6
idna==3.20 \
    --hash=sha256:ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c
    # via requests
numpy==2.5.1 \
    --hash=sha256:84c967049bdf089778addfdda3d4b8b1b69d620be8477f66eebbfe5b65728ab4 \
    --hash=sha256:a48a113e6afea91f5608793bafa7ef2ad481fefbda87ec5069f483de61cb9fa3
requests==2.34.2 \
    --hash=sha256:2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0
urllib3==2.8.0 \
    --hash=sha256:0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3
    # via requests
TXT
# The same Composer project installed by `deps: [composer]`. Its
# composer.lock is resolved just before the pipelines run (below), so it
# follows Packagist as the other PHP jobs do; bad/ expects the wrong
# greeting.
mkdir -p "$repo/php/locked/bad"
cp -R "$repo/php/ok/." "$repo/php/locked/"
cp "$repo/php/bad/tests/GreeterTest.php" "$repo/php/locked/bad/"
printf 'fixture line\n' >"$repo/data.txt"
printf '#!/bin/sh\necho run\n' >"$repo/run.sh"
chmod +x "$repo/run.sh"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name=iwci -c user.email=ci@example.com commit -qm fixture

# php/locked's composer.lock, resolved by Composer in env:php without
# installing anything, and committed for the installer to read.
for name in "$@"; do
  [[ "$name" == php ]] || continue
  cat >"$SCRATCH/php-lock.yml" <<'YAML'
name: php-lock
jobs:
  lock:
    using: env:php@8.4
    cwd: /app/php/locked
    timeout: 10m
    run: |
      composer update --no-install --no-progress --quiet
      cat composer.lock
YAML
  out="$("$IWCI" run --repo "$repo" --branch main --pipeline "$SCRATCH/php-lock.yml" --json \
    --store "$SCRATCH/store" --cache "$SCRATCH/cache")" || true
  if ! jq -r '.pipelines[0].report.jobs[0].execution.stdout // ""' <<<"$out" |
    jq -e '.packages | length > 0' >/dev/null 2>&1; then
    echo "error: could not resolve php/locked/composer.lock:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  jq -r '.pipelines[0].report.jobs[0].execution.stdout' <<<"$out" >"$repo/php/locked/composer.lock"
  git -C "$repo" add -A
  git -C "$repo" -c user.name=iwci -c user.email=ci@example.com commit -qm "composer.lock"
done

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
  # Waiting for a background service's log line, and for one that never
  # comes: the helper says what it waited for and shows the file's end.
  wait-for-log-passes:
    using: env:bash@5
    run: |
      (sleep 1; echo starting; sleep 1; echo "server ready on 5432") > svc.log &
      wait-for-log svc.log 'ready on [0-9]+$' --timeout 30s
      grep -q 'ready on 5432' svc.log
      wait
  wait-for-log-timeout-fails:
    using: env:bash@5
    run: |
      echo starting > svc.log
      wait-for-log svc.log ready --timeout 1s
  wait-for-port-timeout-fails:
    using: env:bash@5
    run: wait-for-port 5999 --timeout 1s
  # Nothing in a job is a terminal (#1008): its stdin is empty, its output
  # goes to the log, and a pipe, a file or /dev/null in their place is not
  # one either. Every descriptor used to say it was.
  no-terminal-passes:
    using: env:bash@5
    run: |
      test ! -t 0 && test ! -t 1 && test ! -t 2
      test "$(echo x | bash -c 'test -t 0 && echo tty || echo no')" = no
      test "$(bash -c 'test -t 0 && echo tty || echo no' < /dev/null)" = no
      test "$(bash -c 'test -t 1 && echo tty || echo no')" = no
      bash -c 'test -t 1 && echo tty || echo no' > /tmp/t
      test "$(cat /tmp/t)" = no
  # A script can put its own descriptors on 3 and 4 (#1019), which were
  # the runtime's preopens and refused with "Not supported" (5 and up
  # worked), and paths and the programs it starts keep working, whether
  # they are still there or closed again.
  low-fds-passes:
    using: env:bash@5
    run: |
      exec 3>&1
      echo three >&3
      exec 4>&1
      echo four >&4
      test "$(cat data.txt)" = "fixture line"
      test "$(bash -c 'echo child >&4' 4>&1)" = child
      echo covered > c.txt
      read -r line < c.txt
      test "$line" = covered
      exec 3>&- 4>&-
      printf 'one\ntwo\n' > lines
      exec 3< lines
      read -r a <&3
      exec 4< lines
      read -r b <&4
      read -r c <&3
      test "$a $b $c" = "one one two"
      exec 3<&- 4<&-
      exec 5>&1
      test "$(cat lines | wc -l)" = 2
      ls / > /dev/null
  # A command sed's `e` runs reaches the shell whole (#1022): sed's
  # posix_spawn joined `sh -c`'s arguments with line feeds and WASIX split
  # them there again, so this ran `printf "%s|" "a` and printed nothing.
  sed-e-passes:
    using: env:bash@5
    run: |
      printf '%s\n' 'printf "%s|" "a' 'b"' > cmd.txt
      test "$(sed 'N;s/^//e' cmd.txt)" = "$(printf 'a\nb|')"
      printf '%s\n' 'echo first' 'echo second' > two.txt
      test "$(sed 'N;s/^//e' two.txt)" = "$(printf 'first\nsecond')"
      test "$(echo 'echo one' | sed 's/^//e')" = one
      test "$(echo x | sed '1e echo before')" = "$(printf 'before\nx')"
  # An argument with a line feed in it reaches the program whole (#1003):
  # bash's exec joined the arguments with line feeds and WASIX split them
  # there again, so this printed `a|b|c|`. Through a second bash, through
  # coreutils' `env` (bash's exec, then env's spawn) and through `exec`.
  newline-args-passes:
    using: env:bash@5
    run: |
      test "$(bash -c 'printf "%s|" "$@"' _ "a
      b" c)" = "$(printf 'a\nb|c|')"
      test "$(env printf '%s|' "p
      q" r)" = "$(printf 'p\nq|r|')"
      test "$(exec printf '%s|' "x
      " "")" = "$(printf 'x\n||')"
      test "$(bash -c 'echo "$1"
      echo two' _ one)" = "$(printf 'one\ntwo')"
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
  # A small Node HTTP server as a service: started before the job, ready
  # once it listens, reached by its name, and stopped after the job.
  node-service-passes:
    using: env:bash-node@24
    timeout: 3m
    services:
      api:
        using: env:bash-node@24
        env: { WHO: api }
        run: |
          node -e '
          require("http")
            .createServer((req, res) => res.end("hello from " + process.env.WHO))
            .listen(3000, "127.0.0.1", () => console.log("api listening on 3000"));
          '
        ready: { port: 3000 }
    run: |
      test "$(node -e 'fetch("http://api:3000/").then(r => r.text()).then(t => console.log(t))')" = "hello from api"
      test "$(cat /proc/iwci/tcp/127.0.0.1:3000)" = listening
  node-service-log-passes:
    using: env:bash-node@24
    timeout: 3m
    services:
      api:
        using: env:bash-node@24
        run: node -e 'require("http").createServer((q, r) => r.end("ok")).listen(3001, () => console.log("ready on 3001"))'
        ready: { log: "^ready on 3001$" }
    run: test "$(node -e 'fetch("http://localhost:3001/").then(r => r.text()).then(console.log)')" = ok
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
  # A closed listener frees its port (#1009): a server stopped and started
  # again on one port in one `node`, and in a second `node` once the
  # first has exited. The port used to stay taken until the job ended.
  rebind-passes:
    using: env:bash-node@24
    run: |
      cat > /tmp/serve.js <<'JS'
      const net = require("node:net");
      const listen = () => new Promise((ok, no) => {
        const s = net.createServer((c) => c.end("hi")).on("error", no);
        s.listen(5555, "127.0.0.1", () => ok(s));
      });
      const ask = () => new Promise((ok, no) => {
        let got = "";
        net.connect(5555, "127.0.0.1").on("data", (d) => (got += d)).on("end", () => ok(got)).on("error", no);
      });
      (async () => {
        for (let i = 0; i < 3; i++) {
          const s = await listen();
          if ((await ask()) !== "hi") throw new Error("no answer");
          await new Promise((ok) => s.close(ok));
        }
        console.log("rebound");
      })().catch((e) => { console.error(e); process.exit(1); });
      JS
      test "$(node /tmp/serve.js)" = rebound
      test "$(node /tmp/serve.js)" = rebound
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
  # A hung `node` whose event loop still wakes: a timer every 50 ms, which
  # costs a guest about 5 ms of CPU a second. That is not work, and it once
  # kept a hung Vitest from ever being stopped (#986).
  idle-timer-fails:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 3m
    run: |
      echo waiting
      node -e 'setInterval(() => {}, 50)'
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
  # A multi-line `node -e` runs every line, and an argument with a line
  # feed in it reaches the program whole, from bash and from Node (#1003):
  # `node -e` ran only its first line, the rest becoming arguments.
  newline-args-passes:
    using: env:bash-node@24
    run: |
      test "$(node -e 'const a = 6
      const b = 7
      console.log(a * b)')" = 42
      test "$(node -p 'JSON.stringify(process.argv.slice(1))' 'a
      b' c)" = '["a\nb","c"]'
      test "$(node -e 'process.stdout.write(require("child_process").execFileSync("bash", ["-c", "printf \"%s|\" \"$@\"", "_", "x\ny", "z"]))')" = "$(printf 'x\ny|z|')"
  # A server started in the background, waited for, then used. It counts
  # its connections and answers with the count, so the client being its
  # first proves wait-for-port never connected: pglite, which serves one
  # client and exits, would have been gone.
  wait-for-port-passes:
    using: env:bash-node@24
    timeout: 3m
    run: |
      cat > /tmp/server.js <<'JS'
      let n = 0;
      setTimeout(() => {
        require("node:net").createServer((s) => s.end(`connection ${++n}\n`)).listen(7000, "127.0.0.1");
      }, 1000);
      JS
      # WASIX bash has no job specs (`%1`), so the pid.
      node /tmp/server.js &
      server=$!
      wait-for-port 7000 --timeout 60s
      got="$(node -e 'require("node:net").connect(7000, "127.0.0.1").on("data", (d) => process.stdout.write(d))')"
      kill "$server"
      test "$got" = "connection 1"
  # An interpreter that is not there is ENOENT, as on Linux.
  shebang-missing-interpreter-fails:
    using: env:bash-node@24
    run: |
      printf '#!/bin/no-such-interpreter\necho ran\n' > s
      node -e 'try { require("child_process").execFileSync("./s") } catch (e) { console.error(e.code); process.exit(e.code === "ENOENT" ? 1 : 2) }'
  # No descriptor is a terminal (#1008), and Node still reads and writes
  # each kind it gets instead: the job's stdin and log, pipes in both
  # directions, a file, and a child's inherited and piped output.
  no-terminal-passes:
    using: env:bash-node@24
    run: |
      node -e 'process.exit(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY ? 1 : 0)'
      test "$(node -p 'require("tty").isatty(0) || require("tty").isatty(1)')" = false
      test "$(node -e 'console.log("piped")' | cat)" = piped
      test "$(node -e 'console.error("to stderr")' 2>&1 | cat)" = "to stderr"
      test "$(echo in | node -e 'process.stdin.pipe(process.stdout)')" = in
      test "$(node -e 'process.stdin.on("data", () => {}).on("end", () => console.log("ended"))')" = ended
      node -e 'console.log("to a file")' > /tmp/out
      test "$(cat /tmp/out)" = "to a file"
      test "$(node -e 'process.stdout.write(require("child_process").execSync("echo child"))')" = child
      test "$(node -e 'require("child_process").spawn(process.execPath, ["-e", "console.log(process.stdout.isTTY)"], { stdio: "inherit" })')" = undefined
      test "$(node -e 'require("child_process").spawn(process.execPath, ["-e", "console.log(1 + 1)"]).stdout.pipe(process.stdout)')" = 2
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
  # bridge now parks that thread and ends only this job. Its isolate can
  # also be torn down first, now with room to finish collecting (#1021),
  # so that note is not required.
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
  # Worker threads that outgrow the job's memory together with their
  # parent. The runner stops the job and each thread disposes its isolate
  # at the heap limit, mid-marking, and V8 finishes the marking first with a
  # full collection, which reached that limit in an isolate being disposed
  # and aborted the runner (#1021). A race, so a smoke check.
  workers-heap-fails:
    using: env:bash-node@24
    memory: 1GiB
    timeout: 3m
    run: |
      cat > /tmp/wh.js <<'JS'
      const { Worker } = require("node:worker_threads");
      const src = "const a = []; for (;;) a.push({ x: Math.random(), s: 'w' + a.length })";
      for (let i = 0; i < 4; i++) new Worker(src, { eval: true }).on("error", () => {});
      const a = []; for (;;) a.push({ y: Math.random() });
      JS
      node /tmp/wh.js
YAML
      ;;
    go@*)
      # The same jobs for every minor; `go` lines say which.
      sed "s/@MINOR@/${1#go@}/g" <<'YAML'
name: go-@MINOR@
workspace:
  deps:
    - go: { dir: gomod }
jobs:
  toolchain-passes:
    using: env:go@@MINOR@
    run: |
      go version
      go version | grep -q '^go version go@MINOR@\.[0-9]* wasip1/wasm$'
      test "$(go env GOROOT)" = /go
      test "$(gofmt -l go)" = go/dirty/main.go
  # The module's dependency comes from the installer's module cache, and
  # the standard library from the environment's build cache: the first
  # build compiles two packages, uuid and main, not `runtime` and the rest.
  build-passes:
    using: env:go@@MINOR@
    cwd: /app/gomod
    timeout: 10m
    run: |
      go build -x -o /tmp/app . 2> /tmp/build.log
      test "$(/tmp/app)" = 36
      grep -c '/compile -o' /tmp/build.log
      test "$(grep -c '/compile -o' /tmp/build.log)" = 2
      # Linux binaries cross-compile, as anywhere.
      GOOS=linux GOARCH=amd64 go build -o /tmp/app-linux .
      head -c 4 /tmp/app-linux | grep -q ELF
  test-passes:
    using: env:go@@MINOR@
    cwd: /app/gomod
    timeout: 10m
    run: go test -v ./...
  test-fails:
    using: env:go@@MINOR@
    cwd: /app/gomod
    timeout: 10m
    env:
      GO_FIXTURE_FAIL: "1"
    run: go test -run TestFail .
  vet-passes:
    using: env:go@@MINOR@
    cwd: /app/gomod
    timeout: 10m
    run: go vet ./...
  vet-fails:
    using: env:go@@MINOR@
    cwd: /app/gomod
    timeout: 10m
    run: |
      printf 'package main\n\nimport "fmt"\n\nfunc bad() { fmt.Printf("%%d\\n", "x") }\n' > bad.go
      go vet .
  build-error-fails:
    using: env:go@@MINOR@
    cwd: /app/gomod
    timeout: 10m
    run: |
      printf 'package main\n\nfunc broken( {\n' > broken.go
      go build .
  # DNS through the runner, a connection to the internet and a certificate
  # checked against the environment's CA bundle.
  https-passes:
    using: env:go@@MINOR@
    cwd: /app/gomod
    timeout: 10m
    run: test "$(go run ./cmd/fetch https://proxy.golang.org/)" = "200 OK"
YAML
      ;;
    python)
      cat <<'YAML'
name: python
jobs:
  python-passes:
    using: env:python@3.13
    run: |
      test "$(python --version)" = "Python 3.13.15"
      test "$(python3 -c 'import sys; print(sys.version_info[:2])')" = "(3, 13)"
      python -c 'import json, sqlite3, ssl, zlib; print(ssl.OPENSSL_VERSION)'
  # A pure Python package and its dependencies from PyPI.
  pip-passes:
    using: env:python@3.13
    timeout: 10m
    run: |
      pip install requests
      python -c 'import requests; print(requests.__version__)'
  # A compiled extension: a `wasix_wasm32` wheel from Wasmer's index, which
  # pip only picks with the environment's defaults (build.sh).
  wheel-passes:
    using: env:python@3.13
    timeout: 10m
    run: |
      pip install numpy
      pip show numpy | grep -q '^Version: .*+wasix'
      test "$(python -c 'import numpy; print(int(numpy.arange(5).sum()))')" = 10
  # pytest's console script on PATH, with the repository's own addopts
  # (`-ra`) kept beside the environment's.
  pytest-passes:
    using: env:python@3.13
    cwd: /app/py/ok
    timeout: 10m
    run: |
      pip install pytest
      pytest
  pytest-fails:
    using: env:python@3.13
    cwd: /app/py/bad
    timeout: 10m
    run: |
      pip install pytest
      pytest
  raise-fails:
    using: env:python@3.13
    run: python -c 'raise SystemExit("expected")'
  # Python's own HTTP server in the background, found by its port and by
  # its log line, then asked for a file.
  wait-for-service-passes:
    using: env:python@3.13
    timeout: 3m
    run: |
      python -u -m http.server 8000 --bind 127.0.0.1 > http.log 2>&1 &
      server=$!
      wait-for-port 8000 --host localhost --timeout 60s
      wait-for-log http.log 'Serving HTTP on' --timeout 10s
      test "$(python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/data.txt").read().decode().strip())')" = "fixture line"
      kill "$server"
  # A hashed requirements file installed before the job (`deps: [pip]`,
  # #1015): the job has no network, so everything it imports came through
  # the verifying installer, numpy as Wasmer's WASIX wheel, into the user
  # site, with charset-normalizer's console script on PATH.
  pip-deps-passes:
    using: env:python@3.13
    deps: [{ pip: { dir: py/locked } }]
    network: false
    timeout: 5m
    run: |
      test "$(python -c 'import numpy; print(int(numpy.arange(5).sum()))')" = 10
      python -c 'import numpy, site, sys; assert numpy.__file__.startswith(site.getusersitepackages()), numpy.__file__'
      python -c 'import requests; print(requests.__version__)'
      pip show numpy | grep -q '^Version: 2.5.1+wasix'
      test -z "$(pip show colorama 2>/dev/null)"
      normalizer --version
  pip-deps-fails:
    using: env:python@3.13
    deps: [{ pip: { dir: py/locked } }]
    network: false
    timeout: 5m
    run: python -c 'import numpy; assert int(numpy.arange(5).sum()) == 11'
  # A script on stdin runs as a script (#1008): Python took the pipe for a
  # terminal, printed its prompts and read a block line by line.
  stdin-script-passes:
    using: env:python@3.13
    run: |
      test "$(echo 'print(1 + 1)' | python)" = 2
      python - > /tmp/out <<'PY'
      def double(x):
          return x * 2
      print(double(21))
      PY
      test "$(cat /tmp/out)" = 42
      test "$(python -c 'import os; print(os.isatty(0), os.isatty(1))' < /dev/null)" = "False False"
  # A multi-line `python -c` runs every line, and an argument with a line
  # feed in it reaches a subprocess whole (#1003).
  newline-args-passes:
    using: env:python@3.13
    run: |
      test "$(python -c 'a = 6
      b = 7
      print(a * b)')" = 42
      test "$(python -c 'import subprocess, sys; sys.stdout.write(subprocess.run(["printf", "%s|", "x\ny", "z"], capture_output=True, text=True).stdout)')" = "$(printf 'x\ny|z|')"
YAML
      ;;
    postgres)
      cat <<'YAML'
name: postgres
workspace:
  services:
    postgres:
      using: env:postgres@18
      run: pglite
      ready: { port: 5432 }
jobs:
  # PostgreSQL as a service of a Python job, queried with psycopg (a
  # `wasix_wasm32` wheel of psycopg-binary from Wasmer's index). pglite
  # serves one connection, so the job uses one. The port check never
  # connects, so it does not use it up.
  psycopg-passes:
    using: env:python@3.13
    timeout: 10m
    run: |
      pip install 'psycopg[binary]'
      python - <<'PY'
      import psycopg
      with psycopg.connect("host=postgres port=5432 user=postgres dbname=postgres") as conn:
          version = conn.execute("select version()").fetchone()[0]
          print(version)
          assert version.startswith("PostgreSQL 18"), version
          conn.execute("create table t (n int)")
          conn.execute("insert into t select generate_series(1, 1000)")
          assert conn.execute("select sum(n) from t").fetchone()[0] == 500500
      PY
  # Ready by its log line, with a secret in its environment that its log
  # prints: masked like the job's own output (the report is checked for it
  # below).
  log-ready-passes:
    using: env:python@3.13
    timeout: 10m
    services:
      postgres:
        using: env:postgres@18
        env: { TOKEN: "${{ secrets.FIXTURE_TOKEN }}" }
        run: |
          echo "starting with $TOKEN"
          exec pglite
        ready: { log: "OLIPHAUNT_WASIX_SOCKET_READY 5432" }
    run: |
      test "$(cat /proc/iwci/tcp/127.0.0.1:5432)" = listening
      test -z "${TOKEN:-}"
  # Not ready in time, and gone before it was ready: the job never runs,
  # and the reason names the service.
  not-ready-fails:
    using: env:python@3.13
    services:
      postgres:
        using: env:postgres@18
        run: exec sleep 300
        ready: { port: 5432, timeout: 2s }
    run: touch ran
  exits-early-fails:
    using: env:python@3.13
    services:
      postgres:
        using: env:postgres@18
        run: echo bye; exit 3
        ready: { command: "test -e /tmp/never" }
    run: touch ran
  # A service still running when the job ends is stopped, and the job
  # passes; one that takes no service at all starts none.
  no-services-passes:
    using: env:python@3.13
    services: false
    run: test "$(ls /proc/iwci/tcp)" = ""
YAML
      ;;
    php)
      cat <<'YAML'
name: php
jobs:
  # Each version: Composer installs a project and PHPUnit passes its test.
  php81-passes:
    using: env:php@8.1
    cwd: /app/php/ok
    timeout: 10m
    run: |
      test "$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')" = 8.1
      composer install
      vendor/bin/phpunit
  php82-passes:
    using: env:php@8.2
    cwd: /app/php/ok
    timeout: 10m
    run: |
      test "$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')" = 8.2
      composer install
      vendor/bin/phpunit
  php83-passes:
    using: env:php@8.3
    cwd: /app/php/ok
    timeout: 10m
    run: |
      test "$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')" = 8.3
      composer install
      vendor/bin/phpunit
  php84-passes:
    using: env:php@8.4
    cwd: /app/php/ok
    timeout: 10m
    run: |
      test "$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')" = 8.4
      composer install
      vendor/bin/phpunit
  php85-passes:
    using: env:php@8.5
    cwd: /app/php/ok
    timeout: 10m
    run: |
      test "$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')" = 8.5
      composer install
      vendor/bin/phpunit
  # What env:php's own `php` (environments/php-cli) adds to phpix: a script
  # runs in the caller's directory, not its own; -m and -l; and a `php` that
  # Composer starts (`composer test`, through PHP_BINARY) is that one too.
  php-cli-passes:
    using: env:php@8.5
    cwd: /app/php/ok
    timeout: 10m
    run: |
      mkdir -p sub
      printf '<?php echo getcwd();' > sub/cwd.php
      test "$(php sub/cwd.php)" = "$PWD"
      php -m | grep -qx intl
      test "$(php -l src/Greeter.php)" = "No syntax errors detected in src/Greeter.php"
      composer --version
      composer install
      composer test
  phpunit-fails:
    using: env:php@8.5
    cwd: /app/php/bad
    timeout: 10m
    run: |
      composer install
      vendor/bin/phpunit
  # composer.lock installed before the job (`deps: [composer]`, #1015):
  # each package checked against its dist hash or its git commit, laid out
  # without what its .gitattributes leave out of a dist, with Composer's
  # autoloader and bin proxies, and no network in the job.
  composer-deps-passes:
    using: env:php@8.4
    cwd: /app/php/locked
    deps: [{ composer: { dir: php/locked } }]
    network: false
    timeout: 10m
    run: |
      test -f vendor/phpunit/phpunit/phpunit
      test ! -e vendor/phpunit/phpunit/tests
      php -r 'require "vendor/autoload.php"; echo Composer\InstalledVersions::getPrettyVersion("phpunit/phpunit"), "\n";'
      vendor/bin/phpunit
  composer-deps-fails:
    using: env:php@8.4
    cwd: /app/php/locked
    deps: [{ composer: { dir: php/locked } }]
    network: false
    timeout: 10m
    run: vendor/bin/phpunit bad
  lint-fails:
    using: env:php@8.5
    run: |
      printf '<?php echo (;' > /tmp/bad.php
      php -l /tmp/bad.php
  # A multi-line `php -r` runs every line (#1003): bash starts php-cli's
  # `php`, which starts phpix, and the code used to arrive split.
  newline-args-passes:
    using: env:php@8.5
    run: |
      test "$(php -r '$a = 6;
      $b = 7;
      echo $a * $b;')" = 42
YAML
      ;;
  esac
}

# What a `-fails` job's failure reason must contain.
want_reason() {
  case "$1" in
    gofmt/dirty-fails | oxfmt/dirty-fails) echo "changed 1 file" ;;
    typescript/type-error-fails) echo "exited with 2" ;;
    bash/false-fails | bash/stat-missing-fails | bash/wait-for-log-timeout-fails | bash/wait-for-port-timeout-fails | python/pytest-fails | python/raise-fails | python/pip-deps-fails | php/phpunit-fails | php/composer-deps-fails | bash-node/throw-fails | bash-node/shebang-missing-interpreter-fails | tools/gofmt-finds-dirty-fails) echo "exited with 1" ;;
    php/lint-fails) echo "exited with 255" ;;
    bash-node/spin-fails) echo "timed out" ;;
    go@*/test-fails | go@*/vet-fails | go@*/build-error-fails) echo "exited with 1" ;;
    postgres/not-ready-fails) echo "service \`postgres\` was not ready after 2s: nothing listened on port 5432" ;;
    postgres/exits-early-fails) echo "service \`postgres\` exited with 3 before it was ready" ;;
    bash/signal-fails) echo "exited with 127" ;;
    bash-node/hang-fails) echo "stalled: no output and no CPU use for 15s" ;;
    bash-node/idle-timer-fails) echo "stalled: no output and no CPU use for 15s" ;;
    bash-node/heap-objects-fails | bash-node/workers-refused-fails) echo "ran out of its 512 MiB of memory" ;;
    bash-node/heap-strings-fails | bash-node/workers-heap-fails) echo "ran out of its 1024 MiB of memory" ;;
    *) echo "" ;;
  esac
}

# What a job's stderr must contain, as an extended regular expression.
want_stderr() {
  case "$1" in
    bash/wait-for-log-timeout-fails) echo "wait-for-log: no line of svc.log matched 'ready' within 1s.*its last lines:.*starting" ;;
    bash/wait-for-port-timeout-fails) echo "wait-for-port: nothing listened on 127.0.0.1 port 5999 within 1s" ;;
    postgres/exits-early-fails) echo "\[service postgres\] bye.*iwci: service .postgres. exited with 3 before it was ready" ;;
    postgres/log-ready-passes) echo "\[service postgres\] starting with \*\*\*" ;;
    bash/signal-fails) echo "dying with \\*\\*\\*.*Program recieved fatal signal: Bad system call.*iwci: the job exited with 127 after a signal.*a guest called [a-z_]+\\(.*Sigsys" ;;
    bash-node/heap-objects-fails) echo "iwci: the job ran out of its 512 MiB of memory.*JavaScript heap could not grow" ;;
    bash-node/heap-strings-fails) echo "iwci: the job ran out of its 1024 MiB of memory.*JavaScript heaps? could not grow" ;;
    bash-node/workers-heap-fails) echo "iwci: the job ran out of its 1024 MiB of memory.*JavaScript heaps? could not grow" ;;
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
  # One line per job: its id, the status it had, the status it needed,
  # whether the runner saw it run out of memory, and why it ended.
  while IFS=$'\t' read -r id status want oom reason; do
    reason_wanted="$(want_reason "$name/$id")"
    if [[ "$reason_wanted" == "ran out of its "* ]] &&
      [[ "$status" != "$want" || "$reason" != "$reason_wanted" || "$oom" != true ]]; then
      # A job there to run out of memory fails for that alone: not a
      # timeout, a stall or an exit status that came after it.
      echo "  FAIL $id: $status${reason:+ ($reason)}, out_of_memory $oom; expected failed ($reason_wanted), out_of_memory true"
      failed=1
    elif [[ "$status" == "$want" && "$reason" == *"$reason_wanted"* ]]; then
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
         (.execution.out_of_memory // false | tostring),
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
