import { describe, expect, it, vi } from "vitest";
import { forwardOutHop, type ForwardOutCapable } from "../chain.js";

describe("forwardOutHop", () => {
  it("resolves with the stream and forwards the correct args", async () => {
    const fakeStream = { id: "duplex" };
    const forwardOut = vi.fn(
      (
        _srcAddr: string,
        _srcPort: number,
        _dstAddr: string,
        _dstPort: number,
        cb: (err: Error | undefined, stream: unknown) => void,
      ) => {
        cb(undefined, fakeStream);
      },
    );
    const client: ForwardOutCapable = { forwardOut };

    const stream = await forwardOutHop(client, "10.0.0.5", 22);
    expect(stream).toBe(fakeStream);
    expect(forwardOut).toHaveBeenCalledTimes(1);
    expect(forwardOut).toHaveBeenCalledWith("127.0.0.1", 0, "10.0.0.5", 22, expect.any(Function));
  });

  it("rejects when forwardOut reports an error", async () => {
    const boom = new Error("channel open failure");
    const client: ForwardOutCapable = {
      forwardOut: (_s, _sp, _d, _dp, cb) => cb(boom, undefined),
    };
    await expect(forwardOutHop(client, "host", 2222)).rejects.toBe(boom);
  });
});
