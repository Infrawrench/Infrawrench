import { hostClient } from "@infrawrench/plugin-base/effect";
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

const client = () => hostClient(new VastClient({ apiKey: "KEY" }, RESOURCE_TYPES));

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

describe("template edits", () => {
  const STORED = {
    id: 9,
    hash_id: "old-hash",
    creator_id: 42,
    name: "vllm",
    image: "vllm/vllm-openai",
    tag: "v1",
    env: "-e HF_TOKEN=hf_secret -p 8000:8000",
    onstart: "echo hi",
    runtype: "ssh",
    ssh_direct: true,
    use_ssh: true,
    jup_direct: false,
    docker_login_repo: "docker.io",
    docker_login_user: "********",
    docker_login_pass: "********",
    extra_filters: { cuda_max_good: { gte: 12.6 } },
    recommended_disk_space: 40,
    desc: "old description",
    readme: "read me",
    readme_visible: true,
    private: true,
    args_str: null,
    count_created: 7,
    created_at: 1_760_000_000,
  };

  const stored = (template: Record<string, unknown> = STORED) => {
    route("GET", "/api/v0/users/current/", { id: 42 });
    route("GET", "/api/v0/template/", { success: true, templates: [template] });
  };

  const edit = (fields: Record<string, string>) =>
    client().updateResource("template", "acct:template:9", "acct", fields);

  const sent = () => calls.find((c) => c.url.pathname === "/api/v1/template/")!.body;

  it("edits on the v1 route with the whole template, not just what changed", async () => {
    stored();
    route("PUT", "/api/v1/template/", {
      success: true,
      template: { id: 10, hash_id: "new-hash" },
    });
    await edit({ name: "renamed" });
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url.pathname)).toEqual([
      "/api/v1/template/",
    ]);
    expect(sent()).toEqual({
      id: 9,
      hash_id: "old-hash",
      name: "renamed",
      image: "vllm/vllm-openai",
      tag: "v1",
      env: "-e HF_TOKEN=hf_secret -p 8000:8000",
      onstart: "echo hi",
      runtype: "ssh",
      ssh_direct: true,
      use_ssh: true,
      jup_direct: false,
      docker_login_repo: "docker.io",
      docker_login_user: "********",
      docker_login_pass: "********",
      extra_filters: { cuda_max_good: { gte: 12.6 } },
      recommended_disk_space: 40,
      desc: "old description",
      readme: "read me",
      readme_visible: true,
      private: true,
    });
  });

  it("answers with the new version, whose id and hash are new", async () => {
    stored();
    route("PUT", "/api/v1/template/", {
      success: true,
      template: { id: 10, hash_id: "new-hash" },
    });
    const updated = await edit({ description: "new", diskGb: "64", image: "other/image" });
    expect(updated.id).toBe("acct:template:10");
    expect(updated.externalId).toBe("10");
    expect(updated.fields).toMatchObject({
      name: "vllm",
      image: "other/image",
      description: "new",
      diskGb: 64,
      hashId: "new-hash",
    });
    expect(JSON.stringify(updated)).not.toContain("hf_secret");
  });

  it("keeps the version when Vast reports no edits", async () => {
    stored();
    route("PUT", "/api/v1/template/", { success: true, msg: "No edits were made" });
    const updated = await edit({ name: "vllm" });
    expect(updated.externalId).toBe("9");
    expect(updated.fields["hashId"]).toBe("old-hash");
  });

  it("does not blank a field the form left empty or could not read", async () => {
    stored();
    route("PUT", "/api/v1/template/", { success: true, template: { id: 10, hash_id: "n" } });
    await edit({ name: " ", image: "", diskGb: "not a number" });
    expect(sent()).toMatchObject({
      name: "vllm",
      image: "vllm/vllm-openai",
      recommended_disk_space: 40,
    });
  });

  it("can clear the description", async () => {
    stored();
    route("PUT", "/api/v1/template/", { success: true, template: { id: 10, hash_id: "n" } });
    await edit({ description: "" });
    expect(sent()).toMatchObject({ desc: "" });
  });

  it("reads the tag from default_tag when that is where the read puts it", async () => {
    const { tag: _tag, ...rest } = STORED;
    stored({ ...rest, default_tag: "v2" });
    route("PUT", "/api/v1/template/", { success: true, template: { id: 10, hash_id: "n" } });
    await edit({ name: "renamed" });
    expect(sent()).toMatchObject({ tag: "v2" });
  });

  it("refuses to edit a template it cannot find or has no hash for", async () => {
    stored({ ...STORED, id: 8 });
    await expect(edit({ name: "x" })).rejects.toThrow(/not found/);
    stored({ ...STORED, hash_id: "" });
    await expect(edit({ name: "x" })).rejects.toThrow(/hash/);
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });
});

