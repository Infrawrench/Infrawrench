#!/usr/bin/env bash
# bash for the `env:` environments: Wasmer's `wasmer/bash` 1.0.25 with its
# `execve` passing the argument and environment lists as lists (#1003).
#
# The C library linked into that module predates `proc_exec4`. Its `execve`
# joins `argv` into one string with a line feed after each argument and
# hands that to `proc_exec3`, which splits it at line feeds again, so an
# argument with a line feed in it reached the program as several: a
# multi-line `node -e`, `python -c` or `bash -c` ran only its first line.
# Every program bash runs is started by that `execve` (bash forks, then
# execs), so every `run:` script met it. No release of `wasmer/bash` is
# built on a newer C library, and rebuilding bash on one changes its fork,
# signals and job control along with it.
#
# So this changes that one call, in the published module, and nothing else.
# `proc_exec4` takes the same nine arguments as `proc_exec3`, with the two
# lists as arrays of string pointers and their lengths as counts instead of
# joined strings and byte lengths. `execve(path, argv, envp)` still has
# `argv` and `envp` in its parameters when it makes the call, and the
# module has a function that counts a null-terminated pointer array, so the
# change is nine bytes in seven places, none changing a length:
#
#   - the import's name, `proc_exec3` to `proc_exec4`;
#   - the two lengths: `strlen(args)` and `strlen(envs)` become that
#     counting function of `argv` and `envp`;
#   - the two lists in the call: the joined strings become `argv` and `envp`.
#
# `execve` still builds the joined strings, which nothing reads any more.
# Each site is checked for the bytes it should hold before it is changed,
# and the module's hash before and after, so a different input fails here
# rather than building something nobody looked at. The disassembly the
# offsets come from (`wasm-objdump -d`, function 250, the only caller of
# `proc_exec3`):
#
#   040c55: 20 0a     local.get 10 (args)   -> 20 01  local.get 1 (argv)
#   040c57: 10 e3 0c  call 1635 (strlen)    -> 10 c8 07  call 968 (count)
#   040c5c: 20 08     local.get 8 (envs)    -> 20 02  local.get 2 (envp)
#   040c5e: 10 e3 0c  call 1635 (strlen)    -> 10 c8 07  call 968 (count)
#   040c7a: 20 0a     local.get 10 (args)   -> 20 01  local.get 1 (argv)
#   040c7e: 20 08     local.get 8 (envs)    -> 20 02  local.get 2 (envp)
#
# Function 968 is `i = -1; do { i++; } while (*p++); return i`, with no
# calls, so asyncify left it alone. Locals 1 and 2 are `execve`'s `argv` and
# `envp` parameters, which nothing assigns before the call. bash's other
# commands (sed, grep, coreutils, findutils, Edge.js) start programs with
# `proc_spawn2`/`proc_spawn3`/`proc_exec4` on their own, and are unchanged.
#
# The module goes back into the published package with the Wasmer CLI
# (`patch-module.sh`, shared with `sed/build.sh`). Drop this directory, and
# pin Wasmer's package again, once a `wasmer/bash` release is built on a C
# library whose `execve` calls `proc_exec4`.
#
# The result goes to dist/package/bash/<version>/, and is the same bytes on
# every host `patch-module.sh` runs on: `environments/build.sh` pins its
# hash. Needs what `patch-module.sh` needs.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
# shellcheck source=builtins/environments/patch-module.sh
source "$here/environments/patch-module.sh"

# Our build of 1.0.25. A changed build is a new number after `iwci.`.
VERSION="1.0.25-iwci.1"
WEBC_SHA256="059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1"
MODULE_SHA256="5b37a9f95fca50f55024b7fc37b786fa80024e55320266cb19936729d24c70ce"
PATCHED_SHA256="c31996f7570dc0367bb8f7cbab55e9af1a2f4bea51ee3c9f6a278917b731f033"
# The time every file in the package is said to have been modified: the
# module's release (wasix-org/bash `fc8096485478`, Release 1.0.25).
BUILT_ON="202602171016.51" # touch -t, in UTC

# offset (hex), the bytes there (hex), what they become. The first is the
# import's name in the import section, `proc_exec3` to `proc_exec4`.
PATCHES=(
  "0x71b 70726f635f6578656333 70726f635f6578656334"
  "0x40c55 200a 2001"
  "0x40c57 10e30c 10c807"
  "0x40c5c 2008 2002"
  "0x40c5e 10e30c 10c807"
  "0x40c7a 200a 2001"
  "0x40c7e 2008 2002"
)

patch_package "${BASH_WORK:-$SCRATCH/bash}" bash "$VERSION" "$WEBC_SHA256" "$MODULE_SHA256" \
  "$PATCHED_SHA256" "$BUILT_ON" "${PATCHES[@]}"
