import { describe, expect, it, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";

const API = "https://api.tailscale.com/api/v2";

type Req = { url: string; method: string; body?: string; headers: Record<string, string> };

/** A host transport answering by "METHOD path" (query string ignored unless routed). */
function routed(routes: Record<string, unknown>) {
  const request = vi.fn(async (req: Req) => {
    const path = req.url.slice(API.length);
    const exact = `${req.method} ${path}`;
    const bare = `${req.method} ${path.split("?")[0]}`;
    const body = exact in routes ? routes[exact] : routes[bare];
    if (body === undefined) return { status: 404, headers: {}, body: '{"message":"not found"}' };
    return { status: 200, headers: {}, body: body === "" ? "" : JSON.stringify(body) };
  });
  const client = plugin.createClient({ apiKey: "tskey-api-secret" }, { http: { request } });
  const sent = (method: string, path: string) =>
    request.mock.calls
      .map(([req]) => req)
      .filter((req) => req.method === method && req.url.slice(API.length).split("?")[0] === path)
      .map((req) => (req.body ? JSON.parse(req.body) : undefined));
  return { request, client, sent };
}

const device = {
  id: "1",
  nodeId: "nWeb",
  name: "web.tail1234.ts.net",
  hostname: "web",
  addresses: ["100.64.0.1", "fd7a::1"],
  authorized: true,
  tags: ["tag:server"],
  enabledRoutes: ["10.0.0.0/24"],
  advertisedRoutes: ["10.0.0.0/24", "10.1.0.0/24"],
  keyExpiryDisabled: true,
  expires: "2026-01-01T00:00:00Z",
};

describe("resource types", () => {
  it("registers every type the client lists", () => {
    expect(plugin.resourceTypes.map((t) => t.id).sort()).toEqual([
      "device",
      "key",
      "posture-integration",
      "service",
      "tailnet",
      "user",
      "user-invite",
      "webhook",
    ]);
  });
});

describe("devices", () => {
  it("maps the extended fields and keeps disabled key expiry off the radar", async () => {
    const { client } = routed({ "GET /tailnet/-/devices": { devices: [device] } });
    const [row] = await client.listResources("device", "acct");
    expect(row!.fields).toMatchObject({
      ipv4: "100.64.0.1",
      tags: "tag:server",
      enabledRoutes: "10.0.0.0/24",
      advertisedRoutes: "10.0.0.0/24, 10.1.0.0/24",
      expires: "",
      keyExpiryDisabled: true,
    });
  });

  it("only calls the endpoints for fields that changed", async () => {
    const { client, sent } = routed({
      "GET /tailnet/-/devices": { devices: [device] },
      "POST /device/nWeb/tags": "",
      "POST /device/nWeb/key": "",
      "POST /device/nWeb/routes": { enabledRoutes: [] },
      "POST /device/nWeb/name": "",
    });
    await client.updateResource!("device", "acct:device:nWeb", "acct", {
      name: "web.tail1234.ts.net",
      tags: "tag:server, tag:prod",
      keyExpiryDisabled: "false",
      enabledRoutes: "10.0.0.0/24, 10.1.0.0/24",
      ipv4: "100.64.0.1",
    });
    expect(sent("POST", "/device/nWeb/name")).toEqual([]);
    expect(sent("POST", "/device/nWeb/tags")).toEqual([{ tags: ["tag:server", "tag:prod"] }]);
    expect(sent("POST", "/device/nWeb/key")).toEqual([{ keyExpiryDisabled: false }]);
    expect(sent("POST", "/device/nWeb/routes")).toEqual([
      { routes: ["10.0.0.0/24", "10.1.0.0/24"] },
    ]);
    expect(sent("POST", "/device/nWeb/ip")).toEqual([]);
  });

  it("rejects an IPv4 outside the tailnet range before calling the API", async () => {
    const { client, sent } = routed({ "GET /tailnet/-/devices": { devices: [device] } });
    await expect(
      client.updateResource!("device", "acct:device:nWeb", "acct", { ipv4: "10.0.0.5" }),
    ).rejects.toThrow("100.64.0.0/10");
    expect(sent("POST", "/device/nWeb/ip")).toEqual([]);
  });

  it("revokes approval through the authorized endpoint", async () => {
    const { client, sent } = routed({
      "GET /tailnet/-/devices": { devices: [device] },
      "POST /device/nWeb/authorized": "",
    });
    await client.invokeAction!("device", "acct:device:nWeb", "deauthorize", "acct");
    expect(sent("POST", "/device/nWeb/authorized")).toEqual([{ authorized: false }]);
  });
});

describe("tailnet", () => {
  const routes = {
    "GET /tailnet/-/settings": { devicesApprovalOn: true, devicesKeyDurationDays: 90 },
    "GET /tailnet/-/dns/configuration": {
      nameservers: [{ address: "1.1.1.1", useWithExitNode: true }],
      splitDNS: { "corp.example": [{ address: "10.0.0.2" }] },
      searchPaths: ["corp.example"],
      preferences: { magicDNS: true, overrideLocalDNS: false },
    },
    "GET /tailnet/-/contacts": { security: { email: "sec@example.com", needsVerification: true } },
    "GET /tailnet/-/devices": { devices: [device] },
    "PATCH /tailnet/-/settings": {},
    "POST /tailnet/-/dns/configuration": {},
  };

  it("lists one tailnet named after its MagicDNS suffix", async () => {
    const { client } = routed(routes);
    const rows = await client.listResources("tailnet", "acct");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "acct:tailnet:-",
      displayName: "tail1234.ts.net",
      fields: {
        devicesApprovalOn: true,
        magicDNS: true,
        nameservers: "1.1.1.1",
        splitDNS: "corp.example → 10.0.0.2",
        securityContact: "sec@example.com (unverified)",
      },
    });
  });

  it("patches only changed settings and keeps split DNS when editing DNS", async () => {
    const { client, sent } = routed(routes);
    await client.updateResource!("tailnet", "acct:tailnet:-", "acct", {
      devicesApprovalOn: "true",
      usersApprovalOn: "true",
      devicesKeyDurationDays: "30",
      nameservers: "1.1.1.1, 9.9.9.9",
      magicDNS: "true",
    });
    expect(sent("PATCH", "/tailnet/-/settings")).toEqual([
      { usersApprovalOn: true, devicesKeyDurationDays: 30 },
    ]);
    const [dns] = sent("POST", "/tailnet/-/dns/configuration");
    expect(dns).toEqual({
      nameservers: [{ address: "1.1.1.1", useWithExitNode: true }, { address: "9.9.9.9" }],
      splitDNS: { "corp.example": [{ address: "10.0.0.2" }] },
      searchPaths: ["corp.example"],
      preferences: { magicDNS: true, overrideLocalDNS: false },
    });
  });

  it("rejects a key expiry outside 1 to 180 days", async () => {
    const { client } = routed(routes);
    await expect(
      client.updateResource!("tailnet", "acct:tailnet:-", "acct", {
        devicesKeyDurationDays: "365",
      }),
    ).rejects.toThrow("180");
  });

  it("formats the configuration audit log for the Logs tab", async () => {
    const { client, request } = routed({
      "GET /tailnet/-/logging/configuration": {
        logs: [
          {
            eventTime: "2026-09-01T00:00:00Z",
            action: "UPDATE",
            actor: { loginName: "amy@example.com" },
            target: { type: "NODE", name: "web", property: "TAGS" },
            old: ["tag:a"],
            new: ["tag:b"],
          },
        ],
      },
    });
    const logs = await client.getLogs!("tailnet", "acct:tailnet:-", "acct", {});
    expect(logs.text).toBe(
      '2026-09-01T00:00:00Z amy@example.com UPDATE NODE web TAGS ["tag:a"] -> ["tag:b"]\n',
    );
    const url = request.mock.calls[0]![0].url;
    expect(url).toContain("start=");
    expect(url).toContain("end=");
  });
});

