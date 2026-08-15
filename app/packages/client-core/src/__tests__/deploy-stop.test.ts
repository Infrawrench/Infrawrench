import { describe, expect, it, vi } from "vitest";
import { createDeployStopController } from "../deploy-stop";

describe("createDeployStopController", () => {
  it("sends immediately once the transport has armed it", () => {
    const send = vi.fn();
    const c = createDeployStopController();
    c.arm(send);
    expect(c.armed).toBe(true);
    expect(send).not.toHaveBeenCalled();

    c.stop();
    expect(send).toHaveBeenCalledTimes(1);
    expect(c.requested).toBe(true);
  });

  it("queues a stop asked for before the socket is up, and flushes it on arm", () => {
    const send = vi.fn();
    const c = createDeployStopController();

    // The window the bug lived in: deploy() is still awaiting its ws token.
    c.stop();
    expect(c.requested).toBe(true);
    expect(send).not.toHaveBeenCalled();

    c.arm(send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends at most one frame however many times it is clicked", () => {
    const send = vi.fn();
    const c = createDeployStopController();
    c.stop();
    c.stop();
    c.arm(send);
    c.stop();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignores a stop after the run has finished", () => {
    const send = vi.fn();
    const c = createDeployStopController();
    c.arm(send);
    c.finish();

    c.stop();
    expect(send).not.toHaveBeenCalled();
    expect(c.requested).toBe(false);
    expect(c.finished).toBe(true);
  });

  it("drops a queued stop when the run ends before the channel is armed", () => {
    const send = vi.fn();
    const c = createDeployStopController();
    c.stop();
    c.finish();

    // e.g. the socket errored while connecting: arming can no longer happen,
    // and a late arm must not resurrect the request.
    c.arm(send);
    expect(send).not.toHaveBeenCalled();
    expect(c.armed).toBe(false);
  });

  it("is idempotent on finish", () => {
    const c = createDeployStopController();
    c.finish();
    c.finish();
    expect(c.finished).toBe(true);
  });
});
