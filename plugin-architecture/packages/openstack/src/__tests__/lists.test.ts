import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it, vi } from "vitest";
import { OpenStackClient } from "../client.js";
import { APP, ok, recordUnread, resetAfterEach, transport, type Answer } from "./harness.js";

resetAfterEach();

describe("marker-paginated lists", () => {
  it("rejects a list that never ends, after exactly the page cap", async () => {
    const { http, seen } = transport((r) => {
      if (r.url.pathname !== "/v2.1/servers/detail") return undefined;
      const from = Number(r.url.searchParams.get("marker")?.slice(1) ?? -1) + 1;
      return ok({ servers: Array.from({ length: 500 }, (_, i) => ({ id: `s${from + i}` })) });
    });
    const client = hostClient(new OpenStackClient(APP, { http }));
    await expect(client.listResources("os-server", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(seen.filter((r) => r.url.pathname === "/v2.1/servers/detail")).toHaveLength(100);
  });

  it("rejects a page whose list key was renamed, on the first page and a later one", async () => {
    const first = transport((r) =>
      r.url.pathname === "/v2.0/subnets" ? ok({ items: [] }) : undefined,
    );
    await expect(
      hostClient(new OpenStackClient(APP, { http: first.http })).listResources("os-subnet", "acct"),
    ).rejects.toThrow("is not a list");

    const later = transport((r) => {
      if (r.url.pathname !== "/v2.0/subnets") return undefined;
      return r.url.searchParams.get("marker")
        ? ok({ subnet: {} })
        : ok({ subnets: Array.from({ length: 500 }, (_, i) => ({ id: `sn${i}` })) });
    });
    await expect(
      hostClient(new OpenStackClient(APP, { http: later.http })).listResources("os-subnet", "acct"),
    ).rejects.toThrow("is not a list");
  });

  it("keeps reading when the service caps the page below the limit and links the next", async () => {
    const { http } = transport((r) => {
      if (r.url.pathname !== "/v2.0/subnets") return undefined;
      if (r.url.searchParams.get("marker") === "sn199") return ok({ subnets: [{ id: "last" }] });
      return ok({
        subnets: Array.from({ length: 200 }, (_, i) => ({ id: `sn${i}` })),
        subnets_links: [{ rel: "next", href: "https://neutron.example.com/v2.0/subnets?x" }],
      });
    });
    const rows = await hostClient(new OpenStackClient(APP, { http })).listResources(
      "os-subnet",
      "acct",
    );
    expect(rows).toHaveLength(201);
  });

  it("rejects a full page whose last row has no marker to continue by", async () => {
    const { http } = transport((r) =>
      r.url.pathname === "/v2.0/subnets"
        ? ok({ subnets: Array.from({ length: 500 }, () => ({ name: "x" })) })
        : undefined,
    );
    await expect(
      hostClient(new OpenStackClient(APP, { http })).listResources("os-subnet", "acct"),
    ).rejects.toThrow("no cursor");
  });

  it("does not read a broken ports list as no router interfaces", async () => {
    const { http } = transport((r) => {
      if (r.url.pathname === "/v2.0/ports") return ok({ port: {} });
      if (r.url.pathname === "/v2.0/routers") return ok({ routers: [{ id: "r1" }] });
      return undefined;
    });
    await expect(
      hostClient(new OpenStackClient(APP, { http })).listResources("os-router", "acct"),
    ).rejects.toThrow("is not a list");
  });
});

describe("volume backups", () => {
  const backups = (a: Answer) =>
    transport((r) => (r.url.pathname === "/v3/proj1/backups/detail" ? a : undefined));

  it("fails the type on a server error instead of reading it as no backups", async () => {
    const { http } = backups({ status: 500, body: { computeFault: { message: "boom" } } });
    recordUnread();
    await expect(
      hostClient(new OpenStackClient(APP, { http })).listResources("os-volume-backup", "acct"),
    ).rejects.toThrow("500");
  });

  it("keeps the stored rows quietly when the roles refuse backups", async () => {
    const { http } = backups({ status: 403, body: { forbidden: { message: "Policy" } } });
    const parts = recordUnread();
    const rows = await hostClient(new OpenStackClient(APP, { http })).listResources(
      "os-volume-backup",
      "acct",
    );
    expect(rows).toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it("still shows the refusal where the host keeps no track", async () => {
    const { http } = backups({ status: 403, body: { forbidden: { message: "Policy" } } });
    await expect(
      hostClient(new OpenStackClient(APP, { http })).listResources("os-volume-backup", "acct"),
    ).rejects.toThrow("403");
  });

  it("reads a cloud without the backup API as having none", async () => {
    const { http } = backups({ status: 404, body: { itemNotFound: { message: "nope" } } });
    const parts = recordUnread();
    expect(
      await hostClient(new OpenStackClient(APP, { http })).listResources(
        "os-volume-backup",
        "acct",
      ),
    ).toEqual([]);
    expect(parts).toEqual([]);
  });
});

describe("Swift containers", () => {
  const ACCOUNT_PATH = "/v1/AUTH_proj1";

  function containers(
    count: number,
    head: (name: string) => Answer = () => ({ status: 204 }),
    listing?: (marker: string) => Answer,
  ) {
    const names = Array.from({ length: count }, (_, i) => `c${String(i).padStart(6, "0")}`);
    return transport((r) => {
      if (r.method === "GET" && r.url.pathname === ACCOUNT_PATH) {
        const marker = r.url.searchParams.get("marker") ?? "";
        if (listing) return listing(marker);
        const limit = Number(r.url.searchParams.get("limit"));
        const page = names.filter((n) => n > marker).slice(0, limit);
        return ok(page.map((name) => ({ name, count: 1, bytes: 1 })));
      }
      if (r.method === "HEAD" && r.url.pathname.startsWith(`${ACCOUNT_PATH}/`)) {
        return head(decodeURIComponent(r.url.pathname.slice(ACCOUNT_PATH.length + 1)));
      }
      return undefined;
    });
  }

  it("rejects an account listing past the page cap instead of returning part", async () => {
    const { http } = containers(0, undefined, (marker) => {
      const from = Number(marker.slice(1) || -1) + 1;
      return ok(Array.from({ length: 1000 }, (_, i) => ({ name: `c${from + i}` })));
    });
    await expect(
      hostClient(new OpenStackClient(APP, { http })).listResources("os-container", "acct"),
    ).rejects.toThrow("has more than Infrawrench reads");
  });

  it("rejects a listing that is not a list", async () => {
    const { http } = containers(0, undefined, () => ok({ containers: [] }));
    await expect(
      hostClient(new OpenStackClient(APP, { http })).listResources("os-container", "acct"),
    ).rejects.toThrow("is not a list");
  });

  it("reads an empty account answered with 204 and no body as none", async () => {
    const { http } = containers(0, undefined, () => ({ status: 204 }));
    expect(
      await hostClient(new OpenStackClient(APP, { http })).listResources("os-container", "acct"),
    ).toEqual([]);
  });

  it("fails the type when a container's ACL cannot be read, rather than calling it private", async () => {
    const { http } = containers(2, (name) =>
      name === "c000001"
        ? { status: 503 }
        : { status: 204, headers: { "X-Container-Read": ".r:*" } },
    );
    await expect(
      hostClient(new OpenStackClient(APP, { http })).listResources("os-container", "acct"),
    ).rejects.toThrow("503");
  });

  it("leaves out a container deleted between the listing and its HEAD", async () => {
    const { http } = containers(2, (name) =>
      name === "c000001" ? { status: 404 } : { status: 204 },
    );
    const rows = await hostClient(new OpenStackClient(APP, { http })).listResources(
      "os-container",
      "acct",
    );
    expect(rows.map((r) => r.externalId)).toEqual(["c000000"]);
  });

  it("reads every container's ACL up to the budget and names none as unread", async () => {
    const { http, seen } = containers(1000);
    const parts = recordUnread();
    const rows = await hostClient(new OpenStackClient(APP, { http })).listResources(
      "os-container",
      "acct",
    );
    expect(rows).toHaveLength(1000);
    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(1000);
    expect(parts).toEqual([]);
  });

  it("past the budget reads a run of containers and names the rest", async () => {
    const { http, seen } = containers(1100);
    const parts = recordUnread();
    const rows = await hostClient(new OpenStackClient(APP, { http })).listResources(
      "os-container",
      "acct",
    );
    const named = parts.flatMap((p) => p.idPrefixes ?? []);
    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(1000);
    expect(rows).toHaveLength(1000);
    expect(named).toHaveLength(100);
    expect(new Set([...rows.map((r) => r.id), ...named]).size).toBe(1100);
  });

  it("reads every container where the host keeps no track of the rest", async () => {
    const { http, seen } = containers(1100);
    const rows = await hostClient(new OpenStackClient(APP, { http })).listResources(
      "os-container",
      "acct",
    );
    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(1100);
    expect(rows).toHaveLength(1100);
  });

  it("moves the run from one poll to the next", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const unreadAt = async (at: string) => {
      vi.setSystemTime(new Date(at));
      const parts = recordUnread();
      await hostClient(new OpenStackClient(APP, { http: containers(1100).http })).listResources(
        "os-container",
        "acct",
      );
      return parts.flatMap((p) => p.idPrefixes ?? []);
    };
    const first = await unreadAt("2026-11-07T10:00:00Z");
    const second = await unreadAt("2026-11-07T10:05:00Z");
    expect(second).not.toEqual(first);
  });
});
