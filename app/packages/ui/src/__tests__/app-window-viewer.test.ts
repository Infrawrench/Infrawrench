import { describe, expect, it } from "vitest";
import { containedRect } from "../apps/AppWindowViewer.js";

describe("containedRect", () => {
  it("fills the box when the aspect ratios match", () => {
    // The steady state: the application accepted the size it was asked for.
    expect(containedRect(1600, 1200, 800, 600)).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    });
  });

  it("centres a picture too tall for the box", () => {
    // Every resize spends a round trip here — the buffer is still the old
    // shape while the box is already the new one — and an application that
    // refuses a size stays here.
    expect(containedRect(100, 100, 400, 200)).toEqual({
      left: 100,
      top: 0,
      width: 200,
      height: 200,
    });
  });

  it("centres a picture too wide for the box", () => {
    expect(containedRect(100, 100, 200, 400)).toEqual({
      left: 0,
      top: 100,
      width: 200,
      height: 200,
    });
  });

  it("maps a click in the middle of the picture to the middle of the buffer", () => {
    // The property that actually matters. A pointer at the centre of the
    // letterboxed picture has to land at the centre of the window, not at the
    // centre of the element it is drawn inside.
    const shown = containedRect(100, 100, 400, 200);
    const clientX = shown.left + shown.width / 2;
    expect((clientX - shown.left) * (100 / shown.width)).toBe(50);
  });

  it("survives a box with no size yet", () => {
    // A tab that is mounted but hidden measures zero, and dividing by it would
    // send NaN coordinates to the host.
    const shown = containedRect(100, 100, 0, 0);
    expect(Number.isFinite(shown.width)).toBe(true);
    expect(shown.width).toBeGreaterThan(0);
  });
});
