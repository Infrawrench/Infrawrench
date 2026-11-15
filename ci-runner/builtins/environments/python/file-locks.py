"""Gives CPython's module the runner's file locks (#1216), in its text form.

    python3 file-locks.py <in.wat> <out.wat>

Wasmer's CPython is built on a C library with no file locking: its `flock`
does nothing and answers 0, and its `fcntl` answers ENOSYS for F_GETLK,
F_SETLK and F_SETLKW without asking the runtime. CPython, built without
`flock`, implements `fcntl.flock` with F_SETLK(W), so `fcntl.flock`,
`fcntl.lockf` and everything built on them (portalocker, msal-extensions,
filelock with fcntl) failed with ENOSYS.

The runner's WASIX has the two calls a C library needs
(`wasix_32v1.iwci_fd_flock` and `iwci_fd_record_lock`, vendor/README.md).
This edits the module's text, as `wasm-tools print` writes it, so that:

- `flock` calls `iwci_fd_flock`;
- `fcntl` calls `iwci_fd_record_lock` for F_GETLK (7), F_SETLK (8) and
  F_SETLKW (9), and the C library's own `fcntl` (renamed) for the rest;
- `fcntl.flock` (`fcntl_flock_impl`) takes a `flock` lock, as CPython does
  on Linux, rather than a record lock: its F_SETLK(W) call goes through
  `iwci_flock_from_fcntl`, which turns the `struct flock` it built back into
  the `flock` operation it was made from.

Every piece of text replaced must be there exactly once, as written here,
or nothing is written: a different module fails the build rather than
being edited somewhere else.
"""

import sys

# The last WASIX import; the two calls go after it.
IMPORT_ANCHOR = (
    '  (import "wasix_32v1" "context_destroy" '
    "(func $__imported_wasix_32v1_context_destroy (;139;) (type 28)))\n"
)
IMPORTS = (
    '  (import "wasix_32v1" "iwci_fd_flock" (func $iwci_fd_flock (type 4)))\n'
    '  (import "wasix_32v1" "iwci_fd_record_lock" (func $iwci_fd_record_lock (type 6)))\n'
)

# The C library's `flock`, which does nothing.
FLOCK = """  (func $flock (;31591;) (type 4) (param i32 i32) (result i32)
    (local i32)
    global.get $__stack_pointer
    i32.const 16
    i32.sub
    local.set 2
    local.get 2
    local.get 0
    i32.store offset=12
    local.get 2
    local.get 1
    i32.store offset=8
    i32.const 0
    return
  )
"""
# errno is the first word of the thread's TLS block, as the C library's
# own functions set it (`global.get $__tls_base` ... `i32.store`).
NEW_FLOCK = """  (func $flock (type 4) (param i32 i32) (result i32)
    (local i32)
    local.get 0
    local.get 1
    call $iwci_fd_flock
    local.tee 2
    if ;; label = @1
      global.get $__tls_base
      local.get 2
      i32.store
      i32.const -1
      return
    end
    i32.const 0
  )
"""

# The C library's `fcntl`, kept under another name for everything but the
# record locks.
FCNTL_HEAD = "  (func $fcntl (;179;) (type 6) (param i32 i32 i32) (result i32)\n"
RENAMED_FCNTL_HEAD = "  (func $iwci_wasix_libc_fcntl (type 6) (param i32 i32 i32) (result i32)\n"
# Its third argument is the address of its variadic arguments, the first of
# which is the `struct flock *` for these three commands.
NEW_FCNTL = """  (func $fcntl (type 6) (param i32 i32 i32) (result i32)
    (local i32)
    block ;; label = @1
      local.get 1
      i32.const 7
      i32.sub
      i32.const 3
      i32.ge_u
      br_if 0 (;@1;)
      local.get 0
      local.get 1
      i32.const 7
      i32.sub
      local.get 2
      i32.load
      call $iwci_fd_record_lock
      local.tee 3
      if ;; label = @2
        global.get $__tls_base
        local.get 3
        i32.store
        i32.const -1
        return
      end
      i32.const 0
      return
    end
    local.get 0
    local.get 1
    local.get 2
    call $iwci_wasix_libc_fcntl
  )
"""

# `fcntl.flock`: CPython built the `struct flock` from the `flock`
# operation (l_type F_RDLCK 0, F_WRLCK 1 or F_UNLCK 2 from LOCK_SH, LOCK_EX
# or LOCK_UN; F_SETLK for LOCK_NB, else F_SETLKW) and calls `fcntl` with
# it. This takes the operation back out and calls `flock`.
FLOCK_IMPL_HEAD = "  (func $fcntl_flock_impl (;9863;) (type 4) (param i32 i32) (result i32)\n"
FLOCK_IMPL_CALL = "            call $fcntl\n"
NEW_FLOCK_IMPL_CALL = "            call $iwci_flock_from_fcntl\n"
FLOCK_FROM_FCNTL = """  (func $iwci_flock_from_fcntl (type 6) (param i32 i32 i32) (result i32)
    (local i32)
    i32.const 1
    local.set 3
    block ;; label = @1
      local.get 2
      i32.load
      i32.load16_s
      local.tee 2
      i32.eqz
      br_if 0 (;@1;)
      i32.const 2
      i32.const 8
      local.get 2
      i32.const 1
      i32.eq
      select
      local.set 3
    end
    local.get 0
    local.get 3
    i32.const 4
    i32.const 0
    local.get 1
    i32.const 8
    i32.eq
    select
    i32.or
    call $flock
  )
"""


def replace_once(text: str, old: str, new: str, what: str) -> str:
    count = text.count(old)
    if count != 1:
        sys.exit(f"error: {what} is in the module {count} times, not once; check what changed")
    return text.replace(old, new)


def main() -> None:
    source, target = sys.argv[1], sys.argv[2]
    with open(source, encoding="utf-8") as f:
        text = f.read()

    text = replace_once(text, IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORTS, "the last WASIX import")
    text = replace_once(text, FLOCK, NEW_FLOCK + FLOCK_FROM_FCNTL, "the C library's flock")

    start = text.find(FLOCK_IMPL_HEAD)
    if start < 0 or text.count(FLOCK_IMPL_HEAD) != 1:
        sys.exit("error: fcntl_flock_impl is not in the module once; check what changed")
    end = text.index("\n  )\n", start) + len("\n  )\n")
    body = replace_once(
        text[start:end], FLOCK_IMPL_CALL, NEW_FLOCK_IMPL_CALL, "fcntl_flock_impl's call of fcntl"
    )
    text = text[:start] + body + text[end:]

    text = replace_once(text, FCNTL_HEAD, NEW_FCNTL + RENAMED_FCNTL_HEAD, "the C library's fcntl")

    with open(target, "w", encoding="utf-8") as f:
        f.write(text)


if __name__ == "__main__":
    main()
