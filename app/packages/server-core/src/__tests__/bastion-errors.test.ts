import { describe, expect, it } from "vitest";
import {
  BastionDisconnectedError,
  BastionError,
  BastionRevokedError,
  BastionStreamOpenError,
  isBastionError,
} from "../bastion/errors";

describe("bastion errors", () => {
  it("BastionError carries the bastionId and name", () => {
    const e = new BastionError("boom", "b1");
    expect(e.bastionId).toBe("b1");
    expect(e.name).toBe("BastionError");
    expect(e.message).toBe("boom");
    expect(e).toBeInstanceOf(Error);
  });

  it("BastionDisconnectedError formats an offline message", () => {
    const e = new BastionDisconnectedError("b2");
    expect(e.name).toBe("BastionDisconnectedError");
    expect(e.bastionId).toBe("b2");
    expect(e.message).toContain("b2");
    expect(e.message).toContain("offline");
    expect(e).toBeInstanceOf(BastionError);
  });

  it("BastionRevokedError formats a revoked message", () => {
    const e = new BastionRevokedError("b3");
    expect(e.name).toBe("BastionRevokedError");
    expect(e.message).toContain("revoked");
    expect(e.bastionId).toBe("b3");
  });

  it("BastionStreamOpenError includes the reason", () => {
    const e = new BastionStreamOpenError("b4", "DNS failure");
    expect(e.name).toBe("BastionStreamOpenError");
    expect(e.message).toContain("DNS failure");
    expect(e.bastionId).toBe("b4");
  });

  it("isBastionError narrows correctly", () => {
    expect(isBastionError(new BastionError("x", "b"))).toBe(true);
    expect(isBastionError(new BastionDisconnectedError("b"))).toBe(true);
    expect(isBastionError(new Error("plain"))).toBe(false);
    expect(isBastionError("string")).toBe(false);
    expect(isBastionError(null)).toBe(false);
  });
});
