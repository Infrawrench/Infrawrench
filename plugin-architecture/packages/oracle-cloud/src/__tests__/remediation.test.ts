import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { ociRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const REGION = "eu-frankfurt-1";
const INSTANCE = "ocid1.instance.oc1.eu-frankfurt-1.antheljt5example";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return {
    resourceTypeId,
    displayName: String(fields["name"] ?? "web-1"),
    externalId,
    fields: { region: REGION, ...fields },
  };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return ociRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

const oversized = (targetSize: string): RemediationFinding => ({
  kind: "oversized",
  resource: res("instance", INSTANCE, { size: "VM.Standard.E4.Flex/4/64" }),
  sizeFieldKey: "size",
  currentSize: "VM.Standard.E4.Flex/4/64",
  targetSize,
  region: REGION,
});

describe("ociRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(ociRemediationCommands);
  });

  it("resizes flex and fixed shapes", () => {
    expect([...lines(oversized("VM.Standard.E4.Flex/2/32")), ...lines(oversized("VM.Standard2.2"))])
      .toMatchInlineSnapshot(`
      [
        "- oci compute instance update --instance-id ocid1.instance.oc1.eu-frankfurt-1.antheljt5example --shape VM.Standard.E4.Flex --shape-config '{"ocpus":2,"memoryInGBs":32}' --force --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "- oci compute instance update --instance-id ocid1.instance.oc1.eu-frankfurt-1.antheljt5example --shape VM.Standard2.2 --force --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
      ]
    `);
    expect(ociRemediationCommands(oversized("VM.Standard2.2"))[0]?.placeholders).toEqual([
      { name: "OCI_CLI_PROFILE", description: expect.any(String) },
    ]);
  });

  it("stops and starts instances and autonomous databases", () => {
    expect([
      ...lines({ kind: "sleep-schedule", resource: res("instance", INSTANCE) }),
      ...lines({
        kind: "sleep-schedule",
        resource: res("autonomous-database", "ocid1.autonomousdatabase.oc1.eu-frankfurt-1.anadb"),
      }),
    ]).toMatchInlineSnapshot(`
      [
        "- oci compute instance action --instance-id ocid1.instance.oc1.eu-frankfurt-1.antheljt5example --action SOFTSTOP --wait-for-state STOPPED --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "- oci compute instance action --instance-id ocid1.instance.oc1.eu-frankfurt-1.antheljt5example --action START --wait-for-state RUNNING --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "- oci db autonomous-database stop --autonomous-database-id ocid1.autonomousdatabase.oc1.eu-frankfurt-1.anadb --wait-for-state STOPPED --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "- oci db autonomous-database start --autonomous-database-id ocid1.autonomousdatabase.oc1.eu-frankfurt-1.anadb --wait-for-state AVAILABLE --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
      ]
    `);
  });

  it("backs up the boot volume before terminating a stopped instance", () => {
    expect(
      lines(
        orphan(
          res("instance", INSTANCE, {
            name: "batch'; shutdown -h now",
            status: "STOPPED",
            bootVolumeId: "ocid1.bootvolume.oc1.eu-frankfurt-1.abtheljexample",
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- oci bv boot-volume-backup create --boot-volume-id ocid1.bootvolume.oc1.eu-frankfurt-1.abtheljexample --display-name 'batch'"'"'; shutdown -h now-pre-delete-20261004' --type FULL --wait-for-state AVAILABLE --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "! oci compute instance terminate --instance-id ocid1.instance.oc1.eu-frankfurt-1.antheljt5example --preserve-boot-volume false --force --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
      ]
    `);
  });

  it("backs up then deletes orphan volumes", () => {
    expect([
      ...lines(
        orphan(
          res("boot-volume", "ocid1.bootvolume.oc1.eu-frankfurt-1.abtheljexample", {
            name: "web-1 (Boot Volume)",
          }),
        ),
      ),
      ...lines(
        orphan(
          res("block-volume", "ocid1.volume.oc1.eu-frankfurt-1.abvolexample", { name: "data" }),
        ),
      ),
    ]).toMatchInlineSnapshot(`
      [
        "- oci bv boot-volume-backup create --boot-volume-id ocid1.bootvolume.oc1.eu-frankfurt-1.abtheljexample --display-name 'web-1 (Boot Volume)-pre-delete-20261004' --type FULL --wait-for-state AVAILABLE --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "! oci bv boot-volume delete --boot-volume-id ocid1.bootvolume.oc1.eu-frankfurt-1.abtheljexample --force --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "- oci bv backup create --volume-id ocid1.volume.oc1.eu-frankfurt-1.abvolexample --display-name data-pre-delete-20261004 --type FULL --wait-for-state AVAILABLE --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "! oci bv volume delete --volume-id ocid1.volume.oc1.eu-frankfurt-1.abvolexample --force --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
      ]
    `);
  });

  it("deletes orphan IPs, load balancers and databases", () => {
    expect([
      ...lines(orphan(res("reserved-ip", "ocid1.publicip.oc1.eu-frankfurt-1.aaipexample"))),
      ...lines(orphan(res("load-balancer", "ocid1.loadbalancer.oc1.eu-frankfurt-1.aalbexample"))),
      ...lines(
        orphan(res("autonomous-database", "ocid1.autonomousdatabase.oc1.eu-frankfurt-1.anadb")),
      ),
    ]).toMatchInlineSnapshot(`
      [
        "! oci network public-ip delete --public-ip-id ocid1.publicip.oc1.eu-frankfurt-1.aaipexample --force --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "! oci lb load-balancer delete --load-balancer-id ocid1.loadbalancer.oc1.eu-frankfurt-1.aalbexample --force --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
        "! oci db autonomous-database delete --autonomous-database-id ocid1.autonomousdatabase.oc1.eu-frankfurt-1.anadb --force --region eu-frankfurt-1 --profile "$OCI_CLI_PROFILE"",
      ]
    `);
  });

  it("returns [] for unknown types, missing ids and commitments", () => {
    expect(lines(orphan(res("vcn", "ocid1.vcn.oc1..x")))).toEqual([]);
    expect(lines(orphan(res("block-volume", null)))).toEqual([]);
    expect(
      lines({
        kind: "idle-commitment",
        commitment: { id: "c", kind: "reservation", description: "", scope: null, region: null },
      }),
    ).toEqual([]);
  });
});
