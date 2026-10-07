import { describe, expect, it } from "vitest";
import { IbmApiError, decodeJwt, parseIbmError } from "../api.js";
import { monthsIn, resourceIdFor, usageToRows } from "../billing.js";
import { normaliseKey } from "../create.js";
import { analyseRules, parseBucketList } from "../listers.js";
import { plugin } from "../plugin.js";
import { parseLocationConstraint } from "../regions.js";
import { parseStatusFeed } from "../status-feed.js";
import { TEST_TOKEN, makeClient } from "./helpers.js";

const vsi = (id: string, region: string) => ({
  id,
  name: `vsi-${id}`,
  status: "running",
  zone: { name: `${region}-1` },
  profile: { name: "bx2-2x8" },
  vcpu: { count: 2 },
  memory: 8,
  image: { id: "r006-img", name: "ibm-ubuntu-24-04" },
  vpc: { id: "vpc-1" },
  primary_network_interface: {
    id: `nic-${id}`,
    primary_ip: { address: "10.0.0.4" },
    subnet: { id: "sub-1" },
  },
  created_at: "2026-01-01T00:00:00Z",
});

describe("IAM and transport", () => {
  it("exchanges the API key once, sends the bearer token and reads the account from the JWT", async () => {
    const { client, calls, tokenCalls } = makeClient(() => undefined);
    const [account] = await client.listResources("account", "a");
    expect(account?.externalId).toBe("acct123");
    expect(account?.fields["identity"]).toBe("ci@example.com");
    await client.listResources("account", "a");
    expect(tokenCalls()).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("pages VPC collections by the start token in next.href, in every region", async () => {
    const { client, calls } = makeClient((req) => {
      const region = req.url.host.split(".")[0]!;
      if (req.url.pathname === "/v1/floating_ips") {
        return {
          body: {
            floating_ips: [
              { id: "fip", name: "ip", address: "169.1.1.1", target: { id: "nic-a" } },
            ],
          },
        };
      }
      if (req.url.pathname !== "/v1/instances") return undefined;
      if (region === "us-south" && !req.url.searchParams.get("start")) {
        return {
          body: {
            instances: [vsi("a", region)],
            next: { href: `https://${req.url.host}/v1/instances?limit=100&start=tok2` },
          },
        };
      }
      if (region === "us-south") return { body: { instances: [vsi("b", region)] } };
      return { body: { instances: [vsi("c", region)] } };
    });
    const list = await client.listResources("instance", "a");
    expect(list.map((r) => r.externalId).sort()).toEqual(["eu-de/c", "us-south/a", "us-south/b"]);
    const a = list.find((r) => r.externalId === "us-south/a")!;
    expect(a.resolvedOutputs).toMatchObject({
      publicIp: "169.1.1.1",
      privateIp: "10.0.0.4",
      id: "a",
    });
    expect(a.fields).toMatchObject({
      profile: "bx2-2x8",
      vcpus: 2,
      memoryGb: 8,
      imageId: "r006-img",
    });
    const call = calls.find((c) => c.url.pathname === "/v1/instances")!;
    expect(call.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    expect(call.url.searchParams.get("version")).toBe("2026-09-24");
    expect(call.url.searchParams.get("generation")).toBe("2");
    expect(calls.some((c) => c.url.searchParams.get("start") === "tok2")).toBe(true);
  });

  it("maps errors to IbmApiError with the HTTP status, and throws when every region refuses", async () => {
    const { client } = makeClient(() => ({
      status: 403,
      body: { errors: [{ code: "forbidden", message: "nope" }] },
    }));
    const err = await client.listResources("vpc", "a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IbmApiError);
    expect((err as IbmApiError).status).toBe(403);
    expect((err as IbmApiError).code).toBe("forbidden");
  });

  it("parses every IBM error shape", () => {
    expect(parseIbmError('{"error_code":"RC-x","message":"m"}')).toEqual({
      code: "RC-x",
      message: "m",
    });
    expect(parseIbmError('{"code":"G0001","description":"d"}')).toEqual({
      code: "G0001",
      message: "d",
    });
    expect(parseIbmError("gateway down").message).toBe("gateway down");
  });

  it("decodes the account id claim", () => {
    expect(decodeJwt(TEST_TOKEN)["account"]).toEqual({ bss: "acct123" });
  });
});

describe("services", () => {
  it("lists VPC and classic clusters from the global endpoint", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.url.pathname === "/global/v2/vpc/getClusters") {
        return {
          body: [
            {
              id: "c1",
              name: "prod",
              region: "us-south",
              masterKubeVersion: "1.33.2",
              state: "normal",
              masterURL: "https://c1.example:30000",
            },
          ],
        };
      }
      if (req.url.pathname === "/global/v2/classic/getClusters") return { body: [] };
      return undefined;
    });
    const [cluster] = await client.listResources("kubernetes-cluster", "a");
    expect(cluster).toMatchObject({
      externalId: "c1",
      resolvedOutputs: { masterUrl: "https://c1.example:30000" },
    });
    expect(calls[0]!.url.searchParams.get("provider")).toBe("vpc-gen2");
  });

  it("splits resource controller instances into databases and other services", async () => {
    const pg = "crn:v1:bluemix:public:databases-for-postgresql:us-south:a/acct123:guid1::";
    const kp = "crn:v1:bluemix:public:kms:us-south:a/acct123:guid2::";
    const { client } = makeClient((req) => {
      if (req.url.pathname === "/v2/resource_instances") {
        return {
          body: {
            resources: [
              { id: pg, crn: pg, name: "orders-db", region_id: "us-south", state: "active" },
              {
                id: kp,
                crn: kp,
                guid: "guid2",
                name: "keys",
                region_id: "us-south",
                state: "active",
              },
            ],
          },
        };
      }
      if (req.url.host === "api.us-south.databases.cloud.ibm.com") {
        if (req.url.pathname.endsWith("/groups")) {
          return {
            body: {
              groups: [
                {
                  id: "member",
                  members: { allocation_count: 2 },
                  memory: { allocation_mb: 8192 },
                  disk: { allocation_mb: 20480 },
                },
              ],
            },
          };
        }
        return { body: { deployment: { version: "16" } } };
      }
      return undefined;
    });
    const [db] = await client.listResources("database", "a");
    expect(db).toMatchObject({
      externalId: pg,
      fields: { service: "databases-for-postgresql", version: "16", members: 2, memoryMb: 8192 },
    });
    const services = await client.listResources("service-instance", "a");
    expect(services.map((s) => s.fields["service"])).toEqual(["kms"]);
  });

  it("lists COS buckets with their location and storage class", async () => {
    const cos = "crn:v1:bluemix:public:cloud-object-storage:global:a/acct123:cosguid::";
    const { client, calls } = makeClient((req) => {
      if (req.url.pathname === "/v2/resource_instances") {
        return { body: { resources: [{ id: cos, crn: cos, guid: "cosguid", name: "cos" }] } };
      }
      if (req.url.host === "s3.us.cloud-object-storage.appdomain.cloud") {
        return {
          raw: "<ListAllMyBucketsResult><Buckets><Bucket><Name>logs</Name><CreationDate>2026-01-01T00:00:00Z</CreationDate><LocationConstraint>eu-de-smart</LocationConstraint></Bucket></Buckets></ListAllMyBucketsResult>",
        };
      }
      if (req.url.host === "config.cloud-object-storage.cloud.ibm.com") {
        return { body: { object_count: 10, bytes_used: 2 * 1024 ** 3 } };
      }
      return undefined;
    });
    const [bucket] = await client.listResources("cos-bucket", "a");
    expect(bucket).toMatchObject({
      externalId: "eu-de/logs",
      fields: {
        storageClass: "smart",
        objectCount: 10,
        storageGb: 2,
        serviceInstanceId: "cosguid",
      },
      resolvedOutputs: { endpoint: "s3.eu-de.cloud-object-storage.appdomain.cloud" },
    });
    const list = calls.find((c) => c.url.host.startsWith("s3."))!;
    expect(list.url.search).toBe("?extended");
    expect(list.headers["ibm-service-instance-id"]).toBe("cosguid");
  });

  it("sends VPC edits as merge-patch and server actions as POSTs", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.url.pathname === "/v1/instances/a" && req.method === "GET")
        return { body: vsi("a", "us-south") };
      if (req.url.pathname === "/v1/floating_ips") return { body: { floating_ips: [] } };
      return { body: {} };
    });
    await client.updateResource("instance", "a:instance:us-south/a", "a", { profile: "bx2-4x16" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.headers["content-type"]).toBe("application/merge-patch+json");
    expect(JSON.parse(patch.body as string)).toEqual({ profile: { name: "bx2-4x16" } });
    await client.invokeAction("instance", "a:instance:us-south/a", "stop-force", "a");
    const action = calls.find((c) => c.url.pathname === "/v1/instances/a/actions")!;
    expect(JSON.parse(action.body as string)).toEqual({ type: "stop", force: true });
  });
});

