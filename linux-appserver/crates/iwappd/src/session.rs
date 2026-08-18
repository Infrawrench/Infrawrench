//! The protocol state machine.
//!
//! Deliberately synchronous and side-effect-free at the edges: frames and
//! backend events go in, wire frames come out of an outbox. No sockets, no
//! threads, no clock. That is what makes flow control — the part most likely
//! to be subtly wrong — testable without a compositor.

use std::collections::BTreeMap;
use std::collections::HashMap;

use iw_codec::{EncodeMode, Encoder, EncoderConfig, Rect, Tier, TierSelector};
use iw_proto::{
    AudioChunk, ClientCaps, ClientMessage, ClipboardBlob, ErrorCode, Frame, FrameKind,
    PROTOCOL_VERSION, PixelFormat, SESSION_WINDOW, ServerCaps, ServerMessage, WindowCloseReason,
    decode_input_batch, encode_frame,
};

use crate::backend::{Backend, BackendEvent, LaunchSpec};
use crate::catalog::Catalog;

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub session_id: String,
    pub version: String,
    pub caps: ServerCaps,
    pub pixel_format: PixelFormat,
    /// The XKB keymap clients' key events are resolved against.
    pub keymap: String,
    /// Environment launched apps inherit, from [`crate::launch_env`].
    pub launch_env: BTreeMap<String, String>,
    /// Prepended to every application's command line.
    ///
    /// `dbus-run-session --`, on a host with no session bus of its own. It is
    /// a prefix rather than an environment variable because that is the only
    /// way to give an application a bus that did not exist before it started —
    /// and GTK4 does not start without one.
    pub launch_prefix: Vec<String>,
    /// Frames a window may have in flight before we stop encoding for it.
    pub max_in_flight: u32,
    pub encoder: EncoderConfig,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            session_id: "session".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            caps: ServerCaps {
                // Compiled in, so it holds for every build — the two call
                // sites that resolve the rest of the caps from the host say
                // the same thing.
                jpeg: true,
                ..ServerCaps::default()
            },
            pixel_format: PixelFormat::Bgra8888,
            keymap: String::new(),
            launch_env: BTreeMap::new(),
            launch_prefix: Vec::new(),
            // Two: one being decoded and one on the wire. Three adds latency
            // you can feel while dragging a window; one stalls on any link
            // with real round-trip time.
            max_in_flight: 2,
            encoder: EncoderConfig::default(),
        }
    }
}

/// `prefix` in front of `argv`, or `argv` alone when there is no prefix.
fn prefixed(prefix: &[String], argv: Vec<String>) -> Vec<String> {
    if prefix.is_empty() {
        return argv;
    }
    let mut out = Vec::with_capacity(prefix.len() + argv.len());
    out.extend_from_slice(prefix);
    out.extend(argv);
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    AwaitingHello,
    Running,
    Ended,
}

struct Window {
    attached: bool,
    width: u32,
    height: u32,
    /// Rectangles damaged since we last encoded. Grows while flow control
    /// holds us back, which is the whole point: a blocked window accumulates
    /// damage instead of queueing frames the client will never catch up with.
    pending_damage: Vec<Rect>,
    /// Damage was reported but no frame has been produced for it yet.
    dirty: bool,
    in_flight: u32,
    needs_keyframe: bool,
    encoder: Encoder,
    tier: TierSelector,
    parent: Option<u32>,
}

pub struct Session<B: Backend, C: Catalog> {
    backend: B,
    catalog: C,
    config: SessionConfig,
    phase: Phase,
    client_caps: ClientCaps,
    /// The client can turn the audio stream off (the viewer's mute) without
    /// tearing anything down; on by default for a client whose caps say audio.
    audio_enabled: bool,
    windows: HashMap<u32, Window>,
    outbox: Vec<Vec<u8>>,
}

impl<B: Backend, C: Catalog> Session<B, C> {
    pub fn new(backend: B, catalog: C, config: SessionConfig) -> Self {
        Self {
            backend,
            catalog,
            config,
            phase: Phase::AwaitingHello,
            client_caps: ClientCaps::default(),
            audio_enabled: true,
            windows: HashMap::new(),
            outbox: Vec::new(),
        }
    }

    /// Whether mixed audio should be produced at all right now.
    pub fn wants_audio(&self) -> bool {
        self.phase == Phase::Running && self.client_caps.audio && self.audio_enabled
    }

    /// Forward one mixed chunk to the client. Gated on the client having
    /// declared the capability — an unknown frame kind is a protocol error on
    /// the other end, not a skipped frame — and on the viewer's mute.
    pub fn on_audio_chunk(&mut self, chunk: &AudioChunk) {
        if !self.wants_audio() {
            return;
        }
        self.outbox.push(encode_frame(
            FrameKind::Audio,
            SESSION_WINDOW,
            &chunk.encode(),
        ));
    }

    pub fn is_ended(&self) -> bool {
        self.phase == Phase::Ended
    }

    /// Wire frames ready to write to the transport.
    pub fn drain(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.outbox)
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    fn send(&mut self, message: &ServerMessage) {
        self.outbox.push(encode_frame(
            FrameKind::ControlServer,
            SESSION_WINDOW,
            &message.to_json(),
        ));
    }

    fn send_error(&mut self, code: ErrorCode, message: impl Into<String>, window_id: Option<u32>) {
        let message = ServerMessage::Error {
            code,
            message: message.into(),
            window_id,
        };
        self.send(&message);
    }

