//! Stopping a job from outside: the run it belongs to was cancelled.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How often a job that can be cancelled checks whether it has been. A
/// cancelled job is then stopped the way a timeout stops one.
pub(crate) const CANCEL_POLL: Duration = Duration::from_millis(200);

type Waker = Box<dyn Fn() + Send + Sync>;

/// A flag shared by everything one cancellation stops. Cloning shares it.
/// Setting it is final; whoever registered with [`Cancel::on_cancel`] is
/// called once, so a waiting scheduler wakes at once rather than at its
/// next poll.
#[derive(Clone, Default)]
pub struct Cancel(Arc<Inner>);

#[derive(Default)]
struct Inner {
    set: AtomicBool,
    wakers: Mutex<Vec<Waker>>,
}

impl std::fmt::Debug for Cancel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Cancel").field(&self.is_cancelled()).finish()
    }
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the flag and calls every waker; true when this call set it.
    pub fn cancel(&self) -> bool {
        if self.0.set.swap(true, Ordering::SeqCst) {
            return false;
        }
        let wakers = std::mem::take(&mut *self.0.wakers.lock().unwrap_or_else(|e| e.into_inner()));
        for wake in wakers {
            wake();
        }
        true
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.set.load(Ordering::SeqCst)
    }

    /// Calls `wake` when the flag is set, or now if it already is.
    pub fn on_cancel(&self, wake: impl Fn() + Send + Sync + 'static) {
        let mut wakers = self.0.wakers.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_cancelled() {
            drop(wakers);
            wake();
        } else {
            wakers.push(Box::new(wake));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn wakers_run_once_and_late_ones_at_once() {
        let cancel = Cancel::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        cancel.on_cancel(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        assert!(!cancel.is_cancelled());
        assert!(cancel.cancel());
        assert!(!cancel.clone().cancel(), "a second cancel changes nothing");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let c = calls.clone();
        cancel.on_cancel(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
