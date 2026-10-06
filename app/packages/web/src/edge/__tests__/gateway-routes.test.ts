import { describe, expect, it } from "vitest";
import { isApiPath, routeRequest } from "../gateway-routes";

describe("routeRequest", () => {
  it("sends every WebSocket upgrade to the gateway", () => {
    expect(routeRequest("GET", "/api/ws", "websocket")).toEqual({
      target: "gateway",
      reason: "websocket",
    });
    expect(routeRequest("GET", "/api/bastions/agent", "WebSocket").target).toBe("gateway");
  });

  it("sends the WebSocket endpoints to the gateway even without the header", () => {
    for (const path of ["/api/ws", "/api/apps", "/api/bastions/agent"]) {
      expect(routeRequest("GET", path, null).target, path).toBe("gateway");
    }
  });

  it("keeps stateful and driver-only routes on the gateway for every method", () => {
    for (const path of [
      "/api/mcp",
      "/api/agent/claim",
      "/api/internal/relay",
      "/api/org/org_1/chat/stream",
      "/api/org/org_1/bastions",
      "/api/org/org_1/shared-consoles/abc",
      "/api/org/org_1/sql/query",
      "/api/org/org_1/kv-browser/list",
      "/api/org/org_1/v1/sftp/list",
      "/api/slack/commands",
      "/api/slack/interactions",
    ]) {
      expect(routeRequest("GET", path, null).target, path).toBe("gateway");
      expect(routeRequest("POST", path, null).target, path).toBe("gateway");
    }
  });

  it("serves reads of mutation-on-gateway routes at the edge", () => {
    expect(routeRequest("GET", "/api/org/org_1/workflows", null).target).toBe("edge");
    expect(routeRequest("POST", "/api/org/org_1/workflows", null).target).toBe("gateway");
    expect(routeRequest("PUT", "/api/org/org_1/accounts/acc_1/credentials", null).target).toBe(
      "gateway",
    );
    expect(routeRequest("POST", "/api/workflows/git/tok", null).target).toBe("gateway");
  });

  it("does not mistake a prefix for a gateway route", () => {
    expect(routeRequest("GET", "/api/org/org_1/sqlite-things", null).target).toBe("edge");
    expect(routeRequest("GET", "/api/org/org_1/costs/summary", null).target).toBe("edge");
  });

  it("reports the account a path names so the edge can check it", () => {
    expect(routeRequest("GET", "/api/org/org_1/accounts/acc%201/resources", null)).toEqual({
      target: "edge",
      accountId: "acc 1",
    });
    expect(routeRequest("GET", "/api/org/org_1/accounts/plugins", null)).toEqual({
      target: "edge",
    });
  });
});

describe("isApiPath", () => {
  it("separates the API from the SPA", () => {
    expect(isApiPath("/api/org/x/costs")).toBe(true);
    expect(isApiPath("/callback")).toBe(true);
    expect(isApiPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isApiPath("/openapi.json")).toBe(true);
    expect(isApiPath("/docs")).toBe(true);
    expect(isApiPath("/org/x/costs")).toBe(false);
    expect(isApiPath("/assets/index-abc.js")).toBe(false);
    expect(isApiPath("/apiary")).toBe(false);
  });
});
