//! The compositor's own state, and the Wayland protocol handlers hanging off
//! it.
//!
//! This is the half that only exists on Linux. It implements just enough of a
//! compositor to be a window manager for windows nobody local ever sees: a
//! surface arrives, we copy its pixels out of shared memory, and the layer
//! above turns that into frames for a workspace tab.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::os::unix::io::OwnedFd;
use std::time::Instant;

use iw_codec::Rect;
use smithay::input::{Seat, SeatHandler, SeatState};
use smithay::output::{Mode, Output, PhysicalProperties, Scale, Subpixel};
use smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1;
use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
use smithay::reexports::wayland_server::backend::{ClientData, ClientId, DisconnectReason};
use smithay::reexports::wayland_server::protocol::{
    wl_buffer, wl_seat, wl_shm, wl_surface::WlSurface,
};
use smithay::reexports::wayland_server::{Client, DisplayHandle, Resource};
use smithay::utils::Serial;
use smithay::wayland::buffer::BufferHandler;
use smithay::wayland::compositor::{
    BufferAssignment, CompositorClientState, CompositorHandler, CompositorState, Damage,
    SubsurfaceCachedState, SurfaceAttributes, TraversalAction, get_parent, with_states,
    with_surface_tree_downward,
};
use smithay::wayland::selection::SelectionHandler;
use smithay::wayland::selection::data_device::{
    ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
};
use smithay::wayland::shell::xdg::decoration::{XdgDecorationHandler, XdgDecorationState};
use smithay::wayland::shell::xdg::{
    PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
    XdgToplevelSurfaceData,
};
use smithay::wayland::shm::{ShmHandler, ShmState, with_buffer_contents};
use smithay::{
    delegate_compositor, delegate_data_device, delegate_output, delegate_seat, delegate_shm,
    delegate_xdg_decoration, delegate_xdg_shell,
};

use crate::backend::BackendEvent;

/// Highest buffer scale we will ask an application to render at.
///
/// Every step squares the pixels the encoder has to look at, and past 3 the
/// difference is below what a viewer downscaling to its own device pixel ratio
/// can show. A 4× display asks for 3× and the browser resamples the rest.
pub(super) const MAX_SCALE: i32 = 3;

/// One toplevel we are streaming.
pub struct WindowRec {
    pub toplevel: ToplevelSurface,
    pub surface: WlSurface,
    pub title: String,
    pub app_id: Option<String>,
    pub parent: Option<u32>,
    /// Size of the pixels we hold, which is the client's buffer size and not
    /// necessarily the size we last configured — a resize takes a round trip.
    pub width: u32,
    pub height: u32,
    /// Our own copy of the client's last committed buffer, tightly packed.
    ///
    /// The `wl_shm` pool is only safely readable inside `with_buffer_contents`,
    /// and the client is free to draw into it again the moment it has the
    /// buffer back, so a borrow would be a data race. One memcpy per commit is
    /// the price of not having one.
    pub pixels: Vec<u8>,
    pub damage: Vec<Rect>,
    /// A toplevel exists before it has anything to show. We announce it to the
    /// client on its first committed buffer, so a tab never opens on nothing.
    pub mapped: bool,
}

impl WindowRec {
    fn take_meta(&mut self, surface: &WlSurface) -> Option<(Option<String>, Option<String>)> {
        let (title, app_id) = with_states(surface, |states| {
            let data = states.data_map.get::<XdgToplevelSurfaceData>();
            match data {
                Some(data) => {
                    let data = data.lock().unwrap();
                    (data.title.clone(), data.app_id.clone())
                }
                None => (None, None),
            }
        });

        let title_changed = title.as_ref().is_some_and(|t| *t != self.title);
        let app_id_changed = app_id.is_some() && app_id != self.app_id;
        if !title_changed && !app_id_changed {
            return None;
        }
        if let Some(title) = &title {
            self.title = title.clone();
        }
        if app_id.is_some() {
            self.app_id = app_id.clone();
        }
        Some((
            title_changed.then(|| self.title.clone()),
            app_id_changed.then(|| self.app_id.clone()).flatten(),
        ))
    }
}

