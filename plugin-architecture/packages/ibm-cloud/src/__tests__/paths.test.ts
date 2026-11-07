import { describe, expect, it } from "vitest";
import { vpcBase } from "../regions.js";
import { makeClient, type Recorded, type Reply } from "./helpers.js";

const AWKWARD = "a/b?c";
const ENCODED = "a%2Fb%3Fc";

const VPC_ROUTES: Array<[string, string]> = [
  ["instance", "instances"],
  ["volume", "volumes"],
  ["vpc", "vpcs"],
  ["subnet", "subnets"],
  ["security-group", "security_groups"],
  ["floating-ip", "floating_ips"],
  ["load-balancer", "load_balancers"],
  ["ssh-key", "keys"],
];

const empty = (): Reply => ({ body: {} });

/** The paths exactly as they were sent, which `URL` keeps encoded. */
const sent = (calls: Recorded[], method: string) =>
  calls.filter((c) => c.method === method).map((c) => c.url.pathname);

describe("path segments", () => {
  it.each(VPC_ROUTES)("deletes a %s by its encoded id", async (typeId, route) => {
    const { client, calls } = makeClient(empty);
    await client.deleteResource(typeId, `a:${typeId}:us-south/${AWKWARD}`, "a");
    expect(sent(calls, "DELETE")).toEqual([`/v1/${route}/${ENCODED}`]);
    expect(calls[0]!.url.host).toBe("us-south.iaas.cloud.ibm.com");
    expect(calls[0]!.url.searchParams.get("version")).toBeTruthy();
  });

  it.each(VPC_ROUTES)("edits a %s by its encoded id", async (typeId, route) => {
    const { client, calls } = makeClient(empty);
    await client
      .updateResource(typeId, `a:${typeId}:us-south/${AWKWARD}`, "a", { name: "new" })
      .catch(() => undefined);
    expect(sent(calls, "PATCH")).toEqual([`/v1/${route}/${ENCODED}`]);
    expect(calls.find((c) => c.method === "PATCH")!.url.searchParams.get("version")).toBeTruthy();
  });

  it.each([
    ["resource-group", AWKWARD, `/v2/resource_groups/${ENCODED}`],
    ["kubernetes-cluster", AWKWARD, `/global/v1/clusters/${ENCODED}`],
    ["worker-pool", "c?1/p 1", "/global/v1/clusters/c%3F1/workerpools/p%201"],
    ["code-engine-project", `us-south/${AWKWARD}`, `/v2/projects/${ENCODED}`],
    ["code-engine-app", "us-south/p?1/n 1", "/v2/projects/p%3F1/apps/n%201"],
  ])("deletes a %s by its encoded id", async (typeId, ext, path) => {
    const { client, calls } = makeClient(empty);
    await client.deleteResource(typeId, `a:${typeId}:${ext}`, "a");
    expect(sent(calls, "DELETE")).toEqual([path]);
  });

  it("edits a resource group and a Code Engine app by their encoded ids", async () => {
    const { client, calls } = makeClient(empty);
    await client
      .updateResource("resource-group", `a:resource-group:${AWKWARD}`, "a", { name: "new" })
      .catch(() => undefined);
    await client
      .updateResource("code-engine-app", "a:code-engine-app:us-south/p?1/n 1", "a", { port: "80" })
      .catch(() => undefined);
    expect(sent(calls, "PATCH")).toEqual([
      `/v2/resource_groups/${ENCODED}`,
      "/v2/projects/p%3F1/apps/n%201",
    ]);
  });

  it("encodes the server in an action, an attachment and a read", async () => {
    const { client, calls } = makeClient((req) =>
      req.url.pathname === "/v1/floating_ips" ? { body: { floating_ips: [] } } : { body: {} },
    );
    await client.invokeAction("instance", `a:instance:us-south/${AWKWARD}`, "reboot", "a");
    await client.attachResource(
      "volume",
      "a:volume:us-south/v",
      "instance",
      `a:instance:us-south/${AWKWARD}`,
      "a",
    );
    expect(sent(calls, "POST")).toEqual([
      `/v1/instances/${ENCODED}/actions`,
      `/v1/instances/${ENCODED}/volume_attachments`,
    ]);
    await client.getResource("instance", `a:instance:us-south/${AWKWARD}`, "a");
    expect(sent(calls, "GET")).toContain(`/v1/instances/${ENCODED}`);
  });

  it("encodes the floating IP it binds and the server it reads", async () => {
    const { client, calls } = makeClient((req) =>
      req.method === "GET" ? { body: { primary_network_interface: { id: "nic" } } } : { body: {} },
    );
    await client.attachResource(
      "floating-ip",
      `a:floating-ip:us-south/${AWKWARD}`,
      "instance",
      `a:instance:us-south/${AWKWARD}`,
      "a",
    );
    expect(sent(calls, "GET")).toEqual([`/v1/instances/${ENCODED}`]);
    expect(sent(calls, "PATCH")).toEqual([`/v1/floating_ips/${ENCODED}`]);
  });

  it("encodes a project id from the API when listing its apps", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.url.pathname === "/v2/projects") {
        return { body: { limit: 100, projects: [{ id: AWKWARD, name: "p" }] } };
      }
      return { body: { limit: 100, apps: [] } };
    });
    await client.listResources("code-engine-app", "a", { regionHint: "us-south" });
    expect(sent(calls, "GET")).toContain(`/v2/projects/${ENCODED}/apps`);
  });

  it("encodes the chosen subnet and project when creating", async () => {
    const { client, calls } = makeClient((req) =>
      req.method === "POST" ? { body: { name: "web" } } : { status: 500, body: {} },
    );
    await client
      .createResource("instance", "a", {
        name: "vm",
        region: "us-south",
        subnetId: AWKWARD,
        sshPublicKey: "ssh-ed25519 AAAA",
        image: "r006-x",
        profile: "bx2-2x8",
      })
      .catch(() => undefined);
    expect(sent(calls, "GET")).toEqual([`/v1/subnets/${ENCODED}`]);
    await client.createResource("code-engine-app", "a", {
      name: "web",
      image: "icr.io/x",
      region: "us-south",
      projectId: AWKWARD,
    });
    expect(sent(calls, "POST")).toEqual([`/v2/projects/${ENCODED}/apps`]);
  });

  it("encodes the account id from the token in usage and summary reads", async () => {
    const { client, calls } = makeClient(
      (req) =>
        req.url.pathname.includes("/summary/")
          ? { body: { billing_currency_code: "USD", offers: [] } }
          : { body: { count: 0, resources: [] } },
      {},
      AWKWARD,
    );
    await client.fetchCostData("a", { fromDate: "2026-09-01", toDate: "2026-09-30" } as never);
    await client.fetchCreditBalance!("a");
    expect(sent(calls, "GET")[0]).toBe(`/v4/accounts/${ENCODED}/resource_instances/usage/2026-09`);
    expect(sent(calls, "GET")[1]).toMatch(new RegExp(`^/v4/accounts/${ENCODED}/summary/`));
  });
});

