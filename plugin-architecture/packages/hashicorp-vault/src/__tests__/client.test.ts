import { describe, expect, it } from "vitest";
import { normaliseAddress, VaultApiError } from "../api.js";
import { parseKvValue, VaultClient } from "../client.js";
import { mapMount, mapToken } from "../mappers.js";
import { isVaultIncident } from "../status-feed.js";
import { vaultTerraformExport } from "../terraform.js";
import { parsePemCertificate } from "../x509.js";
import { CERT_PEM } from "./fixtures.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = makeHttp(route);
  return {
    c: new VaultClient(
      { address: "vault.example.com:8200/ui/", token: "hvs.t", namespace: "admin", ...creds },
      { http } as never,
    ),
    calls,
  };
}

describe("helpers", () => {
  it("normalises the address", () => {
    expect(normaliseAddress("vault.example.com:8200/ui/")).toBe("https://vault.example.com:8200");
    expect(normaliseAddress("http://127.0.0.1:8200/v1")).toBe("http://127.0.0.1:8200");
  });

  it("parses KV values typed by a person", () => {
    expect(parseKvValue('{"a": "1"}')).toEqual({ a: "1" });
    expect(parseKvValue('USER=app\nPASS="x=y"')).toEqual({ USER: "app", PASS: "x=y" });
    expect(parseKvValue("just a string")).toEqual({ value: "just a string" });
  });

  it("reads CN and validity from a certificate", () => {
    expect(parsePemCertificate(CERT_PEM)).toEqual({
      commonName: "api.example.internal",
      issuerCommonName: "api.example.internal",
      notBefore: "2026-10-07T01:07:14.000Z",
      notAfter: "2026-11-06T01:07:14.000Z",
    });
    expect(parsePemCertificate("garbage")).toEqual({});
  });

  it("labels kv v2 mounts", () => {
    expect(
      mapMount(ACCOUNT, "secret/", { type: "kv", options: { version: "2" } }).fields["type"],
    ).toBe("kv-v2");
  });

  it("flags root tokens", () => {
    const t = mapToken(ACCOUNT, { accessor: "a1", policies: ["root"], expire_time: null });
    expect(t.fields).toMatchObject({ root: true, neverExpires: true });
  });
});

describe("requests", () => {
  it("sends the token and namespace and lists with ?list=true", async () => {
    const { c, calls } = client(() => ({ data: { keys: ["default", "app"] } }));
    await c.listResources("vault-policy", ACCOUNT);
    expect(calls[0]!.url.toString()).toBe(
      "https://vault.example.com:8200/v1/sys/policies/acl?list=true",
    );
    expect(calls[0]!.headers["X-Vault-Token"]).toBe("hvs.t");
    expect(calls[0]!.headers["X-Vault-Namespace"]).toBe("admin");
  });

  it("logs in with AppRole and reuses the token", async () => {
    const { c, calls } = client(
      (call) =>
        call.url.pathname === "/v1/auth/approle/login"
          ? { auth: { client_token: "hvs.login", lease_duration: 3600 } }
          : { data: { keys: [] } },
      { token: "", roleId: "r", secretId: "s" },
    );
    await c.listResources("vault-policy", ACCOUNT);
    await c.listResources("vault-token", ACCOUNT);
    expect(calls.filter((x) => x.url.pathname === "/v1/auth/approle/login")).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ role_id: "r", secret_id: "s" });
    expect(calls[1]!.headers["X-Vault-Token"]).toBe("hvs.login");
  });

  it("maps errors to a status and treats a LIST 404 as empty", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/v1/sys/audit"
        ? { status: 403, body: { errors: ["permission denied"] } }
        : { status: 404, body: { errors: [] } },
    );
    expect(await c.listResources("vault-token", ACCOUNT)).toEqual([]);
    const err = await c.listResources("vault-audit-device", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultApiError);
    expect((err as VaultApiError).status).toBe(403);
    expect((err as Error).message).toContain("permission denied");
  });

  it("reads health from a standby node without failing", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/sys/health")
        return {
          status: 429,
          body: { standby: true, sealed: false, version: "1.21.0", cluster_name: "prod" },
        };
      if (call.url.pathname === "/v1/sys/seal-status")
        return { sealed: false, type: "awskms", t: 1, n: 1 };
      return { ha_enabled: true, leader_address: "https://node1:8200", is_self: false };
    });
    const [cluster] = await c.listResources("vault-cluster", ACCOUNT);
    expect(cluster!.displayName).toBe("prod");
    expect(cluster!.fields).toMatchObject({
      standby: true,
      sealed: false,
      sealType: "awskms",
      leaderAddress: "https://node1:8200",
    });
  });
});

