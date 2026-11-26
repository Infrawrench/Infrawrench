import { describe, expect, it } from "vitest";
import { addressProblem, connectProblem, environmentState, outcomeOf } from "../t3";

describe("addressProblem", () => {
  it("takes an https address, with or without the scheme typed", () => {
    expect(addressProblem("https://studio.example.net")).toBeNull();
    expect(addressProblem("  studio.example.net/mcp ")).toBeNull();
  });

  it("names localhost, which a person tries first", () => {
    for (const typed of [
      "http://localhost:3773",
      "localhost:3773",
      "https://127.0.0.1:3773/mcp",
      "http://[::1]:3773",
      "https://dev.localhost",
    ]) {
      expect(addressProblem(typed), typed).toBe("localhost");
    }
  });

  it("wants https", () => {
    expect(addressProblem("http://studio.example.net")).toBe("not-https");
    expect(addressProblem("")).toBe("empty");
    expect(addressProblem("   ")).toBe("empty");
  });
});

describe("connectProblem", () => {
  const host = "prod-0123456789abcdef.t3connect.example";
  it("takes the MCP URL T3 Code copies", () => {
    expect(connectProblem(`https://${host}/mcp`)).toBeNull();
    expect(connectProblem(`  ${host} `)).toBeNull();
  });

  it("names localhost first, then what is not a T3 Connect address", () => {
    expect(connectProblem("http://localhost:3773/mcp")).toBe("localhost");
    expect(connectProblem("https://127.0.0.1:3773/mcp")).toBe("localhost");
    expect(connectProblem(`http://${host}/mcp`)).toBe("not-https");
    expect(connectProblem("https://studio.example.net/mcp")).toBe("not-t3-connect");
    expect(connectProblem(`https://${host}:8443/mcp`)).toBe("not-t3-connect");
    expect(connectProblem("")).toBe("empty");
  });
});

describe("environmentState", () => {
  const now = Date.parse("2026-11-26T12:00:00.000Z");
  it("says what there is to do", () => {
    expect(environmentState({ status: "pending", tokenExpiresAt: null }, now)).toEqual({
      label: "Not signed in",
      tone: "neutral",
      action: "Sign in",
    });
    expect(
      environmentState({ status: "connected", tokenExpiresAt: "2026-12-20T00:00:00.000Z" }, now),
    ).toEqual({ label: "Connected", tone: "success", action: null });
    expect(environmentState({ status: "error", tokenExpiresAt: null }, now).action).toBe(
      "Sign in again",
    );
  });

  it("reads a sign-in that ran out as one that ended", () => {
    expect(
      environmentState({ status: "connected", tokenExpiresAt: "2026-11-26T11:59:59.000Z" }, now),
    ).toMatchObject({ label: "Sign-in ended", action: "Sign in again" });
    // No expiry told: it stands until the environment says otherwise.
    expect(environmentState({ status: "connected", tokenExpiresAt: null }, now).action).toBeNull();
  });
});

describe("outcomeOf", () => {
  it("keeps the two words the callback writes and nothing else", () => {
    expect(outcomeOf("connected")).toBe("connected");
    expect(outcomeOf("failed")).toBe("failed");
    expect(outcomeOf("<script>")).toBeUndefined();
    expect(outcomeOf(1)).toBeUndefined();
    expect(outcomeOf(undefined)).toBeUndefined();
  });
});
