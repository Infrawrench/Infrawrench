import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * Inbound Slack endpoints. Crypto (signature scheme, link tokens) is covered
 * by server-core's slack tests; what is pinned here is the route-level
 * security ordering and the wiring:
 *
 *  - nothing runs before the signature check, and nothing at all without the
 *    signing secret;
 *  - an unmapped Slack user gets a link prompt, never data;
 *  - each surface enforces the same permission as its web equivalent
 *    (costs:read, resources:read, workflows:approve, chat:write + ownership);
 *  - approval buttons decide through decideWorkflowApproval / the chat
 *    pending-action transitions — the exact code paths the web UI uses.
 */

/* ---------------------------------------------------------------- mocks -- */

const t = (name: string, cols: string[]) => {
  const table: Record<string, string> = { __t: name };
  for (const c of cols) table[c] = `${name}.${c}`;
  return table;
};

vi.mock("@/db/schema", () => ({
  slackInstallations: t("slackInstallations", ["organizationId", "teamId", "deletedAt"]),
  organizations: t("organizations", ["id", "displayName"]),
  slackUserLinks: t("slackUserLinks", ["id", "organizationId", "teamId", "slackUserId", "userId"]),
  organizationMembers: t("organizationMembers", ["id", "userId", "organizationId"]),
  users: t("users", ["id", "email", "displayName"]),
  resources: t("resources", ["id", "displayName", "organizationId", "deletedAt"]),
  accounts: t("accounts", ["id", "displayName"]),
  resourceChanges: t("resourceChanges", ["resourceId", "changeKind", "diff", "createdAt"]),
  chatPendingActions: t("chatPendingActions", ["id", "conversationId"]),
  chatConversations: t("chatConversations", ["id"]),
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  desc: (c: unknown) => ({ desc: c }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  ilike: (a: unknown, b: unknown) => ({ ilike: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  isNull: (c: unknown) => ({ isNull: c }),
  or: (...a: unknown[]) => ({ or: a }),
}));

/** Rows per table sentinel; joined shapes are stored pre-joined. */
const tableRows: Record<string, unknown[]> = {};
const inserted: Array<{ table: string; values: unknown }> = [];
const updated: Array<{ table: string; set: Record<string, unknown> }> = [];
let deletedReturning: unknown[] = [];

vi.mock("@/db/client", () => {
  const chain = (rows: () => unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ["where", "innerJoin", "leftJoin", "orderBy"]) self[m] = () => self;
    self["limit"] = () => Promise.resolve(rows());
    self["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej);
    return self;
  };
  return {
    db: {
      select: () => ({
        from: (table: { __t: string }) => chain(() => tableRows[table.__t] ?? []),
      }),
      insert: (table: { __t: string }) => ({
        values: (v: unknown) => {
          inserted.push({ table: table.__t, values: v });
          return { onConflictDoUpdate: () => Promise.resolve() };
        },
      }),
      update: (table: { __t: string }) => ({
        set: (s: Record<string, unknown>) => {
          updated.push({ table: table.__t, set: s });
          return { where: () => Promise.resolve() };
        },
      }),
      delete: () => ({
        where: () => ({ returning: () => Promise.resolve(deletedReturning) }),
      }),
    },
  };
});

let inboundConfigured = true;
const verifySignature = vi.fn();
const postToSlackResponseUrl = vi.fn();
const verifySlackLinkToken = vi.fn();
vi.mock("@infrawrench/server-core/slack", () => ({
  isSlackInboundConfigured: () => inboundConfigured,
  verifySlackRequestSignature: (...a: unknown[]) => verifySignature(...a),
  signSlackLinkToken: (req: { organizationId: string }) => `tok-${req.organizationId}`,
  verifySlackLinkToken: (...a: unknown[]) => verifySlackLinkToken(...a),
  postToSlackResponseUrl: (...a: unknown[]) => postToSlackResponseUrl(...a),
  escapeMrkdwn: (s: string) => s,
}));

vi.mock("@infrawrench/server-core/slack-approvals", () => ({
  SLACK_APPROVE_ACTION_ID: "infrawrench_approval_approve",
  SLACK_DENY_ACTION_ID: "infrawrench_approval_deny",
  SLACK_STATUS_PICK_ACTION_ID: "infrawrench_status_pick",
  parseSlackApprovalButtonValue: (raw: unknown) => {
    if (typeof raw !== "string") return null;
    try {
      const p = JSON.parse(raw) as { k?: string; a?: string; o?: string };
      if ((p.k !== "workflow" && p.k !== "chat") || !p.a || !p.o) return null;
      return { kind: p.k, approvalId: p.a, organizationId: p.o };
    } catch {
      return null;
    }
  },
}));

let memberPermissions: string[] = ["*"];
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: vi.fn(async () => ({ permissions: memberPermissions, role: null })),
}));
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({
  hasPermission: (granted: string[], required: string) =>
    granted.includes("*") || granted.includes(required),
}));

