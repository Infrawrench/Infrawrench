/**
 * Input: packing for the wire, and the translation from DOM events into what
 * Wayland expects.
 *
 * Two conventions matter and neither is obvious. Keyboard events travel as
 * **evdev keycodes**, which are a property of the physical key and have
 * nothing to do with the character it produces — the host's keymap does that.
 * And coordinates travel as Wayland's **24.8 fixed point**, so sub-pixel
 * motion and fractional scaling survive the trip.
 */

export const ButtonState = { Released: 0, Pressed: 1 } as const;
export type ButtonState = (typeof ButtonState)[keyof typeof ButtonState];

/** evdev button codes, which are what `wl_pointer` speaks. */
export const PointerButton = {
  Left: 0x110,
  Right: 0x111,
  Middle: 0x112,
  Side: 0x113,
  Extra: 0x114,
} as const;

/**
 * The DOM numbers mouse buttons in a different order from evdev — middle and
 * right are swapped — which is the kind of thing that ships as "paste does
 * nothing on Linux".
 */
export function pointerButtonFromDom(button: number): number | undefined {
  switch (button) {
    case 0:
      return PointerButton.Left;
    case 1:
      return PointerButton.Middle;
    case 2:
      return PointerButton.Right;
    case 3:
      return PointerButton.Side;
    case 4:
      return PointerButton.Extra;
    default:
      return undefined;
  }
}

export type InputEvent =
  | { kind: "key"; timeMs: number; keycode: number; state: ButtonState }
  | { kind: "keysym"; timeMs: number; keysym: number; state: ButtonState }
  | { kind: "pointerMotion"; timeMs: number; x: number; y: number }
  | { kind: "pointerButton"; timeMs: number; button: number; state: ButtonState }
  | { kind: "pointerAxis"; timeMs: number; dx: number; dy: number }
  | { kind: "pointerLeave"; timeMs: number }
  | { kind: "touchDown"; timeMs: number; id: number; x: number; y: number }
  | { kind: "touchMotion"; timeMs: number; id: number; x: number; y: number }
  | { kind: "touchUp"; timeMs: number; id: number };

const KEY = 1;
const KEYSYM = 2;
const MOTION = 3;
const BUTTON = 4;
const AXIS = 5;
const LEAVE = 6;
const TOUCH_DOWN = 7;
const TOUCH_MOTION = 8;
const TOUCH_UP = 9;

/** Whole pixels to Wayland's 24.8 fixed point. */
export function fixedFromPx(px: number): number {
  return Math.round(px * 256);
}

export function pxFromFixed(fixed: number): number {
  return fixed / 256;
}

function sizeOf(event: InputEvent): number {
  switch (event.kind) {
    case "key":
    case "keysym":
    case "pointerButton":
      return 10;
    case "pointerMotion":
    case "pointerAxis":
      return 13;
    case "pointerLeave":
      return 5;
    case "touchDown":
    case "touchMotion":
      return 17;
    case "touchUp":
      return 9;
  }
}

export function encodeInputBatch(events: InputEvent[]): Uint8Array {
  const out = new Uint8Array(events.reduce((total, event) => total + sizeOf(event), 0));
  const view = new DataView(out.buffer);
  let at = 0;

  const header = (tag: number, timeMs: number) => {
    out[at] = tag;
    view.setUint32(at + 1, timeMs >>> 0, true);
    at += 5;
  };

  for (const event of events) {
    switch (event.kind) {
      case "key":
        header(KEY, event.timeMs);
        view.setUint32(at, event.keycode, true);
        out[at + 4] = event.state;
        at += 5;
        break;
      case "keysym":
        header(KEYSYM, event.timeMs);
        view.setUint32(at, event.keysym, true);
        out[at + 4] = event.state;
        at += 5;
        break;
      case "pointerMotion":
        header(MOTION, event.timeMs);
        view.setInt32(at, event.x, true);
        view.setInt32(at + 4, event.y, true);
        at += 8;
        break;
      case "pointerButton":
        header(BUTTON, event.timeMs);
        view.setUint32(at, event.button, true);
        out[at + 4] = event.state;
        at += 5;
        break;
      case "pointerAxis":
        header(AXIS, event.timeMs);
        view.setInt32(at, event.dx, true);
        view.setInt32(at + 4, event.dy, true);
        at += 8;
        break;
      case "pointerLeave":
        header(LEAVE, event.timeMs);
        break;
      case "touchDown":
      case "touchMotion":
        header(event.kind === "touchDown" ? TOUCH_DOWN : TOUCH_MOTION, event.timeMs);
        view.setInt32(at, event.id, true);
        view.setInt32(at + 4, event.x, true);
        view.setInt32(at + 8, event.y, true);
        at += 12;
        break;
      case "touchUp":
        header(TOUCH_UP, event.timeMs);
        view.setInt32(at, event.id, true);
        at += 4;
        break;
    }
  }
  return out;
}

