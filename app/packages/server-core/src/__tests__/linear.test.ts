import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * Linear transport tests. The things that carry real risk here:
 *
 *  - **the Authorization header**, which is the part of Linear's contract that
 *    contradicts habit: personal API keys are sent bare, and adding a `Bearer`
 *    prefix — the obvious "fix" a future refactor might make — breaks every
 *    request (per https://linear.app/developers/graphql, Bearer is the OAuth
 *    form only);
 *  - **GraphQL error mapping**, because Linear can answer HTTP 200 with an
 *    `errors` array (partial success) and reports rate limiting as a
 *    `RATELIMITED` code on an HTTP 400 — treating either as success, or as a
 *    generic 400, would misreport what happened;
 *  - **the issueCreate input**, where optional fields must be absent rather
 *    than null, and the description goes through as markdown untouched (no
 *    ADF conversion — that is Jira's quirk, not Linear's);
 *  - **redaction**, since the API key must never appear in anything a route
 *    can return.
 *
 * The DB is real Drizzle over a recording driver (`fake-postgres.ts`) against
 * the real schema, so the integration lookup renders its actual SQL, same as
 * org-accounts.test.ts.
 */

vi.mock("../encryption", () => ({
  encrypt: async () => ({ ciphertext: "CT", iv: "IV" }),
  decrypt: async () => "stored-key",
  buildAad: (...parts: string[]) => parts.join(":"),
  keyedHash: async (data: string) => `digest(${data})`,
}));

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

let fetchSpy: ReturnType<typeof vi.spyOn>;

function graphqlResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

// Keys in the `linear_integrations` column order, values driver-shaped
// (timestamps as ISO strings) — see helpers/fake-postgres.ts.
const STORED_ROW = {
  organizationId: "org1",
  encryptedApiKey: "CT",
  apiKeyIv: "IV",
  keyHint: "…a7f2",
  defaultTeamId: "team-1",
  createdByUserId: null,
  createdAt: "2026-08-01T00:00:00.000",
  updatedAt: "2026-08-01T00:00:00.000",
};

