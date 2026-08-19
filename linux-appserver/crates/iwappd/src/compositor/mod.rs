//! The Linux compositor backend.
//!
//! Everything the [`crate::backend::Backend`] trait promises, implemented
//! against Smithay: a Wayland socket in `XDG_RUNTIME_DIR`, applications
//! spawned into it, their windows tracked, their pixels copied out and their
//! input injected.
//!
//! The event loop is calloop, which Smithay re-exports, so no dependency is
//! added beyond the one. [`WaylandBackend::dispatch`] is a single turn of that
//! loop: the caller drives it, which keeps this a passive backend rather than
//! a second thread with a channel between it and the session.

mod spawn;
mod state;

use std::collections::VecDeque;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use smithay::reexports::calloop::generic::Generic;
use smithay::reexports::calloop::ping::{Ping, make_ping};
use smithay::reexports::calloop::{EventLoop, Interest, Mode, PostAction};
use smithay::reexports::wayland_server::{Display, Resource};
use smithay::utils::SERIAL_COUNTER;
use smithay::wayland::selection::data_device::{
    request_data_device_client_selection, set_data_device_selection,
};
use smithay::wayland::socket::ListeningSocketSource;

use iw_proto::{ButtonState, InputEvent, v120_from_axis};

use crate::backend::{Backend, BackendError, BackendEvent, BackendFrame, LaunchSpec};
use crate::launch_env;
use spawn::Nursery;
use state::{AppState, ClientState, MAX_SCALE, send_frame_callbacks};

struct LoopData {
    state: AppState,
    display: Display<AppState>,
}

pub struct WaylandBackend {
    event_loop: EventLoop<'static, LoopData>,
    data: LoopData,
    socket_name: String,
    runtime_dir: PathBuf,
    nursery: Nursery,
    /// Events raised by us rather than by a protocol handler (launch failures,
    /// crashed children).
    local_events: VecDeque<BackendEvent>,
    /// Interrupts [`Self::dispatch`] from another thread. Held so the reader
    /// thread can be handed a clone.
    waker: Ping,
    /// Events raised off-thread — reading a client's clipboard, which is a
    /// pipe an application fills at its own pace.
    async_events: (
        std::sync::mpsc::Sender<BackendEvent>,
        std::sync::mpsc::Receiver<BackendEvent>,
    ),
}

impl WaylandBackend {
    /// Bind a socket and bring the compositor up. `session_id` namespaces the
    /// socket so two Infrawrench sessions on one host do not collide.
    pub fn new(session_id: &str, runtime_dir: PathBuf) -> Result<Self, BackendError> {
        let socket_name = launch_env::wayland_display_name(session_id);

        // Smithay binds the socket relative to XDG_RUNTIME_DIR, read from the
        // environment at bind time — so this process's own view of it has to
        // agree with the one we hand to applications.
        // SAFETY: single-threaded startup, before any thread is spawned.
        unsafe {
            std::env::set_var("XDG_RUNTIME_DIR", &runtime_dir);
        }

        let mut display: Display<AppState> =
            Display::new().map_err(|e| BackendError::Compositor(format!("display: {e}")))?;
        let dh = display.handle();
        let state = AppState::new(&dh);

        let event_loop: EventLoop<'static, LoopData> = EventLoop::try_new()
            .map_err(|e| BackendError::Compositor(format!("event loop: {e}")))?;
        let handle = event_loop.handle();

        let socket = ListeningSocketSource::with_name(&socket_name)
            .map_err(|e| BackendError::Compositor(format!("bind {socket_name}: {e}")))?;
        handle
            .insert_source(socket, |stream, _, data: &mut LoopData| {
                if let Err(err) = data
                    .display
                    .handle()
                    .insert_client(stream, Arc::new(ClientState::default()))
                {
                    tracing_warn(&format!("rejecting client: {err}"));
                }
            })
            .map_err(|e| BackendError::Compositor(format!("socket source: {e}")))?;

        let poll_fd = display
            .backend()
            .poll_fd()
            .try_clone_to_owned()
            .map_err(|e| BackendError::Compositor(format!("poll fd: {e}")))?;
        handle
            .insert_source(
                Generic::new(poll_fd, Interest::READ, Mode::Level),
                |_, _, data: &mut LoopData| {
                    data.display
                        .dispatch_clients(&mut data.state)
                        .map_err(|e| std::io::Error::other(e.to_string()))?;
                    Ok(PostAction::Continue)
                },
            )
            .map_err(|e| BackendError::Compositor(format!("display source: {e}")))?;

        // Client input arrives on another thread. Without something to
        // interrupt it, `dispatch` sits on its timeout with a keystroke already
        // in the channel — up to a whole turn of latency on every key and every
        // mouse move, for input the loop is holding but has not looked at.
        let (waker, wake_source) =
            make_ping().map_err(|e| BackendError::Compositor(format!("waker: {e}")))?;
        handle
            .insert_source(wake_source, |_, _, _| {})
            .map_err(|e| BackendError::Compositor(format!("waker source: {e}")))?;

        Ok(Self {
            event_loop,
            data: LoopData { state, display },
            socket_name,
            runtime_dir,
            nursery: Nursery::default(),
            local_events: VecDeque::new(),
            waker,
            async_events: std::sync::mpsc::channel(),
        })
    }