const decideWorkflowApproval = vi.fn();
vi.mock("@infrawrench/server-core/workflows/approvals", () => ({
  decideWorkflowApproval: (...a: unknown[]) => decideWorkflowApproval(...a),
}));

vi.mock("@infrawrench/client-core", () => ({
  formatMoney: (amount: number, currency: string) => `${currency} ${amount.toFixed(2)}`,
}));

const runCostQuery = vi.fn();
vi.mock("@/services/cost-query", () => ({
  CostQueryError: class CostQueryError extends Error {},
  runCostQuery: (...a: unknown[]) => runCostQuery(...a),
}));

vi.mock("@/plugins/loader", () => ({
  getPlugin: vi.fn(async () => ({
    plugin: {
      manifest: { displayName: "Amazon Web Services" },
      resourceTypes: [{ id: "ec2-instance", displayName: "EC2 instance" }],
    },
  })),
}));

const executePendingAction = vi.fn();
const rejectPendingAction = vi.fn();
const runAgentTurn = vi.fn((..._a: unknown[]) => (async function* () {})());
vi.mock("@/chat/agent", () => ({
  executePendingAction: (...a: unknown[]) => executePendingAction(...a),
  rejectPendingAction: (...a: unknown[]) => rejectPendingAction(...a),
  runAgentTurn: (...a: unknown[]) => runAgentTurn(...a),
}));

const noteChatToolApprovalDecided = vi.fn();
vi.mock("@/chat/slack-approvals", () => ({
  noteChatToolApprovalDecided: (...a: unknown[]) => noteChatToolApprovalDecided(...a),
}));

let sessionUserId: string | null = null;
vi.mock("@/api/auth-middleware", () => ({
  sessionMiddleware: async (
    c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response },
    next: () => Promise<void>,
  ) => {
    if (!sessionUserId) return c.json({ error: "Unauthorized" }, 401);
    c.set("session", { userId: sessionUserId, email: "astrid@example.com" });
    return next();
  },
}));

const { slackInboundRoutes } = await import("@/api/routes/slack-inbound");

/* -------------------------------------------------------------- helpers -- */

const app = new Hono().route("/api", slackInboundRoutes);

async function commandRequest(text: string, signature = "good"): Promise<Response> {
  const body = new URLSearchParams({
    team_id: "T1",
    user_id: "U1",
    command: "/infrawrench",
    text,
  }).toString();
  return app.request("/api/slack/commands", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": "1722700000",
    },
    body,
  });
}

async function interactionRequest(
  actionId: string,
  value: unknown,
  signature = "good",
): Promise<Response> {
  const payload = {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: "U1" },
    response_url: "https://hooks.slack.example/respond",
    actions: [
      { action_id: actionId, value: typeof value === "string" ? value : JSON.stringify(value) },
    ],
  };
  return app.request("/api/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": "1722700000",
    },
    body: `payload=${encodeURIComponent(JSON.stringify(payload))}`,
  });
}

const APPROVAL_VALUE = { k: "workflow", a: "ap-1", o: "org-1" };

