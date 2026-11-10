//! Naming what killed a guest that died of a signal (#955).
//!
//! A WASIX program that gets a fatal signal says only which one: wasix-libc
//! prints `Program recieved fatal signal: Bad system call` and exits with
//! 127, and nothing records who sent the signal or why. A Node job once died
//! that way while starting up, one job in 689, and could not be explained
//! afterwards.
//!
//! wasmer-wasix already describes what is needed through `tracing`: every
//! syscall is an instrumented span that reports its return value, and the
//! delivery of a signal to a guest's handler is an event. [`Recorder`] is a
//! `tracing` subscriber that keeps, per job:
//!
//! - **the signals guests sent** (`thread_signal`, `proc_signal` and
//!   `proc_raise`: what `raise`, `pthread_kill`, `kill` and `abort` become),
//!   with the target and the signal, except that `proc_raise`'s span does
//!   not carry its signal;
//! - **the signals delivered** to a guest's handler, and the ones a process
//!   without a handler ignored;
//! - **the syscalls that returned `ENOSYS` or `ENOTSUP`**, by name, with how
//!   often;
//! - with each signal sent, **what the sending thread did before**: its last
//!   syscalls and their return values, and how the process or guest thread
//!   it runs began there, started or resumed from a deep sleep, and how many
//!   syscalls ago. That is as near to a guest backtrace as the host has.
//!
//! When a job then fails the way a signal makes it fail, [`SignalLog::report`]
//! writes those out, and `wasix::run` appends them to the job's stderr, so
//! they reach the live log and the report by the path the job's own output
//! takes (and are masked like it). A signal that was delivered without any
//! guest having sent it came from the host runtime, and one that libc names
//! but that was never delivered was raised inside the guest, without a
//! syscall; the report says which.
//!
//! Nothing here holds job text: the records are syscall names, process and
//! thread ids, signal names and errno names.
//!
//! Everything else wasmer-wasix traces is refused at the callsite, which
//! `tracing` caches, so it costs what it cost without a subscriber. Syscall
//! returns are the exception: each one is formatted into a small buffer on
//! the stack, to see whether it is `ENOSYS`, and kept in a ring of the
//! thread's own, with no lock.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt::{self, Write as _};
use std::sync::{Arc, Mutex, Once, Weak};
use std::time::{Duration, Instant};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::subscriber::Interest;
use tracing::{Event, Metadata, Subscriber};

/// Signal records kept per job: the newest, which are the ones nearest the
/// death they explain.
const SIGNALS_KEPT: usize = 24;
/// Distinct syscalls remembered as having returned `ENOSYS` or `ENOTSUP`.
const SYSCALLS_KEPT: usize = 16;

/// The syscalls a guest sends a signal with that wasmer-wasix traces
/// (`proc_raise_interval`, behind `setitimer`, is not).
const SENDERS: [&str; 3] = ["thread_signal", "proc_signal", "proc_raise"];

/// What wasix-libc's default handlers print before they abort.
const LIBC_SAYS: &[u8] = b"Program recieved ";

thread_local! {
    /// The job whose guest code this thread runs, set whenever the job
    /// makes a store here, which wasmer-wasix does at the start of every
    /// task. It stays set after the task ends, when nothing on this thread
    /// makes syscalls, until the next task replaces it.
    static ATTENDING: RefCell<Weak<SignalLog>> = const { RefCell::new(Weak::new()) };
    /// What this thread's guest code did last (see [`Recent`]).
    static RECENT: RefCell<Recent> = const { RefCell::new(Recent::new()) };
}

/// How many of a thread's last syscalls a signal it sends is recorded with.
const RECENT_KEPT: usize = 64;
/// How much of a syscall's return value is kept with it.
const RETURN_KEPT: usize = 24;
/// What stands for a task starting in a thread's recent syscalls.
const TASK_START: &str = "[task start]";