describe("keys", () => {
  it("creates a tagged, pre-approved auth key and exposes the secret once", async () => {
    const { client, sent } = routed({
      "POST /tailnet/-/keys": {
        id: "k1",
        key: "tskey-auth-k1-secret",
        keyType: "auth",
        description: "ci",
        capabilities: { devices: { create: { preauthorized: true, tags: ["tag:ci"] } } },
      },
    });
    const created = (await client.createResource!("key", "acct", {
      keyType: "auth",
      description: "ci",
      reusable: "true",
      ephemeral: "true",
      preauthorized: "true",
      tags: '["tag:ci"]',
      expiryDays: "7",
    })) as ResourceInstance;
    expect(sent("POST", "/tailnet/-/keys")).toEqual([
      {
        keyType: "auth",
        capabilities: {
          devices: {
            create: { reusable: true, ephemeral: true, preauthorized: true, tags: ["tag:ci"] },
          },
        },
        expirySeconds: 7 * 86_400,
        description: "ci",
      },
    ]);
    expect(created.resolvedOutputs.key).toBe("tskey-auth-k1-secret");
    expect(created.fields.tags).toBe("tag:ci");
  });

  it("creates an OAuth client with its scopes and requires one", async () => {
    const { client, sent } = routed({ "POST /tailnet/-/keys": { id: "c1", keyType: "client" } });
    await expect(
      client.createResource!("key", "acct", { keyType: "client", scopes: "[]" }),
    ).rejects.toThrow("scope");
    await client.createResource!("key", "acct", {
      keyType: "client",
      scopes: '["devices:core:read","dns"]',
    });
    expect(sent("POST", "/tailnet/-/keys")).toEqual([
      { keyType: "client", scopes: ["devices:core:read", "dns"] },
    ]);
  });

  it("lists every key type and drops a revoked key's expiry", async () => {
    const { client, request } = routed({
      "GET /tailnet/-/keys?all=true": {
        keys: [
          { id: "a", keyType: "api", expires: "2027-01-01T00:00:00Z" },
          { id: "b", keyType: "auth", expires: "2027-01-01T00:00:00Z", revoked: "2026-01-01" },
        ],
      },
    });
    const rows = await client.listResources("key", "acct");
    expect(request.mock.calls[0]![0].url).toBe(`${API}/tailnet/-/keys?all=true`);
    expect(rows.map((r) => r.fields.expires)).toEqual(["2027-01-01T00:00:00Z", ""]);
  });
});

