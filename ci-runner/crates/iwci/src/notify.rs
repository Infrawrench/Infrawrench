//! Telling whoever started a run that its state changed (`notify` in a run
//! request), so it reads the run at once rather than on its next poll.
//!
//! A notice says nothing the caller has to trust: it is the run's id and
//! state, and the caller then reads the run the way it always does
//! (`GET /v1/runs/{id}`, through the proxy). It carries the request's
//! `token` as a bearer key so the caller can tell its own notices from
//! anyone else's; the token is never stored, echoed or logged.
//!
//! - **While the run is going** a notice follows each pipeline's start and
//!   each job's start and end (never output), at most one a second
//!   ([`GAP`]): changes in between are one notice. One that fails is not
//!   retried, since the next change, or the run's end, says more.
//! - **When it ends**, once its entry and report are recorded, so a read
//!   that follows the notice finds it finished. That one goes at once and
//!   is retried for [`RETRY_FOR`] while the caller cannot be reached or
//!   answers `409` (it has not yet recorded that the run started here, as
//!   when its answer to `POST /v1/runs` is still on the way), `425`, `429`
//!   or `5xx`.
//!
//! Notices of one run go one at a time, in order, each waiting for the
//! caller's answer, so the caller never handles two of the same run at
//! once. Only `https` to a name is accepted: never an IP address or
//! `localhost`, so a notice cannot be aimed at the runner's own API or
//! another service on its network.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The longest `url` a request may name.
pub const MAX_URL: usize = 2048;
/// The longest `token`.
pub const MAX_TOKEN: usize = 512;
/// The least time between two notices of a run that is still going.
pub const GAP: Duration = Duration::from_secs(1);
/// How long one notice waits for the caller's answer.
pub const TIMEOUT: Duration = Duration::from_secs(30);
/// How long the notice of a run's end is retried for.
pub const RETRY_FOR: Duration = Duration::from_secs(120);
/// The longest wait between two tries of it.
const MAX_BACKOFF: Duration = Duration::from_secs(15);

/// Where to send a run's notices (`notify` in a run request).
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotifyRequest {
    /// An `https` URL each notice is posted to.
    pub url: String,
    /// Sent as `Authorization: Bearer <token>`. Never stored or echoed.
    pub token: String,
}

impl std::fmt::Debug for NotifyRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotifyRequest")
            .field("url", &self.url)
            .field("token", &"<hidden>")
            .finish()
    }
}

impl NotifyRequest {
    /// Refuses a URL that is not `https` to a name, and a token that could
    /// not go in a header.
    pub fn check(&self) -> Result<(), String> {
        if self.url.len() > MAX_URL {
            return Err(format!("`notify.url` is over {MAX_URL} characters"));
        }
        let uri: ureq::http::Uri = self
            .url
            .parse()
            .map_err(|_| "`notify.url` is not a URL".to_string())?;
        if uri.scheme_str() != Some("https") {
            return Err("`notify.url` must be https".into());
        }
        let Some(authority) = uri.authority() else {
            return Err("`notify.url` has no host".into());
        };
        if authority.as_str().contains('@') {
            return Err("`notify.url` may not carry a user or password".into());
        }
        let host = authority
            .host()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if host.is_empty()
            || host.parse::<std::net::IpAddr>().is_ok()
            || host == "localhost"
            || host.ends_with(".localhost")
        {
            return Err("`notify.url` must name a public host, not an address".into());
        }
        if self.token.is_empty()
            || self.token.len() > MAX_TOKEN
            || !self.token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(format!(
                "`notify.token` is 1 to {MAX_TOKEN} printable characters without spaces"
            ));
        }
        Ok(())
    }
}

/// What a notice says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Notice {
    /// The run's id on this runner.
    pub run: String,
    /// `running`, or how it ended: `finished` or `error`.
    pub state: &'static str,
}

/// What became of one notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// The caller has it.
    Done,
    /// Worth trying again: no answer, or one that says not yet.
    Again,
    /// Refused for good.
    Stop,
}

impl Answer {
    /// An HTTP status's meaning for a notice.
    pub fn of_status(status: u16) -> Self {
        match status {
            200..=299 => Answer::Done,
            409 | 425 | 429 | 500..=599 => Answer::Again,
            _ => Answer::Stop,
        }
    }
}

/// Sends one notice and says how it went.
pub type Sender = Arc<dyn Fn(&NotifyRequest, &Notice) -> Answer + Send + Sync>;

/// Sends notices over HTTPS, following no redirect.
pub fn http_sender() -> Sender {
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        // A redirect could carry the token somewhere the request did not name.
        .max_redirects(0)
        .timeout_global(Some(TIMEOUT))
        .build()
        .new_agent();
    Arc::new(move |target: &NotifyRequest, notice: &Notice| {
        let body = serde_json::to_vec(notice).unwrap_or_default();
        match agent
            .post(&target.url)
            .header("authorization", format!("Bearer {}", target.token))
            .header("content-type", "application/json")
            .send(&body[..])
        {
            Ok(response) => Answer::of_status(response.status().as_u16()),
            Err(_) => Answer::Again,
        }
    })
}