    /// A handle that interrupts [`Self::dispatch`] from another thread. The
    /// stdin reader pings it as soon as it has bytes, so client input is acted
    /// on when it arrives rather than when the turn happens to end.
    pub fn waker(&self) -> Ping {
        self.waker.clone()
    }

    pub fn socket_name(&self) -> &str {
        &self.socket_name
    }

    pub fn runtime_dir(&self) -> &PathBuf {
        &self.runtime_dir
    }

    /// One turn of the event loop: accept clients, dispatch their requests,
    /// reap dead children, flush replies.
    pub fn dispatch(&mut self, timeout: Duration) -> Result<(), BackendError> {
        self.event_loop
            .dispatch(Some(timeout), &mut self.data)
            .map_err(|e| BackendError::Compositor(format!("dispatch: {e}")))?;

        for (app_id, message) in self.nursery.reap() {
            self.local_events
                .push_back(BackendEvent::LaunchFailed { app_id, message });
        }

        self.data
            .display
            .flush_clients()
            .map_err(|e| BackendError::Compositor(format!("flush: {e}")))?;
        Ok(())
    }

    /// The keycode a keysym is bound to, binding it first if it is new.
    ///
    /// `None` when there is no keyboard, or when the keymap the binding needs
    /// would not compile — in which case the old keymap stays and the
    /// character is dropped, which is what this did for every keysym before.
    fn bind_keysym(&mut self, keysym: u32) -> Option<u32> {
        if self.data.state.base_keymap.is_none() {
            let keyboard = self.data.state.seat.get_keyboard()?;
            let text = keyboard.with_xkb_state(&mut self.data.state, |context| {
                let xkb = context.xkb().lock().ok()?;
                // SAFETY: the keymap is only read, into an owned String; no
                // reference to it outlives this borrow.
                Some(
                    unsafe { xkb.keymap() }
                        .get_as_string(smithay::input::keyboard::xkb::KEYMAP_FORMAT_TEXT_V1),
                )
            })?;
            self.data.state.base_keymap = Some(text);
        }
        let base = self.data.state.base_keymap.clone()?;
        let (keycode, changed) = self.data.state.spare_keys.bind(keysym);
        if !changed {
            return Some(keycode);
        }

        let named: Vec<(u32, String)> = self
            .data
            .state
            .spare_keys
            .bindings()
            .map(|(code, sym)| {
                (
                    code,
                    smithay::input::keyboard::xkb::keysym_get_name(
                        smithay::input::keyboard::Keysym::new(sym),
                    ),
                )
            })
            .collect();
        let text = crate::keymap::inject(&base, &named)?;

        let keyboard = self.data.state.seat.get_keyboard()?;
        match keyboard.set_keymap_from_string(&mut self.data.state, text) {
            Ok(()) => Some(keycode),
            Err(err) => {
                tracing_warn(&format!("could not bind keysym {keysym:#x}: {err:?}"));
                None
            }
        }
    }

    /// Everything the compositor noticed since the last call.
    pub fn poll_events(&mut self) -> Vec<BackendEvent> {
        let mut events: Vec<BackendEvent> = self.local_events.drain(..).collect();
        events.extend(self.async_events.1.try_iter());
        events.extend(self.data.state.events.drain(..));
        events
    }

    /// Kill anything we spawned. Called on the way out of the serve loop so a
    /// dropped SSH connection does not leave orphaned applications behind.
    pub fn shutdown_processes(&mut self) {
        self.nursery.terminate_all();
    }

    /// Whether any application is still running. The daemon uses this for its
    /// idle timeout: no windows and no children means nothing to serve.
    pub fn is_idle(&mut self) -> bool {
        self.data.state.windows.is_empty() && !self.nursery.any_alive()
    }
}