pub struct AppState {
    pub compositor: CompositorState,
    pub xdg: XdgShellState,
    /// Held for its global: dropping the state would withdraw
    /// `zxdg_decoration_manager_v1` from the display, and clients that bound
    /// it would start drawing their own titlebars inside our canvas.
    #[allow(dead_code)]
    pub decoration: XdgDecorationState,
    pub shm: ShmState,
    pub seat_state: SeatState<Self>,
    pub data_device: DataDeviceState,
    pub seat: Seat<Self>,
    /// Held for its global, same as `decoration`. Clients query it for scale
    /// and geometry before they map anything.
    #[allow(dead_code)]
    pub output: Output,
    /// Buffer pixels per logical pixel, as told to the applications through
    /// the output. Set from the viewer's device pixel ratio.
    scale: i32,
    pub windows: HashMap<u32, WindowRec>,
    pub next_window_id: u32,
    pub events: VecDeque<BackendEvent>,
    pub started: Instant,
    /// Clipboard the client offered us, handed to whichever app asks next.
    pub client_clipboard: Option<(String, Vec<u8>)>,
}

impl AppState {
    pub fn new(dh: &DisplayHandle) -> Self {
        let compositor = CompositorState::new::<Self>(dh);
        let xdg = XdgShellState::new::<Self>(dh);
        let decoration = XdgDecorationState::new::<Self>(dh);
        // Advertise only the two formats every toolkit can produce. Offering
        // more would mean handling more conversions in the encoder for buffers
        // nothing actually uses.
        let shm = ShmState::new::<Self>(dh, vec![]);
        let mut seat_state = SeatState::new();
        let mut seat = seat_state.new_wl_seat(dh, "infrawrench");
        // The keymap is the default (us, evdev codes). The client maps its
        // browser key events onto that, and reaches anything the layout cannot
        // produce through the keysym path instead.
        let _ = seat.add_keyboard(Default::default(), 200, 25);
        let _ = seat.add_pointer();

        // One virtual output. Clients that ask for outputs before mapping —
        // which is most of them — get a sane answer instead of none.
        let output = Output::new(
            "infrawrench".to_owned(),
            PhysicalProperties {
                size: (0, 0).into(),
                subpixel: Subpixel::Unknown,
                make: "Infrawrench".to_owned(),
                model: "Virtual".to_owned(),
            },
        );
        output.create_global::<Self>(dh);
        output.change_current_state(
            Some(Mode {
                size: (1920, 1080).into(),
                refresh: 60_000,
            }),
            None,
            None,
            Some((0, 0).into()),
        );
        output.set_preferred(Mode {
            size: (1920, 1080).into(),
            refresh: 60_000,
        });

        Self {
            compositor,
            xdg,
            decoration,
            shm,
            data_device: DataDeviceState::new::<Self>(dh),
            seat_state,
            seat,
            output,
            windows: HashMap::new(),
            scale: 1,
            next_window_id: 1,
            events: VecDeque::new(),
            started: Instant::now(),
            client_clipboard: None,
        }
    }

    pub fn now_ms(&self) -> u32 {
        self.started.elapsed().as_millis() as u32
    }

    /// Tell the applications what resolution the viewer is actually showing
    /// them at. Returns true when this changed anything.
    ///
    /// This is the whole of HiDPI on the host side: a toolkit renders at the
    /// scale of the output its surface entered, so an output that says 2 gets a
    /// buffer with four times the pixels and text drawn for it, rather than a
    /// 1× buffer the browser then stretches. Everything else — the toplevel's
    /// configured size, the coordinates in the composite pass — follows from
    /// the client's answer to this.
    pub fn set_scale(&mut self, scale: i32) -> bool {
        let scale = scale.clamp(1, MAX_SCALE);
        if scale == self.scale {
            return false;
        }
        self.scale = scale;
        self.output
            .change_current_state(None, None, Some(Scale::Integer(scale)), None);
        // A surface that is already mapped has to be told again: it entered the
        // output when the scale was something else, and nothing re-sends that
        // on its own.
        for rec in self.windows.values() {
            self.output.leave(&rec.surface);
            self.output.enter(&rec.surface);
        }
        true
    }

