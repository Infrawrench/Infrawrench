import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TursoClient } from "../client.js";

type HostRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};

const ORG = "/v1/organizations/myorg";

function hostHttp(routes: Record<string, unknown>) {
  return vi.fn(async (req: HostRequest) => {
    const key = `${req.method} ${new URL(req.url).pathname}`;
    if (!(key in routes)) throw new Error(`unrouted ${key}`);
    return { status: 200, headers: {}, body: JSON.stringify(routes[key]) };
  });
}

function makeClient(request: ReturnType<typeof hostHttp>) {
  return hostClient(
    new TursoClient({ apiToken: "tok", organizationName: "myorg" }, { http: { request } }),
  );
}

let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const { Socket } = await vi.importActual<{
    Socket: { prototype: { connect: () => void } };
  }>("node:net");
  fetchStub = vi.fn(async () => {
    throw new Error("global fetch must not be used");
  });
  vi.stubGlobal("fetch", fetchStub);
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("a socket must not be opened");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Turso through the host's HTTP service", () => {
  it("lists a database's instances", async () => {
    const request = hostHttp({
      [`GET ${ORG}/databases`]: { databases: [{ Name: "db1", DbId: "1", group: "g" }] },
      [`GET ${ORG}/databases/db1/instances`]: {
        instances: [{ uuid: "u1", name: "i1", type: "primary", region: "lhr", hostname: "h" }],
      },
    });

    const rows = await makeClient(request).listResources("turso-database-instance", "acct");

    expect(rows).toHaveLength(1);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("fails rather than reading a renamed instances key as none", async () => {
    const request = hostHttp({
      [`GET ${ORG}/databases`]: { databases: [{ Name: "db1", DbId: "1", group: "g" }] },
      [`GET ${ORG}/databases/db1/instances`]: { nodes: [] },
    });

    await expect(
      makeClient(request).listResources("turso-database-instance", "acct"),
    ).rejects.toThrow(/is not a list/);
  });

  it("lists organization members", async () => {
    const request = hostHttp({
      [`GET ${ORG}/members`]: { members: [{ username: "alice", email: "a@b.c", role: "owner" }] },
    });

    const rows = await makeClient(request).listResources("turso-organization-member", "acct");

    expect(rows).toHaveLength(1);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("mints a database token", async () => {
    const request = hostHttp({ [`POST ${ORG}/databases/mydb/auth/tokens`]: { jwt: "abc def" } });

    const connection = await makeClient(request).resolveOutput(
      "turso-database",
      "acct:turso-database:mydb",
      "connectionString",
      "acct",
    );

    expect(connection).toBe("libsql://mydb-myorg.turso.io?authToken=abc%20def");
    const body = request.mock.calls[0]![0].body;
    expect(JSON.parse(String(body))).toEqual({ permissions: { read_attach: { databases: [] } } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("deletes a database and a group", async () => {
    const request = hostHttp({
      [`DELETE ${ORG}/databases/mydb`]: { database: "mydb" },
      [`DELETE ${ORG}/groups/g1`]: { group: { name: "g1" } },
    });
    const client = makeClient(request);

    await client.deleteResource("turso-database", "acct:turso-database:mydb", "acct");
    await client.deleteResource("turso-group", "acct:turso-group:g1", "acct");

    expect(request).toHaveBeenCalledTimes(2);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("offers live locations in a new group's config", async () => {
    const request = hostHttp({
      "GET /v1/locations": { locations: { "aws-us-east-1": "AWS US East" } },
    });

    const config = await makeClient(request).getCreateConfig("turso-group");

    const location = config.fields.find((f) => f.key === "location");
    expect(location?.regions?.map((r) => r.id)).toEqual(["aws-us-east-1"]);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
