import { describe, expect, it, vi } from "vitest";
import {
  createLocalExecGuard,
  kubeconfigMayRunCommands,
  normalizeDockerHost,
  type ConsentRequest,
  type GuardedKind,
} from "../local-exec-guard";

const TOKEN_KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - name: c
    cluster:
      server: https://k8s.example.com
users:
  - name: u
    user:
      token: abc
contexts:
  - name: ctx
    context: { cluster: c, user: u }
current-context: ctx
`;

const EXEC_KUBECONFIG = TOKEN_KUBECONFIG.replace(
  "      token: abc",
  "      exec:\n        apiVersion: client.authentication.k8s.io/v1\n        command: aws\n        args: [eks, get-token]",
);

function setup(opts: { stored?: Partial<Record<GuardedKind, string[]>>; answer?: boolean } = {}) {
  const confirm = vi.fn<(r: ConsentRequest) => Promise<boolean>>(async () => opts.answer ?? false);
  let t = 0;
  const guard = createLocalExecGuard({
    storedValues: async (kind) => opts.stored?.[kind] ?? [],
    activeTunnelPorts: () => [40123],
    confirm,
    now: () => t,
  });
  return { guard, confirm, advance: (ms: number) => (t += ms) };
}

describe("kubeconfigMayRunCommands", () => {
  it("passes a token kubeconfig", () => {
    expect(kubeconfigMayRunCommands(TOKEN_KUBECONFIG)).toBe(false);
  });

  it("flags exec and auth-provider in YAML and JSON", () => {
    expect(kubeconfigMayRunCommands(EXEC_KUBECONFIG)).toBe(true);
    expect(kubeconfigMayRunCommands("users:\n- user:\n    auth-provider:\n      name: gcp")).toBe(
      true,
    );
    expect(kubeconfigMayRunCommands('{"users":[{"user":{"exec":{"command":"sh"}}}]}')).toBe(true);
    expect(kubeconfigMayRunCommands('{"users":[{"user":{"authProvider":{}}}]}')).toBe(true);
  });

  it("flags escape sequences that could spell a key without its letters", () => {
    expect(kubeconfigMayRunCommands('{"users":[{"user":{"\\u0065xec":{"command":"sh"}}}]}')).toBe(
      true,
    );
    expect(kubeconfigMayRunCommands('users:\n- user:\n    "\\x65xec": {command: sh}')).toBe(true);
  });
});

describe("assertKubeconfig", () => {
  it("lets a kubeconfig that runs nothing through without asking", async () => {
    const { guard, confirm } = setup();
    await expect(guard.assertKubeconfig(TOKEN_KUBECONFIG)).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("lets a stored exec kubeconfig through without asking", async () => {
    const { guard, confirm } = setup({ stored: { kubeconfig: [EXEC_KUBECONFIG] } });
    await expect(guard.assertKubeconfig(EXEC_KUBECONFIG)).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refuses an unstored exec kubeconfig the user declines", async () => {
    const { guard, confirm } = setup({ stored: { kubeconfig: [EXEC_KUBECONFIG + "\n"] } });
    await expect(guard.assertKubeconfig(EXEC_KUBECONFIG)).rejects.toThrow(/not allowed/);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0].summary.join("\n")).toContain("command: aws");
  });

  it("remembers an approval for the session", async () => {
    const { guard, confirm } = setup({ answer: true });
    await guard.assertKubeconfig(EXEC_KUBECONFIG);
    await guard.assertKubeconfig(EXEC_KUBECONFIG);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("asks once for a burst of parallel calls, and re-asks after a denial expires", async () => {
    const { guard, confirm, advance } = setup({ answer: false });
    const results = await Promise.allSettled([
      guard.assertKubeconfig(EXEC_KUBECONFIG),
      guard.assertKubeconfig(EXEC_KUBECONFIG),
      guard.assertKubeconfig(EXEC_KUBECONFIG),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    await expect(guard.assertKubeconfig(EXEC_KUBECONFIG)).rejects.toThrow();
    expect(confirm).toHaveBeenCalledTimes(1);
    advance(61_000);
    await expect(guard.assertKubeconfig(EXEC_KUBECONFIG)).rejects.toThrow();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("assertDockerHost", () => {
  it("treats an empty host as the local socket, which needs consent", async () => {
    expect(normalizeDockerHost("")).toBe("unix:///var/run/docker.sock");
    const { guard, confirm } = setup();
    await expect(guard.assertDockerHost("")).rejects.toThrow(/not allowed/);
    expect(confirm.mock.calls[0]![0].summary.join(" ")).toContain("this computer");
  });

  it("accepts a stored host, including the empty-means-default equivalence", async () => {
    const { guard, confirm } = setup({ stored: { dockerHost: ["unix:///var/run/docker.sock"] } });
    await expect(guard.assertDockerHost("")).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("accepts the local end of an SSH tunnel main opened, and nothing else on loopback", async () => {
    const { guard, confirm } = setup();
    await expect(guard.assertDockerHost("tcp://127.0.0.1:40123")).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    await expect(guard.assertDockerHost("tcp://127.0.0.1:2375")).rejects.toThrow();
  });

  it("does not let a kubeconfig stored value vouch for a Docker host", async () => {
    const { guard } = setup({ stored: { kubeconfig: ["unix:///var/run/docker.sock"] } });
    await expect(guard.assertDockerHost("unix:///var/run/docker.sock")).rejects.toThrow();
  });
});

describe("approveForStorage", () => {
  it("asks before storing a new exec kubeconfig and refuses on decline", async () => {
    const { guard, confirm } = setup({ answer: false });
    await expect(
      guard.approveForStorage([{ kind: "kubeconfig", next: EXEC_KUBECONFIG, previous: undefined }]),
    ).rejects.toThrow(/not allowed/);
    expect(confirm.mock.calls[0]![0].purpose).toBe("save");
  });

  it("does not ask when the value is unchanged or runs nothing", async () => {
    const { guard, confirm } = setup();
    await guard.approveForStorage([
      { kind: "kubeconfig", next: EXEC_KUBECONFIG, previous: EXEC_KUBECONFIG },
      { kind: "kubeconfig", next: TOKEN_KUBECONFIG, previous: undefined },
      { kind: "dockerHost", next: "", previous: "unix:///var/run/docker.sock" },
    ]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not ask twice when a connection was approved before the save", async () => {
    const { guard, confirm } = setup({ answer: true });
    await guard.assertDockerHost("tcp://10.0.0.5:2375");
    await guard.approveForStorage([
      { kind: "dockerHost", next: "tcp://10.0.0.5:2375", previous: undefined },
    ]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