    /// Handle one frame from the client.
    pub fn on_client_frame(&mut self, frame: Frame) {
        if self.phase == Phase::Ended {
            return;
        }
        match frame.kind {
            FrameKind::ControlClient => match ClientMessage::from_json(&frame.payload) {
                Ok(message) => self.on_message(message),
                Err(err) => self.send_error(
                    ErrorCode::Internal,
                    format!("bad control frame: {err}"),
                    None,
                ),
            },
            FrameKind::Input => self.on_input(frame),
            FrameKind::ClipboardClient => match ClipboardBlob::decode(&frame.payload) {
                Ok(blob) => {
                    let _ = self.backend.offer_clipboard(&blob.mime_type, &blob.data);
                }
                Err(err) => self.send_error(
                    ErrorCode::Internal,
                    format!("bad clipboard frame: {err}"),
                    None,
                ),
            },
            // Server-bound kinds arriving from a client are a desynchronised
            // stream, not something to act on.
            FrameKind::ControlServer
            | FrameKind::Pixels
            | FrameKind::ClipboardServer
            | FrameKind::Audio => {
                self.send_error(ErrorCode::Internal, "unexpected server frame", None)
            }
        }
    }

    fn on_input(&mut self, frame: Frame) {
        if !self.windows.contains_key(&frame.window_id) {
            // Input racing a window close is normal — the user was still
            // typing when the app exited. Drop it quietly rather than
            // reporting an error the client can do nothing about.
            return;
        }
        match decode_input_batch(&frame.payload) {
            Ok(events) => {
                let _ = self.backend.send_input(frame.window_id, &events);
            }
            Err(err) => self.send_error(
                ErrorCode::Internal,
                format!("bad input batch: {err}"),
                Some(frame.window_id),
            ),
        }
    }

