import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { kubeChildEnv, writeServerKubeconfig, type KubeconfigDir } from "../kube-child";

const TOKEN_KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - name: c
    cluster:
      server: https://cluster.example
      certificate-authority-data: Q0E=
users:
  - name: u
    user:
      token: abc
contexts:
  - name: x
    context: { cluster: c, user: u }
current-context: x
`;

const EXEC_KUBECONFIG = TOKEN_KUBECONFIG.replace(
  "      token: abc",
  "      exec:\n        apiVersion: client.authentication.k8s.io/v1\n        command: sh",
);

const dirs: KubeconfigDir[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d.tmpDir, { recursive: true, force: true });
});

function tmpEntries(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("iw-kube-child-test-"));
}

describe("writeServerKubeconfig", () => {
  it("writes an inline-credential kubeconfig to a private file", () => {
    const dir = writeServerKubeconfig("iw-kube-child-test-", TOKEN_KUBECONFIG);
    dirs.push(dir);
    expect(fs.readFileSync(dir.kubeconfigPath, "utf8")).toBe(TOKEN_KUBECONFIG);
    expect(fs.statSync(dir.kubeconfigPath).mode & 0o777).toBe(0o600);
  });

  it("refuses an exec kubeconfig without writing anything", () => {
    const before = tmpEntries();
    expect(() => writeServerKubeconfig("iw-kube-child-test-", EXEC_KUBECONFIG)).toThrow(
      /users\[0\]\.user\.exec/,
    );
    expect(tmpEntries()).toEqual(before);
  });
});

describe("kubeChildEnv", () => {
  it("passes nothing from the server's environment but PATH", () => {
    const saved = {
      ENCRYPTION_MASTER_KEY: process.env["ENCRYPTION_MASTER_KEY"],
      DATABASE_URL: process.env["DATABASE_URL"],
    };
    process.env["ENCRYPTION_MASTER_KEY"] = "must-not-leak";
    process.env["DATABASE_URL"] = "postgres://must-not-leak";
    try {
      const env = kubeChildEnv({
        tmpDir: "/tmp/iw-x",
        kubeconfigPath: "/tmp/iw-x/kubeconfig.yaml",
      });
      expect(Object.values(env).join("\n")).not.toContain("must-not-leak");
      expect(Object.keys(env).sort()).toEqual(
        [
          "HOME",
          "KUBECONFIG",
          "LANG",
          "PATH",
          "TERM",
          "TMPDIR",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
        ].sort(),
      );
      expect(env["HOME"]).toBe("/tmp/iw-x");
      expect(env["KUBECONFIG"]).toBe("/tmp/iw-x/kubeconfig.yaml");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
