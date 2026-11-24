"""Lets CPython find itself on PATH (#1334), in its module's text form.

    python3 path-search.py <in.wat> <out.wat>

Started by a bare name (`python`, as bash starts the first `python` on
PATH), CPython looks for itself the way it does on Linux: getpath.py tries
each directory on PATH for a file of that name that `isxfile` says is an
executable file, and takes the first as `sys.executable`. A venv is found
from there, by the `pyvenv.cfg` beside it.

`isxfile` (`getpath_isxfile` in Modules/getpath.c) wants a regular file with
an execute bit in `st_mode`. This C library's `stat` fills in only the file
type (WASIX's `filestat` has no mode), so no file ever had one, the search
found nothing, `sys.executable` was empty and the interpreter fell back to
its built-in prefix: after a venv's `activate`, `python -m pip install`
installed into the base interpreter, not the venv. The package's own
commands hide it by setting PYTHONEXECUTABLE, which a venv's copy of the
interpreter does not have (and must not inherit, #1310).

This makes `isxfile` true for any regular file, which is what runs here:
bash, and the runtime's exec, start a regular file whatever its mode. So the
interpreter now finds the file bash found, as on Linux. getpath.py calls
`isxfile` only for this search (and for an `.exe` suffix on Windows).

The text replaced must be there exactly once, inside `getpath_isxfile`, or
nothing is written: a different module fails the build rather than being
edited somewhere else.
"""

import sys

ISXFILE_HEAD = "  (func $getpath_isxfile (;13836;) (type 4) (param i32 i32) (result i32)\n"
FUNC_END = "\n  )\n"

# `S_ISREG(st.st_mode) && (st.st_mode & 0111) ? Py_True : Py_False`, after
# the S_ISREG test has passed: True if any of the bits in 0111 (73) is set.
EXEC_BITS = """        global.get $GOT.data.internal._Py_FalseStruct
        local.set 4
        global.get $GOT.data.internal._Py_TrueStruct
        local.get 4
        local.get 3
        i32.const 73
        i32.and
        select
        local.set 4
"""
# True: a regular file is executable here.
REGULAR_FILE = """        global.get $GOT.data.internal._Py_TrueStruct
        local.set 4
"""


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8") as f:
        text = f.read()

    if text.count(ISXFILE_HEAD) != 1:
        sys.exit("error: getpath_isxfile is not in the module exactly once, as expected")
    start = text.index(ISXFILE_HEAD)
    end = text.index(FUNC_END, start) + len(FUNC_END)
    func = text[start:end]
    if func.count(EXEC_BITS) != 1:
        sys.exit("error: getpath_isxfile does not test the execute bits as expected")
    func = func.replace(EXEC_BITS, REGULAR_FILE)

    with open(dst, "w", encoding="utf-8") as f:
        f.write(text[:start] + func + text[end:])


if __name__ == "__main__":
    main()