    fn on_message(&mut self, message: ClientMessage) {
        if self.phase == Phase::AwaitingHello {
            let ClientMessage::Hello { protocol, caps, .. } = message else {
                self.send_error(
                    ErrorCode::ProtocolMismatch,
                    "first message must be hello",
                    None,
                );
                self.end();
                return;
            };
            if protocol != PROTOCOL_VERSION {
                self.send_error(
                    ErrorCode::ProtocolMismatch,
                    format!(
                        "client speaks protocol {protocol}, this build speaks {PROTOCOL_VERSION}"
                    ),
                    None,
                );
                self.end();
                return;
            }
            self.client_caps = caps;
            self.config.encoder.allow_zstd = caps.zstd;
            // A client that cannot apply a difference would paint one as if it
            // were pixels, and one that cannot decode JPEG would paint nothing
            // at all. Both are the client's word, taken here once.
            self.config.encoder.allow_delta = caps.delta && caps.zstd;
            self.config.encoder.allow_jpeg = caps.jpeg && self.config.caps.jpeg;
            self.phase = Phase::Running;
            let welcome = ServerMessage::Welcome {
                protocol: PROTOCOL_VERSION,
                session_id: self.config.session_id.clone(),
                version: self.config.version.clone(),
                caps: self.config.caps,
                pixel_format: self.config.pixel_format,
                keymap: self.config.keymap.clone(),
            };
            self.send(&welcome);
            return;
        }

        match message {
            ClientMessage::Hello { .. } => {
                self.send_error(ErrorCode::ProtocolMismatch, "already greeted", None)
            }
            ClientMessage::ListApps { refresh } => {
                let apps = self.catalog.list(refresh);
                self.send(&ServerMessage::Apps {
                    apps,
                    complete: true,
                });
            }
            ClientMessage::Launch { app_id, exec, cwd } => self.on_launch(app_id, exec, cwd),
            ClientMessage::Attach {
                window_id,
                width,
                height,
                scale,
            } => {
                let Some(window) = self.windows.get_mut(&window_id) else {
                    self.send_error(ErrorCode::UnknownWindow, "no such window", Some(window_id));
                    return;
                };
                window.attached = true;
                window.width = width.max(1);
                window.height = height.max(1);
                // A client that just attached holds nothing, so the next frame
                // has to stand alone regardless of what we sent before.
                window.needs_keyframe = true;
                window.encoder.invalidate();
                window.dirty = true;
                window.pending_damage.clear();
                window.in_flight = 0;
                let _ = self.backend.configure(window_id, width, height, scale);
            }
            ClientMessage::Detach { window_id } => {
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.attached = false;
                    window.pending_damage.clear();
                    window.dirty = false;
                    window.in_flight = 0;
                }
            }
            ClientMessage::Resize {
                window_id,
                width,
                height,
                scale,
            } => {
                let Some(window) = self.windows.get_mut(&window_id) else {
                    self.send_error(ErrorCode::UnknownWindow, "no such window", Some(window_id));
                    return;
                };
                window.width = width.max(1);
                window.height = height.max(1);
                window.needs_keyframe = true;
                window.dirty = true;
                let _ = self.backend.configure(window_id, width, height, scale);
            }
            ClientMessage::CloseWindow { window_id } => {
                let _ = self.backend.close_window(window_id);
            }
            ClientMessage::Ack { window_id, .. } => {
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.in_flight = window.in_flight.saturating_sub(1);
                }
            }
            ClientMessage::ClipboardOffer { .. } => {
                // The offer itself is informational; the data arrives as a
                // ClipboardClient frame when the client sends it.
            }
            ClientMessage::ClipboardRequest { mime_type } => {
                let _ = self.backend.request_clipboard(&mime_type);
            }
            ClientMessage::SetAudio { enabled } => self.audio_enabled = enabled,
            ClientMessage::KillSession => self.end(),
            ClientMessage::Ping { nonce } => self.send(&ServerMessage::Pong { nonce }),
        }
    }

    fn on_launch(&mut self, app_id: Option<String>, exec: Option<String>, cwd: Option<String>) {
        let spec = match (&app_id, &exec) {
            (Some(id), _) => {
                let Some(resolved) = self.catalog.resolve(id) else {
                    self.send_error(
                        ErrorCode::UnknownApp,
                        format!("no desktop entry {id} on this host"),
                        None,
                    );
                    return;
                };
                if resolved.needs_terminal {
                    self.send(&ServerMessage::LaunchResult {
                        app_id: app_id.clone(),
                        ok: false,
                        message: Some(
                            "this entry needs a terminal emulator; open it from the SSH terminal instead"
                                .into(),
                        ),
                    });
                    return;
                }
                LaunchSpec {
                    app_id: Some(resolved.app_id),
                    argv: prefixed(&self.config.launch_prefix, resolved.argv),
                    env: self.config.launch_env.clone(),
                    cwd: cwd.or(resolved.cwd),
                }
            }
            (None, Some(command)) => {
                let argv = iw_apps::exec_argv(command, "", None);
                if argv.is_empty() {
                    self.send_error(ErrorCode::UnknownApp, "empty command", None);
                    return;
                }
                LaunchSpec {
                    app_id: None,
                    argv: prefixed(&self.config.launch_prefix, argv),
                    env: self.config.launch_env.clone(),
                    cwd,
                }
            }
            (None, None) => {
                self.send_error(ErrorCode::UnknownApp, "launch needs appId or exec", None);
                return;
            }
        };

        let reported_id = spec.app_id.clone();
        match self.backend.launch(spec) {
            Ok(()) => self.send(&ServerMessage::LaunchResult {
                app_id: reported_id,
                ok: true,
                message: None,
            }),
            Err(err) => self.send_error(ErrorCode::LaunchFailed, err.to_string(), None),
        }
    }

    /// Handle one event from the compositor.
    pub fn on_backend_event(&mut self, event: BackendEvent) {
        if self.phase == Phase::Ended {
            return;
        }
        match event {
            BackendEvent::WindowOpened {
                window_id,
                app_id,
                title,
                width,
                height,
                parent_window_id,
            } => {
                self.windows.insert(
                    window_id,
                    Window {
                        attached: false,
                        width,
                        height,
                        pending_damage: Vec::new(),
                        dirty: false,
                        in_flight: 0,
                        needs_keyframe: true,
                        encoder: Encoder::new(self.config.encoder),
                        tier: TierSelector::new(&self.client_caps, &self.config.caps),
                        parent: parent_window_id,
                    },
                );
                let icon = app_id
                    .as_deref()
                    .and_then(|id| self.catalog.icon_for_app_id(id));
                self.send(&ServerMessage::WindowOpen {
                    window_id,
                    app_id,
                    title,
                    icon,
                    width,
                    height,
                    parent_window_id,
                });
            }
            BackendEvent::WindowMeta {
                window_id,
                title,
                app_id,
            } => {
                if !self.windows.contains_key(&window_id) {
                    return;
                }
                let icon = app_id
                    .as_deref()
                    .and_then(|id| self.catalog.icon_for_app_id(id));
                self.send(&ServerMessage::WindowMeta {
                    window_id,
                    title,
                    app_id,
                    icon,
                });
            }
            BackendEvent::WindowDamaged { window_id, damage } => {
                if let Some(window) = self.windows.get_mut(&window_id) {
                    if damage.is_empty() {
                        // A client that commits without damaging is claiming
                        // the whole surface changed.
                        window.pending_damage.push(Rect::new(
                            0,
                            0,
                            u16::MAX as u32,
                            u16::MAX as u32,
                        ));
                    } else {
                        window.pending_damage.extend(damage);
                    }
                    window.dirty = true;
                }
            }
            BackendEvent::WindowClosed { window_id, crashed } => {
                if self.windows.remove(&window_id).is_none() {
                    return;
                }
                self.send(&ServerMessage::WindowClose {
                    window_id,
                    reason: if crashed {
                        WindowCloseReason::Crashed
                    } else {
                        WindowCloseReason::Closed
                    },
                });
            }
            BackendEvent::CursorChanged { window_id, shape } => {
                self.send(&ServerMessage::Cursor {
                    window_id,
                    shape,
                    image: None,
                });
            }
            BackendEvent::ClipboardOffer { mime_types } => {
                self.send(&ServerMessage::ClipboardOffer { mime_types });
            }
            BackendEvent::ClipboardData { mime_type, data } => {
                let blob = ClipboardBlob { mime_type, data };
                self.outbox.push(encode_frame(
                    FrameKind::ClipboardServer,
                    SESSION_WINDOW,
                    &blob.encode(),
                ));
            }
            BackendEvent::LaunchFailed { app_id, message } => {
                self.send(&ServerMessage::LaunchResult {
                    app_id,
                    ok: false,
                    message: Some(message),
                });
            }
        }
    }

    /// Encode and queue frames for every window that has damage and a free
    /// in-flight slot. Call after handling backend events.
    pub fn pump(&mut self) {
        if self.phase != Phase::Running {
            return;
        }
        let ids: Vec<u32> = self.windows.keys().copied().collect();
        for window_id in ids {
            let Some(window) = self.windows.get(&window_id) else {
                continue;
            };
            if !window.attached {
                continue;
            }
            // Backed up rather than quiet. A window that has run out of
            // in-flight slots is the most active one there is, and letting it
            // decay would take it off the lossy tier exactly when bandwidth is
            // tightest.
            if window.in_flight >= self.config.max_in_flight {
                continue;
            }
            if !window.dirty {
                self.observe_quiet(window_id);
                continue;
            }

            let Some(frame) = self.backend.take_frame(window_id) else {
                self.observe_quiet(window_id);
                continue;
            };
            let window = self.windows.get_mut(&window_id).expect("checked above");

            let mut damage = std::mem::take(&mut window.pending_damage);
            damage.extend(frame.damage.iter().copied());
            let view = iw_codec::FrameView {
                width: frame.width,
                height: frame.height,
                stride: frame.stride,
                pixels: frame.pixels,
            };
            // The tier the last frame's coverage argued for is the one this
            // frame is encoded in. Coming back from lossy asks for a keyframe:
            // everything on screen is a JPEG of itself and only a full
            // lossless frame makes the text sharp again.
            let mode = match window.tier.current() {
                Tier::Image => EncodeMode::Lossy,
                Tier::Lossless | Tier::Video => EncodeMode::Lossless,
            };
            if window.encoder.set_mode(mode) {
                window.needs_keyframe = true;
            }
            let encoded = window.encoder.encode(view, &damage, window.needs_keyframe);
            window.dirty = false;

            match encoded {
                Ok(Some(encoded)) => {
                    window.needs_keyframe = false;
                    window.in_flight += 1;
                    window
                        .tier
                        .observe(encoded.coverage, &self.client_caps, &self.config.caps);
                    self.outbox
                        .push(encode_frame(FrameKind::Pixels, window_id, &encoded.bytes));
                }
                // Nothing actually changed: the client's canvas is already
                // right, so there is no frame and no in-flight slot spent. It
                // still counts as a still frame, or a paused video would stay
                // on the lossy tier — blurred, and with nothing coming that
                // would ever sharpen it.
                Ok(None) => self.observe_quiet(window_id),
                Err(err) => {
                    let message = err.to_string();
                    self.send_error(ErrorCode::Internal, message, Some(window_id));
                }
            }
        }
    }

    /// Tell a window's tier selector that nothing changed this turn.
    ///
    /// Motion is measured per frame, so without this a window that simply stops
    /// producing frames keeps whatever motion it last had — and a video that
    /// was paused would sit on the lossy tier indefinitely, showing the user a
    /// JPEG of a still picture they are now reading.
    fn observe_quiet(&mut self, window_id: u32) {
        let caps = (self.client_caps, self.config.caps);
        if let Some(window) = self.windows.get_mut(&window_id) {
            window.tier.observe(0.0, &caps.0, &caps.1);
        }
    }

    /// Current encoding tier for a window, for telemetry and tests.
    pub fn tier(&self, window_id: u32) -> Option<Tier> {
        self.windows.get(&window_id).map(|w| w.tier.current())
    }

    /// What each attached window is currently costing, for the serve loop's
    /// periodic report: its tier, and where the lossy quality has settled.
    /// Empty when nothing is attached.
    pub fn window_load(&self) -> Vec<(u32, Tier, u8)> {
        let mut load: Vec<(u32, Tier, u8)> = self
            .windows
            .iter()
            .filter(|(_, w)| w.attached)
            .map(|(id, w)| (*id, w.tier.current(), w.encoder.quality()))
            .collect();
        load.sort_unstable_by_key(|(id, _, _)| *id);
        load
    }

    pub fn window_ids(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = self.windows.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// Windows that are dialogs of another window; the client draws these into
    /// the parent's tab rather than opening one of their own.
    pub fn parent_of(&self, window_id: u32) -> Option<u32> {
        self.windows.get(&window_id).and_then(|w| w.parent)
    }

    fn end(&mut self) {
        for window_id in self.window_ids() {
            self.send(&ServerMessage::WindowClose {
                window_id,
                reason: WindowCloseReason::SessionEnded,
            });
        }
        self.windows.clear();
        self.backend.shutdown();
        self.phase = Phase::Ended;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{MockBackend, MockCatalog};
    use iw_codec::{Codec, PixelPayload};
    use iw_proto::{FrameDecoder, InputEvent};

    fn hello(caps: ClientCaps) -> Frame {
        Frame {
            kind: FrameKind::ControlClient,
            window_id: SESSION_WINDOW,
            payload: ClientMessage::Hello {
                protocol: PROTOCOL_VERSION,
                caps,
                device_pixel_ratio: 1.0,
            }
            .to_json(),
        }
    }

    fn control(message: ClientMessage) -> Frame {
        Frame {
            kind: FrameKind::ControlClient,
            window_id: SESSION_WINDOW,
            payload: message.to_json(),
        }
    }

    fn session() -> Session<MockBackend, MockCatalog> {
        Session::new(
            MockBackend::default(),
            MockCatalog::with_apps(),
            SessionConfig::default(),
        )
    }

    /// Decode everything the session queued, so assertions talk in messages
    /// rather than bytes.
    fn drain_messages(session: &mut Session<MockBackend, MockCatalog>) -> Vec<ServerMessage> {
        let mut decoder = FrameDecoder::new();
        for bytes in session.drain() {
            decoder.push(&bytes);
        }
        let mut out = Vec::new();
        while let Some(frame) = decoder.next_frame().unwrap() {
            if frame.kind == FrameKind::ControlServer {
                out.push(ServerMessage::from_json(&frame.payload).unwrap());
            }
        }
        out
    }

    fn drain_pixels(session: &mut Session<MockBackend, MockCatalog>) -> Vec<(u32, PixelPayload)> {
        let mut decoder = FrameDecoder::new();
        for bytes in session.drain() {
            decoder.push(&bytes);
        }
        let mut out = Vec::new();
        while let Some(frame) = decoder.next_frame().unwrap() {
            if frame.kind == FrameKind::Pixels {
                out.push((
                    frame.window_id,
                    PixelPayload::decode(&frame.payload).unwrap(),
                ));
            }
        }
        out
    }

    fn open_window(session: &mut Session<MockBackend, MockCatalog>, id: u32) {
        session.on_backend_event(BackendEvent::WindowOpened {
            window_id: id,
            app_id: Some("editor".into()),
            title: "untitled".into(),
            width: 64,
            height: 64,
            parent_window_id: None,
        });
    }

    fn attach(session: &mut Session<MockBackend, MockCatalog>, id: u32) {
        session.on_client_frame(control(ClientMessage::Attach {
            window_id: id,
            width: 64,
            height: 64,
            scale: 1.0,
        }));
    }

    #[test]
    fn greets_a_matching_client() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        let messages = drain_messages(&mut s);
        assert!(matches!(
            messages.as_slice(),
            [ServerMessage::Welcome { .. }]
        ));
        assert!(!s.is_ended());
    }

    #[test]
    fn refuses_a_client_speaking_another_protocol() {
        let mut s = session();
        s.on_client_frame(control(ClientMessage::Hello {
            protocol: PROTOCOL_VERSION + 7,
            caps: ClientCaps::default(),
            device_pixel_ratio: 1.0,
        }));
        assert!(s.is_ended());
        assert!(matches!(
            drain_messages(&mut s).as_slice(),
            [ServerMessage::Error {
                code: ErrorCode::ProtocolMismatch,
                ..
            }]
        ));
    }

    #[test]
    fn refuses_traffic_before_the_handshake() {
        let mut s = session();
        s.on_client_frame(control(ClientMessage::ListApps { refresh: false }));
        assert!(s.is_ended());
    }

    #[test]
    fn lists_apps() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        s.on_client_frame(control(ClientMessage::ListApps { refresh: false }));
        let messages = drain_messages(&mut s);
        let ServerMessage::Apps { apps, complete } = &messages[0] else {
            panic!("expected apps, got {messages:?}");
        };
        assert!(complete);
        assert_eq!(apps.len(), 2);
    }

    #[test]
    fn launches_a_known_app_with_the_session_environment() {
        let mut s = Session::new(
            MockBackend::default(),
            MockCatalog::with_apps(),
            SessionConfig {
                launch_env: BTreeMap::from([("WAYLAND_DISPLAY".into(), "wayland-iw-x".into())]),
                ..SessionConfig::default()
            },
        );
        s.on_client_frame(hello(ClientCaps::default()));
        s.on_client_frame(control(ClientMessage::Launch {
            app_id: Some("editor.desktop".into()),
            exec: None,
            cwd: None,
        }));
        let launched = s.backend_mut().launched.clone();
        assert_eq!(launched.len(), 1);
        assert_eq!(launched[0].argv, vec!["editor"]);
        assert_eq!(launched[0].env["WAYLAND_DISPLAY"], "wayland-iw-x");
    }

    #[test]
    fn reports_an_unknown_app_rather_than_guessing() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        s.on_client_frame(control(ClientMessage::Launch {
            app_id: Some("nope.desktop".into()),
            exec: None,
            cwd: None,
        }));
        assert!(matches!(
            drain_messages(&mut s).as_slice(),
            [ServerMessage::Error {
                code: ErrorCode::UnknownApp,
                ..
            }]
        ));
        assert!(s.backend_mut().launched.is_empty());
    }

    #[test]
    fn refuses_a_terminal_only_entry_with_an_explanation() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        s.on_client_frame(control(ClientMessage::Launch {
            app_id: Some("htop.desktop".into()),
            exec: None,
            cwd: None,
        }));
        let messages = drain_messages(&mut s);
        assert!(matches!(
            messages.as_slice(),
            [ServerMessage::LaunchResult { ok: false, .. }]
        ));
        assert!(s.backend_mut().launched.is_empty());
    }

    #[test]
    fn a_window_carries_its_apps_icon() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        open_window(&mut s, 1);
        let messages = drain_messages(&mut s);
        let ServerMessage::WindowOpen { icon, .. } = &messages[0] else {
            panic!("expected windowOpen, got {messages:?}");
        };
        assert_eq!(icon.as_deref(), Some("data:image/png;base64,ZWRpdG9y"));
    }

    #[test]
    fn sends_nothing_for_a_window_nobody_is_looking_at() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        s.backend_mut().set_frame(1, 64, 64, 1);
        s.on_backend_event(BackendEvent::WindowDamaged {
            window_id: 1,
            damage: vec![],
        });
        s.pump();
        assert!(drain_pixels(&mut s).is_empty());
    }

    #[test]
    fn the_first_frame_after_attach_is_a_keyframe() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        s.backend_mut().set_frame(1, 64, 64, 1);
        s.pump();
        let pixels = drain_pixels(&mut s);
        assert_eq!(pixels.len(), 1);
        assert_eq!(pixels[0].0, 1);
        assert!(pixels[0].1.keyframe);
    }

    #[test]
    fn stops_encoding_once_the_in_flight_budget_is_spent() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);

        // Three distinct frames, no acks: the third must not go out.
        for generation in 1..=3u8 {
            s.backend_mut().set_frame(1, 64, 64, generation);
            s.on_backend_event(BackendEvent::WindowDamaged {
                window_id: 1,
                damage: vec![Rect::new(0, 0, 64, 64)],
            });
            s.pump();
        }
        assert_eq!(drain_pixels(&mut s).len(), 2);
    }

    #[test]
    fn an_ack_frees_a_slot() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        for generation in 1..=3u8 {
            s.backend_mut().set_frame(1, 64, 64, generation);
            s.on_backend_event(BackendEvent::WindowDamaged {
                window_id: 1,
                damage: vec![Rect::new(0, 0, 64, 64)],
            });
            s.pump();
        }
        drain_pixels(&mut s);

        s.on_client_frame(control(ClientMessage::Ack {
            window_id: 1,
            seq: 1,
            decode_ms: 4,
        }));
        s.backend_mut().set_frame(1, 64, 64, 9);
        s.on_backend_event(BackendEvent::WindowDamaged {
            window_id: 1,
            damage: vec![Rect::new(0, 0, 64, 64)],
        });
        s.pump();
        assert_eq!(drain_pixels(&mut s).len(), 1);
    }

    #[test]
    fn damage_accumulates_while_blocked_and_lands_in_one_frame() {
        // The client sees one up-to-date frame, not a backlog of stale ones.
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        s.backend_mut().set_frame(1, 64, 64, 1);
        s.pump();
        drain_pixels(&mut s);
        s.on_client_frame(control(ClientMessage::Ack {
            window_id: 1,
            seq: 1,
            decode_ms: 1,
        }));

        // Two separate damage reports arrive before we get to encode.
        s.on_backend_event(BackendEvent::WindowDamaged {
            window_id: 1,
            damage: vec![Rect::new(0, 0, 8, 8)],
        });
        s.on_backend_event(BackendEvent::WindowDamaged {
            window_id: 1,
            damage: vec![Rect::new(40, 40, 8, 8)],
        });
        s.backend_mut().set_frame(1, 64, 64, 2);
        s.pump();

        let pixels = drain_pixels(&mut s);
        assert_eq!(pixels.len(), 1);
        assert_eq!(
            pixels[0].1.rects.len(),
            2,
            "both damaged regions arrive in a single frame"
        );
    }

    #[test]
    fn an_unchanged_window_costs_no_frame_and_no_slot() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        s.backend_mut().set_frame(1, 64, 64, 1);
        s.pump();
        drain_pixels(&mut s);
        s.on_client_frame(control(ClientMessage::Ack {
            window_id: 1,
            seq: 1,
            decode_ms: 1,
        }));

        // Same pixels, damage reported anyway — the toolkit's usual behaviour.
        for _ in 0..5 {
            s.on_backend_event(BackendEvent::WindowDamaged {
                window_id: 1,
                damage: vec![Rect::new(0, 0, 64, 64)],
            });
            s.pump();
        }
        assert!(drain_pixels(&mut s).is_empty());
    }

    #[test]
    fn a_resize_forces_the_next_frame_to_stand_alone() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        s.backend_mut().set_frame(1, 64, 64, 1);
        s.pump();
        drain_pixels(&mut s);
        s.on_client_frame(control(ClientMessage::Ack {
            window_id: 1,
            seq: 1,
            decode_ms: 1,
        }));

        s.on_client_frame(control(ClientMessage::Resize {
            window_id: 1,
            width: 128,
            height: 96,
            scale: 1.0,
        }));
        assert_eq!(
            s.backend_mut().configured.last(),
            Some(&(1u32, 128u32, 96u32))
        );
        s.backend_mut().set_frame(1, 128, 96, 2);
        s.pump();
        let pixels = drain_pixels(&mut s);
        assert!(pixels[0].1.keyframe);
        assert_eq!(pixels[0].1.width, 128);
    }

    #[test]
    fn detaching_stops_pixels_without_closing_the_window() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        s.on_client_frame(control(ClientMessage::Detach { window_id: 1 }));
        s.backend_mut().set_frame(1, 64, 64, 2);
        s.on_backend_event(BackendEvent::WindowDamaged {
            window_id: 1,
            damage: vec![Rect::new(0, 0, 64, 64)],
        });
        s.pump();
        assert!(drain_pixels(&mut s).is_empty());
        assert_eq!(s.window_ids(), vec![1]);
        assert!(s.backend_mut().closed.is_empty());
    }

    #[test]
    fn input_reaches_the_backend() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        let events = vec![InputEvent::Key {
            time_ms: 5,
            keycode: 30,
            state: iw_proto::ButtonState::Pressed,
        }];
        s.on_client_frame(Frame {
            kind: FrameKind::Input,
            window_id: 1,
            payload: iw_proto::encode_input_batch(&events),
        });
        assert_eq!(s.backend_mut().input.last().unwrap(), &(1u32, events));
    }

    #[test]
    fn input_for_a_closed_window_is_dropped_quietly() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        s.on_client_frame(Frame {
            kind: FrameKind::Input,
            window_id: 99,
            payload: iw_proto::encode_input_batch(&[InputEvent::PointerLeave { time_ms: 1 }]),
        });
        assert!(drain_messages(&mut s).is_empty());
        assert!(s.backend_mut().input.is_empty());
    }

    #[test]
    fn a_closed_window_is_reported_once_and_forgotten() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        drain_messages(&mut s);
        s.on_backend_event(BackendEvent::WindowClosed {
            window_id: 1,
            crashed: true,
        });
        s.on_backend_event(BackendEvent::WindowClosed {
            window_id: 1,
            crashed: true,
        });
        let messages = drain_messages(&mut s);
        assert_eq!(messages.len(), 1);
        assert!(matches!(
            messages[0],
            ServerMessage::WindowClose {
                reason: WindowCloseReason::Crashed,
                ..
            }
        ));
        assert!(s.window_ids().is_empty());
    }

    #[test]
    fn a_dialog_reports_its_parent_so_it_does_not_become_a_tab() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        s.on_backend_event(BackendEvent::WindowOpened {
            window_id: 2,
            app_id: Some("editor".into()),
            title: "Save as".into(),
            width: 32,
            height: 32,
            parent_window_id: Some(1),
        });
        assert_eq!(s.parent_of(2), Some(1));
        let messages = drain_messages(&mut s);
        assert!(matches!(
            messages.last(),
            Some(ServerMessage::WindowOpen {
                parent_window_id: Some(1),
                ..
            })
        ));
    }

    #[test]
    fn killing_the_session_closes_every_window_and_stops() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        open_window(&mut s, 2);
        drain_messages(&mut s);
        s.on_client_frame(control(ClientMessage::KillSession));

        let messages = drain_messages(&mut s);
        assert_eq!(messages.len(), 2);
        assert!(messages.iter().all(|m| matches!(
            m,
            ServerMessage::WindowClose {
                reason: WindowCloseReason::SessionEnded,
                ..
            }
        )));
        assert!(s.is_ended());
        assert!(s.backend_mut().shutdown_called);

        // Nothing after the end is acted on.
        s.on_client_frame(control(ClientMessage::Ping { nonce: 1 }));
        assert!(drain_messages(&mut s).is_empty());
    }

    #[test]
    fn a_client_without_zstd_gets_jpeg_rather_than_raw_rectangles() {
        // No lossless tier is available to it, and a screenful of uncompressed
        // pixels over SSH is worse than a lossy one that arrives.
        let mut s = session();
        s.on_client_frame(hello(ClientCaps {
            zstd: false,
            ..ClientCaps::default()
        }));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        s.backend_mut().set_frame(1, 64, 64, 1);
        s.pump();
        let pixels = drain_pixels(&mut s);
        assert_eq!(pixels[0].1.codec, Codec::JpegTiles);
    }

    #[test]
    fn a_client_with_neither_zstd_nor_jpeg_gets_raw_rectangles() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps {
            zstd: false,
            jpeg: false,
            ..ClientCaps::default()
        }));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        s.backend_mut().set_frame(1, 64, 64, 1);
        s.pump();
        let pixels = drain_pixels(&mut s);
        assert_eq!(pixels[0].1.codec, Codec::RawRects);
    }

    #[test]
    fn a_window_in_motion_moves_to_the_lossy_tier_and_back() {
        // The user-visible arc: play a video, everything redraws, the window
        // goes to JPEG; stop, and it comes back exact — with a keyframe,
        // because every pixel on screen is currently an approximation.
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        open_window(&mut s, 1);
        attach(&mut s, 1);
        for step in 0..16u8 {
            s.backend_mut().set_frame(1, 64, 64, step.wrapping_mul(37));
            s.on_backend_event(BackendEvent::WindowDamaged {
                window_id: 1,
                damage: vec![Rect::new(0, 0, 64, 64)],
            });
            s.pump();
            for (window_id, payload) in drain_pixels(&mut s) {
                s.on_client_frame(control(ClientMessage::Ack {
                    window_id,
                    seq: payload.seq,
                    decode_ms: 1,
                }));
            }
        }
        assert_eq!(s.tier(1), Some(Tier::Image));

        // Nothing changes for a while: the same frame, redrawn.
        for _ in 0..24 {
            s.backend_mut().set_frame(1, 64, 64, 9);
            s.on_backend_event(BackendEvent::WindowDamaged {
                window_id: 1,
                damage: vec![Rect::new(0, 0, 64, 64)],
            });
            s.pump();
            for (window_id, payload) in drain_pixels(&mut s) {
                s.on_client_frame(control(ClientMessage::Ack {
                    window_id,
                    seq: payload.seq,
                    decode_ms: 1,
                }));
            }
        }
        assert_eq!(s.tier(1), Some(Tier::Lossless));
    }

    #[test]
    fn a_launch_prefix_wraps_the_application() {
        // How a host with no session bus gets one: the application runs under
        // dbus-run-session, which cannot be expressed as an environment
        // variable because the bus does not exist until it starts.
        let mut s = Session::new(
            MockBackend::default(),
            MockCatalog::with_apps(),
            SessionConfig {
                launch_prefix: vec!["dbus-run-session".into(), "--".into()],
                ..SessionConfig::default()
            },
        );
        s.on_client_frame(hello(ClientCaps::default()));
        s.on_client_frame(control(ClientMessage::Launch {
            app_id: Some("editor.desktop".into()),
            exec: None,
            cwd: None,
        }));
        assert_eq!(
            s.backend_mut().launched[0].argv,
            vec!["dbus-run-session", "--", "editor"]
        );
    }

    #[test]
    fn a_bare_command_is_wrapped_too() {
        let mut s = Session::new(
            MockBackend::default(),
            MockCatalog::with_apps(),
            SessionConfig {
                launch_prefix: vec!["dbus-run-session".into(), "--".into()],
                ..SessionConfig::default()
            },
        );
        s.on_client_frame(hello(ClientCaps::default()));
        s.on_client_frame(control(ClientMessage::Launch {
            app_id: None,
            exec: Some("xterm -e top".into()),
            cwd: None,
        }));
        assert_eq!(
            s.backend_mut().launched[0].argv,
            vec!["dbus-run-session", "--", "xterm", "-e", "top"]
        );
    }

    #[test]
    fn no_prefix_leaves_the_command_alone() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        s.on_client_frame(control(ClientMessage::Launch {
            app_id: Some("editor.desktop".into()),
            exec: None,
            cwd: None,
        }));
        assert_eq!(s.backend_mut().launched[0].argv, vec!["editor"]);
    }

    #[test]
    fn clipboard_crosses_in_both_directions() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);

        let blob = ClipboardBlob {
            mime_type: "text/plain;charset=utf-8".into(),
            data: b"from the browser".to_vec(),
        };
        s.on_client_frame(Frame {
            kind: FrameKind::ClipboardClient,
            window_id: SESSION_WINDOW,
            payload: blob.encode(),
        });
        assert_eq!(s.backend_mut().clipboard_offered.last().unwrap(), &blob);

        s.on_backend_event(BackendEvent::ClipboardData {
            mime_type: "text/plain".into(),
            data: b"from the app".to_vec(),
        });
        let mut decoder = FrameDecoder::new();
        for bytes in s.drain() {
            decoder.push(&bytes);
        }
        let frame = decoder.next_frame().unwrap().unwrap();
        assert_eq!(frame.kind, FrameKind::ClipboardServer);
        assert_eq!(
            ClipboardBlob::decode(&frame.payload).unwrap().data,
            b"from the app"
        );
    }

    #[test]
    fn ping_is_answered() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        s.on_client_frame(control(ClientMessage::Ping { nonce: 77 }));
        assert!(matches!(
            drain_messages(&mut s).as_slice(),
            [ServerMessage::Pong { nonce: 77 }]
        ));
    }

    #[test]
    fn attaching_to_a_window_that_does_not_exist_is_an_error() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        attach(&mut s, 404);
        assert!(matches!(
            drain_messages(&mut s).as_slice(),
            [ServerMessage::Error {
                code: ErrorCode::UnknownWindow,
                ..
            }]
        ));
    }

    fn chunk(seq: u32) -> AudioChunk {
        AudioChunk {
            codec: iw_proto::AudioCodec::PcmS16,
            channels: 2,
            flags: 0,
            seq,
            sample_rate: 48_000,
            data: vec![1, 2, 3, 4],
        }
    }

    fn drain_audio(session: &mut Session<MockBackend, MockCatalog>) -> Vec<AudioChunk> {
        let mut decoder = FrameDecoder::new();
        for bytes in session.drain() {
            decoder.push(&bytes);
        }
        let mut out = Vec::new();
        while let Some(frame) = decoder.next_frame().unwrap() {
            if frame.kind == FrameKind::Audio {
                assert_eq!(frame.window_id, SESSION_WINDOW);
                out.push(AudioChunk::decode(&frame.payload).unwrap());
            }
        }
        out
    }

    #[test]
    fn audio_chunks_reach_a_client_that_declared_the_capability() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        s.on_audio_chunk(&chunk(1));
        assert_eq!(drain_audio(&mut s), vec![chunk(1)]);
    }

    #[test]
    fn audio_is_never_sent_to_a_client_without_the_capability() {
        // The old-client case: an unknown frame kind is a thrown protocol
        // error over there, so the gate is load-bearing, not an optimisation.
        let mut s = session();
        s.on_client_frame(hello(ClientCaps {
            audio: false,
            ..ClientCaps::default()
        }));
        drain_messages(&mut s);
        s.on_audio_chunk(&chunk(1));
        assert!(drain_audio(&mut s).is_empty());
    }

    #[test]
    fn audio_is_not_sent_before_the_handshake() {
        let mut s = session();
        s.on_audio_chunk(&chunk(1));
        assert!(drain_audio(&mut s).is_empty());
        assert!(!s.wants_audio());
    }

    #[test]
    fn set_audio_stops_and_resumes_the_stream() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);

        s.on_client_frame(control(ClientMessage::SetAudio { enabled: false }));
        assert!(!s.wants_audio());
        s.on_audio_chunk(&chunk(1));
        assert!(drain_audio(&mut s).is_empty());

        s.on_client_frame(control(ClientMessage::SetAudio { enabled: true }));
        s.on_audio_chunk(&chunk(2));
        assert_eq!(drain_audio(&mut s), vec![chunk(2)]);
    }

    #[test]
    fn an_audio_frame_from_the_client_is_a_protocol_error() {
        let mut s = session();
        s.on_client_frame(hello(ClientCaps::default()));
        drain_messages(&mut s);
        s.on_client_frame(Frame {
            kind: FrameKind::Audio,
            window_id: SESSION_WINDOW,
            payload: chunk(1).encode(),
        });
        assert!(matches!(
            drain_messages(&mut s).as_slice(),
            [ServerMessage::Error {
                code: ErrorCode::Internal,
                ..
            }]
        ));
    }
}
