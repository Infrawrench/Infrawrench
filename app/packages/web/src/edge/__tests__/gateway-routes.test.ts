import { describe, expect, it } from "vitest";
import { isApiPath, routeRequest } from "../gateway-routes";

describe("routeRequest", () => {
  it("sends every WebSocket upgrade to the session gateway", () => {
    expect(routeRequest("GET", "/api/ws", "websocket")).toEqual({
      target: "gateway",
      tier: "session",
      reason: "websocket",
    });
    expect(routeRequest("GET", "/api/bastions/agent", "WebSocket")).toMatchObject({
      target: "gateway",
      tier: "session",
    });
  });

  it("sends the WebSocket endpoints to the session gateway even without the header", () => {
    for (const path of ["/api/ws", "/api/apps", "/api/bastions/agent"]) {
      expect(routeRequest("GET", path, null), path).toMatchObject({ tier: "session" });
    }
  });

  it("keeps stateful routes on the session gateway for every method", () => {
    for (const path of [
      "/api/mcp",
      "/api/agent/claim",
      "/api/internal/relay",
      "/api/org/org_1/chat/stream",
      "/api/org/org_1/bastions",
      "/api/org/org_1/shared-consoles/abc",
      "/api/org/org_1/apps/start",
      "/api/org/org_1/ssh-tunnels/open",
      "/api/org/org_1/deployments/run",
      "/api/org/org_1/v1/storage/upload",
      "/api/org/org_1/v1/sftp/list",
    ]) {
      for (const method of ["GET", "POST"]) {
        expect(routeRequest(method, path, null), `${method} ${path}`).toMatchObject({
          target: "gateway",
          tier: "session",
        });
      }
    }
  });

  it("sends driver-only routes to any Node runtime for every method", () => {
    for (const path of [
      "/api/org/org_1/sql/query",
      "/api/org/org_1/kv-browser/list",
      "/api/org/org_1/docker/containers",
      "/api/org/org_1/ssh-fanout/run",
      "/api/org/org_1/session-recordings/rec_1",
      "/api/slack/commands",
      "/api/slack/interactions",
      "/api/paging-webhooks/pagerduty/tok",
      "/api/provider-oauth/github/callback",
      "/api/org/org_1/provider-oauth/github/authorize",
    ]) {
      for (const method of ["GET", "POST"]) {
        expect(routeRequest(method, path, null), `${method} ${path}`).toMatchObject({
          target: "gateway",
          tier: "node",
        });
      }
    }
  });

  it("serves reads of mutation-on-gateway routes at the edge", () => {
    expect(routeRequest("GET", "/api/org/org_1/workflows", null).target).toBe("edge");
    expect(routeRequest("POST", "/api/org/org_1/workflows", null)).toMatchObject({
      target: "gateway",
      tier: "node",
    });
    // The account rides along so the Worker can send a bastion-bound one to
    // the session gateway rather than the Lambda.
    expect(routeRequest("PUT", "/api/org/org_1/accounts/acc_1/credentials", null)).toEqual({
      target: "gateway",
      tier: "node",
      reason: "mutation",
      accountId: "acc_1",
    });
    expect(routeRequest("POST", "/api/workflows/git/tok", null).target).toBe("gateway");
    // The pull request check preview runs plugin estimators; its settings
    // CRUD is ordinary Postgres and stays on the edge.
    expect(routeRequest("POST", "/api/org/org_1/pr-checks/preview", null).target).toBe("gateway");
    expect(routeRequest("POST", "/api/org/org_1/pr-checks/repositories", null).target).toBe("edge");
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
