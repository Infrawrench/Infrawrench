import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `jit`, `leaks` and `vulns` on effect/cli: text and `--json` output, the
// shared `--reason` / `--status` flags, refusals and exit codes, against
// fixtures. Nothing reaches a network or a database.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [{ id: "org_1", displayName: "Acme", role: "admin" }]),
  getAuthStatus: vi.fn(async () => ({ authenticated: true, email: "ada@example.com" })),
  clearStoredTokens: vi.fn(),
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const NOW = new Date("2026-11-08T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** One command line, its output on its own: a test may run several. */
const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The bodies of the requests made with `method`, parsed. */
const sentBodies = (method: string) =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body)));

// ---------------------------------------------------------------------------
// jit
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString();

const jitRequest = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  policyId: "pol_1",
  policyName: "Prod",
  accountId: "acc_1",
  accountName: "prod",
  pluginId: "aws",
  scopeId: "sc_1",
  scopeName: "payments",
  roleId: "role_1",
  roleName: "Admin",
  userId: "u1",
  userName: "Ada",
  principalId: "p1",
  principalName: "ada@acme",
  principalKind: "user",
  principalMatched: true,
  reason: "Rolling back INC-42",
  ticket: null,
  durationMinutes: 120,
  status,
  requestExpiresAt: iso(30 * 60_000),
  decidedAt: null,
  decidedByUserId: null,
  decidedByName: null,
  decisionNote: null,
  selfApproved: false,
  incidentId: null,
  grantedAt: null,
  grantExpiresAt: iso(2 * HOUR),
  preexisting: false,
  extendedMinutes: 0,
  endedAt: null,
  endedByName: null,
  endReason: null,
  lastError: null,
  revokeAttempts: 0,
  createdAt: iso(-HOUR),
  canDecide: true,
  canCancel: true,
  canExtend: true,
  canRevoke: true,
  ...over,
});

const REQUESTS = [
  jitRequest("req_aaaa1111", "pending", { userName: null }),
  jitRequest("req_bbbb2222", "active", { extendedMinutes: 30 }),
  jitRequest("req_cccc3333", "active", { preexisting: true, accountName: null }),
  jitRequest("req_dddd4444", "revoke_failed", { revokeAttempts: 3 }),
  jitRequest("req_eeee5555", "revoked", { endReason: "revoked", durationMinutes: 45 }),
  jitRequest("req_ffff6666", "revoked", { endReason: "expired", durationMinutes: 0 }),
  jitRequest("req_gggg7777", "granting", { durationMinutes: 90 }),
  jitRequest("req_hhhh8888", "denied", { requestExpiresAt: iso(-3 * 86_400_000) }),
  jitRequest("req_iiii9999", "timed_out"),
  jitRequest("req_jjjj0000", "cancelled"),
  jitRequest("req_kkkk1111", "grant_failed"),
  jitRequest("req_llll2222", "revoking"),
];

const target = (scopeId: string, scopeName: string, roleId: string, roleName: string) => ({
  scopeId,
  scopeName,
  roleId,
  roleName,
});

const policy = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  description: null,
  enabled: true,
  accountId: "acc_1",
  accountName: "prod",
  pluginId: "aws",
  targets: [
    target("sc_1", "payments", "role_1", "Admin"),
    target("sc_2", "search", "role_1", "Admin"),
    target("sc_1", "payments", "role_2", "ReadOnly"),
  ],
  maxDurationMinutes: 240,
  defaultDurationMinutes: 60,
  requestTimeoutMinutes: 30,
  requesterUserIds: [],
  requesterRoleIds: [],
  approverUserIds: [],
  approverRoleIds: [],
  approverOnCallScheduleIds: [],
  allowSelfApprovalDuringIncident: false,
  requireReason: true,
  requireTicket: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  canRequest: true,
  ...over,
});

const POLICIES = [
  policy("pol_1", "Prod"),
  policy("pol_2", "Prod readonly", {
    canRequest: false,
    enabled: false,
    accountName: null,
    maxDurationMinutes: 90,
  }),
  policy("pol_3", "Staging", { maxDurationMinutes: 45 }),
];

const PRINCIPAL = {
  principal: { id: "p1", name: "ada@acme" },
  canPick: true,
  labels: { principalLabel: "IAM user" },
};

