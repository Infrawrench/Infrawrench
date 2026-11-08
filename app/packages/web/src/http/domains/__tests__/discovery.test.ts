import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * The discovery documents at the domain root: MCP's OAuth metadata
 * (`/.well-known/*`) and the agent registration skill (`/auth.md`). Public,
 * read before a client holds any credential.
 */

// The auth.md limits come from the trial modules, which reach Postgres at import.
vi.mock("@infrawrench/server-core/trials/ceremony", () => ({
  CLAIM_CODE_TTL_MS: 15 * 60_000,
  REGISTRATIONS_PER_IP_PER_HOUR: 5,
}));
vi.mock("@infrawrench/server-core/trials/create", () => ({ TRIAL_DURATION_MS: 24 * 3_600_000 }));

const { discoveryDomain } = await import("@/http/domains/discovery/index");
const { resetRegistrationProbeForTests } = await import("@/mcp/registration-probe");

const wellKnown = buildTestApi(discoveryDomain, { basePath: "/.well-known" });
const root = buildTestApi(discoveryDomain);

/** Stubs the probe's fetch so route tests never reach the network. */
function stubProbeAsDocument(doc: Record<string, unknown>) {
  const fetchStub = vi.fn(async () => Response.json(doc));
  resetRegistrationProbeForTests(fetchStub as unknown as typeof fetch);
  return fetchStub;
}

describe("MCP well-known routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubProbeAsDocument({ client_id_metadata_document_supported: true });
    delete process.env["WORKOS_AUTHKIT_DOMAIN"];
    delete process.env["WORKOS_ISSUER"];
    delete process.env["PUBLIC_BASE_URL"];
    delete process.env["APP_URL"];
  });

  it("/oauth-protected-resource advertises the WorkOS authorization server", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";
    process.env["PUBLIC_BASE_URL"] = "https://infrawrench.test";

    const res = await wellKnown.request("/oauth-protected-resource");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://infrawrench.test/api/mcp");
    expect(body.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(body.bearer_methods_supported).toContain("header");
  });

  // RFC 9728 §3.1: clients derive the metadata URL from the resource path
  // rather than reading it off the WWW-Authenticate challenge.
  it("serves the same metadata at the resource-path-suffixed URL", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";
    process.env["PUBLIC_BASE_URL"] = "https://infrawrench.test";

    const res = await wellKnown.request("/oauth-protected-resource/api/mcp");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://infrawrench.test/api/mcp");
    expect(body.authorization_servers).toEqual(["https://auth.example.com"]);
  });

  it("falls back to APP_URL so the resource keeps its https scheme", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";
    process.env["APP_URL"] = "https://app.infrawrench.test";

    const res = await wellKnown.request("/oauth-protected-resource");
    const body = await res.json();
    expect(body.resource).toBe("https://app.infrawrench.test/api/mcp");
  });

  it("honours x-forwarded-proto when no explicit origin is configured", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";

    const res = await wellKnown.request("/oauth-protected-resource", {
      headers: { "x-forwarded-proto": "https" },
    });
    const body = await res.json();
    expect(body.resource).toMatch(/^https:\/\//);
  });

  it("advertises only scopes the AuthKit server actually grants", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";

    const res = await wellKnown.request("/oauth-protected-resource");
    const body = await res.json();
    expect(body.scopes_supported).toEqual(["openid", "profile", "email", "offline_access"]);
  });

  it("fails loudly instead of advertising a dead authorization server", async () => {
    const res = await wellKnown.request("/oauth-protected-resource");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("server_error");
  });

  it("/oauth-authorization-server redirects to the upstream metadata", async () => {
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com";
    const res = await wellKnown.request("/oauth-authorization-server", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://auth.example.com/.well-known/oauth-authorization-server",
    );
  });
});

describe("discovery responses", () => {
  beforeEach(() => {
    stubProbeAsDocument({ client_id_metadata_document_supported: true });
    delete process.env["PUBLIC_BASE_URL"];
    delete process.env["APP_URL"];
    process.env["WORKOS_AUTHKIT_DOMAIN"] = "https://auth.example.com/";
  });

  it("sends the protected-resource document as the Hono route did, byte for byte", async () => {
    const res = await wellKnown.request("http://iw.test/.well-known/oauth-protected-resource", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(
      '{"resource":"https://iw.test/api/mcp","authorization_servers":["https://auth.example.com"],' +
        '"scopes_supported":["openid","profile","email","offline_access"],' +
        '"bearer_methods_supported":["header"],' +
        '"resource_documentation":"https://iw.test/docs/features/mcp",' +
        '"agent_auth":{"identity_endpoint":"https://iw.test/api/agent/identity",' +
        '"claim_endpoint":"https://iw.test/api/agent/identity/claim",' +
        '"verification_uri":"https://iw.test/claim","identity_types_supported":["anonymous"],' +
        '"skill":"https://iw.test/auth.md"}}',
    );
  });

  it("names the missing configuration on the redirect too", async () => {
    delete process.env["WORKOS_AUTHKIT_DOMAIN"];
    const res = await wellKnown.request("/oauth-authorization-server", { redirect: "manual" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "server_error",
      error_description:
        "WORKOS_AUTHKIT_DOMAIN (or WORKOS_ISSUER) is not configured; MCP OAuth discovery is unavailable.",
    });
  });

  it("serves /auth.md as markdown on the public origin, cached for five minutes", async () => {
    const res = await root.request("http://iw.test/auth.md", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const text = await res.text();
    expect(text.startsWith("# Infrawrench agent authentication\n")).toBe(true);
    expect(text).toContain("curl -X POST https://iw.test/api/agent/identity \\\n");
    expect(text).toContain("It is **deleted 24 hours after it is created**");
    expect(text).toContain("Registration is limited to 5 workspaces per hour per address.");
    expect(text).toContain("for 15 minutes: anyone who has it can take the workspace.");
  });
});
