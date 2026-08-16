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
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use smithay::reexports::calloop::generic::Generic;
use smithay::reexports::calloop::{EventLoop, Interest, Mode, PostAction};
use smithay::reexports::wayland_server::Display;
use smithay::utils::SERIAL_COUNTER;
use smithay::wayland::socket::ListeningSocketSource;

use iw_proto::{ButtonState, InputEvent};

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

        Ok(Self {
            event_loop,
            data: LoopData { state, display },
            socket_name,
            runtime_dir,
            nursery: Nursery::default(),
            local_events: VecDeque::new(),
        })
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

    /// Everything the compositor noticed since the last call.
    pub fn poll_events(&mut self) -> Vec<BackendEvent> {
        let mut events: Vec<BackendEvent> = self.local_events.drain(..).collect();
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
        // The scale is rounded up rather than to nearest: a 1.5× display asks
        // for 2×, and the browser downsamples the extra pixels. Fractional
        // scaling would save the difference in bandwidth but not add any
        // detail, and it needs two more protocols on both ends.
        let buffer_scale = if scale.is_finite() && scale > 1.0 {
            (scale.ceil() as i32).min(MAX_SCALE)
        } else {
            1
        };
        self.data.state.set_scale(buffer_scale);
        let buffer_scale = self.data.state.scale();

        let rec = self
            .data
            .state
            .windows
            .get(&window_id)
            .ok_or(BackendError::UnknownWindow(window_id))?;
        rec.toplevel.with_pending_state(|state| {
            state.size = Some(
                (
                    (width.max(1).div_ceil(buffer_scale as u32)) as i32,
                    (height.max(1).div_ceil(buffer_scale as u32)) as i32,
                )
                    .into(),
            );
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
        // window per tab, the tab the user is looking at is the focus.
        if let Some(keyboard) = &keyboard
            && keyboard.current_focus().as_ref() != Some(&surface)
        {
            let serial = SERIAL_COUNTER.next_serial();
            keyboard.set_focus(&mut self.data.state, Some(surface.clone()), serial);
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
                InputEvent::KeySym { .. } => {
                    // Reaching a keysym the layout cannot produce needs a
                    // temporary keymap swap; until that exists, dropping it is
                    // better than pressing the wrong key.
                }
                InputEvent::PointerMotion { time_ms, x, y } => {
                    let Some(pointer) = &pointer else { continue };
                    let location = (fixed_to_f64(x) / scale, fixed_to_f64(y) / scale).into();
                    pointer.motion(
                        &mut self.data.state,
                        Some((surface.clone(), (0.0, 0.0).into())),
                        &smithay::input::pointer::MotionEvent {
                            location,
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
                            .value(smithay::backend::input::Axis::Horizontal, fixed_to_f64(dx));
                    }
                    if dy != 0 {
                        frame =
                            frame.value(smithay::backend::input::Axis::Vertical, fixed_to_f64(dy));
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
        // actually ship rather than to how fast it can render.
        send_frame_callbacks(&surface, now);

        let rec = self.data.state.windows.get_mut(&window_id)?;
        Some(BackendFrame {
            width,
            height,
            stride: width * 4,
            pixels: &rec.pixels,
            damage: std::mem::take(&mut rec.damage),
        })
    }

    fn offer_clipboard(&mut self, mime_type: &str, data: &[u8]) -> Result<(), BackendError> {
        self.data.state.client_clipboard = Some((mime_type.to_owned(), data.to_vec()));
        Ok(())
    }

    fn request_clipboard(&mut self, _mime_type: &str) -> Result<(), BackendError> {
        // Reading the apps' selection means a pipe and a round trip through the
        // event loop; the plumbing lands with the clipboard work.
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

/// Wayland's 24.8 fixed point back to the f64 the input API takes.
fn fixed_to_f64(value: i32) -> f64 {
    value as f64 / 256.0
}

fn tracing_warn(message: &str) {
    eprintln!("iwappd: {message}");
}
