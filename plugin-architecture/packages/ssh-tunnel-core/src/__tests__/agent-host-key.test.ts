import { describe, expect, it } from "vitest";
import {
  AGENT_HOST_KEY_TOFU_WINDOW_MS,
  agentHostKeyMismatchMessage,
  decideAgentHostKey,
} from "../agent-host-key.js";

const created = new Date("2026-10-03T12:00:00Z");
const minutes = (n: number) => new Date(created.getTime() + n * 60_000);

describe("decideAgentHostKey", () => {
  it("accepts the pinned key", () => {
    expect(
      decideAgentHostKey({
        pinnedFingerprint: "SHA256:a",
        presentedFingerprint: "SHA256:a",
        sessionCreatedAt: created,
        now: minutes(5),
      }),
    ).toBe("match");
  });

  it("refuses a different key even inside the creation window", () => {
    expect(
      decideAgentHostKey({
        pinnedFingerprint: "SHA256:a",
        presentedFingerprint: "SHA256:b",
        sessionCreatedAt: created,
        now: minutes(1),
      }),
    ).toBe("mismatch");
  });

  it("trusts the first key of a freshly created session", () => {
    expect(
      decideAgentHostKey({
        pinnedFingerprint: null,
        presentedFingerprint: "SHA256:a",
        sessionCreatedAt: created,
        now: minutes(20),
      }),
    ).toBe("trust-first-use");
  });

  it("does not auto-trust once the creation window has passed", () => {
    expect(
      decideAgentHostKey({
        pinnedFingerprint: "",
        presentedFingerprint: "SHA256:a",
        sessionCreatedAt: created,
        now: new Date(created.getTime() + AGENT_HOST_KEY_TOFU_WINDOW_MS + 1),
      }),
    ).toBe("unpinned");
  });

  it("does not auto-trust a session dated in the future or unparseable", () => {
    expect(
      decideAgentHostKey({
        pinnedFingerprint: null,
        presentedFingerprint: "SHA256:a",
        sessionCreatedAt: minutes(10),
        now: created,
      }),
    ).toBe("unpinned");
    expect(
      decideAgentHostKey({
        pinnedFingerprint: null,
        presentedFingerprint: "SHA256:a",
        sessionCreatedAt: new Date("not a date"),
      }),
    ).toBe("unpinned");
  });
});

describe("agentHostKeyMismatchMessage", () => {
  it("is not mistaken for a transient SSH error by the setup retry loop", () => {
    // Same matcher the desktop and cloud agent pipelines retry on.
    const retryable =
      /ssh connection failed|timed out|timeout|econnrefused|connection refused|handshake|ready timeout|all configured authentication methods failed/i;
    const message = agentHostKeyMismatchMessage("203.0.113.5", 22, "SHA256:a", "SHA256:b");
    expect(message).toContain("SHA256:a");
    expect(message).toContain("SHA256:b");
    expect(retryable.test(message)).toBe(false);
  });
});
