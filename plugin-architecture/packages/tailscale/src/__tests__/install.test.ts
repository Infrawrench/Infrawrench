import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrollmentScript,
  installAndInspectScript,
  installOnSsh,
  parseStatus,
} from "../install.js";

const key = { id: "key-id", key: "tskey-auth-test-secret" };
const status = (BackendState: string, id?: string) =>
  `install output\n__INFRAWRENCH_TAILSCALE_STATUS__\n${JSON.stringify({ BackendState, ...(id ? { Self: { ID: id, TailscaleIPs: ["100.64.0.5"] } } : {}) })}`;
function setup() {
  const exec = vi
    .fn()
    .mockResolvedValueOnce(status("NeedsLogin"))
    .mockResolvedValueOnce(status("Running", "node-1"));
  const api = {
    devices: vi.fn().mockResolvedValue([{ id: "1", nodeId: "node-1" }]),
    createKey: vi.fn().mockResolvedValue(key),
    revokeKey: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
  };
  return { exec, api };
}

describe("Tailscale enrollment", () => {
  it("keeps the official installer from reading the rest of the piped script", () => {
    expect(installAndInspectScript).toContain('sh "$installer" </dev/null');
  });
  it("explains an unreachable tailscaled instead of a JSON parse error", () => {
    expect(() => parseStatus("__INFRAWRENCH_TAILSCALE_STATUS__\n")).toThrow("tailscaled");
  });
  it("explains a host whose earlier custom settings block `tailscale up`", async () => {
    const { exec, api } = setup();
    exec
      .mockReset()
      .mockResolvedValueOnce(status("NeedsLogin"))
      .mockResolvedValueOnce(
        `__INFRAWRENCH_TAILSCALE_UP_ERROR__\nError: changing settings via 'tailscale up' requires mentioning all non-default flags.\n${status("NeedsLogin")}`,
      );
    await expect(installOnSsh({ exec }, api)).rejects.toThrow("custom settings");
    expect(api.revokeKey).toHaveBeenCalledWith(key.id);
  });
  it("surfaces what `tailscale up` printed when enrollment stalls", async () => {
    const { exec, api } = setup();
    exec
      .mockReset()
      .mockResolvedValueOnce(status("NeedsLogin"))
      .mockResolvedValueOnce(
        `__INFRAWRENCH_TAILSCALE_UP_ERROR__\nbackend error: invalid key: ${key.key} expired\n${status("NeedsLogin")}`,
      );
    const error = await installOnSsh({ exec }, api).catch((e: Error) => e);
    expect(error.message).toContain("backend error: invalid key");
    expect(error.message).not.toContain(key.key);
  });
  it("checks the host before creating a one-use key and revokes it after success", async () => {
    const { exec, api } = setup();
    const result = await installOnSsh({ exec }, api);
    expect(result.address).toBe("100.64.0.5");
    expect(exec.mock.invocationCallOrder[0]).toBeLessThan(
      api.createKey.mock.invocationCallOrder[0]!,
    );
    expect(api.revokeKey).toHaveBeenCalledWith(key.id);
    expect(JSON.stringify(result)).not.toContain(key.key);
  });
  it("does not reinstall or reauthenticate a running device in this tailnet", async () => {
    const { exec, api } = setup();
    exec.mockReset().mockResolvedValue(status("Running", "node-1"));
    expect((await installOnSsh({ exec }, api)).message).toContain("already connected");
    expect(api.createKey).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("treats a device of this tailnet that is still starting as already connected", async () => {
    const { exec, api } = setup();
    exec.mockReset().mockResolvedValue(status("Starting", "node-1"));
    expect((await installOnSsh({ exec }, api)).message).toContain("already connected");
    expect(api.createKey).not.toHaveBeenCalled();
  });
  it("does not move a device out of another tailnet", async () => {
    const { exec, api } = setup();
    exec.mockReset().mockResolvedValue(status("Running", "other-node"));
    await expect(installOnSsh({ exec }, api)).rejects.toThrow("another tailnet");
    expect(api.createKey).not.toHaveBeenCalled();
  });
  it("preserves a host-key trust error before any key is minted", async () => {
    const { exec, api } = setup();
    const trust = new Error("Trust this host first");
    exec.mockReset().mockRejectedValue(trust);
    await expect(installOnSsh({ exec }, api)).rejects.toBe(trust);
    expect(api.createKey).not.toHaveBeenCalled();
  });
  it("revokes a key on failed setup and removes secrets from errors", async () => {
    const { exec, api } = setup();
    exec
      .mockReset()
      .mockResolvedValueOnce(status("NeedsLogin"))
      .mockRejectedValueOnce(new Error(`failed: ${key.key}`));
    await expect(installOnSsh({ exec }, api)).rejects.toThrow("failed: [redacted]");
    expect(api.revokeKey).toHaveBeenCalledWith(key.id);
  });
  it("approves a device left awaiting approval and still revokes the key", async () => {
    const { exec, api } = setup();
    exec
      .mockReset()
      .mockResolvedValueOnce(status("NeedsLogin"))
      .mockResolvedValueOnce(status("NeedsMachineAuth", "node-1"));
    expect((await installOnSsh({ exec }, api)).message).toContain("device is approved");
    expect(api.approve).toHaveBeenCalledWith("node-1");
    expect(api.revokeKey).toHaveBeenCalled();
  });
  it("leaves approval to a human when this account cannot approve devices", async () => {
    const { exec, api } = setup();
    api.approve.mockRejectedValue(new Error("Tailscale API error 403: forbidden"));
    exec
      .mockReset()
      .mockResolvedValueOnce(status("NeedsLogin"))
      .mockResolvedValueOnce(status("NeedsMachineAuth", "node-1"));
    const result = await installOnSsh({ exec }, api);
    expect(result.message).toContain("could not approve");
    expect(result.message).not.toContain("403");
  });
  it("approves an already-joined server awaiting approval without minting a key", async () => {
    const { exec, api } = setup();
    exec.mockReset().mockResolvedValue(status("NeedsMachineAuth", "node-1"));
    expect((await installOnSsh({ exec }, api)).message).toContain("device is approved");
    expect(api.approve).toHaveBeenCalledWith("node-1");
    expect(api.createKey).not.toHaveBeenCalled();
  });
  it("reports failed cleanup without claiming enrollment failed", async () => {
    const { exec, api } = setup();
    api.revokeKey.mockRejectedValue(new Error("API unavailable"));
    expect((await installOnSsh({ exec }, api)).warnings?.[0]).toContain("five minutes");
  });
  it("rejects a failure status after login and cleans up", async () => {
    const { exec, api } = setup();
    exec.mockReset().mockResolvedValue(status("NeedsLogin"));
    await expect(installOnSsh({ exec }, api)).rejects.toThrow("did not finish");
    expect(api.revokeKey).toHaveBeenCalled();
  });
  it("never sends an unexpected key value to the shell", async () => {
    const { exec, api } = setup();
    api.createKey.mockResolvedValue({ ...key, key: "'; touch /tmp/nope #" });
    await expect(installOnSsh({ exec }, api)).rejects.toThrow("Invalid Tailscale enrollment key");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(api.revokeKey).toHaveBeenCalledWith(key.id);
  });
  it("generates portable shell scripts", () => {
    for (const script of [installAndInspectScript, enrollmentScript(key.key)])
      execFileSync("sh", ["-n"], { input: script });
  });
  it.each([0, 1])(
    "uses a protected auth file and cleans it up when tailscale up exits %s",
    (exitCode) => {
      const dir = mkdtempSync(join(tmpdir(), "iw-tailscale-test-"));
      try {
        // Only fake commands run: the test never installs or joins Tailscale.
        writeFileSync(join(dir, "id"), '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 });
        writeFileSync(
          join(dir, "tailscale"),
          `#!/bin/sh
if [ "$1" = up ]; then
  file="\${2#--auth-key=file:}"
  test "$(cat "$file")" = '${key.key}' || exit 90
  test "$(stat -c %a "$file")" = 600 || exit 91
  printf 'verified-file\\n'
  exit ${exitCode}
fi
printf '{"BackendState":"NeedsMachineAuth","Self":{"ID":"node-1"}}\\n'
`,
          { mode: 0o755 },
        );
        const output = execFileSync("sh", ["-s"], {
          input: enrollmentScript(key.key),
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir },
          encoding: "utf8",
        });
        expect(output).toContain("verified-file");
        expect(output).toContain('"NeedsMachineAuth"');
        expect(output).not.toContain(key.key);
        expect(readdirSync(dir).sort()).toEqual(["id", "tailscale"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
