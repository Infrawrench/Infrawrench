import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Layer } from "effect";

/**
 * Agent registration and the claim ceremony (`http/domains/agent-auth/`).
 *
 * The ceremony itself (`server-core/trials/`) has its own suites and is
 * mocked here; its error classes are the real ones, since their `status` is
 * what the wire answers. What is pinned is the gates and their order: the
 * agent's credential or the person's session first, then the per-user attempt
 * throttle, then the body, then the ceremony; and that registration, the only
 * route that opens an organization with no person behind it, needs nothing.
 */

const ceremony = {
  registerAnonymousAgent: vi.fn(),
  resolveAgentCredential: vi.fn(),
  startClaimCeremony: vi.fn(),
  getClaimStatus: vi.fn(),
  resolveClaimCode: vi.fn(),
};
vi.mock("@infrawrench/server-core/trials/ceremony", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@infrawrench/server-core/trials/ceremony")>()),
  ...ceremony,
}));

const claimTrialOrg = vi.fn();
vi.mock("@infrawrench/server-core/trials/claim", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@infrawrench/server-core/trials/claim")>()),
  claimTrialOrg: (...a: unknown[]) => claimTrialOrg(...a),
}));

const effectivePermissions = vi.fn(async (): Promise<string[]> => ["accounts:write"]);
vi.mock("@/auth/effective-permissions", () => ({
  effectivePermissions: (...a: unknown[]) => effectivePermissions(...(a as [])),
}));

const logAudit = vi.fn(async () => true);
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...(a as [])) }));