    pub fn scale(&self) -> i32 {
        self.scale
    }

    pub fn window_id_for(&self, surface: &WlSurface) -> Option<u32> {
        self.windows
            .iter()
            .find(|(_, rec)| rec.surface == *surface)
            .map(|(id, _)| *id)
    }

    /// Re-draw a window from its whole surface tree.
    ///
    /// A toplevel's own buffer is only half the picture — a Wayland client may
    /// put its actual content in subsurfaces, and Firefox does exactly that:
    /// its toplevel carries the GTK shadow frame and nothing else, while the
    /// web page lives in a child. Compositing only the toplevel yields a white
    /// rectangle with a drop shadow, which is precisely what the first capture
    /// against a real browser produced.
    fn composite(&mut self, window_id: u32) {
        let Some(rec) = self.windows.get(&window_id) else {
            return;
        };
        let root = rec.surface.clone();

        // The root's own buffer sets the window size; children draw into it at
        // their offsets.
        let Some((width, height)) = surface_size(&root) else {
            return;
        };
        let root_scale = surface_scale(&root);
        let mut canvas = vec![0u8; width as usize * height as usize * 4];
        let mut damage: Vec<Rect> = Vec::new();

        with_surface_tree_downward(
            &root,
            (0i32, 0i32),
            |_, states, offset| {
                // Draw on the way *down*: a parent is painted before its
                // children, because a subsurface sits on top of the surface it
                // belongs to. Painting on the way up instead — which is what
                // the post-order callback does — lets a toplevel's mostly
                // transparent shadow frame erase the content beneath it, and
                // produces an empty window from a client that drew everything
                // correctly.
                //
                // Every surface carries subsurface state; for one that is not a
                // subsurface it is the default (0, 0), so no branch is needed.
                let mut sub = states.cached_state.get::<SubsurfaceCachedState>();
                let location = sub.current().location;
                // A subsurface is positioned in *logical* pixels while the
                // canvas is in buffer pixels, so on a HiDPI window every child
                // would land at half its offset — the content drifts up and
                // left of where the application put it.
                let at = (
                    offset.0 + location.x * root_scale,
                    offset.1 + location.y * root_scale,
                );

                if let Some(cache) = states.data_map.get::<RefCell<SurfacePixels>>() {
                    let mut cache = cache.borrow_mut();
                    blit(&mut canvas, width, height, &cache, at.0, at.1);
                    let pending: Vec<Rect> = cache.damage.drain(..).collect();
                    for rect in pending {
                        if let Some(clipped) = translate(rect, at.0, at.1).clip(width, height) {
                            damage.push(clipped);
                        }
                    }
                }

                TraversalAction::DoChildren(at)
            },
            |_, _, _| {},
            |_, _, _| true,
        );

        let Some(rec) = self.windows.get_mut(&window_id) else {
            return;
        };
        let resized = rec.width != width || rec.height != height;
        rec.width = width;
        rec.height = height;
        rec.pixels = canvas;
        if resized {
            // Damage from before a resize describes a buffer that no longer
            // exists; the encoder sends a keyframe for the new size instead.
            rec.damage.clear();
        } else {
            rec.damage.extend(damage);
        }
    }
}

/// Per-surface pixel cache. Every surface in a tree keeps its own last
/// committed contents, because the compositing pass needs all of them at once
/// and a `wl_shm` pool is only readable inside `with_buffer_contents`.
#[derive(Default)]
pub struct SurfacePixels {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    damage: Vec<Rect>,
    /// `wl_surface.set_buffer_scale`: how many buffer pixels the client drew
    /// per logical pixel. Everything cached here is in *buffer* pixels, while
    /// subsurface offsets and surface damage arrive in logical ones, so this is
    /// the conversion between them and 1 for a client that ignores DPI.
    scale: i32,
}