#[derive(Default)]
struct State {
    /// Something changed since the last notice.
    dirty: bool,
    /// How the run ended, once it has.
    ended: Option<&'static str>,
    /// The run's thread let go of its handle: nothing more will change.
    closed: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

/// A run's notices, sent from a thread of their own. The run's thread holds
/// this; [`Notifier::watcher`] is what its log sink holds. Dropped without
/// [`Notifier::ended`] (a run thread that panicked), the thread just stops.
pub struct Notifier {
    shared: Arc<Shared>,
}

/// Marks a run as changed, from wherever its log events come.
#[derive(Clone)]
pub struct Watcher {
    shared: Arc<Shared>,
}

impl Watcher {
    pub fn changed(&self) {
        let mut state = self.shared.state.lock().unwrap();
        state.dirty = true;
        self.shared.changed.notify_all();
    }
}

impl Notifier {
    /// Starts the thread that sends run `run`'s notices to `target`.
    /// `gone` is called once it has sent its last.
    pub fn start(
        target: NotifyRequest,
        run: String,
        send: Sender,
        gone: impl FnOnce() + Send + 'static,
    ) -> Self {
        Self::start_with(target, run, send, gone, GAP, RETRY_FOR)
    }

    fn start_with(
        target: NotifyRequest,
        run: String,
        send: Sender,
        gone: impl FnOnce() + Send + 'static,
        gap: Duration,
        retry_for: Duration,
    ) -> Self {
        let shared = Arc::new(Shared::default());
        let thread = shared.clone();
        std::thread::Builder::new()
            .name("iwci-notify".into())
            .spawn(move || {
                deliver(&thread, &target, &run, &send, gap, retry_for);
                gone();
            })
            .expect("spawning a notice thread");
        Self { shared }
    }

    pub fn watcher(&self) -> Watcher {
        Watcher {
            shared: self.shared.clone(),
        }
    }

    /// The run ended as `state` and is recorded: its last notice goes now.
    pub fn ended(&self, state: &'static str) {
        let mut s = self.shared.state.lock().unwrap();
        s.ended = Some(state);
        self.shared.changed.notify_all();
    }
}

impl Drop for Notifier {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        state.closed = true;
        self.shared.changed.notify_all();
    }
}