describe("jit", () => {
  it("lists the queue, with the filters passed through", async () => {
    serveRoutes(out, {
      "GET /jit-access/requests": REQUESTS,
      "GET /jit-access/requests?status=active&mine=1&holding=1": [],
    });
    expect(await cli("jit")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 2 active, 1 waiting · 1 failed to revoke

      ID        WHO      ROLE   WHERE            FOR   STATUS            CLOCK   REASON             
      req_aaaa  unknown  Admin  payments (prod)  2h    waiting           in 30m  Rolling back INC-42
      req_bbbb  Ada      Admin  payments (prod)  2.5h  ACTIVE            in 2h   Rolling back INC-42
      req_cccc  Ada      Admin  payments         2h    already held      in 2h   Rolling back INC-42
      req_dddd  Ada      Admin  payments (prod)  2h    REVOKE FAILED ×3  —       Rolling back INC-42
      req_eeee  Ada      Admin  payments (prod)  45m   ended early       —       Rolling back INC-42
      req_ffff  Ada      Admin  payments (prod)  —     ended             —       Rolling back INC-42
      req_gggg  Ada      Admin  payments (prod)  1.5h  granting          in 2h   Rolling back INC-42
      req_hhhh  Ada      Admin  payments (prod)  2h    denied            —       Rolling back INC-42
      req_iiii  Ada      Admin  payments (prod)  2h    timed out         —       Rolling back INC-42
      req_jjjj  Ada      Admin  payments (prod)  2h    cancelled         —       Rolling back INC-42
      req_kkkk  Ada      Admin  payments (prod)  2h    grant failed      —       Rolling back INC-42
      req_llll  Ada      Admin  payments (prod)  2h    revoking          —       Rolling back INC-42
      "
    `);
    expect(await cli("jit", "list", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", requests: REQUESTS }));
    expect(await cli("jit", "--status", "active", "--mine", "--holding")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No just-in-time access requests. Ask for one with \`infrawrench jit request\`.
      "
    `);
  });

  it("lists the policies", async () => {
    serveRoutes(out, { "GET /jit-access/policies": POLICIES });
    expect(await cli("jit", "policies")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Prod · prod · up to 4h
        Admin on payments
        Admin on search
        ReadOnly on payments
      Prod readonly · acc_1 · up to 1.5h (you cannot request under this one) (off)
        Admin on payments
        Admin on search
        ReadOnly on payments
      Staging · prod · up to 45m
        Admin on payments
        Admin on search
        ReadOnly on payments
      "
    `);
    expect(await cli("jit", "policies", "--json")).toBe(0);
    serveRoutes(out, { "GET /jit-access/policies": [] });
    expect(await cli("jit", "policies")).toBe(0);
  });

  it("requests a role", async () => {
    const created = jitRequest("req_new00001", "pending");
    serveRoutes(out, {
      "GET /jit-access/policies": POLICIES,
      "GET /jit-access/policies/pol_1/principal": PRINCIPAL,
      "POST /jit-access/requests": created,
    });
    const line = [
      "jit",
      "request",
      "--policy",
      "prod",
      "--role",
      "admin",
      "--scope",
      "pay",
      "--for",
      "2h",
      "--reason",
      "Rolling back INC-42",
      "--ticket",
      "INC-42",
    ];
    expect(await cli(...line)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Requested Admin on payments for 2h (req_new0, granted to ada@acme). Approvers have been notified.
      "
    `);
    expect(sentBodies("POST")).toEqual([
      {
        policyId: "pol_1",
        scopeId: "sc_1",
        roleId: "role_1",
        durationMinutes: 120,
        reason: "Rolling back INC-42",
        ticket: "INC-42",
      },
    ]);
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      "x-infrawrench-client": "cli",
    });
    expect(await cli(...line, "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", request: created }));
  });

  it("refuses a request it cannot place", async () => {
    serveRoutes(out, {
      "GET /jit-access/policies": POLICIES,
      "GET /jit-access/policies/pol_3/principal": { ...PRINCIPAL, principal: null },
    });
    const base = ["jit", "request", "--for", "2h", "--reason", "why not"];
    expect(await cli("jit", "request", "--policy", "prod")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Usage: infrawrench jit request --policy <name> --role <name> [--scope <name>] --for 2h --reason "…" [--ticket <ref>]
      "
    `);
    expect(await cli(...base, "--policy", "nope", "--role", "admin")).toBe(1);
    expect(await cli(...base, "--policy", "pro", "--role", "admin")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Several roles match; add --scope. Matches: Admin on payments; Admin on search
      "
    `);
    expect(await cli(...base, "--policy", "prod", "--role", "admin")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Several roles match; add --scope. Matches: Admin on payments; Admin on search
      "
    `);
    expect(await cli(...base, "--policy", "prod", "--role", "owner")).toBe(1);
    expect(await cli(...base, "--policy", "staging", "--role", "readonly")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "No IAM user matches your email address. Request this from the app, where you can pick yourself from the provider's list.
      "
    `);
    serveRoutes(out, {
      "GET /jit-access/policies": POLICIES,
      "GET /jit-access/policies/pol_1/principal": PRINCIPAL,
    });
    expect(
      await cli(
        "jit",
        "request",
        "--policy",
        "prod",
        "--role",
        "readonly",
        "--for",
        "soon",
        "--reason",
        "x",
      ),
    ).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "--for must look like 30m or 2h, got "soon"
      "
    `);
  });

  it("decides, cancels, extends and revokes a request by id prefix", async () => {
    const routes: Record<string, unknown> = { "GET /jit-access/requests": REQUESTS };
    for (const verb of ["approve", "deny", "cancel", "revoke"]) {
      routes[`POST /jit-access/requests/req_aaaa1111/${verb}`] = jitRequest(
        "req_aaaa1111",
        "denied",
      );
    }
    routes["POST /jit-access/requests/req_bbbb2222/extend"] = jitRequest("req_bbbb2222", "active", {
      lastError: "provider slow",
      grantExpiresAt: "2026-11-08T15:00:00.000Z",
    });
    serveRoutes(out, routes);
    expect(await cli("jit", "approve", "req_aaaa", "--note", "ok")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Admin on payments for Ada: denied
      "
    `);
    expect(await cli("jit", "deny", "req_aaaa")).toBe(0);
    expect(await cli("jit", "cancel", "req_aaaa", "--json")).toBe(0);
    expect(await cli("jit", "revoke", "req_aaaa1111")).toBe(0);
    expect(await cli("jit", "extend", "req_bbbb", "--by", "30m")).toBe(0);
    expect(sentBodies("POST")).toEqual([{ note: "ok" }, {}, {}, {}, { minutes: 30 }]);
  });

  it("refuses a missing, unknown or ambiguous id, and a missing --by", async () => {
    serveRoutes(out, { "GET /jit-access/requests": REQUESTS });
    expect(await cli("jit", "approve")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Give the request id (from \`infrawrench jit\`).
      "
    `);
    expect(await cli("jit", "cancel", "nope")).toBe(1);
    expect(await cli("jit", "revoke", "req_")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      ""req_" matches 12 requests; give more of the id.
      "
    `);
    expect(await cli("jit", "extend", "req_bbbb")).toBe(2);
    expect(await cli("jit", "extend", "req_bbbb", "--by", "1.5m")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "--by must be a whole number of minutes, got "1.5m"
      "
    `);
  });

  it("renders a status this build does not know as its word", async () => {
    serveRoutes(out, { "GET /jit-access/requests": [jitRequest("req_zzzz", "suspended")] });
    expect(await cli("jit")).toBe(0);
    expect(out.stdout).toContain("suspended");
  });
});

