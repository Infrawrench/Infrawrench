import { describe, expect, it } from "vitest";
import { identityRoute, makeClient, TENANCY, type Reply } from "./helpers.js";

const PROD = "ocid1.compartment.oc1..prod";
const INSTANCE = "ocid1.instance.oc1.iad.aaaainst";

function computeRoute(url: URL): Reply | undefined {
  if (!url.hostname.startsWith("iaas.")) return undefined;
  const compartment = url.searchParams.get("compartmentId");
  if (url.pathname === "/20160918/instances") {
    if (compartment !== PROD) return { body: [] };
    return {
      body: [
        {
          id: INSTANCE,
          displayName: "web-1",
          compartmentId: PROD,
          availabilityDomain: "Uocm:US-ASHBURN-AD-1",
          region: "us-ashburn-1",
          shape: "VM.Standard.E4.Flex",
          shapeConfig: { ocpus: 2, memoryInGBs: 32, vcpus: 4, processorDescription: "AMD EPYC" },
          imageId: "ocid1.image.oc1.iad.ubuntu",
          lifecycleState: "RUNNING",
          timeCreated: "2026-01-01T00:00:00Z",
        },
        {
          id: "ocid1.instance.oc1.iad.gone",
          displayName: "old",
          compartmentId: PROD,
          availabilityDomain: "Uocm:US-ASHBURN-AD-1",
          region: "us-ashburn-1",
          shape: "VM.Standard2.1",
          lifecycleState: "TERMINATED",
        },
      ],
    };
  }
  if (url.pathname === "/20160918/vnicAttachments") {
    return {
      body: [
        {
          instanceId: INSTANCE,
          vnicId: "vnic1",
          subnetId: "ocid1.subnet.oc1.iad.s1",
          nicIndex: 0,
          lifecycleState: "ATTACHED",
        },
      ],
    };
  }
  if (url.pathname === "/20160918/vnics/vnic1")
    return { body: { publicIp: "203.0.113.7", privateIp: "10.0.0.7" } };
  if (url.pathname === "/20160918/bootVolumeAttachments") {
    return {
      body: [
        {
          instanceId: INSTANCE,
          bootVolumeId: "ocid1.bootvolume.oc1.iad.b1",
          lifecycleState: "ATTACHED",
        },
      ],
    };
  }
  if (url.pathname === "/20160918/images/ocid1.image.oc1.iad.ubuntu") {
    return {
      body: {
        displayName: "Canonical-Ubuntu-24.04-2026.09.01-0",
        operatingSystem: "Canonical Ubuntu",
      },
    };
  }
  if (url.pathname === `/20160918/instances/${INSTANCE}`) return { body: {} };
  return undefined;
}

