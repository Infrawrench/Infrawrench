;; The WASIX side of a native program inside a job's sandbox (inside.rs).
;;
;; A script's shell finds this module on PATH under the native program's
;; name (`bun`) and runs it as any other command. It hands its arguments,
;; environment and working directory to the runner through
;; /proc/iwci/native, which starts the native program, and then carries its
;; own standard streams to and from the program's until the program's
;; output ends, and exits as the program did.
;;
;; `@SPAWN@` is replaced by the length and bytes of the path it opens to
;; start the program, `proc/iwci/native/spawn/<name>`, relative to the
;; preopened root.
;;
;; Memory:
;;     0  iovecs, counts, small results
;;    64  the request header: argc, argv bytes, envc, environ bytes, cwd bytes
;;   128  iovecs of the request
;;   256  poll subscriptions (3 x 48)
;;   512  poll events (3 x 32)
;;  1024  "proc/iwci/native/"
;;  1100  the spawn path
;;  1280  a session file's path, built here
;;  1536  the session id the runner gave
;;  1600  the exit status the runner gave
;;  1700  "iwci: could not start the native program\n"
;;  2048  stdin waiting to be written (64 KiB)
;; 67584  output read and being written (64 KiB)
;; 135168 argv, the environment and the working directory, then the end
(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get" (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get" (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_get" (func $fd_prestat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_dir_name" (func $fd_prestat_dir_name (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_raise" (func $proc_raise (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (import "wasix_32v1" "getcwd" (func $getcwd (param i32 i32) (result i32)))

  (memory (export "memory") 4)

  (global $prefix_len i32 (i32.const 17))
  (data (i32.const 1024) "proc/iwci/native/")
  (global $spawn_len i32 (i32.const @SPAWN_LEN@))
  (data (i32.const 1100) "@SPAWN@")
  (data (i32.const 1700) "iwci: could not start the native program\0a")

  (global $stdin_buf i32 (i32.const 2048))
  (global $io_buf i32 (i32.const 67584))
  (global $buf_size i32 (i32.const 65536))
  (global $dynamic i32 (i32.const 135168))

  ;; Gives up: says so on stderr and exits 127, as a shell does for a
  ;; command it cannot run.
  (func $fail
    (i32.store (i32.const 0) (i32.const 1700))
    (i32.store (i32.const 4) (i32.const 41))
    (drop (call $fd_write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 8)))
    (call $proc_exit (i32.const 127))
    unreachable)

  ;; Makes sure memory reaches `end`.
  (func $reserve (param $end i32)
    (local $have i32)
    (local.set $have (i32.mul (memory.size) (i32.const 65536)))
    (if (i32.gt_u (local.get $end) (local.get $have))
      (then
        (if (i32.lt_s
              (memory.grow (i32.add
                (i32.div_u (i32.sub (local.get $end) (local.get $have)) (i32.const 65536))
                (i32.const 1)))
              (i32.const 0))
          (then (call $fail))))))

  ;; The preopened directory named `/`.
  (func $root (result i32)
    (local $fd i32)
    (local.set $fd (i32.const 3))
    (block $done
      (loop $next
        (br_if $done (i32.gt_u (local.get $fd) (i32.const 64)))
        (if (i32.eqz (call $fd_prestat_get (local.get $fd) (i32.const 16)))
          (then
            (if (i32.eq (i32.load (i32.const 20)) (i32.const 1))
              (then
                (if (i32.eqz (call $fd_prestat_dir_name (local.get $fd) (i32.const 24) (i32.const 1)))
                  (then
                    (if (i32.eq (i32.load8_u (i32.const 24)) (i32.const 47))
                      (then (return (local.get $fd))))))))))
        (local.set $fd (i32.add (local.get $fd) (i32.const 1)))
        (br $next)))
    (call $fail)
    unreachable)

  ;; Opens `len` bytes of path at `path` under `root`, for reading and
  ;; writing as the runner's file allows.
  (func $open (param $root i32) (param $path i32) (param $len i32) (result i32)
    (if (call $path_open (local.get $root) (i32.const 0) (local.get $path) (local.get $len)
          (i32.const 0) (i64.const 0x1fffffff) (i64.const 0) (i32.const 0) (i32.const 32))
      (then (call $fail)))
    (i32.load (i32.const 32)))

  ;; `proc/iwci/native/<id>/<name>` at 1280, opened.
  (func $session_file (param $root i32) (param $id_len i32) (param $name i32) (param $name_len i32) (result i32)
    (local $at i32)
    (memory.copy (i32.const 1280) (i32.const 1024) (global.get $prefix_len))
    (local.set $at (i32.add (i32.const 1280) (global.get $prefix_len)))
    (memory.copy (local.get $at) (i32.const 1536) (local.get $id_len))
    (local.set $at (i32.add (local.get $at) (local.get $id_len)))
    (i32.store8 (local.get $at) (i32.const 47))
    (local.set $at (i32.add (local.get $at) (i32.const 1)))
    (memory.copy (local.get $at) (local.get $name) (local.get $name_len))
    (local.set $at (i32.add (local.get $at) (local.get $name_len)))
    (call $open (local.get $root) (i32.const 1280) (i32.sub (local.get $at) (i32.const 1280))))

  ;; Reads into `buf`, at most `max` bytes: how many, or -1 on an error.
  (func $read (param $fd i32) (param $buf i32) (param $max i32) (result i32)
    (i32.store (i32.const 0) (local.get $buf))
    (i32.store (i32.const 4) (local.get $max))
    (if (call $fd_read (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8))
      (then (return (i32.const -1))))
    (i32.load (i32.const 8)))

  ;; Writes all of `len` bytes at `buf`; stops quietly when `fd` fails.
  (func $write_all (param $fd i32) (param $buf i32) (param $len i32)
    (block $done
      (loop $more
        (br_if $done (i32.eqz (local.get $len)))
        (i32.store (i32.const 0) (local.get $buf))
        (i32.store (i32.const 4) (local.get $len))
        (br_if $done (call $fd_write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8)))
        (br_if $done (i32.eqz (i32.load (i32.const 8))))
        (local.set $buf (i32.add (local.get $buf) (i32.load (i32.const 8))))
        (local.set $len (i32.sub (local.get $len) (i32.load (i32.const 8))))
        (br $more))))

  ;; Reads `fd` to its end (at most 31 bytes) at `buf`: how many.
  (func $read_small (param $fd i32) (param $buf i32) (result i32)
    (local $got i32) (local $n i32)
    (block $done
      (loop $more
        (local.set $n (call $read (local.get $fd)
          (i32.add (local.get $buf) (local.get $got))
          (i32.sub (i32.const 31) (local.get $got))))
        (br_if $done (i32.le_s (local.get $n) (i32.const 0)))
        (local.set $got (i32.add (local.get $got) (local.get $n)))
        (br_if $done (i32.ge_u (local.get $got) (i32.const 31)))
        (br $more)))
    (local.get $got))

  ;; One subscription at index `i`: userdata `tag`, for reading (1) or
  ;; writing (2) `fd`.
  (func $subscribe (param $i i32) (param $tag i32) (param $kind i32) (param $fd i32)
    (local $at i32)
    (local.set $at (i32.add (i32.const 256) (i32.mul (local.get $i) (i32.const 48))))
    (memory.fill (local.get $at) (i32.const 0) (i32.const 48))
    (i64.store (local.get $at) (i64.extend_i32_u (local.get $tag)))
    (i32.store8 (i32.add (local.get $at) (i32.const 8)) (local.get $kind))
    (i32.store (i32.add (local.get $at) (i32.const 16)) (local.get $fd)))

  (func $start (export "_start")
    (local $root i32) (local $argc i32) (local $argv_size i32) (local $envc i32) (local $env_size i32)
    (local $argv_ptrs i32) (local $argv_buf i32) (local $env_ptrs i32) (local $env_buf i32)
    (local $cwd i32) (local $cwd_len i32) (local $end i32)
    (local $spawn i32) (local $id_len i32) (local $in i32) (local $out i32) (local $err i32) (local $status i32)
    (local $in_open i32) (local $out_open i32) (local $err_open i32)
    (local $pending i32) (local $pending_at i32)
    (local $nsubs i32) (local $nevents i32) (local $i i32) (local $tag i32) (local $n i32)
    (local $code i32) (local $at i32) (local $signal i32)

    (local.set $root (call $root))

    ;; Arguments, environment, working directory.
    (if (call $args_sizes_get (i32.const 64) (i32.const 68)) (then (call $fail)))
    (if (call $environ_sizes_get (i32.const 72) (i32.const 76)) (then (call $fail)))
    (local.set $argc (i32.load (i32.const 64)))
    (local.set $argv_size (i32.load (i32.const 68)))
    (local.set $envc (i32.load (i32.const 72)))
    (local.set $env_size (i32.load (i32.const 76)))
    (local.set $argv_ptrs (global.get $dynamic))
    (local.set $argv_buf (i32.add (local.get $argv_ptrs) (i32.mul (i32.add (local.get $argc) (i32.const 1)) (i32.const 4))))
    (local.set $env_ptrs (i32.and (i32.add (i32.add (local.get $argv_buf) (local.get $argv_size)) (i32.const 3)) (i32.const -4)))
    (local.set $env_buf (i32.add (local.get $env_ptrs) (i32.mul (i32.add (local.get $envc) (i32.const 1)) (i32.const 4))))
    (local.set $cwd (i32.add (local.get $env_buf) (local.get $env_size)))
    (local.set $end (i32.add (local.get $cwd) (i32.const 4097)))
    (call $reserve (local.get $end))
    (if (call $args_get (local.get $argv_ptrs) (local.get $argv_buf)) (then (call $fail)))
    (if (call $environ_get (local.get $env_ptrs) (local.get $env_buf)) (then (call $fail)))
    (i32.store (i32.const 40) (i32.const 4096))
    (if (call $getcwd (local.get $cwd) (i32.const 40)) (then (call $fail)))
    (local.set $cwd_len (i32.load (i32.const 40)))
    (i32.store (i32.const 80) (local.get $cwd_len))

    ;; The request: header, argv, environment, working directory.
    (i32.store (i32.const 128) (i32.const 64))
    (i32.store (i32.const 132) (i32.const 20))
    (i32.store (i32.const 136) (local.get $argv_buf))
    (i32.store (i32.const 140) (local.get $argv_size))
    (i32.store (i32.const 144) (local.get $env_buf))
    (i32.store (i32.const 148) (local.get $env_size))
    (i32.store (i32.const 152) (local.get $cwd))
    (i32.store (i32.const 156) (local.get $cwd_len))
    (local.set $spawn (call $open (local.get $root) (i32.const 1100) (global.get $spawn_len)))
    (if (call $fd_write (local.get $spawn) (i32.const 128) (i32.const 4) (i32.const 8)) (then (call $fail)))
    (if (i32.ne (i32.load (i32.const 8))
          (i32.add (i32.add (i32.const 20) (local.get $argv_size)) (i32.add (local.get $env_size) (local.get $cwd_len))))
      (then (call $fail)))
    ;; Reading it back starts the program and gives its session's id, or
    ;; nothing when it could not be started.
    (local.set $id_len (call $read_small (local.get $spawn) (i32.const 1536)))
    (if (i32.eqz (local.get $id_len)) (then (call $fail)))
    (local.set $in (call $session_file (local.get $root) (local.get $id_len) (i32.const 1650) (i32.const 2)))
    (local.set $out (call $session_file (local.get $root) (local.get $id_len) (i32.const 1653) (i32.const 3)))
    (local.set $err (call $session_file (local.get $root) (local.get $id_len) (i32.const 1657) (i32.const 3)))
    (local.set $status (call $session_file (local.get $root) (local.get $id_len) (i32.const 1661) (i32.const 6)))
    (local.set $in_open (i32.const 1))
    (local.set $out_open (i32.const 1))
    (local.set $err_open (i32.const 1))

    ;; Until the program's output ends: its output to ours, our input to
    ;; its, as each is ready.
    (block $finished
      (loop $round
        (br_if $finished (i32.and (i32.eqz (local.get $out_open)) (i32.eqz (local.get $err_open))))
        (local.set $nsubs (i32.const 0))
        (if (local.get $out_open)
          (then
            (call $subscribe (local.get $nsubs) (i32.const 1) (i32.const 1) (local.get $out))
            (local.set $nsubs (i32.add (local.get $nsubs) (i32.const 1)))))
        (if (local.get $err_open)
          (then
            (call $subscribe (local.get $nsubs) (i32.const 2) (i32.const 1) (local.get $err))
            (local.set $nsubs (i32.add (local.get $nsubs) (i32.const 1)))))
        (if (local.get $in_open)
          (then
            (if (local.get $pending)
              (then (call $subscribe (local.get $nsubs) (i32.const 3) (i32.const 2) (local.get $in)))
              (else (call $subscribe (local.get $nsubs) (i32.const 4) (i32.const 1) (i32.const 0))))
            (local.set $nsubs (i32.add (local.get $nsubs) (i32.const 1)))))
        (if (call $poll_oneoff (i32.const 256) (i32.const 512) (local.get $nsubs) (i32.const 12))
          (then (call $fail)))
        (local.set $nevents (i32.load (i32.const 12)))
        (local.set $i (i32.const 0))
        (block $events_done
          (loop $event
            (br_if $events_done (i32.ge_u (local.get $i) (local.get $nevents)))
            (local.set $tag (i32.wrap_i64 (i64.load (i32.add (i32.const 512) (i32.mul (local.get $i) (i32.const 32))))))
            (if (i32.eq (local.get $tag) (i32.const 1))
              (then
                (local.set $n (call $read (local.get $out) (global.get $io_buf) (global.get $buf_size)))
                (if (i32.le_s (local.get $n) (i32.const 0))
                  (then (local.set $out_open (i32.const 0)))
                  (else (call $write_all (i32.const 1) (global.get $io_buf) (local.get $n))))))
            (if (i32.eq (local.get $tag) (i32.const 2))
              (then
                (local.set $n (call $read (local.get $err) (global.get $io_buf) (global.get $buf_size)))
                (if (i32.le_s (local.get $n) (i32.const 0))
                  (then (local.set $err_open (i32.const 0)))
                  (else (call $write_all (i32.const 2) (global.get $io_buf) (local.get $n))))))
            (if (i32.eq (local.get $tag) (i32.const 3))
              (then
                (i32.store (i32.const 0) (i32.add (global.get $stdin_buf) (local.get $pending_at)))
                (i32.store (i32.const 4) (local.get $pending))
                (if (call $fd_write (local.get $in) (i32.const 0) (i32.const 1) (i32.const 8))
                  (then
                    ;; The program closed its input.
                    (drop (call $fd_close (local.get $in)))
                    (local.set $in_open (i32.const 0))
                    (local.set $pending (i32.const 0)))
                  (else
                    (local.set $pending_at (i32.add (local.get $pending_at) (i32.load (i32.const 8))))
                    (local.set $pending (i32.sub (local.get $pending) (i32.load (i32.const 8))))))))
            (if (i32.eq (local.get $tag) (i32.const 4))
              (then
                (local.set $n (call $read (i32.const 0) (global.get $stdin_buf) (global.get $buf_size)))
                (if (i32.le_s (local.get $n) (i32.const 0))
                  (then
                    (drop (call $fd_close (local.get $in)))
                    (local.set $in_open (i32.const 0)))
                  (else
                    (local.set $pending (local.get $n))
                    (local.set $pending_at (i32.const 0))))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $event)))
        (br $round)))

    ;; How it ended: `<code>` or `s<signal>`.
    (local.set $n (call $read_small (local.get $status) (i32.const 1600)))
    (local.set $at (i32.const 1600))
    (if (i32.and (i32.gt_s (local.get $n) (i32.const 0)) (i32.eq (i32.load8_u (i32.const 1600)) (i32.const 115)))
      (then
        (local.set $signal (i32.const 1))
        (local.set $at (i32.const 1601))))
    (block $parsed
      (loop $digit
        (br_if $parsed (i32.ge_u (local.get $at) (i32.add (i32.const 1600) (local.get $n))))
        (br_if $parsed (i32.lt_u (i32.load8_u (local.get $at)) (i32.const 48)))
        (br_if $parsed (i32.gt_u (i32.load8_u (local.get $at)) (i32.const 57)))
        (local.set $code (i32.add (i32.mul (local.get $code) (i32.const 10))
          (i32.sub (i32.load8_u (local.get $at)) (i32.const 48))))
        (local.set $at (i32.add (local.get $at) (i32.const 1)))
        (br $digit)))
    (if (local.get $signal)
      (then
        ;; Ended by a signal: so does this process, which its shell then
        ;; reports as it would the program.
        (if (i32.and (i32.ge_u (local.get $code) (i32.const 1)) (i32.le_u (local.get $code) (i32.const 15)))
          (then (drop (call $proc_raise (local.get $code)))))
        (call $proc_exit (i32.add (i32.const 128) (local.get $code)))))
    (call $proc_exit (local.get $code)))

  (data (i32.const 1650) "in\00out\00err\00status"))
