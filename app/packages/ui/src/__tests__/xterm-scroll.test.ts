import { describe, expect, it, vi } from "vitest";
import { attachAltBufferScrollHandler, type ScrollableTerminal } from "../xterm-scroll";

function makeTerm(bufferType: string, withElement = true, mouseTrackingMode = "none") {
  const element = withElement ? document.createElement("div") : undefined;
  const term: ScrollableTerminal = {
    element,
    buffer: { active: { type: bufferType } },
    modes: { mouseTrackingMode },
  };
  return { term, element };
}

function wheel(opts: Partial<WheelEvent> & { deltaY: number }): WheelEvent {
  const e = new Event("wheel", { cancelable: true }) as WheelEvent;
  Object.assign(e, { deltaMode: 1, ...opts });
  return e;
}

describe("attachAltBufferScrollHandler", () => {
  it("returns a no-op dispose when terminal has no element", () => {
    const { term } = makeTerm("alternate", false);
    const handle = attachAltBufferScrollHandler(term, vi.fn());
    expect(() => handle.dispose()).not.toThrow();
  });

  it("sends up-arrow sequences when scrolling up in alt buffer", () => {
    const { term, element } = makeTerm("alternate");
    const sendInput = vi.fn();
    attachAltBufferScrollHandler(term, sendInput);
    element!.dispatchEvent(wheel({ deltaY: -3, deltaMode: 1 }));
    expect(sendInput).toHaveBeenCalledWith("\x1bOA".repeat(3));
  });

  it("sends down-arrow sequences when scrolling down", () => {
    const { term, element } = makeTerm("alternate");
    const sendInput = vi.fn();
    attachAltBufferScrollHandler(term, sendInput);
    element!.dispatchEvent(wheel({ deltaY: 2, deltaMode: 1 }));
    expect(sendInput).toHaveBeenCalledWith("\x1bOB".repeat(2));
  });

  it("clamps line count to max 10", () => {
    const { term, element } = makeTerm("alternate");
    const sendInput = vi.fn();
    attachAltBufferScrollHandler(term, sendInput);
    element!.dispatchEvent(wheel({ deltaY: 100, deltaMode: 1 }));
    expect(sendInput).toHaveBeenCalledWith("\x1bOB".repeat(10));
  });

  it("converts pixel deltas (deltaMode 0) to lines", () => {
    const { term, element } = makeTerm("alternate");
    const sendInput = vi.fn();
    attachAltBufferScrollHandler(term, sendInput);
    element!.dispatchEvent(wheel({ deltaY: 32, deltaMode: 0 }));
    expect(sendInput).toHaveBeenCalledWith("\x1bOB".repeat(2));
  });

  it("does nothing in the normal buffer", () => {
    const { term, element } = makeTerm("normal");
    const sendInput = vi.fn();
    attachAltBufferScrollHandler(term, sendInput);
    element!.dispatchEvent(wheel({ deltaY: -3 }));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does nothing while the app has mouse tracking enabled", () => {
    // xterm already converts wheel events to mouse reports the app scrolls
    // with — synthesizing keys on top would double-scroll or walk history.
    const { term, element } = makeTerm("alternate", true, "any");
    const sendInput = vi.fn();
    attachAltBufferScrollHandler(term, sendInput);
    element!.dispatchEvent(wheel({ deltaY: -3 }));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("ignores zero-delta wheel events", () => {
    const { term, element } = makeTerm("alternate");
    const sendInput = vi.fn();
    attachAltBufferScrollHandler(term, sendInput);
    element!.dispatchEvent(wheel({ deltaY: 0 }));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("dispose removes the wheel listener", () => {
    const { term, element } = makeTerm("alternate");
    const sendInput = vi.fn();
    const handle = attachAltBufferScrollHandler(term, sendInput);
    handle.dispose();
    element!.dispatchEvent(wheel({ deltaY: -3 }));
    expect(sendInput).not.toHaveBeenCalled();
  });
});