/// A thread's last syscalls and their return values, and where a task
/// started on it: a process or guest thread starting, or resuming after a
/// wait long enough to give its thread back (a deep sleep). A thread that
/// sends a signal is recorded with these, which is the nearest thing to a
/// backtrace of the guest the host has.
struct Recent {
    calls: [Call; RECENT_KEPT],
    /// Calls made, ever: the next goes in `calls[made % RECENT_KEPT]`.
    made: usize,
    /// `made` when the thread's current task started.
    task_started: usize,
    /// The current task is a process or thread back from a deep sleep: it
    /// unwound its stack, gave its thread back, and was rebuilt on this one
    /// (a new instance, its globals restored, its stack rewound).
    task_resumed: bool,
}

#[derive(Clone, Copy)]
struct Call {
    syscall: &'static str,
    ret: [u8; RETURN_KEPT],
    len: u8,
}

impl Recent {
    const fn new() -> Self {
        Self {
            calls: [Call {
                syscall: "",
                ret: [0; RETURN_KEPT],
                len: 0,
            }; RECENT_KEPT],
            made: 0,
            task_started: 0,
            task_resumed: false,
        }
    }

    /// Notes that a task is starting on the thread.
    fn start(&mut self) {
        self.push(TASK_START, b"");
        self.task_started = self.made;
        self.task_resumed = false;
    }

    /// `started 40 syscalls before` or `resumed from a deep sleep 40
    /// syscalls before`: how the thread's current task began.
    fn task(&self) -> String {
        format!(
            "{} {} syscalls before",
            if self.task_resumed {
                "resumed from a deep sleep"
            } else {
                "started"
            },
            self.made - self.task_started
        )
    }

    fn push(&mut self, syscall: &'static str, ret: &[u8]) {
        let len = ret.len().min(RETURN_KEPT);
        let call = &mut self.calls[self.made % RECENT_KEPT];
        call.syscall = syscall;
        call.ret[..len].copy_from_slice(&ret[..len]);
        call.len = len as u8;
        self.made += 1;
    }

    /// The calls oldest first, as `fd_read path_open2=Errno::noent
    /// futex_wait x3`: a return value is given only when it is not success,
    /// and a call repeated in a row is counted.
    fn describe(&self) -> String {
        let kept = self.made.min(RECENT_KEPT);
        let mut text = String::new();
        let mut last = String::new();
        let mut times = 0;
        let flush = |text: &mut String, last: &str, times: usize| {
            if times == 0 {
                return;
            }
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(last);
            if times > 1 {
                let _ = write!(text, " x{times}");
            }
        };
        for i in self.made - kept..self.made {
            let call = &self.calls[i % RECENT_KEPT];
            let ret = String::from_utf8_lossy(&call.ret[..usize::from(call.len)]);
            let mut one = call.syscall.to_owned();
            if !matches!(
                &*ret,
                "" | "Ok(())" | "Errno::success" | "Ok(Errno::success)"
            ) {
                one.push('=');
                one.push_str(&ret);
            }
            if one == last {
                times += 1;
            } else {
                flush(&mut text, &last, times);
                last = one;
                times = 1;
            }
        }
        flush(&mut text, &last, times);
        text
    }
}

/// One job's signals and unimplemented syscalls.
#[derive(Default)]
pub(crate) struct SignalLog {
    inner: Mutex<Log>,
}

#[derive(Default)]
struct Log {
    signals: VecDeque<(Instant, Signalled)>,
    /// Syscall, errno, times, last time.
    unimplemented: Vec<(String, &'static str, u32, Instant)>,
}

/// One signal record.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Signalled {
    /// A guest called `syscall` with `args`; `before` is what its thread
    /// did before that ([`Recent::describe`]) and `task` how the task it
    /// was running began ([`Recent::task`]).
    Sent {
        syscall: &'static str,
        args: String,
        before: String,
        task: String,
    },
    /// A process ran its handler for a signal (`fields` name both).
    Delivered { fields: String },
    /// A process with no handler was sent a signal that does not end it.
    Ignored { fields: String },
}

