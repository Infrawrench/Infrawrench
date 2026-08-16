//! Control messages. These are JSON because they are cold, and because the
//! other end of this protocol is TypeScript — the field names here are the
//! field names in `@infrawrench/appstream-core`, so they are camelCase and
//! every optional field is genuinely optional rather than nullable.

use serde::{Deserialize, Serialize};

use crate::ProtocolError;

/// What the client can decode. The encoder picks its tier from this and never
/// sends something the viewer would have to drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCaps {
    /// `WebCodecs VideoDecoder` with a working vp09 config.
    pub vp9: bool,
    /// `createImageBitmap` of a WebP blob — true everywhere we ship, kept as a
    /// flag so a stripped-down host (a test harness, the CLI) can say no.
    pub webp: bool,
    /// The wasm zstd decoder loaded. Without it there is no lossless tier and
    /// the session is image-only.
    pub zstd: bool,
    /// `createImageBitmap` of a JPEG blob. Defaulted true rather than false:
    /// every browser has decoded JPEG for thirty years, and a client old
    /// enough to omit the field is one whose `webp` flag meant the same thing.
    #[serde(default = "yes")]
    pub jpeg: bool,
    /// The client applies `RectOp::Delta` — interframe compression. Defaulted
    /// **false**, because a client that does not know the op would paint a
    /// rectangle of differences as if they were pixels: garbage, silently.
    #[serde(default)]
    pub delta: bool,
    /// Largest single frame the client will accept, in bytes.
    pub max_frame_bytes: u32,
}

fn yes() -> bool {
    true
}

impl Default for ClientCaps {
    fn default() -> Self {
        Self {
            vp9: false,
            webp: true,
            zstd: true,
            jpeg: true,
            delta: true,
            max_frame_bytes: 16 * 1024 * 1024,
        }
    }
}

/// What this build of `iwappd` can actually do on this host — resolved at
/// startup, not compiled in, because it depends on what is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCaps {
    pub vp9: bool,
    pub webp: bool,
    /// This build has the JPEG encoder — the lossy tier. Always true today;
    /// a flag because the client's tier choice reads both ends.
    #[serde(default)]
    pub jpeg: bool,
    pub xwayland: bool,
    pub audio: bool,
    /// A `wl_shm` client can start at all: we found or created an
    /// `XDG_RUNTIME_DIR` we can put a socket in.
    pub runtime_dir: bool,
}

/// Byte order of the pixels in a lossless frame. `wl_shm`'s `Argb8888` is
/// little-endian ARGB, which is BGRA in memory — the client's blit needs to be
/// told, not to guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PixelFormat {
    Bgra8888,
    Rgba8888,
}

/// One launchable application, as found in the host's desktop entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    /// Desktop-file id, e.g. `org.gnome.Nautilus.desktop`. Stable across
    /// sessions, which is what makes "recently launched" work.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<String>,
    /// `data:image/png;base64,…`, capped well under the tab-icon budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// `StartupWMClass`, which is how a window that reports a different
    /// `app_id` than its desktop file gets the right icon on its tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wm_class: Option<String>,
    /// `Terminal=true` entries need a terminal emulator we do not provide;
    /// surfaced so the launcher can grey them out rather than fail on click.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_terminal: bool,
}

/// Why a window went away, so the tab can say something better than "closed".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowCloseReason {
    /// The application closed it (or we asked and it complied).
    Closed,
    /// The process died without unmapping — a crash.
    Crashed,
    /// The session is going away.
    SessionEnded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// `Welcome.protocol` and the client's version do not match.
    ProtocolMismatch,
    /// No desktop entry with that id, or the binary it names is gone.
    UnknownApp,
    /// The app was spawned and exited immediately — almost always a missing
    /// library on a bare host, so the message carries the real stderr.
    LaunchFailed,
    /// No `XDG_RUNTIME_DIR` and we could not create one.
    NoRuntimeDir,
    /// Referenced a window that is not (or no longer) open.
    UnknownWindow,
    Internal,
}

/// A clipboard payload, carried as a binary frame rather than JSON because it
/// may be an image and base64 would inflate it by a third.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardBlob {
    pub mime_type: String,
    pub data: Vec<u8>,
}

