//! Test doubles for the two seams the session sits between.
//!
//! Only compiled for tests. The mock backend keeps a per-window pixel buffer
//! whose contents vary with a "generation" number, so a test can say "the app
//! drew something new" without hand-writing pixels.

use std::collections::{BTreeMap, HashMap};

use iw_proto::{AppEntry, ClipboardBlob, InputEvent};

use crate::backend::{Backend, BackendError, BackendFrame, LaunchSpec};
use crate::catalog::{Catalog, ResolvedApp};

#[derive(Default)]
pub struct MockBackend {
    pub launched: Vec<LaunchSpec>,
    pub configured: Vec<(u32, u32, u32)>,
    pub input: Vec<(u32, Vec<InputEvent>)>,
    pub closed: Vec<u32>,
    pub clipboard_offered: Vec<ClipboardBlob>,
    pub clipboard_requests: Vec<String>,
    pub shutdown_called: bool,
    pub fail_launch: Option<String>,
    pub pids: HashMap<u32, u32>,
    frames: HashMap<u32, (u32, u32, Vec<u8>)>,
}

impl MockBackend {
    /// Give a window a full buffer whose pixels depend on `generation`, so
    /// successive calls look like the app redrew.
    pub fn set_frame(&mut self, window_id: u32, width: u32, height: u32, generation: u8) {
        let pixels = (0..width * height)
            .flat_map(|i| {
                let v = (i as u8)
                    .wrapping_mul(7)
                    .wrapping_add(generation.wrapping_mul(53));
                [v, v.wrapping_add(11), v.wrapping_add(29), 255]
            })
            .collect();
        self.frames.insert(window_id, (width, height, pixels));
    }
}

impl Backend for MockBackend {
    fn launch(&mut self, spec: LaunchSpec) -> Result<(), BackendError> {
        if let Some(message) = &self.fail_launch {
            return Err(BackendError::Launch(message.clone()));
        }
        self.launched.push(spec);
        Ok(())
    }

    fn configure(
        &mut self,
        window_id: u32,
        width: u32,
        height: u32,
        _scale: f32,
    ) -> Result<(), BackendError> {
        self.configured.push((window_id, width, height));
        Ok(())
    }

    fn send_input(&mut self, window_id: u32, events: &[InputEvent]) -> Result<(), BackendError> {
        self.input.push((window_id, events.to_vec()));
        Ok(())
    }

    fn close_window(&mut self, window_id: u32) -> Result<(), BackendError> {
        self.closed.push(window_id);
        Ok(())
    }

    fn take_frame(&mut self, window_id: u32) -> Option<BackendFrame<'_>> {
        let (width, height, pixels) = self.frames.get(&window_id)?;
        Some(BackendFrame {
            width: *width,
            height: *height,
            stride: width * 4,
            pixels,
            // Damage reaches the session as a backend *event*; a frame is just
            // the pixels behind it.
            damage: Vec::new(),
        })
    }

    fn window_pid(&mut self, window_id: u32) -> Option<u32> {
        self.pids.get(&window_id).copied()
    }

    fn offer_clipboard(&mut self, mime_type: &str, data: &[u8]) -> Result<(), BackendError> {
        self.clipboard_offered.push(ClipboardBlob {
            mime_type: mime_type.to_owned(),
            data: data.to_vec(),
        });
        Ok(())
    }

    fn request_clipboard(&mut self, mime_type: &str) -> Result<(), BackendError> {
        self.clipboard_requests.push(mime_type.to_owned());
        Ok(())
    }

    fn shutdown(&mut self) {
        self.shutdown_called = true;
    }
}

/// A two-app catalog: one launchable, one terminal-only.
pub struct MockCatalog {
    apps: Vec<AppEntry>,
    resolved: BTreeMap<String, ResolvedApp>,
}

impl MockCatalog {
    pub fn with_apps() -> Self {
        let icon = iw_apps::base64::data_url("image/png", b"editor");
        Self {
            apps: vec![
                AppEntry {
                    id: "editor.desktop".into(),
                    name: "Editor".into(),
                    comment: None,
                    categories: vec!["Utility".into()],
                    icon: Some(icon),
                    wm_class: Some("editor".into()),
                    needs_terminal: false,
                },
                AppEntry {
                    id: "htop.desktop".into(),
                    name: "htop".into(),
                    comment: None,
                    categories: vec![],
                    icon: None,
                    wm_class: None,
                    needs_terminal: true,
                },
            ],
            resolved: BTreeMap::from([
                (
                    "editor.desktop".to_string(),
                    ResolvedApp {
                        app_id: "editor.desktop".into(),
                        argv: vec!["editor".into()],
                        cwd: None,
                        needs_terminal: false,
                    },
                ),
                (
                    "htop.desktop".to_string(),
                    ResolvedApp {
                        app_id: "htop.desktop".into(),
                        argv: vec!["htop".into()],
                        cwd: None,
                        needs_terminal: true,
                    },
                ),
            ]),
        }
    }
}

impl Catalog for MockCatalog {
    fn list(&mut self, _refresh: bool) -> Vec<AppEntry> {
        self.apps.clone()
    }

    fn resolve(&mut self, app_id: &str) -> Option<ResolvedApp> {
        self.resolved.get(app_id).cloned()
    }

    fn icon_for_app_id(&mut self, app_id: &str) -> Option<String> {
        self.apps
            .iter()
            .find(|a| {
                a.wm_class.as_deref() == Some(app_id) || a.id.trim_end_matches(".desktop") == app_id
            })
            .and_then(|a| a.icon.clone())
    }
}
