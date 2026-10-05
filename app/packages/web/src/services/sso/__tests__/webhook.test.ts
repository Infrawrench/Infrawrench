import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("../workos-api", () => ({}));
vi.mock("../directory-sync", () => ({}));
vi.mock("../settings", () => ({}));

const { verifyWorkosSignature, parseWorkosEvent, TOLERANCE_MS } = await import("../webhook");

const SECRET = "test-webhook-secret-not-real";
const body = JSON.stringify({ id: "event_01TEST", event: "dsync.user.created", data: { id: "x" } });

function sign(payload: string, t: number, secret = SECRET) {
  const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t}, v1=${sig}`;
}

describe("verifyWorkosSignature", () => {
  const now = 1_780_000_000_000;

  it("accepts a fresh signature over the raw body", () => {
    expect(verifyWorkosSignature(body, sign(body, now), SECRET, now)).toBe(true);
  });

  it("rejects a body that differs by one byte from what was signed", () => {
    expect(verifyWorkosSignature(`${body} `, sign(body, now), SECRET, now)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyWorkosSignature(body, sign(body, now, "other"), SECRET, now)).toBe(false);
  });

  it("rejects a replay outside the tolerance, in either direction", () => {
    const old = now - TOLERANCE_MS - 1;
    const future = now + TOLERANCE_MS + 1;
    expect(verifyWorkosSignature(body, sign(body, old), SECRET, now)).toBe(false);
    expect(verifyWorkosSignature(body, sign(body, future), SECRET, now)).toBe(false);
  });

  it("rejects missing or malformed headers and an empty secret", () => {
    expect(verifyWorkosSignature(body, undefined, SECRET, now)).toBe(false);
    expect(verifyWorkosSignature(body, "v1=abc", SECRET, now)).toBe(false);
    expect(verifyWorkosSignature(body, `t=${now}`, SECRET, now)).toBe(false);
    expect(verifyWorkosSignature(body, "t=abc, v1=00", SECRET, now)).toBe(false);
    expect(verifyWorkosSignature(body, sign(body, now), "", now)).toBe(false);
  });
});

describe("parseWorkosEvent", () => {
  it("needs an id, an event name and a data object", () => {
    expect(parseWorkosEvent(body)?.event).toBe("dsync.user.created");
    expect(parseWorkosEvent("{}")).toBeNull();
    expect(parseWorkosEvent("not json")).toBeNull();
    expect(parseWorkosEvent(JSON.stringify({ id: "e", event: "x", data: "s" }))).toBeNull();
  });
});
