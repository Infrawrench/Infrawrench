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
#   builtins/test.sh clickhouse      ClickHouse as a service, from Node
#   builtins/test.sh bash-node-pool  many V8 heaps at once, and large ones
#   builtins/test.sh bash kubectl    kubectl against a fake API server
#   builtins/test.sh bash openssh    ssh, scp and sftp against SSH servers
#   builtins/test.sh aws az gcloud   the cloud CLIs against a fake cloud
#   builtins/test.sh npm-cli         the deployment CLIs against fake APIs
#   builtins/test.sh bash gh         gh and git push against a fake GitHub
#
# `tools` runs gofmt from a bash script (`tools:`), so it needs gofmt and
# bash earlier in the same list. `postgres` runs PostgreSQL as a service
# (`services:`) for Python jobs, so it needs python in the same list.
# `clickhouse` runs ClickHouse as a service (`services:`) and talks to it
# over its HTTP interface from Node, so it needs an iwci built with
# `--features node`, like bash-node.
# `bash-node-pool` runs bash-node's environment in a pipeline of its own,
# so that its runner's V8 holds only its heaps: two dozen `node`s at once,
# one that needs 3 GB after they ended, then two jobs holding 2.4 GB of
# heap each at the same time. It needs an iwci built with `--features
# node`, about 6 GB of memory and 4 minutes.
# `kubectl` runs kubectl from bash scripts against a small API server its
# build makes (`kubectl/fake-apiserver.go`), on the job's loopback, with a
# kubeconfig lent the way the app lends a connection (`IWCI_LENT_FILE`), so
# it needs bash in the same list and Go's archive and modules from the
# internet to build.
# `openssh` runs OpenSSH's clients from bash scripts against small SSH
# servers its build makes (`openssh/sshd-fixture`), on the job's loopback,
# with connections and keys lent the same way, so it needs bash in the
# same list, ssh-keygen on this machine for the fixture's keys, and the
# internet to build (OpenSSH, OpenSSL, the toolchains, Go modules).
# `gh` runs the GitHub CLI and Git from bash scripts against a fake GitHub
# its build makes (`gh/fake-github.go`), on the job's loopback, with a
# token lent the way the app lends one (`github-token:`, `IWCI_LENT_FILE`),
# so it needs bash in the same list and the internet to build (Go's
# archive, gh's source and modules).
#
# `aws`, `az` and `gcloud` run each cloud CLI's environment against a fake
# of the calls they make (`environments/cloud-clis/fake-cloud.py`), a
# service on the job's loopback, in jobs with no network, so no request can
# reach a provider. Each is lent its connection the way the app lends one
# (IWCI_LENT_FILE: what the AWS, GCP and Azure plugins' lendCiCredential
# write), and the lent secrets must come out masked. `az`'s fake serves
# HTTPS with a certificate made here with openssl.
#
# Expectations live in the job names: a job whose key ends in `-passes`
# must pass and one ending in `-fails` must fail, for the reason
# `want_reason` gives (a formatter by changing files, not by exiting with an
# error). A tool that does not resolve or start is an `error`, not a
# failure, so it cannot hide behind an expected failure; a job that must
# not start ends in `-errors`, and its error must contain `want_reason`.
#
# IWCI is the `iwci` binary to use (default: target/debug/iwci; bash-node
# needs one built with `--features node`, and x86_64 Linux to build its
# Edge.js, see environments/edgejs/build.sh). SKIP_BUILD=1 publishes what is
# already in dist/ instead of building. python, php and go need the internet:
# python and php install packages (from PyPI and Wasmer's wheel index, and
# from Packagist, in jobs and through `deps:`), and go fetches its fixture's
# module and an HTTPS page. Needs: git, jq, openssl, and
# whatever the named build scripts need.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

IWCI="${IWCI:-$here/../target/debug/iwci}"
if [[ $# -eq 0 ]]; then
  set -- gofmt bash tools
fi

# A secret the bash pipeline reads, which must never show up in a report.
export IWCI_SECRET_FIXTURE_TOKEN="fixture-secret-value-0451"
# The token of the kubeconfig the kubectl jobs are lent: the fake API
# server wants it, and it must never show up in a report either (the
# kubectl-passes job prints it).
KUBE_FIXTURE_TOKEN="fixture-token"
# What the cloud CLI jobs are lent, which the fake cloud wants and the report
# must never show (cloud_lent, below). The fake reads them as secrets too.
export IWCI_SECRET_AWS_FIXTURE_KEY="ASIAFIXTUREKEY0451"
export IWCI_SECRET_AWS_FIXTURE_TOKEN="fixture-aws-session-0451"
AWS_FIXTURE_SECRET_KEY="fixture-aws-secret-0451"
export IWCI_SECRET_GCP_FIXTURE_TOKEN="ya29.fixture-gcp-token-0451"
export IWCI_SECRET_AZURE_FIXTURE_SECRET="fixture-azure-secret-0451"
# The tokens the npm-cli pipeline's connections lend, which its fake APIs
# want (npm-cli/fake-apis.mjs) and which must never show up in a report.
# Vercel's CLI takes no `-` in a token.
VERCEL_FIXTURE_TOKEN="vercelfixturetoken0451"
CLOUDFLARE_FIXTURE_TOKEN="cloudflare-fixture-token-0451"
NEON_FIXTURE_KEY="neon-fixture-key-0451"
# The token the gh jobs are lent, which the fake GitHub wants (in no real
# token's format), and the Basic credential Git sends with it: neither may
# show up in a report (gh-passes prints both).
GH_FIXTURE_TOKEN="fixture-installation-token-0451"
GH_FIXTURE_BASIC="$(printf 'x-access-token:%s' "$GH_FIXTURE_TOKEN" | base64 | tr -d '\n')"

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
    kubectl)
      [[ "${SKIP_BUILD:-}" == 1 ]] || bash "$here/kubectl/build.sh" 1.37
      dirs=("$dist"/builtin/kubectl/*)
      ;;
    gh)
      [[ "${SKIP_BUILD:-}" == 1 ]] || bash "$here/gh/build.sh" 2.104
      dirs=("$dist"/builtin/gh/*)
      ;;
    openssh)
      [[ "${SKIP_BUILD:-}" == 1 ]] || bash "$here/openssh/build.sh"
      dirs=()
      for program in ssh scp sftp ssh-keygen ssh-keyscan; do
        dirs+=("$dist"/builtin/"$program"/*)
      done
      ;;
    bash | bash-node | python | php | go@* | postgres | clickhouse | aws | az | gcloud)
      if [[ "${SKIP_BUILD:-}" != 1 && "$built_envs" == false ]]; then
        envs=()
        for env in "$@"; do
          case "$env" in bash | bash-node | python | php | go@* | postgres | clickhouse | aws | az | gcloud) envs+=("$env") ;; esac
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
    npm-cli)
      # Node tools: Vercel's, Cloudflare's and Neon's CLIs and Wrangler,
      # from their lockfiles (npm-cli/build.sh). They run on bash-node's
      # environment, and one job checks that bash's refuses them, so both
      # are published here too, built unless they already are.
      [[ "${SKIP_BUILD:-}" == 1 ]] || bash "$here/npm-cli/build.sh"
      for env in bash bash-node; do
        if [[ "${SKIP_BUILD:-}" != 1 ]] && ! compgen -G "$dist/environment/$env/*" >/dev/null; then
          bash "$here/environments/build.sh" "$env"
        fi
      done
      dirs=("$dist"/environment/bash/* "$dist"/environment/bash-node/*)
      for tool in vercel cf neon wrangler; do
        dirs+=("$dist"/builtin/"$tool"/*)
      done
      ;;
    bash-node-pool)
      # Runs on bash-node's environment, built here unless it already is.
      if [[ "${SKIP_BUILD:-}" != 1 ]] && ! compgen -G "$dist/environment/bash-node/*" >/dev/null; then
        bash "$here/environments/build.sh" bash-node
      fi
      dirs=("$dist"/environment/bash-node/*)
      ;;
    *)
      echo "error: no test for \`$name\`; know gofmt, oxfmt, typescript, bash, bash-node, bash-node-pool, python, php, go (or go@<minor>), postgres, clickhouse, tools, kubectl, openssh, aws, az, gcloud, npm-cli, gh" >&2
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
# A local package index for the pip jobs that have no network: one wheel,
# made here with the standard library, with a module, a `__main__` and a
# console script (`iwci-hello`), in a directory pip reads with
# `--no-index --find-links`.
mkdir -p "$repo/py/wheels"
python3 - "$repo/py/wheels" <<'PY'
import base64, hashlib, sys, zipfile
dist, version = "iwci_hello", "1.0"
info = f"{dist}-{version}.dist-info"
files = {
    f"{dist}/__init__.py": 'def main():\n    print("hello from iwci-hello")\n',
    f"{dist}/__main__.py": "from iwci_hello import main\n\nmain()\n",
    f"{info}/METADATA": f"Metadata-Version: 2.1\nName: iwci-hello\nVersion: {version}\n",
    f"{info}/WHEEL": "Wheel-Version: 1.0\nGenerator: iwci-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    f"{info}/entry_points.txt": "[console_scripts]\niwci-hello = iwci_hello:main\n",
}
record = []
with zipfile.ZipFile(f"{sys.argv[1]}/{dist}-{version}-py3-none-any.whl", "w") as whl:
    for name, text in files.items():
        data = text.encode()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{name},sha256={digest},{len(data)}")
        whl.writestr(name, data)
    record.append(f"{info}/RECORD,,")
    whl.writestr(f"{info}/RECORD", "\n".join(record) + "\n")
PY
# A certificate for `localhost` and its key, for the Python job that serves
# HTTPS (`tls-server-passes`). Made here, so no key is checked in.
mkdir -p "$repo/py/tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
  -subj /CN=localhost -addext subjectAltName=DNS:localhost \
  -keyout "$repo/py/tls/key.pem" -out "$repo/py/tls/cert.pem" 2>/dev/null
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
# A committed symlink, for renaming one the job did not make.
ln -s data.txt "$repo/data-link"
# kubectl's API server, from its build.
if [[ -f "$dist/test/kubectl/fake-apiserver.wasm" ]]; then
  mkdir -p "$repo/k8s"
  cp "$dist/test/kubectl/fake-apiserver.wasm" "$repo/k8s/"
fi
# The fake GitHub, from gh's build.
if [[ -f "$dist/test/gh/fake-github.wasm" ]]; then
  mkdir -p "$repo/gh"
  cp "$dist/test/gh/fake-github.wasm" "$repo/gh/"
  # What every gh job does first: the fake on the job's loopback as the
  # HTTPS proxy, and gh and Git trusting the CA it made. Nothing else
  # changes, so they reach "github.com" as they would GitHub.
  cat >"$repo/gh/serve.sh" <<'SH'
serve_github() {
  /app/gh/fake-github.wasm "$@" > /tmp/github.log 2>&1 &
  wait-for-port 8080
  export HTTPS_PROXY=http://127.0.0.1:8080
  export SSL_CERT_FILE=/tmp/fake-github-ca.pem GIT_SSL_CAINFO=/tmp/fake-github-ca.pem
}
SH
fi
# OpenSSH's test server, from its build, and keys made here: host keys of
# three types for three servers, another the wrong server holds, and the
# users' keys it accepts. The users' private halves are lent, never
# committed (openssh_lent, below).
if [[ -f "$dist/test/openssh/sshd-fixture.wasm" ]]; then
  mkdir -p "$repo/ssh" "$SCRATCH/ssh-keys"
  cp "$dist/test/openssh/sshd-fixture.wasm" "$repo/ssh/"
  for key in "host_a ed25519" "host_jump ecdsa" "host_rsa rsa" "host_other ed25519" "deploy ed25519" "deploy_rsa rsa"; do
    read -r file type <<<"$key"
    ssh-keygen -q -t "$type" -N '' -C "$file" -f "$SCRATCH/ssh-keys/$file"
  done
  cp "$SCRATCH"/ssh-keys/host_{a,jump,rsa,other} "$repo/ssh/"
  cat "$SCRATCH/ssh-keys/deploy.pub" "$SCRATCH/ssh-keys/deploy_rsa.pub" >"$repo/ssh/authorized_keys"
  # `serve <name> <port> <host key>`, sourced by the jobs: a server in the
  # background, logging to /tmp/<name>.log, ready once it listens.
  cat >"$repo/ssh/serve.sh" <<'SH'
serve() {
  /app/ssh/sshd-fixture.wasm -listen "127.0.0.1:$2" -host-key "/app/ssh/$3" \
    -authorized /app/ssh/authorized_keys -name "$1" >"/tmp/$1.log" 2>&1 &
  wait-for-port "$2"
}
SH
fi
# The fake APIs the npm CLI builtins deploy to (npm-cli/fake-apis.mjs).
mkdir -p "$repo/npm-cli"
cp "$here/npm-cli/fake-apis.mjs" "$repo/npm-cli/"
# A package registry the Node jobs install from (npm-registry/registry.mjs),
# with a command-line package in two versions.
mkdir -p "$repo/npm"
cp "$here/npm-registry/registry.mjs" "$repo/npm/"
for version in 1.0.0 2.0.0; do
  mkdir -p "$repo/npm/packages/hello-cli/$version/bin"
  printf '{ "name": "hello-cli", "version": "%s", "bin": { "hello": "bin/hello.js" } }\n' "$version" \
    >"$repo/npm/packages/hello-cli/$version/package.json"
  printf '#!/usr/bin/env node\nconsole.log("hello %s " + process.argv.slice(2).join(" "));\n' "$version" \
    >"$repo/npm/packages/hello-cli/$version/bin/hello.js"
done
# The cloud CLIs' fake cloud, and a certificate for its HTTPS half (the
# Azure CLI signs in over HTTPS only) that the az jobs trust.
mkdir -p "$repo/cloud"
cp "$here/environments/cloud-clis/fake-cloud.py" "$repo/cloud/"
for name in "$@"; do
  [[ "$name" == az ]] || continue
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=127.0.0.1 \
    -addext subjectAltName=IP:127.0.0.1 -keyout "$repo/cloud/key.pem" -out "$repo/cloud/cert.pem" 2>/dev/null
done
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
  # A child's exit status reaches its parent whole (#1053): every status
  # from 80 up read as 79, so a script could not tell `git`'s fatal 128
  # from a missing command's 127.
  exit-status-passes:
    using: env:bash@5
    run: |
      got=""
      for c in 1 79 80 126 127 128 200 255; do
        status=0
        bash -c "exit $c" || status=$?
        got="$got $status"
      done
      test "$got" = " 1 79 80 126 127 128 200 255"
      status=0
      git rev-parse --verify no-such-ref 2>/dev/null || status=$?
      test "$status" = 128
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
  # Renaming what the checkout holds (#985): a job that had not written a
  # file yet could not rename it ("mv: No such file or directory"). Into
  # another checked-out directory, keeping its mode, a whole directory, a
  # file of the job's own into a directory only the checkout has, and links.
  rename-passes:
    using: env:bash@5
    run: |
      mv data.txt moved.txt
      test "$(cat moved.txt)" = "fixture line"
      test ! -e data.txt
      mv run.sh go/clean/run.sh
      test "$(stat -c %a go/clean/run.sh)" = 755
      mv go/dirty ts/was-dirty
      test -f ts/was-dirty/main.go
      test ! -e go/dirty
      echo mine > mine.txt
      mv mine.txt js/clean/mine.txt
      test "$(cat js/clean/mine.txt)" = mine
      # A symlink the job made (#1004), to a file and to a directory.
      ln -s moved.txt link && mv link link2
      test "$(cat link2)" = "fixture line" && test ! -L link
      ln -s go dirlink && mv dirlink go-link
      test -f go-link/clean/main.go
      # A link that came with the checkout, and a dangling one (#1005).
      mv data-link moved-link
      test "$(readlink moved-link)" = data.txt && test ! -L data-link
      ln -s nowhere dangling && mv dangling dangling2
      test "$(readlink dangling2)" = nowhere
  # A file has one name (#1052): `link()` fails with EPERM, as on a file
  # system without hard links, and leaves nothing behind. It succeeded with
  # a second name only WASIX's cache knew, after which removing the first
  # name removed nothing. A failed link onto a deleted checkout file leaves
  # it deleted.
  links-passes:
    using: env:bash@5
    run: |
      echo hi > f
      if ln f g 2> err; then exit 1; fi
      # EPERM, which this coreutils' ln prints as "Permission denied".
      grep -Eq 'Operation not permitted|Permission denied' err
      test ! -e g
      rm f
      test ! -e f
      test -z "$(ls -A | grep -x -e f -e g)"
      if ln data.txt data2.txt 2> /dev/null; then exit 1; fi
      rm data.txt
      if ln run.sh data.txt 2> /dev/null; then exit 1; fi
      test ! -e data.txt && test ! -e data2.txt
  # `rmdir` of a directory nothing had looked at yet (#1057): a checked-out
  # one with entries was "No such file or directory", not "Directory not
  # empty", and so was a file. `rm -rf` of checked-out trees removes them.
  rmdir-passes:
    using: env:bash@5
    run: |
      if rmdir go/clean 2> err; then exit 1; fi
      grep -q 'Directory not empty' err
      test -f go/clean/main.go
      if rmdir data.txt 2> err; then exit 1; fi
      grep -q 'Not a directory' err
      if rmdir nothing 2> err; then exit 1; fi
      grep -q 'No such file or directory' err
      mkdir -p /tmp/z/a
      if rmdir /tmp/z 2> err; then exit 1; fi
      grep -q 'Directory not empty' err
      rmdir /tmp/z/a /tmp/z
      test ! -e /tmp/z
      rm go/clean/main.go
      rmdir go/clean
      test ! -e go/clean
      rm -rf go ts
      test ! -e go && test ! -e ts
      mkdir go && test -z "$(ls -A go)"
  # `rm -rf` of a directory of three or more entries (#1078): each read of
  # the directory listed it afresh and took the cookie as a position in
  # that listing, so every entry removed since skipped one, and rm left
  # some and failed with "Directory not empty".
  rm-rf-passes:
    using: env:bash@5
    run: |
      for n in 3 5 12 200; do
        mkdir -p /tmp/f$n; for i in $(seq 1 $n); do echo x > /tmp/f$n/file$i; done
        rm -rf /tmp/f$n
        test ! -e /tmp/f$n
      done
      mkdir -p tree/a/b
      for d in tree tree/a tree/a/b; do for i in $(seq 1 30); do echo x > $d/longer-file-name-$i; done; done
      rm -rf tree go
      test ! -e tree && test ! -e go
  # A job is root, and the isolate says so (#1077): /etc/passwd and
  # /etc/group have root, and SHELL is exported to what a script starts.
  user-database-passes:
    using: env:bash@5
    run: |
      grep -qx 'root:x:0:0:root:/root:/bin/bash' /etc/passwd
      grep -qx 'root:x:0:' /etc/group
      test "$(env | grep '^SHELL=')" = SHELL=/bin/bash
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
  # A process starts more children over its life than a job may have at
  # once (#1082): sed's `e` spawns each, waits for it, and the 512th used to
  # fail with "Operation not permitted".
  spawn-many-passes:
    using: env:bash@5
    run: test "$(seq 600 | sed 's/.*/echo x/e' | wc -l)" = 600
  # Every process a service has is stopped with it, however many it
  # started before (#1094): the runner looked for processes by id up to
  # 2048, so the orphaned loop here, past that, ran on after the job.
  many-processes-stopped-passes:
    using: env:bash@5
    services:
      spawner:
        using: env:bash@5
        run: |
          seq 2100 | sed 's/.*/true/e' > /dev/null
          ( (i=0; while :; do i=$((i + 1)); ((i % 1000)) || echo "$i" > /tmp/workflow/spawner-tick; done) & )
          until test -e /tmp/workflow/spawner-tick; do sleep 0.1; done
          echo spawned
          sleep 600
        ready: { log: "^spawned$", timeout: 10m }
    run: test -e /tmp/workflow/spawner-tick
  many-processes-checked-passes:
    using: env:bash@5
    needs: [many-processes-stopped-passes]
    run: |
      before="$(cat /tmp/workflow/spawner-tick)"
      sleep 3
      test "$(cat /tmp/workflow/spawner-tick)" = "$before"
  # A command a subshell starts in the background outlives the subshell
  # (#1105), as on Linux: `( cmd & )` is how a script detaches a helper.
  # The subshell's exit sent it SIGQUIT ("Program recieved fatal signal:
  # Quit"), in a `bash -c` too.
  subshell-background-passes:
    using: env:bash@5
    run: |
      ( bash -c 'sleep 1; echo a > /tmp/a' & )
      bash -c '( sh -c "sleep 1; echo b > /tmp/b" & ); exit 0'
      sleep 3
      test "$(cat /tmp/a /tmp/b)" = "$(printf 'a\nb')"
  # A process's parent pid is the process that started it, and an
  # orphan's is the job's first process, as `init` on Linux (#1107): every
  # process saw 0. The orphan reads its parent after its subshell has
  # exited, through an `exec`ed bash (bash reads `$PPID` as it starts).
  ppid-passes:
    using: env:bash@5
    run: |
      test "$PPID" = 0
      bash -c 'echo "$PPID"' > /tmp/child
      test "$(cat /tmp/child)" = "$$"
      ( bash -c 'sleep 1; exec bash -c "echo \$PPID" > /tmp/orphan' & )
      sleep 3
      test "$(cat /tmp/orphan)" = "$$"
  # ...but not the job: what a job leaves running, by `( cmd & )` or
  # `cmd &`, is stopped when it ends (#1106). It used to run on and write
  # here.
  left-running-passes:
    using: env:bash@5
    run: |
      ( bash -c 'i=0; while :; do i=$((i + 1)); echo "$i" > /tmp/workflow/left-a; sleep 0.1; done' & )
      bash -c 'i=0; while :; do i=$((i + 1)); ((i % 1000)) || echo "$i" > /tmp/workflow/left-b; done' &
      until test -e /tmp/workflow/left-a && test -e /tmp/workflow/left-b; do sleep 0.1; done
  left-running-stopped-passes:
    using: env:bash@5
    needs: [left-running-passes]
    run: |
      before="$(cat /tmp/workflow/left-a /tmp/workflow/left-b)"
      sleep 3
      test "$(cat /tmp/workflow/left-a /tmp/workflow/left-b)" = "$before"
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
  # Git (environments/git/build.sh): a repository's everyday commands, a
  # file mode it records, and the subcommands that are shell scripts.
  git-passes:
    using: env:bash@5
    env:
      GIT_AUTHOR_NAME: t
      GIT_AUTHOR_EMAIL: t@example.test
      GIT_COMMITTER_NAME: t
      GIT_COMMITTER_EMAIL: t@example.test
    run: |
      git --version | grep -q '^git version 2\.'
      cd "$(mktemp -d)"
      git init -q -b main
      # `git init` trusts modes: it changes the mode of .git/config, which
      # it renamed into place, and reads it back (#1054).
      test "$(git config core.filemode)" = true
      echo one > a.txt
      printf '#!/bin/sh\necho ran\n' > run.sh
      chmod 755 run.sh
      git add a.txt run.sh
      git commit -qm first
      test "$(git ls-files -s run.sh | cut -c1-6)" = 100755
      test "$(git log --format=%s)" = first
      echo two >> a.txt
      test "$(git status --porcelain)" = " M a.txt"
      git diff | grep -q '^+two$'
      git commit -qam second
      test "$(git rev-list --count HEAD)" = 2
      test "$(git show HEAD:a.txt)" = "$(printf 'one\ntwo')"
      git tag -a v1 -m v1
      test "$(git describe)" = v1
      git checkout -qb side HEAD~1
      echo b > b.txt
      git add b.txt
      git commit -qm side
      git checkout -qb other HEAD~1
      echo c > c.txt
      git add c.txt
      git commit -qm other
      git checkout -q main
      # Two branches at once: the octopus strategy is a shell script.
      git merge -q -m octopus side other
      test "$(git log -1 --format=%p | wc -w)" = 3
      test "$(git branch --list | wc -l)" = 3
      git config set --local x.y z
      test "$(git config get x.y)" = z
      git submodule status
      git stash list
  # A `file://` remote, the way plugingen's watcher uses one: a push, a
  # commit built with plumbing on a throwaway index, a hook that refuses and
  # one that runs git, a shallow fetch and clone, and a clone from a path.
  git-remote-passes:
    using: env:bash@5
    run: |
      git() { command git -c user.name=t -c user.email=t@example.test -c init.defaultBranch=main "$@"; }
      base="$(mktemp -d)"
      remote="$base/remote.git"
      work="$base/work"
      git init -q --bare "$remote"
      git init -q "$work"
      cd "$work"
      git remote add origin "file://$remote"
      echo old > gen.ts
      git add gen.ts
      git commit -qm add
      git push -q origin main
      head="$(git rev-parse HEAD)"
      export GIT_INDEX_FILE="$base/index"
      git read-tree "$head"
      blob="$(printf 'new\n' | git hash-object -w --stdin)"
      git update-index --add --cacheinfo "100644,$blob,gen.ts"
      commit="$(git commit-tree "$(git write-tree)" -p "$head" -m subject)"
      unset GIT_INDEX_FILE
      git push -q --force origin "$commit:refs/heads/topic"
      test "$(git status --porcelain)" = ""
      test "$(cat gen.ts)" = old
      git ls-remote --heads origin refs/heads/topic | grep -q "^$commit"
      git fetch -q --no-tags --depth=1 origin +refs/heads/topic:refs/watch/topic
      test "$(git show refs/watch/topic:gen.ts)" = new
      test "$(git -C "$remote" rev-parse topic^)" = "$head"
      test "$(git -C "$remote" rev-list --count main..topic)" = 1
      printf '#!/bin/sh\necho "no thanks" >&2\nexit 1\n' > "$remote/hooks/pre-receive"
      chmod 755 "$remote/hooks/pre-receive"
      if git push origin "$commit:refs/heads/refused" 2> err; then exit 1; fi
      grep -q "no thanks" err
      grep -q "pre-receive hook declined" err
      printf '#!/bin/sh\nread -r old new ref\necho "got $ref $(git rev-parse "$new^")" >&2\n' > "$remote/hooks/pre-receive"
      git push origin "$commit:refs/heads/taken" 2> err
      grep -q "got refs/heads/taken $head" err
      git clone -q --depth=1 "file://$remote" "$base/shallow"
      test "$(git -C "$base/shallow" rev-list --count HEAD)" = 1
      git clone -q "$remote" "$base/copy"
      test "$(git -C "$base/copy" log --format=%s)" = add
  # And over HTTPS, through git-remote-https (libcurl and OpenSSL, with the
  # package's CA certificates).
  git-https-passes:
    using: env:bash@5
    timeout: 5m
    run: |
      git ls-remote https://github.com/octocat/Hello-World.git HEAD | grep -q 'HEAD$'
      git clone -q --depth=1 https://github.com/octocat/Hello-World.git hello
      test "$(git -C hello rev-list --count HEAD)" = 1
      test -s hello/README
  # A failing git command fails the script with git's status.
  git-diff-fails:
    using: env:bash@5
    run: |
      git init -q -b main /tmp/r
      cd /tmp/r
      echo x > f
      git add f
      git diff --cached --exit-code --quiet
  git-fatal-fails:
    using: env:bash@5
    run: git rev-parse --verify no-such-ref
YAML
      ;;
    kubectl)
      cat <<'YAML'
name: kubectl
jobs:
  # A connection lent as the app lends it: a kubeconfig whose token is a
  # secret part, `KUBECONFIG` pointing at it. The server makes its own
  # certificate, which the kubeconfig trusts (client-go sends no token
  # over plain HTTP).
  kubectl-passes:
    using: env:bash@5
    tools: [builtin:kubectl@1.37]
    connections: [fixture cluster]
    run: |
      /app/k8s/fake-apiserver.wasm > /tmp/api.log 2>&1 &
      wait-for-port 6443
      kubectl version --client | grep -q 'Client Version: v1.37'
      kubectl version -o json | grep -q v1.37.2-fixture
      test "$(kubectl get namespaces -o name | tr '\n' ' ')" = "namespace/default namespace/kube-system "
      test "$(kubectl get ns default -o jsonpath='{.status.phase}')" = Active
      kubectl rollout restart deploy/web
      grep -q "PATCH /apis/apps/v1/namespaces/default/deployments/web" /tmp/api.log
      kubectl config view --minify --raw -o jsonpath='{.users[0].user.token}'
  # The server refuses a wrong token, and kubectl fails for it.
  unauthorized-fails:
    using: env:bash@5
    tools: [builtin:kubectl@1.37]
    run: |
      /app/k8s/fake-apiserver.wasm > /tmp/api.log 2>&1 &
      wait-for-port 6443
      kubectl --server https://127.0.0.1:6443 --certificate-authority /tmp/fake-api-ca.pem \
        --token wrong-token get namespaces
  # A connection the app refused: the job never starts, with its reason.
  refused-fails:
    using: env:bash@5
    tools: [builtin:kubectl@1.37]
    connections: [staging]
    run: kubectl get namespaces
YAML
      ;;
    gh)
      # A token lent as the app lends one (gh_lent, below): GH_TOKEN,
      # GITHUB_TOKEN, GH_REPO, and Git's global configuration with the
      # token as a header for the repository. The fake GitHub serves
      # acme/widgets and wants that token.
      cat <<'YAML'