describe("mappers", () => {
  it("flags SSH open to the world", () => {
    const r = analyseRules([
      {
        direction: "inbound",
        protocol: "tcp",
        port_min: 22,
        port_max: 22,
        remote: { cidr_block: "0.0.0.0/0" },
      },
      {
        direction: "inbound",
        protocol: "tcp",
        port_min: 443,
        port_max: 443,
        remote: { cidr_block: "10.0.0.0/8" },
      },
      { direction: "outbound", protocol: "any", remote: { cidr_block: "0.0.0.0/0" } },
    ]);
    expect(r).toMatchObject({ adminOpen: true, openPorts: "22" });
    expect(
      analyseRules([{ direction: "inbound", protocol: "any", remote: { cidr_block: "0.0.0.0/0" } }])
        .adminOpen,
    ).toBe(true);
  });

  it("parses COS location constraints and bucket listings", () => {
    expect(parseLocationConstraint("us-south-smart")).toEqual({
      location: "us-south",
      storageClass: "smart",
    });
    expect(parseLocationConstraint("ams03-standard")).toEqual({
      location: "ams03",
      storageClass: "standard",
    });
    expect(parseBucketList("<Buckets></Buckets>")).toEqual([]);
  });

  it("normalises SSH keys for matching", () => {
    expect(normaliseKey("ssh-ed25519 AAAA  me@laptop\n")).toBe("ssh-ed25519 AAAA");
  });
});