function linkedAstrid(): void {
  tableRows["slackUserLinks"] = [
    {
      organizationId: "org-1",
      userId: "user-1",
      email: "astrid@example.com",
      displayName: "Astrid",
    },
  ];
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  inboundConfigured = true;
  memberPermissions = ["*"];
  sessionUserId = null;
  deletedReturning = [];
  inserted.length = 0;
  updated.length = 0;
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows["slackInstallations"] = [{ organizationId: "org-1", orgName: "Acme" }];
  tableRows["slackUserLinks"] = [];
  verifySignature.mockReturnValue(true);
  decideWorkflowApproval.mockResolvedValue({ outcome: "decided", approval: {} });
  executePendingAction.mockResolvedValue({ allResolved: true });
  rejectPendingAction.mockResolvedValue({ allResolved: true });
  postToSlackResponseUrl.mockResolvedValue(undefined);
  process.env["APP_URL"] = "https://app.example.com";
});

/* ---------------------------------------------------------------- tests -- */

describe("POST /api/slack/commands — authentication", () => {
  it("refuses everything when no signing secret is configured", async () => {
    inboundConfigured = false;
    const res = await commandRequest("costs");
    expect(res.status).toBe(503);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it("rejects a bad signature before doing any work", async () => {
    verifySignature.mockReturnValue(false);
    const res = await commandRequest("costs", "forged");
    expect(res.status).toBe(401);
    expect(runCostQuery).not.toHaveBeenCalled();
  });

  it("verifies the signature over the raw body", async () => {
    await commandRequest("help");
    const arg = verifySignature.mock.calls[0]![0] as { rawBody: string; signature: string };
    expect(arg.rawBody).toContain("text=help");
    expect(arg.signature).toBe("good");
  });
});

describe("POST /api/slack/commands — identity", () => {
  it("gives an unlinked user a link prompt instead of data", async () => {
    const res = await commandRequest("costs");
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("isn't linked");
    expect(body).toContain("/api/slack/link?token=tok-org-1");
    expect(runCostQuery).not.toHaveBeenCalled();
  });

  it("tells a workspace that was never connected to connect first", async () => {
    tableRows["slackInstallations"] = [];
    const res = await commandRequest("costs");
    const body = JSON.stringify(await res.json());
    expect(body).toContain("isn't connected");
  });

  it("ignores a link whose user is no longer an org member", async () => {
    // linkedMembers inner-joins organization_members; the fake models the
    // post-join result, so an ex-member is simply an empty join result.
    tableRows["slackUserLinks"] = [];
    const res = await commandRequest("status prod");
    expect(JSON.stringify(await res.json())).toContain("isn't linked");
  });
});

describe("/infrawrench costs", () => {
  beforeEach(() => {
    linkedAstrid();
    runCostQuery.mockResolvedValue({
      series: [
        {
          key: "ec2",
          label: "EC2",
          currency: "USD",
          points: [{ bucket: "2026-08-01", amount: 40 }],
        },
      ],
      currencies: ["USD"],
      totals: { USD: 40 },
      previousTotals: { USD: 20 },
    });
  });

  it("replies ephemerally with the month-to-date summary", async () => {
    const res = await commandRequest("costs");
    const body = (await res.json()) as { response_type: string };
    expect(body.response_type).toBe("ephemeral");
    const text = JSON.stringify(body);
    expect(text).toContain("USD 40.00");
    expect(text).toContain("EC2");
    expect(text).toContain("▲ 100%");
    // Month-to-date: from the 1st of the current month through today.
    const req = runCostQuery.mock.calls[0]![1] as { from: string; to: string };
    expect(req.from.endsWith("-01")).toBe(true);
    expect(req.to >= req.from).toBe(true);
  });

  it("requires costs:read", async () => {
    memberPermissions = ["resources:read"];
    const res = await commandRequest("costs");
    expect(JSON.stringify(await res.json())).toContain("costs:read");
    expect(runCostQuery).not.toHaveBeenCalled();
  });
});

describe("/infrawrench status", () => {
  beforeEach(() => {
    linkedAstrid();
  });

  it("requires resources:read", async () => {
    memberPermissions = ["costs:read"];
    const res = await commandRequest("status prod");
    expect(JSON.stringify(await res.json())).toContain("resources:read");
  });

  it("answers directly when one resource clearly matches", async () => {
    tableRows["resources"] = [
      {
        id: "r1",
        displayName: "prod-db",
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
        accountId: "acc-1",
        lastSyncedAt: new Date(Date.now() - 5 * 60_000),
        deletedAt: null,
      },
    ];
    tableRows["accounts"] = [{ displayName: "Production" }];
    tableRows["resourceChanges"] = [];
    const res = await commandRequest("status prod-db");
    const text = JSON.stringify(await res.json());
    expect(text).toContain("prod-db");
    expect(text).toContain("EC2 instance");
    expect(text).toContain("minutes ago");
  });

  it("offers disambiguation buttons when several resources match", async () => {
    tableRows["resources"] = [
      { id: "r1", displayName: "prod-db-primary", deletedAt: null },
      { id: "r2", displayName: "prod-db-replica", deletedAt: null },
    ];
    const res = await commandRequest("status db");
    const body = (await res.json()) as { blocks: Array<{ type: string; elements?: unknown[] }> };
    const actions = body.blocks.find((b) => b.type === "actions");
    expect(actions?.elements).toHaveLength(2);
    expect(JSON.stringify(actions)).toContain("infrawrench_status_pick");
  });

  it("says so when nothing matches", async () => {
    tableRows["resources"] = [];
    const res = await commandRequest("status nothing-here");
    expect(JSON.stringify(await res.json())).toContain("No resource matching");
  });
});

describe("POST /api/slack/interactions — workflow approval buttons", () => {
  it("rejects a bad signature", async () => {
    verifySignature.mockReturnValue(false);
    const res = await interactionRequest("infrawrench_approval_approve", APPROVAL_VALUE, "forged");
    expect(res.status).toBe(401);
    expect(decideWorkflowApproval).not.toHaveBeenCalled();
  });

  it("sends an unlinked clicker the link prompt, decides nothing", async () => {
    const res = await interactionRequest("infrawrench_approval_approve", APPROVAL_VALUE);
    expect(res.status).toBe(200);
    expect(decideWorkflowApproval).not.toHaveBeenCalled();
    expect(JSON.stringify(postToSlackResponseUrl.mock.calls[0])).toContain("isn't linked");
  });

  it("decides through decideWorkflowApproval — the web UI's code path", async () => {
    linkedAstrid();
    await interactionRequest("infrawrench_approval_approve", APPROVAL_VALUE);
    expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "org-1",
      "ap-1",
      "approved",
      { userId: "user-1", name: "Astrid" },
      { decidedVia: "Slack" },
    );
  });

  it("maps the Deny button to a denial", async () => {
    linkedAstrid();
    await interactionRequest("infrawrench_approval_deny", APPROVAL_VALUE);
    expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "org-1",
      "ap-1",
      "denied",
      expect.anything(),
      { decidedVia: "Slack" },
    );
  });

  it("requires workflows:approve, exactly like the web decision route", async () => {
    linkedAstrid();
    memberPermissions = ["workflows:read", "workflows:write"];
    await interactionRequest("infrawrench_approval_approve", APPROVAL_VALUE);
    expect(decideWorkflowApproval).not.toHaveBeenCalled();
    expect(JSON.stringify(postToSlackResponseUrl.mock.calls[0])).toContain("workflows:approve");
  });

  it("tells the losing racer the request was already decided", async () => {
    linkedAstrid();
    decideWorkflowApproval.mockResolvedValue({ outcome: "conflict" });
    await interactionRequest("infrawrench_approval_approve", APPROVAL_VALUE);
    expect(JSON.stringify(postToSlackResponseUrl.mock.calls[0])).toContain("already been decided");
  });

  it("ignores a malformed button value", async () => {
    linkedAstrid();
    const res = await interactionRequest("infrawrench_approval_approve", "not-json{");
    expect(res.status).toBe(200);
    expect(decideWorkflowApproval).not.toHaveBeenCalled();
  });
});

