import { describe, expect, it } from "vitest";
import {
  assertKubeconfigSafeForServer,
  findServerUnsafeKubeconfigFields,
  serverKubeconfigError,
} from "../kubeconfig-policy.js";
import { driver, serverDriver } from "../driver.js";
import { plugin } from "../plugin.js";

function kubeconfig(opts: { cluster?: string; user?: string; extraTop?: string } = {}): string {
  return [
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    "  - name: c",
    "    cluster:",
    "      server: https://cluster.example",
    opts.cluster ?? "      certificate-authority-data: Q0E=",
    "users:",
    "  - name: u",
    "    user:",
    opts.user ?? "      token: abc",
    "contexts:",
    "  - name: x",
    "    context: { cluster: c, user: u, namespace: default }",
    "current-context: x",
    opts.extraTop ?? "",
  ].join("\n");
}

describe("findServerUnsafeKubeconfigFields", () => {
  it.each([
    ["a bearer token", {}],
    [
      "client certificate data",
      { user: "      client-certificate-data: Q0VSVA==\n      client-key-data: S0VZ" },
    ],
    ["a username and password", { user: "      username: admin\n      password: hunter2" }],
    ["insecure-skip-tls-verify", { cluster: "      insecure-skip-tls-verify: true" }],
    ["extensions and preferences", { extraTop: "preferences: {}\nextensions: []" }],
  ])("accepts %s", (_label, opts) => {
    expect(findServerUnsafeKubeconfigFields(kubeconfig(opts))).toEqual([]);
  });

  it.each([
    ["exec", { user: "      exec:\n        apiVersion: x\n        command: sh" }],
    [
      "auth-provider",
      { user: "      auth-provider:\n        name: gcp\n        config: { cmd-path: sh }" },
    ],
    ["tokenFile", { user: "      tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token" }],
    ["token-file", { user: "      token-file: /etc/passwd" }],
    ["client-certificate", { user: "      client-certificate: /etc/cert" }],
    ["client-key", { user: "      client-key: /etc/key" }],
    ["certificate-authority", { cluster: "      certificate-authority: /etc/ca" }],
    ["proxy-url", { cluster: "      proxy-url: http://evil.example:3128" }],
  ])("rejects %s", (key, opts) => {
    const problems = findServerUnsafeKubeconfigFields(kubeconfig(opts));
    expect(problems.some((p) => p.includes(`.${key} (`))).toBe(true);
  });

  it("rejects keys it does not know, so a differently-cased exec cannot slip past", () => {
    const problems = findServerUnsafeKubeconfigFields(
      kubeconfig({ user: "      Exec:\n        command: sh" }),
    );
    expect(problems).toEqual(["users[0].user.Exec (not supported)"]);
  });

  it("rejects unknown top-level keys (a second `Users` list)", () => {
    const problems = findServerUnsafeKubeconfigFields(
      kubeconfig({ extraTop: "Users:\n  - name: u\n    user: { exec: { command: sh } }" }),
    );
    expect(problems).toEqual(["kubeconfig.Users (not supported)"]);
  });

  it("sees an exec block pulled in through a YAML merge key", () => {
    const raw = [
      "x-anchor: &creds",
      "  exec: { command: sh }",
      "clusters: [{ name: c, cluster: { server: 'https://c' } }]",
      "users:",
      "  - name: u",
      "    user:",
      "      <<: *creds",
    ].join("\n");
    const problems = findServerUnsafeKubeconfigFields(raw);
    expect(problems).toContain("users[0].user.exec (runs a local credential plugin command)");
  });

  it("checks every user, not just the current one", () => {
    const raw = `${kubeconfig()}\n`.replace(
      "users:\n",
      "users:\n  - name: spare\n    user:\n      exec: { command: sh }\n",
    );
    expect(findServerUnsafeKubeconfigFields(raw)).toEqual([
      "users[0].user.exec (runs a local credential plugin command)",
    ]);
  });

  it("treats unparseable and multi-document input as unsafe", () => {
    expect(findServerUnsafeKubeconfigFields("users: [")).toHaveLength(1);
    expect(findServerUnsafeKubeconfigFields(`${kubeconfig()}\n---\n${kubeconfig()}`)).toHaveLength(
      1,
    );
    expect(findServerUnsafeKubeconfigFields("")).toEqual(["kubeconfig is empty"]);
    expect(findServerUnsafeKubeconfigFields("just a string")).toEqual([
      "kubeconfig (must be a mapping)",
    ]);
  });
});

describe("serverKubeconfigError / assertKubeconfigSafeForServer", () => {
  it("names the field and points at the desktop app", () => {
    const msg = serverKubeconfigError(kubeconfig({ user: "      exec: { command: sh }" }));
    expect(msg).toContain("users[0].user.exec");
    expect(msg).toContain("desktop app");
    expect(serverKubeconfigError(kubeconfig())).toBeNull();
    expect(() => assertKubeconfigSafeForServer(kubeconfig())).not.toThrow();
  });
});

describe("plugin.validateServerCredentials", () => {
  it("checks the kubeconfig credential", () => {
    expect(plugin.validateServerCredentials?.({ kubeconfig: kubeconfig() })).toBeNull();
    expect(
      plugin.validateServerCredentials?.({
        kubeconfig: kubeconfig({ user: "      exec: { command: sh }" }),
      }),
    ).toContain("exec");
  });
});

describe("serverDriver", () => {
  it("refuses an exec kubeconfig before the SDK loads it", async () => {
    const exec = kubeconfig({ user: "      exec: { command: /bin/false }" });
    await expect(serverDriver.command(exec, "getVersion")).rejects.toThrow(/user\.exec/);
  });

  it("shares its id with the desktop driver, which keeps full exec support", () => {
    expect(serverDriver.id).toBe(driver.id);
  });
});
