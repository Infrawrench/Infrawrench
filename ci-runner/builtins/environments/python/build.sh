#!/usr/bin/env bash
# CPython for env:python and the cloud CLI environments: Wasmer's
# `python/python` 3.13.20 (CPython 3.13.15) with file locks (#1216), which
# keeps its own PYTHONEXECUTABLE to itself (#1310; keep_executable_to_itself)
# and finds itself on PATH when started by a bare name (#1334).
#
# Its C library has no file locking. `flock` does nothing and answers 0;
# `fcntl` answers ENOSYS for F_GETLK, F_SETLK and F_SETLKW without asking
# the runtime, since WASIX had no call for it. CPython was built without
# `flock`, so `fcntl.flock` uses F_SETLK(W), and `fcntl.flock`,
# `fcntl.lockf` and what is built on them (portalocker, msal-extensions and
# with them the Azure CLI's token cache, `filelock`'s Unix lock) failed with
# "[Errno 52] Function not implemented".
#
# The runner's WASIX now has the calls (`iwci_fd_flock` and
# `iwci_fd_record_lock`, vendor/README.md). This puts them in the module:
# `file-locks.py` edits its text form (`wasm-tools print`, with every
# function referred to by name, so a new import renumbers nothing by hand)
# and `wasm-tools parse` makes it a module again. `flock` and the three
# `fcntl` commands call the runtime; `fcntl.flock` takes a `flock` lock, as
# CPython does on Linux. Nothing else in the module changes, though
# `wasm-tools` writes it out in its own encoding (shorter LEB128s, its own
# name section). Each text it replaces must be there exactly once, and the
# module's hash is checked before and after, so a different input fails
# here rather than building something nobody looked at.
#
# `path-search.py` then edits the same text so that a regular file counts as
# executable when CPython looks for itself on PATH (`isxfile` in getpath).
# The C library's `stat` gives no mode, so that search never found anything:
# after a venv's `activate`, a bare `python` (which bash finds in the venv)
# came up with an empty `sys.executable`, never read the venv's
# `pyvenv.cfg`, and ran as the base interpreter. Now it finds the file bash
# found, as CPython does on Linux. Keep it as long as the C library's `stat`
# has no execute bits.
#
# The module goes back into the published package with the Wasmer CLI
# (`patch-module.sh`, as bash/build.sh and sed/build.sh do it). Drop this
# directory, and pin Wasmer's package again, once a `python/python` release
# is built on a C library whose `flock` and `fcntl` lock (and the runtime
# has a call for them that upstream WASIX defines).
#
# The result goes to dist/package/python/<version>/, and is the same bytes
# on every host it runs on: `environments/build.sh` pins its hash. That
# needs the package unpacked on a case-sensitive file system, since its
# terminfo has names that differ only in case; `patch-module.sh` sees to it
# (#1335). Needs python3, and what `patch-module.sh` needs.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
# shellcheck source=builtins/environments/patch-module.sh
source "$here/environments/patch-module.sh"

# Our build of 3.13.20. A changed build is a new number after `iwci.`.
VERSION="3.13.20-iwci.3"
WEBC_SHA256="a9fa8202f1bf6a4eca8d31ee5f2b1970c8f45af5c5520cc954d28a133333d8e7"
MODULE_SHA256="3fc48792e8f667333a6397fd9ce6961a5a76cd69160c5af6af074a32c0baf3f4"
REWRITTEN_SHA256="ed0ec4d8ddbca8e5c57abe26d8b0931d0608441f83639f03aef7f4c97efcd9d4"
# The time every file in the package is said to have been modified: the
# day this build was first made.
BUILT_ON="202611150000.00" # touch -t, in UTC

WASM_TOOLS_VERSION="1.219.1"

