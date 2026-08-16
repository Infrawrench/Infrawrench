//! Packed input events.
//!
//! Input is the one direction where latency is felt directly, so a batch is a
//! compact binary blob rather than JSON: a mouse drag at 120 Hz is a hundred
//! motion events a second, and each one costs 13 bytes here against ~60 as
//! JSON. Coordinates are Wayland's 24.8 fixed point so sub-pixel motion and
//! fractional scaling survive the trip.

use crate::ProtocolError;

/// Whether a button or key went down or up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonState {
    Released = 0,
    Pressed = 1,
}

impl ButtonState {
    fn from_u8(v: u8) -> Self {
        if v == 0 {
            Self::Released
        } else {
            Self::Pressed
        }
    }
}

/// evdev button codes, which are what `wl_pointer` speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointerButton(pub u32);

impl PointerButton {
    pub const LEFT: Self = Self(0x110);
    pub const RIGHT: Self = Self(0x111);
    pub const MIDDLE: Self = Self(0x112);
    pub const SIDE: Self = Self(0x113);
    pub const EXTRA: Self = Self(0x114);

    /// Map a DOM `MouseEvent.button` to its evdev code. The DOM's middle and
    /// right are swapped relative to evdev's numbering, which is exactly the
    /// kind of thing that silently ships as "paste does nothing".
    pub fn from_dom(button: u16) -> Option<Self> {
        Some(match button {
            0 => Self::LEFT,
            1 => Self::MIDDLE,
            2 => Self::RIGHT,
            3 => Self::SIDE,
            4 => Self::EXTRA,
            _ => return None,
        })
    }
}

/// A single input event, already translated out of DOM terms by the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputEvent {
    /// evdev keycode (XKB keycode minus 8) against the keymap we handed the
    /// client at attach time.
    Key {
        time_ms: u32,
        keycode: u32,
        state: ButtonState,
    },
    /// A keysym the current layout cannot reach with a plain keycode — dead
    /// keys, IME output, anything composed. The compositor binds a spare
    /// keycode to it, presses it, and restores the keymap.
    KeySym {
        time_ms: u32,
        keysym: u32,
        state: ButtonState,
    },
    /// Surface-local pointer position in 24.8 fixed point.
    PointerMotion {
        time_ms: u32,
        x: i32,
        y: i32,
    },
    PointerButton {
        time_ms: u32,
        button: PointerButton,
        state: ButtonState,
    },
    /// Scroll delta in 24.8 fixed point, already normalised to Wayland's
    /// "10 units per notch" convention by the client.
    PointerAxis {
        time_ms: u32,
        dx: i32,
        dy: i32,
    },
    /// The pointer left the window (tab blurred, cursor left the canvas).
    PointerLeave {
        time_ms: u32,
    },
    TouchDown {
        time_ms: u32,
        id: i32,
        x: i32,
        y: i32,
    },
    TouchMotion {
        time_ms: u32,
        id: i32,
        x: i32,
        y: i32,
    },
    TouchUp {
        time_ms: u32,
        id: i32,
    },
}

const KEY: u8 = 1;
const KEYSYM: u8 = 2;
const MOTION: u8 = 3;
const BUTTON: u8 = 4;
const AXIS: u8 = 5;
const LEAVE: u8 = 6;
const TOUCH_DOWN: u8 = 7;
const TOUCH_MOTION: u8 = 8;
const TOUCH_UP: u8 = 9;