impl Signalled {
    /// SIGCHLD is every shell's background noise: a child exited.
    fn is_child_exit(&self) -> bool {
        let text = match self {
            Self::Sent { args, .. } => args,
            Self::Delivered { fields } | Self::Ignored { fields } => fields,
        };
        text.contains("Sigchld")
    }
}

impl fmt::Display for Signalled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sent { syscall, args, .. } if args.is_empty() => {
                write!(f, "a guest called {syscall} (its signal is not traced)")
            }
            Self::Sent { syscall, args, .. } => write!(f, "a guest called {syscall}({args})"),
            Self::Delivered { fields } => write!(f, "delivered to a handler: {fields}"),
            Self::Ignored { fields } => write!(f, "ignored, no handler: {fields}"),
        }
    }
}

impl std::fmt::Debug for SignalLog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignalLog").finish_non_exhaustive()
    }
}

impl SignalLog {
    /// Makes this the job the calling thread's guest code belongs to, and
    /// notes that a task is starting on the thread.
    pub(crate) fn attend(self: &Arc<Self>) {
        let same = ATTENDING.with(|attending| {
            let mut attending = attending.borrow_mut();
            let same = std::ptr::eq(attending.as_ptr(), Arc::as_ptr(self));
            *attending = Arc::downgrade(self);
            same
        });
        RECENT.with(|recent| {
            let mut recent = recent.borrow_mut();
            if !same {
                // The thread's last task was another job's.
                *recent = Recent::new();
            }
            recent.start();
        });
    }

    fn signalled(&self, what: Signalled) {
        let mut log = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if log.signals.len() == SIGNALS_KEPT {
            log.signals.pop_front();
        }
        log.signals.push_back((Instant::now(), what));
    }

    fn unimplemented(&self, syscall: &str, errno: &'static str) {
        let now = Instant::now();
        let mut log = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = log
            .unimplemented
            .iter_mut()
            .find(|(name, e, ..)| name == syscall && *e == errno)
        {
            entry.2 = entry.2.saturating_add(1);
            entry.3 = now;
        } else if log.unimplemented.len() < SYSCALLS_KEPT {
            log.unimplemented.push((syscall.to_owned(), errno, 1, now));
        }
    }

    /// What to add to the log of a job that exited with `exit_code` having
    /// written `stderr`, when that is how a signal ends a job: wasix-libc
    /// said so, or the status is the one a signal gives (127 from libc's
    /// `abort`, 128 + the signal from the host) and a signal other than
    /// SIGCHLD was seen. `None` for every other job, however it failed.
    pub(crate) fn report(&self, exit_code: i32, stderr: &[u8]) -> Option<String> {
        let log = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let libc_said = stderr
            .windows(LIBC_SAYS.len())
            .any(|window| window == LIBC_SAYS);
        let signalled = log.signals.iter().any(|(_, s)| !s.is_child_exit());
        let by_status = (exit_code == 127 || exit_code > 128) && signalled;
        if !libc_said && !by_status {
            return None;
        }
        let now = Instant::now();
        let ago = |at: Instant| Ago(now.saturating_duration_since(at));
        let mut text = format!(
            "iwci: the job exited with {exit_code} after a signal. What the runner saw of it (#955):\n"
        );
        for (at, signal) in &log.signals {
            let _ = writeln!(text, "  {} before the end, {signal}", ago(*at));
            if let Signalled::Sent { before, task, .. } = signal
                && !before.is_empty()
            {
                let _ = writeln!(text, "    its thread's syscalls before that: {before}");
                let _ = writeln!(text, "    its thread's task had {task}");
            }
        }
        let delivered = log
            .signals
            .iter()
            .any(|(_, s)| matches!(s, Signalled::Delivered { .. }) && !s.is_child_exit());
        let sent = log
            .signals
            .iter()
            .any(|(_, s)| matches!(s, Signalled::Sent { .. }) && !s.is_child_exit());
        if libc_said && !delivered {
            // libc's line comes from a handler; the host ran none.
            text.push_str(
                "  no signal was delivered to a handler: the one libc names was raised inside the guest, without a syscall\n",
            );
        } else if delivered && !sent {
            text.push_str(
                "  no guest sent these with a syscall: they came from the host runtime (a write to a closed pipe, a timer, the runner stopping the job)\n",
            );
        }
        if log.unimplemented.is_empty() {
            text.push_str("  no syscall returned ENOSYS or ENOTSUP\n");
        }
        for (syscall, errno, times, last) in &log.unimplemented {
            let _ = writeln!(
                text,
                "  syscall {syscall} returned {errno} {times} time{}, last {} before the end",
                if *times == 1 { "" } else { "s" },
                ago(*last)
            );
        }
        Some(text)
    }
}