enum Next {
    Progress,
    End(&'static str),
    Stop,
}

fn deliver(
    shared: &Shared,
    target: &NotifyRequest,
    run: &str,
    send: &Sender,
    gap: Duration,
    retry_for: Duration,
) {
    loop {
        let next = {
            let mut state = shared.state.lock().unwrap();
            while !state.dirty && state.ended.is_none() && !state.closed {
                state = shared.changed.wait(state).unwrap();
            }
            if let Some(ended) = state.ended {
                Next::End(ended)
            } else if state.dirty {
                state.dirty = false;
                Next::Progress
            } else {
                Next::Stop
            }
        };
        match next {
            Next::Stop => return,
            Next::End(ended) => {
                send_end(target, run, ended, send, retry_for);
                return;
            }
            Next::Progress => {
                let notice = Notice {
                    run: run.to_string(),
                    state: "running",
                };
                // Not retried: the next change, or the end, says more.
                let _ = send(target, &notice);
                // A breath before the next, which the run's end cuts short.
                let until = Instant::now() + gap;
                let mut state = shared.state.lock().unwrap();
                while state.ended.is_none() && !state.closed {
                    let left = until.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    state = shared.changed.wait_timeout(state, left).unwrap().0;
                }
            }
        }
    }
}

/// The run's last notice, tried again while it is worth it.
fn send_end(
    target: &NotifyRequest,
    run: &str,
    ended: &'static str,
    send: &Sender,
    retry_for: Duration,
) {
    let notice = Notice {
        run: run.to_string(),
        state: ended,
    };
    let until = Instant::now() + retry_for;
    let mut backoff = Duration::from_millis(500);
    loop {
        match send(target, &notice) {
            Answer::Done => return,
            Answer::Stop => {
                eprintln!(
                    "iwci serve: the caller refused the notice that run {run} ended; it will find out by polling"
                );
                return;
            }
            Answer::Again => {}
        }
        if Instant::now() + backoff > until {
            eprintln!(
                "iwci serve: could not tell the caller that run {run} ended; it will find out by polling"
            );
            return;
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    fn target(url: &str) -> NotifyRequest {
        NotifyRequest {
            url: url.into(),
            token: "t0ken".into(),
        }
    }

    #[test]
    fn only_https_to_a_name_with_a_header_safe_token_is_accepted() {
        assert!(
            target("https://app.example.com/api/ci-notify/runs/1")
                .check()
                .is_ok()
        );
        assert!(target("https://app.example.com:8443/x").check().is_ok());
        for bad in [
            "http://app.example.com/x",
            "https://127.0.0.1/x",
            "https://10.0.0.5:8547/v1/drain",
            "https://[::1]/x",
            "https://169.254.169.254/latest",
            "https://localhost/x",
            "https://LOCALHOST./x",
            "https://runner.localhost/x",
            "https://user:pass@app.example.com/x",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(target(bad).check().is_err(), "{bad} was accepted");
        }
        let mut long = target("https://app.example.com/x");
        long.url.push_str(&"a".repeat(MAX_URL));
        assert!(long.check().is_err());
        for token in ["", "with space", "new\nline", &"a".repeat(MAX_TOKEN + 1)] {
            let t = NotifyRequest {
                url: "https://app.example.com/x".into(),
                token: token.into(),
            };
            assert!(t.check().is_err(), "{token:?} was accepted");
        }
    }

    #[test]
    fn a_request_never_prints_its_token() {
        let printed = format!("{:?}", target("https://app.example.com/x"));
        assert!(!printed.contains("t0ken"), "{printed}");
        assert!(printed.contains("app.example.com"));
    }

    #[test]
    fn statuses_say_whether_to_try_again() {
        assert_eq!(Answer::of_status(204), Answer::Done);
        assert_eq!(Answer::of_status(409), Answer::Again);
        assert_eq!(Answer::of_status(503), Answer::Again);
        assert_eq!(Answer::of_status(401), Answer::Stop);
        assert_eq!(Answer::of_status(404), Answer::Stop);
        assert_eq!(Answer::of_status(302), Answer::Stop);
    }

    /// A sender that records each notice and answers from `answers`, then
    /// `Done`.
    fn recorder(answers: Vec<Answer>) -> (Sender, mpsc::Receiver<Notice>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let answers = Mutex::new(answers.into_iter());
        let send: Sender = Arc::new(move |t: &NotifyRequest, notice: &Notice| {
            assert_eq!(t.token, "t0ken");
            tx.lock().unwrap().send(notice.clone()).unwrap();
            answers.lock().unwrap().next().unwrap_or(Answer::Done)
        });
        (send, rx)
    }

    fn wait(rx: &mpsc::Receiver<Notice>) -> Notice {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("a notice in time")
    }

    #[test]
    fn changes_become_notices_and_the_end_goes_at_once_and_last() {
        let (send, rx) = recorder(vec![]);
        let (gone_tx, gone_rx) = mpsc::channel();
        let notifier = Notifier::start_with(
            target("https://app.example.com/x"),
            "abc".into(),
            send,
            move || gone_tx.send(()).unwrap(),
            // A gap far longer than the test: only the end may cut it short.
            Duration::from_secs(600),
            Duration::from_secs(5),
        );
        let watcher = notifier.watcher();
        watcher.changed();
        assert_eq!(
            wait(&rx),
            Notice {
                run: "abc".into(),
                state: "running"
            }
        );
        // Changes within the gap are held, and the end does not wait for it.
        watcher.changed();
        watcher.changed();
        let started = Instant::now();
        notifier.ended("finished");
        drop(notifier);
        assert_eq!(wait(&rx).state, "finished");
        assert!(started.elapsed() < Duration::from_secs(5));
        gone_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the thread ends after the last notice");
        assert!(rx.try_recv().is_err(), "nothing after the end");
    }

    #[test]
    fn the_end_is_retried_until_the_caller_has_it_and_never_after_a_refusal() {
        let (send, rx) = recorder(vec![Answer::Again, Answer::Again, Answer::Done]);
        let (gone_tx, gone_rx) = mpsc::channel();
        let notifier = Notifier::start_with(
            target("https://app.example.com/x"),
            "abc".into(),
            send,
            move || gone_tx.send(()).unwrap(),
            Duration::ZERO,
            Duration::from_secs(30),
        );
        notifier.ended("error");
        drop(notifier);
        for _ in 0..3 {
            assert_eq!(wait(&rx).state, "error");
        }
        gone_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(rx.try_recv().is_err());

        let (send, rx) = recorder(vec![Answer::Stop]);
        let (gone_tx, gone_rx) = mpsc::channel();
        let notifier = Notifier::start_with(
            target("https://app.example.com/x"),
            "abc".into(),
            send,
            move || gone_tx.send(()).unwrap(),
            Duration::ZERO,
            Duration::from_secs(30),
        );
        notifier.ended("finished");
        drop(notifier);
        assert_eq!(wait(&rx).state, "finished");
        gone_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(rx.try_recv().is_err(), "a refusal is not retried");
    }

    #[test]
    fn a_progress_notice_is_tried_once_and_a_dropped_run_just_stops() {
        let sent = Arc::new(AtomicUsize::new(0));
        let counted = sent.clone();
        let send: Sender = Arc::new(move |_: &NotifyRequest, _: &Notice| {
            counted.fetch_add(1, Ordering::SeqCst);
            Answer::Again
        });
        let (gone_tx, gone_rx) = mpsc::channel();
        let notifier = Notifier::start_with(
            target("https://app.example.com/x"),
            "abc".into(),
            send,
            move || gone_tx.send(()).unwrap(),
            Duration::ZERO,
            Duration::from_secs(30),
        );
        notifier.watcher().changed();
        // The run's thread goes without saying how the run ended.
        std::thread::sleep(Duration::from_millis(200));
        drop(notifier);
        gone_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the thread ends with its handle");
        assert_eq!(sent.load(Ordering::SeqCst), 1);
    }
}