describe("POST /api/slack/interactions — chat tool approval buttons", () => {
  const CHAT_VALUE = { k: "chat", a: "pa-1", o: "org-1" };

  function pendingRow(ownerId: string, status = "pending"): void {
    tableRows["chatPendingActions"] = [
      {
        pending: {
          id: "pa-1",
          conversationId: "conv-1",
          toolName: "delete_resource",
          toolInput: { resourceId: "r1" },
          status,
        },
        conversation: { id: "conv-1", organizationId: "org-1", userId: ownerId },
      },
    ];
  }

  it("lets the conversation owner approve; executes and resumes the agent", async () => {
    linkedAstrid();
    pendingRow("user-1");
    await interactionRequest("infrawrench_approval_approve", CHAT_VALUE);
    await flushAsync();
    // Claimed through the same approved → executed transition as the web route.
    expect(updated).toContainEqual({ table: "chatPendingActions", set: { status: "approved" } });
    expect(executePendingAction).toHaveBeenCalledWith(
      "pa-1",
      expect.objectContaining({ userId: "user-1", organizationId: "org-1", source: "chat" }),
    );
    expect(noteChatToolApprovalDecided).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved", via: "Slack", decidedByName: "Astrid" }),
    );
    // allResolved → the agent turn resumes so the outcome lands in the chat.
    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1" }),
    );
  });

  it("refuses anyone but the conversation owner", async () => {
    linkedAstrid();
    pendingRow("someone-else");
    await interactionRequest("infrawrench_approval_approve", CHAT_VALUE);
    await flushAsync();
    expect(executePendingAction).not.toHaveBeenCalled();
    expect(updated).toHaveLength(0);
    expect(JSON.stringify(postToSlackResponseUrl.mock.calls[0])).toContain("conversation owner");
  });

  it("requires chat:write even for the owner", async () => {
    linkedAstrid();
    memberPermissions = ["workflows:approve"];
    pendingRow("user-1");
    await interactionRequest("infrawrench_approval_approve", CHAT_VALUE);
    await flushAsync();
    expect(executePendingAction).not.toHaveBeenCalled();
    expect(JSON.stringify(postToSlackResponseUrl.mock.calls[0])).toContain("chat:write");
  });

  it("denies through rejectPendingAction and resumes so the agent hears it", async () => {
    linkedAstrid();
    pendingRow("user-1");
    await interactionRequest("infrawrench_approval_deny", CHAT_VALUE);
    await flushAsync();
    expect(rejectPendingAction).toHaveBeenCalledWith("pa-1", "Denied from Slack by Astrid.");
    expect(executePendingAction).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalled();
  });

  it("refuses an already-resolved action", async () => {
    linkedAstrid();
    pendingRow("user-1", "executed");
    await interactionRequest("infrawrench_approval_approve", CHAT_VALUE);
    await flushAsync();
    expect(executePendingAction).not.toHaveBeenCalled();
    expect(JSON.stringify(postToSlackResponseUrl.mock.calls[0])).toContain("already been resolved");
  });
});