/// Copy a committed `wl_shm` buffer into a surface's cache.
fn absorb(cache: &mut SurfacePixels, buffer: &wl_buffer::WlBuffer) {
    let copied = with_buffer_contents(buffer, |ptr, len, data| {
        let width = data.width.max(0) as usize;
        let height = data.height.max(0) as usize;
        let stride = data.stride.max(0) as usize;
        let offset = data.offset.max(0) as usize;
        if width == 0 || height == 0 || stride < width * 4 {
            return None;
        }
        if offset + stride * height > len {
            return None;
        }
        let opaque = matches!(data.format, wl_shm::Format::Xrgb8888);

        // SAFETY: the pool is mapped for the duration of this callback, and
        // every byte read is bounds-checked against `len` above.
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        let mut out = vec![0u8; width * height * 4];
        for row in 0..height {
            let src = offset + row * stride;
            let dst = row * width * 4;
            out[dst..dst + width * 4].copy_from_slice(&bytes[src..src + width * 4]);
            if opaque {
                // Xrgb8888 leaves the high byte undefined; a client that left
                // it at zero would otherwise arrive fully transparent.
                for px in 0..width {
                    out[dst + px * 4 + 3] = 0xff;
                }
            }
        }
        Some((width as u32, height as u32, out))
    });

    if let Ok(Some((width, height, pixels))) = copied {
        cache.width = width;
        cache.height = height;
        cache.pixels = pixels;
    }
}

/// Draw one surface's pixels into the window canvas at `(ox, oy)`, blended.
///
/// Source-over with premultiplied alpha, which is what `wl_shm`'s `Argb8888`
/// carries. A straight copy would be cheaper but wrong in both directions: a
/// client's rounded corners and shadows would get hard edges, and any surface
/// with a transparent region would punch a hole through whatever it covers.
fn blit(canvas: &mut [u8], canvas_w: u32, canvas_h: u32, src: &SurfacePixels, ox: i32, oy: i32) {
    if src.pixels.is_empty() {
        return;
    }
    for row in 0..src.height {
        let y = oy + row as i32;
        if y < 0 || y >= canvas_h as i32 {
            continue;
        }
        for col in 0..src.width {
            let x = ox + col as i32;
            if x < 0 || x >= canvas_w as i32 {
                continue;
            }
            let from = (row * src.width + col) as usize * 4;
            let to = (y as u32 * canvas_w + x as u32) as usize * 4;
            let alpha = src.pixels[from + 3] as u32;
            if alpha == 255 {
                canvas[to..to + 4].copy_from_slice(&src.pixels[from..from + 4]);
                continue;
            }
            if alpha == 0 {
                continue;
            }
            let inverse = 255 - alpha;
            for channel in 0..4 {
                let source = src.pixels[from + channel] as u32;
                let dest = canvas[to + channel] as u32;
                canvas[to + channel] = (source + dest * inverse / 255).min(255) as u8;
            }
        }
    }
}

fn translate(rect: Rect, ox: i32, oy: i32) -> Rect {
    Rect::new(
        (rect.x as i32 + ox).max(0) as u32,
        (rect.y as i32 + oy).max(0) as u32,
        rect.w,
        rect.h,
    )
}

/// A surface's buffer scale — buffer pixels per logical pixel. 1 for a client
/// that never called `set_buffer_scale`, which is every client on a 1× output.
///
/// Read from the surface rather than from the output because the two can
/// legitimately disagree: an application free to ignore a 2× output renders a
/// 1× buffer, and its coordinates are then already logical.
pub(super) fn surface_scale(surface: &WlSurface) -> i32 {
    with_states(surface, |states| {
        states
            .data_map
            .get::<RefCell<SurfacePixels>>()
            .map(|cache| cache.borrow().scale.max(1))
            .unwrap_or(1)
    })
}