/// A duration as a log line says it.
struct Ago(Duration);

impl fmt::Display for Ago {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0 < Duration::from_secs(1) {
            write!(f, "{}ms", self.0.as_millis())
        } else {
            write!(f, "{:.1}s", self.0.as_secs_f64())
        }
    }
}

/// Starts recording, once per process. Does nothing if the process already
/// has a `tracing` subscriber, which then sees wasmer-wasix's events itself,
/// or if `IWCI_SIGNAL_LOG=0` turns it off (it looks at every syscall's
/// return value, which is the one cost it has).
pub(crate) fn install() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        if std::env::var_os("IWCI_SIGNAL_LOG").is_some_and(|v| v == "0") {
            return;
        }
        let _ = tracing::dispatcher::set_global_default(tracing::Dispatch::new(Recorder));
    });
}

/// The `tracing` subscriber (see the module comment).
struct Recorder;

/// What a callsite is to the recorder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wanted {
    /// The span of a syscall that sends a signal.
    Sender(&'static str),
    /// The event carrying a syscall's return value.
    Return,
    /// wasmer-wasix handing a signal to a guest's handler, or dropping it.
    Delivery,
    /// A thread entering or leaving a deep sleep, or rewinding after one.
    Sleep,
}

fn wanted(meta: &Metadata<'_>) -> Option<Wanted> {
    let target = meta.target();
    if target.starts_with("wasmer_wasix::syscalls") {
        if meta.is_span() {
            return SENDERS
                .iter()
                .copied()
                .find(|name| *name == meta.name())
                .map(Wanted::Sender);
        }
        let fields = meta.fields();
        if fields.field("return").is_some() {
            return Some(Wanted::Return);
        }
        // "thread entering deep sleep", "thread leaving deep sleep" and the
        // rewinds, the only events here that name a pid and a tid.
        if target == "wasmer_wasix::syscalls"
            && fields.field("pid").is_some()
            && fields.field("tid").is_some()
        {
            return Some(Wanted::Sleep);
        }
        return None;
    }
    if target == "wasmer_wasix::state::env" && meta.is_event() {
        // "processing signal via handler" names it `signal`, "Signal
        // ignored" names it `sig`.
        let fields = meta.fields();
        if fields.field("signal").is_some() || fields.field("sig").is_some() {
            return Some(Wanted::Delivery);
        }
    }
    None
}

fn attending() -> Option<Arc<SignalLog>> {
    ATTENDING.with(|attending| attending.borrow().upgrade())
}

impl Subscriber for Recorder {
    fn register_callsite(&self, meta: &'static Metadata<'static>) -> Interest {
        if wanted(meta).is_some() {
            Interest::always()
        } else {
            Interest::never()
        }
    }