describe("lists that cannot say they have every row", () => {
  const LISTS: Array<[string, string, string]> = [
    ["instance", "/api/v1/instances/", "instances"],
    ["volume", "/api/v0/volumes/", "volumes"],
    ["serverless-endpoint", "/api/v0/endptjobs/", "results"],
    ["workergroup", "/api/v0/workergroups/", "results"],
    ["template", "/api/v0/template/", "templates"],
    ["ssh-key", "/api/v0/ssh/", "ssh_keys"],
    ["env-var", "/api/v0/secrets/", "secrets"],
  ];

  it("throws at the instance cap rather than prune the rest", async () => {
    route("GET", "/api/v1/instances/", (c: Call) => ({
      instances: [{ ...INSTANCE, id: calls.indexOf(c) }],
      next_token: "more",
    }));
    await expect(client().listResources("instance", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(400);
    expect(calls[0]!.url.searchParams.get("limit")).toBe("25");
  });

  it("reads a full 10,000 instances", async () => {
    route("GET", "/api/v1/instances/", (c: Call) => {
      const page = calls.indexOf(c);
      return {
        instances: Array.from({ length: 25 }, (_, i) => ({ id: page * 25 + i })),
        next_token: page < 399 ? "more" : null,
      };
    });
    await expect(client().listResources("instance", "acct")).resolves.toHaveLength(10_000);
  });

  it("throws at the charge cap, asking for Vast's largest page", async () => {
    route("GET", "/api/v0/charges/", { results: [{ source: "instance-1" }], next_token: "more" });
    await expect(
      client().fetchCostData("acct", { fromDate: "2026-09-01", toDate: "2026-09-30" }),
    ).rejects.toThrow("has more than Infrawrench reads");
    expect(calls).toHaveLength(400);
    expect(calls[0]!.url.searchParams.get("limit")).toBe("500");
  });

  it("follows a token past an empty page, since only a null token ends the list", async () => {
    route("GET", "/api/v1/instances/", (c: Call) => {
      const page = calls.indexOf(c);
      if (page === 0) return { instances: [], next_token: "more" };
      return { instances: [INSTANCE], next_token: null };
    });
    const list = await client().listResources("instance", "acct");
    expect(list.map((i) => i.externalId)).toEqual(["312"]);
  });

  it.each(LISTS)("%s: a renamed list rejects instead of reading as empty", async (type, path) => {
    route("GET", "/api/v0/users/current/", { id: 42 });
    route("GET", path, { success: true, renamed: [] });
    await expect(client().listResources(type, "acct")).rejects.toThrow("is not a list");
  });

  it.each([
    ["instance", "/api/v1/instances/", "instances"],
    ["cost", "/api/v0/charges/", "results"],
  ])("%s: a renamed list on a later page rejects too", async (type, path, key) => {
    route("GET", path, (c: Call) =>
      calls.indexOf(c) === 0 ? { [key]: [], next_token: "more" } : { renamed: [] },
    );
    const read =
      type === "cost"
        ? client().fetchCostData("acct", { fromDate: "2026-09-01", toDate: "2026-09-30" })
        : client().listResources(type, "acct");
    await expect(read).rejects.toThrow("is not a list");
    expect(calls).toHaveLength(2);
  });

  it("does not name a secret's value when the secrets are not an object", async () => {
    route("GET", "/api/v0/secrets/", { secrets: "s3cr3t-value" });
    const err = await client()
      .listResources("env-var", "acct")
      .catch((e: Error) => e.message);
    expect(err).toContain("is not a list");
    expect(err).not.toContain("s3cr3t-value");
  });

  it("reads a null list as empty, the way a nil slice is written", async () => {
    route("GET", "/api/v0/volumes/", { volumes: null });
    route("GET", "/api/v0/secrets/", { secrets: null });
    await expect(client().listResources("volume", "acct")).resolves.toEqual([]);
    await expect(client().listResources("env-var", "acct")).resolves.toEqual([]);
  });

  it("still reads ssh keys as a bare list and as a wrapped one", async () => {
    const key = { id: 3, key: "ssh-ed25519 AAAA" };
    route("GET", "/api/v0/ssh/", [key]);
    await expect(client().listResources("ssh-key", "acct")).resolves.toHaveLength(1);
    route("GET", "/api/v0/ssh/", { ssh_keys: [key] });
    await expect(client().listResources("ssh-key", "acct")).resolves.toHaveLength(1);
  });

  it("rejects rather than list no templates when the account has no id", async () => {
    route("GET", "/api/v0/users/current/", { balance: 1 });
    route("GET", "/api/v0/template/", { success: true, templates: [{ id: 9 }] });
    await expect(client().listResources("template", "acct")).rejects.toThrow(/no id/);
  });
});

describe("blank ids", () => {
  it.each(["instance", "template", "volume", "ssh-key", "serverless-endpoint", "env-var"])(
    "%s: refuses to delete with no id",
    async (type) => {
      await expect(client().deleteResource(type, `acct:${type}:`, "acct")).rejects.toThrow(/no id/);
      expect(calls).toEqual([]);
    },
  );

  it.each(["template", "volume"])("%s: refuses to delete a non-numeric id", async (type) => {
    await expect(client().deleteResource(type, `acct:${type}:abc`, "acct")).rejects.toThrow(
      /no id/,
    );
    expect(calls).toEqual([]);
  });

  it("refuses to edit or act with no id", async () => {
    await expect(
      client().updateResource("instance", "acct:instance:", "acct", { label: "x" }),
    ).rejects.toThrow(/no id/);
    await expect(
      client().invokeAction("instance", "acct:instance:", "stop", "acct"),
    ).rejects.toThrow(/no id/);
    expect(calls).toEqual([]);
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

  it("keeps the range's share of an item that began long before it", () => {
    const rows = mapCharges(
      [
        {
          source: "instance-1",
          items: [
            {
              type: "gpu",
              start: day("2026-09-02") - 1200 * 86_400,
              end: day("2026-09-02"),
              amount: 1200,
            },
          ],
        },
      ],
      range,
    );
    expect(rows).toEqual([
      { date: "2026-09-01", service: "GPU", resourceId: "1", currency: "USD", amount: 1 },
    ]);
  });

  it("does not walk the days of an item with a far-future end", () => {
    const rows = mapCharges(
      [
        {
          source: "instance-1",
          items: [{ type: "gpu", start: day("2026-09-01"), end: 9_999_999_999, amount: 1_000_000 }],
        },
      ],
      { fromDate: "2026-09-01", toDate: "2026-09-02" },
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-09-01", "2026-09-02"]);
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