impl ClipboardBlob {
    /// `u16 mime_len | mime | data`.
    pub fn encode(&self) -> Vec<u8> {
        let mime = self.mime_type.as_bytes();
        let mut out = Vec::with_capacity(2 + mime.len() + self.data.len());
        out.extend_from_slice(&(mime.len() as u16).to_le_bytes());
        out.extend_from_slice(mime);
        out.extend_from_slice(&self.data);
        out
    }

    pub fn decode(payload: &[u8]) -> Result<Self, ProtocolError> {
        if payload.len() < 2 {
            return Err(ProtocolError::Truncated {
                expected: 2,
                actual: payload.len(),
            });
        }
        let mime_len = u16::from_le_bytes([payload[0], payload[1]]) as usize;
        if payload.len() < 2 + mime_len {
            return Err(ProtocolError::Truncated {
                expected: 2 + mime_len,
                actual: payload.len(),
            });
        }
        let mime_type = std::str::from_utf8(&payload[2..2 + mime_len])
            .map_err(|_| ProtocolError::Utf8 { field: "mimeType" })?
            .to_owned();
        Ok(Self {
            mime_type,
            data: payload[2 + mime_len..].to_vec(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Hello {
        protocol: u32,
        caps: ClientCaps,
        /// Device pixel ratio of the viewer, so windows are configured at the
        /// scale they will actually be shown at.
        device_pixel_ratio: f32,
    },
    #[serde(rename_all = "camelCase")]
    ListApps {
        /// Skip the cache and re-scan the desktop entries.
        #[serde(default)]
        refresh: bool,
    },
    #[serde(rename_all = "camelCase")]
    Launch {
        /// Desktop-file id. Mutually exclusive with `exec`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_id: Option<String>,
        /// A raw command, for the power case the launcher grid cannot express.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exec: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Start (or resume) receiving pixels for a window at this size.
    #[serde(rename_all = "camelCase")]
    Attach {
        window_id: u32,
        width: u32,
        height: u32,
        scale: f32,
    },
    /// Stop receiving pixels without closing the window — the tab is in the
    /// background. The app keeps running.
    #[serde(rename_all = "camelCase")]
    Detach { window_id: u32 },
    #[serde(rename_all = "camelCase")]
    Resize {
        window_id: u32,
        width: u32,
        height: u32,
        scale: f32,
    },
    #[serde(rename_all = "camelCase")]
    CloseWindow { window_id: u32 },
    /// Frame `seq` reached the screen. Drives flow control and the degraded
    /// indicator; `decodeMs` is the client's own decode+paint cost.
    #[serde(rename_all = "camelCase")]
    Ack {
        window_id: u32,
        seq: u32,
        decode_ms: u32,
    },
    /// The client's clipboard changed; these are the types it can provide.
    #[serde(rename_all = "camelCase")]
    ClipboardOffer { mime_types: Vec<String> },
    /// An app asked for the clipboard; send this type.
    #[serde(rename_all = "camelCase")]
    ClipboardRequest { mime_type: String },
    /// Close every window and exit. The tab's "end session" button.
    KillSession,
    #[serde(rename_all = "camelCase")]
    Ping { nonce: u32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    #[serde(rename_all = "camelCase")]
    Welcome {
        protocol: u32,
        session_id: String,
        version: String,
        caps: ServerCaps,
        pixel_format: PixelFormat,
        /// XKB keymap the client's key events are resolved against, as the
        /// text of a `.xkb` file. The client needs it to know which keycode to
        /// send for a given `KeyboardEvent.code`.
        keymap: String,
    },
    #[serde(rename_all = "camelCase")]
    Apps {
        apps: Vec<AppEntry>,
        /// Icon resolution is the slow half of a scan, so the list arrives in
        /// batches and the launcher renders the first one immediately.
        complete: bool,
    },
    #[serde(rename_all = "camelCase")]
    WindowOpen {
        window_id: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_id: Option<String>,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
        width: u32,
        height: u32,
        /// Set when this window is a dialog belonging to another window. The
        /// client composites it into the parent's tab rather than opening one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_window_id: Option<u32>,
    },
    /// Title, app id or icon changed. Sent whenever the app renames a window,
    /// which is how a tab tracks the open document.
    #[serde(rename_all = "camelCase")]
    WindowMeta {
        window_id: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WindowClose {
        window_id: u32,
        reason: WindowCloseReason,
    },
    /// Cursor for the focused window: either a named shape the viewer maps to
    /// a CSS cursor, or a bitmap it draws itself. Either way the pointer is
    /// rendered locally, so it never lags the link.
    #[serde(rename_all = "camelCase")]
    Cursor {
        window_id: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<CursorImage>,
    },
    #[serde(rename_all = "camelCase")]
    ClipboardOffer { mime_types: Vec<String> },
    #[serde(rename_all = "camelCase")]
    LaunchResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_id: Option<String>,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// Per-window encoder telemetry, for the degraded-connection indicator.
    #[serde(rename_all = "camelCase")]
    Stats {
        window_id: u32,
        encoded_bytes: u64,
        frames_sent: u32,
        frames_dropped: u32,
        encode_ms_p50: u32,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        code: ErrorCode,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_id: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Pong { nonce: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorImage {
    pub width: u32,
    pub height: u32,
    pub hotspot_x: u32,
    pub hotspot_y: u32,
    /// `data:image/png;base64,…`
    pub data_url: String,
}

impl ClientMessage {
    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("control messages are always serialisable")
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, ProtocolError> {
        Ok(serde_json::from_slice(bytes)?)
    }
}

impl ServerMessage {
    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("control messages are always serialisable")
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, ProtocolError> {
        Ok(serde_json::from_slice(bytes)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_messages_are_tagged_camel_case() {
        let json = String::from_utf8(
            ClientMessage::Attach {
                window_id: 3,
                width: 1280,
                height: 800,
                scale: 2.0,
            }
            .to_json(),
        )
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"attach","windowId":3,"width":1280,"height":800,"scale":2.0}"#
        );
    }

    #[test]
    fn optional_fields_are_omitted_not_nulled() {
        // The TS side types these as `field?: string`, so a null would be a
        // type error there rather than a missing value.
        let json = String::from_utf8(
            ClientMessage::Launch {
                app_id: Some("firefox.desktop".into()),
                exec: None,
                cwd: None,
            }
            .to_json(),
        )
        .unwrap();
        assert_eq!(json, r#"{"type":"launch","appId":"firefox.desktop"}"#);
    }

    #[test]
    fn server_messages_round_trip() {
        let msg = ServerMessage::WindowOpen {
            window_id: 12,
            app_id: Some("org.gnome.TextEditor".into()),
            title: "untitled".into(),
            icon: Some("data:image/png;base64,AAA".into()),
            width: 800,
            height: 600,
            parent_window_id: None,
        };
        assert_eq!(ServerMessage::from_json(&msg.to_json()).unwrap(), msg);
    }

    #[test]
    fn an_app_entry_omits_its_empty_halves() {
        let json = String::from_utf8(
            serde_json::to_vec(&AppEntry {
                id: "vim.desktop".into(),
                name: "Vim".into(),
                comment: None,
                categories: vec![],
                icon: None,
                wm_class: None,
                needs_terminal: true,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            json,
            r#"{"id":"vim.desktop","name":"Vim","needsTerminal":true}"#
        );
    }

    #[test]
    fn clipboard_blobs_round_trip_binary_data() {
        let blob = ClipboardBlob {
            mime_type: "image/png".into(),
            data: vec![0x89, b'P', b'N', b'G', 0, 255],
        };
        assert_eq!(ClipboardBlob::decode(&blob.encode()).unwrap(), blob);
    }

    #[test]
    fn a_truncated_clipboard_blob_is_an_error_not_a_panic() {
        assert!(matches!(
            ClipboardBlob::decode(&[9, 0, b'x']),
            Err(ProtocolError::Truncated { .. })
        ));
        assert!(matches!(
            ClipboardBlob::decode(&[1]),
            Err(ProtocolError::Truncated { .. })
        ));
    }
}