    fn enabled(&self, meta: &Metadata<'_>) -> bool {
        wanted(meta).is_some()
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::TRACE)
    }

    fn new_span(&self, attrs: &Attributes<'_>) -> Id {
        if let Some(Wanted::Sender(syscall)) = wanted(attrs.metadata())
            && let Some(log) = attending()
        {
            let mut args = Fields::default();
            attrs.record(&mut args);
            log.signalled(Signalled::Sent {
                syscall,
                args: args.0,
                before: RECENT.with(|recent| recent.borrow().describe()),
                task: RECENT.with(|recent| recent.borrow().task()),
            });
        }
        // Spans are recorded when they are made and never looked up.
        Id::from_u64(1)
    }

    fn record(&self, _span: &Id, _values: &Record<'_>) {}

    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}

    fn event(&self, event: &Event<'_>) {
        match wanted(event.metadata()) {
            Some(Wanted::Sleep) => {
                let mut message = Head::of("message");
                event.record(&mut message);
                if message.has(b"leaving deep sleep") {
                    // On the thread the task was rebuilt on, before it runs.
                    RECENT.with(|recent| recent.borrow_mut().task_resumed = true);
                } else if message.has(b"entering deep sleep") {
                    RECENT.with(|recent| recent.borrow_mut().push("[deep sleep]", b""));
                }
            }
            Some(Wanted::Return) => {
                let mut ret = Head::of("return");
                event.record(&mut ret);
                // `wasmer_wasix::syscalls::wasix::proc_spawn2` names the
                // syscall last.
                let target = event.metadata().target();
                let syscall = target.rsplit("::").next().unwrap_or(target);
                RECENT.with(|recent| recent.borrow_mut().push(syscall, &ret.text[..ret.len]));
                if let Some(errno) = ret.unimplemented()
                    && let Some(log) = attending()
                {
                    log.unimplemented(syscall, errno);
                }
            }
            Some(Wanted::Delivery) => {
                let Some(log) = attending() else { return };
                let mut fields = Fields::default();
                event.record(&mut fields);
                let ignored = fields.0.contains("message=Signal_ignored");
                let fields = fields.without_message();
                log.signalled(if ignored {
                    Signalled::Ignored { fields }
                } else {
                    Signalled::Delivered { fields }
                });
            }
            Some(Wanted::Sender(_)) | None => {}
        }
    }

    fn enter(&self, _span: &Id) {}

    fn exit(&self, _span: &Id) {}
}

/// A span's or event's fields as `name=value`, space separated, capped.
#[derive(Default)]
struct Fields(String);

impl Fields {
    /// The fields without the event's message.
    fn without_message(self) -> String {
        self.0
            .split(' ')
            .filter(|part| !part.starts_with("message="))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if self.0.len() > 200 {
            return;
        }
        if !self.0.is_empty() {
            self.0.push(' ');
        }
        if field.name() == "message" {
            // One word, so `without_message` can drop it.
            let _ = write!(self.0, "message={}", format!("{value:?}").replace(' ', "_"));
        } else {
            let _ = write!(self.0, "{}={value:?}", field.name());
        }
    }
}

/// The start of one field of an event, formatted without allocating: a
/// syscall's return value, an event's message.
struct Head {
    field: &'static str,
    text: [u8; 48],
    len: usize,
}

impl Head {
    fn of(field: &'static str) -> Self {
        Self {
            field,
            text: [0; 48],
            len: 0,
        }
    }

    fn has(&self, needle: &[u8]) -> bool {
        self.text[..self.len]
            .windows(needle.len())
            .any(|window| window == needle)
    }

    /// The errno, when the syscall said it is not implemented.
    fn unimplemented(&self) -> Option<&'static str> {
        if self.has(b"Errno::nosys") {
            Some("ENOSYS")
        } else if self.has(b"Errno::notsup") {
            Some("ENOTSUP")
        } else {
            None
        }
    }
}