impl Backend for WaylandBackend {
    fn launch(&mut self, spec: LaunchSpec) -> Result<(), BackendError> {
        let mut env = spec.env.clone();
        // Whatever the caller assembled, the socket is ours to name — a stale
        // WAYLAND_DISPLAY here sends the app to another compositor entirely.
        env.insert("WAYLAND_DISPLAY".into(), self.socket_name.clone());
        env.insert(
            "XDG_RUNTIME_DIR".into(),
            self.runtime_dir.to_string_lossy().into_owned(),
        );
        self.nursery.spawn(&spec, &env)
    }

    fn configure(
        &mut self,
        window_id: u32,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<(), BackendError> {
        // The client asks in the pixels it will actually paint — its CSS box
        // times its device pixel ratio. Wayland configures a toplevel in
        // *logical* pixels and the application multiplies by the output scale
        // to get its buffer, so the conversion happens here, once.
        //
        // The output scale is the ratio rounded up rather than to nearest: a
        // 1.5× display asks for 2×, and the browser downsamples the extra
        // pixels. Fractional scaling would save the difference in bandwidth
        // but not add any detail, and it needs two more protocols on both
        // ends. The toplevel's size divides by the *fractional* ratio though —
        // that recovers the CSS box the viewer measured. At a fractional ratio
        // the application's buffer (logical × the whole scale) is therefore
        // larger than the request, which is exactly what the viewer expects to
        // downsample; dividing the size by the whole scale instead configured
        // a window smaller than its box, and every frame was stretched back up
        // — an application drawn too large everywhere.
        let buffer_scale = if scale.is_finite() && scale > 1.0 {
            (scale.ceil() as i32).min(MAX_SCALE)
        } else {
            1
        };
        self.data.state.set_scale(buffer_scale);

        let logical = crate::paint::logical_size(width, height, scale);
        // Before the window is asked to take this size, make sure the desktop
        // is big enough to hold it — a toolkit clamps a window to the output
        // it can see, and a viewer tab is under no obligation to fit ours.
        self.data.state.ensure_desktop_fits(logical);

        let rec = self
            .data
            .state
            .windows
            .get(&window_id)
            .ok_or(BackendError::UnknownWindow(window_id))?;
        rec.toplevel.with_pending_state(|state| {
            state.size = Some(logical.into());
        });
        rec.toplevel.send_configure();
        Ok(())
    }

    fn send_input(&mut self, window_id: u32, events: &[InputEvent]) -> Result<(), BackendError> {
        let surface = self
            .data
            .state
            .windows
            .get(&window_id)
            .ok_or(BackendError::UnknownWindow(window_id))?
            .surface
            .clone();

        let keyboard = self.data.state.seat.get_keyboard();
        let pointer = self.data.state.seat.get_pointer();

        // The protocol carries pointer positions in *buffer* pixels — the same
        // pixels the client is looking at, which is the only coordinate system
        // it has. Wayland delivers them surface-local and **logical**, so on a
        // HiDPI window every position has to come back down by the scale the
        // application actually rendered at. Skipping this puts the pointer at
        // twice its offset, which past the halfway point of the window is
        // outside it entirely.
        let scale = f64::from(state::surface_scale(&surface).max(1));

        // Keyboard focus follows whichever window is being typed into: with one
        // window per tab, the tab the user is looking at is the focus — unless
        // a popup holds a grab, in which case the menu owns the keys (its
        // arrows, its Escape) until it is dismissed.
        let keyboard_focus = self
            .data
            .state
            .keyboard_target(window_id)
            .unwrap_or_else(|| surface.clone());
        if let Some(keyboard) = &keyboard
            && keyboard.current_focus().as_ref() != Some(&keyboard_focus)
        {
            let serial = SERIAL_COUNTER.next_serial();
            keyboard.set_focus(&mut self.data.state, Some(keyboard_focus), serial);
        }

        for event in events {
            match *event {
                InputEvent::Key {
                    time_ms,
                    keycode,
                    state,
                } => {
                    let Some(keyboard) = &keyboard else { continue };
                    keyboard.input::<(), _>(
                        &mut self.data.state,
                        // The protocol carries evdev keycodes; xkb numbers the
                        // same keys eight higher, and Smithay subtracts the
                        // eight again on its way back out to the client.
                        smithay::input::keyboard::Keycode::from(keycode + 8),
                        key_state(state),
                        SERIAL_COUNTER.next_serial(),
                        time_ms,
                        |_, _, _| smithay::input::keyboard::FilterResult::Forward,
                    );
                }
                InputEvent::KeySym {
                    time_ms,
                    keysym,
                    state,
                } => {
                    let Some(keyboard) = &keyboard else { continue };
                    let Some(keycode) = self.bind_keysym(keysym) else {
                        continue;
                    };
                    keyboard.input::<(), _>(
                        &mut self.data.state,
                        smithay::input::keyboard::Keycode::from(keycode + 8),
                        key_state(state),
                        SERIAL_COUNTER.next_serial(),
                        time_ms,
                        |_, _, _| smithay::input::keyboard::FilterResult::Forward,
                    );
                }
                InputEvent::PointerMotion { time_ms, x, y } => {
                    let Some(pointer) = &pointer else { continue };
                    let at = (fixed_to_f64(x) / scale, fixed_to_f64(y) / scale);
                    // The event lands on whatever is under the point — the
                    // topmost popup, or the toplevel. The second element of
                    // the target is that surface's own origin in the same
                    // coordinates; Smithay subtracts it to make the position
                    // surface-local, which is how a click inside a menu hits
                    // the item under the cursor rather than one further down.
                    let (target, origin) = self
                        .data
                        .state
                        .pointer_target(window_id, at)
                        .unwrap_or_else(|| (surface.clone(), (0.0, 0.0)));
                    pointer.motion(
                        &mut self.data.state,
                        Some((target, origin.into())),
                        &smithay::input::pointer::MotionEvent {
                            location: at.into(),
                            serial: SERIAL_COUNTER.next_serial(),
                            time: time_ms,
                        },
                    );
                    pointer.frame(&mut self.data.state);
                }
                InputEvent::PointerButton {
                    time_ms,
                    button,
                    state,
                } => {
                    let Some(pointer) = &pointer else { continue };
                    if state == ButtonState::Pressed {
                        // A grabbed popup is dismissed by a press outside it,
                        // before the press is delivered — the same order every
                        // desktop compositor uses.
                        let at = pointer.current_location();
                        self.data
                            .state
                            .dismiss_popups_outside(window_id, (at.x, at.y));
                    }
                    pointer.button(
                        &mut self.data.state,
                        &smithay::input::pointer::ButtonEvent {
                            button: button.0,
                            state: button_state(state),
                            serial: SERIAL_COUNTER.next_serial(),
                            time: time_ms,
                        },
                    );
                    pointer.frame(&mut self.data.state);
                }
                InputEvent::PointerAxis { time_ms, dx, dy } => {
                    let Some(pointer) = &pointer else { continue };
                    let mut frame = smithay::input::pointer::AxisFrame::new(time_ms)
                        .source(smithay::backend::input::AxisSource::Wheel);
                    if dx != 0 {
                        frame = frame
                            .value(smithay::backend::input::Axis::Horizontal, fixed_to_f64(dx))
                            .v120(
                                smithay::backend::input::Axis::Horizontal,
                                v120_from_axis(dx),
                            );
                    }
                    if dy != 0 {
                        frame = frame
                            .value(smithay::backend::input::Axis::Vertical, fixed_to_f64(dy))
                            .v120(smithay::backend::input::Axis::Vertical, v120_from_axis(dy));
                    }
                    pointer.axis(&mut self.data.state, frame);
                    pointer.frame(&mut self.data.state);
                }
                InputEvent::PointerLeave { time_ms } => {
                    let Some(pointer) = &pointer else { continue };
                    pointer.motion(
                        &mut self.data.state,
                        None,
                        &smithay::input::pointer::MotionEvent {
                            location: (0.0, 0.0).into(),
                            serial: SERIAL_COUNTER.next_serial(),
                            time: time_ms,
                        },
                    );
                    pointer.frame(&mut self.data.state);
                }
                // Touch is accepted by the protocol but not yet injected; a
                // dropped touch is better than a synthetic click somewhere the
                // user did not press.
                InputEvent::TouchDown { .. }
                | InputEvent::TouchMotion { .. }
                | InputEvent::TouchUp { .. } => {}
            }
        }
        Ok(())
    }

    fn close_window(&mut self, window_id: u32) -> Result<(), BackendError> {
        let rec = self
            .data
            .state
            .windows
            .get(&window_id)
            .ok_or(BackendError::UnknownWindow(window_id))?;
        rec.toplevel.send_close();
        Ok(())
    }

    fn take_frame(&mut self, window_id: u32) -> Option<BackendFrame<'_>> {
        let now = self.data.state.now_ms();
        let (surface, width, height) = {
            let rec = self.data.state.windows.get(&window_id)?;
            if !rec.mapped || rec.pixels.is_empty() {
                return None;
            }
            (rec.surface.clone(), rec.width, rec.height)
        };

        // Release the client to draw the next frame only now, as we consume
        // this one. That is what paces an application to the rate we can
        // actually ship rather than to how fast it can render. Popups draw
        // into this same frame, so they are paced with it — a menu whose
        // callbacks never fired would open once and never animate again.
        send_frame_callbacks(&surface, now);
        for popup in self.data.state.popup_surfaces(window_id) {
            send_frame_callbacks(&popup, now);
        }

        let rec = self.data.state.windows.get_mut(&window_id)?;
        Some(BackendFrame {
            width,
            height,
            stride: width * 4,
            pixels: &rec.pixels,
            damage: std::mem::take(&mut rec.damage),
        })
    }