describe("OracleCloudClient listing", () => {
  it("lists instances across compartments with IPs, size and SSH user resolved", async () => {
    const { client, calls } = makeClient(
      (url, method, body) => identityRoute(url) ?? computeRoute(url),
    );
    const instances = await client.listResources("instance", "acct");
    expect(instances).toHaveLength(1);
    const [web] = instances;
    expect(web!.id).toBe(`acct:instance:${INSTANCE}`);
    expect(web!.fields).toMatchObject({
      name: "web-1",
      size: "VM.Standard.E4.Flex/2/32",
      vcpus: 4,
      status: "RUNNING",
      compartmentName: "prod",
      sshUsername: "ubuntu",
      bootVolumeId: "ocid1.bootvolume.oc1.iad.b1",
      subnetId: "ocid1.subnet.oc1.iad.s1",
      billedWhenStopped: false,
    });
    expect(web!.resolvedOutputs).toMatchObject({ publicIp: "203.0.113.7", privateIp: "10.0.0.7" });
    // Search refused → every compartment (root and prod) is visited.
    const listed = calls
      .filter((c) => c.url.pathname === "/20160918/instances")
      .map((c) => c.url.searchParams.get("compartmentId"));
    expect(listed.sort()).toEqual([PROD, TENANCY].sort());
    // Every request is signed with x-date and the key id.
    expect(calls[0]!.headers["authorization"]).toMatch(
      /^Signature version="1",keyId="ocid1\.tenancy/,
    );
    expect(calls[0]!.headers["x-date"]).toBeTruthy();
  });

  it("uses Resource Search to visit only compartments that hold the type", async () => {
    const { client, calls } = makeClient((url) => {
      if (url.hostname.startsWith("query.")) {
        return {
          body: {
            items: [
              { resourceType: "Instance", compartmentId: PROD },
              { resourceType: "Vcn", compartmentId: "ocid1.compartment.oc1..other" },
            ],
          },
        };
      }
      return identityRoute(url) ?? computeRoute(url);
    });
    await client.listResources("instance", "acct");
    const listed = calls
      .filter((c) => c.url.pathname === "/20160918/instances")
      .map((c) => c.url.searchParams.get("compartmentId"));
    // prod from Search, plus root always (Search is eventually consistent).
    expect(listed.sort()).toEqual([PROD, TENANCY].sort());
    const search = calls.find((c) => c.url.hostname.startsWith("query."));
    expect(search!.url.hostname).toBe("query.us-ashburn-1.oci.oraclecloud.com");
    expect((search!.body as { query: string }).query).toContain("query instance, volume");
  });

  it("treats a compartment the user cannot read as empty, not as a failure", async () => {
    const { client } = makeClient((url) => {
      if (url.hostname.startsWith("iaas.") && url.pathname === "/20160918/vcns") {
        if (url.searchParams.get("compartmentId") === PROD) {
          return { status: 404, body: { code: "NotAuthorizedOrNotFound", message: "x" } };
        }
        return {
          body: [
            {
              id: "ocid1.vcn.oc1.iad.v",
              displayName: "main",
              compartmentId: TENANCY,
              cidrBlocks: ["10.0.0.0/16"],
              lifecycleState: "AVAILABLE",
            },
          ],
        };
      }
      return identityRoute(url);
    });
    const vcns = await client.listResources("vcn", "acct");
    expect(vcns.map((v) => v.fields["cidrBlocks"])).toEqual(["10.0.0.0/16"]);
  });

  it("flags security lists that open SSH to the internet", async () => {
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/securityLists") {
        if (url.searchParams.get("compartmentId") !== TENANCY) return { body: [] };
        return {
          body: [
            {
              id: "ocid1.securitylist.oc1.iad.sl",
              displayName: "Default",
              compartmentId: TENANCY,
              vcnId: "ocid1.vcn.oc1.iad.v",
              lifecycleState: "AVAILABLE",
              ingressSecurityRules: [
                {
                  protocol: "6",
                  source: "0.0.0.0/0",
                  tcpOptions: { destinationPortRange: { min: 22, max: 22 } },
                },
                {
                  protocol: "6",
                  source: "0.0.0.0/0",
                  tcpOptions: { destinationPortRange: { min: 443, max: 443 } },
                },
                { protocol: "1", source: "10.0.0.0/16" },
              ],
              egressSecurityRules: [{ protocol: "all", destination: "0.0.0.0/0" }],
            },
          ],
        };
      }
      return identityRoute(url);
    });
    const [list] = await client.listResources("security-list", "acct");
    expect(list!.fields).toMatchObject({
      internetOpenPorts: "22, 443",
      adminPortsOpen: true,
      ingressRuleCount: 3,
      egressRuleCount: 1,
    });
  });

  it("lists budgets from the root compartment in the home region", async () => {
    const { client, calls } = makeClient((url) => {
      if (
        url.hostname === "usage.us-ashburn-1.oci.oraclecloud.com" &&
        url.pathname === "/20190111/budgets"
      ) {
        return {
          body: [
            {
              id: "ocid1.budget.oc1.iad.b",
              displayName: "prod monthly",
              amount: 500,
              targetType: "COMPARTMENT",
              targets: [PROD],
              actualSpend: 123.4,
              forecastedSpend: 410,
              alertRuleCount: 1,
              lifecycleState: "ACTIVE",
            },
          ],
        };
      }
      return identityRoute(url);
    });
    const [budget] = await client.listResources("budget", "acct");
    expect(budget!.fields).toMatchObject({ amount: 500, targets: PROD, actualSpend: 123.4 });
    expect(calls.at(-1)!.url.searchParams.get("compartmentId")).toBe(TENANCY);
  });
});