impl fmt::Write for Head {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let room = self.text.len() - self.len;
        let take = room.min(s.len());
        self.text[self.len..self.len + take].copy_from_slice(&s.as_bytes()[..take]);
        self.len += take;
        // Full: stop the formatter, what matters comes first.
        if take < s.len() {
            Err(fmt::Error)
        } else {
            Ok(())
        }
    }
}

impl Visit for Head {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == self.field {
            let _ = write!(self, "{value:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent(syscall: &'static str, args: &str) -> Signalled {
        Signalled::Sent {
            syscall,
            args: args.to_owned(),
            before: String::new(),
            task: String::new(),
        }
    }

    #[test]
    fn a_job_that_failed_on_its_own_gets_no_report() {
        let log = SignalLog::default();
        log.unimplemented("sock_open", "ENOTSUP");
        log.signalled(Signalled::Delivered {
            fields: "pid=1 signal=Signal::Sigchld".into(),
        });
        // A test that failed, a missing command, a script's own `exit 130`.
        assert_eq!(log.report(1, b"1 test failed\n"), None);
        assert_eq!(log.report(127, b"bash: nope: command not found\n"), None);
        assert_eq!(log.report(130, b""), None);
    }

    #[test]
    fn a_fatal_signal_is_reported_with_who_sent_it_and_what_was_unimplemented() {
        let log = SignalLog::default();
        log.unimplemented("proc_spawn2", "ENOSYS");
        log.unimplemented("proc_spawn2", "ENOSYS");
        log.signalled(sent("thread_signal", "tid=1 sig=Signal::Sigsys"));
        log.signalled(Signalled::Delivered {
            fields: "pid=3 signal=Signal::Sigsys".into(),
        });
        let report = log
            .report(127, b"Program recieved fatal signal: Bad system call\n")
            .unwrap();
        assert!(report.starts_with("iwci: the job exited with 127 after a signal."));
        assert!(
            report.contains("a guest called thread_signal(tid=1 sig=Signal::Sigsys)"),
            "{report}"
        );
        assert!(
            report.contains("delivered to a handler: pid=3 signal=Signal::Sigsys"),
            "{report}"
        );
        assert!(
            report.contains("syscall proc_spawn2 returned ENOSYS 2 times"),
            "{report}"
        );
        assert!(!report.contains("host runtime"), "{report}");
    }

    #[test]
    fn a_signal_no_guest_sent_is_the_hosts() {
        let log = SignalLog::default();
        log.signalled(Signalled::Delivered {
            fields: "pid=3 signal=Signal::Sigsys".into(),
        });
        let report = log
            .report(127, b"Program recieved fatal signal: Bad system call\n")
            .unwrap();
        assert!(report.contains("came from the host runtime"), "{report}");
        assert!(report.contains("no syscall returned ENOSYS"), "{report}");

        // Nothing delivered, only libc's own abort afterwards, as in #955:
        // the signal libc names never passed through the host.
        let log = SignalLog::default();
        log.signalled(sent("thread_signal", "tid=0 sig=Signal::Sigabrt"));
        let report = log
            .report(127, b"Program recieved fatal signal: Bad system call\n")
            .unwrap();
        assert!(report.contains("raised inside the guest"), "{report}");
        assert!(!report.contains("host runtime"), "{report}");
    }

    #[test]
    fn the_status_a_signal_gives_is_enough_without_libcs_words() {
        let log = SignalLog::default();
        log.signalled(sent("proc_raise", "sig=Signal::Sigabrt"));
        assert!(log.report(134, b"").is_some());
        assert!(log.report(127, b"").is_some());
        assert_eq!(log.report(1, b""), None);
    }

    #[test]
    fn only_the_newest_signals_and_a_bounded_set_of_syscalls_are_kept() {
        let log = SignalLog::default();
        for i in 0..100 {
            log.signalled(sent("proc_raise", &format!("sig={i}")));
            log.unimplemented(&format!("syscall_{i}"), "ENOSYS");
        }
        let inner = log.inner.lock().unwrap();
        assert_eq!(inner.signals.len(), SIGNALS_KEPT);
        assert_eq!(
            inner.signals.back().unwrap().1,
            sent("proc_raise", "sig=99")
        );
        assert_eq!(inner.unimplemented.len(), SYSCALLS_KEPT);
    }