/// The size of a surface's own buffer, which for a toplevel is the window size.
fn surface_size(surface: &WlSurface) -> Option<(u32, u32)> {
    with_states(surface, |states| {
        states
            .data_map
            .get::<RefCell<SurfacePixels>>()
            .map(|cache| {
                let cache = cache.borrow();
                (cache.width, cache.height)
            })
            .filter(|(w, h)| *w > 0 && *h > 0)
    })
}

impl CompositorHandler for AppState {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().unwrap().compositor_state
    }

    fn commit(&mut self, surface: &WlSurface) {
        // Set IWAPPD_DEBUG=1 to trace what clients actually commit. Every
        // "why is the window blank" question is answered here: which surface,
        // what size, and whether its buffer was one we could read.
        let debug = std::env::var_os("IWAPPD_DEBUG").is_some();

        // `wl_compositor` v6 replaced "work it out from the outputs you have
        // entered" with a per-surface preference, and GTK4 and Qt6 both prefer
        // it. A surface that never hears it renders at 1× on a 2× output.
        let scale = self.scale;
        with_states(surface, |states| {
            smithay::wayland::compositor::send_surface_state(
                surface,
                states,
                scale,
                smithay::utils::Transform::Normal,
            );
        });

        // Every surface caches its own pixels, whether it is a toplevel or a
        // child three levels down: the compositing pass needs all of them.
        with_states(surface, |states| {
            states
                .data_map
                .insert_if_missing(|| RefCell::new(SurfacePixels::default()));
            let cache = states
                .data_map
                .get::<RefCell<SurfacePixels>>()
                .expect("just inserted");
            let mut cache = cache.borrow_mut();

            let mut guard = states.cached_state.get::<SurfaceAttributes>();
            let attrs = guard.current();
            cache.scale = attrs.buffer_scale.max(1);
            match attrs.buffer.take() {
                Some(BufferAssignment::NewBuffer(buffer)) => {
                    let before = (cache.width, cache.height);
                    absorb(&mut cache, &buffer);
                    if debug {
                        let shm = with_buffer_contents(&buffer, |_, _, d| {
                            format!(
                                "shm {}x{} stride {} fmt {:?}",
                                d.width, d.height, d.stride, d.format
                            )
                        })
                        .unwrap_or_else(|e| format!("NOT SHM ({e:?})"));
                        let opaque = cache.pixels.chunks_exact(4).filter(|px| px[3] != 0).count();
                        let coloured = cache
                            .pixels
                            .chunks_exact(4)
                            .filter(|px| px[0] != 0 || px[1] != 0 || px[2] != 0)
                            .count();
                        eprintln!(
                            "[commit] surface {} buffer: {shm}; cache {before:?} -> ({}, {}); {opaque} opaque, {coloured} coloured px",
                            surface.id().protocol_id(),
                            cache.width,
                            cache.height
                        );
                    }
                    // The client may reuse the buffer the moment it is
                    // released, which is exactly why we copied.
                    buffer.release();
                }
                Some(BufferAssignment::Removed) => {
                    cache.pixels.clear();
                    cache.width = 0;
                    cache.height = 0;
                }
                None => {}
            }
            // Everything downstream works in buffer pixels. `wl_surface.damage`
            // is in *surface* (logical) coordinates and `damage_buffer` is
            // already in buffer ones — identical at scale 1, off by a factor of
            // the scale on a HiDPI client, which shows up as a window that
            // repaints a quarter of what it should.
            let scale = cache.scale;
            let fresh: Vec<Rect> = attrs
                .damage
                .drain(..)
                .map(|damage| match damage {
                    Damage::Buffer(rect) => {
                        rect_from(rect.loc.x, rect.loc.y, rect.size.w, rect.size.h)
                    }
                    Damage::Surface(rect) => rect_from(
                        rect.loc.x * scale,
                        rect.loc.y * scale,
                        rect.size.w * scale,
                        rect.size.h * scale,
                    ),
                })
                .collect();
            cache.damage.extend(fresh);
        });

        // Walk up to the toplevel this surface belongs to: a subsurface commit
        // is a change to its window, not to itself.
        let mut root = surface.clone();
        while let Some(parent) = get_parent(&root) {
            root = parent;
        }
        let Some(window_id) = self.window_id_for(&root) else {
            return;
        };

        if debug {
            let mut surfaces = 0usize;
            let mut drawn = 0usize;
            with_surface_tree_downward(
                &root,
                (),
                |_, _, _| TraversalAction::DoChildren(()),
                |_, states, _| {
                    surfaces += 1;
                    if let Some(cache) = states.data_map.get::<RefCell<SurfacePixels>>()
                        && !cache.borrow().pixels.is_empty()
                    {
                        drawn += 1;
                    }
                },
                |_, _, _| true,
            );
            eprintln!("[tree] window {window_id}: {surfaces} surface(s), {drawn} with pixels");
        }

        self.composite(window_id);

        let first_content = self
            .windows
            .get(&window_id)
            .is_some_and(|rec| !rec.mapped && !rec.pixels.is_empty());
        if first_content {
            // Tell the client its surface is on our output. Without this the
            // window belongs to no output at all, which some clients — Firefox
            // among them — read as "not visible" and stop painting entirely.
            self.output.enter(&root);
            let opened = {
                let rec = self.windows.get_mut(&window_id).expect("checked above");
                rec.mapped = true;
                BackendEvent::WindowOpened {
                    window_id,
                    app_id: rec.app_id.clone(),
                    title: rec.title.clone(),
                    width: rec.width,
                    height: rec.height,
                    parent_window_id: rec.parent,
                }
            };
            self.events.push_back(opened);
        }

        // A title or app id change only means something once the client knows
        // the window exists at all.
        let meta = self
            .windows
            .get_mut(&window_id)
            .and_then(|rec| rec.mapped.then(|| rec.take_meta(&root)).flatten());
        if let Some((title, app_id)) = meta
            && !first_content
        {
            self.events.push_back(BackendEvent::WindowMeta {
                window_id,
                title,
                app_id,
            });
        }

        if self.windows.get(&window_id).is_some_and(|r| r.mapped) {
            let damage = self
                .windows
                .get_mut(&window_id)
                .map(|r| std::mem::take(&mut r.damage))
                .unwrap_or_default();
            self.events
                .push_back(BackendEvent::WindowDamaged { window_id, damage });
        }
    }
}

