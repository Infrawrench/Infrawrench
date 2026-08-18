//! The seam between the protocol and the compositor.
//!
//! Everything above this trait — the session state machine, flow control, the
//! launcher — is ordinary Rust that builds and tests on any platform. Below it
//! is Smithay, `wl_shm` buffers and process spawning, which only exist on
//! Linux. Keeping the seam narrow is what lets the interesting logic be tested
//! on a laptop instead of only in CI.

use std::collections::BTreeMap;

use iw_codec::Rect;
use iw_proto::InputEvent;

/// A window's pixels as the compositor sees them.
pub struct BackendFrame<'a> {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pixels: &'a [u8],
    /// Damage the client reported for this commit. Empty means "everything",
    /// which is what a client that never calls `wl_surface.damage` implies.
    pub damage: Vec<Rect>,
}

/// Something the compositor noticed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendEvent {
    WindowOpened {
        window_id: u32,
        /// `xdg_toplevel.set_app_id`, when the client bothered to set one.
        app_id: Option<String>,
        title: String,
        width: u32,
        height: u32,
        /// Set for a dialog that belongs to another window. The client
        /// composites those into the parent's tab rather than opening a tab.
        parent_window_id: Option<u32>,
    },
    WindowMeta {
        window_id: u32,
        title: Option<String>,
        app_id: Option<String>,
    },
    /// New pixels are available; the session pulls them with
    /// [`Backend::take_frame`] when flow control allows.
    WindowDamaged {
        window_id: u32,
        damage: Vec<Rect>,
    },
    WindowClosed {
        window_id: u32,
        crashed: bool,
    },
    CursorChanged {
        window_id: u32,
        shape: Option<String>,
    },
    /// An app put something on the clipboard. The data itself follows only if
    /// the client asks for it — a copied 40 MB image should not cross the link
    /// because someone pressed Ctrl-C on the far side.
    ClipboardOffer {
        mime_types: Vec<String>,
    },
    /// The data for an earlier [`Backend::request_clipboard`]. Separate from
    /// the request because Wayland hands clipboard data over a pipe, so it
    /// arrives some time after it is asked for.
    ClipboardData {
        mime_type: String,
        data: Vec<u8>,
    },
    /// A launch we started has failed. `message` carries the child's stderr,
    /// because on a bare host it is almost always a missing library and the
    /// real linker error is worth ten "failed to start" dialogs.
    LaunchFailed {
        app_id: Option<String>,
        message: String,
    },
}

/// What to spawn, fully resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub app_id: Option<String>,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("no window {0}")]
    UnknownWindow(u32),
    #[error("{0}")]
    Launch(String),
    #[error("{0}")]
    Compositor(String),
}

pub trait Backend {
    /// Spawn an application into this session's Wayland display.
    fn launch(&mut self, spec: LaunchSpec) -> Result<(), BackendError>;

    /// Tell a window what size to be. Called on attach and on tab resize.
    fn configure(
        &mut self,
        window_id: u32,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<(), BackendError>;

    /// Deliver input to the focused surface of a window.
    fn send_input(&mut self, window_id: u32, events: &[InputEvent]) -> Result<(), BackendError>;

    /// Ask a window to close (`xdg_toplevel.close`).
    fn close_window(&mut self, window_id: u32) -> Result<(), BackendError>;

    /// Borrow a window's current pixels. `None` when nothing has been
    /// committed yet — a window can exist for several frames before its
    /// client draws anything.
    fn take_frame(&mut self, window_id: u32) -> Option<BackendFrame<'_>>;

    /// The process behind a window's Wayland connection, when the platform
    /// can tell. How a window is matched to its AT-SPI application.
    fn window_pid(&mut self, _window_id: u32) -> Option<u32> {
        None
    }

    /// Hand the client's clipboard to whatever app asks for it next.
    fn offer_clipboard(&mut self, mime_type: &str, data: &[u8]) -> Result<(), BackendError>;

    /// Start reading the apps' clipboard selection. The data arrives later as
    /// [`BackendEvent::ClipboardData`].
    fn request_clipboard(&mut self, mime_type: &str) -> Result<(), BackendError>;

    /// Close every window and stop.
    fn shutdown(&mut self);
}