# rewrite_python <module>: the module with file locks, in place.
rewrite_python() {
  local module="$1" work="${PYTHON_WORK:-$SCRATCH/python}" asset asset_sha
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
      asset="x86_64-linux"
      asset_sha="4b7a764bf421fb33de78a45a94d5d832b29befe3d4977f935db4bdab09b17fd1"
      ;;
    Linux-aarch64 | Linux-arm64)
      asset="aarch64-linux"
      asset_sha="24f6d96def108ca2ed089f8bdad47386e77f3a5bb1fea636fb572a1e3c3c5a3f"
      ;;
    Darwin-arm64)
      asset="aarch64-macos"
      asset_sha="415b36faf03522b36ed7a54be85f8077b6188a97eabfa742bc2e843ef84cb464"
      ;;
    *)
      echo "error: no pinned wasm-tools for $(uname -s)-$(uname -m) (Linux x86_64 or arm64, macOS arm64)" >&2
      exit 1
      ;;
  esac
  local name="wasm-tools-$WASM_TOOLS_VERSION-$asset"
  rm -rf "${work:?}/$name"
  tar -xzf "$(download "$work/dl" \
    "https://github.com/bytecodealliance/wasm-tools/releases/download/v$WASM_TOOLS_VERSION/$name.tar.gz" \
    "$asset_sha" "$name.tar.gz")" -C "$work"
  local tools="$work/$name/wasm-tools"
  "$tools" print "$module" -o "$work/python.wat"
  python3 "$here/environments/python/file-locks.py" "$work/python.wat" "$work/python-locks.wat"
  python3 "$here/environments/python/path-search.py" "$work/python-locks.wat" "$work/python-path.wat"
  "$tools" parse "$work/python-path.wat" -o "$module"
  rm -f "$work/python.wat" "$work/python-locks.wat" "$work/python-path.wat"
  keep_executable_to_itself "${module%/modules/*}"
}

# The package's Nix `sitecustomize.py`, before and after the lines below.
SITECUSTOMIZE="fs/nix/store/wf0002v5izqcb7kg59n8cilx58lcp373-python3-static-wasm32-unknown-wasi-3.13.15/lib/python3.13/site-packages/sitecustomize.py"
SITECUSTOMIZE_SHA256="5778dbc0e4f80ab0f4767d316fc5c2dea842ee349cba02187ce5f88ab56ec078"
SITECUSTOMIZED_SHA256="1ddba15358c897cc74b077f979f6e5b7d75bbb9e7c5d16beac4ca487ef668d81"

# keep_executable_to_itself <package>: the interpreter does not pass on
# PYTHONEXECUTABLE (#1310).
#
# Each of the package's commands sets it to /bin/python3.13, which tells the
# interpreter its own path. Every program the interpreter started inherited
# it, so a venv's interpreter that `python -m venv` started (to run
# ensurepip) took itself for /bin/python3.13 and missed its venv. That went
# unseen while a child's environment was laid over its parent's start-up
# one, which also put back the `PIP_*` variables ensurepip removes, so pip
# installed into this interpreter instead. Now a child gets only what it is
# passed, so pip found this interpreter externally managed and refused.
# The Nix `sitecustomize.py` already keeps its own NIX_PYTHONEXECUTABLE from
# leaking this way; this does the same for the package's variable, and only
# when it holds the package's value, so one a job sets itself is left alone.
keep_executable_to_itself() {
  local file="$1/$SITECUSTOMIZE"
  if [[ "$(sha256 "$file")" != "$SITECUSTOMIZE_SHA256" ]]; then
    echo "error: the package's sitecustomize.py is not the one expected" >&2
    exit 1
  fi
  cat >>"$file" <<'PY'

# iwci (ci-runner/builtins/environments/python/build.sh): PYTHONEXECUTABLE is
# this package's commands telling the interpreter its own path. A program it
# starts, such as a venv's interpreter, is not this interpreter (#1310).
if os.environ.get('PYTHONEXECUTABLE') == '/bin/python3.13':
    del os.environ['PYTHONEXECUTABLE']
PY
  if [[ "$(sha256 "$file")" != "$SITECUSTOMIZED_SHA256" ]]; then
    echo "error: the changed sitecustomize.py hashed to $(sha256 "$file"), expected $SITECUSTOMIZED_SHA256" >&2
    exit 1
  fi
}

rewrite_package "${PYTHON_WORK:-$SCRATCH/python}" python "$VERSION" "$WEBC_SHA256" "$MODULE_SHA256" \
  "$REWRITTEN_SHA256" "$BUILT_ON" rewrite_python
