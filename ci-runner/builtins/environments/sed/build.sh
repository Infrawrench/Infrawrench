#!/usr/bin/env bash
# sed for the `env:` environments: Wasmer's `wasmer/sed` 4.9.0 (GNU sed)
# with its `posix_spawn` passing the argument and environment lists as lists
# (#1022).
#
# sed's `e` command, and the `e` flag of `s///`, run a command through
# `popen`, which starts `sh -c <command>` with `posix_spawn`. The C library
# linked into that module predates `proc_spawn3`: its `posix_spawn` joins
# `argv` into one string with a line feed after each argument and hands that
# to `proc_spawn2`, which splits it at line feeds again, so a command with a
# line feed in it reached the shell as several arguments, the script cut at
# its first line. The same as bash's `execve` (#1003, `bash/build.sh`). No
# release of `wasmer/sed` is built on a newer C library (4.9.0, February
# 2026, is the only one; wasix-org/sed is a Rust rewrite with no release).
#
# So this changes that one call, in the published module, and nothing else.
# `proc_spawn3` takes the same fourteen arguments as `proc_spawn2`, with the
# two lists as arrays of string pointers and their lengths as counts instead
# of joined strings and byte lengths. `__posix_spawn(pid, path, actions,
# attr, argv, envp, search)` still has `argv` and `envp` in its parameters
# (locals 4 and 5) when it builds the joined strings, and the module's
# `wcslen` counts a null-terminated array of 32-bit words, which is what a
# pointer array is here, so the change is fourteen bytes in five places,
# none changing a length:
#
#   - the import's name, `proc_spawn2` to `proc_spawn3`;
#   - in `__posix_spawn` (function 225, the only caller of the wrapper
#     `__wasi_proc_spawn2`), each joined string is stored in the local that
#     is freed after the call, and `argv` or `envp` passed in its place. The
#     call to `__wasilibc_exec_combine_strings` (function 224) is encoded in
#     five bytes, padded; in two it leaves room for the extra `local.get`:
#
#       00fdf0: 10 e0 81 80 80 00  call 224    -> 10 e0 01  call 224
#       00fdf6: 22 0d              local.tee 13   21 0d     local.set 13
#                                                 20 04     local.get 4 (argv)
#                                                 01        nop
#       00fdfa: 10 e0 81 80 80 00  call 224    -> 10 e0 01  call 224
#       00fe00: 22 0b              local.tee 11   21 0b     local.set 11
#                                                 20 05     local.get 5 (envp)
#                                                 01        nop
#
#   - in `__wasi_proc_spawn2` (function 79), the two lengths: `strlen(args)`
#     and `strlen(envs)` become `wcslen` (function 352) of `argv` and `envp`:
#
#       000ff4: 10 a7 80 80 80 00  call 39 (strlen) -> 10 e0 82 80 80 00  call 352
#       000ffe: 10 a7 80 80 80 00  call 39 (strlen) -> 10 e0 82 80 80 00  call 352
#
# `wcslen` makes no calls, and the module is not asyncified (it unwinds with
# WebAssembly exceptions), so nothing else depends on those bytes. A null
# `envp` stays null, which `proc_spawn3` reads as "inherit", as `proc_spawn2`
# did. Each site is checked for the bytes it should hold before it is
# changed, and the module's hash before and after, so a different input
# fails here rather than building something nobody looked at.
#
# The module goes back into the published package with the Wasmer CLI
# (`patch-module.sh`, shared with `bash/build.sh`). Drop this directory, and
# pin Wasmer's package again, once a `wasmer/sed` release is built on a C
# library whose `posix_spawn` calls `proc_spawn3`.
#
# The result goes to dist/package/sed/<version>/, and is the same bytes on
# every host `patch-module.sh` runs on: `environments/build.sh` pins its
# hash. Needs what `patch-module.sh` needs.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../../lib.sh"
# shellcheck source=builtins/environments/patch-module.sh
source "$here/environments/patch-module.sh"

# Our build of 4.9.0. A changed build is a new number after `iwci.`.
VERSION="4.9.0-iwci.1"
WEBC_SHA256="3fc12256be87f6b8b7810d68d642359a6220f63b39a2ea6ef7a2bb6d79ec1393"
MODULE_SHA256="1b1905e9252987599139cb7a04b04e846472438b5821a57eea0c9a15fd0189c1"
PATCHED_SHA256="ab408e2d3d343e39baea3c418f71de52c617019cf1e0f8b1e00fa37ef29cc0e0"
# The time every file in the package is said to have been modified: the
# package's publication (`wasmer/sed` 4.9.0 on the Wasmer registry).
BUILT_ON="202602240314.03" # touch -t, in UTC

# offset (hex), the bytes there (hex), what they become. The first is the
# import's name in the import section, `proc_spawn2` to `proc_spawn3`.
PATCHES=(
  "0x56b 70726f635f737061776e32 70726f635f737061776e33"
  "0xff4 10a780808000 10e082808000"
  "0xffe 10a780808000 10e082808000"
  "0xfdf0 10e081808000220d 10e001210d200401"
  "0xfdfa 10e081808000220b 10e001210b200501"
)

patch_package "${SED_WORK:-$SCRATCH/sed}" sed "$VERSION" "$WEBC_SHA256" "$MODULE_SHA256" \
  "$PATCHED_SHA256" "$BUILT_ON" "${PATCHES[@]}"
