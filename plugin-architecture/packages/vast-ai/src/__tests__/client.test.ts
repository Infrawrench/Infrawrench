import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VastClient } from "../client.js";
import { VastApiError } from "../api.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { buildDockerFlags, buildEnvObject, envKeysOf, portsOf } from "../docker-env.js";
import { isoFromEpoch, normalizeStatus } from "../mappers.js";
import { mapCharges, parseSource, spreadByDay } from "../cost-data.js";
import { offerOption } from "../create-config.js";
import { vastRemediationCommands } from "../remediation.js";

interface Call {
  method: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}
type Route = (call: Call) => unknown;
let calls: Call[] = [];
let routes: Record<string, Route> = {};

function route(method: string, path: string, handler: Route | unknown) {
  routes[`${method} ${path}`] = typeof handler === "function" ? (handler as Route) : () => handler;
}

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const call: Call = {
        method: init.method ?? "GET",
        url: u,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const handler = routes[`${call.method} ${u.pathname}`];
      if (!handler) {
        return new Response(
          JSON.stringify({ success: false, error: "not_found", msg: "Not found" }),
          {
            status: 404,
          },
        );
      }
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const client = () => new VastClient({ apiKey: "KEY" }, RESOURCE_TYPES);

const INSTANCE = {
  id: 312,
  label: "train",
  actual_status: "running",
  intended_status: "running",
  gpu_name: "RTX 4090",
  num_gpus: 2,
  gpu_ram: 24564,
  cpu_cores_effective: 16,
  cpu_ram: 64000,
  disk_space: 50,
  image_uuid: "pytorch/pytorch",
  template_id: 99,
  public_ipaddr: "1.2.3.4",
  ssh_host: "ssh5.vast.ai",
  ssh_port: 10600,
  ports: { "22/tcp": [{ HostIp: "0.0.0.0", HostPort: "40022" }] },
  dph_total: 0.81,
  is_bid: false,
  geolocation: "California, US",
  reliability2: 0.995,
  gpu_util: 87.5,
  cpu_util: 0.25,
  disk_usage: 40,
  start_date: 1_760_000_000,
  end_date: 1_790_000_000,
  jupyter_token: "secret-token",
  volume_info: [{ volume_id: 7, mount_path: "/data" }],
};

describe("api", () => {
  it("sends Bearer auth and maps errors with status", async () => {
    route(
      "GET",
      "/api/v0/ssh/",
      () =>
        new Response(JSON.stringify({ success: false, error: "auth", msg: "Invalid API key" }), {
          status: 401,
        }),
    );
    const err = (await client()
      .listResources("ssh-key", "acct")
      .catch((e: unknown) => e)) as VastApiError;
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer KEY");
    expect(err).toBeInstanceOf(VastApiError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("Invalid API key");
  });

  it("treats a 200 with success:false as an error", async () => {
    route("GET", "/api/v0/endptjobs/", { success: false, msg: "nope" });
    await expect(client().listResources("serverless-endpoint", "acct")).rejects.toThrow(/nope/);
  });

  it("follows next_token on instances", async () => {
    route("GET", "/api/v1/instances/", (c: Call) =>
      c.url.searchParams.get("after_token")
        ? { instances: [{ ...INSTANCE, id: 313 }], next_token: null }
        : { instances: [INSTANCE], next_token: "abc" },
    );
    const list = await client().listResources("instance", "acct");
    expect(list.map((i) => i.externalId)).toEqual(["312", "313"]);
    expect(calls[0]!.url.searchParams.get("limit")).toBe("25");
  });
});

describe("instances", () => {
  it("maps hardware, price, utilization and SSH outputs", async () => {
    route("GET", "/api/v1/instances/", { instances: [INSTANCE], next_token: null });
    const [i] = await client().listResources("instance", "acct");
    expect(i!.fields).toMatchObject({
      status: "running",
      numGpus: 2,
      gpuRamGb: 24.6,
      ramGb: 64,
      pricing: "on-demand",
      pricePerHour: 0.81,
      reliability: 99.5,
      gpuUtilPercent: 87.5,
      cpuUtilPercent: 25,
      diskUsagePercent: 40,
      volumeIds: "7",
      templateId: "99",
    });
    expect(i!.fields["contractEnd"]).toBe(new Date(1_790_000_000_000).toISOString());
    expect(i!.resolvedOutputs).toMatchObject({
      sshCommand: "ssh -p 10600 root@ssh5.vast.ai",
      directSshCommand: "ssh -p 40022 root@1.2.3.4",
    });
    expect(JSON.stringify(i)).not.toContain("secret-token");
  });

  it("accepts an offer with the CLI's body shape", async () => {
    route("PUT", "/api/v0/asks/555/", { success: true, new_contract: 312 });
    route("GET", "/api/v0/instances/312/", { instances: INSTANCE });
    const created = await client().createResource("instance", "acct", {
      offerId: "555",
      pricing: "on-demand",
      templateHash: "abc123",
      image: "",
      disk: "40",
      runtype: "ssh_direct",
      label: "train",
      env: "HF_TOKEN=hf_x\nBAD KEY=1",
      ports: "8000, 8080/udp",
      volumeId: "7",
      volumeMountPath: "/data",
    });
    expect(calls[0]!.body).toEqual({
      client_id: "me",
      disk: 40,
      template_hash_id: "abc123",
      label: "train",
      env: { HF_TOKEN: "hf_x", "-p 8000:8000": "1", "-p 8080:8080/udp": "1" },
      volume_info: { create_new: false, volume_id: 7, mount_path: "/data" },
    });
    expect(created.externalId).toBe("312");
  });

  it("bids the offer's minimum when no bid is given", async () => {
    route("POST", "/api/v0/bundles/", (c: Call) => {
      expect((c.body as { id: unknown }).id).toEqual({ eq: 555 });
      return { offers: [{ id: 555, min_bid: 0.21, dph_total: 0.5 }] };
    });
    route("PUT", "/api/v0/asks/555/", { success: true, new_contract: 1 });
    route("GET", "/api/v0/instances/1/", { instances: { id: 1 } });
    await client().createResource("instance", "acct", {
      offerId: "555",
      pricing: "interruptible",
      bidPrice: "0",
      image: "img",
    });
    const ask = calls.find((c) => c.url.pathname === "/api/v0/asks/555/")!;
    expect((ask.body as { price: number }).price).toBe(0.21);
    expect((ask.body as { runtype: string }).runtype).toBe("ssh_direct");
  });

  it("starts, stops, reboots and recycles", async () => {
    route("PUT", "/api/v0/instances/312/", { success: true });
    route("PUT", "/api/v0/instances/reboot/312/", { success: true });
    route("PUT", "/api/v0/instances/recycle/312/", { success: true });
    const c = client();
    for (const a of ["start", "stop", "reboot", "recycle"]) {
      await c.invokeAction("instance", "acct:instance:312", a, "acct");
    }
    expect(calls.map((x) => [x.url.pathname, x.body])).toEqual([
      ["/api/v0/instances/312/", { state: "running" }],
      ["/api/v0/instances/312/", { state: "stopped" }],
      ["/api/v0/instances/reboot/312/", undefined],
      ["/api/v0/instances/recycle/312/", undefined],
    ]);
  });

  it("relabels and rebids", async () => {
    route("PUT", "/api/v0/instances/312/", { success: true });
    route("PUT", "/api/v0/instances/bid_price/312/", { success: true });
    route("GET", "/api/v0/instances/312/", { instances: INSTANCE });
    await client().updateResource("instance", "acct:instance:312", "acct", {
      label: "new",
      bidPrice: "0.3",
    });
    expect(calls[1]!.body).toEqual({ client_id: "me", price: 0.3 });
  });
});

describe("other resources", () => {
  it("lists only your templates, with env names but not values", async () => {
    route("GET", "/api/v0/users/current/", { id: 42, balance: 12.5 });
    route("GET", "/api/v0/template/", (c: Call) => {
      expect(JSON.parse(c.url.searchParams.get("select_filters")!)).toEqual({
        creator_id: { eq: 42 },
      });
      return {
        success: true,
        templates: [
          {
            id: 9,
            hash_id: "h",
            name: "vllm",
            image: "vllm/vllm-openai",
            env: "-e HF_TOKEN=hf_secret -p 8000:8000",
          },
        ],
      };
    });
    const [t] = await client().listResources("template", "acct");
    expect(t!.fields).toMatchObject({ envKeys: "HF_TOKEN", ports: "8000", hashId: "h" });
    expect(JSON.stringify(t)).not.toContain("hf_secret");
  });

  it("lists account env var names only and updates by key", async () => {
    route("GET", "/api/v0/secrets/", { success: true, secrets: { B: "x", A: "s3cr3t-value" } });
    route("PUT", "/api/v0/secrets/", { success: true });
    const c = client();
    const vars = await c.listResources("env-var", "acct");
    expect(vars.map((v) => v.externalId)).toEqual(["A", "B"]);
    expect(JSON.stringify(vars)).not.toContain("s3cr3t-value");
    await c.updateResource("env-var", "acct:env-var:A", "acct", { value: "new" });
    expect(calls[1]!.body).toEqual({ key: "A", value: "new" });
  });

  it("deletes a volume with the id in both query and body", async () => {
    route("DELETE", "/api/v0/volumes/", { success: true });
    await client().deleteResource("volume", "acct:volume:7", "acct");
    expect(calls[0]!.url.searchParams.get("id")).toBe("7");
    expect(calls[0]!.body).toEqual({ id: 7 });
  });

  it("starts an endpoint through its deployment", async () => {
    route("GET", "/api/v0/deployments/", {
      success: true,
      deployments: [{ id: 644, endpoint_id: 5 }],
    });
    route("POST", "/api/v0/deployment/644/start/", { success: true });
    await client().invokeAction(
      "serverless-endpoint",
      "acct:serverless-endpoint:5",
      "start",
      "acct",
    );
    expect(calls[1]!.url.pathname).toBe("/api/v0/deployment/644/start/");
  });

  it("reports the credit balance", async () => {
    route("GET", "/api/v0/users/current/", { id: 42, balance: 12.5 });
    expect(await client().fetchCreditBalance("acct")).toEqual([
      { key: "default", label: "Vast.ai credit", remaining: 12.5, currency: "USD" },
    ]);
  });
});

describe("cost data", () => {
  const range = { fromDate: "2026-09-01", toDate: "2026-09-30" };
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

  it("spreads an item across the days it covers", () => {
    const parts = spreadByDay(day("2026-09-01") + 43_200, day("2026-09-02") + 43_200, 10);
    expect(parts).toEqual([
      ["2026-09-01", 5],
      ["2026-09-02", 5],
    ]);
  });

  it("maps charge items to services, resources and tags, clipped to the range", () => {
    const rows = mapCharges(
      [
        {
          type: "instance",
          source: "instance-312",
          metadata: { label: "train" },
          items: [
            { type: "gpu", start: day("2026-08-31"), end: day("2026-09-02"), amount: 20 },
            { type: "disk", start: day("2026-09-01"), end: day("2026-09-02"), amount: 1 },
          ],
        },
        {
          type: "volume",
          source: "volume-7",
          start: day("2026-09-05"),
          end: day("2026-09-06"),
          amount: 0.5,
          items: [],
        },
      ],
      range,
    );
    expect(rows).toEqual([
      {
        date: "2026-09-01",
        service: "GPU",
        resourceId: "312",
        tags: { label: "train" },
        currency: "USD",
        amount: 10,
      },
      {
        date: "2026-09-01",
        service: "Storage",
        resourceId: "312",
        tags: { label: "train" },
        currency: "USD",
        amount: 1,
      },
      { date: "2026-09-05", service: "Volumes", resourceId: "7", currency: "USD", amount: 0.5 },
    ]);
  });

  it("asks for the range as unix seconds and paginates", async () => {
    route("GET", "/api/v0/charges/", (c: Call) => {
      const f = JSON.parse(c.url.searchParams.get("select_filters")!);
      expect(f.day.gte).toBe(day("2026-09-01"));
      return c.url.searchParams.get("after_token")
        ? { results: [], next_token: null }
        : {
            results: [
              {
                source: "instance-1",
                start: day("2026-09-03"),
                end: day("2026-09-03") + 3600,
                amount: 2,
              },
            ],
            next_token: "n",
          };
    });
    const rows = await client().fetchCostData("acct", range);
    expect(rows).toEqual([
      { date: "2026-09-03", service: "GPU", resourceId: "1", currency: "USD", amount: 2 },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("parses charge sources", () => {
    expect(parseSource("instance-12")).toEqual({ type: "instance", id: "12" });
    expect(parseSource(null)).toEqual({ type: "", id: "" });
  });
});

describe("helpers", () => {
  it("builds and reads Docker flag strings", () => {
    const flags = buildDockerFlags("A=1\nB=two words\n# c", "8000 22/tcp");
    expect(flags).toBe('-e A=1 -e B="two words" -p 8000:8000 -p 22:22/tcp');
    expect(envKeysOf(flags)).toEqual(["A", "B"]);
    expect(portsOf(flags)).toEqual(["8000", "22/tcp"]);
    expect(buildEnvObject("X=1", "")).toEqual({ X: "1" });
  });

  it("normalizes statuses", () => {
    expect(normalizeStatus("exited", "stopped")).toBe("stopped");
    expect(normalizeStatus("exited", "running")).toBe("exited");
    expect(normalizeStatus(null, null)).toBe("loading");
    expect(normalizeStatus("weird")).toBe("unknown");
  });

  it("drops far-future contract ends", () => {
    expect(isoFromEpoch(9_999_999_999)).toBe("");
  });

  it("labels offers with GPU, place, reliability and price", () => {
    const o = offerOption({
      id: 1,
      gpu_name: "RTX 4090",
      num_gpus: 1,
      geolocation: "US",
      reliability2: 0.99,
      dph_total: 0.4,
      cpu_ram: 32000,
      cpu_cores_effective: 8,
    });
    expect(o).toMatchObject({ id: "1", category: "RTX 4090", vcpus: 8, priceMonthly: 292 });
    expect(o.label).toContain("$0.400/hr");
  });

  it("offers vastai commands for orphans", () => {
    const resource = { resourceTypeId: "volume", externalId: "7", fields: {} } as never;
    expect(vastRemediationCommands({ kind: "orphan", resource } as never)[0]!.command).toBe(
      "vastai delete volume 7",
    );
  });
});
