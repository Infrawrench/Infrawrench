import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeWsBackpressure } from "@/services/ws-backpressure";

const MiB = 1024 * 1024;

function fakeWs() {
  return { bufferedAmount: 0, readyState: 1, OPEN: 1 };
}

describe("makeWsBackpressure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pauses above the high-water mark and resumes after the buffer drains", () => {
    const ws = fakeWs();
    const pause = vi.fn();
    const resume = vi.fn();
    const bp = makeWsBackpressure(ws as never, { pause, resume });

    bp.check();
    expect(pause).not.toHaveBeenCalled();

    ws.bufferedAmount = 5 * MiB;
    bp.check();
    expect(pause).toHaveBeenCalledTimes(1);
    bp.check(); // no double-pause while paused
    expect(pause).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(200);
    expect(resume).not.toHaveBeenCalled(); // still above low water

    ws.bufferedAmount = 512 * 1024;
    vi.advanceTimersByTime(100);
    expect(resume).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500); // poller stopped — no repeat resumes
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("resumes when the ws is no longer open", () => {
    const ws = fakeWs();
    const pause = vi.fn();
    const resume = vi.fn();
    const bp = makeWsBackpressure(ws as never, { pause, resume });

    ws.bufferedAmount = 5 * MiB;
    bp.check();
    expect(pause).toHaveBeenCalledTimes(1);

    ws.readyState = 3;
    vi.advanceTimersByTime(100);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("dispose resumes a paused source and is idempotent", () => {
    const ws = fakeWs();
    const pause = vi.fn();
    const resume = vi.fn();
    const bp = makeWsBackpressure(ws as never, { pause, resume });

    ws.bufferedAmount = 5 * MiB;
    bp.check();
    bp.dispose();
    expect(resume).toHaveBeenCalledTimes(1);
    bp.dispose();
    expect(resume).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("dispose is a no-op when never paused", () => {
    const ws = fakeWs();
    const pause = vi.fn();
    const resume = vi.fn();
    const bp = makeWsBackpressure(ws as never, { pause, resume });
    bp.dispose();
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});