name: gh
jobs:
  gh-passes:
    using: env:bash@5
    tools: [builtin:gh@2.104]
    github-token: { contents: write, pull-requests: write, issues: write }
    run: |
      source /app/gh/serve.sh
      serve_github
      gh --version | grep -q '^gh version 2.104.0 (2026-11-12)'
      test "$GH_REPO" = acme/widgets
      test "$GIT_CONFIG_GLOBAL" = /root/.gitconfig
      test "$(stat -c %a /root/.gitconfig)" = 600
      # Masked wherever they are printed.
      echo "token $GH_TOKEN, $GITHUB_TOKEN"
      cat /root/.gitconfig
      # git push with the lent credentials: a branch and a tag.
      git config --global user.name ci
      git config --global user.email ci@example.com
      git init -q -b main /tmp/w && cd /tmp/w
      echo widget > widget.txt && git add widget.txt && git commit -q -m 'Add a widget'
      git push https://github.com/acme/widgets.git HEAD:main
      git push https://github.com/acme/widgets.git HEAD:refs/heads/feature
      git tag v1.0.0 && git push https://github.com/acme/widgets.git v1.0.0
      test "$(git ls-remote https://github.com/acme/widgets.git refs/tags/v1.0.0 | cut -f1)" = "$(git rev-parse HEAD)"
      cd /tmp
      # Pull requests.
      test "$(gh pr create --head feature --base main --title 'Add a widget' --body 'From CI.' --label bug)" = https://github.com/acme/widgets/pull/1
      test "$(gh pr list --json number,headRefName --jq '.[] | "\(.number) \(.headRefName)"')" = "1 feature"
      gh pr edit 1 --title 'Add widgets' --add-label release
      test "$(gh pr view 1 --json title,labels --jq '.title + " " + ([.labels[].name] | join(","))')" = "Add widgets bug,release"
      # Issues.
      test "$(gh issue create --title 'A bug' --body 'Found by CI.' --label bug)" = https://github.com/acme/widgets/issues/2
      gh issue edit 2 --title 'A real bug' --remove-label bug
      gh issue close 2
      test "$(gh issue view 2 --json state,title --jq '.state + " " + .title')" = "CLOSED A real bug"
      # A release with an asset, and the REST API.
      echo built > widget.tgz
      test "$(gh release create v1.0.0 --title v1.0.0 --notes 'First.' ./widget.tgz)" = https://github.com/acme/widgets/releases/tag/v1.0.0
      test "$(gh api repos/acme/widgets/releases/tags/v1.0.0 --jq '.assets[0].name')" = widget.tgz
      test "$(gh api repos/acme/widgets --jq .full_name)" = acme/widgets
      # Everything above reached the fake, as the right calls.
      for want in 'POST github.com/acme/widgets.git/git-receive-pack' 'POST api.github.com/graphql PullRequestCreate' \
        'POST api.github.com/graphql PullRequestUpdate' 'POST api.github.com/graphql IssueCreate' \
        'POST api.github.com/graphql IssueClose' 'POST api.github.com/repos/acme/widgets/releases' \
        'POST uploads.github.com/repos/acme/widgets/releases/1/assets'; do
        grep -qF "$want" /tmp/github.log || { echo "the fake saw no $want"; cat /tmp/github.log; exit 1; }
      done
      ! grep -q -- '-> 401' /tmp/github.log
  # GitHub refuses a token it did not issue, and gh and Git fail for it
  # (Git at once: the lent token sets GIT_TERMINAL_PROMPT=0).
  bad-token-fails:
    using: env:bash@5
    tools: [builtin:gh@2.104]
    github-token: { contents: write, pull-requests: write, issues: write }
    run: |
      source /app/gh/serve.sh
      serve_github -token another-token
      if git ls-remote https://github.com/acme/widgets.git; then exit 2; fi
      gh api repos/acme/widgets
  # A job that asks for no token has none: gh says to log in.
  no-token-fails:
    using: env:bash@5
    tools: [builtin:gh@2.104]
    run: |
      test -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}${GIT_CONFIG_GLOBAL:-}"
      gh api repos/acme/widgets
  # Permissions the app would not mint: the job never starts, with its reason.
  refused-fails:
    using: env:bash@5
    tools: [builtin:gh@2.104]
    github-token: { issues: write }
    run: gh issue list
  # A token that expired before the job started.
  expired-fails:
    using: env:bash@5
    tools: [builtin:gh@2.104]
    github-token: { statuses: write }
    run: gh api repos/acme/widgets
YAML
      ;;
    openssh)
      # Connections and keys are lent as the app lends them (openssh_lent,
      # below): a Host entry in ~/.ssh/config with the connection's key and
      # its pinned host key as a known_hosts file of its own, and a key at
      # mode 0600 named as an IdentityFile.
      # Servers: `web` on 2222 (Ed25519 host key), `jump` on 2223 (ECDSA),
      # `legacy` on 2224 (RSA). Each job is lent only what it names, so the
      # wrong host key is never next to the right one.
      cat <<'YAML'
name: openssh
jobs:
  exec-passes:
    using: env:bash@5
    tools: [builtin:ssh@10.6]
    connections: [web]
    ssh-keys: [deploy]
    run: |
      source /app/ssh/serve.sh
      serve web 2222 host_a
      ssh -V 2>&1 | grep -q '^OpenSSH_10.6p2, OpenSSL 3'
      test "$(stat -c %a ~/.ssh/id_deploy)" = 600
      test "$(ssh web echo hello)" = hello
      test "$(echo piped | ssh web 'tr a-z A-Z')" = PIPED
      status=0
      ssh web 'exit 3' || status=$?
      test "$status" = 3
      grep -q 'exec "tr a-z A-Z"' /tmp/web.log
      # The lent key, which must come out masked in the report.
      cat ~/.ssh/id_deploy
  copy-passes:
    using: env:bash@5
    tools: [builtin:ssh@10.6, builtin:scp@10.6, builtin:sftp@10.6]
    connections: [web]
    ssh-keys: [deploy]
    run: |
      source /app/ssh/serve.sh
      serve web 2222 host_a
      head -c 300000 /dev/urandom > /tmp/up.bin
      scp /tmp/up.bin web:/tmp/remote.bin
      scp web:/tmp/remote.bin /tmp/down.bin
      test "$(sha256sum < /tmp/up.bin)" = "$(sha256sum < /tmp/down.bin)"
      printf 'put /tmp/up.bin /tmp/sftp.bin\nget /tmp/sftp.bin /tmp/back.bin\n' | sftp -b - web
      test "$(sha256sum < /tmp/up.bin)" = "$(sha256sum < /tmp/back.bin)"
      test "$(grep -c 'subsystem sftp' /tmp/web.log)" = 3
  jump-passes:
    using: env:bash@5
    tools: [builtin:ssh@10.6, builtin:scp@10.6]
    connections: [web-via-jump]
    ssh-keys: [deploy]
    run: |
      source /app/ssh/serve.sh
      serve web 2222 host_a
      serve jump 2223 host_jump
      test "$(ssh web-via-jump echo through)" = through
      echo payload > /tmp/up.txt
      scp /tmp/up.txt web-via-jump:/tmp/jumped.txt
      test "$(cat /tmp/jumped.txt)" = payload
      test "$(grep -c 'direct-tcpip to 127.0.0.1:2222' /tmp/jump.log)" = 2
      grep -q 'exec "echo through"' /tmp/web.log
  # A tunnel in the background, as a job reaches a database behind a
  # bastion: here, through `web` to its own port.
  forward-passes:
    using: env:bash@5
    tools: [builtin:ssh@10.6]
    connections: [web]
    ssh-keys: [deploy]
    run: |
      source /app/ssh/serve.sh
      serve web 2222 host_a
      ssh -N -L 127.0.0.1:2290:127.0.0.1:2222 web &
      wait-for-port 2290
      test "$(ssh -o UserKnownHostsFile=/root/.ssh/iw_web.known_hosts -o HostKeyAlias='[127.0.0.1]:2222' \
        -p 2290 deploy@127.0.0.1 echo tunnelled)" = tunnelled
      grep -q 'direct-tcpip to 127.0.0.1:2222' /tmp/web.log
  rsa-passes:
    using: env:bash@5
    tools: [builtin:ssh@10.6]
    connections: [legacy]
    ssh-keys: [deploy-rsa]
    run: |
      source /app/ssh/serve.sh
      serve legacy 2224 host_rsa
      ssh -v legacy echo rsa > /tmp/out 2> /tmp/err
      test "$(cat /tmp/out)" = rsa
      grep -q 'Server host key: ssh-rsa' /tmp/err
      grep -q 'accepted ssh-rsa key' /tmp/legacy.log
  keygen-passes:
    using: env:bash@5
    tools: [builtin:ssh-keygen@10.6, builtin:ssh-keyscan@10.6]
    connections: [web]
    run: |
      source /app/ssh/serve.sh
      serve web 2222 host_a
      ssh-keygen -q -t ed25519 -N '' -C job -f /tmp/new
      test "$(stat -c %a /tmp/new)" = 600
      ssh-keygen -l -f /tmp/new.pub | grep -q '(ED25519)$'
      ssh-keyscan -q -p 2222 -t ed25519 127.0.0.1 | grep -v '^#' | cut -d' ' -f2- > /tmp/scanned
      test "$(cat /tmp/scanned)" = "$(cut -d' ' -f2- ~/.ssh/iw_web.known_hosts)"
      ssh-keygen -F '[127.0.0.1]:2222' -f ~/.ssh/iw_web.known_hosts | grep -q ssh-ed25519
  # The server holds another key than the one pinned for it.
  wrong-host-key-fails:
    using: env:bash@5
    tools: [builtin:ssh@10.6]
    connections: [web]
    ssh-keys: [deploy]
    run: |
      source /app/ssh/serve.sh
      serve web 2222 host_other
      ssh web echo reached
  # No key pinned for it, and no terminal to ask: never trusted on first use.
  unknown-host-fails:
    using: env:bash@5
    tools: [builtin:ssh@10.6]
    ssh-keys: [deploy]
    run: |
      source /app/ssh/serve.sh
      serve web 2222 host_a
      ssh -p 2222 deploy@127.0.0.1 echo reached
  # A key a job wrote without chmod 600 is refused, as on Linux.
  loose-key-fails:
    using: env:bash@5
    tools: [builtin:ssh@10.6]
    connections: [web]
    ssh-keys: [deploy]
    run: |
      source /app/ssh/serve.sh
      serve web 2222 host_a
      cat ~/.ssh/id_deploy > /tmp/loose
      ssh -F none -i /tmp/loose -o IdentitiesOnly=yes -o UserKnownHostsFile=/root/.ssh/iw_web.known_hosts \
        -p 2222 deploy@127.0.0.1 echo reached
  refused-fails:
    using: env:bash@5
    tools: [builtin:ssh@10.6]
    connections: [closed]
    ssh-keys: [deploy]
    run: ssh closed echo reached
  # A connection the app refused: the job never starts, with its reason.
  not-lent-fails:
    using: env:bash@5
    tools: [builtin:ssh@10.6]
    connections: [staging]
    run: ssh staging echo reached
YAML
      ;;
    npm-cli)
      # The deployment CLIs (npm-cli/build.sh) against fake Vercel,
      # Cloudflare and Neon APIs on the job's loopback (npm-cli/fake-apis.mjs),
      # with the network off, so nothing can reach a real one. Each token
      # comes from a lent connection, as the app lends one (npm_cli_lent,
      # below), and must come out masked.
      cat <<'YAML'
name: npm-cli
workspace:
  services:
    apis:
      using: env:bash-node@24
      run: node /app/npm-cli/fake-apis.mjs
      ready: { port: 4300 }
