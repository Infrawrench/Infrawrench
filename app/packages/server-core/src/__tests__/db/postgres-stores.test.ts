/**
 * Executes the store modules' real drizzle SQL against a real Postgres. The
 * unit suites stub `db/client` with chainable fakes, which asserts the tests'
 * idea of the query builder — never that the joins, aggregates and jsonb
 * reads actually run against the migrated schema. Here each module's read
 * path executes for an organization that does not exist, and must come back
 * empty (or with its synthesized defaults) without throwing.
 *
 * Same rules as postgres.test.ts: skipped unless DATABASE_URL is set,
 * migrations already applied, scratch databases only. Reads only — nothing
 * is written.
 *
 * Every import is dynamic: these modules import `db/client`, which throws at
 * import time when DATABASE_URL is unset, and static imports would run even
 * for a skipped suite.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const configured = !!process.env["DATABASE_URL"];

// No row anywhere references this org, so every read below exercises its full
// SQL and returns its empty shape.
const orgId = `test-org-${randomUUID()}`;

describe.skipIf(!configured)("postgres store modules against a real server", () => {
  afterAll(async () => {
    if (!configured) return;
    const { db } = await import("../../db/client");
    await db.$client.end();
  });

  it("lists probes, leases, backups and log workspaces", async () => {
    const probes = await import("../../probes/store");
    expect(await probes.listProbeRecords(orgId)).toEqual([]);

    const leases = await import("../../leases/store");
    expect(await leases.listLeaseRecords(orgId)).toEqual([]);

    const backups = await import("../../backups/store");
    expect(await backups.listBackupPolicies(orgId)).toEqual([]);

    const logWorkspaces = await import("../../log-workspaces/store");
    expect(await logWorkspaces.listLogWorkspaceQueries(orgId)).toEqual({ queries: [] });
  });

  it("lists ownership and owner candidates", async () => {
    const ownership = await import("../../ownership/store");
    expect(await ownership.listOwnership(orgId)).toEqual({ ownership: [] });
    expect(await ownership.listOwnerCandidates(orgId)).toEqual([]);
  });

  it("lists cost centres, allocation rules and billing rules", async () => {
    const allocation = await import("../../cost/allocation");
    expect(await allocation.listCostCentres(orgId)).toEqual([]);
    expect(await allocation.listAllocationRules(orgId)).toEqual([]);

    const billingRules = await import("../../cost/billing-rules");
    expect(await billingRules.listBillingRules(orgId)).toEqual([]);
  });

  it("lists schedules, status pages, incidents and change freezes", async () => {
    const schedules = await import("../../schedules/store");
    expect(await schedules.listScheduleRecords(orgId)).toEqual([]);

    const statusPages = await import("../../status-pages/store");
    expect(await statusPages.listStatusPages(orgId)).toEqual({ pages: [] });

    const incidents = await import("../../incidents/store");
    expect(await incidents.listIncidentRecords(orgId)).toEqual([]);

    const freezes = await import("../../change-freezes");
    expect(await freezes.findActiveChangeFreeze(orgId)).toBeNull();
  });

  it("lists alert rules, deliveries and workflow approvals", async () => {
    const rules = await import("../../alerts/rules");
    expect(await rules.listAlertRules(orgId)).toEqual([]);

    const ack = await import("../../alerts/ack");
    expect(await ack.listAlertDeliveries(orgId)).toEqual([]);

    const approvals = await import("../../workflows/approvals");
    expect(await approvals.listWorkflowApprovals(orgId)).toEqual([]);
  });

  it("lists posture dismissals and digest recipients", async () => {
    const dismissals = await import("../../posture/dismissals");
    expect(await dismissals.listPostureDismissals(orgId)).toEqual([]);

    const recipients = await import("../../digest/recipients");
    expect(await recipients.listDigestEmailRecipients(orgId)).toEqual([]);
  });

  it("reads environments and session recordings", async () => {
    const environments = await import("../../environments/store");
    expect(await environments.listEnvironmentTemplates(orgId)).toEqual({ templates: [] });
    expect(await environments.countLiveInstances(orgId)).toBe(0);

    const recordings = await import("../../ssh-recording/store");
    expect(await recordings.listSessionRecordings(orgId)).toEqual([]);
    expect(await recordings.getSessionRecordingUsage(orgId)).toBeDefined();
  });

  it("synthesizes settings defaults for an unknown org", async () => {
    const quotas = await import("../../quotas/settings");
    expect(await quotas.getQuotaSettings(orgId)).toBeDefined();

    const expiry = await import("../../expiry/settings");
    expect(await expiry.getExpirySettings(orgId)).toBeDefined();

    const drift = await import("../../drift/settings");
    expect(await drift.getDriftAlertSettings(orgId)).toBeDefined();

    const networkFlow = await import("../../network-flow/settings");
    expect(await networkFlow.getNetworkFlowSettings(orgId)).toBeDefined();

    const environments = await import("../../environments/store");
    expect(await environments.getEnvironmentSettings(orgId)).toBeDefined();
  });
});