describe("users", () => {
  const users = {
    "GET /tailnet/-/users": {
      users: [{ id: "u1", loginName: "amy@example.com", role: "member", status: "active" }],
    },
    "POST /users/u1/role": "",
    "POST /users/u1/delete": "",
    "POST /users/u1/suspend": "",
  };

  it("changes the role and deletes with the documented POST routes", async () => {
    const { client, sent } = routed(users);
    await client.updateResource!("user", "acct:user:u1", "acct", { role: "admin" });
    await client.invokeAction!("user", "acct:user:u1", "suspend", "acct");
    await client.deleteResource!("user", "acct:user:u1", "acct");
    expect(sent("POST", "/users/u1/role")).toEqual([{ role: "admin" }]);
    expect(sent("POST", "/users/u1/suspend")).toHaveLength(1);
    expect(sent("POST", "/users/u1/delete")).toHaveLength(1);
  });

  it("refuses a user that is not in this tailnet", async () => {
    const { client, sent } = routed(users);
    await expect(client.deleteResource!("user", "acct:user:u9", "acct")).rejects.toThrow(
      "not found",
    );
    expect(sent("POST", "/users/u9/delete")).toEqual([]);
  });
});

describe("webhooks", () => {
  const hook = {
    endpointId: "w1",
    endpointUrl: "https://hooks.example.com/ts",
    subscriptions: ["nodeCreated"],
  };

  it("creates with picked events and keeps the creation secret", async () => {
    const { client, sent } = routed({
      "POST /tailnet/-/webhooks": { ...hook, secret: "whsec" },
    });
    const created = (await client.createResource!("webhook", "acct", {
      endpointUrl: "https://hooks.example.com/ts",
      providerType: "slack",
      subscriptions: '["nodeCreated","userCreated"]',
    })) as ResourceInstance;
    expect(sent("POST", "/tailnet/-/webhooks")).toEqual([
      {
        endpointUrl: "https://hooks.example.com/ts",
        providerType: "slack",
        subscriptions: ["nodeCreated", "userCreated"],
      },
    ]);
    expect(created.resolvedOutputs.secret).toBe("whsec");
  });

  it("rejects unknown events on edit and rotates through the credential export", async () => {
    const { client, sent } = routed({
      "GET /tailnet/-/webhooks": { webhooks: [hook] },
      "POST /webhooks/w1/rotate": { ...hook, secret: "new-secret" },
    });
    await expect(
      client.updateResource!("webhook", "acct:webhook:w1", "acct", {
        subscriptions: "nodeExploded",
      }),
    ).rejects.toThrow("nodeExploded");
    const exported = await client.exportCredential!(
      "webhook",
      "acct:webhook:w1",
      "acct",
      "rotate-secret",
    );
    expect(exported.content).toBe("new-secret");
    expect(sent("POST", "/webhooks/w1/rotate")).toHaveLength(1);
  });
});