describe("region in a host name", () => {
  it.each([
    ["instance", "evil.example#/x"],
    ["instance", "evil.example:443/x"],
    ["code-engine-project", "evil.example#/x"],
    ["code-engine-app", "evil.example#/p/n"],
    ["cos-bucket", "evil.example#/x"],
  ])("refuses to send a %s to %s", async (typeId, ext) => {
    const { client, calls } = makeClient(empty);
    await expect(client.deleteResource(typeId, `a:${typeId}:${ext}`, "a")).rejects.toThrow(
      /not a region/,
    );
    expect(calls).toHaveLength(0);
  });

  it("accepts every shape of region IBM writes", () => {
    expect(vpcBase("us-south")).toBe("https://us-south.iaas.cloud.ibm.com/v1");
    expect(vpcBase("in-mum")).toBe("https://in-mum.iaas.cloud.ibm.com/v1");
    expect(() => vpcBase("")).toThrow(/not a region/);
  });
});

describe("blank ids", () => {
  it.each([
    ["instance", "us-south/"],
    ["instance", "/x"],
    ["instance", ""],
    ["resource-group", ""],
    ["kubernetes-cluster", ""],
    ["worker-pool", "c"],
    ["worker-pool", "c/"],
    ["worker-pool", "/p"],
    ["code-engine-project", "us-south/"],
    ["code-engine-app", "us-south/p"],
    ["code-engine-app", "us-south/p/"],
    ["code-engine-app", "us-south//n"],
    ["cos-bucket", "us-south/"],
    ["database", ""],
    ["service-instance", ""],
  ])("refuses to delete a %s with the id %j", async (typeId, ext) => {
    const { client, calls } = makeClient(empty);
    await expect(client.deleteResource(typeId, `a:${typeId}:${ext}`, "a")).rejects.toThrow(
      /malformed id/,
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["resource-group", ""],
    ["service-instance", ""],
    ["worker-pool", "c"],
    ["code-engine-app", "us-south/p"],
  ])("refuses to edit a %s with the id %j", async (typeId, ext) => {
    const { client, calls } = makeClient(empty);
    await expect(
      client.updateResource(typeId, `a:${typeId}:${ext}`, "a", {
        name: "new",
        sizePerZone: "2",
        port: "80",
      }),
    ).rejects.toThrow(/malformed id/);
    expect(calls).toHaveLength(0);
  });
});