beforeEach(() => {
  pg.reset();
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => graphqlResponse({ viewer: {} }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyLinearCredentials", () => {
  it("posts the viewer query to the fixed endpoint with a bare Authorization header", async () => {
    fetchSpy.mockImplementation(async () =>
      graphqlResponse({ viewer: { id: "u1", name: "Ops Bot", email: "ops@acme.com" } }),
    );

    const { verifyLinearCredentials } = await import("../linear");
    const user = await verifyLinearCredentials("lin_api_abc123");

    expect(user).toEqual({ id: "u1", name: "Ops Bot", email: "ops@acme.com" });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // The load-bearing assertion: the key exactly, with no `Bearer ` prefix.
    expect(headers["Authorization"]).toBe("lin_api_abc123");
    expect(JSON.parse(String(init.body)).query).toContain("viewer");
  });

  it("maps an AUTHENTICATION_ERROR to key-focused wording", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            errors: [
              { message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } },
            ],
          }),
          { status: 400 },
        ),
    );
    const { verifyLinearCredentials, LinearApiError } = await import("../linear");

    const promise = verifyLinearCredentials("bad-key");
    await expect(promise).rejects.toBeInstanceOf(LinearApiError);
    await expect(promise).rejects.toThrow(/rejected the API key/);
  });

  /**
   * Linear documents rate limiting as GraphQL errors with code RATELIMITED on
   * an HTTP 400 (https://linear.app/developers/rate-limiting) — it must not be
   * reported as "your input was wrong".
   */
  it("reports RATELIMITED as rate limiting, not a generic error", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
          }),
          { status: 400 },
        ),
    );
    const { verifyLinearCredentials } = await import("../linear");
    await expect(verifyLinearCredentials("key")).rejects.toThrow(/rate limiting/);
  });

  /** GraphQL can fail on an HTTP 200 — the errors array is the truth. */
  it("treats errors on an HTTP 200 as failure", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: null, errors: [{ message: "Something broke" }] }), {
          status: 200,
        }),
    );
    const { verifyLinearCredentials } = await import("../linear");
    await expect(verifyLinearCredentials("key")).rejects.toThrow(/Something broke/);
  });

  it("reports an unreachable API with no status", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const { verifyLinearCredentials, LinearApiError } = await import("../linear");
    await expect(verifyLinearCredentials("key")).rejects.toMatchObject({
      name: LinearApiError.name,
      status: null,
    });
  });

  it("refuses an empty key before making any request", async () => {
    const { verifyLinearCredentials } = await import("../linear");
    await expect(verifyLinearCredentials("   ")).rejects.toThrow(/required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("listLinearTeams", () => {
  it("returns id/key/name for the picker and drops malformed nodes", async () => {
    pg.setRows([STORED_ROW]);
    fetchSpy.mockImplementation(async () =>
      graphqlResponse({
        teams: {
          nodes: [
            { id: "t1", key: "ENG", name: "Engineering" },
            { id: "t2", name: "No key" },
          ],
        },
      }),
    );

    const { listLinearTeams } = await import("../linear");
    expect(await listLinearTeams("org1")).toEqual([{ id: "t1", key: "ENG", name: "Engineering" }]);
  });

  it("throws when Linear is not connected", async () => {
    const { listLinearTeams } = await import("../linear");
    await expect(listLinearTeams("org1")).rejects.toThrow(/not connected/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("createLinearIssue", () => {
  it("sends teamId/title/description in the issueCreate input and returns identifier + url", async () => {
    pg.setRows([STORED_ROW]);
    fetchSpy.mockImplementation(async () =>
      graphqlResponse({
        issueCreate: {
          success: true,
          issue: {
            id: "i1",
            identifier: "ENG-123",
            url: "https://linear.app/acme/issue/ENG-123",
          },
        },
      }),
    );

    const { createLinearIssue } = await import("../linear");
    const issue = await createLinearIssue({
      organizationId: "org1",
      teamId: "t1",
      title: "Cost anomaly: EC2 spend up 240%",
      description: "Baseline: $12/day",
    });

    expect(issue).toEqual({
      id: "i1",
      identifier: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(body.query).toContain("issueCreate");
    expect(body.variables.input).toEqual({
      teamId: "t1",
      title: "Cost anomaly: EC2 spend up 240%",
      // Markdown, verbatim — no ADF conversion. That is Jira's contract, not
      // Linear's, and converting here would post a JSON blob into the issue.
      description: "Baseline: $12/day",
    });
  });

  /** Absent means absent: no `description: null`, no empty labelIds array. */
  it("omits optional fields rather than sending empty values", async () => {
    pg.setRows([STORED_ROW]);
    fetchSpy.mockImplementation(async () =>
      graphqlResponse({
        issueCreate: { success: true, issue: { id: "i1", identifier: "ENG-1", url: "https://x" } },
      }),
    );

    const { createLinearIssue } = await import("../linear");
    await createLinearIssue({ organizationId: "org1", teamId: "t1", title: "No detail" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const input = (JSON.parse(String(init.body)) as { variables: { input: object } }).variables
      .input;
    expect(input).not.toHaveProperty("description");
    expect(input).not.toHaveProperty("labelIds");
    expect(input).not.toHaveProperty("projectId");
  });

  it("truncates the title to the 255-character cap", async () => {
    pg.setRows([STORED_ROW]);
    fetchSpy.mockImplementation(async () =>
      graphqlResponse({
        issueCreate: { success: true, issue: { id: "i1", identifier: "ENG-1", url: "https://x" } },
      }),
    );

    const { createLinearIssue } = await import("../linear");
    await createLinearIssue({ organizationId: "org1", teamId: "t1", title: "x".repeat(400) });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const input = (JSON.parse(String(init.body)) as { variables: { input: { title: string } } })
      .variables.input;
    expect(input.title).toHaveLength(255);
  });

  it("fails loudly when success is false or the issue is missing", async () => {
    pg.setRows([STORED_ROW]);
    fetchSpy.mockImplementation(async () => graphqlResponse({ issueCreate: { success: false } }));

    const { createLinearIssue } = await import("../linear");
    await expect(
      createLinearIssue({ organizationId: "org1", teamId: "t1", title: "t" }),
    ).rejects.toThrow(/returned no issue/);
  });

  it("requires a team and a title before making any request", async () => {
    const { createLinearIssue } = await import("../linear");
    await expect(
      createLinearIssue({ organizationId: "org1", teamId: " ", title: "t" }),
    ).rejects.toThrow(/team is required/);
    await expect(
      createLinearIssue({ organizationId: "org1", teamId: "t1", title: "  " }),
    ).rejects.toThrow(/title is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("getLinearIntegration", () => {
  it("returns the redacted record, never the key", async () => {
    pg.setRows([STORED_ROW]);
    const { getLinearIntegration } = await import("../linear");
    const record = await getLinearIntegration("org1");

    expect(record).toEqual({
      keyHint: "…a7f2",
      defaultTeamId: "team-1",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(JSON.stringify(record)).not.toContain("CT");
  });

  it("returns null when the org has no integration", async () => {
    const { getLinearIntegration } = await import("../linear");
    expect(await getLinearIntegration("org1")).toBeNull();
  });
});

describe("describeLinearGraphqlErrors", () => {
  it("joins plain error messages", async () => {
    const { describeLinearGraphqlErrors } = await import("../linear");
    expect(
      describeLinearGraphqlErrors([{ message: "Team not found" }, { message: "Bad input" }]),
    ).toContain("Team not found; Bad input");
  });
});

describe("isLinearSourceKind", () => {
  it("accepts every kind the link table's CHECK constraint allows", async () => {
    const { isLinearSourceKind, LINEAR_SOURCE_KINDS } = await import("../linear");
    for (const kind of LINEAR_SOURCE_KINDS) expect(isLinearSourceKind(kind)).toBe(true);
  });

  it("rejects anything else", async () => {
    const { isLinearSourceKind } = await import("../linear");
    expect(isLinearSourceKind("something_else")).toBe(false);
  });
});