jobs:
  # `vercel deploy` uploads the directory and creates a deployment;
  # `--prebuilt` sends `vercel build`'s output as it is, to production.
  vercel-deploy-passes:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:vercel@65]
    connections: [vercel]
    env: { VERCEL_ORG_ID: team_fixture, VERCEL_PROJECT_ID: prj_fixture }
    run: |
      mkdir -p /tmp/site && cd /tmp/site
      echo '<h1>hello</h1>' >index.html
      vercel deploy --api http://127.0.0.1:4100 --yes >/tmp/out 2>&1 || { cat /tmp/out; exit 1; }
      cat /tmp/out
      grep -q 'https://web-.*\.vercel\.app' /tmp/out
      echo "token: $VERCEL_TOKEN"
      node -e '
      fetch("http://127.0.0.1:4100/_received").then((r) => r.json()).then(([d]) => {
        if (d.files["index.html"] !== "<h1>hello</h1>\n" || d.target !== null || d.prebuilt) throw new Error(JSON.stringify(d));
      });'
  vercel-prebuilt-passes:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:vercel@65]
    connections: [vercel]
    run: |
      mkdir -p /tmp/pb/.vercel/output/static && cd /tmp/pb
      echo '{"projectId":"prj_fixture","orgId":"team_fixture"}' >.vercel/project.json
      echo '{"version":3}' >.vercel/output/config.json
      echo '<h1>prebuilt</h1>' >.vercel/output/static/index.html
      vercel deploy --prebuilt --prod --api http://127.0.0.1:4100 --yes
      node -e '
      fetch("http://127.0.0.1:4100/_received").then((r) => r.json()).then(([d]) => {
        if (!d.prebuilt || d.target !== "production" || d.files[".vercel/output/static/index.html"] !== "<h1>prebuilt</h1>\n") throw new Error(JSON.stringify(d));
      });'
  # A token the API refuses fails the deploy.
  vercel-bad-token-fails:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:vercel@65]
    env: { VERCEL_TOKEN: notthetoken, VERCEL_ORG_ID: team_fixture, VERCEL_PROJECT_ID: prj_fixture }
    run: |
      mkdir -p /tmp/site && cd /tmp/site && echo hi >index.html
      vercel deploy --api http://127.0.0.1:4100 --yes
  # Wrangler bundles with esbuild-wasm (the import is inlined), uploads
  # the Worker and turns its workers.dev route on.
  wrangler-deploy-passes:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:wrangler@4]
    connections: [cloudflare]
    env: { CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:4200/client/v4" }
    run: |
      mkdir -p /tmp/w/src && cd /tmp/w
      echo '{"name":"hello","main":"src/index.js","compatibility_date":"2026-11-01"}' >wrangler.json
      printf 'import { greet } from "./greet.js";\nexport default { fetch() { return new Response(greet("ci")); } };\n' >src/index.js
      printf 'export const greet = (n) => `hello ${n}`;\n' >src/greet.js
      started=$(date +%s%N)
      wrangler deploy
      echo "deployed in $(( ($(date +%s%N) - started) / 1000000 )) ms"
      node -e '
      fetch("http://127.0.0.1:4200/_received").then((r) => r.json()).then(([d]) => {
        const code = d.modules[d.main_module] ?? "";
        if (d.worker !== "hello" || !code.includes("hello ${n}") || code.includes("import ")) throw new Error(JSON.stringify(d));
      });'
  # Without bundling: a Worker built elsewhere, uploaded as it is.
  wrangler-no-bundle-passes:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:wrangler@4]
    connections: [cloudflare]
    env: { CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:4200/client/v4" }
    run: |
      mkdir -p /tmp/nb/dist && cd /tmp/nb
      echo '{"name":"prebundled","main":"dist/worker.js","compatibility_date":"2026-11-01"}' >wrangler.json
      echo 'export default { fetch() { return new Response("as built"); } };' >dist/worker.js
      wrangler deploy --no-bundle
      node -e '
      fetch("http://127.0.0.1:4200/_received").then((r) => r.json()).then(([d]) => {
        if (d.modules["worker.js"] !== "export default { fetch() { return new Response(\"as built\"); } };\n") throw new Error(JSON.stringify(d));
      });'
  wrangler-pages-passes:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:wrangler@4]
    connections: [cloudflare]
    env: { CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:4200/client/v4" }
    run: |
      mkdir -p /tmp/pages/dist && cd /tmp/pages
      echo '<h1>pages</h1>' >dist/index.html
      echo 'body {}' >dist/app.css
      wrangler pages deploy dist --project-name site --branch main
      node -e '
      fetch("http://127.0.0.1:4200/_received").then((r) => r.json()).then(([d]) => {
        if (d.pages !== "site" || d.branch !== "main" || d.files.join() !== "/app.css,/index.html") throw new Error(JSON.stringify(d));
      });'
  # workerd cannot run in a job: `wrangler dev` says so and fails.
  wrangler-dev-fails:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:wrangler@4]
    connections: [cloudflare]
    env: { CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:4200/client/v4" }
    run: |
      mkdir -p /tmp/w && cd /tmp/w
      echo '{"name":"hello","main":"index.js","compatibility_date":"2026-11-01"}' >wrangler.json
      echo 'export default { fetch() { return new Response("hi"); } };' >index.js
      wrangler dev
  # Cloudflare's CLI deploys a directory of static assets as a Worker.
  cf-deploy-passes:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:cf@1.0.0-beta.32]
    connections: [cloudflare]
    env: { CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:4200/client/v4" }
    run: |
      mkdir -p /tmp/site/public && cd /tmp/site
      echo '<h1>cf</h1>' >public/index.html
      cf deploy public
      node -e '
      fetch("http://127.0.0.1:4200/_received").then((r) => r.json()).then(([d]) => {
        if (d.worker !== "site" || !d.assets) throw new Error(JSON.stringify(d));
      });'
  # A branch for a pull request: made, its connection string read, and
  # deleted, by name.
  neon-branch-passes:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:neon@9]
    connections: [neon]
    env: { NEON_API_HOST: "http://127.0.0.1:4300/api/v2" }
    run: |
      p=fixture-project-123456
      neon branches create --project-id $p --name pr-42 -o json >/tmp/branch.json
      test "$(node -p 'require("/tmp/branch.json").branch.name')" = pr-42
      url="$(neon connection-string pr-42 --project-id $p)"
      echo "$url"
      [[ "$url" == postgresql://app_owner:*@ep-made-*.fake.neon.test/app?sslmode=require* ]]
      neon branches delete pr-42 --project-id $p
      node -e '
      fetch("http://127.0.0.1:4300/_received").then((r) => r.json()).then((d) => {
        if (JSON.stringify(d) !== JSON.stringify([{ created: "pr-42" }, { deleted: "pr-42" }])) throw new Error(JSON.stringify(d));
      });'
  neon-bad-key-fails:
    using: env:bash-node@24
    network: false
    timeout: 5m
    tools: [builtin:neon@9]
    env: { NEON_API_KEY: not-the-key, NEON_API_HOST: "http://127.0.0.1:4300/api/v2" }
    run: neon branches list --project-id fixture-project-123456
  # A Node tool needs `node`: in env:bash it never starts, and saying so.
  in-bash-errors:
    using: env:bash@5
    services: false
    tools: [builtin:vercel@65]
    run: vercel --version
  # And it is not a job of its own.
  as-a-job-errors:
    using: builtin:neon@9
    services: false
    args: [--version]
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
  # `node --version` and `-v` print `process.version`, as Node's do: they
  # said v24.13.2-pre where it is v24.13.2 (#1151).
  node-passes:
    using: env:bash-node@24
    run: |
      test "$(node -e 'console.log(6 * 7)')" = 42
      node --version
      version="$(node -p process.version)"
      [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
      test "$(node --version)" = "$version"
      test "$(node -v)" = "$version"
      test "v$(node -p process.versions.node)" = "$version"
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
      npx --version
  # HOME is a directory: it was only a variable, so `pnpm dlx` failed with
  # "lstat '/root'".
  home-passes:
    using: env:bash-node@24
    run: |
      test "$HOME" = /root
      test -d "$HOME"
      test "$(node -p 'require("os").homedir()')" = /root
  # A command reached through a symbolic link runs what the link points
  # at, as execve does: npm and pnpm install commands as links into their
  # packages, and running one failed with "No such file or directory". The
  # script is handed the path that was run, as on Linux.
  symlink-exec-passes:
    using: env:bash-node@24
    run: |
      mkdir -p /tmp/l/lib /tmp/l/bin
      printf '#!/usr/bin/env node\nconsole.log(process.argv[1])\n' >/tmp/l/lib/s.js
      ln -s ../lib/s.js /tmp/l/bin/rel
      ln -s /tmp/l/lib/s.js /tmp/l/bin/abs
      ln -s rel /tmp/l/bin/chain
      ln -s ../l/lib /tmp/l/dir
      test "$(/tmp/l/bin/rel)" = /tmp/l/bin/rel
      test "$(/tmp/l/bin/abs)" = /tmp/l/bin/abs
      test "$(/tmp/l/bin/chain)" = /tmp/l/bin/chain
      test "$(/tmp/l/dir/s.js)" = /tmp/l/dir/s.js
      test "$(PATH="/tmp/l/bin:$PATH" rel)" = /tmp/l/bin/rel
      test "$(node -e 'process.stdout.write(require("child_process").execFileSync("/tmp/l/bin/chain"))')" = /tmp/l/bin/chain
      # A loop is a failure to run, not a hang.
      ln -s loop-b /tmp/l/bin/loop-a
      ln -s loop-a /tmp/l/bin/loop-b
      if /tmp/l/bin/loop-a 2>/dev/null; then exit 1; fi
  # A child's command is looked up on the PATH it is given, as Node does
  # (#1201): Edge.js searched its parent's.
  spawn-child-path-passes:
    using: env:bash-node@24
    run: |
      mkdir -p /tmp/x
      printf '#!/usr/bin/env node\nconsole.log("x ran")\n' >/tmp/x/xcmd
      cat >/tmp/spawn.cjs <<'JS'
      const cp = require("node:child_process");
      const env = { ...process.env, PATH: "/tmp/x:" + process.env.PATH };
      const out = [
        cp.execFileSync("xcmd", { env }),
        cp.spawnSync("xcmd", [], { env }).stdout,
        cp.execFileSync("xcmd", [], { env, cwd: "/tmp" }),
      ].join("");
      if (out !== "x ran\n".repeat(3)) throw new Error(JSON.stringify(out));
      // Not on the parent's PATH, so not found without it.
      if (cp.spawnSync("xcmd").error?.code !== "ENOENT") throw new Error("found");
      cp.spawn("xcmd", { env, stdio: "inherit" }).on("exit", (code) => process.exit(code));
      JS
      test "$(node /tmp/spawn.cjs)" = "x ran"
  # Global installs (README.md, "Global installs"), from a registry on the
  # job's loopback: `npm i -g` (pnpm, in Edge.js) and `pnpm add -g` put
  # the package's commands on PATH, the first time in a job too, and
  # `pnpm remove -g` takes them away again.
  global-install-passes:
    using: env:bash-node@24
    timeout: 4m
    services:
      registry:
        using: env:bash-node@24
        run: node /app/npm/registry.mjs /app/npm/packages 4873
        ready: { port: 4873 }
    env: { npm_config_registry: "http://127.0.0.1:4873/" }
    run: |
      npm i -g hello-cli@1.0.0
      test "$(command -v hello)" = /root/.local/share/pnpm/hello
      test "$(hello a b)" = "hello 1.0.0 a b"
      pnpm add -g hello-cli@2.0.0
      test "$(hello c)" = "hello 2.0.0 c"
      test "$(node -e 'process.stdout.write(require("child_process").execFileSync("hello", ["d"]))')" = "hello 2.0.0 d"
      pnpm remove -g hello-cli
      if command -v hello; then exit 1; fi
  # npx (npm's, which Edge.js ships without putting on PATH) and pnpm dlx
  # run a package's command without installing it, and npx prefers the
  # project's own.
  npx-passes:
    using: env:bash-node@24
    timeout: 4m
    services:
      registry:
        using: env:bash-node@24
        run: node /app/npm/registry.mjs /app/npm/packages 4873
        ready: { port: 4873 }
    env: { npm_config_registry: "http://127.0.0.1:4873/" }
    run: |
      test "$(npx --yes hello-cli@1.0.0 x)" = "hello 1.0.0 x"
      test "$(pnpm dlx hello-cli@2.0.0 y)" = "hello 2.0.0 y"
      mkdir -p /tmp/proj && cd /tmp/proj && echo '{}' >package.json
      pnpm add hello-cli@1.0.0
      test "$(npx hello z)" = "hello 1.0.0 z"
  # A global install can be kept with a job cache, and runs again with the
  # registry gone (no service, no network).
  global-cache-save-passes:
    using: env:bash-node@24
    timeout: 4m
    services:
      registry:
        using: env:bash-node@24
        run: node /app/npm/registry.mjs /app/npm/packages 4873
        ready: { port: 4873 }
    env: { npm_config_registry: "http://127.0.0.1:4873/" }
    cache: { key: pnpm-global-fixture, paths: [/root/.local/share/pnpm] }
    run: |
      npm i -g hello-cli@2.0.0
      test "$(hello)" = "hello 2.0.0 "
  global-cache-restore-passes:
    using: env:bash-node@24
    needs: [global-cache-save-passes]
    network: false
    cache: { key: pnpm-global-fixture, paths: [/root/.local/share/pnpm] }
    run: test "$(hello again)" = "hello 2.0.0 again"
  # A package the registry does not have fails the install, and the job.
  global-install-missing-fails:
    using: env:bash-node@24
    timeout: 4m
    services:
      registry:
        using: env:bash-node@24
        run: node /app/npm/registry.mjs /app/npm/packages 4873
        ready: { port: 4873 }
    env: { npm_config_registry: "http://127.0.0.1:4873/" }
    run: npm i -g no-such-cli
  throw-fails:
    using: env:bash-node@24
    run: |
      node -e 'throw new Error("expected")'
  # V8's engine flags are the runner's, the same for every job: a `node`
  # started with V8 options of its own runs, and so does every later one,
  # in this job or the next, whatever options each was given.
  node-options-passes:
    using: env:bash-node@24
    run: |
      test "$(node --harmony-import-attributes -e 'console.log(1)')" = 1
      test "$(node --max-old-space-size=256 --stack-size=100 -e 'console.log(6 * 7)')" = 42
  node-after-options-passes:
    using: env:bash-node@24
    needs: [node-options-passes]
    run: |
      test "$(node --js-source-phase-imports -e 'console.log(2)')" = 2
      test "$(node -e 'console.log(6 * 7)')" = 42
  # An ES module that does not parse says where once, with its caret, as
  # Node does (#1097): it printed the file, line, source and caret two or
  # three times, one of them naming line 1 with no caret. Caught, the
  # error's stack is Node's: the place is only for the fatal report.
  module-syntax-error-passes:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      printf 'export const a = 1;\n\nexport const b = {;\n' >/tmp/bad.mjs
      printf 'import "/tmp/bad.mjs";\n' >/tmp/imports-bad.mjs
      want="$(printf 'file:///tmp/bad.mjs:3\nexport const b = {;\n%18s^\n\nSyntaxError: Unexpected token %s' '' "';'")"
      for main in /tmp/bad.mjs /tmp/imports-bad.mjs; do
        if node "$main" 2>/tmp/err; then exit 1; fi
        test "$(head -n 5 /tmp/err)" = "$want"
        test "$(grep -c 'export const b' /tmp/err)" = 1
        test "$(grep -c '^file://' /tmp/err)" = 1
      done
      cat >/tmp/catch.mjs <<'JS'
      try {
        await import("/tmp/bad.mjs");
      } catch (e) {
        if (!(e instanceof SyntaxError) || !e.stack.startsWith("SyntaxError: Unexpected token ';'\n")) {
          console.error(e.stack);
          process.exit(1);
        }
        console.log("caught");
      }
      JS
      test "$(node /tmp/catch.mjs)" = caught
  # Its stderr begins with the one block and then the error (want_stderr).
  module-syntax-error-fails:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      printf 'export const a = {;\n' >/tmp/bad.mjs
      node /tmp/bad.mjs
  # An uncaught exception is reported as Node 24 reports it, byte for byte
  # up to the stack's frames (whose internal line numbers are Edge.js's
  # library's) and after them. A CommonJS main printed "Failed to execute
  # builtin" first, a SyntaxError in it a second arrow into the loader, and
  # every arrow an empty line too many (#1141); an ES module's error, and a
  # rejection, pointed at the internals that rethrew it (#1142); an import
  # of a name a module does not export had an empty line after its arrow
  # (#1143); a thrown string came out quoted, without its hint.
  error-report-passes:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      mkdir -p /tmp/er && cd /tmp/er
      version="$(node --version)"
      # report <file> <stderr up to the first frame>: the node fails, says
      # that, and ends with the version as Node does.
      report() {
        if node "$1" 2>err; then exit 1; fi
        if [[ "$(sed '/^    at /,$d' err)" != "$2" || "$(tail -n 2 err)" != "$(printf '\nNode.js %s' "$version")" ]]; then
          printf -- '--- %s: got\n%s\n--- wanted\n%s\n' "$1" "$(cat err)" "$2" >&2
          exit 1
        fi
      }
      printf 'const x = 1;\n\nconst a = {;\n' >syntax.cjs
      report syntax.cjs "$(printf '/tmp/er/syntax.cjs:3\nconst a = {;\n%11s^\n\nSyntaxError: Unexpected token %s' '' "';'")"
      printf 'const x = 1;\nthrow new Error("boom");\n' >throw.cjs
      report throw.cjs "$(printf '/tmp/er/throw.cjs:2\nthrow new Error("boom");\n^\n\nError: boom')"
      printf 'function f() {\n  throw new TypeError("bad thing");\n}\nf();\n' >fn.cjs
      printf 'require("./fn.cjs");\n' >requires.cjs
      report requires.cjs "$(printf '/tmp/er/fn.cjs:2\n  throw new TypeError("bad thing");\n  ^\n\nTypeError: bad thing')"
      printf 'Promise.reject(new Error("rejected"));\n' >reject.cjs
      report reject.cjs "$(printf '/tmp/er/reject.cjs:1\nPromise.reject(new Error("rejected"));\n%15s^\n\nError: rejected' '')"
      printf 'setTimeout(() => {\n  throw new Error("later");\n}, 1);\n' >timer.cjs
      report timer.cjs "$(printf '/tmp/er/timer.cjs:2\n  throw new Error("later");\n  ^\n\nError: later')"
      printf 'const x = 1;\nthrow new Error("boom");\n' >throw.mjs
      report throw.mjs "$(printf 'file:///tmp/er/throw.mjs:2\nthrow new Error("boom");\n%6s^\n\nError: boom' '')"
      printf 'function f() {\n  throw new TypeError("bad thing");\n}\nf();\n' >fn.mjs
      printf 'import "./fn.mjs";\n' >imports.mjs
      report imports.mjs "$(printf 'file:///tmp/er/fn.mjs:2\n  throw new TypeError("bad thing");\n%8s^\n\nTypeError: bad thing' '')"
      printf 'await 1;\nthrow new Error("after await");\n' >tla.mjs
      report tla.mjs "$(printf 'file:///tmp/er/tla.mjs:2\nthrow new Error("after await");\n%6s^\n\nError: after await' '')"
      printf 'export const a = 1;\n' >a.mjs
      printf '// a comment\n\nimport { a, nope } from "./a.mjs";\nconsole.log(a, nope);\n' >missing.mjs
      want_missing="$(printf 'file:///tmp/er/missing.mjs:3\nimport { a, nope } from "./a.mjs";\n%12s^^^^\nSyntaxError: The requested module %s does not provide an export named %s' '' "'./a.mjs'" "'nope'")"
      report missing.mjs "$want_missing"
      printf 'import "./missing.mjs";\n' >imports-missing.mjs
      report imports-missing.mjs "$want_missing"
      if node -e 'throw new Error("from eval")' 2>err; then exit 1; fi
      test "$(sed '/^    at /,$d' err)" = "$(printf '[eval]:1\nthrow new Error("from eval")\n^\n\nError: from eval')"
      # Values that are not errors carry no arrow: Node prints the line
      # first, after an empty line, then the value.
      hint='(Use `node --trace-uncaught ...` to show where the exception was thrown)'
      printf 'const x = 1;\nthrow "a string";\n' >string.cjs
      if node string.cjs 2>err; then exit 1; fi
      test "$(cat err)" = "$(printf '\n/tmp/er/string.cjs:2\nthrow "a string";\n^\na string\n%s\n\nNode.js %s' "$hint" "$version")"
      printf 'throw { code: "E_X", n: 1 };\n' >object.cjs
      if node object.cjs 2>err; then exit 1; fi
      test "$(cat err)" = "$(printf '\n/tmp/er/object.cjs:1\nthrow { code: "E_X", n: 1 };\n^\n{ code: %s, n: 1 }\n\nNode.js %s' "'E_X'" "$version")"
      printf 'throw 42;\n' >number.mjs
      if node number.mjs 2>err; then exit 1; fi
      test "$(cat err)" = "$(printf '\nnode:internal/modules/run_main:107\n    triggerUncaughtException(\n    ^\n42\n%s\n\nNode.js %s' "$hint" "$version")"
  # A CommonJS main's error: its stderr begins with its arrow, nothing
  # before it (want_stderr).
  error-report-fails:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      printf 'const x = 1;\nthrow new Error("boom");\n' >/tmp/throw.cjs
      node /tmp/throw.cjs
  # An ES module whose top-level await never settles exits 13 with Node's
  # warning on its stderr: where the await is, its line and a caret, then
  # three empty lines. The warning went to iwci's own stderr and the job's
  # was empty (#1150); the run's stderr is checked for it below.
  unsettled-tla-passes:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      mkdir -p /tmp/tla && cd /tmp/tla
      printf 'const x = 1;\nawait new Promise(() => {});\n' >stall.mjs
      status=0; node stall.mjs 2>err || status=$?
      test "$status" = 13
      test "$(cat err; echo .)" = "$(printf 'Warning: Detected unsettled top-level await at file:///tmp/tla/stall.mjs:2\nawait new Promise(() => {});\n^\n\n\n\n.')"
      # Through a pipe, as `2>&1 | tee` gives it.
      test "$({ node stall.mjs 2>&1 || true; } | head -n 1)" = 'Warning: Detected unsettled top-level await at file:///tmp/tla/stall.mjs:2'
      # In an imported module, indented: the line and caret are the await's.
      printf 'import "./inner.mjs";\n' >outer.mjs
      printf 'export const a = 1;\nif (a) {\n  await new Promise(() => {});\n}\n' >inner.mjs
      status=0; node outer.mjs 2>err || status=$?
      test "$status" = 13
      test "$(cat err; echo .)" = "$(printf 'Warning: Detected unsettled top-level await at file:///tmp/tla/inner.mjs:3\n  await new Promise(() => {});\n  ^\n\n\n\n.')"
      # --no-warnings keeps the exit status and drops the warning.
      status=0; node --no-warnings stall.mjs 2>err || status=$?
      test "$status" = 13
      test ! -s err
      # A process.exitCode set before the loop ends is kept, with no warning.
      printf 'process.exitCode = 3;\nawait new Promise(() => {});\n' >code.mjs
      status=0; node code.mjs 2>err || status=$?
      test "$status" = 3
      test ! -s err
  # The job's own stderr carries the warning (want_stderr).
  unsettled-tla-fails:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      printf 'const x = 1;\nawait new Promise(() => {});\n' >/tmp/stall.mjs
      node /tmp/stall.mjs
  # `fs.renameSync` of a checked-out file and directory (#985), which threw
  # ENOENT in a job that had not written them, and of a checked-out symlink
  # (#1005), which WASIX could not find to move.
  rename-passes:
    using: env:bash-node@24
    run: |
      cat > /tmp/rename.js <<'JS'
      const fs = require("node:fs");
      fs.renameSync("data.txt", "moved.txt");
      fs.renameSync("go/dirty", "go/renamed");
      fs.renameSync("data-link", "node-link");
      const text = fs.readFileSync("moved.txt", "utf8").trim();
      console.log(text, fs.existsSync("data.txt"), fs.readdirSync("go").sort().join(","), fs.readlinkSync("node-link"));
      JS
      test "$(node /tmp/rename.js)" = "fixture line false clean,renamed data.txt"
  # Threads and processes renaming temporaries onto one name at once
  # (#1092), the atomic-replace idiom of compile and package caches: two
  # renames racing onto one target aborted the runner, every job on it
  # included. Every rename succeeds, the last one wins and no temporary is
  # left behind.
  rename-race-passes:
    using: env:bash-node@24
    timeout: 5m
    run: |
      cat > /tmp/race.js <<'JS'
      const fs = require("node:fs");
      const assert = require("node:assert");
      const { spawn } = require("node:child_process");
      const { Worker, isMainThread, threadId } = require("node:worker_threads");
      const dir = "/tmp/rr";
      const N = 3000;
      const hammer = (who) => {
        for (let i = 0; i < N; i++) {
          const tmp = `${dir}/target.${who}.${i}.tmp`;
          fs.writeFileSync(tmp, `${who}.${i}`);
          fs.renameSync(tmp, `${dir}/target`);
        }
      };
      if (process.argv[2]) {
        hammer(process.argv[2]);
      } else if (!isMainThread) {
        hammer(`t${threadId}`);
      } else {
        fs.mkdirSync(dir, { recursive: true });
        const exited = (child) => new Promise((resolve, reject) => child.on("exit", resolve).on("error", reject));
        const all = [
          ...["p1", "p2"].map((who) => exited(spawn(process.execPath, [__filename, who], { stdio: "inherit" }))),
          ...[1, 2, 3, 4].map(() => exited(new Worker(__filename))),
        ];
        Promise.all(all).then((codes) => {
          assert.deepStrictEqual(codes, [0, 0, 0, 0, 0, 0]);
          assert.deepStrictEqual(fs.readdirSync(dir), ["target"]);
          assert.match(fs.readFileSync(`${dir}/target`, "utf8"), new RegExp(`^(p[12]|t[0-9]+)\\.${N - 1}$`));
          console.log("rename race ok");
        });
      }
      JS
      test "$(node /tmp/race.js)" = "rename race ok"
      test "$(ls /tmp/rr)" = target
  # Threads and processes unlinking one name while others rename and write
  # onto it (#1139), as a compile cache's writers and its pruning do: an
  # unlink that lost the race to another asserted on an inode it had not
  # looked up, or one already unlinked, and the `node` exited with 134.
  # Every unlink succeeds or says ENOENT, and the name is left gone or
  # holding one writer's whole contents.
  unlink-race-passes:
    using: env:bash-node@24
    timeout: 5m
    run: |
      cat > /tmp/unlink-race.js <<'JS'
      const fs = require("node:fs");
      const assert = require("node:assert");
      const { spawn } = require("node:child_process");
      const { Worker, isMainThread, workerData } = require("node:worker_threads");
      const dir = "/tmp/ur";
      const target = `${dir}/target`;
      const N = 2000;
      const hammer = (who) => {
        for (let i = 0; i < N; i++) {
          if (who.startsWith("u")) {
            try {
              fs.unlinkSync(target);
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            if (who === "u1") fs.writeFileSync(target, `${who}.${i}`);
          } else {
            const tmp = `${dir}/${who}.${i}.tmp`;
            fs.writeFileSync(tmp, `${who}.${i}`);
            fs.renameSync(tmp, target);
          }
        }
      };
      if (process.argv[2]) {
        hammer(process.argv[2]);
      } else if (!isMainThread) {
        hammer(workerData);
      } else {
        fs.mkdirSync(dir, { recursive: true });
        const exited = (child) => new Promise((resolve, reject) => child.on("exit", resolve).on("error", reject));
        const all = [
          ...["r1", "u1"].map((who) => exited(spawn(process.execPath, [__filename, who], { stdio: "inherit" }))),
          ...["r2", "r3", "u2", "u3"].map((who) => exited(new Worker(__filename, { workerData: who }))),
        ];
        Promise.all(all).then((codes) => {
          assert.deepStrictEqual(codes, [0, 0, 0, 0, 0, 0]);
          const left = fs.readdirSync(dir);
          assert.ok(left.length === 0 || (left.length === 1 && left[0] === "target"), left.join());
          if (left.length) assert.match(fs.readFileSync(target, "utf8"), /^(r[123]|u1)\.[0-9]+$/);
          console.log("unlink race ok");
        });
      }
      JS
      test "$(node /tmp/unlink-race.js)" = "unlink race ok"
  # `fs.rmSync(dir, { recursive: true })` removes the tree (#1049). Its
  # `remove` tries `unlink` before `rmdir`, and WASIX's unlink of a
  # directory dropped it from its directory cache before refusing, so the
  # `rmdir` found nothing, and the call removed nothing and succeeded
  # (wasmer-wasix.patch, from wasmerio/wasmer#7076).
  rm-recursive-passes:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      cat > /tmp/rm.js <<'JS'
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const assert = require("node:assert");
      const tree = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));
        fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
        fs.writeFileSync(path.join(dir, "a", "b", "f"), "x");
        fs.writeFileSync(path.join(dir, "g"), "y");
        fs.mkdirSync(path.join(dir, "empty"));
        return dir;
      };
      for (const remove of [
        (dir) => fs.rmSync(dir, { recursive: true }),
        (dir) => fs.rmSync(dir, { recursive: true, force: true }),
        (dir) => fs.rmdirSync(dir, { recursive: true }),
      ]) {
        const dir = tree();
        remove(dir);
        assert.equal(fs.existsSync(dir), false);
      }
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));
      fs.rmSync(empty, { recursive: true });
      assert.equal(fs.existsSync(empty), false);
      // Unlinking a directory fails and changes nothing.
      const kept = tree();
      assert.throws(() => fs.unlinkSync(kept), { code: "EISDIR" });
      assert.deepStrictEqual(fs.readdirSync(kept).sort(), ["a", "empty", "g"]);
      fs.rmSync(kept, { recursive: true });
      assert.equal(fs.existsSync(kept), false);
      // A directory from the checkout.
      fs.rmSync("go", { recursive: true });
      assert.equal(fs.existsSync("go"), false);
      console.log("rm ok");
      JS
      test "$(node /tmp/rm.js)" = "rm ok"
      test ! -e go
  # A directory renamed out of one that is then removed can be listed
  # (#1079): it kept the old one as its `..`, which `scandir` stats, so
  # `fs.readdirSync` threw EACCES. `ray build` moves its output out of a
  # temporary directory that way.
  moved-dir-passes:
    using: env:bash-node@24
    run: |
      cat > /tmp/moved.js <<'JS'
      const fs = require("node:fs");
      const path = require("node:path");
      const assert = require("node:assert");
      const root = "/tmp/q";
      fs.mkdirSync(root, { recursive: true });
      const m = fs.mkdtempSync(path.join(root, ".b-"));
      fs.mkdirSync(path.join(m, "assets", "deep"), { recursive: true });
      fs.writeFileSync(path.join(m, "assets", "f"), "x");
      fs.mkdirSync(path.join(root, "dist"));
      fs.renameSync(path.join(m, "assets"), path.join(root, "dist", "assets"));
      fs.rmSync(m, { recursive: true, force: true });
      assert.deepStrictEqual(fs.readdirSync(path.join(root, "dist", "assets")).sort(), ["deep", "f"]);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, "dist", "assets", "deep")), []);
      assert.equal(fs.readFileSync(path.join(root, "dist", "assets", "f"), "utf8"), "x");
      console.log("moved ok");
      JS
      test "$(node /tmp/moved.js)" = "moved ok"
  # `fs.cpSync` of a directory (#1075), which Node copies in C++ with
  # `std::filesystem::copy_file`, which copies with `sendfile`: that only
  # sent to sockets, and answered EACCES for a file.
  cp-sync-passes:
    using: env:bash-node@24
    run: |
      mkdir -p /tmp/a/b && echo x > /tmp/a/b/f && echo y > /tmp/a/g
      node -e 'require("fs").cpSync("/tmp/a", "/tmp/c", { recursive: true })'
      test "$(cat /tmp/c/b/f /tmp/c/g)" = "$(printf 'x\ny')"
      node -e 'require("fs").cpSync("go", "/tmp/go", { recursive: true })'
      test "$(cat /tmp/go/dirty/main.go)" = "$(cat go/dirty/main.go)"
  # `os.userInfo()` answers for root (#1077), which oclif asks for when
  # `SHELL` is not set; it threw for want of a user database.
  user-info-passes:
    using: env:bash-node@24
    run: |
      test "$(node -e 'const u = require("os").userInfo(); console.log(u.username, u.uid, u.gid, u.homedir, u.shell)')" = "root 0 0 /root /bin/bash"
      test "$(node -e 'console.log(process.env.SHELL)')" = /bin/bash
  # `fs.linkSync` fails with EPERM and leaves one name (#1052): it used to
  # succeed, and `unlinkSync` of either name then removed nothing.
  links-passes:
    using: env:bash-node@24
    run: |
      cat > /tmp/links.js <<'JS'
      const fs = require("node:fs");
      const assert = require("node:assert");
      fs.writeFileSync("/tmp/n1", "x");
      assert.throws(() => fs.linkSync("/tmp/n1", "/tmp/n2"), { code: "EPERM" });
      assert.equal(fs.existsSync("/tmp/n2"), false);
      fs.unlinkSync("/tmp/n1");
      assert.deepStrictEqual(fs.readdirSync("/tmp").filter((n) => /^n[12]$/.test(n)), []);
      assert.throws(() => fs.linkSync("data.txt", "data2.txt"), { code: "EPERM" });
      assert.throws(() => fs.linkSync("data.txt", "run.sh"), { code: "EEXIST" });
      fs.unlinkSync("data.txt");
      assert.equal(fs.existsSync("data.txt"), false);
      console.log("links ok");
      JS
      test "$(node /tmp/links.js)" = "links ok"
      test ! -e /tmp/n1 && test ! -e data.txt && test ! -e data2.txt
  # `fs.rmdirSync` of a populated checkout directory says ENOTEMPTY (#1057).
  # It said ENOENT for any directory nothing had looked at, so a recursive
  # delete that calls `rmdir` first and recurses on ENOTEMPTY, as
  # hand-written ones do, took the tree for gone and left it.
  rmdir-passes:
    using: env:bash-node@24
    run: |
      cat > /tmp/rmdir.js <<'JS'
      const fs = require("node:fs");
      const path = require("node:path");
      const assert = require("node:assert");
      assert.throws(() => fs.rmdirSync("go/dirty"), { code: "ENOTEMPTY" });
      assert.ok(fs.existsSync("go/dirty/main.go"));
      assert.throws(() => fs.rmdirSync("data.txt"), { code: "ENOTDIR" });
      assert.throws(() => fs.rmdirSync("nothing"), { code: "ENOENT" });
      fs.mkdirSync("/tmp/z/a", { recursive: true });
      assert.throws(() => fs.rmdirSync("/tmp/z"), { code: "ENOTEMPTY" });
      const remove = (dir) => {
        try {
          fs.rmdirSync(dir);
        } catch (e) {
          if (e.code === "ENOENT") return;
          if (e.code !== "ENOTEMPTY") throw e;
          for (const name of fs.readdirSync(dir)) {
            const child = path.join(dir, name);
            if (fs.lstatSync(child).isDirectory()) remove(child);
            else fs.unlinkSync(child);
          }
          fs.rmdirSync(dir);
        }
      };
      remove("ts");
      remove("/tmp/z");
      assert.equal(fs.existsSync("ts"), false);
      assert.equal(fs.existsSync("/tmp/z"), false);
      console.log("rmdir ok");
      JS
      test "$(node /tmp/rmdir.js)" = "rmdir ok"
      test ! -e ts
  # A mode set on a file renamed into place reads back (#1054). Node's C
  # library reads modes by `st_ino`, and a renamed file kept the number of
  # its old path, so this read 644: an atomic write (a temporary file
  # renamed over the target) lost its `chmod`, and so did Git's.
  # Resizing a checked-out file keeps what it had (#1211): it read back as
  # zeros, from truncate(2) and ftruncate(2) alike.
  truncate-checkout-passes:
    using: env:bash-node@24
    run: |
      node -e '
        const fs = require("node:fs");
        fs.truncateSync("data.txt", 7);
        const fd = fs.openSync("run.sh", "r+");
        fs.ftruncateSync(fd, fs.fstatSync(fd).size + 3);
        fs.closeSync(fd);
      '
      test "$(cat data.txt)" = fixture
      test "$(head -c 9 run.sh)" = "#!/bin/sh"
      test "$(wc -c < run.sh)" -eq 22

  renamed-modes-passes:
    using: env:bash-node@24
    run: |
      cat > /tmp/renamed.js <<'JS'
      const fs = require("node:fs");
      const assert = require("node:assert");
      const mode = (st) => (st.mode & 0o7777).toString(8);
      fs.writeFileSync("/tmp/b", "x");
      fs.renameSync("/tmp/b", "/tmp/c");
      fs.chmodSync("/tmp/c", 0o755);
      assert.equal(mode(fs.statSync("/tmp/c")), "755");
      // Over a file that was there.
      fs.writeFileSync("/tmp/t", "old");
      assert.equal(mode(fs.statSync("/tmp/t")), "644");
      fs.writeFileSync("/tmp/t.new", "new");
      fs.renameSync("/tmp/t.new", "/tmp/t");
      fs.chmodSync("/tmp/t", 0o750);
      assert.equal(mode(fs.statSync("/tmp/t")), "750");
      // By a descriptor opened before the rename.
      const fd = fs.openSync("/tmp/o", "w");
      fs.renameSync("/tmp/o", "/tmp/p");
      fs.chmodSync("/tmp/p", 0o711);
      assert.equal(mode(fs.fstatSync(fd)), "711");
      fs.closeSync(fd);
      // In a directory renamed after its file was looked up.
      fs.mkdirSync("/tmp/d");
      fs.writeFileSync("/tmp/d/f", "x");
      assert.equal(mode(fs.statSync("/tmp/d/f")), "644");
      fs.renameSync("/tmp/d", "/tmp/e");
      fs.chmodSync("/tmp/e/f", 0o700);
      assert.equal(mode(fs.statSync("/tmp/e/f")), "700");
      fs.chmodSync("/tmp/e", 0o750);
      assert.equal(mode(fs.statSync("/tmp/e")), "750");
      // A checked-out executable keeps its mode under its new name, and a
      // new file at an old name starts from the default.
      fs.renameSync("run.sh", "run2.sh");
      assert.equal(mode(fs.statSync("run2.sh")), "755");
      fs.writeFileSync("run.sh", "y");
      assert.equal(mode(fs.statSync("run.sh")), "644");
      fs.writeFileSync("/tmp/b", "y");
      assert.equal(mode(fs.statSync("/tmp/b")), "644");
      console.log("renamed modes ok");
      JS
      test "$(node /tmp/renamed.js)" = "renamed modes ok"
      test "$(stat -c %a /tmp/c /tmp/e/f run2.sh)" = "$(printf '755\n700\n755')"
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
  # A server that waits longer than 30 s for its first client still serves
  # it (#1046). The job prints while it waits, or the stall check here
  # (15 s) would end it.
  idle-server-passes:
    using: env:bash-node@24
    timeout: 3m
    services:
      echo:
        using: env:bash-node@24
        run: node -e 'require("net").createServer((c) => c.end("pong")).listen(3002, () => console.log("ready on 3002"))'
        ready: { port: 3002 }
    run: |
      for ((i = 1; i <= 9; i++)); do sleep 5; echo "waited $((i * 5)) s"; done
      test "$(node -e 'let d = ""; require("net").connect(3002, "echo").on("data", (b) => (d += b)).on("end", () => console.log(d))')" = pong
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

  # Isolates on several threads at once calling from WebAssembly into
  # JavaScript, while V8's WebAssembly code GC frees what they dropped
  # (#970, #1039): every call goes through a wasm-to-JS wrapper from V8's
  # process-wide cache and tiers it up, and the modules are made and dropped
  # again, half their signatures shared between threads, half not. V8 13.6
  # could free such a wrapper twice and take the runner down, which the
  # bridge kept from happening by turning the code GC off; V8 13.7 fixed the
  # lookup. Four Workers beside the main thread, four generations of them.
  wasm-wrappers-passes:
    using: env:bash-node@24
    timeout: 5m
    run: |
      cat > /tmp/wrappers.js <<'JS'
      const { Worker, isMainThread, workerData, parentPort } = require("node:worker_threads");

      const leb = (n) => {
        const out = [];
        do {
          let byte = n & 0x7f;
          n >>>= 7;
          if (n) byte |= 0x80;
          out.push(byte);
        } while (n);
        return out;
      };
      const section = (id, body) => [id, ...leb(body.length), ...body];
      const vec = (items) => [...leb(items.length), ...items.flat()];
      const str = (s) => [...leb(s.length), ...Buffer.from(s)];
      const CONST = { 0x7f: [0x41, 0], 0x7e: [0x42, 0], 0x7d: [0x43, 0, 0, 0, 0], 0x7c: [0x44, 0, 0, 0, 0, 0, 0, 0, 0] };
      const TYPES = [0x7f, 0x7e, 0x7d, 0x7c];

      // A module importing one function per signature and exporting a caller for
      // each: signature k takes params spelled by k's base-4 digits.
      function module(signatures) {
        const params = signatures.map((k) => {
          const p = [];
          for (let n = k; n > 0; n = Math.floor(n / 4)) p.push(TYPES[n % 4]);
          return p;
        });
        const types = [...params.map((p) => [0x60, ...vec(p.map((t) => [t])), 0]), [0x60, 0, 0]];
        const caller = types.length - 1;
        const imports = signatures.map((_, i) => [...str("m"), ...str(`f${i}`), 0, ...leb(i)]);
        const funcs = signatures.map(() => leb(caller));
        const exports = signatures.map((_, i) => [...str(`c${i}`), 0, ...leb(signatures.length + i)]);
        const bodies = params.map((p, i) => {
          const code = [0, ...p.flatMap((t) => CONST[t]), 0x10, ...leb(i), 0x0b];
          return [...leb(code.length), ...code];
        });
        return new Uint8Array([
          0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
          ...section(1, vec(types)),
          ...section(2, vec(imports)),
          ...section(3, vec(funcs)),
          ...section(7, vec(exports)),
          ...section(10, vec(bodies)),
        ]);
      }

      function churn(seed, rounds) {
        let calls = 0;
        for (let round = 0; round < rounds; round++) {
          // Half the signatures every thread shares, half its own for the round.
          const signatures = [];
          for (let k = 0; k < 24; k++) signatures.push(k < 12 ? k + 1 : 64 + ((seed * 997 + round * 31 + k) % 4000));
          const imports = { m: {} };
          signatures.forEach((_, i) => (imports.m[`f${i}`] = () => calls++));
          const instance = new WebAssembly.Instance(new WebAssembly.Module(module(signatures)), imports);
          const callers = Object.values(instance.exports);
          for (let i = 0; i < 300; i++) for (const call of callers) call();
          // Garbage, so the instances and their code die.
          let junk = [];
          for (let i = 0; i < 2000; i++) junk.push(new Array(64).fill(i));
          junk = null;
        }
        return calls;
      }

      if (isMainThread) {
        const [workers = 4, generations = 4, rounds = 60] = process.argv.slice(2).map(Number);
        let total = 0;
        const run = (generation) =>
          Promise.all(
            Array.from({ length: workers }, (_, w) =>
              new Promise((resolve, reject) => {
                const worker = new Worker(__filename, { workerData: { seed: generation * workers + w, rounds } });
                worker.on("message", (calls) => (total += calls));
                worker.on("error", reject);
                worker.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
              }),
            ),
          );
        (async () => {
          for (let generation = 0; generation < generations; generation++) {
            // The main thread churns too, beside its workers.
            await Promise.all([run(generation), Promise.resolve().then(() => (total += churn(1000 + generation, rounds / 2)))]);
          }
          console.log(`calls: ${total}`);
        })().catch((error) => {
          console.error(error);
          process.exit(1);
        });
      } else {
        parentPort.postMessage(churn(workerData.seed, workerData.rounds));
      }
      JS
      out="$(node /tmp/wrappers.js 4 4 60)"
      echo "$out"
      test "$out" = "calls: 7776000"

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
  # Node's `fs` reads and sets the runner's file modes (#959): Edge.js is
  # built on a C library that asks /proc/iwci (wasix-libc-modes.patch).
  modes-passes:
    using: env:bash-node@24
    run: |
      cat > /tmp/modes.js <<'JS'
      const fs = require("node:fs");
      const assert = require("node:assert");
      const mode = (st) => (st.mode & 0o7777).toString(8);
      // The checkout: git's executable bit, and the default.
      assert.equal(mode(fs.statSync("run.sh")), "755");
      assert.equal(mode(fs.statSync("data.txt")), "644");
      assert.equal(mode(fs.statSync(".")), "755");
      fs.writeFileSync("/tmp/f", "secret");
      assert.equal(mode(fs.statSync("/tmp/f")), "644");
      fs.chmodSync("/tmp/f", 0o600);
      assert.equal(mode(fs.statSync("/tmp/f")), "600");
      assert.equal(mode(fs.lstatSync("/tmp/f")), "600");
      // By descriptor: a file this process created, one the record has, and
      // one with the default.
      const fd = fs.openSync("/tmp/f", "r");
      assert.equal(mode(fs.fstatSync(fd)), "600");
      fs.closeSync(fd);
      const run = fs.openSync("run.sh", "r");
      assert.equal(mode(fs.fstatSync(run)), "755");
      fs.closeSync(run);
      const data = fs.openSync("data.txt", "r");
      assert.equal(mode(fs.fstatSync(data)), "644");
      fs.closeSync(data);
      // Created with a mode, less the umask; set through a descriptor.
      fs.writeFileSync("/tmp/g", "x", { mode: 0o600 });
      assert.equal(mode(fs.statSync("/tmp/g")), "600");
      fs.mkdirSync("/tmp/d", { mode: 0o700 });
      assert.equal(mode(fs.statSync("/tmp/d")), "700");
      const h = fs.openSync("/tmp/h", "w");
      fs.fchmodSync(h, 0o640);
      assert.equal(mode(fs.fstatSync(h)), "640");
      fs.closeSync(h);
      assert.equal(mode(fs.statSync("/tmp/h")), "640");
      assert.equal(mode(fs.statSync(fs.mkdtempSync("/tmp/t-"))), "700");
      // A copy keeps its source's mode; a symlink reads 777 by lstat.
      fs.copyFileSync("run.sh", "/tmp/run2.sh");
      assert.equal(mode(fs.statSync("/tmp/run2.sh")), "755");
      process.umask(0o077);
      fs.writeFileSync("/tmp/u", "x");
      assert.equal(mode(fs.statSync("/tmp/u")), "600");
      fs.symlinkSync("/tmp/f", "/tmp/l");
      assert.equal(mode(fs.lstatSync("/tmp/l")), "777");
      assert.equal(mode(fs.statSync("/tmp/l")), "600");
      assert.throws(() => fs.chmodSync("/tmp/nope", 0o600), { code: "ENOENT" });
      fs.accessSync("run.sh", fs.constants.X_OK);
      console.log("modes ok");
      JS
      node /tmp/modes.js
      # The shell's commands and Node's see the same record.
      test "$(stat -c %a /tmp/f /tmp/h)" = "$(printf '600\n640')"
      chmod 604 /tmp/f
      test "$(node -p '(require("fs").statSync("/tmp/f").mode & 0o777).toString(8)')" = 604
  # A parent asking a Worker about itself. Heap statistics, CPU use and
  # reports are run on the worker's loop; Edge.js freed the request when the
  # engine would not also interrupt the worker's JavaScript for it, so
  # `node` crashed, hung or got ERR_WORKER_NOT_RUNNING (#1006,
  # edgejs-request-interrupt.patch). `cpuUsage()` then still never settled:
  # libuv's thread CPU time is not there on WASIX, and the failure never
  # reached the promise (edgejs-worker-cpu-usage.patch). It counts from the
  # worker's start: a worker that spun for a second has used some of it (all
  # of it on a quiet host) and nothing like what a reused host thread had.
  worker-introspection-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 1m
    run: |
      cat > /tmp/ask.js <<'JS'
      const { Worker } = require("node:worker_threads");
      const assert = require("node:assert");
      (async () => {
        for (const body of ["setInterval(() => {}, 1000)", "const e = Date.now() + 1000; while (Date.now() < e) {} setInterval(() => {}, 1000)"]) {
          const w = new Worker(body, { eval: true });
          await new Promise((r) => w.once("online", r));
          const heap = await w.getHeapStatistics();
          assert.ok(heap.total_heap_size > 0);
          assert.equal(process.report.getReport().workers.length, 1);
          const cpu = await w.cpuUsage();
          assert.ok(Number.isInteger(cpu.user) && Number.isInteger(cpu.system), JSON.stringify(cpu));
          assert.ok(cpu.user < 30e6, JSON.stringify(cpu));
          if (body.startsWith("const e")) assert.ok(cpu.user > 50e3, JSON.stringify(cpu));
          const since = await w.cpuUsage(cpu);
          assert.ok(since.user >= 0 && since.user < 30e6, JSON.stringify(since));
          await w.terminate();
        }
        console.log("introspection ok");
      })();
      JS
      test "$(node /tmp/ask.js)" = "introspection ok"
  # The same calls, and event loop utilisation, while workers end by
  # themselves (#938): each reads the worker's env, as the stop once did, now
  # under the worker's mutex (edgejs-worker-env-readers.patch). Polling from
  # creation also asks workers that refuse tasks (not up yet, or ending),
  # which wrote into a freed task thousands of times a run until
  # edgejs-worker-task-free.patch (#1070). A smoke test: the windows are
  # narrow, and the write only broke something when another thread had the
  # block by then (about one job in 25 with twelve copies at once).
  worker-readers-passes:
    using: env:bash-node@24
    needs: [node-passes]
    memory: 2GiB
    timeout: 3m
    run: |
      cat > /tmp/readers.js <<'JS'
      const { Worker } = require("node:worker_threads");
      let done = 0;
      const total = 200;
      function one(i) {
        const w = new Worker("setTimeout(() => {}, " + (i % 5) + ")", { eval: true });
        const poke = () => {
          w.getHeapStatistics().catch(() => {});
          try { w.cpuUsage?.().catch(() => {}); } catch {}
          try { w.performance.eventLoopUtilization(); } catch {}
          if (i % 20 === 0) process.report.getReport();
        };
        w.on("online", poke);
        const timer = setInterval(poke, 1);
        w.on("exit", () => {
          clearInterval(timer);
          if (++done === total) console.log("readers ok");
          else if (i + 4 < total) one(i + 4);
        });
      }
      for (let i = 0; i < 4; i++) one(i);
      JS
      test "$(node /tmp/readers.js)" = "readers ok"
  # `vm.Script#createCachedData()` (#1007): the bridge built its Buffer with
  # the global `Buffer.from`, inside a call that could not reach back into
  # Edge.js, so renewing Buffer's pool there left it empty and the next
  # pooled allocation threw (`Invalid typed array length`), every run. It
  # now makes the Buffer itself, without the pool.
  cached-data-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 2m
    run: |
      cat > /tmp/cache.js <<'JS'
      const vm = require("node:vm");
      const assert = require("node:assert");
      for (let i = 0; i < 200; i++) {
        const data = new vm.Script(`(function f${i}(a) { return a + ${i}; })`).createCachedData();
        assert.ok(Buffer.isBuffer(data) && data.length > 0);
      }
      assert.equal(Buffer.from("x".repeat(416)).length, 416);
      const source = "(function g(a) { return a * 2; })";
      const script = new vm.Script(source, { cachedData: new vm.Script(source).createCachedData() });
      assert.equal(script.cachedDataRejected, false);
      assert.equal(script.runInThisContext()(21), 42);
      console.log("cached data ok");
      JS
      for i in 1 2 3; do test "$(node /tmp/cache.js)" = "cached data ok"; done
  # JavaScript that V8 runs inside a bridge call reaches Edge.js's own
  # functions (#1090): a `toString` the bridge coerces, a getter on a
  # sandbox `vm.createContext` copies, `Error.prepareStackTrace` for a
  # SyntaxError, the unhandled-rejection handler. Those imports did not
  # lend the guest's store, so each such call returned `undefined` without
  # running (`os.hostname()` then threw). Every call here goes through one
  # of them; the run's own stderr must not say "no store lent" either.
  store-lending-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 2m
    run: |
      cat > /tmp/lend.js <<'JS'
      const assert = require("node:assert");
      const os = require("node:os");
      const vm = require("node:vm");
      const fs = require("node:fs");
      const host = os.hostname();
      // A call that was dropped returned undefined, which os.hostname() throws on.
      const probe = () => { try { return os.hostname(); } catch (e) { return "threw " + e.code; } };
      // napi_coerce_to_string
      process.env.IWCI_LEND = { toString: probe };
      assert.equal(process.env.IWCI_LEND, host);
      // unofficial_napi_contextify_make_context
      const sandbox = { get host() { return probe(); } };
      vm.createContext(sandbox);
      assert.equal(vm.runInContext("host", sandbox), host);
      // unofficial_napi_contextify_compile_function and contains_module_syntax
      fs.writeFileSync("/tmp/bad.js", "module.exports = {;\n");
      const seen = [];
      Error.prepareStackTrace = (error) => (seen.push(probe()), "stack of " + error.name);
      assert.throws(() => require("/tmp/bad.js"), SyntaxError);
      Error.prepareStackTrace = undefined;
      assert.ok(seen.length > 0 && seen.every((h) => h === host), JSON.stringify(seen));
      console.log("lending ok");
      JS
      test "$(node /tmp/lend.js)" = "lending ok"
      # unofficial_napi_module_wrap_create, which no longer formats the
      # stack of a module that does not parse (it sets the arrow alone, as
      # Node does, #1143), so the stack is formatted when it is read.
      printf 'export const a = {;\n' > /tmp/bad.mjs
      cat > /tmp/lend.mjs <<'JS'
      import assert from "node:assert";
      import os from "node:os";
      const probe = () => { try { return os.hostname(); } catch (e) { return "threw " + e.code; } };
      const seen = [];
      Error.prepareStackTrace = (error) => (seen.push(probe()), "stack of " + error.name);
      const error = await import("/tmp/bad.mjs").then(() => null, (e) => e);
      assert.ok(error instanceof SyntaxError);
      assert.deepEqual(seen, []);
      assert.equal(error.stack, "stack of SyntaxError");
      Error.prepareStackTrace = undefined;
      assert.ok(seen.length > 0 && seen.every((h) => h === os.hostname()), JSON.stringify(seen));
      console.log("lending ok");
      JS
      test "$(node /tmp/lend.mjs)" = "lending ok"
      # napi_reject_deferred: the binding rejects at once, before anything
      # handles the promise, so the unhandled-rejection handler runs inside
      # the call and records the async context, which is Edge.js's to give
      # (`fs.promises.access` of a missing file did this on every call).
      cat > /tmp/reject.js <<'JS'
      const { internalBinding } = require("internal/test/binding");
      const { AsyncLocalStorage } = require("node:async_hooks");
      const fs = internalBinding("fs");
      const als = new AsyncLocalStorage();
      const seen = [];
      process.on("unhandledRejection", (error) => seen.push(`${als.getStore()} ${error.code}`));
      als.run("first", () => fs.access("/missing", 0, fs.kUsePromises));
      als.run("second", () => setTimeout(() => fs.access("/missing", 0, fs.kUsePromises), 1));
      require("node:fs/promises").access("/missing").catch(() => {});
      setTimeout(() => console.log(seen.join(", ")), 50);
      JS
      test "$(node --no-warnings --expose-internals /tmp/reject.js)" = "first ENOENT, second ENOENT"
  # Edge.js's built-ins come from a code cache the runner made with its own
  # V8 (#996, iwci-runtime/src/builtins.rs), not from source, in `node`,
  # in worker threads and in ES modules; the job can read the file but not
  # change it, and a cache a job records for itself stays in its own files.
  builtins-cache-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 2m
    run: |
      cache=/usr/local/lib/iwci/node/edge.builtins
      test -s "$cache"
      if echo x 2>/dev/null >"$cache"; then echo "the cache is writable" >&2; exit 1; fi
      # Found for each built-in (`hit`), and taken by V8 (no `rejected`).
      count() { grep -c "^\[edge-bytecode-cache\] builtin-$1" || true; }
      out="$(EDGE_BYTECODE_CACHE_TRACE=1 node -e 0 2>&1)"
      test "$(count hit <<<"$out")" -gt 20
      test "$(count miss <<<"$out")$(count rejected <<<"$out")" = 00
      out="$(EDGE_BYTECODE_CACHE_TRACE=1 node -e 'new (require("node:worker_threads").Worker)("0", { eval: true })' 2>&1)"
      test "$(count miss <<<"$out")$(count rejected <<<"$out")" = 00
      printf 'import "node:fs";\n' >/tmp/m.mjs
      out="$(EDGE_BYTECODE_CACHE_TRACE=1 node /tmp/m.mjs 2>&1)"
      test "$(count miss <<<"$out")$(count rejected <<<"$out")" = 00
      # A job's own recording writes its own file, and leaves the runner's.
      before="$(sha256sum <"$cache")"
      EDGE_BUILTINS_CACHE=/tmp/mine EDGE_BUILTINS_CACHE_RECORD=1 node -e 'require("node:http2")'
      test -s /tmp/mine
      test "$(sha256sum <"$cache")" = "$before"
  # Node's module compile cache (edgejs-compile-cache.patch), which Edge.js
  # stubbed out: the first `node` writes the engine's code cache of each
  # module it compiles, CommonJS and ES, in workers too, and the next takes
  # every one. A changed source or a damaged entry is a miss, never a crash,
  # and a directory that cannot be made is no cache, never an error.
  compile-cache-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 3m
    run: |
      # A failing step says which it was, and what it got (#1249).
      trap 'echo "compile-cache-passes: line $LINENO exited $?: $BASH_COMMAND" >&2' ERR
      same() { [[ "$1" == "$2" ]] || { printf 'got:  %s\nwant: %s\n' "$1" "$2" >&2; return 1; }; }
      mkdir -p /tmp/cc/app && cd /tmp/cc/app
      printf 'module.exports = (a) => a + 1;\n' >dep.js
      printf 'export const twice = (a) => a * 2;\n' >dep.mjs
      printf 'require("node:worker_threads").parentPort.postMessage(require("./dep.js")(41));\n' >worker.js
      cat >main.js <<'JS'
      const assert = require("node:assert");
      const { Worker } = require("node:worker_threads");
      assert.equal(require("./dep.js")(1), 2);
      import("./dep.mjs").then(({ twice }) => {
        assert.equal(twice(2), 4);
        new Worker(__dirname + "/worker.js").once("message", (n) => {
          assert.equal(n, 42);
          console.log(require("node:module").getCompileCacheDir());
        });
      });
      JS
      # What the engine did with each of this tree's modules, as
      # NODE_DEBUG_NATIVE=COMPILE_CACHE reports it.
      # `node`'s own errors go to the job's stderr, not into the comparison.
      report() {
        local log
        log="$(NODE_DEBUG_NATIVE=COMPILE_CACHE node main.js 2>&1 >/dev/null)" ||
          printf 'node main.js exited %s:\n%s\n' "$?" "$(grep -v '^\[compile cache\]' <<<"$log")" >&2
        sed -n 's#.*V8 code cache for \([A-Za-z]*\) \(file://\)\{0,1\}/tmp/cc/[a-z]*/\([a-z.]*\) was \([a-z ]*\),.*#\1 \3 \4#p' <<<"$log" |
          sort | tr '\n' ';'
      }
      test "$(node -p 'require("node:module").getCompileCacheDir()')" = undefined
      export NODE_COMPILE_CACHE=/tmp/cc/cache
      dir="$(node main.js)"
      case "$dir" in /tmp/cc/cache/v24.*-wasm32-*-0) ;; *) echo "unexpected cache directory: $dir" >&2; exit 1 ;; esac
      test "$(find "$dir" -type f | wc -l)" -ge 4
      # The worker requires dep.js after the main thread has written it.
      hits="CommonJS dep.js accepted;CommonJS dep.js accepted;CommonJS main.js accepted;CommonJS worker.js accepted;ESM dep.mjs accepted;"
      same "$(report)" "$hits"
      # A changed module is compiled again and its entry replaced.
      printf 'module.exports = (a) => a + 1; // changed\n' >dep.js
      same "$(report)" "CommonJS dep.js accepted;CommonJS dep.js not initialized;CommonJS main.js accepted;CommonJS worker.js accepted;ESM dep.mjs accepted;"
      same "$(report)" "$hits"
      # A damaged entry is a miss.
      for f in "$dir"/*; do printf 'garbage' | dd of="$f" bs=1 seek=60 conv=notrunc 2>/dev/null; done
      same "$(report)" "CommonJS dep.js accepted;CommonJS dep.js not initialized;CommonJS main.js not initialized;CommonJS worker.js not initialized;ESM dep.mjs not initialized;"
      same "$(report)" "$hits"
      # An entry that cannot be written is no error (each is a directory now).
      for f in "$dir"/*; do rm "$f" && mkdir -p "$f/in-the-way"; done
      test "$(node main.js)" = "$dir"
      # Workers compiling the same modules at once write the same entries,
      # which renaming over them would turn into an aborted runner (#1092).
      mkdir /tmp/cc/many
      for i in $(seq 300); do printf 'module.exports = %d;\n' "$i" >"/tmp/cc/many/m$i.js"; done
      cat >/tmp/cc/many.js <<'JS'
      const { Worker } = require("node:worker_threads");
      const code = 'let s = 0; for (let i = 1; i <= 300; i++) s += require("/tmp/cc/many/m" + i + ".js"); require("node:worker_threads").parentPort.postMessage(s);';
      for (let w = 0; w < 4; w++) new Worker(code, { eval: true }).once("message", (s) => { if (s !== 45150) { console.error("worker " + w + " summed " + s); process.exit(1); } });
      JS
      node /tmp/cc/many.js
      same "$(NODE_DEBUG_NATIVE=COMPILE_CACHE node /tmp/cc/many.js 2>&1 | grep -c 'many/m[0-9]*\.js was accepted')" 1200
      # The API.
      unset NODE_COMPILE_CACHE
      node -e '
        const assert = require("node:assert");
        const fs = require("node:fs");
        const m = require("node:module");
        const { ENABLED, ALREADY_ENABLED, FAILED } = m.constants.compileCacheStatus;
        fs.writeFileSync("/tmp/cc/file", "");
        const failed = m.enableCompileCache("/tmp/cc/file/sub");
        assert.equal(failed.status, FAILED, JSON.stringify(failed));
        assert.match(failed.message, /^Cannot create cache directory/);
        assert.equal(m.getCompileCacheDir(), undefined);
        const result = m.enableCompileCache("/tmp/cc/api");
        assert.deepEqual([result.status, result.directory], [ENABLED, "/tmp/cc/api"]);
        assert.ok(m.getCompileCacheDir().startsWith("/tmp/cc/api/v24."));
        assert.equal(m.enableCompileCache("/tmp/cc/other").status, ALREADY_ENABLED);
        require("/tmp/cc/app/dep.js");
        m.flushCompileCache();
        assert.equal(fs.readdirSync(m.getCompileCacheDir()).length, 1);
      '
      test "$(NODE_DISABLE_COMPILE_CACHE=1 NODE_COMPILE_CACHE=/tmp/cc/off node main.js)" = undefined
      test ! -e /tmp/cc/off
      # A directory that cannot be made (here, under a file) is no cache, and
      # no error. Not under /opt: since #1087 a job can write anywhere in its
      # own file system, the environment's directories included.
      test "$(NODE_COMPILE_CACHE=/tmp/cc/file/sub node main.js)" = undefined
      # A portable cache is keyed by paths relative to it, so it moves with
      # the tree.
      mkdir /tmp/cc/one
      cp /tmp/cc/app/*.js /tmp/cc/app/*.mjs /tmp/cc/one/
      NODE_COMPILE_CACHE=/tmp/cc/one/.cache NODE_COMPILE_CACHE_PORTABLE=1 node /tmp/cc/one/main.js >/dev/null
      mv /tmp/cc/one /tmp/cc/two
      cd /tmp/cc/two
      same "$(NODE_COMPILE_CACHE=/tmp/cc/two/.cache NODE_COMPILE_CACHE_PORTABLE=1 report)" "$hits"
  # CPU time is CPU time (#1038): the C library read the monotonic clock
  # (days, and a sleep counted as work), and the host's clocks would be the
  # whole runner's. Now `process.cpuUsage()` starts near zero, grows with
  # work and not with sleep, and `process.threadCpuUsage()` works.
  # wasix-libc-getrusage.patch, and the runner's clocks (stall.rs
  # `guest_cpu`). bash and coreutils keep Wasmer's own C library, so the
  # shell's `time` and `times` are still wrong.
  cpu-time-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 1m
    run: |
      cat > /tmp/cpu.js <<'JS'
      const assert = require("node:assert");
      const show = (x) => JSON.stringify(x);
      const start = process.cpuUsage();
      assert.ok(start.user > 0 && start.user < 30e6, show(start));
      const spinUntil = Date.now() + 500;
      while (Date.now() < spinUntil) {}
      const spun = process.cpuUsage(start);
      assert.ok(spun.user > 20e3 && spun.user < 30e6, show(spun));
      const thread = process.threadCpuUsage();
      assert.ok(thread.user > 20e3 && thread.user <= process.cpuUsage().user, show(thread));
      setTimeout(() => {
        const slept = process.cpuUsage(start);
        assert.ok(slept.user - spun.user < 250e3, show({ spun, slept }));
        console.log("cpu time ok");
      }, 500);
      JS
      test "$(node /tmp/cpu.js)" = "cpu time ok"
  # Numeric open flags with no access mode open read-only, as Node's
  # O_RDONLY is 0 (#1045). WASI's O_RDONLY is a bit of its own, and the C
  # library refused them with EINVAL, so Go's WebAssembly runtime (which
  # esbuild-wasm is) could open nothing. edgejs-open-flags.patch.
  open-flags-passes:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      cat > /tmp/open.js <<'JS'
      const fs = require("node:fs");
      const assert = require("node:assert");
      const { O_CREAT, O_WRONLY, O_TRUNC } = fs.constants;
      fs.closeSync(fs.openSync("data.txt", 0));
      assert.equal(fs.readFileSync("data.txt", { flag: 0, encoding: "utf8" }), "fixture line\n");
      assert.equal(fs.readFileSync("data.txt", { flag: 0 }).toString(), "fixture line\n");
      fs.closeSync(fs.openSync("/tmp/made", O_CREAT));
      assert.ok(fs.existsSync("/tmp/made"));
      const fd = fs.openSync("/tmp/w", O_CREAT | O_WRONLY | O_TRUNC);
      fs.writeSync(fd, "w");
      fs.closeSync(fd);
      assert.equal(fs.readFileSync("/tmp/w", "utf8"), "w");
      fs.open("data.txt", 0, 0, (err, fd) => {
        assert.ifError(err);
        fs.closeSync(fd);
        fs.promises.open("data.txt", 0).then(async (handle) => {
          assert.equal(await handle.readFile("utf8"), "fixture line\n");
          await handle.close();
          console.log("open flags ok");
        });
      });
      JS
      test "$(node /tmp/open.js)" = "open flags ok"
  # `structuredClone` and `postMessage` keep integer-like keys (an OpenAPI
  # document's responses), shared references and cycles, and leave
  # non-enumerable properties behind (#1048); a document of tens of
  # thousands of objects clones, which the native copy could not.
  # edgejs-structured-clone.patch.
  structured-clone-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 2m
    run: |
      cat > /tmp/clone.js <<'JS'
      const assert = require("node:assert");
      const v8 = require("node:v8");
      const viaV8 = (value) => v8.deserialize(v8.serialize(value));
      const doc = { paths: {} };
      for (let i = 0; i < 5000; i++) {
        doc.paths["/p" + i] = { get: { responses: { 200: { d: i }, 404: { d: -i } } } };
      }
      const values = [
        { 200: 1, a: 2 },
        { 0: "x" },
        { 4294967294: 2, 4294967295: 1 },
        [1, { 7: 2 }],
        new Map([[1, { 5: 5 }]]),
        Object.assign(Object.create(null), { 3: "n" }),
        doc,
      ];
      for (const value of values) assert.deepStrictEqual(structuredClone(value), viaV8(value));
      const shared = { s: 1 };
      const both = structuredClone({ p: shared, q: shared });
      assert.ok(both.p === both.q);
      const cycle = { n: 1 };
      cycle.self = cycle;
      const cycled = structuredClone(cycle);
      assert.ok(cycled.self === cycled);
      assert.deepStrictEqual(Object.keys(structuredClone(Object.defineProperty({ v: 1 }, "h", { value: 2 }))), ["v"]);
      // With a Blob in it, the value takes the native copy.
      const withBlob = structuredClone({ 200: new Blob(["hi"]), p: shared, q: shared, cycle });
      assert.ok(withBlob[200] instanceof Blob && withBlob.p === withBlob.q);
      assert.ok(withBlob.cycle.self === withBlob.cycle);
      const { port1, port2 } = new MessageChannel();
      port1.once("message", (data) => {
        assert.deepStrictEqual(data.keyed, { 200: 1, a: 2 });
        assert.ok(data.p === data.q && data.cycle.self === data.cycle);
        port1.close();
        withBlob[200].text().then((text) => {
          assert.equal(text, "hi");
          console.log("clone ok");
        });
      });
      port2.postMessage({ keyed: { 200: 1, a: 2 }, p: shared, q: shared, cycle });
      JS
      test "$(node /tmp/clone.js)" = "clone ok"
  # A child's exit is seen while a timer is pending (#1065). WASIX sends no
  # SIGCHLD, so libuv asks after each poll, and a child's output ends before
  # its exit can be read: with a timer pending, the poll after the end of
  # its output slept until the timer, and `spawnSync` with a timeout
  # returned when the timeout ran out. edgejs-child-exit-poll.patch.
  child-exit-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 2m
    run: |
      cat > /tmp/exit.js <<'JS'
      const { spawn, spawnSync } = require("node:child_process");
      const assert = require("node:assert");
      // The child's output ends a second before it exits, as when a process
      // closes its stdio first.
      const child = ["-e", "require('node:fs').closeSync(1); require('node:fs').closeSync(2); setTimeout(() => process.exit(0), 1000)"];
      let t0 = Date.now();
      const r = spawnSync(process.execPath, child, { timeout: 20000 });
      const sync = Date.now() - t0;
      assert.equal(r.status, 0);
      assert.ok(sync < 10000, `spawnSync took ${sync} ms`);
      // A timer pending in the parent must not hold back `exit` either.
      const pending = setTimeout(() => {}, 30000);
      t0 = Date.now();
      spawn(process.execPath, child).on("exit", (code) => {
        const async = Date.now() - t0;
        clearTimeout(pending);
        assert.equal(code, 0);
        assert.ok(async < 10000, `exit took ${async} ms`);
        console.log("child exit ok");
      });
      JS
      test "$(node /tmp/exit.js)" = "child exit ok"
  # A `node` starts more children over its life than a job may have at
  # once (#1082): the 512th `execFileSync` used to fail with EPERM.
  spawn-many-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 5m
    run: |
      node -e '
      const { execFileSync } = require("node:child_process");
      for (let i = 1; i <= 600; i++) execFileSync("true");
      console.log("600 spawns ok");
      ' | grep -qx '600 spawns ok'
  # A detached child outlives the `node` that started it (#1105): node's
  # exit sent it SIGQUIT. It does not outlive the job, though, which
  # left-running-stopped-passes checks.
  detached-child-passes:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      node -e '
      const { spawn } = require("node:child_process");
      const once = "sleep 1; echo n > /tmp/n";
      spawn("bash", ["-c", once], { detached: true, stdio: "ignore" }).unref();
      const loop = "i=0; while :; do i=$((i + 1)); echo $i > /tmp/workflow/left-node; sleep 0.1; done";
      spawn("bash", ["-c", loop], { detached: true, stdio: "ignore" }).unref();
      '
      sleep 3
      test "$(cat /tmp/n)" = n
      test -s /tmp/workflow/left-node
  left-running-stopped-passes:
    using: env:bash-node@24
    needs: [detached-child-passes]
    run: |
      before="$(cat /tmp/workflow/left-node)"
      sleep 3
      test "$(cat /tmp/workflow/left-node)" = "$before"
  # A `node` knows its parent, and a child it starts knows the `node`
  # (#1107): `process.ppid` and bash's `$PPID` were 0.
  ppid-passes:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      node -e 'console.log(process.ppid)' > /tmp/ppid
      test "$(cat /tmp/ppid)" = "$$"
      node -e '
      const { execFileSync } = require("node:child_process");
      const ppid = execFileSync("bash", ["-c", "echo $PPID"], { encoding: "utf8" }).trim();
      console.log(ppid === String(process.pid) ? "ok" : `${ppid} is not ${process.pid}`);
      ' > /tmp/child
      test "$(cat /tmp/child)" = ok
  # A child's exit status reaches a `node` whole (#1053): spawnSync and
  # `exit` read every status from 80 up as 79.
  exit-status-passes:
    using: env:bash-node@24
    needs: [node-passes]
    run: |
      cat > /tmp/status.js <<'JS'
      const { spawn, spawnSync } = require("node:child_process");
      const assert = require("node:assert");
      for (const c of [1, 79, 80, 128, 255]) {
        assert.equal(spawnSync("bash", ["-c", `exit ${c}`]).status, c);
      }
      assert.equal(spawnSync("git", ["rev-parse", "--verify", "no-such-ref"]).status, 128);
      spawn("bash", ["-c", "exit 129"]).on("exit", (code) => {
        assert.equal(code, 129);
        console.log("status ok");
      });
      JS
      test "$(node /tmp/status.js)" = "status ok"
  # postMessage of a large value arrives whole, every way a message goes
  # (#1061): Edge.js copied each value through N-API first and kept every
  # handle of the copy until the call returned, so a value of a few thousand
  # objects ran out of the bridge's handles and the message was lost without
  # an error, or the receiver waited for it until the stall check. And a
  # copied buffer bigger than the receiver's guest heap had spare failed to
  # read (a `messageerror`), now and then. edgejs-post-message.patch, and
  # vendor/wasmer-napi lending the store to message reads.
  post-message-passes:
    using: env:bash-node@24
    needs: [node-passes]
    timeout: 5m
    memory: 4GiB
    run: |
      cat > /tmp/post.js <<'JS'
      const { Worker, MessageChannel, isMainThread, parentPort } = require("node:worker_threads");
      const assert = require("node:assert");
      const makeDoc = (n) => {
        const doc = { paths: {} };
        for (let i = 0; i < n; i++) doc.paths["/p" + i] = { get: { responses: { 200: { d: i } } } };
        return doc;
      };
      const checkDoc = (got, n) => {
        assert.equal(Object.keys(got.paths).length, n);
        assert.equal(got.paths["/p" + (n - 1)].get.responses[200].d, n - 1);
      };
      if (!isMainThread) {
        parentPort.on("message", (m) => {
          if (m.kind === "doc") {
            checkDoc(m.doc, m.n);
            parentPort.postMessage({ kind: "doc", doc: makeDoc(m.n) });
          } else if (m.kind === "buf") {
            assert.equal(new Uint8Array(m.buf)[m.size - 1], 7);
            const buf = new ArrayBuffer(m.size);
            new Uint8Array(buf)[m.size - 1] = 9;
            parentPort.postMessage({ kind: "buf", buf }, m.transfer ? [buf] : []);
          } else if (m.kind === "burst") {
            for (let i = 0; i < m.count; i++) parentPort.postMessage({ kind: "tick" });
          } else {
            parentPort.close();
          }
        });
        parentPort.on("messageerror", (e) => { throw e; });
        return;
      }
      const once = (port, kind) => new Promise((resolve, reject) => {
        const onMessage = (m) => {
          if (kind !== undefined && m.kind !== kind) return;
          port.off("message", onMessage);
          resolve(m);
        };
        port.on("message", onMessage);
        port.once("messageerror", reject);
      });
      (async () => {
        const n = 25000; // 100,000 objects
        let { port1, port2 } = new MessageChannel();
        let got = once(port1);
        port2.postMessage(makeDoc(n));
        checkDoc(await got, n);
        // With something to transfer, the value takes the walks.
        const buf = new ArrayBuffer(16);
        got = once(port1);
        port2.postMessage({ doc: makeDoc(8000), buf }, [buf]);
        checkDoc((await got).doc, 8000);
        const inner = new MessageChannel();
        got = once(port1);
        port2.postMessage({ doc: makeDoc(8000), port: inner.port1, again: inner.port1 }, [inner.port1]);
        const withPort = await got;
        checkDoc(withPort.doc, 8000);
        assert.ok(withPort.port === withPort.again);
        withPort.port.close();
        inner.port2.close();
        assert.throws(() => port2.postMessage({ f() {} }), { name: "DataCloneError" });
        port1.close();
        const worker = new Worker(__filename);
        worker.on("messageerror", (e) => { throw e; });
        got = once(worker, "doc");
        worker.postMessage({ kind: "doc", n, doc: makeDoc(n) });
        checkDoc((await got).doc, n);
        for (const size of [16 << 20, 64 << 20]) {
          for (const transfer of [false, true]) {
            const out = new ArrayBuffer(size);
            new Uint8Array(out)[size - 1] = 7;
            got = once(worker, "buf");
            worker.postMessage({ kind: "buf", size, transfer, buf: out }, transfer ? [out] : []);
            const back = (await got).buf;
            assert.equal(back.byteLength, size);
            assert.equal(new Uint8Array(back)[size - 1], 9);
          }
        }
        let ticks = 0;
        await new Promise((resolve) => {
          worker.on("message", (m) => { if (m.kind === "tick" && ++ticks === 100000) resolve(); });
          worker.postMessage({ kind: "burst", count: 100000 });
        });
        worker.postMessage({ kind: "done" });
        console.log("post ok");
      })();
      JS
      test "$(node /tmp/post.js)" = "post ok"
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
  # Git from Node, as a test suite runs it (plugingen's): synchronously
  # with a working directory, and asynchronously with standard input.
  git-passes:
    using: env:bash-node@24
    run: |
      cat > /tmp/git.mjs <<'JS'
      import { execFileSync, spawn } from "node:child_process";
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-"));
      const git = (...args) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
          cwd: dir,
          encoding: "utf8",
        }).trim();
      git("init", "-q", "-b", "main");
      fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
      git("add", "a.txt");
      git("commit", "-qm", "first");
      const blob = await new Promise((resolve, reject) => {
        const child = spawn("git", ["hash-object", "-w", "--stdin"], { cwd: dir });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
        child.stdin.end("two\n");
      });
      if (git("cat-file", "-p", blob) !== "two") throw new Error("blob");
      if (git("log", "--format=%s") !== "first") throw new Error("log");
      try {
        git("rev-parse", "--verify", "-q", "nothing");
        throw new Error("rev-parse succeeded");
      } catch (error) {
        if (error.status !== 1) throw error;
      }
      console.log("ok");
      JS
      test "$(node /tmp/git.mjs)" = ok
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
  # Git is on PATH here too.
  git-passes:
    using: env:go@@MINOR@
    run: |
      git init -q -b main /tmp/r
      git -C /tmp/r status --short --branch | grep -q '^## No commits yet on main$'
  # `os/exec` starts more children over a program's life than a job may
  # have at once (#1082): the 512th used to fail with "Operation not
  # permitted", which is what stopped `go vet` on a large module.
  spawn-many-passes:
    using: env:go@@MINOR@
    timeout: 10m
    run: |
      mkdir -p /tmp/spawn && cd /tmp/spawn
      printf 'module spawn\n\ngo 1.21\n' > go.mod
      cat > main.go <<'GO'
      package main

      import (
      	"fmt"
      	"os"
      	"os/exec"
      )

      func main() {
      	for i := 1; i <= 600; i++ {
      		if err := exec.Command("true").Run(); err != nil {
      			fmt.Printf("spawn %d: %v\n", i, err)
      			os.Exit(1)
      		}
      	}
      	fmt.Println("600 spawns ok")
      }
      GO
      go build -o spawn .
      test "$(./spawn)" = "600 spawns ok"
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
  # A server started with `&` that waits longer than 30 s for its first
  # client, and then longer than 30 s for that client's request, still
  # answers (#1046): a blocking accept and recv gave up after 30 s.
  idle-server-passes:
    using: env:python@3.13
    timeout: 5m
    run: |
      python - <<'PY' &
      import socket
      s = socket.create_server(("127.0.0.1", 7000))
      c, _ = s.accept()
      c.sendall(c.recv(16).upper())
      PY
      server=$!
      sleep 45
      python - <<'PY'
      import socket, time
      c = socket.create_connection(("127.0.0.1", 7000))
      time.sleep(35)
      c.sendall(b"ping")
      assert c.recv(16) == b"PING"
      PY
      wait "$server"
  # One whose client never comes is still ended by the job's timeout, and a
  # service waiting for one by the job's end.
  idle-server-timeout-fails:
    using: env:python@3.13
    timeout: 20s
    run: python -c 'import socket; socket.create_server(("127.0.0.1", 7001)).accept()'
  idle-service-passes:
    using: env:python@3.13
    services:
      idle:
        using: env:python@3.13
        run: python -c 'import socket; socket.create_server(("127.0.0.1", 7002)).accept()'
        ready: { port: 7002 }
    run: test "$(cat /proc/iwci/tcp/127.0.0.1:7002)" = listening
  # A listening socket is a stream socket with no peer (#1217):
  # `getsockopt(SO_TYPE)` answered ENOTSOCK for one and `getpeername`
  # ENOTSUP, so `ssl.wrap_socket` could not wrap a server's socket, the usual
  # way to serve HTTPS from Python.
  tls-server-passes:
    using: env:python@3.13
    timeout: 3m
    run: |
      python - <<'PY'
      import socket
      s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
      types = [s.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE)]
      s.bind(("127.0.0.1", 7004))
      types.append(s.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE))
      s.listen()
      types.append(s.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE))
      assert types == [socket.SOCK_STREAM] * 3, types
      s.close()
      PY
      python - <<'PY' &
      import http.server, ssl
      served = []
      class Handler(http.server.BaseHTTPRequestHandler):
          def do_GET(self):
              self.send_response(200)
              self.send_header("Content-Length", "8")
              self.end_headers()
              self.wfile.write(b"over tls")
              served.append(True)
      server = http.server.HTTPServer(("127.0.0.1", 7443), Handler)
      context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
      context.load_cert_chain("/app/py/tls/cert.pem", "/app/py/tls/key.pem")
      server.socket = context.wrap_socket(server.socket, server_side=True)
      while not served:
          server.handle_request()
      PY
      server=$!
      wait-for-port 7443 --host localhost --timeout 60s
      test "$(python -c 'import ssl, urllib.request; print(urllib.request.urlopen("https://localhost:7443/", context=ssl.create_default_context(cafile="/app/py/tls/cert.pem")).read().decode())')" = "over tls"
      wait "$server"
  # File locks (#1216): `fcntl.flock` and `fcntl.lockf` failed with
  # ENOSYS. Another process's lock is refused without waiting, a blocking
  # one waits for its holder to exit, which releases it, and a second open
  # of a file in one process is a description of its own for flock (and
  # the same process for lockf), as on Linux.
  file-locks-passes:
    using: env:python@3.13
    timeout: 3m
    run: |
      python -u - > /tmp/holder.log <<'PY' &
      import fcntl, time
      f = open("/tmp/flock", "w")
      fcntl.flock(f, fcntl.LOCK_EX)
      g = open("/tmp/lockf", "w")
      fcntl.lockf(g, fcntl.LOCK_EX)
      print("held")
      time.sleep(2)
      PY
      holder=$!
      wait-for-log /tmp/holder.log held --timeout 60s
      python - <<'PY'
      import errno, fcntl, time
      f = open("/tmp/flock", "w")
      g = open("/tmp/lockf", "w")
      for lock, file in ((fcntl.flock, f), (fcntl.lockf, g)):
          try:
              lock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
              raise SystemExit(f"{lock.__name__} took a lock another process holds")
          except OSError as e:
              assert e.errno in (errno.EAGAIN, errno.EACCES), e
      start = time.monotonic()
      fcntl.flock(f, fcntl.LOCK_EX)
      fcntl.lockf(g, fcntl.LOCK_EX)
      assert time.monotonic() - start > 0.5, "the blocking locks did not wait"
      again = open("/tmp/flock", "w")
      try:
          fcntl.flock(again, fcntl.LOCK_SH | fcntl.LOCK_NB)
          raise SystemExit("flock shared a lock between two opens of one file")
      except BlockingIOError:
          pass
      fcntl.lockf(open("/tmp/lockf", "w"), fcntl.LOCK_EX | fcntl.LOCK_NB)
      fcntl.flock(f, fcntl.LOCK_UN)
      fcntl.flock(again, fcntl.LOCK_SH | fcntl.LOCK_NB)
      PY
      wait "$holder"
      # SQLite in CPython locks its database file with the same record
      # locks; a database on disk still works from two processes.
      python -c 'import sqlite3; c = sqlite3.connect("/tmp/t.db"); c.execute("create table t (x)"); c.execute("insert into t values (42)"); c.commit()'
      test "$(python -c 'import sqlite3; print(sqlite3.connect("/tmp/t.db").execute("select x from t").fetchone()[0])')" = 42
  # pip's three ways to keep packages apart from the interpreter's own, from
  # the local wheel and with no network: the user site, whose console
  # scripts are on PATH; a target directory on PYTHONPATH; and a virtual
  # environment of copies (`--copies`), with pip from ensurepip, which
  # `venv` here does not run by itself.
  pip-user-passes:
    using: env:python@3.13
    network: false
    env: { PIP_NO_INDEX: "1", PIP_FIND_LINKS: /app/py/wheels }
    run: |
      test "$PYTHONUSERBASE" = /root/.local
      pip install --user iwci-hello
      test "$(iwci-hello)" = "hello from iwci-hello"
      test "$(command -v iwci-hello)" = /root/.local/bin/iwci-hello
      python -c 'import iwci_hello, site; assert iwci_hello.__file__.startswith(site.getusersitepackages()), iwci_hello.__file__'
      pip list --user | grep -q '^iwci-hello '
  pip-target-passes:
    using: env:python@3.13
    network: false
    env: { PIP_NO_INDEX: "1", PIP_FIND_LINKS: /app/py/wheels }
    run: |
      pip install --target /tmp/libs iwci-hello
      test "$(PYTHONPATH=/tmp/libs python -m iwci_hello)" = "hello from iwci-hello"
      if python -c 'import iwci_hello' 2>/dev/null; then exit 1; fi
  venv-passes:
    using: env:python@3.13
    network: false
    timeout: 5m
    env: { PIP_NO_INDEX: "1", PIP_FIND_LINKS: /app/py/wheels }
    run: |
      python -m venv --copies /tmp/venv
      /tmp/venv/bin/python -m ensurepip --default-pip
      /tmp/venv/bin/pip install iwci-hello
      test "$(/tmp/venv/bin/iwci-hello)" = "hello from iwci-hello"
      test "$(/tmp/venv/bin/python -c 'import sys; print(sys.prefix)')" = /tmp/venv
      source /tmp/venv/bin/activate
      test "$(command -v python)" = /tmp/venv/bin/python
      test "$(iwci-hello)" = "hello from iwci-hello"
      # Not the interpreter's own: outside the venv it is not there.
      deactivate
      if python -c 'import iwci_hello' 2>/dev/null; then exit 1; fi
  # Git is on PATH here too, and Python can run it.
  git-passes:
    using: env:python@3.13
    run: |
      git init -q -b main /tmp/r
      python -c 'import subprocess; print(subprocess.run(["git", "-C", "/tmp/r", "status", "--short", "--branch"], check=True, capture_output=True, text=True).stdout)' | grep -q '^## No commits yet on main$'
  # A remote that wants credentials, as a private repository does, fails
  # Git at once with its own error (#1231): nobody can answer its prompt,
  # and it waited for an answer until the stall check stopped the job. The
  # fake answers every request 401; the timeout is well inside the stall
  # check, so a prompt that waits ends this job as timed out.
  git-auth-prompt-fails:
    using: env:python@3.13
    timeout: 2m
    run: |
      python - > /tmp/auth.log 2>&1 <<'PY' &
      import http.server
      class Private(http.server.BaseHTTPRequestHandler):
          def do_GET(self):
              self.send_response(401)
              self.send_header("WWW-Authenticate", 'Basic realm="private"')
              self.send_header("Content-Length", "0")
              self.end_headers()
      http.server.HTTPServer(("127.0.0.1", 8001), Private).serve_forever()
      PY
      wait-for-port 8001 --timeout 60s
      git clone http://127.0.0.1:8001/acme/private.git /tmp/private
  # Git's prompt for a user name, with prompts allowed, ends at once (#1264):
  # it reads /dev/tty, which a job has with nothing to read. It used to read
  # git-remote-http's standard input, the pipe from Git, and waited until
  # the job's timeout. A fake on the job's loopback answers every request
  # 401 with `WWW-Authenticate: Basic`, so Git asks.
  git-prompt-ends-fails:
    using: env:python@3.13
    timeout: 2m
    env: { GIT_TERMINAL_PROMPT: "1" }
    run: |
      python - > /tmp/auth.log 2>&1 <<'PY' &
      import http.server
      class Private(http.server.BaseHTTPRequestHandler):
          def do_GET(self):
              self.send_response(401)
              self.send_header("WWW-Authenticate", 'Basic realm="private"')
              self.send_header("Content-Length", "0")
              self.end_headers()
      http.server.HTTPServer(("127.0.0.1", 8002), Private).serve_forever()
      PY
      wait-for-port 8002 --timeout 60s
      git clone http://127.0.0.1:8002/acme/private.git /tmp/private
YAML
      ;;
    aws)
      cat <<'YAML'
name: aws
workspace:
  # The fake cloud (environments/cloud-clis/fake-cloud.py) on the job's
  # loopback. It wants the lent session, and gets it as secrets.
  services:
    cloud:
      using: env:aws@1.46
      env:
        FAKE_AWS_KEY: ${{ secrets.AWS_FIXTURE_KEY }}
        FAKE_AWS_TOKEN: ${{ secrets.AWS_FIXTURE_TOKEN }}
      run: exec python3 -u /app/cloud/fake-cloud.py
      ready: { port: 4566 }
jobs:
  version-passes:
    using: env:aws@1.46
    services: false
    run: |
      aws --version
      aws --version | grep -q '^aws-cli/1\.46\.3 Python/3\.13\.15 '
      test -z "$AWS_PAGER"
      test "$AWS_EC2_METADATA_DISABLED" = true
      # The CLI's own packages, not the job's: a urllib3 the job installs
      # does not reach it.
      if python3 -c 'import awscli' 2>/dev/null; then exit 1; fi
  # Lent the way the app lends an AWS connection (cloud_lent): the session
  # as variables and as a profile named after the connection. Every common
  # path, with no network: the fake cloud is the only thing it can reach.
  deploy-passes:
    using: env:aws@1.46
    connections: [aws fixture]
    network: false
    timeout: 15m
    env: { AWS_ENDPOINT_URL: "http://127.0.0.1:4566" }
    run: |
      test "$(aws sts get-caller-identity --query Account --output text)" = 123456789012
      test "$(aws --profile aws-fixture sts get-caller-identity --query Arn --output text)" = arn:aws:iam::123456789012:user/ci
      mkdir -p /tmp/site/sub
      echo hello > /tmp/site/index.html
      echo x > /tmp/site/sub/a.txt
      aws s3 cp /tmp/site/index.html s3://assets/index.html
      aws s3 sync /tmp/site s3://assets/site
      test "$(aws s3 ls s3://assets/site/ --recursive | wc -l)" = 2
      test "$(aws s3 cp s3://assets/site/sub/a.txt -)" = x
      test "$(aws s3api list-buckets --query 'Buckets[].Name' --output text)" = assets
      test "$(aws s3api head-object --bucket assets --key index.html --query ContentLength)" = 6
      test "$(aws ecr get-login-password)" = fake-ecr-password
      printf 'Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n' > /tmp/stack.yml
      aws cloudformation deploy --template-file /tmp/stack.yml --stack-name web
      test "$(aws cloudformation describe-stacks --stack-name web --query 'Stacks[0].StackStatus' --output text)" = CREATE_COMPLETE
      printf 'def handler(event, context):\n    return 1\n' > /tmp/handler.py
      (cd /tmp && python3 -c 'import zipfile; zipfile.ZipFile("fn.zip", "w").write("handler.py")')
      test "$(aws lambda update-function-code --function-name web --zip-file fileb:///tmp/fn.zip --query LastUpdateStatus --output text)" = Successful
      # An exec kubeconfig that runs this `aws` for its token.
      aws eks update-kubeconfig --name prod --kubeconfig /tmp/kubeconfig
      grep -q 'command: aws' /tmp/kubeconfig
      aws eks get-token --cluster-name prod |
        python3 -c 'import json, sys; t = json.load(sys.stdin)["status"]["token"]; assert t.startswith("k8s-aws-v1."), t'
      # Masked in the report, like any lent value.
      echo "session: $AWS_SESSION_TOKEN" >&2
      grep aws_session_token ~/.aws/credentials
  # A session the cloud does not know is refused, and the CLI says so.
  wrong-session-fails:
    using: env:aws@1.46
    network: false
    env:
      AWS_ENDPOINT_URL: "http://127.0.0.1:4566"
      AWS_ACCESS_KEY_ID: ASIAWRONG
      AWS_SECRET_ACCESS_KEY: wrong
      AWS_SESSION_TOKEN: wrong
      AWS_DEFAULT_REGION: us-east-1
    run: aws sts get-caller-identity
  # With nothing lent the CLI finds no credentials at once: it does not wait
  # on the instance metadata service, which a job cannot reach.
  no-credentials-passes:
    using: env:aws@1.46
    services: false
    network: false
    run: |
      start=$(date +%s)
      if aws sts get-caller-identity 2> /tmp/err; then exit 1; fi
      grep -q 'Unable to locate credentials' /tmp/err
      test $(( $(date +%s) - start )) -lt 30
  not-lent-fails:
    using: env:aws@1.46
    services: false
    connections: [staging]
    run: aws sts get-caller-identity
YAML
      ;;
    gcloud)
      cat <<'YAML'
name: gcloud
workspace:
  services:
    cloud:
      using: env:gcloud@593
      env: { FAKE_GCP_TOKEN: "${{ secrets.GCP_FIXTURE_TOKEN }}" }
      run: exec python3 -u /app/cloud/fake-cloud.py
      ready: { port: 4566 }
jobs:
  version-passes:
    using: env:gcloud@593
    services: false
    timeout: 5m
    run: |
      gcloud version
      gcloud version | grep -q '^Google Cloud SDK 593\.0\.0$'
      # What was left out is not listed as installed.
      if gcloud version | grep -q -e gsutil -e bundled-python; then exit 1; fi
      bq version | grep -q '^This is BigQuery CLI'
      test "$(gcloud config get-value core/disable_prompts 2>/dev/null)" = 1
  # Lent the way the app lends a Google Cloud connection (cloud_lent): an
  # access token in a file gcloud reads, and the project.
  lent-passes:
    using: env:gcloud@593
    connections: [gcp fixture]
    network: false
    timeout: 10m
    env:
      CLOUDSDK_API_ENDPOINT_OVERRIDES_CLOUDRESOURCEMANAGER: "http://127.0.0.1:4566/gcp/"
      CLOUDSDK_API_ENDPOINT_OVERRIDES_STORAGE: "http://127.0.0.1:4566/gcp/storage/v1/"
    run: |
      test "$(gcloud config get-value project)" = acme
      test "$(gcloud projects describe acme --format='value(projectNumber)')" = 424242424242
      gcloud storage ls gs://site | grep -qx gs://site/index.html
      # Masked in the report.
      gcloud auth print-access-token
  wrong-token-fails:
    using: env:gcloud@593
    network: false
    timeout: 10m
    env:
      CLOUDSDK_API_ENDPOINT_OVERRIDES_CLOUDRESOURCEMANAGER: "http://127.0.0.1:4566/gcp/"
      CLOUDSDK_CORE_PROJECT: acme
    run: |
      printf wrong > /tmp/token
      CLOUDSDK_AUTH_ACCESS_TOKEN_FILE=/tmp/token gcloud projects describe acme
YAML
      ;;
    az)
      cat <<'YAML'
name: az
workspace:
  services:
    cloud:
      using: env:az@2.92
      env: { FAKE_AZURE_SECRET: "${{ secrets.AZURE_FIXTURE_SECRET }}" }
      run: exec python3 -u /app/cloud/fake-cloud.py --cert /app/cloud/cert.pem --key /app/cloud/key.pem
      ready: { port: 4567 }
jobs:
  version-passes:
    using: env:az@2.92
    services: false
    timeout: 5m
    run: |
      az version
      test "$(az version --query '"azure-cli"' -o tsv)" = 2.92.0
      test "$AZURE_CORE_COLLECT_TELEMETRY" = no
  # Lent the way the app lends an Azure connection (cloud_lent): the service
  # principal as variables. The fake is a cloud of its own the CLI is told
  # about; its first command that needs an account signs in by itself.
  lent-passes:
    using: env:az@2.92
    connections: [azure fixture]
    network: false
    timeout: 15m
    env: { REQUESTS_CA_BUNDLE: /app/cloud/cert.pem, AZURE_CORE_INSTANCE_DISCOVERY: "false" }
    run: |
      az cloud register --name Fixture --endpoint-resource-manager https://127.0.0.1:4567/ --output none
      az cloud set --name Fixture --output none
      test "$(az group list --query '[].name' -o tsv)" = web
      test "$(az account show --query id -o tsv)" = "$AZURE_SUBSCRIPTION_ID"
      test "$(az account show --query user.type -o tsv)" = servicePrincipal
      # Signed in once: the second command finds the account.
      az group list --output none
  wrong-secret-fails:
    using: env:az@2.92
    connections: [azure fixture]
    network: false
    timeout: 15m
    env:
      REQUESTS_CA_BUNDLE: /app/cloud/cert.pem
      AZURE_CORE_INSTANCE_DISCOVERY: "false"
      AZURE_CLIENT_SECRET: wrong
    run: |
      az cloud register --name Fixture --endpoint-resource-manager https://127.0.0.1:4567/ --output none
      az cloud set --name Fixture --output none
      az group list
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
  # pglite waiting longer than 30 s for its client, and then longer than
  # 30 s between that client's queries (#1046): a blocking accept gave up
  # after 30 s, and pglite exited with it.
  idle-client-passes:
    using: env:python@3.13
    timeout: 10m
    services:
      postgres:
        using: env:postgres@18
        run: pglite
        ready: { log: "OLIPHAUNT_WASIX_SOCKET_READY 5432" }
    run: |
      pip install 'psycopg[binary]'
      sleep 45
      python - <<'PY'
      import time, psycopg
      with psycopg.connect("host=postgres port=5432 user=postgres dbname=postgres") as conn:
          assert conn.execute("select 1").fetchone()[0] == 1
          time.sleep(35)
          assert conn.execute("select 2").fetchone()[0] == 2
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
  # pglite-server: many connections over pglite's one backend, a
  # transaction at a time. Connections open together, a pool, transactions
  # from several threads claiming rows with SKIP LOCKED (each row once),
  # one transaction waiting for another to end rather than running inside
  # it, a wait on an idle transaction failing with 55P03 instead of
  # hanging, a disconnect rolling back, a connection's prepared statements
  # its own, the session reset once everyone has left, and pgcrypto.
  connections-passes:
    using: env:python@3.13
    timeout: 10m
    services:
      postgres:
        using: env:postgres@18
        run: pglite-server -wait 2s
        ready: { port: 5432 }
    run: |
      pip install 'psycopg[binary]' psycopg-pool
      python - <<'PY'
      import threading, time
      import psycopg, psycopg_pool
      url = "postgres://app:secret@postgres:5432/app"

      # Alone: the session reset when the last connection left.
      with psycopg.connect(url, autocommit=True) as c:
          c.execute("set search_path = nowhere")
      with psycopg.connect(url, autocommit=True) as c:
          assert c.execute("show search_path").fetchone()[0] == '"$user", public'
          assert c.execute("select version()").fetchone()[0].startswith("PostgreSQL 18")
          c.execute("create extension if not exists pgcrypto")
          c.execute("create extension if not exists pgcrypto")
          sha, mac, n = c.execute("select encode(digest('abc', 'sha256'), 'hex'),"
              " encode(hmac('what do ya want for nothing?', 'Jefe', 'sha256'), 'hex'),"
              " length(gen_random_bytes(40))").fetchone()
          assert sha == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha
          assert mac == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", mac  # RFC 4231 case 2
          assert n == 40
          c.execute("create table jobs (id int primary key, owner int, claims int not null default 0)")
          c.execute("insert into jobs (id) select generate_series(1, 400)")

      def threads(n, target):
          ts = [threading.Thread(target=target, args=(i,)) for i in range(n)]
          for t in ts: t.start()
          for t in ts: t.join()

      # Eight connections open together, each claiming rows in transactions.
      conns = [psycopg.connect(url) for _ in range(8)]
      claimed = [[] for _ in conns]
      def worker(i):
          while True:
              with conns[i].transaction():
                  ids = [r[0] for r in conns[i].execute(
                      "select id from jobs where owner is null order by id limit 7 for update skip locked")]
                  if not ids:
                      return
                  conns[i].execute("update jobs set owner = %s, claims = claims + 1 where id = any(%s)", (i, ids))
              claimed[i] += ids
      threads(8, worker)
      every = sum(claimed, [])
      assert sorted(every) == list(range(1, 401)), len(every)
      assert conns[0].execute("select count(*) from jobs where claims <> 1").fetchone()[0] == 0
      for c in conns:
          c.close()

      # The poller's claim, one statement, from sixteen connections at once.
      with psycopg.connect(url, autocommit=True) as c:
          c.execute("update jobs set owner = null, claims = 0")
      got = []
      def claim(i):
          with psycopg.connect(url, autocommit=True) as c:
              got.extend(r[0] for r in c.execute(
                  "update jobs set owner = %s, claims = claims + 1 where id in"
                  " (select id from jobs where owner is null order by id limit 25 for update skip locked)"
                  " returning id", (i,)))
      threads(16, claim)
      assert sorted(got) == list(range(1, 401)), len(got)

      # A pool, with server-side prepared statements of each connection's own.
      pool = psycopg_pool.ConnectionPool(url, min_size=4, max_size=4, open=True)
      def pooled(i):
          with pool.connection() as c:
              for _ in range(3):
                  assert c.execute("select %s::int * 2", (i,), prepare=True).fetchone()[0] == i * 2
      threads(48, pooled)
      pool.close()

      # One transaction waits for another to end; it never runs inside it.
      a, b = psycopg.connect(url), psycopg.connect(url, autocommit=True)
      a.execute("select id from jobs where id = 1 for update")
      a.execute("update jobs set owner = 99 where id = 1")
      seen = []
      t = threading.Thread(target=lambda: seen.extend(b.execute(
          "select id from jobs where id = 1 and owner <> 99 for update skip locked").fetchall()))
      t.start()
      time.sleep(0.5)
      assert t.is_alive(), "ran inside another transaction"
      a.commit()
      t.join()
      assert seen == [], seen

      # Waiting on a transaction that does nothing gives up, with 55P03.
      a.execute("select 1")
      start = time.time()
      try:
          b.execute("select 1")
          raise AssertionError("waited on an idle transaction without giving up")
      except psycopg.errors.LockNotAvailable as e:
          assert "connection" in str(e) and time.time() - start < 10, e
      a.rollback()
      assert b.execute("select 2").fetchone()[0] == 2

      # A disconnect rolls its transaction back.
      a.execute("insert into jobs (id) values (1000)")
      a.close()
      assert b.execute("select count(*) from jobs where id = 1000").fetchone()[0] == 0

      # A SQL-level PREPARE is the connection's, gone when it disconnects.
      for _ in range(2):
          with psycopg.connect(url, autocommit=True) as c:
              c.execute("prepare q as select 1")
      b.close()
      print("ok")
      PY
  # Git is on PATH here too.
  git-passes:
    using: env:postgres@18
    run: git --version
YAML
      ;;
    bash-node-pool)
      # Alone in its runner, so its V8 has only this pipeline's heaps.
      # Until V8 15.9 every isolate of the runner shared one 4 GiB cage. A
      # `node` that outlived other `node`s, here blocked in one call, was
      # the isolate group's main isolate, and V8 freed a disposed isolate's
      # young-generation pages only from a task on that isolate's thread:
      # 24 young generations left a later `node` 200 to 500 MB of heap,
      # where V8 failed "CALL_AND_RETRY_LAST" and the isolate was lost
      # (#1134). Every isolate has a cage of its own now, so the `node`s
      # that ended take nothing from the probe.
      #
      # And the heaps of different jobs are held by nothing but each job's
      # `memory:` (#1158): `big-1` and `big-2` hold 2.4 GB of heap each at
      # the same time, 4.8 GB together. The account of the shared cage
      # held all heaps of the runner to 3.5 GiB: one of the two waited for
      # room the other held, and was stopped, "within the job's `memory:`,
      # but not within the 3584 MiB of V8 heap that every job on this
      # runner shares".
      cat <<'YAML'
name: bash-node-pool
jobs:
  main-passes:
    using: env:bash-node@24
    memory: 1GiB
    timeout: 5m
    run: node -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000)'
  churn-1-passes:
    using: env:bash-node@24
    memory: 3GiB
    timeout: 5m
    run: |
      cat > /tmp/churn.js <<'JS'
      let keep = [];
      for (let i = 0; i < 6e6; i++) {
        keep.push({ a: i, b: [i, i + 1] });
        if (keep.length > 4e5) keep = keep.slice(2e5);
      }
      JS
      sleep 15
      for k in 1 2 3 4 5 6; do node /tmp/churn.js & done
      wait
  churn-2-passes:
    using: env:bash-node@24
    memory: 3GiB
    timeout: 5m
    run: |
      cat > /tmp/churn.js <<'JS'
      let keep = [];
      for (let i = 0; i < 6e6; i++) {
        keep.push({ a: i, b: [i, i + 1] });
        if (keep.length > 4e5) keep = keep.slice(2e5);
      }
      JS
      sleep 15
      for k in 1 2 3 4 5 6; do node /tmp/churn.js & done
      wait
  churn-3-passes:
    using: env:bash-node@24
    memory: 3GiB
    timeout: 5m
    run: |
      cat > /tmp/churn.js <<'JS'
      let keep = [];
      for (let i = 0; i < 6e6; i++) {
        keep.push({ a: i, b: [i, i + 1] });
        if (keep.length > 4e5) keep = keep.slice(2e5);
      }
      JS
      sleep 15
      for k in 1 2 3 4 5 6; do node /tmp/churn.js & done
      wait
  churn-4-passes:
    using: env:bash-node@24
    memory: 3GiB
    timeout: 5m
    run: |
      cat > /tmp/churn.js <<'JS'
      let keep = [];
      for (let i = 0; i < 6e6; i++) {
        keep.push({ a: i, b: [i, i + 1] });
        if (keep.length > 4e5) keep = keep.slice(2e5);
      }
      JS
      sleep 15
      for k in 1 2 3 4 5 6; do node /tmp/churn.js & done
      wait
  probe-passes:
    using: env:bash-node@24
    needs: [churn-1-passes, churn-2-passes, churn-3-passes, churn-4-passes]
    memory: 6GiB
    timeout: 5m
    run: |
      sleep 12
      node -e 'const a = []; for (let i = 0; i < 30; i++) a.push(new Array(12.5e6).fill(i + 0.5)); console.log(a.length * 100, "MB")'
  big-1-passes:
    using: env:bash-node@24
    needs: [probe-passes]
    memory: 4GiB
    timeout: 5m
    run: |
      node -e 'const a = []; for (let i = 0; i < 24; i++) a.push(new Array(12.5e6).fill(i + 0.5)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25000); console.log(a.length * 100, "MB held")'
  big-2-passes:
    using: env:bash-node@24
    needs: [probe-passes]
    memory: 4GiB
    timeout: 5m
    run: |
      node -e 'const a = []; for (let i = 0; i < 24; i++) a.push(new Array(12.5e6).fill(i + 0.5)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25000); console.log(a.length * 100, "MB held")'
YAML
      ;;
    clickhouse)
      cat <<'YAML'
name: clickhouse
workspace:
  services:
    clickhouse:
      using: env:clickhouse@26.11
      run: clickhouse-server
      env: { CLICKHOUSE_DB: app, CLICKHOUSE_PASSWORD: secret }
      ready: { port: 8123, timeout: 120s }
jobs:
  # ClickHouse's HTTP interface as @clickhouse/client uses it, against the
  # engines and features the app's metrics and cost tables depend on: a
  # MergeTree with a TTL, an AggregatingMergeTree fed by a materialized
  # view, a ReplacingMergeTree read with FINAL, JSONEachRow inserts with
  # async_insert, query parameters, gzip, errors and auth.
  sql-passes:
    using: env:clickhouse@26.11
    memory: 3GiB
    timeout: 10m
    run: |
      cat > /tmp/ch.mjs <<'JS'
      import zlib from "node:zlib";
      const auth = "Basic " + Buffer.from("default:secret").toString("base64");
      async function ch(sql, { params = {}, body, headers = {} } = {}) {
        const url = new URL("http://clickhouse:8123/");
        url.searchParams.set("database", "app");
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        if (body !== undefined) url.searchParams.set("query", sql);
        const r = await fetch(url, { method: "POST", headers: { Authorization: auth, ...headers }, body: body ?? sql });
        const text = await r.text();
        if (r.status !== 200) throw new Error(`${r.status}: ${text}`);
        return text.trim();
      }
      function expect(name, got, want) {
        if (got !== want) throw new Error(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        console.log(`ok ${name}`);
      }
      expect("ping", await (await fetch("http://clickhouse:8123/ping")).text(), "Ok.\n");
      expect("version", (await ch("SELECT version()")).split(".").slice(0, 2).join("."), "26.11");
      await ch(`CREATE TABLE raw (series String, unit LowCardinality(String), ts DateTime64(3), value Float64)
        ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (series, ts) TTL toDateTime(ts) + INTERVAL 10 YEAR`);
      await ch(`CREATE TABLE per_minute (series String, unit LowCardinality(String), minute DateTime,
        value_avg AggregateFunction(avg, Float64)) ENGINE = AggregatingMergeTree ORDER BY (series, minute)
        SETTINGS allow_dimensions_outside_sorting_key = 1`);
      await ch(`CREATE MATERIALIZED VIEW mv TO per_minute AS SELECT series, unit, toStartOfMinute(toDateTime(ts)) AS minute,
        avgState(value) AS value_avg FROM raw GROUP BY series, unit, minute`);
      const rows = [10, 20, 30].map((value, i) =>
        JSON.stringify({ series: "cpu", unit: "%", ts: `2026-11-0${i + 1}T10:00:00.123Z`, value }));
      await ch("INSERT INTO raw FORMAT JSONEachRow", {
        params: { async_insert: "1", wait_for_async_insert: "0", date_time_input_format: "best_effort" },
        body: rows.join("\n"),
      });
      await ch("SYSTEM FLUSH ASYNC INSERT QUEUE");
      expect("milliseconds", await ch("SELECT toUnixTimestamp64Milli(min(ts)) FROM raw"), "1793527200123");
      expect("rollup", await ch("SELECT sum(v) FROM (SELECT avgMerge(value_avg) AS v FROM per_minute GROUP BY minute)"), "60");
      expect("parameters", await ch("SELECT count() FROM raw WHERE value > {min:Float64}", { params: { param_min: "15" } }), "2");
      await ch(`CREATE TABLE costs (id String, amount Float64, ingested DateTime) ENGINE = ReplacingMergeTree(ingested) ORDER BY id`);
      await ch("INSERT INTO costs VALUES ('a', 1, '2026-11-01 00:00:00')");
      await ch("INSERT INTO costs VALUES ('a', 2, '2026-11-02 00:00:00')");
      expect("without FINAL", await ch("SELECT count() FROM costs"), "2");
      expect("FINAL", await ch("SELECT amount FROM costs FINAL"), "2");
      await ch("OPTIMIZE TABLE costs FINAL");
      expect("OPTIMIZE FINAL", await ch("SELECT count() FROM costs"), "1");
      await ch("DELETE FROM raw WHERE value = 10");
      expect("DELETE", await ch("SELECT count() FROM raw"), "2");
      expect("64-bit integers quoted on request", JSON.parse(await ch("SELECT toUInt64(18446744073709551000) AS n FORMAT JSONEachRow",
        { params: { output_format_json_quote_64bit_integers: "1" } })).n, "18446744073709551000");
      const gz = await fetch("http://clickhouse:8123/?enable_http_compression=1",
        { method: "POST", headers: { Authorization: auth, "Accept-Encoding": "gzip" }, body: "SELECT 42" });
      expect("gzip", gz.headers.get("content-encoding") + " " + (await gz.text()).trim(), "gzip 42");
      const denied = await fetch("http://clickhouse:8123/?query=SELECT%201", { headers: { Authorization: "Basic " + Buffer.from("default:wrong").toString("base64") } });
      expect("wrong password", denied.status, 401);
      expect("26.11's MergeTree defaults", await ch("SELECT value FROM system.merge_tree_settings WHERE name = 'allow_dimensions_outside_sorting_key'"), "0");
      JS
      node /tmp/ch.mjs
  # A statement the server rejects fails the job with ClickHouse's message.
  rejected-fails:
    using: env:clickhouse@26.11
    memory: 3GiB
    run: |
      node --input-type=module -e '
      const r = await fetch("http://clickhouse:8123/?database=app", { method: "POST", body: "SELEC 1",
        headers: { Authorization: "Basic " + Buffer.from("default:secret").toString("base64") } });
      if (r.status !== 200) { console.error(r.status, await r.text()); process.exit(1); }'
  # Without `ready`, a job would race the server; with it, a server that
  # never listens fails the job and says why.
  not-ready-fails:
    using: env:clickhouse@26.11
    memory: 3GiB
    services:
      clickhouse:
        using: env:clickhouse@26.11
        run: CLICKHOUSE_HTTP_PORT=9999 clickhouse-server
        ready: { port: 8123, timeout: 20s }
    run: "true"
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
  # Git is on PATH here too, for PHP and for scripts.
  git-passes:
    using: env:php@8.5
    run: |
      git --version
      test "$(php -r 'echo trim(shell_exec("git --version"));')" = "$(git --version)"
YAML
      ;;
  esac
}

# What a `-fails` job's failure reason must contain.
want_reason() {
  case "$1" in
    gofmt/dirty-fails | oxfmt/dirty-fails) echo "changed 1 file" ;;
    typescript/type-error-fails) echo "exited with 2" ;;
    bash/git-fatal-fails | python/git-auth-prompt-fails | python/git-prompt-ends-fails) echo "exited with 128" ;;
    kubectl/unauthorized-fails) echo "exited with 1" ;;
    kubectl/refused-fails) echo "staging is not lent to CI for this fixture" ;;
    gh/bad-token-fails) echo "exited with 1" ;;
    gh/no-token-fails) echo "exited with 4" ;;
    gh/refused-fails) echo "the Infrawrench GitHub App's installation on acme does not have issues: write" ;;
    gh/expired-fails) echo "the GitHub token for \`statuses=write\` expired" ;;
    openssh/wrong-host-key-fails | openssh/unknown-host-fails | openssh/loose-key-fails | openssh/refused-fails) echo "exited with 255" ;;
    openssh/not-lent-fails | aws/not-lent-fails) echo "staging is not lent to CI for this fixture" ;;
    aws/wrong-session-fails) echo "exited with 255" ;;
    gcloud/wrong-token-fails | az/wrong-secret-fails) echo "exited with 1" ;;
    bash/false-fails | bash/git-diff-fails | bash/stat-missing-fails | bash/wait-for-log-timeout-fails | bash/wait-for-port-timeout-fails | python/pytest-fails | python/raise-fails | python/pip-deps-fails | php/phpunit-fails | php/composer-deps-fails | bash-node/throw-fails | bash-node/module-syntax-error-fails | bash-node/error-report-fails |bash-node/shebang-missing-interpreter-fails | tools/gofmt-finds-dirty-fails) echo "exited with 1" ;;
    php/lint-fails) echo "exited with 255" ;;
    bash-node/unsettled-tla-fails) echo "exited with 13" ;;
    bash-node/global-install-missing-fails) echo "exited with 1" ;;
    npm-cli/vercel-bad-token-fails | npm-cli/wrangler-dev-fails | npm-cli/neon-bad-key-fails) echo "exited with 1" ;;
    npm-cli/in-bash-errors) echo "runs on \`node\`, which this environment does not have" ;;
    npm-cli/as-a-job-errors) echo "runs on Node: list it in \`tools:\`" ;;
    bash-node/spin-fails | python/idle-server-timeout-fails) echo "timed out" ;;
    go@*/test-fails | go@*/vet-fails | go@*/build-error-fails) echo "exited with 1" ;;
    postgres/not-ready-fails) echo "service \`postgres\` was not ready after 2s: nothing listened on port 5432" ;;
    postgres/exits-early-fails) echo "service \`postgres\` exited with 3 before it was ready" ;;
    clickhouse/rejected-fails) echo "exited with 1" ;;
    clickhouse/not-ready-fails) echo "service \`clickhouse\` was not ready after 20s: nothing listened on port 8123" ;;
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
    kubectl/unauthorized-fails) echo "You must be logged in to the server" ;;
    python/git-auth-prompt-fails) echo "fatal: could not read Username for 'http://127\.0\.0\.1:8001': terminal prompts disabled" ;;
    python/git-prompt-ends-fails) echo "fatal: could not read Username for 'http://127\.0\.0\.1:8002'" ;;
    gh/bad-token-fails) echo "could not read Username for 'https://github.com': terminal prompts disabled.*gh: Bad credentials \(HTTP 401\)" ;;
    gh/no-token-fails) echo "gh auth login|GH_TOKEN" ;;
    openssh/wrong-host-key-fails) echo "REMOTE HOST IDENTIFICATION HAS CHANGED.*Host key verification failed" ;;
    openssh/unknown-host-fails) echo "Host key verification failed" ;;
    openssh/loose-key-fails) echo "UNPROTECTED PRIVATE KEY FILE.*Permission denied \(publickey\)" ;;
    openssh/refused-fails) echo "ssh: connect to host 127.0.0.1 port 2299: Connection refused" ;;
    aws/wrong-session-fails) echo "InvalidClientTokenId" ;;
    aws/deploy-passes) echo "session: \\*\\*\\*" ;;
    gcloud/wrong-token-fails) echo "Request had invalid authentication credentials" ;;
    az/wrong-secret-fails) echo "AADSTS7000215: Invalid client secret provided.*could not sign in with the lent service principal" ;;
    postgres/exits-early-fails) echo "\[service postgres\] bye.*iwci: service .postgres. exited with 3 before it was ready" ;;
    postgres/log-ready-passes) echo "\[service postgres\] starting with \*\*\*" ;;
    clickhouse/rejected-fails) echo "400 Code: 62\. DB::Exception: Syntax error.*\(SYNTAX_ERROR\)" ;;
    bash/signal-fails) echo "dying with \\*\\*\\*.*Program recieved fatal signal: Bad system call.*iwci: the job exited with 127 after a signal.*a guest called [a-z_]+\\(.*Sigsys" ;;
    bash-node/module-syntax-error-fails) echo "^file:///tmp/bad\.mjs:1 export const a = \{; {19}\^  SyntaxError: Unexpected token ';'" ;;
    bash-node/error-report-fails) echo "^/tmp/throw\.cjs:2 throw new Error\(\"boom\"\); \^  Error: boom     at Object\.<anonymous> \(/tmp/throw\.cjs:2:7\)" ;;
    bash-node/unsettled-tla-fails) echo "^Warning: Detected unsettled top-level await at file:///tmp/stall\.mjs:2 await new Promise\(\(\) => \{\}\); \^" ;;
    npm-cli/wrangler-dev-fails) echo "workerd, Cloudflare's local Workers runtime, cannot run in a CI job here" ;;
    npm-cli/neon-bad-key-fails) echo "Authentication failed: the Neon API rejected the API key" ;;
    npm-cli/vercel-bad-token-fails) echo "The token provided via VERCEL_TOKEN environment variable is not valid" ;;
    bash-node/heap-objects-fails) echo "iwci: the job ran out of its 512 MiB of memory.*JavaScript heap could not grow" ;;
    bash-node/heap-strings-fails) echo "iwci: the job ran out of its 1024 MiB of memory.*JavaScript heaps? could not grow" ;;
    bash-node/workers-heap-fails) echo "iwci: the job ran out of its 1024 MiB of memory.*JavaScript heaps? could not grow" ;;
    bash-node/workers-refused-fails) echo "ERR_WORKER_INIT_FAILED.*iwci: the job ran out of its 512 MiB of memory.*worker threads could not start" ;;
    *) echo "" ;;
  esac
}

