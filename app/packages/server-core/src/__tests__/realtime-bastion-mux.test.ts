import { describe, expect, it } from "vitest";
import { BastionMux } from "../realtime/bastion-mux";

describe("BastionMux", () => {
  it("renumbers colliding client streams onto distinct agent streams and back", () => {
    const mux = new BastionMux();
    const a = mux.fromClient(
      "a",
      { op: "open", streamId: 1, host: "api.example.com", port: 443 },
      true,
    );
    const b = mux.fromClient(
      "b",
      { op: "open", streamId: 1, host: "api.example.com", port: 443 },
      true,
    );
    expect(a).toEqual([
      { to: "agent", message: { op: "open", streamId: 1, host: "api.example.com", port: 443 } },
    ]);
    expect(b).toEqual([
      { to: "agent", message: { op: "open", streamId: 2, host: "api.example.com", port: 443 } },
    ]);

    expect(mux.fromAgent({ op: "opened", streamId: 2 })).toEqual([
      { to: "client", client: "b", message: { op: "opened", streamId: 1 } },
    ]);
    expect(mux.fromClient("a", { op: "data", streamId: 1, data: "aGk=" }, true)).toEqual([
      { to: "agent", message: { op: "data", streamId: 1, data: "aGk=" } },
    ]);
    expect(mux.fromAgent({ op: "data", streamId: 1, data: "b2s=" })).toEqual([
      { to: "client", client: "a", message: { op: "data", streamId: 1, data: "b2s=" } },
    ]);
  });

  it("fails an open at once when no agent is connected", () => {
    const mux = new BastionMux();
    expect(mux.fromClient("a", { op: "open", streamId: 7, host: "h", port: 443 }, false)).toEqual([
      {
        to: "client",
        client: "a",
        message: { op: "open-failed", streamId: 7, reason: "agent disconnected" },
      },
    ]);
    expect(mux.size).toBe(0);
  });

  it("forgets a stream on close from either side", () => {
    const mux = new BastionMux();
    mux.fromClient("a", { op: "open", streamId: 1, host: "h", port: 443 }, true);
    mux.fromClient("a", { op: "open", streamId: 2, host: "h", port: 443 }, true);
    mux.fromAgent({ op: "close", streamId: 1 });
    mux.fromClient("a", { op: "close", streamId: 2 }, true);
    expect(mux.size).toBe(0);
  });

  it("closes a departed client's streams at the agent, and the agent's at every client", () => {
    const mux = new BastionMux();
    mux.fromClient("a", { op: "open", streamId: 1, host: "h", port: 443 }, true);
    mux.fromClient("b", { op: "open", streamId: 5, host: "h", port: 443 }, true);
    expect(mux.clientGone("a")).toEqual([
      { to: "agent", message: { op: "close", streamId: 1, reason: "client gone" } },
    ]);
    expect(mux.agentGone()).toEqual([
      {
        to: "client",
        client: "b",
        message: { op: "close", streamId: 5, reason: "agent disconnected" },
      },
    ]);
    expect(mux.size).toBe(0);
  });

  it("closes streams it does not know instead of dropping them silently", () => {
    const mux = new BastionMux();
    expect(mux.fromClient("a", { op: "data", streamId: 3, data: "" }, true)).toEqual([
      {
        to: "client",
        client: "a",
        message: { op: "close", streamId: 3, reason: "unknown stream" },
      },
    ]);
    expect(mux.fromAgent({ op: "data", streamId: 9, data: "" })).toEqual([
      { to: "agent", message: { op: "close", streamId: 9, reason: "unknown stream" } },
    ]);
  });
});