    fn window_pid(&mut self, window_id: u32) -> Option<u32> {
        let rec = self.data.state.windows.get(&window_id)?;
        let client = rec.surface.client()?;
        let credentials = client.get_credentials(&self.data.state.dh).ok()?;
        u32::try_from(credentials.pid).ok()
    }

    fn offer_clipboard(&mut self, mime_type: &str, data: &[u8]) -> Result<(), BackendError> {
        self.data.state.client_clipboard = Some((mime_type.to_owned(), data.to_vec()));
        // Publishing it is what makes it pasteable: until the seat holds a
        // selection, an application asking for the clipboard is told there is
        // nothing there. The contents are not sent now — `send_selection`
        // hands them over when something actually reads.
        let dh = self.data.state.dh.clone();
        let seat = self.data.state.seat.clone();
        set_data_device_selection(&dh, &seat, vec![mime_type.to_owned()], ());
        Ok(())
    }

    /// Ask whichever application owns the selection to write it into a pipe.
    ///
    /// The read happens on a thread and the result comes back as an event: the
    /// application on the other end may take its time, and this is called from
    /// the middle of the compositor's own loop.
    fn request_clipboard(&mut self, mime_type: &str) -> Result<(), BackendError> {
        let (reader, writer) =
            make_pipe().map_err(|e| BackendError::Compositor(format!("pipe: {e}")))?;
        let seat = self.data.state.seat.clone();
        request_data_device_client_selection(&seat, mime_type.to_owned(), writer)
            .map_err(|e| BackendError::Compositor(format!("selection: {e}")))?;

        let sender = self.async_events.0.clone();
        let waker = self.waker.clone();
        let mime_type = mime_type.to_owned();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut data = Vec::new();
            let mut reader = std::fs::File::from(reader);
            // A selection nobody writes ends at EOF with nothing in it, which
            // is reported as an empty clipboard rather than as a failure.
            let _ = reader.read_to_end(&mut data);
            let _ = sender.send(BackendEvent::ClipboardData { mime_type, data });
            // The loop is asleep on its timeout; without this the clipboard
            // arrives whenever the next frame happens to.
            waker.ping();
        });
        Ok(())
    }

    fn shutdown(&mut self) {
        for window_id in self.data.state.windows.keys().copied().collect::<Vec<_>>() {
            if let Some(rec) = self.data.state.windows.get(&window_id) {
                rec.toplevel.send_close();
            }
        }
        self.nursery.terminate_all();
    }
}