// ---------------------------------------------------------------------------
// leaks
// ---------------------------------------------------------------------------

const leak = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "open",
  scannerAccountId: "gh_1",
  scannerAccountName: "acme (GitHub)",
  scannerPluginId: "github",
  tokenType: "aws_access_key",
  tokenTypeLabel: "AWS access key",
  ownerPluginId: "aws",
  ownerPluginName: "AWS",
  secretHint: "AKIA…WXYZ",
  repository: "acme/api",
  path: "src/config.ts",
  line: 12,
  commitSha: "abc",
  url: "https://github.com/acme/api/security/secret-scanning/1",
  upstreamState: "open",
  upstreamResolution: null,
  validity: "active",
  publiclyLeaked: false,
  detectedAt: "2026-11-07T10:00:00.000Z",
  firstSeenAt: "2026-11-07T10:00:00.000Z",
  matchKind: "account",
  matchConfidence: "fingerprint",
  matchedAccountId: "acc_1",
  matchedAccountName: "prod",
  matchedResourceId: null,
  matchedResourceName: null,
  matchedResourceTypeId: null,
  matchedPluginId: "aws",
  matchedFieldKey: null,
  candidateAccountIds: [],
  rotation: { mode: "reissue", manageUrl: null },
  rotatedAt: null,
  rotatedBy: null,
  rotationMethod: null,
  dismissedReason: null,
  dismissedComment: null,
  dismissedAt: null,
  dismissedBy: null,
  upstreamResolvedAt: null,
  upstreamResolveError: null,
  canResolveUpstream: true,
  ...over,
});

const LEAKS = [
  leak("lk_aaaa1111"),
  leak("lk_bbbb2222", {
    matchKind: "secret-field",
    matchedResourceName: "api-env",
    rotation: { mode: "replace", manageUrl: null },
    validity: "inactive",
    secretHint: null,
    upstreamResolveError: "403 from GitHub",
  }),
  leak("lk_cccc3333", {
    status: "rotated",
    rotationMethod: "reissued",
    rotatedBy: "ada@example.com",
    matchKind: "none",
    validity: "inactive",
    candidateAccountIds: ["a", "b"],
    repository: null,
  }),
  leak("lk_dddd4444", {
    status: "dismissed",
    dismissedReason: "used-in-tests",
    rotation: { mode: "manual", manageUrl: "https://console.aws/iam" },
    matchKind: "none",
    candidateAccountIds: [],
    path: null,
    repository: null,
  }),
];

const SCANNERS = [
  {
    accountId: "gh_1",
    accountName: "acme",
    pluginId: "github",
    label: "GitHub secret scanning",
    canResolve: true,
    returnsSecretValue: true,
    lastScannedAt: "2026-11-08T11:00:00.000Z",
    lastError: null,
    lastCount: 4,
  },
  {
    accountId: "gl_1",
    accountName: "acme-gl",
    pluginId: "gitlab",
    label: "GitLab secret detection",
    canResolve: false,
    returnsSecretValue: false,
    lastScannedAt: "2026-11-08T11:00:00.000Z",
    lastError: null,
    lastCount: 1,
    lastPartial: true,
  },
  {
    accountId: "gl_2",
    accountName: "broken",
    pluginId: "gitlab",
    label: "GitLab secret detection",
    canResolve: false,
    returnsSecretValue: false,
    lastScannedAt: null,
    lastError: "401",
    lastCount: null,
  },
];

const LISTING = {
  leaks: LEAKS,
  counts: { open: 2, rotated: 1, dismissed: 1, resolved: 0 },
  scanners: SCANNERS,
  generatedAt: "2026-11-08T12:00:00.000Z",
};

const CLOUD_ACCOUNTS = [
  { id: "acc_1", pluginId: "aws", displayName: "prod", createdAt: "2026-01-01T00:00:00Z" },
];

