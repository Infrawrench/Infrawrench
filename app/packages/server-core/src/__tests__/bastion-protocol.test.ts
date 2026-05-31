import { describe, expect, it } from "vitest";
import {
  BASTION_PROTOCOL_VERSION,
  BASTION_WS_SUBPROTOCOL,
  type BastionMessage,
} from "../bastion/protocol";

describe("bastion protocol constants", () => {
  it("exposes the subprotocol name", () => {
    expect(BASTION_WS_SUBPROTOCOL).toBe("infrawrench-bastion-v1");
  });

  it("exposes the protocol version", () => {
    expect(BASTION_PROTOCOL_VERSION).toBe(1);
  });

  it("messages serialize/deserialize as JSON envelopes", () => {
    const msgs: BastionMessage[] = [
      { op: "hello", protocolVersion: 1, allowlist: ["*.amazonaws.com"], heartbeatMs: 5000 },
      { op: "open", streamId: 1, host: "api.aws.com", port: 443 },
      { op: "data", streamId: 1, data: Buffer.from("hi").toString("base64") },
      { op: "end", streamId: 1 },
      { op: "opened", streamId: 1 },
      { op: "open-failed", streamId: 1, reason: "refused" },
      { op: "close", streamId: 1, reason: "done" },
      { op: "ping" },
      { op: "pong" },
      { op: "agent-info", agentVersion: "1.2.3" },
    ];
    for (const m of msgs) {
      const round = JSON.parse(JSON.stringify(m));
      expect(round).toEqual(m);
      expect(typeof round.op).toBe("string");
    }
  });

  it("data payloads survive a base64 round-trip", () => {
    const original = Buffer.from([0, 1, 2, 255, 254]);
    const msg: BastionMessage = { op: "data", streamId: 7, data: original.toString("base64") };
    const decoded = Buffer.from((JSON.parse(JSON.stringify(msg)) as typeof msg).data, "base64");
    expect(Buffer.compare(decoded, original)).toBe(0);
  });
});
