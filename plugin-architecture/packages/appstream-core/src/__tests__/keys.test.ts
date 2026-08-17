import { describe, expect, it } from "vitest";

import { ButtonState, type InputEvent } from "../input.js";
import { KeyTranslator, keysymFromCharacter } from "../keys.js";

/** A keydown as the browser would report it. */
const down = (code: string, key: string, shiftKey = false, caps = false) => ({
  code,
  key,
  shiftKey,
  getModifierState: (name: string) => (name === "CapsLock" ? caps : false),
});

/** Just the evdev codes and states, which is what the host acts on. */
const shape = (events: InputEvent[]) =>
  events.map((e) =>
    e.kind === "key"
      ? `${e.state === ButtonState.Pressed ? "+" : "-"}${e.keycode}`
      : e.kind === "keysym"
        ? `${e.state === ButtonState.Pressed ? "+" : "-"}sym:${e.keysym}`
        : e.kind,
  );

const KEY_A = 30;
const DIGIT_2 = 3;
const QUOTE = 40;
const SHIFT = 42;

describe("a US keyboard", () => {
  it("sends the key that was pressed, with nothing synthesised", () => {
    // The case that must not regress: for the layout the host is keyed to,
    // this has to be exactly what forwarding the position always did.
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("KeyA", "a"), 0))).toEqual([`+${KEY_A}`]);
    expect(shape(keys.release(down("KeyA", "a"), 1))).toEqual([`-${KEY_A}`]);
  });

  it("leaves a shifted character alone when the user is already holding Shift", () => {
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("Digit2", "@", true), 0))).toEqual([`+${DIGIT_2}`]);
  });
});

describe("a UK keyboard", () => {
  it('types " where the user pressed it, not @', () => {
    // UK Shift+2 is `"`; US Shift+2 is `@`. Forwarding the position gives the
    // user the wrong character on the most-used punctuation there is.
    const keys = new KeyTranslator();
    // `"` is Shift+Quote on US, and the user is already holding Shift.
    expect(shape(keys.press(down("Digit2", '"', true), 0))).toEqual([`+${QUOTE}`]);
  });

  it("types @ from the key that carries it", () => {
    // UK Shift+' is `@`; US wants Shift+2.
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("Quote", "@", true), 0))).toEqual([`+${DIGIT_2}`]);
  });

  it("releases whatever it actually pressed", () => {
    // The release has to name the substituted key, not the physical one, or
    // the application is left holding a key nobody pressed.
    const keys = new KeyTranslator();
    keys.press(down("Quote", "@", true), 0);
    expect(shape(keys.release(down("Quote", "@", true), 1))).toEqual([`-${DIGIT_2}`]);
  });

  it("reaches £ as a keysym, because no US key produces it", () => {
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("Digit3", "£", true), 0))).toEqual(["+sym:163", "-sym:163"]);
  });
});

describe("an AZERTY keyboard", () => {
  it("types a from the key labelled A", () => {
    // The physical key is where QWERTY keeps Q. Forwarding the position is how
    // a French user ends up typing qzerty.
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("KeyQ", "a"), 0))).toEqual([`+${KEY_A}`]);
  });

  it("types a digit without the Shift the user had to hold for it", () => {
    // AZERTY digits are shifted and US digits are not; leaving Shift down
    // would turn 1 into !.
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("Digit1", "1", true), 0))).toEqual([
      `-${SHIFT}`,
      "+2",
      `+${SHIFT}`,
    ]);
  });
});

describe("synthesised Shift", () => {
  it("presses and releases Shift around a character that needs it", () => {
    // A layout where the character is unshifted but US wants it shifted.
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("KeyQ", "A"), 0))).toEqual([
      `+${SHIFT}`,
      `+${KEY_A}`,
      `-${SHIFT}`,
    ]);
  });

  it("puts Shift back immediately rather than on release", () => {
    // The character is decided when the key goes down, and the user may let go
    // of Shift while still holding the key — so the restore cannot wait.
    const keys = new KeyTranslator();
    const pressed = keys.press(down("KeyQ", "A"), 0);
    expect(shape(pressed).at(-1)).toBe(`-${SHIFT}`);
    expect(shape(keys.release(down("KeyQ", "A"), 1))).toEqual([`-${KEY_A}`]);
  });
});

describe("Caps Lock", () => {
  it("does not shift a letter the host will already capitalise", () => {
    // `key` is already uppercase because of Caps Lock, and the host's own Caps
    // Lock applies again — synthesising Shift on top would give a lowercase
    // letter.
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("KeyA", "A", false, true), 0))).toEqual([`+${KEY_A}`]);
  });

  it("still shifts punctuation, which Caps Lock does not touch", () => {
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("Digit1", "!", false, true), 0))).toEqual([
      `+${SHIFT}`,
      "+2",
      `-${SHIFT}`,
    ]);
  });
});

describe("keys that are not characters", () => {
  it("travels by position", () => {
    const keys = new KeyTranslator();
    expect(shape(keys.press(down("Enter", "Enter"), 0))).toEqual(["+28"]);
    expect(shape(keys.press(down("ArrowLeft", "ArrowLeft"), 0))).toEqual(["+105"]);
    expect(shape(keys.press(down("ShiftLeft", "Shift"), 0))).toEqual([`+${SHIFT}`]);
  });

  it("ignores a key it has no code for", () => {
    const keys = new KeyTranslator();
    expect(keys.press(down("Fn", "Fn"), 0)).toEqual([]);
  });
});

describe("holding and losing focus", () => {
  it("ignores a repeat of a key already down", () => {
    const keys = new KeyTranslator();
    keys.press(down("KeyA", "a"), 0);
    expect(keys.press(down("KeyA", "a"), 1)).toEqual([]);
  });

  it("releases everything still held", () => {
    const keys = new KeyTranslator();
    keys.press(down("KeyA", "a"), 0);
    keys.press(down("ShiftLeft", "Shift"), 1);
    expect(shape(keys.releaseAll(2)).sort()).toEqual([`-${KEY_A}`, `-${SHIFT}`].sort());
    expect(keys.held).toEqual([]);
  });

  it("does not release a key twice", () => {
    const keys = new KeyTranslator();
    keys.press(down("KeyA", "a"), 0);
    keys.release(down("KeyA", "a"), 1);
    expect(keys.releaseAll(2)).toEqual([]);
  });

  it("does not hold a keysym key", () => {
    // It is tapped rather than held, so there is nothing to release later.
    const keys = new KeyTranslator();
    keys.press(down("Digit3", "£", true), 0);
    expect(keys.held).toEqual([]);
    expect(keys.release(down("Digit3", "£", true), 1)).toEqual([]);
  });
});

describe("keysymFromCharacter", () => {
  it("maps ASCII and Latin-1 to themselves", () => {
    expect(keysymFromCharacter("A")).toBe(0x41);
    expect(keysymFromCharacter("£")).toBe(0xa3);
    expect(keysymFromCharacter("é")).toBe(0xe9);
  });

  it("flags anything else as Unicode", () => {
    expect(keysymFromCharacter("€")).toBe(0x0100_0000 + 0x20ac);
    expect(keysymFromCharacter("あ")).toBe(0x0100_0000 + 0x3042);
  });
});
