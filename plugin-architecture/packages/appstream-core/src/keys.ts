/**
 * Turning a browser's key events into what a US-keymapped host will accept.
 *
 * The host's keymap is `us` and cannot be the user's own — the browser will not
 * say what layout is in use, and there is no protocol for asking. Forwarding
 * physical key positions is therefore right only for a user who is already on
 * US QWERTY: on any other layout the host resolves the position through the
 * wrong table, and a UK user gets `@` where they typed `"`.
 *
 * So the character is the thing to preserve, not the position. `KeyboardEvent`
 * hands us both — `code` is the key that moved, `key` is what the user's own
 * layout made of it — and this translates the second into whichever US key
 * produces it, synthesising Shift where the two layouts disagree about it. What
 * no US key can produce at all (`£`, `é`, `¬`) goes as a keysym, which the host
 * binds to a spare keycode.
 *
 * The whole thing is a pure function of the event plus a little state, so every
 * layout's worth of awkward cases is a unit test rather than a VM.
 */

import { ButtonState, evdevFromCode, type InputEvent } from "./input.js";

/** The evdev codes for the two Shift keys, which is what gets synthesised. */
const SHIFT_LEFT = 42;

/**
 * What a US layout produces from each printable key, unshifted and shifted.
 *
 * Only the keys whose character depends on the layout: letters, digits and
 * punctuation. Everything else — Enter, the arrows, the function keys — means
 * the same thing everywhere and travels by position.
 */