fn key_state(state: ButtonState) -> smithay::backend::input::KeyState {
    match state {
        ButtonState::Pressed => smithay::backend::input::KeyState::Pressed,
        ButtonState::Released => smithay::backend::input::KeyState::Released,
    }
}

fn button_state(state: ButtonState) -> smithay::backend::input::ButtonState {
    match state {
        ButtonState::Pressed => smithay::backend::input::ButtonState::Pressed,
        ButtonState::Released => smithay::backend::input::ButtonState::Released,
    }
}

/// A pipe, as `(read, write)`.
///
/// `std::io::pipe` would do this, and is two Rust releases newer than the one
/// this workspace is pinned to — the binary runs on other people's machines,
/// so the toolchain floor is a deliberate choice rather than an oversight.
fn make_pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    use std::os::fd::FromRawFd;
    let mut fds = [0i32; 2];
    // SAFETY: `pipe` writes exactly two descriptors into the array we own, and
    // reports failure through its return value rather than by writing garbage.
    if unsafe { libc_pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: both descriptors are freshly created and owned by nobody else.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

unsafe extern "C" {
    #[link_name = "pipe"]
    fn libc_pipe(fds: *mut i32) -> i32;
}

/// Wayland's 24.8 fixed point back to the f64 the input API takes.
fn fixed_to_f64(value: i32) -> f64 {
    value as f64 / 256.0
}

fn tracing_warn(message: &str) {
    eprintln!("iwappd: {message}");
}