describe("GET /api/slack/link", () => {
  it("bounces a signed-out browser through sign-in and back", async () => {
    const res = await app.request("/api/slack/link?token=abc");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/api/auth/sign-in");
    expect(decodeURIComponent(location)).toContain("/api/slack/link?token=abc");
  });

  it("stores the mapping for a signed-in org member", async () => {
    sessionUserId = "user-1";
    verifySlackLinkToken.mockReturnValue({
      organizationId: "org-1",
      teamId: "T1",
      slackUserId: "U1",
    });
    tableRows["organizationMembers"] = [{ id: "m1" }];
    const res = await app.request("/api/slack/link?token=abc", {
      headers: { cookie: "wos-session=sealed" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("slack=linked");
    expect(inserted[0]).toMatchObject({
      table: "slackUserLinks",
      values: expect.objectContaining({
        organizationId: "org-1",
        teamId: "T1",
        slackUserId: "U1",
        userId: "user-1",
      }),
    });
  });

  it("refuses a token for an org the user is not a member of", async () => {
    sessionUserId = "user-1";
    verifySlackLinkToken.mockReturnValue({
      organizationId: "org-2",
      teamId: "T1",
      slackUserId: "U1",
    });
    tableRows["organizationMembers"] = [];
    const res = await app.request("/api/slack/link?token=abc", {
      headers: { cookie: "wos-session=sealed" },
    });
    expect(res.headers.get("location")).toContain("slack=error");
    expect(inserted).toHaveLength(0);
  });

  it("rejects an invalid or expired token", async () => {
    sessionUserId = "user-1";
    verifySlackLinkToken.mockReturnValue(null);
    const res = await app.request("/api/slack/link?token=stale", {
      headers: { cookie: "wos-session=sealed" },
    });
    expect(res.headers.get("location")).toContain("slack=error");
    expect(inserted).toHaveLength(0);
  });
});