fn rect_from(x: i32, y: i32, w: i32, h: i32) -> Rect {
    Rect::new(
        x.max(0) as u32,
        y.max(0) as u32,
        w.max(0) as u32,
        h.max(0) as u32,
    )
}

/// Tell every surface in a tree that its frame reached a screen.
///
/// We send these when the frame is actually consumed rather than when it is
/// committed, which paces a client to the rate we can encode and ship instead
/// of letting it render frames nobody will ever see.
pub fn send_frame_callbacks(surface: &WlSurface, time: u32) {
    with_surface_tree_downward(
        surface,
        (),
        |_, _, &()| TraversalAction::DoChildren(()),
        |_, states, &()| {
            for callback in states
                .cached_state
                .get::<SurfaceAttributes>()
                .current()
                .frame_callbacks
                .drain(..)
            {
                callback.done(time);
            }
        },
        |_, _, &()| true,
    );
}

impl XdgShellHandler for AppState {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        let window_id = self.next_window_id;
        self.next_window_id += 1;

        let parent = surface
            .parent()
            .and_then(|parent| self.window_id_for(&parent));

        surface.with_pending_state(|state| {
            state.states.set(xdg_toplevel::State::Activated);
            // No maximise, no fullscreen, no tiling: the tab decides the size,
            // and telling the client otherwise invites it to draw chrome we do
            // not want.
        });
        surface.send_configure();

