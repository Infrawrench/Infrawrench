import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationResource } from "@infrawrench/plugin-base";
import { gcpRemediationCommands } from "../remediation.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const commands = (r: ReturnType<typeof gcpRemediationCommands>) => r.map((c) => c.command);

const instance: RemediationResource = {
  resourceTypeId: "gce-instance",
  displayName: "web-1",
  externalId: "acme-prod-123456/us-central1-a/web-1",
  fields: { name: "web-1", zone: "us-central1-a", machineType: "n2-standard-8", status: "RUNNING" },
};

describe("gcpRemediationCommands", () => {
  it("resizes a stopped instance: stop, set-machine-type, start", () => {
    const out = gcpRemediationCommands({
      kind: "oversized",
      resource: instance,
      sizeFieldKey: "machineType",
      currentSize: "n2-standard-8",
      targetSize: "n2-standard-4",
      region: "us-central1-a",
    });
    expect(out.every((c) => !c.destructive && c.tool === "gcloud" && !c.placeholders)).toBe(true);
    expect(commands(out)).toMatchInlineSnapshot(`
      [
        "gcloud compute instances stop web-1 --zone us-central1-a --project acme-prod-123456",
        "gcloud compute instances set-machine-type web-1 --machine-type n2-standard-4 --zone us-central1-a --project acme-prod-123456",
        "gcloud compute instances start web-1 --zone us-central1-a --project acme-prod-123456",
      ]
    `);
  });

  it("stops and starts an instance for a sleep schedule", () => {
    expect(commands(gcpRemediationCommands({ kind: "sleep-schedule", resource: instance })))
      .toMatchInlineSnapshot(`
      [
        "gcloud compute instances stop web-1 --zone us-central1-a --project acme-prod-123456",
        "gcloud compute instances start web-1 --zone us-central1-a --project acme-prod-123456",
      ]
    `);
  });

  it("falls back to $GCP_PROJECT when externalId lacks the project", () => {
    const out = gcpRemediationCommands({
      kind: "sleep-schedule",
      resource: { ...instance, externalId: null },
    });
    expect(out[0]!.placeholders?.[0]?.name).toBe("GCP_PROJECT");
    expect(out[0]!.command).toMatchInlineSnapshot(
      `"gcloud compute instances stop web-1 --zone us-central1-a --project "$GCP_PROJECT""`,
    );
  });

  it("snapshots then deletes an orphaned disk", () => {
    const out = gcpRemediationCommands({
      kind: "orphan",
      reason: "Persistent disk is not attached to any instance",
      resource: {
        resourceTypeId: "gce-disk",
        displayName: "data-disk-old",
        externalId: "acme-prod-123456/europe-west1-b/data-disk-old",
        fields: {
          name: "data-disk-old",
          zone: "europe-west1-b",
          sizeGb: 500,
          status: "READY",
          attachedTo: "",
        },
      },
    });
    expect(out.map((c) => c.destructive)).toEqual([false, true]);
    expect(commands(out)).toMatchInlineSnapshot(`
      [
        "gcloud compute disks snapshot data-disk-old --snapshot-names data-disk-old-pre-delete-20261004 --zone europe-west1-b --project acme-prod-123456",
        "gcloud compute disks delete data-disk-old --zone europe-west1-b --project acme-prod-123456",
      ]
    `);
  });

  it("keeps the snapshot name within GCP's 63-character limit", () => {
    const name = `d${"x".repeat(61)}`;
    const out = gcpRemediationCommands({
      kind: "orphan",
      reason: "",
      resource: {
        resourceTypeId: "gce-disk",
        displayName: name,
        externalId: `p/us-east1-b/${name}`,
        fields: { name, zone: "us-east1-b" },
      },
    });
    const snap = /--snapshot-names (\S+)/.exec(out[0]!.command)![1]!;
    expect(snap.length).toBeLessThanOrEqual(63);
    expect(snap.endsWith("-pre-delete-20261004")).toBe(true);
  });

  it("releases a regional static IP", () => {
    const out = gcpRemediationCommands({
      kind: "orphan",
      reason: "Static external IP is reserved but not in use",
      resource: {
        resourceTypeId: "static-ip",
        displayName: "lb-ip",
        externalId: "us-east1/lb-ip",
        fields: { name: "lb-ip", region: "us-east1", status: "RESERVED", addressType: "EXTERNAL" },
      },
    });
    expect(out[0]!.destructive).toBe(true);
    expect(out[0]!.placeholders?.[0]?.name).toBe("GCP_PROJECT");
    expect(commands(out)).toMatchInlineSnapshot(`
      [
        "gcloud compute addresses delete lb-ip --region us-east1 --project "$GCP_PROJECT"",
      ]
    `);
  });

  it("releases a global static IP with --global", () => {
    expect(
      commands(
        gcpRemediationCommands({
          kind: "orphan",
          reason: "",
          resource: {
            resourceTypeId: "static-ip",
            displayName: "global-ip",
            externalId: "/global-ip",
            fields: { name: "global-ip", region: "", status: "RESERVED" },
          },
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "gcloud compute addresses delete global-ip --global --project "$GCP_PROJECT"",
      ]
    `);
  });

  it("quotes a name carrying shell metacharacters", () => {
    const out = gcpRemediationCommands({
      kind: "sleep-schedule",
      resource: { ...instance, fields: { ...instance.fields, name: "web'; rm -rf ~" } },
    });
    expect(out[0]!.command).toMatchInlineSnapshot(
      `"gcloud compute instances stop 'web'"'"'; rm -rf ~' --zone us-central1-a --project acme-prod-123456"`,
    );
  });

  it("describes an idle CUD and turns off auto-renew (CUDs cannot be cancelled)", () => {
    const out = gcpRemediationCommands({
      kind: "idle-commitment",
      commitment: {
        id: "commitment-n2-3yr",
        kind: "committed_use",
        description: "Committed use discount",
        scope: null,
        region: "us-central1",
      },
    });
    expect(out.every((c) => !c.destructive)).toBe(true);
    expect(commands(out)).toMatchInlineSnapshot(`
      [
        "gcloud compute commitments describe commitment-n2-3yr --region us-central1 --project "$GCP_PROJECT"",
        "gcloud compute commitments update commitment-n2-3yr --region us-central1 --project "$GCP_PROJECT" --no-auto-renew",
      ]
    `);
  });

  it("returns [] for unknown types and missing ids", () => {
    expect(
      gcpRemediationCommands({
        kind: "orphan",
        reason: "",
        resource: { resourceTypeId: "gcs-bucket", displayName: "b", externalId: "b", fields: {} },
      }),
    ).toEqual([]);
    expect(
      gcpRemediationCommands({
        kind: "sleep-schedule",
        resource: { ...instance, externalId: null, fields: {} },
      }),
    ).toEqual([]);
  });
});
