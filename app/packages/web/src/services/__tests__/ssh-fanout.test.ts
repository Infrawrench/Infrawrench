import { describe, it, expect, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../plugin-clients", () => ({ getClientForAccount: vi.fn() }));
vi.mock("../../plugins/loader", () => ({ loadPlugins: vi.fn(), getPlugin: vi.fn() }));
vi.mock("../encryption", () => ({ decrypt: vi.fn(), buildAad: vi.fn() }));
vi.mock("../host-validation", () => ({ assertHostNotInternal: vi.fn() }));

const { deriveResourceTarget } = await import("../ssh-fanout");

const row = {
  id: "res-1",
  accountId: "acc-1",
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  displayName: "web-01",
  fieldsJson: { state: "running", sshUser: "ubuntu", tags: { env: "prod" } },
  outputsJson: { publicIp: "203.0.113.7" },
};

describe("deriveResourceTarget", () => {
  it("returns null without an sshEndpoint declaration", () => {
    expect(deriveResourceTarget(row, undefined)).toBeNull();
    expect(deriveResourceTarget(row, {})).toBeNull();
  });

  it("resolves the host from outputs, falling back to fields", () => {
    const t = deriveResourceTarget(row, { sshEndpoint: { hostOutputKey: "publicIp" } });
    expect(t?.host).toBe("203.0.113.7");
    const fromFields = deriveResourceTarget(
      { ...row, outputsJson: {}, fieldsJson: { ...row.fieldsJson, publicIp: "198.51.100.2" } },
      { sshEndpoint: { hostOutputKey: "publicIp" } },
    );
    expect(fromFields?.host).toBe("198.51.100.2");
  });

  it("returns null when no host resolves", () => {
    expect(
      deriveResourceTarget(
        { ...row, outputsJson: {} },
        { sshEndpoint: { hostOutputKey: "publicIp" } },
      ),
    ).toBeNull();
  });

  it("applies runningWhen case-insensitively", () => {
    const endpoint = {
      sshEndpoint: {
        hostOutputKey: "publicIp",
        runningWhen: { fieldKey: "state", value: "RUNNING" },
      },
    };
    expect(deriveResourceTarget(row, endpoint)?.running).toBe(true);
    expect(
      deriveResourceTarget({ ...row, fieldsJson: { state: "stopped" } }, endpoint)?.running,
    ).toBe(false);
  });

  it("prefers the usernameFieldKey field over defaultUsername", () => {
    const t = deriveResourceTarget(row, {
      sshEndpoint: {
        hostOutputKey: "publicIp",
        defaultUsername: "admin",
        usernameFieldKey: "sshUser",
      },
    });
    expect(t?.defaultUsername).toBe("ubuntu");
    const noField = deriveResourceTarget(
      { ...row, fieldsJson: { state: "running" } },
      { sshEndpoint: { hostOutputKey: "publicIp", defaultUsername: "admin" } },
    );
    expect(noField?.defaultUsername).toBe("admin");
  });

  it("carries resource tags as key:value strings and flags needsKey", () => {
    const t = deriveResourceTarget(row, { sshEndpoint: { hostOutputKey: "publicIp" } });
    expect(t?.tags).toEqual(["env:prod"]);
    expect(t?.needsKey).toBe(true);
    expect(t?.kind).toBe("resource");
    expect(t?.label).toBe("web-01");
  });
});
