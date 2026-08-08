import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Jira transport tests. Four things carry real risk here:
 *
 *  - **site URL validation**, which is a security control rather than a
 *    convenience. The server makes an outbound request to whatever an org
 *    member pastes, so anything that isn't an https Atlassian host has to be
 *    refused — and suffix matching has to actually be suffix matching;
 *  - **ADF construction**, because REST v3 types `description` as a document.
 *    A plain string does not error, it silently writes raw characters into the
 *    field, so "did we build a document" is not visible at runtime;
 *  - **the create payload**, where a project key, an issue type *id*, and
 *    whitespace-free labels are what Jira accepts and anything else is a 400;
 *  - **error mapping**, since a 401 and a 403 need different words to be
 *    actionable, and Jira's own `errorMessages`/`errors` body is the only
 *    thing that explains a 400.
 *
 * Everything under test here is pure except the two fetch-driven cases, which
 * spy on `globalThis.fetch`. The DB is mocked so importing the module doesn't
 * try to open a connection.
 */

vi.mock("../encryption", () => ({
  encrypt: async () => ({ ciphertext: "CT", iv: "IV" }),
  decrypt: async () => "stored-token",
  buildAad: (...parts: string[]) => parts.join(":"),
  keyedHash: async (data: string) => `digest(${data})`,
}));

vi.mock("../db/schema", () => ({
  jiraIntegrations: { __t: "jiraIntegrations", organizationId: "organizationId" },
  jiraIssueLinks: { __t: "jiraIssueLinks", organizationId: "organizationId" },
}));

/** Rows the next `select().from(...)` chain resolves to. */
let integrationRows: unknown[] = [];

vi.mock("../db/client", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["where", "orderBy", "limit"]) self[m] = () => self;
    self["then"] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(integrationRows).then(resolve);
    return self;
  };
  return { db: { select: () => ({ from: () => chain() }) } };
});

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (c: unknown) => ({ desc: c }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  integrationRows = [];
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("{}", { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseJiraSiteUrl", () => {
  it("normalizes a site URL to a bare https origin", async () => {
    const { parseJiraSiteUrl } = await import("../jira");
    expect(parseJiraSiteUrl("https://acme.atlassian.net/").siteUrl).toBe(
      "https://acme.atlassian.net",
    );
  });

  /**
   * Users paste what they are looking at. A board URL carries the right origin,
   * so discarding the path is friendlier — and safer — than refusing it.
   */
  it("accepts a pasted board or issue URL and keeps only the origin", async () => {
    const { parseJiraSiteUrl } = await import("../jira");
    expect(parseJiraSiteUrl("https://acme.atlassian.net/browse/OPS-412").siteUrl).toBe(
      "https://acme.atlassian.net",
    );
  });

  it("accepts a bare hostname — the scheme is not the user's decision", async () => {
    const { parseJiraSiteUrl } = await import("../jira");
    expect(parseJiraSiteUrl("acme.atlassian.net").siteUrl).toBe("https://acme.atlassian.net");
  });

  it("accepts the legacy .jira.com form", async () => {
    const { parseJiraSiteUrl } = await import("../jira");
    expect(parseJiraSiteUrl("https://acme.jira.com").host).toBe("acme.jira.com");
  });

  it("rejects a non-Atlassian host", async () => {
    const { parseJiraSiteUrl } = await import("../jira");
    expect(() => parseJiraSiteUrl("https://evil.example.com")).toThrow(/not a Jira Cloud site/);
  });

  /**
   * The allowlist is suffix-matched, so a lookalike registered domain that
   * merely *contains* an allowed host must not slip through. Without this the
   * endpoint is an org-member-triggerable SSRF out of the cluster.
   */
  it("rejects a lookalike domain", async () => {
    const { parseJiraSiteUrl } = await import("../jira");
    expect(() => parseJiraSiteUrl("https://acme.atlassian.net.evil.com")).toThrow(
      /not a Jira Cloud site/,
    );
  });

  it("rejects http", async () => {
    const { parseJiraSiteUrl } = await import("../jira");
    expect(() => parseJiraSiteUrl("http://acme.atlassian.net")).toThrow(/must use https/);
  });

  it("rejects an empty value", async () => {
    const { parseJiraSiteUrl } = await import("../jira");
    expect(() => parseJiraSiteUrl("   ")).toThrow(/required/);
  });
});

describe("toAdf", () => {
  it("wraps text in a doc/paragraph/text document", async () => {
    const { toAdf } = await import("../jira");
    expect(toAdf("Order entry fails")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Order entry fails" }] }],
    });
  });

  it("splits blank-line-separated blocks into separate paragraphs", async () => {
    const { toAdf } = await import("../jira");
    const doc = toAdf("First para\n\nSecond para");
    expect(doc?.content).toHaveLength(2);
    expect(doc?.content[1]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Second para" }],
    });
  });

  it("turns a single newline into a hard break inside one paragraph", async () => {
    const { toAdf } = await import("../jira");
    const doc = toAdf("Line one\nLine two");
    expect(doc?.content).toHaveLength(1);
    expect(doc?.content[0]?.content).toEqual([
      { type: "text", text: "Line one" },
      { type: "hardBreak" },
      { type: "text", text: "Line two" },
    ]);
  });

  /**
   * A `doc` with an empty `content` array is not valid ADF, so the caller has
   * to omit the field rather than send an empty document.
   */
  it("returns null for empty or whitespace-only text", async () => {
    const { toAdf } = await import("../jira");
    expect(toAdf("")).toBeNull();
    expect(toAdf("   \n\n  ")).toBeNull();
  });
});