/** Rows each `db.select()` chain resolves to, in call order. */
const selects: unknown[][] = [];
vi.mock("@/db/client", () => {
  const chain = () => {
    const rows = () => Promise.resolve(selects.shift() ?? []);
    const node: Record<string, unknown> = {};
    for (const m of ["from", "where", "innerJoin"]) node[m] = () => node;
    node["limit"] = rows;
    node["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      rows().then(res, rej);
    return node;
  };
  return { db: { select: chain } };
});

const { ClaimCeremonyError, RegistrationRateLimitedError } =
  await import("@infrawrench/server-core/trials/ceremony");
const { TrialClaimError } = await import("@infrawrench/server-core/trials/claim");
const { PlanRequiredError } = await import("@infrawrench/server-core/entitlements");
const { agentAuthDomain, resetClaimAttemptsForTests } =
  await import("@/http/domains/agent-auth/index");
const { makeHttpApiHandler } = await import("@/http/server");
const { json, OrgAuth, RequestErrorsLive, SessionAuth } = await import("@/http/middleware");
const { SessionPrincipal } = await import("@/http/principal");

let sessionUserId: string | null = "user-1";
let sessionRuns = 0;
const middleware = Layer.mergeAll(
  Layer.succeed(OrgAuth)(() => Effect.succeed(json({ error: "unused" }, 500))),
  Layer.succeed(SessionAuth)((httpEffect) =>
    Effect.suspend(() => {
      sessionRuns++;
      return sessionUserId
        ? Effect.provideService(httpEffect, SessionPrincipal, {
            userId: sessionUserId,
            email: "u@example.com",
          })
        : Effect.succeed(json({ error: "Unauthorized" }, 401));
    }),
  ),
  RequestErrorsLive,
);
const handler = makeHttpApiHandler([agentAuthDomain], middleware);

function request(path: string, init?: RequestInit): Promise<Response> {
  return handler.handle(new Request(`https://app.example.com${path}`, init));
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const agent = { authorization: "Bearer iwa_good" };

beforeEach(() => {
  vi.clearAllMocks();
  selects.length = 0;
  sessionUserId = "user-1";
  sessionRuns = 0;
  resetClaimAttemptsForTests();
  delete process.env["PUBLIC_BASE_URL"];
  delete process.env["APP_URL"];
  ceremony.resolveAgentCredential.mockImplementation(async (token: string) =>
    token === "iwa_good" ? "reg-1" : null,
  );
  ceremony.registerAnonymousAgent.mockResolvedValue({
    registrationId: "reg-1",
    credential: "iwa_new",
    organizationId: "org-trial",
    trialExpiresAt: new Date("2026-11-09T00:00:00Z"),
  });
  ceremony.getClaimStatus.mockResolvedValue({
    organizationId: "org-trial",
    claimed: false,
    claimPending: true,
    trialExpiresInMs: 1000,
  });
  ceremony.resolveClaimCode.mockResolvedValue("reg-1");
  claimTrialOrg.mockResolvedValue({
    organizationId: "org-trial",
    mode: "adopt",
    accountsMoved: 0,
    historyMoved: false,
  });
});

describe("POST /api/agent/identity", () => {
  it("registers with no credential at all, the session layer never consulted", async () => {
    const res = await request(
      "/api/agent/identity",
      post({ label: "x".repeat(100) }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      registration_id: "reg-1",
      credential: "iwa_new",
      organization_id: "org-trial",
      trial_expires_at: "2026-11-09T00:00:00.000Z",
      claim_url: "https://app.example.com/claim",
      notice:
        "This workspace is a trial and will be deleted 24 hours after it was created " +
        "unless a person claims it. Start the claim ceremony with POST /api/agent/identity/claim.",
    });
    expect(ceremony.registerAnonymousAgent).toHaveBeenCalledWith({
      label: "x".repeat(80),
      ip: "203.0.113.9",
    });
    expect(sessionRuns).toBe(0);
  });

  it("counts an address that is not an IP as unknown, and takes a missing body as {}", async () => {
    const res = await request("/api/agent/identity", {
      method: "POST",
      headers: { "x-forwarded-for": "not-an-ip", "x-forwarded-proto": "http" },
    });
    expect(res.status).toBe(200);
    expect(ceremony.registerAnonymousAgent).toHaveBeenCalledWith({ ip: null });
    expect((await res.json()).claim_url).toBe("http://app.example.com/claim");
  });

  it("answers the rate limit with its own code", async () => {
    ceremony.registerAnonymousAgent.mockRejectedValue(
      new RegistrationRateLimitedError("Too many workspaces from this address."),
    );
    const res = await request("/api/agent/identity", post({}));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "Too many workspaces from this address.",
      code: "rate_limited",
    });
  });

  it("answers any other failure with the route's sentence", async () => {
    ceremony.registerAnonymousAgent.mockRejectedValue(new Error("pg down"));
    const res = await request("/api/agent/identity", post({}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not open a trial workspace." });
  });
});

describe("the agent's own polling", () => {
  it("refuses a missing or unknown credential", async () => {
    expect((await request("/api/agent/identity")).status).toBe(401);
    const res = await request("/api/agent/identity", {
      headers: { authorization: "Bearer iwa_bad" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("reports the status and the clock", async () => {
    const res = await request("/api/agent/identity", { headers: agent });
    expect(await res.json()).toEqual({
      registration_id: "reg-1",
      organization_id: "org-trial",
      claimed: false,
      claim_pending: true,
      trial_expires_in_ms: 1000,
    });
    ceremony.getClaimStatus.mockResolvedValueOnce(null);
    const gone = await request("/api/agent/identity", { headers: agent });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "Unknown registration" });
  });

  it("starts the ceremony, answering its refusals with their status", async () => {
    ceremony.startClaimCeremony.mockResolvedValueOnce({
      userCode: "ABCDEFGH",
      expiresAt: new Date("2026-11-08T12:15:00Z"),
    });
    const res = await request("/api/agent/identity/claim", { method: "POST", headers: agent });
    expect(await res.json()).toEqual({
      user_code: "ABCD-EFGH",
      verification_uri: "https://app.example.com/claim",
      verification_uri_complete: "https://app.example.com/claim?code=ABCDEFGH",
      expires_at: "2026-11-08T12:15:00.000Z",
      interval: 5,
    });
    ceremony.startClaimCeremony.mockRejectedValueOnce(
      new ClaimCeremonyError("This registration was revoked.", 403),
    );
    const revoked = await request("/api/agent/identity/claim", { method: "POST", headers: agent });
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toEqual({ error: "This registration was revoked." });
    const anonymous = await request("/api/agent/identity/claim", { method: "POST" });
    expect(anonymous.status).toBe(401);
  });
});

describe("the human half", () => {
  it("needs a session on every path under /api/agent/claim", async () => {
    sessionUserId = null;
    for (const [method, path] of [
      ["POST", "/api/agent/claim/lookup"],
      ["POST", "/api/agent/claim"],
      ["GET", "/api/agent/claim"],
      ["POST", "/api/agent/claim/nope"],
    ] as const) {
      const res = await request(path, { method });
      expect(res.status).toBe(401);
    }
    expect(ceremony.resolveClaimCode).not.toHaveBeenCalled();
  });

  it("looks a code up, offering only orgs the person may write accounts into", async () => {
    selects.push(
      [{ displayName: "Trial of Acme" }],
      [
        { id: "org-trial", displayName: "Trial of Acme" },
        { id: "org-a", displayName: "Acme" },
        { id: "org-b", displayName: "Beta" },
      ],
    );
    effectivePermissions.mockResolvedValueOnce(["accounts:write"]).mockResolvedValueOnce([]);
    const res = await request("/api/agent/claim/lookup", post({ code: "ABCD-EFGH" }));
    expect(await res.json()).toEqual({
      registrationId: "reg-1",
      workspaceName: "Trial of Acme",
      trialExpiresInMs: 1000,
      mergeTargets: [{ id: "org-a", displayName: "Acme" }],
    });
    expect(ceremony.resolveClaimCode).toHaveBeenCalledWith("ABCD-EFGH");
  });

  it("refuses a missing code, a bad code and a vanished workspace in their own words", async () => {
    let res = await request("/api/agent/claim/lookup", post("not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Enter the code your agent gave you." });

    ceremony.resolveClaimCode.mockRejectedValueOnce(
      new ClaimCeremonyError("That code doesn't look right. Ask your agent for a new one."),
    );
    res = await request("/api/agent/claim/lookup", post({ code: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "That code doesn't look right. Ask your agent for a new one.",
    });

    ceremony.getClaimStatus.mockResolvedValueOnce(null);
    res = await request("/api/agent/claim/lookup", post({ code: "ABCDEFGH" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "That workspace no longer exists." });
  });

  it("throttles a person before reading what they sent", async () => {
    for (let i = 0; i < 10; i++) {
      await request("/api/agent/claim/lookup", post({}));
    }
    // The eleventh attempt is refused even with a body that is not JSON, which
    // the confirm route would otherwise answer with a 500.
    const res = await request("/api/agent/claim", post("{"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "Too many attempts. Wait a few minutes and try again.",
    });
    expect(claimTrialOrg).not.toHaveBeenCalled();
  });

  it("confirms a merge, re-resolving the code, and audits it", async () => {
    claimTrialOrg.mockResolvedValueOnce({
      organizationId: "org-a",
      mode: "merge",
      accountsMoved: 2,
      historyMoved: true,
    });
    const res = await request(
      "/api/agent/claim",
      post({
        code: "ABCDEFGH",
        mode: "merge",
        targetOrganizationId: "org-a",
        moveHistory: true,
        registrationId: "reg-other",
      }),
    );
    expect(await res.json()).toEqual({
      organizationId: "org-a",
      mode: "merge",
      accountsMoved: 2,
      historyMoved: true,
    });
    expect(claimTrialOrg).toHaveBeenCalledWith({
      registrationId: "reg-1",
      userId: "user-1",
      mode: "merge",
      targetOrganizationId: "org-a",
      moveHistory: true,
    });
    expect(logAudit).toHaveBeenCalledWith({
      organizationId: "org-a",
      userId: "user-1",
      action: "agent.claim",
      entityType: "agent_registration",
      entityId: "reg-1",
      metadata: { mode: "merge", accountsMoved: 2, historyMoved: true },
    });
  });

  it("adopts by default, and answers each refusal with the status it carries", async () => {
    await request("/api/agent/claim", post({ code: "ABCDEFGH", mode: "other" }));
    expect(claimTrialOrg).toHaveBeenCalledWith({
      registrationId: "reg-1",
      userId: "user-1",
      mode: "adopt",
    });

    claimTrialOrg.mockRejectedValueOnce(new TrialClaimError("You lack accounts:write.", 403));
    let res = await request("/api/agent/claim", post({ code: "ABCDEFGH", mode: "merge" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You lack accounts:write." });

    claimTrialOrg.mockRejectedValueOnce(new PlanRequiredError("Upgrade to merge."));
    res = await request("/api/agent/claim", post({ code: "ABCDEFGH", mode: "merge" }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Upgrade to merge." });

    // A body that is not JSON at all was an uncaught parse error.
    res = await request("/api/agent/claim", post("{"));
    expect(res.status).toBe(500);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });
});
