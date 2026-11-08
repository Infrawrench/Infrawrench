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
}

pub(crate) struct Watchdog {
    shared: Arc<(Mutex<State>, Condvar)>,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    /// Calls `kill` at `deadline`, and every few milliseconds after it,
    /// until [`Watchdog::finish`].
    pub(crate) fn start(deadline: Instant, kill: impl Fn() + Send + 'static) -> Self {
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
                        if now >= deadline {
                            state.fired = true;
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
                            state = wake
                                .wait_timeout(state, deadline - now)
                                .unwrap_or_else(|e| e.into_inner())
                                .0;
                        }
                    }
                })
                .ok()
        };
        Self { shared, thread }
    }

    /// Stops the timer and returns whether it fired.
    pub(crate) fn finish(mut self) -> bool {
        self.stop()
    }

    fn stop(&mut self) -> bool {
        let fired = {
            let (lock, wake) = &*self.shared;
            let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
            state.done = true;
            wake.notify_all();
            state.fired
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