describe("leaks", () => {
  it("lists open leaks by default, every status on request, narrowed to an account", async () => {
    serveRoutes(out, {
      "GET /leaked-secrets?status=open": LISTING,
      "GET /leaked-secrets": LISTING,
      "GET /accounts": CLOUD_ACCOUNTS,
      "GET /leaked-secrets?status=dismissed&accountId=acc_1": { ...LISTING, leaks: [] },
    });
    expect(await cli("leaks")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · leaked credentials  2 open · 1 rotated · 1 dismissed
      acme (GitHub secret scanning): scanned 2026-11-08 11:00, 4 findings
      acme-gl (GitLab secret detection): scanned 2026-11-08 11:00, 1 finding; partial read, some findings may be missing; matches by token type only
      broken (GitLab secret detection): last scan failed: 401

      ID        SEVERITY  TOKEN                     LOCATION                    MATCHED TO                             DETECTED          STATUS                                             
      lk_aaaa1  critical  AWS access key AKIA…WXYZ  acme/api: src/config.ts:12  account prod                           2026-11-07 10:00  Open                                               
      lk_bbbb2  critical  AWS access key            acme/api: src/config.ts:12  stored on api-env                      2026-11-07 10:00  Open                                               
      lk_cccc3  high      AWS access key AKIA…WXYZ  src/config.ts:12            one of 2 AWS accounts (by token type)  2026-11-07 10:00  Rotated: Reissued in Infrawrench by ada@example.com
      lk_dddd4  critical  AWS access key AKIA…WXYZ  acme (GitHub)               nothing Infrawrench holds              2026-11-07 10:00  Dismissed: Used in tests                           
      lk_bbbb2: couldn't close it on the scanner: 403 from GitHub

      Act on one with \`leaks rotate <id>\`, \`leaks mark-rotated <id>\` or \`leaks dismiss <id> --reason <r>\`; \`--json\` has full ids, finding URLs and each leak's rotation mode.
      "
    `);
    expect(await cli("leaks", "list", "--status", "ALL")).toBe(0);
    expect(await cli("leaks", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", ...LISTING }));
    expect(await cli("leaks", "--status", "dismissed", "-a", "prod")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · leaked credentials  2 open · 1 rotated · 1 dismissed
      acme (GitHub secret scanning): scanned 2026-11-08 11:00, 4 findings
      acme-gl (GitLab secret detection): scanned 2026-11-08 11:00, 1 finding; partial read, some findings may be missing; matches by token type only
      broken (GitLab secret detection): last scan failed: 401

      No dismissed leaks for that account. \`--status all\` lists every one.
      "
    `);
  });

  it("says when no scanner is connected or nothing leaked", async () => {
    serveRoutes(out, {
      "GET /leaked-secrets?status=open": { ...LISTING, scanners: [], leaks: [], counts: {} },
      "GET /leaked-secrets": { ...LISTING, leaks: [] },
    });
    expect(await cli("leaks")).toBe(0);
    expect(await cli("leaks", "--status", "all")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · leaked credentials  2 open · 1 rotated · 1 dismissed
      acme (GitHub secret scanning): scanned 2026-11-08 11:00, 4 findings
      acme-gl (GitLab secret detection): scanned 2026-11-08 11:00, 1 finding; partial read, some findings may be missing; matches by token type only
      broken (GitLab secret detection): last scan failed: 401

      No leaks.
      "
    `);
  });

  it("refuses a bad --status at parse time, and --local", async () => {
    expect(await cli("leaks", "--status", "fixed")).toBe(2);
    expect(out.stderr).toContain(
      '--status must be one of open, rotated, dismissed, resolved, all (got "fixed").',
    );
    expect(out.requests).toEqual([]);
    expect(await cli("leaks", "--local")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Leaked credentials live in Infrawrench Cloud: scanning runs on the server against the organization's GitHub and GitLab accounts. Drop --local.
      "
    `);
  });

  it("scans, and exits 1 when a scanner failed (#902)", async () => {
    serveRoutes(out, { "POST /leaked-secrets/scan": { scanned: 3, newLeaks: 2, errors: 1 } });
    expect(await cli("leaks", "scan")).toBe(1);
    expect(out.stdout).toBe("Scanned 3 accounts, 1 failed. New leaks: 2.\n");
    expect(await cli("leaks", "scan", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", scanned: 3, newLeaks: 2, errors: 1 }));
    serveRoutes(out, { "POST /leaked-secrets/scan": { scanned: 0, newLeaks: 0, errors: 0 } });
    expect(await cli("leaks", "scan")).toBe(0);
    serveRoutes(out, { "POST /leaked-secrets/scan": { scanned: 1, newLeaks: 0, errors: 0 } });
    expect(await cli("leaks", "scan")).toBe(0);
    expect(out.stdout).toBe("Scanned 1 account. New leaks: 0.\n");
  });

  it("rotates, marks rotated, dismisses and reopens", async () => {
    const after = (id: string, over: Record<string, unknown>) => ({ leak: leak(id, over) });
    serveRoutes(out, {
      "GET /leaked-secrets": LISTING,
      "POST /leaked-secrets/lk_aaaa1111/rotate": after("lk_aaaa1111", {
        status: "rotated",
        rotationMethod: "reissued",
        upstreamResolvedAt: "2026-11-08T12:00:00.000Z",
      }),
      "POST /leaked-secrets/lk_aaaa1111/mark-rotated": after("lk_aaaa1111", {
        status: "rotated",
        rotationMethod: "manual",
        rotatedBy: "ada@example.com",
        upstreamResolveError: "403",
      }),
      "POST /leaked-secrets/lk_aaaa1111/dismiss": after("lk_aaaa1111", {
        status: "dismissed",
        dismissedReason: "false-positive",
      }),
      "POST /leaked-secrets/lk_dddd4444/reopen": after("lk_dddd4444", {}),
    });
    expect(await cli("leaks", "rotate", "lk_aaaa")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Rotated lk_aaaa1 · AWS access key · Rotated: Reissued in Infrawrench
      Closed on the scanner 2026-11-08 12:00.
      "
    `);
    expect(await cli("leaks", "mark-rotated", "lk_aaaa", "--keep-upstream-open")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Marked rotated lk_aaaa1 · AWS access key · Rotated: Marked rotated by ada@example.com
      Couldn't close it on the scanner: 403
      "
    `);
    expect(
      await cli(
        "leaks",
        "dismiss",
        "lk_aaaa",
        "--reason",
        "False-Positive",
        "--comment",
        " fixture ",
      ),
    ).toBe(0);
    expect(await cli("leaks", "reopen", "lk_dddd4444", "--json")).toBe(0);
    expect(out.stdout).toBe(pretty({ org: "org_1", leak: leak("lk_dddd4444") }));
    expect(sentBodies("POST")).toEqual([
      { resolveUpstream: true },
      { resolveUpstream: false },
      { reason: "false-positive", resolveUpstream: true, comment: "fixture" },
      {},
    ]);
  });

  it("replaces a literal value from stdin", async () => {
    serveRoutes(out, {
      "GET /leaked-secrets": LISTING,
      "POST /leaked-secrets/lk_bbbb2222/rotate": {
        leak: leak("lk_bbbb2222", { status: "rotated", rotationMethod: "replaced" }),
      },
    });
    const real = Object.getOwnPropertyDescriptor(process, "stdin");
    /** Every read of `process.stdin` gets a fresh pipe carrying `text`. */
    const feed = (text: string) =>
      Object.defineProperty(process, "stdin", {
        configurable: true,
        get: () => Readable.from([text]),
      });
    try {
      feed("  new-secret\n");
      expect(await cli("leaks", "rotate", "lk_bbbb", "--value-stdin")).toBe(0);
      expect(sentBodies("POST")).toEqual([{ resolveUpstream: true, value: "new-secret" }]);
      feed("\n");
      expect(await cli("leaks", "rotate", "lk_bbbb", "--value-stdin")).toBe(2);
      expect(out.stderr).toMatchInlineSnapshot(`
        "No value on stdin. Nothing was rotated.
        "
      `);
    } finally {
      if (real) Object.defineProperty(process, "stdin", real);
    }
  });

  it("refuses what it cannot rotate, and asks for a reason and an id", async () => {
    serveRoutes(out, { "GET /leaked-secrets": LISTING });
    expect(await cli("leaks", "rotate", "lk_bbbb")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "This secret is stored as a literal value, so rotating it means supplying the new one.
      Create it at the provider, then pass it on stdin (never as an argument, which lands in shell history):
        infrawrench leaks rotate lk_bbbb2 --value-stdin < new-value.txt
      "
    `);
    expect(await cli("leaks", "rotate", "lk_aaaa", "--value-stdin")).toBe(2);
    expect(await cli("leaks", "rotate", "lk_cccc")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "This leak is rotated, not open. Reopen it first with \`infrawrench leaks reopen lk_cccc3\`.
      "
    `);
    expect(await cli("leaks", "rotate", "lk_dddd")).toBe(1);
    expect(await cli("leaks", "rotate", "lk_")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      ""lk_" matches 4 leaks: lk_aaaa1111, lk_bbbb2222, lk_cccc3333, lk_dddd4444. Give more of the id.
      "
    `);
    expect(await cli("leaks", "reopen", "zzz")).toBe(1);
    expect(await cli("leaks", "mark-rotated")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Usage: infrawrench leaks mark-rotated <id>
      Ids are printed by \`infrawrench leaks --status all\`.
      "
    `);
    expect(await cli("leaks", "dismiss", "lk_aaaa")).toBe(2);
    expect(out.stderr).toContain(
      "Dismissing needs --reason false-positive|used-in-tests|wont-fix.",
    );
    expect(await cli("leaks", "dismiss", "lk_aaaa", "--reason", "meh")).toBe(2);
    expect(out.stderr).toContain(
      '--reason must be one of false-positive, used-in-tests, wont-fix (got "meh").',
    );
  });

  it("reads a status or match this build does not know as its word", async () => {
    serveRoutes(out, {
      "GET /leaked-secrets?status=open": {
        ...LISTING,
        leaks: [leak("lk_zzzz", { status: "quarantined", matchKind: "vault" })],
      },
    });
    expect(await cli("leaks")).toBe(0);
    expect(out.stdout).toContain("quarantined");
  });
});

// ---------------------------------------------------------------------------
// vulns
// ---------------------------------------------------------------------------

const running = (resourceId: string, typeName: string, plural: string) => ({
  resourceId,
  pluginId: "aws",
  resourceTypeId: typeName.toLowerCase(),
  resourceTypeName: typeName,
  resourceTypePluralName: plural,
  accountId: "acc_1",
  accountName: "prod",
  displayName: resourceId,
  matchedBy: "digest",
});

const vuln = (findingId: string, over: Record<string, unknown> = {}) => ({
  key: `acc_1/${findingId}`,
  accountId: "acc_1",
  accountName: "prod",
  pluginId: "aws",
  pluginName: "AWS",
  scanner: "Inspector",
  findingId,
  advisoryId: "CVE-2024-3094",
  aliases: ["GHSA-xxxx"],
  title: "xz backdoor",
  severity: "critical",
  cvssScore: 10,
  cvssVector: null,
  packageName: "xz",
  packageEcosystem: "deb",
  installedVersion: "5.6.0",
  fixedVersion: "5.6.2",
  fixAvailable: true,
  exploitAvailable: true,
  kev: { dateAdded: "2024-04-01", dueDate: null, knownRansomware: false },
  artifact: {
    kind: "image",
    name: "ghcr.io/acme/api",
    digest: "sha256:0123456789abcdef",
    tags: ["1.4"],
    resourceExternalId: null,
    url: null,
    key: "image:ghcr.io/acme/api",
  },
  firstSeenAt: null,
  lastSeenAt: null,
  url: null,
  collectedAt: "2026-11-08T10:00:00.000Z",
  running: [
    running("pod-1", "Pod", "Pods"),
    running("pod-2", "Pod", "Pods"),
    running("fn", "Lambda Function", "Lambda Functions"),
  ],
  services: [
    { id: "svc_1", name: "Checkout", slug: "checkout", tier: 1 },
    { id: "svc_2", name: "Search", slug: "search", tier: null },
    { id: "svc_3", name: "Admin", slug: "admin", tier: 3 },
  ],
  ...over,
});

const FINDINGS = [
  vuln("f1"),
  vuln("f2", {
    advisoryId: "CVE-2023-0001",
    severity: "high",
    cvssScore: 7.5,
    kev: { dateAdded: "2023-01-01", dueDate: null, knownRansomware: true },
    fixedVersion: null,
    fixAvailable: false,
    running: [],
    services: [],
    pluginId: "github",
    artifact: {
      ...vuln("x").artifact,
      tags: [],
      name: "acme/web",
      key: "repository:acme/web",
      kind: "repository",
    },
  }),
  vuln("f3", {
    advisoryId: "GHSA-low",
    severity: "low",
    cvssScore: null,
    kev: null,
    fixedVersion: null,
    fixAvailable: null,
    packageName: null,
    installedVersion: null,
    running: [running("pod-9", "Pod", "Pods")],
    services: undefined,
    artifact: { ...vuln("x").artifact, tags: [], digest: null, key: "image:x" },
  }),
  vuln("f4", {
    advisoryId: "CVE-2025-9",
    severity: "unknown",
    kev: null,
    running: [],
    services: [],
  }),
];

const DISMISSED = [
  {
    ...vuln("f9", { advisoryId: "CVE-2022-1", severity: "medium" }),
    dismissal: {
      advisoryId: "CVE-2022-1",
      artifactKey: "*",
      dismissedAt: "2026-10-01T00:00:00.000Z",
      dismissedBy: "ada@example.com",
      reason: "Not reachable",
    },
  },
];

const SOURCES = [
  {
    accountId: "acc_1",
    accountName: "prod",
    pluginId: "aws",
    pluginName: "AWS",
    scanner: "Inspector",
    consoleUrl: "https://console.aws/inspector",
    partial: false,
    lastCollectedAt: "2026-11-08T11:00:00.000Z",
    error: null,
    helpLabel: null,
    helpUrl: null,
    findingCount: 3,
  },
  {
    accountId: "gh_1",
    accountName: "acme",
    pluginId: "github",
    pluginName: "GitHub",
    scanner: "Dependabot",
    consoleUrl: null,
    partial: true,
    lastCollectedAt: "2026-11-01T11:00:00.000Z",
    error: "Resource not accessible",
    helpLabel: "Grant access",
    helpUrl: "https://docs/dependabot",
    findingCount: 1,
  },
  {
    accountId: "gl_1",
    accountName: "gitlab",
    pluginId: "gitlab",
    pluginName: "GitLab",
    scanner: "Container scanning",
    consoleUrl: null,
    partial: false,
    lastCollectedAt: null,
    error: null,
    helpLabel: null,
    helpUrl: null,
    findingCount: 0,
  },
];

const FEED = {
  findings: FINDINGS.map((f) => {
    if (f.services !== undefined) return f;
    const { services: _s, ...rest } = f;
    return rest;
  }),
  totalCount: 4,
  counts: { critical: 1, high: 1, medium: 0, low: 1, unknown: 1 },
  runningCounts: { critical: 1, high: 0, medium: 0, low: 1, unknown: 0 },
  dismissed: DISMISSED,
  dismissedCount: 1,
  sources: SOURCES,
  kevUpdatedAt: "2026-11-08T06:00:00.000Z",
  generatedAt: "2026-11-08T12:00:00.000Z",
};

const SERVICE_LIST = {
  services: [
    { id: "svc_1", name: "Checkout", slug: "checkout" },
    { id: "svc_4", name: "Checkout worker", slug: "checkout-worker" },
  ],
};

describe("vulns", () => {
  it("lists findings worst first, with services and the dismissed count", async () => {
    serveRoutes(out, { "GET /vulnerabilities": FEED });
    expect(await cli("vulns")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 open findings  1 critical (1 running) · 1 high (0 running) · 1 low (1 running) · 1 unscored (0 running)
      CISA KEV catalog updated 6h ago

      SEVERITY  ADVISORY                      CVSS  PACKAGE            ARTIFACT               RUNNING                       SERVICE                 
      critical  CVE-2024-3094 KEV             10.0  xz 5.6.0 -> 5.6.2  ghcr.io/acme/api:1.4   2 Pods and 1 Lambda Function  checkout (T1), search +1
      high      CVE-2023-0001 KEV ransomware   7.5  xz 5.6.0 (no fix)  acme/web@0123456789ab  not running                   -                       
      low       GHSA-low                         -  (unknown package)  ghcr.io/acme/api       1 Pod                         -                       
      unscored  CVE-2025-9                    10.0  xz 5.6.0 -> 5.6.2  ghcr.io/acme/api:1.4   not running                   -                       

      1 dismissed as accepted risk; list them with --include-dismissed.

      1 scanner failed on the last collection; their findings may be stale or missing:
        acme (GitHub · Dependabot): Resource not accessible
          Grant access: https://docs/dependabot

      Collected from each provider's scanner by the cloud poller and joined to synced resources. \`infrawrench vulns sources\` lists the scanners; dismiss with \`vulns dismiss <advisoryId> <artifactKey|*>\`.
      "
    `);
    expect(await cli("vulnerabilities", "list", "--limit", "1")).toBe(0);
    expect(await cli("vulns", "--json")).toBe(0);
    expect(out.stdout).toBe(
      pretty({ org: "org_1", ...FEED, findings: FEED.findings, matchedCount: 4, dismissed: [] }),
    );
  });

  it("filters through the shared filter", async () => {
    serveRoutes(out, { "GET /vulnerabilities": FEED, "GET /services": SERVICE_LIST });
    expect(await cli("vulns", "--severity", "critical,unscored", "--running")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 open findings  1 critical (1 running) · 1 high (0 running) · 1 low (1 running) · 1 unscored (0 running)
      CISA KEV catalog updated 6h ago

      1 of 4 match the filters.

      SEVERITY  ADVISORY           CVSS  PACKAGE            ARTIFACT              RUNNING                       SERVICE                 
      critical  CVE-2024-3094 KEV  10.0  xz 5.6.0 -> 5.6.2  ghcr.io/acme/api:1.4  2 Pods and 1 Lambda Function  checkout (T1), search +1

      1 dismissed as accepted risk; list them with --include-dismissed.

      1 scanner failed on the last collection; their findings may be stale or missing:
        acme (GitHub · Dependabot): Resource not accessible
          Grant access: https://docs/dependabot

      Collected from each provider's scanner by the cloud poller and joined to synced resources. \`infrawrench vulns sources\` lists the scanners; dismiss with \`vulns dismiss <advisoryId> <artifactKey|*>\`.
      "
    `);
    expect(await cli("vulns", "--not-running", "--kev", "--plugin", "github")).toBe(0);
    expect(
      await cli("vulns", "--fix-available", "--search", "XZ", "-a", "pro", "--service", "checkout"),
    ).toBe(0);
    expect(await cli("vulns", "--resource", "pod-9", "--include-dismissed")).toBe(0);
    expect(
      await cli("vulns", "--include-dismissed", "--json", "--limit", "1", "--search", "cve"),
    ).toBe(0);
    expect(await cli("vulns", "--include-dismissed")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 open findings  1 critical (1 running) · 1 high (0 running) · 1 low (1 running) · 1 unscored (0 running)
      CISA KEV catalog updated 6h ago

      SEVERITY  ADVISORY                      CVSS  PACKAGE            ARTIFACT               RUNNING                       SERVICE                 
      critical  CVE-2024-3094 KEV             10.0  xz 5.6.0 -> 5.6.2  ghcr.io/acme/api:1.4   2 Pods and 1 Lambda Function  checkout (T1), search +1
      high      CVE-2023-0001 KEV ransomware   7.5  xz 5.6.0 (no fix)  acme/web@0123456789ab  not running                   -                       
      low       GHSA-low                         -  (unknown package)  ghcr.io/acme/api       1 Pod                         -                       
      unscored  CVE-2025-9                    10.0  xz 5.6.0 -> 5.6.2  ghcr.io/acme/api:1.4   not running                   -                       

      Dismissed · 1 accepted risk

      ADVISORY    ARTIFACT              SCOPE       ACCEPTED                                    
      CVE-2022-1  ghcr.io/acme/api:1.4  everywhere  2026-10-01 · ada@example.com · Not reachable

      Undo with \`infrawrench vulns restore <advisoryId> <artifactKey|*>\`.

      1 scanner failed on the last collection; their findings may be stale or missing:
        acme (GitHub · Dependabot): Resource not accessible
          Grant access: https://docs/dependabot

      Collected from each provider's scanner by the cloud poller and joined to synced resources. \`infrawrench vulns sources\` lists the scanners; dismiss with \`vulns dismiss <advisoryId> <artifactKey|*>\`.
      "
    `);
    expect(await cli("vulns", "--search", "nothing-matches")).toBe(0);
  });

  it("refuses bad filters with the legacy sentences", async () => {
    serveRoutes(out, { "GET /vulnerabilities": FEED, "GET /services": SERVICE_LIST });
    expect(await cli("vulns", "--severity", "huge,high")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "--severity takes a comma-separated list of critical, high, medium, low, unknown (got "huge").
      "
    `);
    expect(await cli("vulns", "--severity", ",")).toBe(2);
    expect(await cli("vulns", "-a", "nope")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "No vulnerability-reporting account matches "nope".
      Accounts with a scanner:
        acc_1  prod
        gh_1  acme
        gl_1  gitlab
      "
    `);
    expect(await cli("vulns", "--service", "check")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      ""check" matches 2 services: checkout, checkout-worker. Use the slug.
      "
    `);
    expect(await cli("vulns", "--service", "zzz")).toBe(2);
    expect(await cli("vulns", "--running", "--not-running")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "--running and --not-running are mutually exclusive
      "
    `);
    expect(await cli("vulns", "--local")).toBe(2);
  });

  it("says when nothing reports, or nothing is open", async () => {
    serveRoutes(out, { "GET /vulnerabilities": { ...FEED, sources: [], kevUpdatedAt: null } });
    expect(await cli("vulns")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 4 open findings  1 critical (1 running) · 1 high (0 running) · 1 low (1 running) · 1 unscored (0 running)
      CISA KEV catalog not fetched yet; no KEV markers

      No connected account reports vulnerabilities yet. Findings appear when a provider with a scanner (container registry scanning, a cloud security center, Dependabot, an artifact scanner) is connected and enabled.
      "
    `);
    serveRoutes(out, { "GET /vulnerabilities": { ...FEED, findings: [], totalCount: 0 } });
    expect(await cli("vulns")).toBe(0);
    serveRoutes(out, {
      "GET /vulnerabilities": {
        ...FEED,
        findings: [],
        totalCount: 0,
        dismissed: [],
        dismissedCount: 0,
      },
    });
    expect(await cli("vulns")).toBe(0);
  });

  it("dismisses and restores", async () => {
    serveRoutes(out, {
      "POST /vulnerabilities/dismissals": DISMISSED[0]!.dismissal,
      "DELETE /vulnerabilities/dismissals?advisoryId=cve-2022-1&artifactKey=*": { ok: true },
      "DELETE /vulnerabilities/dismissals?advisoryId=CVE-2022-1&artifactKey=image%3Ax": {
        ok: true,
      },
    });
    expect(await cli("vulns", "dismiss", " CVE-2022-1 ", "*", "--reason", "Not reachable")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Dismissed CVE-2022-1 · everywhere
      Accepted for Acme. It leaves the vulnerability list and the alerts until \`vulns restore\`.
      "
    `);
    expect(await cli("vulns", "dismiss", "CVE-2022-1", "*", "--json")).toBe(0);
    expect(sentBodies("POST")).toEqual([
      { advisoryId: "CVE-2022-1", artifactKey: "*", reason: "Not reachable" },
      { advisoryId: "CVE-2022-1", artifactKey: "*", reason: null },
    ]);
    expect(await cli("vulns", "restore", "cve-2022-1", "*")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Restored CVE-2022-1 · everywhere
      Back on the vulnerability list and in the alerts.
      "
    `);
    expect(await cli("vulns", "restore", "CVE-2022-1", "image:x", "--json")).toBe(0);
    expect(await cli("vulns", "dismiss", "CVE-1")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Usage: infrawrench vulns dismiss <advisoryId> <artifactKey|"*"> [--reason <text>]
      The artifact key is each finding's \`artifact.key\` in \`infrawrench vulns --json\`; quote \`*\` (the advisory everywhere in the organization) so the shell does not expand it.
      "
    `);
    expect(await cli("vulns", "restore", " ", "x")).toBe(2);
  });

  it("lists the scanner accounts", async () => {
    serveRoutes(out, { "GET /vulnerabilities": FEED });
    expect(await cli("vulns", "sources")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Acme · 3 scanner accounts
      CISA KEV catalog updated 6h ago

      ACCOUNT  PROVIDER  SCANNER             FINDINGS  COLLECTED  STATUS 
      prod     AWS       Inspector                  3  1h ago     ok     
      acme     GitHub    Dependabot                 1  7d ago     error  
      gitlab   GitLab    Container scanning         0  never      pending

      prod · Inspector
        Console: https://console.aws/inspector
      acme · Dependabot
        Resource not accessible
        Grant access: https://docs/dependabot

      Partial: the provider's API returns a bounded subset of its findings.
      "
    `);
    expect(await cli("vulns", "sources", "--json")).toBe(0);
    expect(out.stdout).toBe(
      pretty({ org: "org_1", sources: SOURCES, kevUpdatedAt: FEED.kevUpdatedAt }),
    );
    serveRoutes(out, { "GET /vulnerabilities": { ...FEED, sources: [] } });
    expect(await cli("vulns", "sources")).toBe(0);
  });

  it("reads a severity, kind or match this build does not know without failing the list", async () => {
    serveRoutes(out, {
      "GET /vulnerabilities": {
        ...FEED,
        findings: [
          vuln("f7", {
            severity: "catastrophic",
            artifact: { ...vuln("x").artifact, kind: "wasm" },
            running: [{ ...running("pod-1", "Pod", "Pods"), matchedBy: "heuristic" }],
            services: [{ id: "svc_1", name: "Checkout", slug: "checkout", tier: 9 }],
          }),
        ],
      },
    });
    expect(await cli("vulns")).toBe(0);
    expect(out.stdout).toContain("catastrophic");
    expect(out.stdout).toContain("1 Pod");
    expect(await cli("vulns", "--severity", "unscored")).toBe(0);
    expect(out.stdout).toContain("1 of 4 match the filters.");
    expect(await cli("vulns", "--json")).toBe(0);
    expect(JSON.parse(out.stdout).findings[0].severity).toBe("catastrophic");
  });
});
