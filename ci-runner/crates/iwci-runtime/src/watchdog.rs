//! A timer thread that stops a guest running on another thread.

use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How often the kill is repeated once the deadline has passed. An
/// interrupt can be missed (it is a signal to a thread that may just be
/// leaving or entering wasm), so it is sent until the guest stops.
const REPEAT: Duration = Duration::from_millis(20);

#[derive(Default)]
struct State {
    done: bool,
    fired: bool,
    /// It fired because the run was cancelled, not at the deadline.
    cancelled: bool,
}

pub(crate) struct Watchdog {
    shared: Arc<(Mutex<State>, Condvar)>,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    /// Calls `kill` at `deadline`, and every few milliseconds after it,
    /// until [`Watchdog::finish`].
    /// Also calls it, and goes on calling it, once `cancel` is set.
    pub(crate) fn start(
        deadline: Instant,
        cancel: Option<crate::Cancel>,
        kill: impl Fn() + Send + 'static,
    ) -> Self {
        let shared: Arc<(Mutex<State>, Condvar)> = Arc::default();
        let thread = {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("iwci-watchdog".into())
                .spawn(move || {
                    let (lock, wake) = &*shared;
                    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
                    loop {
                        if state.done {
                            return;
                        }
                        let now = Instant::now();
                        let cancelled = cancel.as_ref().is_some_and(|c| c.is_cancelled());
                        if now >= deadline || cancelled {
                            state.fired = true;
                            state.cancelled |= cancelled && now < deadline;
                            drop(state);
                            kill();
                            state = lock.lock().unwrap_or_else(|e| e.into_inner());
                            if state.done {
                                return;
                            }
                            state = wake
                                .wait_timeout(state, REPEAT)
                                .unwrap_or_else(|e| e.into_inner())
                                .0;
                        } else {
                            let wait = match &cancel {
                                Some(_) => (deadline - now).min(crate::cancel::CANCEL_POLL),
                                None => deadline - now,
                            };
                            state = wake
                                .wait_timeout(state, wait)
                                .unwrap_or_else(|e| e.into_inner())
                                .0;
                        }
                    }
                })
                .ok()
        };
        Self { shared, thread }
    }

    /// Stops the timer and returns whether it fired, and whether that was
    /// for a cancellation.
    pub(crate) fn finish(mut self) -> (bool, bool) {
        self.stop()
    }

    fn stop(&mut self) -> (bool, bool) {
        let fired = {
            let (lock, wake) = &*self.shared;
            let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
            state.done = true;
            wake.notify_all();
            (state.fired, state.cancelled)
        };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        fired
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.stop();
    }
}