describe("services", () => {
  it("creates a Service with the svc: prefix through PUT", async () => {
    const { client, sent } = routed({
      "PUT /tailnet/-/services/svc%3Aweb": {
        name: "svc:web",
        addrs: ["100.100.0.1", "fd7a::9"],
        ports: ["tcp:443"],
      },
    });
    const created = (await client.createResource!("service", "acct", {
      name: "web",
      ports: "tcp:443",
      tags: '["tag:web"]',
    })) as ResourceInstance;
    expect(sent("PUT", "/tailnet/-/services/svc%3Aweb")).toEqual([
      { name: "svc:web", displayName: "", comment: "", ports: ["tcp:443"], tags: ["tag:web"] },
    ]);
    expect(created.resolvedOutputs).toEqual({ ip: "100.100.0.1", serviceName: "svc:web" });
  });

  it("only approves a device that hosts the Service", async () => {
    const { client, sent } = routed({
      "GET /tailnet/-/services/svc%3Aweb": { name: "svc:web" },
      "GET /tailnet/-/services/svc%3Aweb/devices": {
        hosts: [{ stableNodeID: "nWeb", approvalLevel: "not-approved" }],
      },
      "POST /tailnet/-/services/svc%3Aweb/device/nWeb/approved": { approved: true },
    });
    await expect(
      client.executeNoSqlCommand!("service", "acct:service:svc:web", "acct", "approve-host", [
        JSON.stringify({ deviceId: "nOther" }),
      ]),
    ).rejects.toThrow("does not host");
    await client.executeNoSqlCommand!("service", "acct:service:svc:web", "acct", "approve-host", [
      JSON.stringify({ deviceId: "nWeb" }),
    ]);
    expect(sent("POST", "/tailnet/-/services/svc%3Aweb/device/nWeb/approved")).toEqual([
      { approved: true },
    ]);
  });
});

describe("posture integrations", () => {
  it("sends only the identifiers the chosen provider uses", async () => {
    const { client, sent } = routed({ "POST /tailnet/-/posture/integrations": { id: "p1" } });
    await client.createResource!("posture-integration", "acct", {
      provider: "intune",
      intuneCloud: "us-gov",
      falconCloud: "us-1",
      clientId: "app-uuid",
      tenantId: "tenant",
      clientSecret: "s3cret",
    });
    expect(sent("POST", "/tailnet/-/posture/integrations")).toEqual([
      {
        provider: "intune",
        cloudId: "us-gov",
        clientId: "app-uuid",
        tenantId: "tenant",
        clientSecret: "s3cret",
      },
    ]);
  });
});

describe("user invites", () => {
  it("creates a link-only invite when no email is given", async () => {
    const { client, sent } = routed({
      "POST /tailnet/-/user-invites": [
        { id: "i1", role: "admin", inviteUrl: "https://login.tailscale.com/uinv/x" },
      ],
    });
    const created = (await client.createResource!("user-invite", "acct", {
      role: "admin",
      email: "",
    })) as ResourceInstance;
    expect(sent("POST", "/tailnet/-/user-invites")).toEqual([[{ role: "admin" }]]);
    expect(created.resolvedOutputs.inviteUrl).toBe("https://login.tailscale.com/uinv/x");
  });
});
