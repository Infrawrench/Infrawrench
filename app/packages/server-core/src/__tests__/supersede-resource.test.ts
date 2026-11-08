/**
 * An edit that answers with a new id (a provider that makes each edit a new version):
 * what moves to the new id and what stays with the old one, asserted on the SQL the
 * real dialect renders. The real-server half (the row move itself) is in
 * `db/secret-writes.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { supersedeResource } = await import("../created-resource");

const ORG = "org-1";
const ACCOUNT = "acct-1";
const OLD = "acct-1:template:41";
const NEW = "acct-1:template:42";

const resource: ResourceInstance = {
  id: NEW,
  pluginId: "fake",
  resourceTypeId: "template",
  accountId: ACCOUNT,
  displayName: "Second version",
  externalId: "42",
  fields: { name: "Second version" },
  resolvedOutputs: {},
  secretStates: [],
  createdAt: "",
  updatedAt: "",
};

async function supersede(): Promise<void> {
  await supersedeResource({
    organizationId: ORG,
    pluginId: "fake",
    resourceTypeId: "template",
    accountId: ACCOUNT,
    previousId: OLD,
    resource,
  });
}

/** The write to `table`, which must be exactly one. */
function writeTo(table: string) {
  const hits = pg.queries.filter((q) => q.sql.startsWith(`update "${table}"`));
  expect(hits, `one update of ${table}`).toHaveLength(1);
  return hits[0]!;
}

beforeEach(() => pg.reset());

describe("supersedeResource", () => {
  it("writes the new row and soft deletes the old one, in this account", async () => {
    await supersede();
    const insert = pg.queries.find((q) => q.sql.startsWith('insert into "resources"'));
    expect(insert?.params).toContain(NEW);
    const retire = pg.queries.find(
      (q) => q.sql.startsWith('update "resources"') && q.sql.includes('"deleted_at"'),
    );
    expect(retire?.params).toEqual(expect.arrayContaining([OLD, ORG, ACCOUNT]));
  });

  it("moves what people attached to the resource", async () => {
    await supersede();
    for (const table of [
      "dashboard_pins",
      "starred_items",
      "service_members",
      "resource_ownership",
      "resource_schedules",
      "resource_leases",
      "environment_instance_members",
      "synthetic_probes",
      "slos",
      "query_monitors",
      "event_subscriptions",
      "associations",
      "secret_field_states",
    ]) {
      const { params } = writeTo(table);
      expect(params, table).toContain(NEW);
      expect(params, table).toContain(OLD);
    }
  });

  it("scopes every table that has an organization to it", async () => {
    await supersede();
    for (const table of [
      "starred_items",
      "service_members",
      "resource_ownership",
      "resource_schedules",
      "resource_leases",
      "environment_instance_members",
      "synthetic_probes",
      "slos",
      "query_monitors",
      "event_subscriptions",
    ]) {
      const { sql, params } = writeTo(table);
      expect(sql, table).toContain(`"${table}"."organization_id" = $`);
      expect(params, table).toContain(ORG);
    }
    // Pins have no organization column: their dashboard has.
    expect(writeTo("dashboard_pins").sql).toContain('"dashboards"."organization_id" = $');
  });

  it("leaves a one-per-resource row where the new id already has its own", async () => {
    await supersede();
    // The subquery is correlated with the row being updated, not with itself.
    expect(writeTo("dashboard_pins").sql).toContain(
      '"other_pin"."dashboard_id" = "dashboard_pins"."dashboard_id"',
    );
    expect(writeTo("starred_items").sql).toContain(
      '"other_star"."user_id" = "starred_items"."user_id"',
    );
    expect(writeTo("service_members").sql).toContain(
      '"other_member"."service_id" = "service_members"."service_id"',
    );
    for (const table of ["resource_ownership", "resource_schedules", "resource_leases"]) {
      expect(writeTo(table).sql, table).toContain("not exists");
    }
  });

  it("names the new version where a name is kept beside the id", async () => {
    await supersede();
    expect(writeTo("resource_ownership").params).toContain("Second version");
    expect(writeTo("service_members").params).toContain("Second version");
  });

  it("moves only stars on resources, and only output references from this one", async () => {
    await supersede();
    expect(writeTo("starred_items").params).toContain("resource");
    const refs = writeTo("secret_field_states");
    expect(refs.sql).toContain('"source_resource_id" = $');
    expect(refs.params).toContain("output-ref");
    // The rows this resource's own fields own are encrypted against the old id.
    expect(refs.sql).not.toMatch(/where[^]*"secret_field_states"\."resource_id" = \$/);
    expect(writeTo("associations").sql).toContain('"associations"."provider_resource_id" = $');
  });

  it("leaves the record of what happened with the old id", async () => {
    await supersede();
    for (const table of [
      "resource_changes",
      "metric_alert_events",
      "savings_events",
      "savings_finding_states",
      "posture_dismissals",
      "ssh_session_recordings",
      "deploy_events",
      "audit_logs",
    ]) {
      expect(
        pg.queries.some((q) => q.sql.includes(`"${table}"`)),
        table,
      ).toBe(false);
    }
  });
});