describe("OracleCloudClient mutations", () => {
  it("starts an instance with an InstanceAction in the OCID's region", async () => {
    const { client, calls } = makeClient((url, method) => {
      if (method === "POST" && url.pathname === `/20160918/instances/${INSTANCE}`)
        return { body: {} };
      return identityRoute(url);
    });
    await client.invokeAction("instance", `acct:instance:${INSTANCE}`, "START", "acct");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url.hostname).toBe("iaas.us-ashburn-1.oraclecloud.com");
    expect(post.url.searchParams.get("action")).toBe("START");
    expect(post.headers["x-content-sha256"]).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  });

  it("resizes a flex instance from the size field", async () => {
    let putBody: unknown;
    const { client } = makeClient((url, method, body) => {
      if (method === "PUT" && url.pathname === `/20160918/instances/${INSTANCE}`) {
        putBody = body;
        return { body: {} };
      }
      if (method === "GET" && url.pathname === `/20160918/instances/${INSTANCE}`) {
        return {
          body: {
            id: INSTANCE,
            displayName: "web-1",
            compartmentId: PROD,
            availabilityDomain: "Uocm:US-ASHBURN-AD-1",
            region: "us-ashburn-1",
            shape: "VM.Standard.E4.Flex",
            shapeConfig: { ocpus: 1, memoryInGBs: 16 },
            lifecycleState: "RUNNING",
          },
        };
      }
      return identityRoute(url) ?? { body: [] };
    });
    const updated = await client.updateResource("instance", `acct:instance:${INSTANCE}`, "acct", {
      size: "VM.Standard.E4.Flex/1/16",
    });
    expect(putBody).toEqual({
      shape: "VM.Standard.E4.Flex",
      shapeConfig: { ocpus: 1, memoryInGBs: 16 },
    });
    expect(updated.fields["size"]).toBe("VM.Standard.E4.Flex/1/16");
  });

  it("creates a tag budget with an initial alert rule", async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    const { client } = makeClient((url, method, body) => {
      if (method === "POST" && url.hostname.startsWith("usage.")) {
        posted.push({ path: url.pathname, body });
        if (url.pathname === "/20190111/budgets") {
          return {
            body: {
              id: "ocid1.budget.oc1.iad.new",
              displayName: "team",
              amount: 100,
              lifecycleState: "ACTIVE",
              targetType: "TAG",
              targets: ["Ops.team.web"],
            },
          };
        }
        return { body: {} };
      }
      return identityRoute(url);
    });
    const budget = await client.createResource("budget", "acct", {
      name: "team",
      amount: "99.6",
      targetType: "TAG",
      targetTagKey: "Ops.team",
      targetTagValue: "web",
      alertThresholdPercent: "80",
      alertRecipients: "a@example.com, b@example.com",
    });
    expect(posted[0]!.body).toMatchObject({
      compartmentId: TENANCY,
      amount: 100,
      resetPeriod: "MONTHLY",
      targetType: "TAG",
      targets: ["Ops.team.web"],
    });
    expect(posted[1]).toEqual({
      path: "/20190111/budgets/ocid1.budget.oc1.iad.new/alertRules",
      body: {
        displayName: "team 80%",
        type: "ACTUAL",
        thresholdType: "PERCENTAGE",
        threshold: 80,
        recipients: "a@example.com, b@example.com",
      },
    });
    expect(budget.fields["alertRuleCount"]).toBe(1);
  });

  it("attaches a block volume as paravirtualized", async () => {
    const { client, calls } = makeClient((url, method) =>
      method === "POST" && url.pathname === "/20160918/volumeAttachments"
        ? { body: {} }
        : identityRoute(url),
    );
    await client.attachResource(
      "block-volume",
      "acct:block-volume:ocid1.volume.oc1.iad.v",
      "instance",
      `acct:instance:${INSTANCE}`,
      "acct",
    );
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      type: "paravirtualized",
      instanceId: INSTANCE,
      volumeId: "ocid1.volume.oc1.iad.v",
    });
  });

  it("returns an OKE kubeconfig as raw text with a CLI warning", async () => {
    const { client } = makeClient((url, method) =>
      method === "POST" && url.pathname.endsWith("/kubeconfig/content")
        ? { raw: "apiVersion: v1\nkind: Config\n" }
        : identityRoute(url),
    );
    const out = await client.exportCredential(
      "oke-cluster",
      "acct:oke-cluster:ocid1.cluster.oc1.iad.c",
      "acct",
      "kubeconfig",
    );
    expect(out.content).toContain("kind: Config");
    expect(out.warning).toMatch(/OCI CLI/);
  });

  it("browses a bucket's objects with folders and object names", async () => {
    const { client } = makeClient((url) => {
      if (url.hostname.startsWith("objectstorage.")) {
        if (url.pathname === "/n") return { body: "acmens" };
        if (url.pathname === "/n/acmens/b/logs/o") {
          return {
            body: {
              prefixes: ["2026/"],
              objects: [{ name: "readme.txt", size: 12, timeModified: "2026-10-01T00:00:00Z" }],
            },
          };
        }
      }
      return identityRoute(url);
    });
    const objects = await client.listStorageObjects("eu-frankfurt-1/logs", "");
    expect(objects).toEqual([
      { key: "2026/", name: "2026", size: 0, lastModified: "", isDirectory: true },
      {
        key: "readme.txt",
        name: "readme.txt",
        size: 12,
        lastModified: "2026-10-01T00:00:00Z",
        isDirectory: false,
      },
    ]);
  });
});