# What the app would lend the openssh pipeline (a run request's `lent`), in
# the shape the `ssh` plugin lends it (plugin-architecture/packages/ssh,
# `lendSshHost`): a connection is its key at /root/.ssh/iw_<alias>, the
# host key pinned for it as a line of /root/.ssh/iw_<alias>.known_hosts, and
# a Host entry in ~/.ssh/config naming both (and, behind a jump host, the
# jump host's own three and ProxyJump, joined as the app joins them); a key
# is a file at mode 0600 named as an IdentityFile.
openssh_lent() {
  local keys="$SCRATCH/ssh-keys"
  pub() { cut -d' ' -f1,2 "$keys/$1.pub"; }
  jq -n --arg a "$(pub host_a)" --arg jump "$(pub host_jump)" --arg rsa "$(pub host_rsa)" \
    --rawfile deploy "$keys/deploy" --rawfile deploy_rsa "$keys/deploy_rsa" '
    def host($alias; $port; $key; $known; $via): [
      { path: "/root/.ssh/iw_\($alias)", mode: "600", content: $key },
      { path: "/root/.ssh/iw_\($alias).known_hosts", mode: "600",
        content: [{ text: "[127.0.0.1]:\($port) \($known)\n" }] },
      { path: "/root/.ssh/config", mode: "600", content: [{ text: "Host \($alias)\n  HostName 127.0.0.1\n  Port \($port)\n  User deploy\n  IdentityFile /root/.ssh/iw_\($alias)\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile /root/.ssh/iw_\($alias).known_hosts\n\($via)" }] } ];
    def direct($alias; $port; $key; $known): { files: host($alias; $port; $key; $known; "") };
    {
      connections: {
        web: direct("web"; 2222; $deploy; $a),
        "web-via-jump": { files:
          (host("jump"; 2223; $deploy; $jump; "")[0:2]
            + host("web-via-jump"; 2222; $deploy; $a; "  ProxyJump jump\n")[0:2]
            + [{ path: "/root/.ssh/config", mode: "600", content:
                 (host("jump"; 2223; $deploy; $jump; "")[2].content + [{ text: "\n" }]
                   + host("web-via-jump"; 2222; $deploy; $a; "  ProxyJump jump\n")[2].content) }]) },
        legacy: direct("legacy"; 2224; $deploy_rsa; $rsa),
        closed: direct("closed"; 2299; $deploy; $a),
        staging: { refused: "staging is not lent to CI for this fixture" }
      },
      "ssh-keys": {
        deploy: { files: [
          { path: "/root/.ssh/id_deploy", content: $deploy },
          { path: "/root/.ssh/config", mode: "644", content: [{ text: "Host *\n  IdentityFile /root/.ssh/id_deploy\n" }] } ] },
        "deploy-rsa": { files: [
          { path: "/root/.ssh/id_deploy_rsa", content: $deploy_rsa },
          { path: "/root/.ssh/config", mode: "644", content: [{ text: "Host *\n  IdentityFile /root/.ssh/id_deploy_rsa\n" }] } ] }
      }
    }'
}

