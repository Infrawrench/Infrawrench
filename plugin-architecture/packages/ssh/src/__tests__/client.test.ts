import { describe, expect, it } from "vitest";
import { SshClient, type SshCredentials } from "../client.js";

function makeClient(overrides: Partial<SshCredentials> = {}): SshClient {
  return new SshClient({ host: "example.com", ...overrides });
}

describe("SshClient.listResources", () => {
  it("returns a single ssh-target ResourceInstance with defaults applied", async () => {
    const client = makeClient();
    const list = await client.listResources("ssh-target", "acct1");
    expect(list).toHaveLength(1);
    const r = list[0]!;
    expect(r.id).toBe("acct1:ssh-target:example.com");
    expect(r.pluginId).toBe("ssh");
    expect(r.resourceTypeId).toBe("ssh-target");
    expect(r.accountId).toBe("acct1");
    expect(r.displayName).toBe("example.com");
    expect(r.externalId).toBe("example.com");
    expect(r.fields).toEqual({ host: "example.com", port: "22", username: "root" });
    expect(r.resolvedOutputs).toEqual({});
    expect(r.secretStates).toEqual([]);
    expect(typeof r.createdAt).toBe("string");
    expect(typeof r.updatedAt).toBe("string");
    expect(() => new Date(r.createdAt).toISOString()).not.toThrow();
  });

  it("honors explicit port and username", async () => {
    const client = makeClient({ port: "2222", username: "deploy" });
    const [r] = await client.listResources("ssh-target", "a");
    expect(r!.fields).toEqual({ host: "example.com", port: "2222", username: "deploy" });
  });

  it("returns an empty array for unknown resource types", async () => {
    const client = makeClient();
    expect(await client.listResources("something-else", "a")).toEqual([]);
  });
});

describe("SshClient.getResource", () => {
  it("returns the matching resource by id", async () => {
    const client = makeClient();
    const r = await client.getResource("ssh-target", "acct1:ssh-target:example.com", "acct1");
    expect(r.id).toBe("acct1:ssh-target:example.com");
  });

  it("falls back to the first resource when id does not match", async () => {
    const client = makeClient();
    const r = await client.getResource("ssh-target", "nonexistent-id", "acct1");
    expect(r.id).toBe("acct1:ssh-target:example.com");
  });

  it("throws when there are no resources", async () => {
    const client = makeClient();
    await expect(client.getResource("unknown-type", "x", "a")).rejects.toThrow(
      /Resource not found/,
    );
  });
});

describe("SshClient.resolveOutput", () => {
  it("resolves connection outputs", async () => {
    const client = makeClient({ port: "2222", username: "deploy" });
    expect(await client.resolveOutput("ssh-target", "id", "host")).toBe("example.com");
    expect(await client.resolveOutput("ssh-target", "id", "port")).toBe("2222");
    expect(await client.resolveOutput("ssh-target", "id", "username")).toBe("deploy");
    expect(await client.resolveOutput("ssh-target", "id", "sshCommand")).toBe(
      "ssh -p 2222 deploy@example.com",
    );
  });

  it("quotes generated SSH commands when needed", async () => {
    const client = makeClient({ host: "edge host.example.com", username: "deploy user" });
    expect(await client.resolveOutput("ssh-target", "id", "sshCommand")).toBe(
      "ssh -p 22 'deploy user@edge host.example.com'",
    );
  });

  it("returns an empty string for unknown outputs", async () => {
    expect(await makeClient().resolveOutput("ssh-target", "id", "unknown")).toBe("");
    expect(await makeClient().resolveOutput("other", "id", "host")).toBe("");
  });
});

describe("SshClient.fetchDashboardStats", () => {
  it("reports host:port and user with defaults", async () => {
    const stats = await makeClient().fetchDashboardStats();
    expect(stats).toEqual([
      { label: "Host", value: "example.com:22" },
      { label: "User", value: "root" },
    ]);
  });

  it("reflects custom port and username", async () => {
    const stats = await makeClient({ port: "2200", username: "ci" }).fetchDashboardStats();
    expect(stats).toEqual([
      { label: "Host", value: "example.com:2200" },
      { label: "User", value: "ci" },
    ]);
  });
});

describe("SshClient.renderDetail", () => {
  it("renders a Connection section with key-value list", async () => {
    const client = makeClient({ port: "2022", username: "admin" });
    const [resource] = await client.listResources("ssh-target", "a");
    const detail = client.renderDetail(resource!);
    expect(detail.title).toBe("example.com");
    expect(detail.sections).toHaveLength(1);
    const section = detail.sections[0]!;
    expect(section).toMatchObject({ kind: "section", title: "Connection" });
    const kvList = (section as { children: unknown[] }).children[0] as {
      kind: string;
      items: { key: string; value: string }[];
    };
    expect(kvList.kind).toBe("key-value-list");
    expect(kvList.items).toEqual([
      { key: "Host", value: "example.com" },
      { key: "Port", value: "2022" },
      { key: "Username", value: "admin" },
    ]);
  });

  it("uses defaults in the detail view when port/username missing", async () => {
    const client = makeClient();
    const [resource] = await client.listResources("ssh-target", "a");
    const detail = client.renderDetail(resource!);
    const kvList = (detail.sections[0] as { children: { items: { value: string }[] }[] })
      .children[0]!;
    expect(kvList.items.map((i) => i.value)).toEqual(["example.com", "22", "root"]);
  });
});

describe("SshClient.renderSidebarItem", () => {
  it("maps id and displayName", async () => {
    const client = makeClient();
    const [resource] = await client.listResources("ssh-target", "a");
    expect(client.renderSidebarItem(resource!)).toEqual({
      id: resource!.id,
      label: "example.com",
    });
  });
});

describe("SshClient.getSshConfig", () => {
  it("coerces port to a number and supplies defaults", () => {
    const client = makeClient({ port: "2222", username: "deploy", privateKey: "PEM" });
    expect(client.getSshConfig()).toEqual({
      host: "example.com",
      port: 2222,
      username: "deploy",
      privateKey: "PEM",
    });
  });

  it("defaults port 22, username root, empty key when absent", () => {
    const client = makeClient();
    expect(client.getSshConfig()).toEqual({
      host: "example.com",
      port: 22,
      username: "root",
      privateKey: "",
    });
  });
});
