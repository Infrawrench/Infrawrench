import { describe, expect, it } from "vitest";

import { plugin } from "../plugin.js";
import { userData, shapeOf } from "../ci-compute.js";
import { containerShape } from "../ci-containers.js";
import { CI_GRANTS as CI_GRANTS_FOR_TESTS } from "../ci-executor.js";
import { parseStatement, statementGrants } from "../ci-shared.js";
import { TENANCY, identityRoute, makeClient, type Reply } from "./helpers.js";

const tags = {
  "infrawrench-ci": "org-Acme_01",
  "infrawrench-ci-run": "r1",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const key = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const spec = { bootstrap: "#!/bin/sh\necho hi\n", tags, name: "ci build", maxSeconds: 3600 };

const VCN = {
  id: "ocid1.vcn.oc1..ci",
  lifecycleState: "AVAILABLE",
  defaultRouteTableId: "ocid1.rt",
  defaultSecurityListId: "ocid1.sl",
};
const SUBNET = { id: "ocid1.subnet.oc1..ci", lifecycleState: "AVAILABLE" };

/** An OCI tenancy with the CI network already made, unless `fresh`. */
function tenancy(
  opts: {
    fresh?: boolean;
    extra?: (url: URL, method: string, body: unknown) => Reply | undefined;
  } = {},
) {
  const made: string[] = [];
  return {
    made,
    route: (url: URL, method: string, body: unknown): Reply | undefined => {
      const own = opts.extra?.(url, method, body);
      if (own) return own;
      const id = identityRoute(url);
      if (id) return id;
      const p = url.pathname;
      if (method === "GET" && p === "/20160918/vcns")
        return { body: opts.fresh && !made.includes("vcn") ? [] : [VCN] };
      if (method === "GET" && p === "/20160918/subnets")
        return { body: opts.fresh && !made.includes("subnet") ? [] : [SUBNET] };
      if (method === "POST" && p === "/20160918/vcns") {
        made.push("vcn");
        return { body: VCN };
      }
      if (method === "GET" && p === "/20160918/internetGateways") return { body: [] };
      if (method === "POST" && p === "/20160918/internetGateways") {
        made.push("igw");
        return { body: { id: "ocid1.igw" } };
      }
      if (method === "PUT" && p === "/20160918/securityLists/ocid1.sl") {
        made.push("sl");
        return { body: {} };
      }
      if (method === "PUT" && p === "/20160918/routeTables/ocid1.rt") {
        made.push("rt");
        return { body: {} };
      }
      if (method === "POST" && p === "/20160918/subnets") {
        made.push("subnet");
        return { body: SUBNET };
      }
      if (method === "GET" && p === "/20160918/images")
        return { body: [{ id: "ocid1.image.ubuntu" }] };
      return undefined;
    },
  };
}

describe("OCI CI executor", () => {
  it("declares vm and container, and leaves build out", () => {
    expect(plugin.manifest.ciExecutor?.kinds.map((k) => k.kind)).toEqual(["vm", "container"]);
  });

  it("launches an instance on the CI network with a retry token, tags and no legacy metadata", async () => {
    const t = tenancy();
    const { client, calls } = makeClient((url, method, body) => {
      if (method === "GET" && url.pathname === "/20160918/instances") return { body: [] };
      if (method === "POST" && url.pathname === "/20160918/instances")
        return { body: { id: "ocid1.instance.oc1..job" } };
      return t.route(url, method, body);
    });
    const handle = await client.ciStart!({ ...spec, kind: "vm" });
    expect(handle).toMatchObject({
      id: "ocid1.instance.oc1..job",
      region: "us-ashburn-1",
      data: { kind: "vm" },
    });
    const launch = calls.find(
      (c) => c.method === "POST" && c.url.pathname === "/20160918/instances",
    )!;
    expect(launch.headers["opc-retry-token"]).toMatch(/^iwci-[0-9a-f]{32}$/);
    expect(launch.headers["authorization"]).toContain('keyId="ocid1.tenancy');
    const body = launch.body as Record<string, any>;
    expect(body).toMatchObject({
      compartmentId: TENANCY,
      availabilityDomain: "Uocm:US-ASHBURN-AD-1",
      displayName: `iwci-${key}`,
      shape: "VM.Standard.E5.Flex",
      shapeConfig: { ocpus: 1, memoryInGBs: 8 },
      sourceDetails: { sourceType: "image", imageId: "ocid1.image.ubuntu" },
      createVnicDetails: { subnetId: SUBNET.id, assignPublicIp: true },
      instanceOptions: { areLegacyImdsEndpointsDisabled: true },
      freeformTags: tags,
    });
    const script = atob(body["metadata"].user_data);
    expect(script).toContain("shutdown -h +60");
    expect(script).toContain("echo hi");
    // Nothing on the network was made: it was there.
    expect(t.made).toEqual([]);
  });

  it("finds an instance an earlier start made instead of launching another", async () => {
    const t = tenancy();
    const { client, calls } = makeClient((url, method, body) => {
      if (method === "GET" && url.pathname === "/20160918/instances") {
        expect(url.searchParams.get("displayName")).toBe(`iwci-${key}`);
        return {
          body: [
            { id: "ocid1.instance.oc1..old", lifecycleState: "TERMINATED" },
            { id: "ocid1.instance.oc1..job", lifecycleState: "PROVISIONING" },
          ],
        };
      }
      return t.route(url, method, body);
    });
    const handle = await client.ciStart!({ ...spec, kind: "vm" });
    expect(handle.id).toBe("ocid1.instance.oc1..job");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("makes the CI network in a new region: nothing in, everything out, before the subnet", async () => {
    const t = tenancy({ fresh: true });
    const { client, calls } = makeClient((url, method, body) => {
      if (method === "GET" && url.pathname === "/20160918/instances") return { body: [] };
      if (method === "POST" && url.pathname === "/20160918/instances")
        return { body: { id: "ocid1.instance.oc1..job" } };
      return t.route(url, method, body);
    });
    await client.ciStart!({ ...spec, kind: "vm" });
    expect(t.made).toEqual(["vcn", "igw", "sl", "rt", "subnet"]);
    const sl = calls.find((c) => c.method === "PUT" && c.url.pathname.includes("securityLists"))!;
    expect(sl.body).toEqual({
      ingressSecurityRules: [],
      egressSecurityRules: [
        {
          destination: "0.0.0.0/0",
          destinationType: "CIDR_BLOCK",
          protocol: "all",
          isStateless: false,
        },
      ],
    });
    const rt = calls.find((c) => c.method === "PUT" && c.url.pathname.includes("routeTables"))!;
    expect(rt.body).toEqual({
      routeRules: [
        { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: "ocid1.igw" },
      ],
    });
    const vcn = calls.find((c) => c.method === "POST" && c.url.pathname === "/20160918/vcns")!;
    expect(vcn.headers["opc-retry-token"]).toMatch(/^iwci-/);
    expect((vcn.body as any).freeformTags).toEqual({ "infrawrench-ci-network": "true" });
  });

  it("moves on to the next availability domain when one is out of capacity", async () => {
    const t = tenancy();
    const { client, calls } = makeClient((url, method, body) => {
      if (method === "GET" && url.pathname === "/20160918/instances") return { body: [] };
      if (method === "POST" && url.pathname === "/20160918/instances") {
        return (body as any).availabilityDomain.endsWith("AD-1")
          ? { status: 500, body: { code: "InternalError", message: "Out of host capacity." } }
          : { body: { id: "ocid1.instance.oc1..job" } };
      }
      return t.route(url, method, body);
    });
    const handle = await client.ciStart!({ ...spec, kind: "vm" });
    expect(handle.id).toBe("ocid1.instance.oc1..job");
    const launches = calls.filter(
      (c) => c.method === "POST" && c.url.pathname === "/20160918/instances",
    );
    // Retried within the transport for the 500, then the next AD.
    expect(launches.at(-1)!.body).toMatchObject({ availabilityDomain: "Uocm:US-ASHBURN-AD-2" });
    expect(new Set(launches.map((c) => c.headers["opc-retry-token"])).size).toBe(2);
  }, 30_000);

  it("starts a container instance with no resource principal, never restarting, under the watchdog", async () => {
    const t = tenancy();
    const { client, calls } = makeClient((url, method, body) => {
      if (url.hostname.startsWith("compute-containers.")) {
        if (method === "GET") return { body: { items: [] } };
        if (method === "POST") return { body: { id: "ocid1.computecontainerinstance.oc1..job" } };
      }
      return t.route(url, method, body);
    });
    const handle = await client.ciStart!({ ...spec, kind: "container", machine: "4vcpu-16gb" });
    expect(handle).toMatchObject({
      id: "ocid1.computecontainerinstance.oc1..job",
      data: { kind: "container" },
    });
    const create = calls.find(
      (c) => c.method === "POST" && c.url.hostname.startsWith("compute-containers."),
    )!;
    expect(create.url.href).toBe(
      "https://compute-containers.us-ashburn-1.oci.oraclecloud.com/20210415/containerInstances",
    );
    const body = create.body as Record<string, any>;
    expect(body).toMatchObject({
      shape: "CI.Standard.E4.Flex",
      shapeConfig: { ocpus: 2, memoryInGBs: 16 },
      containerRestartPolicy: "NEVER",
      vnics: [{ subnetId: SUBNET.id, isPublicIpAssigned: true }],
      freeformTags: tags,
    });
    expect(body["containers"][0]).toMatchObject({
      imageUrl: "docker.io/library/buildpack-deps:noble-curl",
      command: ["/bin/sh", "-c"],
      isResourcePrincipalDisabled: true,
    });
    expect(body["containers"][0].arguments[2]).toContain("echo hi");
  });

  it("reads status, tears down idempotently and lists what is tagged", async () => {
    const { client, calls } = makeClient((url, method) => {
      const p = url.pathname;
      if (p === "/20160918/instances/ocid1.i.running")
        return { body: { id: "x", lifecycleState: "RUNNING" } };
      if (p === "/20160918/instances/ocid1.i.gone")
        return { status: 404, body: { code: "NotAuthorizedOrNotFound", message: "" } };
      if (p === "/20210415/containerInstances/ocid1.c.done")
        return { body: { id: "c", lifecycleState: "INACTIVE" } };
      if (method === "DELETE") return { status: 204 };
      if (p === "/20160918/instances") {
        return {
          body: [
            {
              id: "ocid1.i.ci",
              lifecycleState: "RUNNING",
              timeCreated: "2026-11-13T10:00:00Z",
              freeformTags: tags,
            },
            { id: "ocid1.i.other", lifecycleState: "RUNNING", freeformTags: { team: "web" } },
            { id: "ocid1.i.dead", lifecycleState: "TERMINATED", freeformTags: tags },
          ],
        };
      }
      if (p === "/20210415/containerInstances") {
        return {
          body: { items: [{ id: "ocid1.c.ci", lifecycleState: "INACTIVE", freeformTags: tags }] },
        };
      }
      return undefined;
    });
    expect(
      await client.ciStatus!({
        id: "ocid1.i.running",
        region: "us-ashburn-1",
        label: "",
        data: { kind: "vm" },
      }),
    ).toMatchObject({ state: "running" });
    expect(
      await client.ciStatus!({
        id: "ocid1.i.gone",
        region: "us-ashburn-1",
        label: "",
        data: { kind: "vm" },
      }),
    ).toEqual({ state: "gone" });
    expect(
      await client.ciStatus!({
        id: "ocid1.c.done",
        region: "us-ashburn-1",
        label: "",
        data: { kind: "container" },
      }),
    ).toMatchObject({ state: "stopped" });
    await client.ciTeardown!({
      id: "ocid1.i.running",
      region: "us-ashburn-1",
      label: "",
      data: { kind: "vm" },
    });
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url.searchParams.get("preserveBootVolume")).toBe("false");
    // Already gone is success.
    const gone = makeClient(() => ({
      status: 404,
      body: { code: "NotAuthorizedOrNotFound", message: "" },
    }));
    await gone.client.ciTeardown!({
      id: "ocid1.c.x",
      region: "us-ashburn-1",
      label: "",
      data: { kind: "container" },
    });

    const listed = await client.ciListTagged!("infrawrench-ci", []);
    expect(listed.map((t) => [t.handle.id, t.live])).toEqual([
      ["ocid1.i.ci", true],
      ["ocid1.c.ci", false],
    ]);
    expect(listed[0]!.tags).toEqual(tags);
    expect(listed[0]!.createdAt).toBe("2026-11-13T10:00:00Z");
  });

  it("checks policies and names the statements a group lacks", async () => {
    const { client } = makeClient((url) => {
      const p = url.pathname;
      if (p === "/20160918/userGroupMemberships")
        return { body: [{ groupId: "ocid1.group.ci", lifecycleState: "ACTIVE" }] };
      if (p === "/20160918/groups") return { body: [{ id: "ocid1.group.ci", name: "CiRunners" }] };
      if (p === "/20160918/policies") {
        return {
          body: [
            {
              lifecycleState: "ACTIVE",
              statements: [
                "Allow group CiRunners to manage instance-family in tenancy",
                "Allow group 'Default'/'CiRunners' to use virtual-network-family in tenancy",
                "Allow group Others to manage all-resources in tenancy",
              ],
            },
          ],
        };
      }
      if (p === "/20160918/dynamicGroups") {
        return {
          body: [
            {
              name: "everything",
              lifecycleState: "ACTIVE",
              matchingRule: `ANY {instance.compartment.id = '${TENANCY}'}`,
            },
          ],
        };
      }
      return (
        identityRoute(url) ??
        (p === "/20160918/vcns"
          ? { body: [VCN] }
          : p === "/20160918/subnets"
            ? { body: [SUBNET] }
            : undefined)
      );
    });
    const vm = await client.ciPreflight!("vm");
    expect(vm.ok).toBe(false);
    expect(vm.missing.map((m) => m.permission)).toEqual([
      "Allow group <group> to use volume-family in tenancy",
    ]);
    expect(vm.problems[0]).toContain("dynamic group everything");
    const container = await client.ciPreflight!("container");
    expect(container.missing.map((m) => m.permission)).toEqual([
      "Allow group <group> to manage compute-container-family in tenancy",
    ]);
    expect(container.problems).toEqual([]);
    await expect(client.ciPreflight!("build")).rejects.toThrow("`vm` and `container`");
  });

  it("falls back to what it can list when the policies cannot be read", async () => {
    const { client } = makeClient((url) => {
      const p = url.pathname;
      if (
        [
          "/20160918/userGroupMemberships",
          "/20160918/groups",
          "/20160918/policies",
          "/20160918/dynamicGroups",
        ].includes(p)
      ) {
        return { status: 404, body: { code: "NotAuthorizedOrNotFound", message: "" } };
      }
      if (p === "/20160918/instances")
        return { status: 404, body: { code: "NotAuthorizedOrNotFound", message: "" } };
      if (p === "/20160918/vcns") return { body: [] };
      return identityRoute(url);
    });
    const result = await client.ciPreflight!("vm", "us-ashburn-1");
    expect(result.missing.map((m) => m.permission)).toEqual([
      "Allow group <group> to manage instance-family in tenancy",
    ]);
  });
});

describe("OCI CI helpers", () => {
  it("reads shapes and container sizes", () => {
    expect(shapeOf("VM.Standard.E5.Flex/2/16")).toEqual({
      shape: "VM.Standard.E5.Flex",
      shapeConfig: { ocpus: 2, memoryInGBs: 16 },
    });
    expect(shapeOf("VM.GPU.A10.1")).toEqual({ shape: "VM.GPU.A10.1" });
    expect(() => shapeOf("VM.Standard.E5.Flex")).toThrow("needs its size");
    expect(containerShape("2vcpu-8gb")).toEqual({
      shape: "CI.Standard.E4.Flex",
      shapeConfig: { ocpus: 1, memoryInGBs: 8 },
    });
    expect(containerShape("CI.Standard.A1.Flex/2/8").shape).toBe("CI.Standard.A1.Flex");
    expect(() => containerShape("1vcpu-2gb")).toThrow("even number");
    expect(userData("#!/bin/sh\nx\n", 90)).toMatch(/^#!\/bin\/bash\nshutdown -h \+2 /);
  });

  it("reads policy statements the way OCI writes them", () => {
    const groups = new Map([["ocid1.group.a", "ci"]]);
    const s = parseStatement(
      "allow group Default/CI to MANAGE all-resources IN TENANCY where request.region = 'iad'",
    )!;
    expect(statementGrants(s, CI_GRANTS_FOR_TESTS.containers, groups)).toBe(true);
    const narrow = parseStatement("Allow group CI to use instance-family in tenancy")!;
    expect(statementGrants(narrow, CI_GRANTS_FOR_TESTS.instances, groups)).toBe(false);
    const elsewhere = parseStatement(
      "Allow group CI to manage instance-family in compartment dev",
    )!;
    expect(statementGrants(elsewhere, CI_GRANTS_FOR_TESTS.instances, groups)).toBe(false);
    const byId = parseStatement(
      "Allow group id ocid1.group.a to manage instance-family in tenancy",
    )!;
    expect(statementGrants(byId, CI_GRANTS_FOR_TESTS.instances, groups)).toBe(true);
    const anyone = parseStatement("Allow any-user to manage instance-family in tenancy")!;
    expect(statementGrants(anyone, CI_GRANTS_FOR_TESTS.instances, new Map())).toBe(true);
    expect(parseStatement("Endorse group X to read objects in tenancy Y")).toBeNull();
  });
});