# What the app would lend the cloud CLI pipelines: what the AWS, GCP and
# Azure plugins' lendCiCredential return (plugin-architecture/packages/
# {aws,gcp,azure}/src/ci-credential.ts), with fixture values.
cloud_lent() {
  case "$1" in
    aws)
      jq -n --arg key "$IWCI_SECRET_AWS_FIXTURE_KEY" --arg secret "$AWS_FIXTURE_SECRET_KEY" \
        --arg token "$IWCI_SECRET_AWS_FIXTURE_TOKEN" '{ connections: {
          "aws fixture": {
            env: { AWS_ACCESS_KEY_ID: $key, AWS_SECRET_ACCESS_KEY: $secret, AWS_SESSION_TOKEN: $token,
                   AWS_REGION: [{ text: "us-east-1" }], AWS_DEFAULT_REGION: [{ text: "us-east-1" }] },
            files: [
              { path: "/root/.aws/credentials", mode: "600", content: [
                { text: "[aws-fixture]\naws_access_key_id = " }, { secret: $key },
                { text: "\naws_secret_access_key = " }, { secret: $secret },
                { text: "\naws_session_token = " }, { secret: $token }, { text: "\n" } ] },
              { path: "/root/.aws/config", mode: "600", content: [{ text: "[profile aws-fixture]\nregion = us-east-1\n" }] } ] },
          staging: { refused: "staging is not lent to CI for this fixture" } } }' ;;
    gcloud)
      jq -n --arg token "$IWCI_SECRET_GCP_FIXTURE_TOKEN" '{ connections: {
          "gcp fixture": {
            env: { CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: [{ text: "/root/.config/gcloud/gcp-fixture.token" }],
                   GOOGLE_OAUTH_ACCESS_TOKEN: $token,
                   CLOUDSDK_CORE_PROJECT: [{ text: "acme" }], GOOGLE_CLOUD_PROJECT: [{ text: "acme" }] },
            files: [{ path: "/root/.config/gcloud/gcp-fixture.token", mode: "600", content: $token }] } } }' ;;
    az)
      jq -n --arg secret "$IWCI_SECRET_AZURE_FIXTURE_SECRET" '
        def shown($v): [{ text: $v }];
        { connections: { "azure fixture": { env: {
          AZURE_CLIENT_ID: shown("00000000-0000-0000-0000-00000000000b"),
          AZURE_TENANT_ID: shown("00000000-0000-0000-0000-00000000000a"),
          AZURE_CLIENT_SECRET: $secret,
          AZURE_SUBSCRIPTION_ID: shown("00000000-0000-0000-0000-00000000000c"),
          ARM_CLIENT_ID: shown("00000000-0000-0000-0000-00000000000b"),
          ARM_TENANT_ID: shown("00000000-0000-0000-0000-00000000000a"),
          ARM_CLIENT_SECRET: $secret,
          ARM_SUBSCRIPTION_ID: shown("00000000-0000-0000-0000-00000000000c") } } } }' ;;
  esac
}

