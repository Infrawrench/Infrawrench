import { describe, expect, it } from "vitest";

import { safe, setColorEnabled, c, visibleWidth } from "../cli/output";

/**
 * Regression for the terminal-control-injection finding.
 *
 * An org member can put whatever they like in an incident title, summary or
 * note. Another member runs `infrawrench declared-incidents` and the CLI writes
 * that text to their terminal — which *executes* control sequences rather than
 * displaying them. Crafted content could clear the screen, move the cursor back
 * over output that was already printed and rewrite it, or set the window title.
 *
 * Every control character is spelled as an escape here so this file stays plain
 * text; a test about control characters that contains raw ones is unreadable.
 */

const ESC = "\u001b";

describe("safe()", () => {
  it("strips the sequence that erases the screen and homes the cursor", () => {
    expect(safe(`Checkout${ESC}[2J${ESC}[H is fine`)).toBe("Checkout[2J[H is fine");
  });

  it("strips an OSC window-title set, terminator and all", () => {
    expect(safe(`title${ESC}]0;pwned\u0007`)).toBe("title]0;pwned");
  });

  it("strips carriage returns, which overwrite the line already printed", () => {
    // The spoofing primitive that needs no ESC at all: print a plausible line,
    // \r back to column zero, then print something else over it.
    expect(safe("resolved\rSEV1 open")).toBe("resolvedSEV1 open");
  });

  it("strips backspace, the other way to walk back over output", () => {
    expect(safe("ok\b\bno")).toBe("okno");
  });

  it("strips C1 controls, which some terminals accept as sequence introducers", () => {
    expect(safe("a\u009b2Jb")).toBe("a2Jb");
  });

  it("keeps newlines and tabs — a summary is allowed paragraphs", () => {
    expect(safe("one\ntwo\tthree")).toBe("one\ntwo\tthree");
  });

  it("leaves ordinary text, including non-ASCII, exactly alone", () => {
    expect(safe("Checkout — 500s · café 🙂")).toBe("Checkout — 500s · café 🙂");
  });

  it("treats null and undefined as empty, so callers need no ceremony", () => {
    expect(safe(null)).toBe("");
    expect(safe(undefined)).toBe("");
  });

  it("does not disturb the colours the c.* helpers add afterwards", () => {
    // The documented order is: sanitise the value, then colour it. Colouring a
    // sanitised string must still produce a working SGR sequence.
    setColorEnabled(true);
    try {
      const coloured = c.red(safe(`bad${ESC}[2Jinput`));
      expect(coloured).toContain("bad[2Jinput");
      expect(visibleWidth(coloured)).toBe("bad[2Jinput".length);
    } finally {
      setColorEnabled(false);
    }
  });

  it("makes hostile text harmless inside a table cell's width calculation", () => {
    // Untrusted ANSI also corrupts column alignment, because visibleWidth only
    // discounts the SGR sequences we emit ourselves.
    const hostile = `x${ESC}[2Jx`;
    expect(visibleWidth(hostile)).not.toBe(2);
    expect(visibleWidth(safe(hostile))).toBe(safe(hostile).length);
  });
});
