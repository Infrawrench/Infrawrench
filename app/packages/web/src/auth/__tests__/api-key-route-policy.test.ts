import { describe, it, expect } from "vitest";
import {
  AGENT_DENY_RULES,
  API_KEY_DENY_RULES,
  agentRouteDenial,
  apiKeyRouteDenial,
  orgSubPath,
} from "../api-key-route-policy";

const ORG = "/api/org/org_01ABCDEF";

describe("orgSubPath", () => {
  it("strips the org prefix", () => {
    expect(orgSubPath(`${ORG}/api-keys`)).toBe("/api-keys");
    expect(orgSubPath(`${ORG}/team/members/u1`)).toBe("/team/members/u1");
  });

  it("returns / for the org root", () => {
    expect(orgSubPath(ORG)).toBe("/");
    expect(orgSubPath(`${ORG}/`)).toBe("/");
  });

  it("returns null for paths outside the org tree", () => {
    expect(orgSubPath("/api/profile/mfa")).toBeNull();
    expect(orgSubPath("/api/orgs")).toBeNull();
    expect(orgSubPath("/api/admin/organizations")).toBeNull();
    expect(orgSubPath("/openapi.json")).toBeNull();
  });

  /**
   * The org id is an opaque segment. Splitting on `/` rather than slicing a
   * known id keeps the match working whatever the id contains.
   */
  it("does not care what the org id looks like", () => {
    expect(orgSubPath("/api/org/a.b%20c/api-keys")).toBe("/api-keys");
  });
});

describe("apiKeyRouteDenial", () => {
  it("closes key minting to keys entirely", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect(apiKeyRouteDenial(method, `${ORG}/api-keys`)).toMatch(/cannot manage API keys/);
    }
    expect(apiKeyRouteDenial("DELETE", `${ORG}/api-keys/k1`)).toMatch(/cannot manage API keys/);
  });

  it("closes billing and push entirely", () => {
    expect(apiKeyRouteDenial("GET", `${ORG}/billing`)).toMatch(/cannot change billing/);
    expect(apiKeyRouteDenial("POST", `${ORG}/billing/checkout`)).toMatch(/cannot change billing/);
    expect(apiKeyRouteDenial("PUT", `${ORG}/push/preferences`)).toMatch(/cannot register devices/);
  });

  it("closes team and break-glass mutations but leaves their reads open", () => {
    expect(apiKeyRouteDenial("GET", `${ORG}/team`)).toBeNull();
    expect(apiKeyRouteDenial("GET", `${ORG}/team/members`)).toBeNull();
    expect(apiKeyRouteDenial("POST", `${ORG}/team/invitations`)).toMatch(/team membership/);
    expect(apiKeyRouteDenial("PATCH", `${ORG}/team/members/u1/role`)).toMatch(/team membership/);
    expect(apiKeyRouteDenial("DELETE", `${ORG}/team/members/u1`)).toMatch(/team membership/);

    expect(apiKeyRouteDenial("GET", `${ORG}/access-requests`)).toBeNull();
    expect(apiKeyRouteDenial("POST", `${ORG}/access-requests/r1/approve`)).toMatch(/break-glass/);

    // Shared consoles, by the same argument as break-glass: sharing a live
    // shell and accepting a place on one are both acts a person performs, and
    // an unattended key redeeming an invite would turn a link pasted into a
    // chat window into a durable foothold. Listing stays open — that is the
    // visibility half of the control.
    expect(apiKeyRouteDenial("GET", `${ORG}/shared-consoles`)).toBeNull();
    expect(apiKeyRouteDenial("POST", `${ORG}/shared-consoles`)).toMatch(/share or join a console/);
    expect(apiKeyRouteDenial("POST", `${ORG}/shared-consoles/c1/join`)).toMatch(
      /share or join a console/,
    );
    expect(apiKeyRouteDenial("POST", `${ORG}/shared-consoles/c1/handover`)).toMatch(
      /share or join a console/,
    );
    expect(apiKeyRouteDenial("DELETE", `${ORG}/shared-consoles/c1`)).toMatch(
      /share or join a console/,
    );
  });

  /**
   * A prefix rule must not swallow a sibling that merely starts with the same
   * characters — `/teams-something` is not `/team`.
   */
  it("matches on path segments, not string prefixes", () => {
    expect(apiKeyRouteDenial("POST", `${ORG}/teams-of-things`)).toBeNull();
    expect(apiKeyRouteDenial("POST", `${ORG}/api-keys-report`)).toBeNull();
    expect(apiKeyRouteDenial("POST", `${ORG}/billing-rules`)).toBeNull();
    expect(apiKeyRouteDenial("POST", `${ORG}/shared-consoles-report`)).toBeNull();
  });

  it("leaves the automation surface open", () => {
    for (const path of [
      "/accounts",
      "/resources/aws:a1:i-1",
      "/costs/query",
      "/workflows",
      "/config",
      "/dashboards",
      "/audit-logs",
      "/session-recordings",
    ]) {
      expect(apiKeyRouteDenial("POST", `${ORG}${path}`)).toBeNull();
      expect(apiKeyRouteDenial("GET", `${ORG}${path}`)).toBeNull();
    }
  });

  it("is case-insensitive on the method", () => {
    expect(apiKeyRouteDenial("post", `${ORG}/team/invitations`)).toMatch(/team membership/);
  });

  it("says nothing about paths outside the org tree", () => {
    // `/api/profile` is human-only for a different reason — it sits under the
    // `authed` group, whose session middleware is untouched.
    expect(apiKeyRouteDenial("DELETE", "/api/profile/sessions/s1")).toBeNull();
  });

  it("gives every rule a reason a caller can act on", () => {
    for (const rule of API_KEY_DENY_RULES) {
      expect(rule.reason.length).toBeGreaterThan(20);
      expect(rule.prefix.startsWith("/")).toBe(true);
      expect(rule.prefix.endsWith("/")).toBe(false);
    }
  });
});