const US_LAYOUT: Readonly<Record<string, readonly [string, string]>> = {
  Backquote: ["`", "~"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  KeyQ: ["q", "Q"],
  KeyW: ["w", "W"],
  KeyE: ["e", "E"],
  KeyR: ["r", "R"],
  KeyT: ["t", "T"],
  KeyY: ["y", "Y"],
  KeyU: ["u", "U"],
  KeyI: ["i", "I"],
  KeyO: ["o", "O"],
  KeyP: ["p", "P"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  KeyA: ["a", "A"],
  KeyS: ["s", "S"],
  KeyD: ["d", "D"],
  KeyF: ["f", "F"],
  KeyG: ["g", "G"],
  KeyH: ["h", "H"],
  KeyJ: ["j", "J"],
  KeyK: ["k", "K"],
  KeyL: ["l", "L"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  KeyZ: ["z", "Z"],
  KeyX: ["x", "X"],
  KeyC: ["c", "C"],
  KeyV: ["v", "V"],
  KeyB: ["b", "B"],
  KeyN: ["n", "N"],
  KeyM: ["m", "M"],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Space: [" ", " "],
};

/** Character → the US key that produces it, and whether Shift is needed. */
const US_BY_CHARACTER: Readonly<Record<string, { code: string; shift: boolean }>> = (() => {
  const index: Record<string, { code: string; shift: boolean }> = {};
  for (const [code, [plain, shifted]] of Object.entries(US_LAYOUT)) {
    index[plain] ??= { code, shift: false };
    index[shifted] ??= { code, shift: true };
  }
  return index;
})();

/**
 * The X11 keysym for a character.
 *
 * Latin-1 is the identity — a historical accident this protocol inherits from
 * X — and everything else is the codepoint with the Unicode flag on top.
 */
export function keysymFromCharacter(character: string): number | undefined {
  const codepoint = character.codePointAt(0);
  if (codepoint === undefined) return undefined;
  if (codepoint >= 0x20 && codepoint <= 0x7e) return codepoint;
  if (codepoint >= 0xa0 && codepoint <= 0xff) return codepoint;
  return 0x0100_0000 + codepoint;
}

/** The parts of a `KeyboardEvent` this needs, so a test need not build one. */
export interface KeyLike {
  code: string;
  key: string;
  shiftKey: boolean;
  getModifierState?(key: string): boolean;
}

/**
 * Translates key events for one focused window.
 *
 * Stateful for one reason: a key press may go out as a *different* key than the
 * one the user pressed, and the release has to match it. It also remembers what
 * is down, so a window that loses focus can let go of everything.
 */
export class KeyTranslator {
  /** Physical `code` → the evdev keycode actually sent for it. */
  #sent = new Map<string, number>();

  /** Everything currently held, for `releaseAll`. */
  get held(): number[] {
    return [...this.#sent.values()];
  }

  press(event: KeyLike, timeMs: number): InputEvent[] {
    // A key that is already down is the browser's auto-repeat, or a keyup we
    // never saw. Either way the host already believes it is held.
    if (this.#sent.has(event.code)) return [];

    const position = evdevFromCode(event.code);
    const character = printable(event.key) ? event.key : undefined;

    // Not a character at all — Enter, an arrow, a modifier. Position is the
    // right answer and every layout agrees on it.
    if (!character) {
      if (position === undefined) return [];
      this.#sent.set(event.code, position);
      return [{ kind: "key", timeMs, keycode: position, state: ButtonState.Pressed }];
    }

    const target = US_BY_CHARACTER[character];
    if (!target) {
      // No US key produces this. £, é, ¬ — the host binds a spare keycode to
      // the keysym and presses that. Nothing is recorded as held: the host
      // taps it rather than holding it.
      const keysym = keysymFromCharacter(character);
      if (keysym === undefined) return [];
      return [
        { kind: "keysym", timeMs, keysym, state: ButtonState.Pressed },
        { kind: "keysym", timeMs, keysym, state: ButtonState.Released },
      ];
    }

    const keycode = evdevFromCode(target.code);
    if (keycode === undefined) return [];

    // Caps Lock is already reflected in `event.key`, and the host's own Caps
    // Lock will apply again on top — so for letters the two cancel and the
    // shift we need is the opposite of the one the character implies.
    const caps = event.getModifierState?.("CapsLock") ?? false;
    const needsShift = caps && isLetter(character) ? !target.shift : target.shift;

    const events: InputEvent[] = [];
    // Bring the host's shift state to what this key needs, press, and put it
    // back. Restoring immediately rather than on release is deliberate: the
    // character is decided when the key goes down, and the user may let go of
    // Shift while still holding the key.
    if (needsShift && !event.shiftKey) {
      events.push({ kind: "key", timeMs, keycode: SHIFT_LEFT, state: ButtonState.Pressed });
    } else if (!needsShift && event.shiftKey) {
      events.push({ kind: "key", timeMs, keycode: SHIFT_LEFT, state: ButtonState.Released });
    }

    events.push({ kind: "key", timeMs, keycode, state: ButtonState.Pressed });

    if (needsShift && !event.shiftKey) {
      events.push({ kind: "key", timeMs, keycode: SHIFT_LEFT, state: ButtonState.Released });
    } else if (!needsShift && event.shiftKey) {
      events.push({ kind: "key", timeMs, keycode: SHIFT_LEFT, state: ButtonState.Pressed });
    }

    this.#sent.set(event.code, keycode);
    return events;
  }

  release(event: KeyLike, timeMs: number): InputEvent[] {
    const keycode = this.#sent.get(event.code);
    if (keycode === undefined) return [];
    this.#sent.delete(event.code);
    return [{ kind: "key", timeMs, keycode, state: ButtonState.Released }];
  }

  /**
   * Let go of everything.
   *
   * A key held when the window loses focus never gets its release — that goes
   * to whatever has focus now — and the application would repeat it forever.
   */
  releaseAll(timeMs: number): InputEvent[] {
    const events: InputEvent[] = [...this.#sent.values()].map((keycode) => ({
      kind: "key" as const,
      timeMs,
      keycode,
      state: ButtonState.Released,
    }));
    this.#sent.clear();
    return events;
  }
}

/** One character the user meant to type, rather than a name like "Enter". */
function printable(key: string): boolean {
  return [...key].length === 1;
}

function isLetter(character: string): boolean {
  return character.toLowerCase() !== character.toUpperCase();
}
