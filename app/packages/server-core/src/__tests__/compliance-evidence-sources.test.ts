import { describe, expect, it, vi } from "vitest";
import type { LeakedSecret, LeakedSecretListResponse } from "@infrawrench/client-core";

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../access-review/feed", () => ({ listAccessReview: vi.fn() }));
vi.mock("../posture/feed", () => ({ listPosture: vi.fn() }));
vi.mock("../backups/feed", () => ({ listBackupCoverage: vi.fn() }));
vi.mock("../backups/drills", () => ({ listDrillCoverage: vi.fn() }));
vi.mock("../vulnerabilities/feed", () => ({ listVulnerabilities: vi.fn() }));
vi.mock("../jit-access/service", () => ({ listJitGrantIssues: vi.fn() }));
vi.mock("../ssh-recording/settings", () => ({ getSessionRecordingSettings: vi.fn() }));

const HINT = "sk_l…9f3a";
const leak = (over: Partial<LeakedSecret>): LeakedSecret => ({
  id: "l1",
  status: "rotated",
  scannerAccountId: "s",
  scannerAccountName: "GitHub org",
  scannerPluginId: "github",
  tokenType: "stripe_api_key",
  tokenTypeLabel: "Stripe secret key",
  ownerPluginId: "stripe",
  ownerPluginName: "Stripe",
  secretHint: HINT,
  repository: "acme/api",
  path: "config.ts",
  line: 3,
  commitSha: "abc123",
  url: null,
  upstreamState: "resolved",
  upstreamResolution: "revoked",
  validity: "active",
  publiclyLeaked: false,
  detectedAt: "2026-09-10T00:00:00Z",
  firstSeenAt: "2026-09-10T00:00:00Z",
  matchKind: "account",
  matchConfidence: "fingerprint",
  matchedAccountId: "acc",
  matchedAccountName: "Stripe live",
  matchedResourceId: null,
  matchedResourceName: null,
  matchedResourceTypeId: null,
  matchedPluginId: null,
  matchedFieldKey: null,
  candidateAccountIds: [],
  rotation: { mode: "account", manageUrl: null },
  rotatedAt: "2026-09-10T03:00:00Z",
  rotatedBy: "Ada",
  rotationMethod: "detected",
  dismissedReason: null,
  dismissedComment: null,
  dismissedAt: null,
  dismissedBy: null,
  upstreamResolvedAt: "2026-09-10T03:01:00Z",
  upstreamResolveError: null,
  canResolveUpstream: true,
  ...over,
});

const listLeakedSecrets = vi.fn(async (): Promise<LeakedSecretListResponse> => ({
  leaks: [
    leak({}),
    leak({
      id: "l2",
      status: "dismissed",
      rotatedAt: null,
      rotationMethod: null,
      dismissedAt: "2026-09-11T00:00:00Z",
      dismissedReason: "false-positive",
      dismissedComment: "test fixture",
      upstreamResolvedAt: null,
    }),
  ],
  counts: { open: 0, rotated: 1, dismissed: 1, resolved: 0 },
  scanners: [
    {
      accountId: "s",
      accountName: "GitHub org",
      pluginId: "github",
      label: "Secret scanning",
      canResolve: true,
      returnsSecretValue: true,
      lastScannedAt: "2026-10-01T00:00:00Z",
      lastError: null,
      lastCount: 2,
    },
  ],
  generatedAt: "2026-10-01T00:00:00Z",
}));
vi.mock("../leaked-secrets/store", () => ({ listLeakedSecrets }));

vi.mock("../scorecards/store", () => ({
  listScorecardRecords: async () => [{ id: "sc1" }],
  scorecardToWire: () => ({
    id: "sc1",
    name: "Production readiness",
    description: null,
    checks: [],
    levels: [{ key: "bronze", name: "Bronze", minScore: 50, color: null }],
    applicableTiers: [],
    alertOnLevelDrop: true,
    enabled: true,
    isDefault: true,
    lastEvaluatedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }),
  listScorecardResults: async () => [
    {
      scorecardId: "sc1",
      scorecardName: "Production readiness",
      serviceId: "svc1",
      score: 30,
      level: null,
      levelName: null,
      checks: [
        {
          checkId: "r",
          type: "has_runbook",
          name: "Has runbook",
          weight: 1,
          status: "fail",
          detail: "No runbook linked",
        },
      ],
      evaluatedAt: "2026-09-30T23:00:00Z",
    },
  ],
}));
vi.mock("../service-catalog/store", () => ({
  listServiceRecords: async () => [
    { id: "svc1", name: "Checkout API", slug: "checkout", tier: 1, ownerTeam: "Payments" },
  ],
}));

const { getEvidenceEvaluator } = await import("../compliance/evidence");

const ctx = {
  organizationId: "org-1",
  period: { from: "2026-07-01", to: "2026-09-30" },
  start: new Date("2026-07-01T00:00:00Z"),
  end: new Date("2026-10-01T00:00:00Z"),
  now: new Date("2026-10-01T00:00:00Z"),
};

describe("leaked-credentials evidence", () => {
  it("logs the period's leaks without the secret hint anywhere in the pack files", async () => {
    const out = await getEvidenceEvaluator("leaked-credentials")!(ctx);
    expect(out.result.status).toBe("present");
    expect(out.result.itemCount).toBe(2);
    expect(out.csv).toContain("False positive");
    expect(out.csv).toContain('"3"'); // hours to rotate
    expect(out.csv).not.toContain(HINT);
    expect(JSON.stringify(out.json)).not.toContain(HINT);
    expect(JSON.stringify(out.json)).not.toContain("secretHint");
    // Everything fit in the first read, so no per-status reads.
    expect(listLeakedSecrets).toHaveBeenCalledTimes(1);
  });
});

describe("scorecards evidence", () => {
  it("reports a service below the lowest level as a gap with its failing checks", async () => {
    const out = await getEvidenceEvaluator("scorecards")!(ctx);
    expect(out.result.status).toBe("gap");
    expect(out.result.gaps).toEqual([
      '1 service(s) are below the Bronze level of "Production readiness"',
    ]);
    expect(out.csv).toContain("Checkout API");
    expect(out.csv).toContain("Has runbook: No runbook linked");
  });
});