describe("sanitizeJiraLabels", () => {
  /** Jira rejects the whole request over one label containing a space. */
  it("replaces whitespace with hyphens", async () => {
    const { sanitizeJiraLabels } = await import("../jira");
    expect(sanitizeJiraLabels(["cost anomaly"])).toEqual(["cost-anomaly"]);
  });

  it("drops empties and de-duplicates", async () => {
    const { sanitizeJiraLabels } = await import("../jira");
    expect(sanitizeJiraLabels(["a", "", "  ", "a", "b"])).toEqual(["a", "b"]);
  });

  it("caps the number of labels", async () => {
    const { sanitizeJiraLabels } = await import("../jira");
    const many = Array.from({ length: 50 }, (_, i) => `l${i}`);
    expect(sanitizeJiraLabels(many)).toHaveLength(20);
  });

  it("returns an empty array for undefined", async () => {
    const { sanitizeJiraLabels } = await import("../jira");
    expect(sanitizeJiraLabels(undefined)).toEqual([]);
  });
});

describe("buildCreateIssuePayload", () => {
  it("nests everything under fields, with project by key and type by id", async () => {
    const { buildCreateIssuePayload } = await import("../jira");
    const payload = buildCreateIssuePayload({
      projectKey: "OPS",
      issueTypeId: "10004",
      summary: "Spend up 240%",
      description: "Baseline: $12/day",
      labels: ["infrawrench", "cost anomaly"],
    });

    expect(payload).toEqual({
      fields: {
        project: { key: "OPS" },
        issuetype: { id: "10004" },
        summary: "Spend up 240%",
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Baseline: $12/day" }] }],
        },
        labels: ["infrawrench", "cost-anomaly"],
      },
    });
  });

  /**
   * Jira validates a present-but-empty field against the project's field
   * configuration and can refuse the create over it, so absent means absent.
   */
  it("omits description and labels rather than sending empty values", async () => {
    const { buildCreateIssuePayload } = await import("../jira");
    const payload = buildCreateIssuePayload({
      projectKey: "OPS",
      issueTypeId: "10004",
      summary: "No detail",
    });
    expect(payload.fields).not.toHaveProperty("description");
    expect(payload.fields).not.toHaveProperty("labels");
  });

  it("truncates the summary to Jira's 255-character ceiling", async () => {
    const { buildCreateIssuePayload } = await import("../jira");
    const payload = buildCreateIssuePayload({
      projectKey: "OPS",
      issueTypeId: "10004",
      summary: "x".repeat(400),
    });
    expect(payload.fields["summary"]).toHaveLength(255);
  });
});

describe("basicAuthHeader", () => {
  /** The scheme Jira Cloud documents: base64 of `email:apiToken`. */
  it("base64-encodes email:token", async () => {
    const { basicAuthHeader } = await import("../jira");
    expect(basicAuthHeader("fred", "fred")).toBe("Basic ZnJlZDpmcmVk");
  });
});

describe("issueBrowseUrl", () => {
  it("builds the /browse link a human wants to click", async () => {
    const { issueBrowseUrl } = await import("../jira");
    expect(issueBrowseUrl("https://acme.atlassian.net", "OPS-412")).toBe(
      "https://acme.atlassian.net/browse/OPS-412",
    );
  });

  it("tolerates a trailing slash on the stored site URL", async () => {
    const { issueBrowseUrl } = await import("../jira");
    expect(issueBrowseUrl("https://acme.atlassian.net/", "OPS-1")).toBe(
      "https://acme.atlassian.net/browse/OPS-1",
    );
  });
});