describe("kv v2", () => {
  const route = (call: Call) => {
    const p = call.url.pathname;
    if (p === "/v1/sys/mounts")
      return {
        data: { "secret/": { type: "kv", options: { version: "2" } }, "pki/": { type: "pki" } },
      };
    if (p === "/v1/secret/metadata/" && call.url.searchParams.get("list"))
      return { data: { keys: ["app/", "top"] } };
    if (p === "/v1/secret/metadata/app/" && call.url.searchParams.get("list"))
      return { data: { keys: ["db"] } };
    if (p.startsWith("/v1/secret/metadata/"))
      return {
        data: {
          current_version: 2,
          versions: {
            "1": {
              created_time: "2026-01-01T00:00:00Z",
              deletion_time: "2026-02-01T00:00:00Z",
              destroyed: false,
            },
            "2": { created_time: "2026-03-01T00:00:00Z", deletion_time: "", destroyed: false },
          },
        },
      };
    return {};
  };

  it("walks folders and lists secrets under their engine", async () => {
    const { c } = client(route);
    const secrets = await c.listResources("vault-kv-secret", ACCOUNT);
    expect(secrets.map((s) => s.externalId)).toEqual(["secret::app/db", "secret::top"]);
    expect(secrets[0]!.parentResourceId).toBe(`${ACCOUNT}:vault-mount:secret`);
    expect(secrets[0]!.fields["currentVersion"]).toBe(2);
  });

  it("maps versions and their states", async () => {
    const { c } = client(route);
    const versions = await c.listSecretVersions(
      "vault-kv-secret",
      `${ACCOUNT}:vault-kv-secret:secret::app/db`,
    );
    expect(versions).toEqual([
      { id: "2", state: "enabled", createdAt: "2026-03-01T00:00:00Z", isLatest: true },
      { id: "1", state: "disabled", createdAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("soft-deletes, restores and destroys versions with the right verbs", async () => {
    const { c, calls } = client(route);
    const id = `${ACCOUNT}:vault-kv-secret:secret::app/db`;
    await c.modifySecretVersion("vault-kv-secret", id, ACCOUNT, "1", "enable");
    await c.modifySecretVersion("vault-kv-secret", id, ACCOUNT, "1", "destroy");
    const writes = calls.filter((x) => x.method !== "GET");
    expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual([
      "POST /v1/secret/undelete/app/db",
      "PUT /v1/secret/destroy/app/db",
    ]);
    expect(writes[0]!.body).toEqual({ versions: [1] });
  });

  it("adds a version from KEY=value text", async () => {
    const { c, calls } = client(() => ({
      data: { version: 3, created_time: "2026-10-01T00:00:00Z" },
    }));
    const v = await c.addSecretVersion(
      "vault-kv-secret",
      `${ACCOUNT}:vault-kv-secret:secret::app/db`,
      ACCOUNT,
      "A=1",
    );
    expect(calls[0]!.url.pathname).toBe("/v1/secret/data/app/db");
    expect(calls[0]!.body).toEqual({ data: { A: "1" } });
    expect(v).toMatchObject({ id: "3", isLatest: true });
  });
});

describe("pki, policies, tokens", () => {
  it("lists certificates with expiry parsed from the PEM", async () => {
    const { c } = client((call) => {
      const p = call.url.pathname;
      if (p === "/v1/sys/mounts") return { data: { "pki/": { type: "pki" } } };
      if (p === "/v1/pki/certs") return { data: { keys: ["10:e8:9e"] } };
      return { data: { certificate: CERT_PEM, revocation_time: 0 } };
    });
    const [cert] = await c.listResources("vault-pki-cert", ACCOUNT);
    expect(cert!.externalId).toBe("pki::10-e8-9e");
    expect(cert!.fields).toMatchObject({
      commonName: "api.example.internal",
      notAfter: "2026-11-06T01:07:14.000Z",
      revoked: false,
    });
  });

  it("patches PKI roles with merge-patch", async () => {
    const { c, calls } = client(() => ({ data: {} }));
    await c.updateResource("vault-pki-role", `${ACCOUNT}:vault-pki-role:pki::web`, ACCOUNT, {
      allowAnyName: "false",
      allowedDomains: "a.com, b.com",
    });
    const patch = calls.find((x) => x.method === "PATCH")!;
    expect(patch.url.pathname).toBe("/v1/pki/roles/web");
    expect(patch.headers["Content-Type"]).toBe("application/merge-patch+json");
    expect(patch.body).toEqual({ allow_any_name: false, allowed_domains: ["a.com", "b.com"] });
  });

  it("saves an edited policy from the editor prompt", async () => {
    const { c, calls } = client(() => ({}));
    await c.executeNoSqlCommand(
      "vault-policy",
      `${ACCOUNT}:vault-policy:app`,
      ACCOUNT,
      "edit-policy",
      [JSON.stringify({ policy: 'path "a/*" { capabilities = ["read"] }' })],
    );
    expect(calls[0]!.url.pathname).toBe("/v1/sys/policies/acl/app");
    expect(calls[0]!.body).toEqual({ policy: 'path "a/*" { capabilities = ["read"] }' });
    await expect(
      c.deleteResource("vault-policy", `${ACCOUNT}:vault-policy:default`, ACCOUNT),
    ).rejects.toThrow(/built in/);
  });

  it("revokes a token by accessor", async () => {
    const { c, calls } = client(() => ({}));
    await c.deleteResource("vault-token", `${ACCOUNT}:vault-token:acc-1`, ACCOUNT);
    expect(calls[0]!.url.pathname).toBe("/v1/auth/token/revoke-accessor");
    expect(calls[0]!.body).toEqual({ accessor: "acc-1" });
  });
});

describe("status feed and terraform", () => {
  it("keeps only Vault incidents", () => {
    expect(isVaultIncident("HCP Vault Azure: Cluster Updates")).toBe(true);
    expect(isVaultIncident("Degraded scans in HCP Vault Radar")).toBe(false);
    expect(isVaultIncident("HCP Terraform Returning 404s")).toBe(false);
  });

  it("exports a kv v2 mount", () => {
    const out = vaultTerraformExport.mapResource(
      mapMount(ACCOUNT, "secret/", { type: "kv", options: { version: "2" }, description: "app" }),
    );
    expect(out?.resource).toMatchObject({ type: "vault_mount", importId: "secret" });
    expect(out?.resource.attributes["options"]).toEqual({
      kind: "map",
      entries: { version: { kind: "string", value: "2" } },
    });
    expect(
      vaultTerraformExport.mapResource(mapMount(ACCOUNT, "cubbyhole/", { type: "cubbyhole" })),
    ).toBeNull();
  });
});