    #[test]
    fn a_thread_keeps_its_newest_syscalls_in_order() {
        let mut recent = Recent::new();
        assert_eq!(recent.describe(), "");
        recent.push(TASK_START, b"");
        recent.push("fd_read", b"Ok(Errno::success)");
        recent.push("path_open2", b"Ok(Errno::noent)");
        recent.push("futex_wait", b"Ok(Errno::success)");
        recent.push("futex_wait", b"Ok(Errno::success)");
        recent.push("proc_id", b"Errno::success");
        recent.push(
            "sock_open",
            b"Ok(Errno::notsup) and more than is kept of it",
        );
        assert_eq!(
            recent.describe(),
            "[task start] fd_read path_open2=Ok(Errno::noent) futex_wait x2 proc_id sock_open=Ok(Errno::notsup) and mo"
        );
        for i in 0..RECENT_KEPT {
            recent.push(
                if i % 2 == 0 {
                    "clock_time_get"
                } else {
                    "fd_write"
                },
                b"Errno::success",
            );
        }
        let text = recent.describe();
        assert_eq!(text.matches("clock_time_get").count(), RECENT_KEPT / 2);
        assert!(!text.contains("fd_read"), "{text}");
    }

    #[test]
    fn a_sent_signal_is_reported_with_what_its_thread_did_before() {
        let log = SignalLog::default();
        log.signalled(Signalled::Sent {
            syscall: "thread_signal",
            args: "tid=0 sig=Signal::Sigabrt".into(),
            before: "[task start] futex_wait".into(),
            task: "resumed from a deep sleep 1 syscalls before".into(),
        });
        let report = log.report(127, b"").unwrap();
        assert!(
            report.contains("    its thread's syscalls before that: [task start] futex_wait\n"),
            "{report}"
        );
        assert!(
            report.contains(
                "    its thread's task had resumed from a deep sleep 1 syscalls before\n"
            ),
            "{report}"
        );
    }

    #[test]
    fn a_thread_knows_how_its_task_began_and_how_long_ago() {
        let mut recent = Recent::new();
        recent.push("fd_read", b"Ok(Errno::success)");
        recent.start();
        assert_eq!(recent.task(), "started 0 syscalls before");
        for _ in 0..40 {
            recent.push("fd_read", b"Ok(Errno::success)");
        }
        assert_eq!(recent.task(), "started 40 syscalls before");
        // wasmer-wasix says a task is back from a deep sleep once it has
        // been set up on its new thread.
        recent.start();
        recent.task_resumed = true;
        recent.push("futex_wait", b"Ok(Errno::success)");
        assert_eq!(recent.task(), "resumed from a deep sleep 1 syscalls before");
        recent.start();
        assert_eq!(recent.task(), "started 0 syscalls before");
    }

    #[test]
    fn a_return_value_is_read_from_its_first_bytes() {
        let mut ret = Head::of("return");
        let _ = write!(ret, "Ok(Errno::nosys)");
        assert_eq!(ret.unimplemented(), Some("ENOSYS"));
        let mut ret = Head::of("return");
        let _ = write!(ret, "Errno::notsup");
        assert_eq!(ret.unimplemented(), Some("ENOTSUP"));
        let mut ret = Head::of("return");
        let _ = write!(ret, "Ok(Errno::success)");
        assert_eq!(ret.unimplemented(), None);
        // Longer than the buffer: cut, not a panic.
        let mut ret = Head::of("return");
        let _ = write!(ret, "{}", "x".repeat(500));
        assert_eq!(ret.len, 48);
        assert_eq!(ret.unimplemented(), None);
    }
}
