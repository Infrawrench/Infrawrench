import { describe, expect, it, vi } from "vitest";
import {
  runDockerSetupScript,
  type DockerSetupContext,
  type DockerSetupStep,
} from "../docker-setup-script";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function makeCtx(execImpl: (cmd: string) => ExecResult) {
  const steps: DockerSetupStep[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  const ctx: DockerSetupContext = {
    exec: async (command: string) => {
      calls.push(command);
      return execImpl(command);
    },
    sudo: (cmd) => `sudo ${cmd}`,
    sshHost: "1.2.3.4",
    appendLog: (m) => logs.push(m),
    setStep: (s) => steps.push(s),
  };
  return { ctx, steps, logs, calls };
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr = "x", stdout = ""): ExecResult => ({ stdout, stderr, code: 1 });

describe("runDockerSetupScript", () => {
  it("skips install when Docker already present and listening", async () => {
    const { ctx, steps, logs } = makeCtx((cmd) => {
      if (cmd.includes("docker --version")) return ok("Docker version 24.0.0");
      if (cmd.includes("2375/version")) return ok('{"ApiVersion":"1.43"}');
      return ok();
    });
    const result = await runDockerSetupScript(ctx);
    expect(result.dockerVersion).toBe("Docker version 24.0.0");
    expect(steps).toEqual(["checking", "configuring"]);
    expect(logs.some((l) => /already listening/.test(l))).toBe(true);
  });

  it("installs Docker when missing then configures TCP", async () => {
    let versionCalls = 0;
    let tcpCalls = 0;
    const { ctx, steps } = makeCtx((cmd) => {
      if (cmd.includes("docker --version 2>/dev/null")) return fail();
      if (cmd.startsWith("curl -fsSL https://get.docker.com")) return ok("installed");
      if (cmd === "docker --version") {
        versionCalls++;
        return ok("Docker version 25.0.0");
      }
      if (cmd.includes("2375/version")) {
        tcpCalls++;
        // first check fails, post-config verify succeeds
        return tcpCalls === 1 ? fail() : ok('{"ApiVersion":"1.43"}');
      }
      return ok();
    });
    const result = await runDockerSetupScript(ctx);
    expect(result.dockerVersion).toBe("Docker version 25.0.0");
    expect(versionCalls).toBe(1);
    expect(steps).toEqual(["checking", "installing", "configuring"]);
  });

  it("throws when install fails", async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd.includes("docker --version 2>/dev/null")) return fail();
      if (cmd.startsWith("curl -fsSL")) return fail("install boom");
      return ok();
    });
    await expect(runDockerSetupScript(ctx)).rejects.toThrow(/Docker installation failed/);
  });

  it("throws when installed docker is not accessible", async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd.includes("docker --version 2>/dev/null")) return fail();
      if (cmd.startsWith("curl -fsSL")) return ok("done");
      if (cmd === "docker --version") return fail("nope");
      return ok();
    });
    await expect(runDockerSetupScript(ctx)).rejects.toThrow(/not accessible/);
  });

  it("throws when TCP config fails", async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd.includes("docker --version")) return ok("Docker version 24");
      if (cmd.includes("2375/version")) return fail();
      if (cmd.includes("mkdir -p /etc/systemd")) return fail("config boom");
      return ok();
    });
    await expect(runDockerSetupScript(ctx)).rejects.toThrow(/Failed to configure Docker TCP/);
  });

  it("throws when TCP listener does not respond after configuration", async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd.includes("docker --version")) return ok("Docker version 24");
      if (cmd.includes("2375/version")) return fail(); // always fails
      return ok();
    });
    await expect(runDockerSetupScript(ctx)).rejects.toThrow(/not responding after configuration/);
  });

  it("wraps configure commands with sudo", async () => {
    const sudo = vi.fn((cmd: string) => `sudo ${cmd}`);
    let tcpCalls = 0;
    const ctx: DockerSetupContext = {
      exec: async (cmd) => {
        if (cmd.includes("docker --version")) return ok("Docker version 24");
        if (cmd.includes("2375/version")) {
          tcpCalls++;
          return tcpCalls === 1 ? fail() : ok('{"ApiVersion":"1"}');
        }
        return ok();
      },
      sudo,
      sshHost: "h",
      appendLog: () => {},
      setStep: () => {},
    };
    await runDockerSetupScript(ctx);
    expect(sudo).toHaveBeenCalledWith("systemctl restart docker");
  });
});