describe("agentRouteDenial", () => {
  it("inherits every API-key denial", () => {
    // An agent is strictly more restricted than a key, never less. If a rule is
    // added to the key table and agents were not covered, this fails.
    for (const rule of API_KEY_DENY_RULES) {
      const method = rule.methods === "*" ? "GET" : rule.methods[0]!;
      expect(agentRouteDenial(method, `${ORG}${rule.prefix}`)).not.toBeNull();
    }
  });

  it("rewrites the inherited reason to name agents", () => {
    // A caller told "API keys cannot manage API keys" when it presented an
    // agent credential would go looking for a key it does not have.
    expect(agentRouteDenial("POST", `${ORG}/api-keys`)).toMatch(/^Agents/);
  });

  it("closes agent-registration writes but leaves reads open", () => {
    expect(agentRouteDenial("DELETE", `${ORG}/agent-registrations/r1`)).toMatch(/cannot revoke/);
    expect(agentRouteDenial("GET", `${ORG}/agent-registrations`)).toBeNull();
  });

  it("closes invitations to claimed agents too", () => {
    // Unclaimed agents never hold `team:invite`; this is the second lock, for a
    // claimed agent that inherits it from its claimer's role.
    expect(agentRouteDenial("POST", `${ORG}/team/invitations`)).not.toBeNull();
  });

  it("leaves the ordinary product surface open", () => {
    for (const path of ["/resources", "/accounts", "/dashboards", "/costs"]) {
      expect(agentRouteDenial("POST", `${ORG}${path}`)).toBeNull();
      expect(agentRouteDenial("GET", `${ORG}${path}`)).toBeNull();
    }
  });

  it("gives every agent-only rule a reason a caller can act on", () => {
    for (const rule of AGENT_DENY_RULES) {
      expect(rule.reason.length).toBeGreaterThan(20);
      expect(rule.prefix.startsWith("/")).toBe(true);
      expect(rule.prefix.endsWith("/")).toBe(false);
    }
  });
});