/// Convert whole pixels to Wayland's 24.8 fixed point.
pub const fn fixed_from_px(px: i32) -> i32 {
    px * 256
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put_i32(out: &mut Vec<u8>, v: i32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Pack a batch of events into an [`crate::FrameKind::Input`] payload.
pub fn encode_input_batch(events: &[InputEvent]) -> Vec<u8> {
    let mut out = Vec::with_capacity(events.len() * 16);
    for event in events {
        match *event {
            InputEvent::Key {
                time_ms,
                keycode,
                state,
            } => {
                out.push(KEY);
                put_u32(&mut out, time_ms);
                put_u32(&mut out, keycode);
                out.push(state as u8);
            }
            InputEvent::KeySym {
                time_ms,
                keysym,
                state,
            } => {
                out.push(KEYSYM);
                put_u32(&mut out, time_ms);
                put_u32(&mut out, keysym);
                out.push(state as u8);
            }
            InputEvent::PointerMotion { time_ms, x, y } => {
                out.push(MOTION);
                put_u32(&mut out, time_ms);
                put_i32(&mut out, x);
                put_i32(&mut out, y);
            }
            InputEvent::PointerButton {
                time_ms,
                button,
                state,
            } => {
                out.push(BUTTON);
                put_u32(&mut out, time_ms);
                put_u32(&mut out, button.0);
                out.push(state as u8);
            }
            InputEvent::PointerAxis { time_ms, dx, dy } => {
                out.push(AXIS);
                put_u32(&mut out, time_ms);
                put_i32(&mut out, dx);
                put_i32(&mut out, dy);
            }
            InputEvent::PointerLeave { time_ms } => {
                out.push(LEAVE);
                put_u32(&mut out, time_ms);
            }
            InputEvent::TouchDown { time_ms, id, x, y } => {
                out.push(TOUCH_DOWN);
                put_u32(&mut out, time_ms);
                put_i32(&mut out, id);
                put_i32(&mut out, x);
                put_i32(&mut out, y);
            }
            InputEvent::TouchMotion { time_ms, id, x, y } => {
                out.push(TOUCH_MOTION);
                put_u32(&mut out, time_ms);
                put_i32(&mut out, id);
                put_i32(&mut out, x);
                put_i32(&mut out, y);
            }
            InputEvent::TouchUp { time_ms, id } => {
                out.push(TOUCH_UP);
                put_u32(&mut out, time_ms);
                put_i32(&mut out, id);
            }
        }
    }
    out
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ProtocolError> {
        if self.at + n > self.bytes.len() {
            return Err(ProtocolError::Truncated {
                expected: self.at + n,
                actual: self.bytes.len(),
            });
        }
        let slice = &self.bytes[self.at..self.at + n];
        self.at += n;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, ProtocolError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, ProtocolError> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }

    fn i32(&mut self) -> Result<i32, ProtocolError> {
        Ok(i32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }
}

/// Unpack an [`crate::FrameKind::Input`] payload.
pub fn decode_input_batch(payload: &[u8]) -> Result<Vec<InputEvent>, ProtocolError> {
    let mut r = Reader {
        bytes: payload,
        at: 0,
    };
    let mut events = Vec::new();
    while r.at < payload.len() {
        let kind = r.u8()?;
        let time_ms = r.u32()?;
        events.push(match kind {
            KEY => InputEvent::Key {
                time_ms,
                keycode: r.u32()?,
                state: ButtonState::from_u8(r.u8()?),
            },
            KEYSYM => InputEvent::KeySym {
                time_ms,
                keysym: r.u32()?,
                state: ButtonState::from_u8(r.u8()?),
            },
            MOTION => InputEvent::PointerMotion {
                time_ms,
                x: r.i32()?,
                y: r.i32()?,
            },
            BUTTON => InputEvent::PointerButton {
                time_ms,
                button: PointerButton(r.u32()?),
                state: ButtonState::from_u8(r.u8()?),
            },
            AXIS => InputEvent::PointerAxis {
                time_ms,
                dx: r.i32()?,
                dy: r.i32()?,
            },
            LEAVE => InputEvent::PointerLeave { time_ms },
            TOUCH_DOWN => InputEvent::TouchDown {
                time_ms,
                id: r.i32()?,
                x: r.i32()?,
                y: r.i32()?,
            },
            TOUCH_MOTION => InputEvent::TouchMotion {
                time_ms,
                id: r.i32()?,
                x: r.i32()?,
                y: r.i32()?,
            },
            TOUCH_UP => InputEvent::TouchUp {
                time_ms,
                id: r.i32()?,
            },
            other => return Err(ProtocolError::UnknownInputEvent(other)),
        });
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<InputEvent> {
        vec![
            InputEvent::Key {
                time_ms: 12,
                keycode: 30,
                state: ButtonState::Pressed,
            },
            InputEvent::Key {
                time_ms: 40,
                keycode: 30,
                state: ButtonState::Released,
            },
            InputEvent::KeySym {
                time_ms: 41,
                keysym: 0x00e9, // é, unreachable on a us layout
                state: ButtonState::Pressed,
            },
            InputEvent::PointerMotion {
                time_ms: 50,
                x: fixed_from_px(320),
                y: fixed_from_px(-12),
            },
            InputEvent::PointerButton {
                time_ms: 51,
                button: PointerButton::RIGHT,
                state: ButtonState::Pressed,
            },
            InputEvent::PointerAxis {
                time_ms: 52,
                dx: 0,
                dy: fixed_from_px(10),
            },
            InputEvent::PointerLeave { time_ms: 53 },
            InputEvent::TouchDown {
                time_ms: 54,
                id: 1,
                x: fixed_from_px(4),
                y: fixed_from_px(5),
            },
            InputEvent::TouchMotion {
                time_ms: 55,
                id: 1,
                x: fixed_from_px(6),
                y: fixed_from_px(7),
            },
            InputEvent::TouchUp { time_ms: 56, id: 1 },
        ]
    }

    #[test]
    fn round_trips_every_event_kind() {
        let events = sample();
        let decoded = decode_input_batch(&encode_input_batch(&events)).unwrap();
        assert_eq!(decoded, events);
    }

    #[test]
    fn a_motion_event_costs_thirteen_bytes() {
        let bytes = encode_input_batch(&[InputEvent::PointerMotion {
            time_ms: 1,
            x: 2,
            y: 3,
        }]);
        assert_eq!(bytes.len(), 13);
    }

    #[test]
    fn dom_buttons_map_to_evdev_not_dom_order() {
        assert_eq!(PointerButton::from_dom(0), Some(PointerButton::LEFT));
        assert_eq!(PointerButton::from_dom(1), Some(PointerButton::MIDDLE));
        assert_eq!(PointerButton::from_dom(2), Some(PointerButton::RIGHT));
        assert_eq!(PointerButton::from_dom(9), None);
    }

    #[test]
    fn rejects_a_truncated_batch() {
        let mut bytes = encode_input_batch(&sample());
        bytes.truncate(bytes.len() - 1);
        assert!(matches!(
            decode_input_batch(&bytes),
            Err(ProtocolError::Truncated { .. })
        ));
    }

    #[test]
    fn rejects_an_unknown_event_kind() {
        assert!(matches!(
            decode_input_batch(&[200, 0, 0, 0, 0]),
            Err(ProtocolError::UnknownInputEvent(200))
        ));
    }
}