        let wl_surface = surface.wl_surface().clone();
        self.windows.insert(
            window_id,
            WindowRec {
                toplevel: surface,
                surface: wl_surface,
                title: String::new(),
                app_id: None,
                parent,
                width: 0,
                height: 0,
                pixels: Vec::new(),
                damage: Vec::new(),
                mapped: false,
            },
        );
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        let Some((window_id, _)) = self
            .windows
            .iter()
            .find(|(_, rec)| rec.toplevel == surface)
            .map(|(id, rec)| (*id, rec.mapped))
        else {
            return;
        };
        let was_mapped = self.windows.remove(&window_id).is_some_and(|r| r.mapped);
        if was_mapped {
            self.events.push_back(BackendEvent::WindowClosed {
                window_id,
                crashed: false,
            });
        }
    }

    fn new_popup(&mut self, _surface: PopupSurface, _positioner: PositionerState) {
        // Popups render into their parent's frame rather than becoming windows
        // of their own — a menu must never open a workspace tab. Compositing
        // them is the next piece of work; until then they simply do not draw.
    }

    fn grab(&mut self, _surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {}

    fn reposition_request(
        &mut self,
        _surface: PopupSurface,
        _positioner: PositionerState,
        _token: u32,
    ) {
    }
}

impl XdgDecorationHandler for AppState {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        // Server-side, always. We draw no decoration at all: the workspace tab
        // is the titlebar, and a client-drawn one would put a second one
        // inside the canvas.
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(zxdg_toplevel_decoration_v1::Mode::ServerSide);
        });
        toplevel.send_configure();
    }

    fn request_mode(
        &mut self,
        toplevel: ToplevelSurface,
        _mode: zxdg_toplevel_decoration_v1::Mode,
    ) {
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(zxdg_toplevel_decoration_v1::Mode::ServerSide);
        });
        toplevel.send_configure();
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(zxdg_toplevel_decoration_v1::Mode::ServerSide);
        });
        toplevel.send_configure();
    }
}

impl BufferHandler for AppState {
    fn buffer_destroyed(&mut self, _buffer: &wl_buffer::WlBuffer) {}
}

impl ShmHandler for AppState {
    fn shm_state(&self) -> &ShmState {
        &self.shm
    }
}

impl SeatHandler for AppState {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Self> {
        &mut self.seat_state
    }

    fn focus_changed(&mut self, _seat: &Seat<Self>, _focused: Option<&WlSurface>) {}

    fn cursor_image(
        &mut self,
        _seat: &Seat<Self>,
        image: smithay::input::pointer::CursorImageStatus,
    ) {
        // Named shapes travel as a string the viewer maps to a CSS cursor;
        // a surface cursor is drawn by the app into a surface we do not
        // composite yet, so it reports as the default rather than vanishing.
        let shape = match image {
            smithay::input::pointer::CursorImageStatus::Hidden => Some("none".to_owned()),
            smithay::input::pointer::CursorImageStatus::Named(shape) => {
                Some(shape.name().to_owned())
            }
            smithay::input::pointer::CursorImageStatus::Surface(_) => Some("default".to_owned()),
        };
        self.events.push_back(BackendEvent::CursorChanged {
            window_id: 0,
            shape,
        });
    }
}

impl SelectionHandler for AppState {
    type SelectionUserData = ();
}

impl DataDeviceHandler for AppState {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device
    }
}

impl ClientDndGrabHandler for AppState {}
impl ServerDndGrabHandler for AppState {
    fn send(&mut self, _mime_type: String, _fd: OwnedFd, _seat: Seat<Self>) {}
}

impl smithay::wayland::output::OutputHandler for AppState {}

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}

delegate_compositor!(AppState);
delegate_xdg_shell!(AppState);
delegate_xdg_decoration!(AppState);
delegate_shm!(AppState);
delegate_seat!(AppState);
delegate_data_device!(AppState);
delegate_output!(AppState);