# What the app would lend the gh pipeline: a token per set of permissions
# a job asks for (`ci/github-token.ts`, githubTokenEntry), one GitHub
# would not mint, and one minted an hour and ten minutes ago.
gh_lent() {
  local now
  now="$(date +%s)"
  jq -n --arg token "$GH_FIXTURE_TOKEN" --arg basic "$GH_FIXTURE_BASIC" --argjson now "$now" '
    def config: [
      { text: "[http \"https://github.com/acme/widgets\"]\n\textraheader = AUTHORIZATION: basic " },
      { secret: $basic }, { text: "\n" },
      { text: "[http \"https://github.com/acme/widgets.git\"]\n\textraheader = AUTHORIZATION: basic " },
      { secret: $basic }, { text: "\n" } ];
    def token($expires): {
      env: { GH_TOKEN: $token, GITHUB_TOKEN: $token, GH_REPO: [{ text: "acme/widgets" }],
             GIT_CONFIG_GLOBAL: [{ text: "/root/.gitconfig" }], GIT_TERMINAL_PROMPT: [{ text: "0" }] },
      files: [{ path: "/root/.gitconfig", mode: "600", content: config }],
      "expires-at": $expires };
    { "github-token": {
        "contents=write,issues=write,pull-requests=write": token($now + 3600),
        "issues=write": { refused: "the Infrawrench GitHub App'"'"'s installation on acme does not have issues: write, so it cannot lend a token with it; an owner of acme can grant it from the installation'"'"'s settings on GitHub" },
        "statuses=write": token($now - 600)
    } }'
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
  # What the app would lend the run (`lent` of a run request).
  lent=""
  if [[ "$name" == kubectl ]]; then
    lent="$SCRATCH/kubectl-lent.json"
    kube_head='apiVersion: v1\nkind: Config\nclusters:\n- name: fixture\n  cluster:\n    server: https://127.0.0.1:6443\n    certificate-authority: /tmp/fake-api-ca.pem\ncontexts:\n- name: fixture\n  context:\n    cluster: fixture\n    user: ci\n    namespace: default\ncurrent-context: fixture\nusers:\n- name: ci\n  user:\n    token: '
    cat >"$lent" <<JSON
{
  "connections": {
    "fixture cluster": {
      "env": { "KUBECONFIG": [{ "text": "/root/.kube/config" }] },
      "files": [{ "path": "/root/.kube/config", "content": [{ "text": "$kube_head" }, { "secret": "$KUBE_FIXTURE_TOKEN" }] }]
    },
    "staging": { "refused": "staging is not lent to CI for this fixture" }
  }
}
JSON
  elif [[ "$name" == openssh ]]; then
    lent="$SCRATCH/openssh-lent.json"
    openssh_lent >"$lent"
  elif [[ "$name" == aws || "$name" == az || "$name" == gcloud ]]; then
    lent="$SCRATCH/$name-lent.json"
    cloud_lent "$name" >"$lent"
  elif [[ "$name" == npm-cli ]]; then
    # As the Vercel, Cloudflare and Neon plugins lend a connection: the
    # token their CLI reads, secret, and Cloudflare's account ID, shown.
    lent="$SCRATCH/npm-cli-lent.json"
    jq -n --arg v "$VERCEL_FIXTURE_TOKEN" --arg c "$CLOUDFLARE_FIXTURE_TOKEN" --arg n "$NEON_FIXTURE_KEY" '{
      connections: {
        vercel: { env: { VERCEL_TOKEN: [{ secret: $v }] }, files: [] },
        cloudflare: { env: { CLOUDFLARE_API_TOKEN: [{ secret: $c }], CLOUDFLARE_ACCOUNT_ID: [{ text: "0123456789abcdef0123456789abcdef" }] }, files: [] },
        neon: { env: { NEON_API_KEY: [{ secret: $n }] }, files: [] }
      }
    }' >"$lent"
  elif [[ "$name" == gh ]]; then
    lent="$SCRATCH/gh-lent.json"
    gh_lent >"$lent"
  fi
  # iwci's own stderr goes on to ours as it comes, and to a file that is
  # checked below.
  out="$({
    IWCI_LENT_FILE="$lent" "$IWCI" run --repo "$repo" --branch main --pipeline "$file" --json \
      --store "$SCRATCH/store" --cache "$SCRATCH/cache" --stall-after "$stall_after" \
      2>&1 1>&3 3>&- | tee "$SCRATCH/$name.err" >&2
    exit "${PIPESTATUS[0]}"
  } 3>&1)" || status=$?
  # A guest callback V8 ran inside a bridge call that lent no store never
  # ran, and read as `undefined` (#1090). A debug iwci aborts on the first.
  if dropped="$(grep -c 'no store lent to this thread' "$SCRATCH/$name.err")"; then
    echo "  FAIL $dropped guest callbacks did not run for want of a store (\"no store lent\" in iwci's stderr)"
    failed=1
  fi
  # What Node prints straight to standard error is the job's: the bridge
  # printed an unsettled top-level await's warning on iwci's own (#1150).
  if grep -q 'top-level await' "$SCRATCH/$name.err"; then
    echo "  FAIL a job's top-level await warning is on iwci's own stderr"
    failed=1
  fi
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
         (if (.id | endswith("-passes")) then "passed"
          elif (.id | endswith("-errors")) then "error" else "failed" end),
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
  if grep -q "$IWCI_SECRET_FIXTURE_TOKEN" <<<"$out" || grep -q "$KUBE_FIXTURE_TOKEN" <<<"$out" ||
    grep -qF -e "$IWCI_SECRET_AWS_FIXTURE_KEY" -e "$IWCI_SECRET_AWS_FIXTURE_TOKEN" -e "$AWS_FIXTURE_SECRET_KEY" \
      -e "$IWCI_SECRET_GCP_FIXTURE_TOKEN" -e "$IWCI_SECRET_AZURE_FIXTURE_SECRET" \
      -e "$VERCEL_FIXTURE_TOKEN" -e "$CLOUDFLARE_FIXTURE_TOKEN" -e "$NEON_FIXTURE_KEY" \
      -e "$GH_FIXTURE_TOKEN" -e "$GH_FIXTURE_BASIC" <<<"$out"; then
    echo "  FAIL the secret's value appears in the report"
    failed=1
  fi
  # Every line of a lent private key is masked (exec-passes prints one).
  if [[ "$name" == openssh ]]; then
    while read -r line; do
      if [[ "$line" != -----* ]] && grep -qF "$line" <<<"$out"; then
        echo "  FAIL a line of the lent private key appears in the report"
        failed=1
        break
      fi
    done <"$SCRATCH/ssh-keys/deploy"
  fi
  if [[ "$failed" == 1 ]]; then
    # The whole report, for the tool's own output.
    jq '.pipelines[0].report.jobs[] | {id, status, reason, message, execution}' <<<"$out" >&2
  fi