describe("billing", () => {
  it("covers every month a range touches", () => {
    expect(monthsIn({ fromDate: "2025-11-20", toDate: "2026-01-02" } as never)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("maps usage records to monthly rows keyed like this plugin's resources", () => {
    const rows = usageToRows("2026-09", [
      {
        resource_instance_id: "crn:v1:bluemix:public:is:us-south-1:a/acct::instance:0717_abc",
        resource_name: "Virtual Server for VPC",
        region: "us-south",
        currency_code: "USD",
        plan_name: "Gen2",
        usage: [
          {
            metric_name: "Instance hours",
            quantity: 720,
            cost: 70,
            rated_cost: 80,
            unit_name: "hours",
          },
        ],
      },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-09-01",
        resourceId: "us-south/0717_abc",
        amount: 70,
        listAmount: 80,
        usageAmount: 720,
        usageUnit: "hours",
        tags: expect.objectContaining({ plan: "Gen2", metric: "Instance hours" }),
      }),
    ]);
    expect(
      resourceIdFor(
        "crn:v1:bluemix:public:containers-kubernetes:us-south:a/acct:cl123::",
        "us-south",
      ),
    ).toBe("cl123");
  });

  it("turns a refused usage read into a setup error", async () => {
    const { client } = makeClient(() => ({
      status: 403,
      body: { errors: [{ code: "forbidden", message: "no" }] },
    }));
    await expect(
      client.fetchCostData("a", { fromDate: "2026-09-01", toDate: "2026-09-30" } as never),
    ).rejects.toThrow(/Billing/);
  });
});

describe("status feed", () => {
  it("keeps open incidents and maintenance, drops announcements and resolved outages", () => {
    const item = (title: string, type: string, extra = "") =>
      `<item><title><![CDATA[${title}]]></title><description><![CDATA[<p>Details.</p> Type: ${type} <br /> Regions: us-south, eu-de <br /> Resources: is.instance <br />${extra} Update Time: Mon Oct 06 2026 10:00:00 GMT+0000 <br />]]></description><link>https://cloud.ibm.com/status?x=1</link><guid isPermaLink="false">${title}</guid><pubDate>Mon, 06 Oct 2026 10:00:00 GMT</pubDate></item>`;
    const rss = `<?xml version="1.0"?><rss><channel>${item("VPC errors", "incident", " Outage Start: Mon Oct 06 2026 09:00:00 GMT+0000 <br />")}${item("New feature", "announcement")}${item("Old outage", "incident", " Outage End: Mon Jan 05 2026 09:00:00 GMT+0000 <br />")}${item("Patching", "maintenance")}</channel></rss>`;
    const incidents = parseStatusFeed(rss);
    expect(incidents.map((i) => i.title)).toEqual(["VPC errors", "Patching"]);
    expect(incidents[0]).toMatchObject({
      regions: ["us-south", "eu-de"],
      services: ["is.instance"],
      impact: "major",
    });
    expect(incidents[1]!.impact).toBe("maintenance");
  });
});

describe("terraform", () => {
  it("imports Code Engine apps by project and name", () => {
    const out = plugin.terraformExport!.mapResource({
      id: "a:code-engine-app:us-south/p1/web",
      pluginId: "ibm-cloud",
      resourceTypeId: "code-engine-app",
      accountId: "a",
      displayName: "web",
      externalId: "us-south/p1/web",
      fields: {
        name: "web",
        projectId: "p1",
        image: "icr.io/codeengine/helloworld",
        region: "us-south",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource).toMatchObject({ type: "ibm_code_engine_app", importId: "p1/web" });
  });
});
