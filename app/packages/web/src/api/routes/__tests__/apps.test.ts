import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// `./ssh-host-keys` (imported for hostKeyTrustResponse) pulls in the real DB
// client at module load; stub it so no real connection is attempted.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const mockCheckAppsHost = vi.fn();
const mockInstall = vi.fn();
vi.mock("@/services/apps-preflight", () => ({
  checkAppsHost: (...a: unknown[]) => mockCheckAppsHost(...a),
  installAppsHostRequirements: (...a: unknown[]) => mockInstall(...a),
}));

class AppsKeyMissingError extends Error {}
vi.mock("@/services/apps-host", () => ({ AppsKeyMissingError }));

class HostKeyTrustRequiredError extends Error {
  kind = "unknown" as const;
  host = "h";
  port = 22;
  presentedFingerprint = "SHA256:p";
  storedFingerprint = null;
}
vi.mock("@/services/ssh-host-keys", () => ({ HostKeyTrustRequiredError }));

const mockCheckChangeFreeze = vi.fn();
vi.mock("@/services/change-freezes", () => ({
  checkChangeFreeze: (...a: unknown[]) => mockCheckChangeFreeze(...a),
}));

const { appsRoutes } = await import("@/api/routes/apps");
const buildApp = () => buildTestApp(appsRoutes);

const target = {
  accountId: "a1",
  resourceId: "a1:vm:i-1",
  sshKeyId: "k1",
  host: "10.0.0.4",
  username: "root",
};

const preflight = (ready: boolean) => ({
  arch: "x86_64",
  osId: "debian",
  osName: "Debian GNU/Linux 13 (trixie)",
  packageManager: "apt-get",
  privilege: "root",
  requirements: [{ id: "dbus", severity: "required", title: "dbus", summary: "s", ok: ready }],
  staging: true,
  appCount: 3,
  ready,
});

/** Read an NDJSON body into the objects it carried. */
async function ndjson(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

const post = (path: string, body: unknown) =>
  buildApp().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Linux application host setup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckChangeFreeze.mockResolvedValue(null);
  });

  describe("POST /check", () => {
    it("returns the preflight and the plan together", async () => {
      // Together, because the UI shows the commands before offering the button.
      const answer = { preflight: preflight(false), plan: { commands: ["apt-get install dbus"] } };
      mockCheckAppsHost.mockResolvedValue(answer);

      const res = await post("/check", target);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(answer);
    });

    it("400s on a body with an unknown field", async () => {
      // Strict, so a caller cannot smuggle a field past the schema into a
      // service that connects somewhere.
      const res = await post("/check", { ...target, command: "rm -rf /" });

      expect(res.status).toBe(400);
      expect(mockCheckAppsHost).not.toHaveBeenCalled();
    });

    it("404s when the org's SSH key is gone", async () => {
      mockCheckAppsHost.mockRejectedValue(new AppsKeyMissingError("gone"));

      expect((await post("/check", target)).status).toBe(404);
    });

    it("409s with the fingerprint when the host key needs trusting", async () => {
      mockCheckAppsHost.mockRejectedValue(new HostKeyTrustRequiredError("new host"));

      const res = await post("/check", target);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: "ssh_host_key_trust_required",
        presentedFingerprint: "SHA256:p",
      });
    });

    it("502s when the host could not be probed", async () => {
      mockCheckAppsHost.mockRejectedValue(new Error("connect ETIMEDOUT"));

      const res = await post("/check", target);

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "connect ETIMEDOUT" });
    });
  });

  describe("POST /setup", () => {
    it("streams each output line, then the outcome", async () => {
      mockInstall.mockImplementation(async (params: { onOutput: (line: string) => void }) => {
        params.onOutput("Setting up dbus (1.16.2-2)");
        return { log: ["Setting up dbus (1.16.2-2)"], failed: [], preflight: preflight(true) };
      });

      const res = await post("/setup", target);

      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      // The `$ <command>` echo comes from the service, which is mocked here;
      // what this asserts is that the route relays lines as they arrive and puts
      // the outcome last.
      const events = await ndjson(res);
      expect(events[0]).toEqual({ line: "Setting up dbus (1.16.2-2)" });
      expect(events.at(-1)).toMatchObject({ outcome: { failed: [], preflight: { ready: true } } });
    });

    it("passes only the requirement ids through, never a command", async () => {
      mockInstall.mockResolvedValue({ log: [], failed: [], preflight: preflight(true) });

      await post("/setup", { ...target, requirements: ["dbus", "fonts"] });

      expect(mockInstall).toHaveBeenCalledWith(
        expect.objectContaining({ include: ["dbus", "fonts"] }),
      );
    });

    it("rejects a requirement id it does not know", async () => {
      const res = await post("/setup", { ...target, requirements: ["curl"] });

      expect(res.status).toBe(400);
      expect(mockInstall).not.toHaveBeenCalled();
    });

    it("refuses during a change freeze, before touching the host", async () => {
      // Installing packages on a host is a change to production.
      mockCheckChangeFreeze.mockResolvedValue(new Response("frozen", { status: 409 }));

      const res = await post("/setup", target);

      expect(res.status).toBe(409);
      expect(mockInstall).not.toHaveBeenCalled();
    });

    it("reports a failure inside the stream, since the status line has gone", async () => {
      mockInstall.mockRejectedValue(new Error("sudo: a password is required"));

      const res = await post("/setup", target);

      // 200 with an error event, not a 500: the body started before the install
      // could fail, so this is the only channel left.
      expect(res.status).toBe(200);
      expect(await ndjson(res)).toEqual([{ error: "sudo: a password is required" }]);
    });

    it("carries the host-key fingerprint into the stream too", async () => {
      mockInstall.mockRejectedValue(new HostKeyTrustRequiredError("changed"));

      const events = await ndjson(await post("/setup", target));

      expect(events[0]).toMatchObject({
        error: "ssh_host_key_trust_required",
        presentedFingerprint: "SHA256:p",
      });
    });
  });
});