done

# An environment's caches across runs (#1083): the same job run twice, and
# Go's build cache comes back on the second, which compiles nothing (the
# first compiles the module's two packages, as `build-passes` does).
for name in "$@"; do
  [[ "$name" == go@* ]] || continue
  echo "== $name, its build cache on a second run"
  for want in 2 0; do
    file="$SCRATCH/$name-cache-$want.yml"
    sed -e "s/@MINOR@/${name#go@}/g" -e "s/@WANT@/$want/g" >"$file" <<'YAML'
name: go-cache-@MINOR@
workspace:
  deps:
    - go: { dir: gomod }
jobs:
  build-cache:
    using: env:go@@MINOR@
    cwd: /app/gomod
    timeout: 10m
    run: |
      go build -x -o /tmp/app . 2> /tmp/build.log
      test "$(/tmp/app)" = 36
      test "$(grep -c '/compile -o' /tmp/build.log || true)" = @WANT@
YAML
    out="$("$IWCI" run --repo "$repo" --branch main --pipeline "$file" --json \
      --store "$SCRATCH/store" --cache "$SCRATCH/cache")" || true
    job_status="$(jq -r '.pipelines[0].report.jobs[0].status // "none"' <<<"$out")"
    caches="$(jq -r '.pipelines[0].report.jobs[0].caches // [] | join("; ")' <<<"$out")"
    if [[ "$job_status" == passed ]]; then
      echo "  ok   $want compiles: $caches"
    else
      echo "  FAIL expected $want compiles: $job_status ($caches)"
      jq '.pipelines[0].report.jobs[0] | {status, reason, message, execution}' <<<"$out" >&2
      failed=1
    fi
  done
done
exit "$failed"