export function decodeInputBatch(payload: Uint8Array): InputEvent[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const events: InputEvent[] = [];
  let at = 0;

  const need = (bytes: number) => {
    if (at + bytes > payload.length) {
      throw new Error(`truncated input batch: expected ${at + bytes} bytes, got ${payload.length}`);
    }
  };

  while (at < payload.length) {
    need(5);
    const tag = payload[at]!;
    const timeMs = view.getUint32(at + 1, true);
    at += 5;
    switch (tag) {
      case KEY:
      case KEYSYM: {
        need(5);
        const value = view.getUint32(at, true);
        const state = (payload[at + 4] ? 1 : 0) as ButtonState;
        at += 5;
        events.push(
          tag === KEY
            ? { kind: "key", timeMs, keycode: value, state }
            : { kind: "keysym", timeMs, keysym: value, state },
        );
        break;
      }
      case MOTION:
      case AXIS: {
        need(8);
        const a = view.getInt32(at, true);
        const b = view.getInt32(at + 4, true);
        at += 8;
        events.push(
          tag === MOTION
            ? { kind: "pointerMotion", timeMs, x: a, y: b }
            : { kind: "pointerAxis", timeMs, dx: a, dy: b },
        );
        break;
      }
      case BUTTON: {
        need(5);
        const button = view.getUint32(at, true);
        const state = (payload[at + 4] ? 1 : 0) as ButtonState;
        at += 5;
        events.push({ kind: "pointerButton", timeMs, button, state });
        break;
      }
      case LEAVE:
        events.push({ kind: "pointerLeave", timeMs });
        break;
      case TOUCH_DOWN:
      case TOUCH_MOTION: {
        need(12);
        const id = view.getInt32(at, true);
        const x = view.getInt32(at + 4, true);
        const y = view.getInt32(at + 8, true);
        at += 12;
        events.push({
          kind: tag === TOUCH_DOWN ? "touchDown" : "touchMotion",
          timeMs,
          id,
          x,
          y,
        });
        break;
      }
      case TOUCH_UP: {
        need(4);
        const id = view.getInt32(at, true);
        at += 4;
        events.push({ kind: "touchUp", timeMs, id });
        break;
      }
      default:
        throw new Error(`invalid input event kind ${tag}`);
    }
  }
  return events;
}

/**
 * `KeyboardEvent.code` → evdev keycode.
 *
 * Keyed by physical position, which is the whole point: the host resolves the
 * character through its own keymap, so a Dvorak user pressing the key labelled
 * `S` sends the same code as a QWERTY user pressing the key in that position
 * and each gets the letter they expect.
 */
const EVDEV_BY_CODE: Readonly<Record<string, number>> = {
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad0: 82,
  NumpadDecimal: 83,
  IntlBackslash: 86,
  F11: 87,
  F12: 88,
  IntlRo: 89,
  Convert: 92,
  KanaMode: 93,
  NonConvert: 94,
  NumpadEnter: 96,
  ControlRight: 97,
  NumpadDivide: 98,
  PrintScreen: 99,
  AltRight: 100,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  AudioVolumeMute: 113,
  AudioVolumeDown: 114,
  AudioVolumeUp: 115,
  Pause: 119,
  IntlYen: 124,
  MetaLeft: 125,
  MetaRight: 126,
  ContextMenu: 127,
};

/** The evdev keycode for a `KeyboardEvent.code`, if we know one. */
export function evdevFromCode(code: string): number | undefined {
  return EVDEV_BY_CODE[code];
}

/**
 * Convert a DOM wheel event to a Wayland axis delta in 24.8 fixed point.
 *
 * Wayland's convention is ten units per notch. Browsers report wheels in three
 * different units depending on `deltaMode`, and a trackpad reports continuous
 * pixels — so everything is normalised to notches first, and a pixel-mode
 * delta is divided by the ~100px a notch conventionally scrolls.
 */
export function axisFromWheel(event: { deltaX: number; deltaY: number; deltaMode?: number }): {
  dx: number;
  dy: number;
} {
  const perNotch = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100;
  return {
    dx: fixedFromPx((event.deltaX / perNotch) * 10),
    dy: fixedFromPx((event.deltaY / perNotch) * 10),
  };
}

/**
 * Canvas-relative CSS coordinates to buffer pixels in fixed point.
 *
 * The window is rendered at `scale` device pixels per CSS pixel, and the
 * compositor addresses the buffer, so a pointer position that skips this
 * conversion is off by the device pixel ratio on every retina screen.
 */
export function pointerPosition(
  offsetX: number,
  offsetY: number,
  scale: number,
): { x: number; y: number } {
  return { x: fixedFromPx(offsetX * scale), y: fixedFromPx(offsetY * scale) };
}
