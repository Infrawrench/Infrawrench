import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigitalOceanClient } from "../client.js";
import { doCreateResource } from "../create-handlers.js";
import { fakeApi } from "./fake-api.js";

const ACC = "acc1";
const BASE = "https://api.digitalocean.com/v2";

const share = {
  id: "s-1",
  name: "data",
  size_gib: 100,
  region: "atl1",
  status: "ACTIVE",
  created_at: "2026-01-01T00:00:00Z",
  vpc_ids: ["vpc-1"],
  performance_tier: "standard",
  host: "10.128.32.2",
  mount_path: "/123/s-1",
};

interface Seen {
  path: string;
  method: string;
  body: string | undefined;
}

function route(answer: (path: string, region: string | null) => object | Response) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== new URL(BASE).origin) throw new Error(`Unexpected host: ${url.href}`);
      const path = url.pathname.replace("/v2", "");
      seen.push({
        path: `${path}${url.search}`,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      const body = answer(path, url.searchParams.get("region"));
      return body instanceof Response ? body : new Response(JSON.stringify(body));
    }),
  );
  return seen;
}

const client = () => hostClient(new DigitalOceanClient({ apiToken: "tok" }));
const failing = (status: number) => new Response('{"id":"x"}', { status });

afterEach(() => vi.unstubAllGlobals());

describe("NFS shares (#411)", () => {
  it("lists what the document calls `shares`, asking for no page size it does not take", async () => {
    const seen = route(() => ({ shares: [share] }));
    const [row] = await client().listResources("nfs-share", ACC);
    expect(seen.map((s) => s.path)).toEqual(["/nfs"]);
    expect(row!.externalId).toBe("atl1/s-1");
    expect(row!.fields["sizeGib"]).toBe(100);
    expect(row!.fields["status"]).toBe("ACTIVE");
  });

  it("builds the mount target and command from `host` and `mount_path`", async () => {
    route(() => ({ shares: [share] }));
    const [row] = await client().listResources("nfs-share", ACC);
    expect(row!.fields["mountTarget"]).toBe("10.128.32.2");
    expect(row!.resolvedOutputs["mountTarget"]).toBe("10.128.32.2");
    expect(row!.resolvedOutputs["mountCommand"]).toBe(
      "sudo mount -t nfs -o nfsvers=4.1 10.128.32.2:/123/s-1 /mnt/data",
    );
  });

  it("still reads the old `nfs` key", async () => {
    route(() => ({ nfs: [share] }));
    await expect(client().listResources("nfs-share", ACC)).resolves.toHaveLength(1);
  });

  it("reads an account with none, however it is said", async () => {
    for (const body of [{ shares: [] }, { shares: null }, {}]) {
      route(() => body);
      await expect(client().listResources("nfs-share", ACC)).resolves.toEqual([]);
    }
    route(() => failing(403));
    await expect(client().listResources("nfs-share", ACC)).resolves.toEqual([]);
    route(() => failing(404));
    await expect(client().listResources("nfs-share", ACC)).resolves.toEqual([]);
  });

  it("does not read a failure or a renamed key as none", async () => {
    route(() => failing(500));
    await expect(client().listResources("nfs-share", ACC)).rejects.toThrow("500");
    route(() => failing(401));
    await expect(client().listResources("nfs-share", ACC)).rejects.toThrow("401");
    route(() => ({ file_shares: [share] }));
    await expect(client().listResources("nfs-share", ACC)).rejects.toThrow("is not a list");
  });

  it("asks each region if listing without one is refused", async () => {
    const seen = route((path, region) => {
      if (path === "/regions") {
        return { regions: [{ slug: "atl1" }, { slug: "ams3" }, { slug: "nyc2" }] };
      }
      if (!region) return failing(400);
      if (region === "atl1") return { shares: [share] };
      return region === "ams3" ? failing(422) : { shares: [] };
    });
    await expect(client().listResources("nfs-share", ACC)).resolves.toHaveLength(1);
    expect(seen.map((s) => s.path)).toContain("/nfs?region=atl1");

    route((path, region) => {
      if (path === "/regions") return { regions: [{ slug: "atl1" }] };
      return region ? failing(500) : failing(400);
    });
    await expect(client().listResources("nfs-share", ACC)).rejects.toThrow("500");
  });

  it("creates from `share`, with its real id and mount", async () => {
    const fetch = vi.fn(async () => ({ share: { ...share, status: "CREATING" } }));
    const ctx = { api: fakeApi(fetch), credentials: {} };
    const result = await doCreateResource(ctx, "nfs-share", ACC, {
      name: "data",
      region: "atl1",
      sizeGib: "100",
      vpcId: "vpc-1",
    });
    expect(result.resource.externalId).toBe("atl1/s-1");
    expect(result.resource.resolvedOutputs["mountTarget"]).toBe("10.128.32.2");
  });

  it("refuses a created share that came back with no id", async () => {
    const fetch = vi.fn(async () => ({}));
    const ctx = { api: fakeApi(fetch), credentials: {} };
    await expect(
      doCreateResource(ctx, "nfs-share", ACC, { name: "data", region: "atl1", vpcId: "vpc-1" }),
    ).rejects.toThrow("no id");
  });

  it("attaches with the VPC in `params`", async () => {
    const seen = route((path) => {
      if (path === "/nfs") return { shares: [{ ...share, vpc_ids: [] }] };
      if (path === "/droplets/7") {
        return { droplet: { id: 7, name: "d", region: { slug: "atl1" }, vpc_uuid: "vpc-2" } };
      }
      if (path === "/projects") return { projects: [] };
      return { action: { id: "a-1" } };
    });
    await client().attachResource(
      "nfs-share",
      `${ACC}:nfs-share:atl1/s-1`,
      "droplet",
      `${ACC}:droplet:7`,
      ACC,
    );
    const attach = seen.find((s) => s.method === "POST");
    expect(attach!.path).toBe("/nfs/s-1/actions");
    expect(JSON.parse(attach!.body!)).toEqual({
      type: "attach",
      region: "atl1",
      params: { vpc_id: "vpc-2" },
    });
  });
});