describe("describeJiraError", () => {
  it("tells the user to check the token on 401", async () => {
    const { describeJiraError } = await import("../jira");
    expect(describeJiraError(401, "")).toMatch(/credentials \(401\)/);
  });

  it("names the missing project permissions on 403", async () => {
    const { describeJiraError } = await import("../jira");
    expect(describeJiraError(403, "")).toMatch(/Create Issues/);
  });

  /** Status alone is useless for a 400; Jira's own wording is the whole value. */
  it("surfaces errorMessages from the body", async () => {
    const { describeJiraError } = await import("../jira");
    const body = JSON.stringify({ errorMessages: ["Issue type is required."], errors: {} });
    expect(describeJiraError(400, body)).toContain("Issue type is required.");
  });

  it("surfaces per-field errors from the body", async () => {
    const { describeJiraError } = await import("../jira");
    const body = JSON.stringify({
      errorMessages: [],
      errors: { customfield_10010: "Sprint is required." },
    });
    expect(describeJiraError(400, body)).toContain("customfield_10010: Sprint is required.");
  });

  it("falls back to raw text when the body is not JSON", async () => {
    const { describeJiraError } = await import("../jira");
    expect(describeJiraError(500, "<html>gateway</html>")).toContain("gateway");
  });

  it("calls a configuration problem out on 422", async () => {
    const { describeJiraError } = await import("../jira");
    expect(describeJiraError(422, "")).toMatch(/required field with no default/);
  });
});

describe("verifyJiraCredentials", () => {
  it("calls GET /rest/api/3/myself with basic auth and returns the account", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            accountId: "5b10a2844c20165700ede21g",
            displayName: "Ops Bot",
            emailAddress: "ops@acme.com",
          }),
          { status: 200 },
        ),
    );

    const { verifyJiraCredentials } = await import("../jira");
    const account = await verifyJiraCredentials({
      siteUrl: "https://acme.atlassian.net",
      accountEmail: "ops@acme.com",
      apiToken: "tok",
    });

    expect(account.displayName).toBe("Ops Bot");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("ops@acme.com:tok", "utf8").toString("base64")}`,
    );
  });

  /**
   * This is the case Save exists to catch — a revoked or mistyped token has to
   * be reported on the form, in Jira's terms, not swallowed.
   */
  it("throws a user-readable error when Jira answers 401", async () => {
    fetchSpy.mockImplementation(async () => new Response("{}", { status: 401 }));
    const { verifyJiraCredentials, JiraApiError } = await import("../jira");

    const promise = verifyJiraCredentials({
      siteUrl: "https://acme.atlassian.net",
      accountEmail: "ops@acme.com",
      apiToken: "bad",
    });

    await expect(promise).rejects.toBeInstanceOf(JiraApiError);
    await expect(promise).rejects.toThrow(/credentials \(401\)/);
  });

  /**
   * The host is user-supplied, so "we never reached Jira" is a distinct and
   * likely outcome from "Jira said no" — and carries no HTTP status, which is
   * what the route branches on to choose 400 over 502.
   */
  it("reports an unreachable site with no status", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const { verifyJiraCredentials, JiraApiError } = await import("../jira");

    await expect(
      verifyJiraCredentials({
        siteUrl: "https://gone.atlassian.net",
        accountEmail: "ops@acme.com",
        apiToken: "tok",
      }),
    ).rejects.toMatchObject({ name: JiraApiError.name, status: null });
  });

  it("refuses a non-Atlassian site before making any request", async () => {
    const { verifyJiraCredentials } = await import("../jira");
    await expect(
      verifyJiraCredentials({
        siteUrl: "https://evil.example.com",
        accountEmail: "ops@acme.com",
        apiToken: "tok",
      }),
    ).rejects.toThrow(/not a Jira Cloud site/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("getJiraIntegration", () => {
  it("returns the redacted record, never the token", async () => {
    integrationRows = [
      {
        organizationId: "org1",
        siteUrl: "https://acme.atlassian.net",
        accountEmail: "ops@acme.com",
        encryptedApiToken: "CT",
        apiTokenIv: "IV",
        tokenHint: "…a7f2",
        defaultProjectKey: "OPS",
        defaultIssueTypeId: "10004",
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ];
    const { getJiraIntegration } = await import("../jira");
    const record = await getJiraIntegration("org1");

    expect(record).toEqual({
      siteUrl: "https://acme.atlassian.net",
      accountEmail: "ops@acme.com",
      tokenHint: "…a7f2",
      defaultProjectKey: "OPS",
      defaultIssueTypeId: "10004",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(JSON.stringify(record)).not.toContain("CT");
  });

  it("returns null when the org has no integration", async () => {
    const { getJiraIntegration } = await import("../jira");
    expect(await getJiraIntegration("org1")).toBeNull();
  });
});

describe("isJiraSourceKind", () => {
  it("accepts every kind the link table's CHECK constraint allows", async () => {
    const { isJiraSourceKind, JIRA_SOURCE_KINDS } = await import("../jira");
    for (const kind of JIRA_SOURCE_KINDS) expect(isJiraSourceKind(kind)).toBe(true);
  });

  it("rejects anything else", async () => {
    const { isJiraSourceKind } = await import("../jira");
    expect(isJiraSourceKind("something_else")).toBe(false);
  });
});
