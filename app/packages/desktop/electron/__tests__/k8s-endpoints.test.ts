import { beforeAll, describe, expect, it } from "vitest";
import {
  isK8sApiEndpointAllowed,
  isPrivateAddress,
  registerK8sEndpoint,
  registerKubeconfigClusterEndpoints,
  resolveK8sApiEndpoint,
} from "../k8s-endpoints";

// `registerKubeconfigClusterEndpoints` dynamically imports
// @kubernetes/client-node (ESM-only, so it can't be required at module load).
// That cold import lands inside whichever test calls it first, and under a
// fully parallel `turbo test` run it can exceed the default 5s per-test
// timeout: an intermittent failure of only the kubeconfig tests, only under
// load. Warm it once here instead, the way plugin-loader.test.ts warms the
// plugin registry.
beforeAll(async () => {
  await import("@kubernetes/client-node");
}, 60_000);

// The allowlist is module-level state shared across this file, so every test
// registers distinct host:port pairs and asserts against endpoints no other
// test registers.

function kubeconfigWithServers(...servers: string[]): string {
  const clusters = servers
    .map(
      (server, i) => `  - name: cluster-${i}
    cluster:
      server: ${server}`,
    )
    .join("\n");
  return `apiVersion: v1
kind: Config
clusters:
${clusters}
users:
  - name: user
    user:
      token: test-token
contexts:
  - name: ctx
    context:
      cluster: cluster-0
      user: user
current-context: ctx
`;
}

describe("isK8sApiEndpointAllowed", () => {
  it("allows public hosts without registration", () => {
    expect(isK8sApiEndpointAllowed("k8s.example.com", "443")).toBe(true);
    expect(isK8sApiEndpointAllowed("34.120.10.5", "443")).toBe(true);
    expect(isK8sApiEndpointAllowed("2600:1901::1", "443")).toBe(true);
  });

  it("blocks unregistered loopback and private hosts", () => {
    expect(isK8sApiEndpointAllowed("127.0.0.1", "6443")).toBe(false);
    expect(isK8sApiEndpointAllowed("localhost", "6443")).toBe(false);
    expect(isK8sApiEndpointAllowed("sub.localhost", "6443")).toBe(false);
    expect(isK8sApiEndpointAllowed("10.1.2.3", "443")).toBe(false);
    expect(isK8sApiEndpointAllowed("172.16.0.1", "443")).toBe(false);
    expect(isK8sApiEndpointAllowed("192.168.1.10", "443")).toBe(false);
    expect(isK8sApiEndpointAllowed("::1", "6443")).toBe(false);
    expect(isK8sApiEndpointAllowed("fd00::2", "6443")).toBe(false);
  });

  it("blocks cloud metadata endpoints", () => {
    expect(isK8sApiEndpointAllowed("169.254.169.254", "80")).toBe(false);
    expect(isK8sApiEndpointAllowed("metadata.google.internal", "80")).toBe(false);
  });
});

describe("registerK8sEndpoint", () => {
  it("allows exactly the registered host:port, case-insensitively", () => {
    registerK8sEndpoint("MyCluster.LOCALHOST", 16443);
    expect(isK8sApiEndpointAllowed("mycluster.localhost", "16443")).toBe(true);
    // Same host, different port stays blocked.
    expect(isK8sApiEndpointAllowed("mycluster.localhost", "16444")).toBe(false);
  });
});

describe("registerKubeconfigClusterEndpoints", () => {
  it("registers every cluster server in the kubeconfig", async () => {
    await registerKubeconfigClusterEndpoints(
      kubeconfigWithServers("https://127.0.0.1:32771", "https://10.20.30.40"),
    );
    expect(isK8sApiEndpointAllowed("127.0.0.1", "32771")).toBe(true);
    // No explicit port → https default 443.
    expect(isK8sApiEndpointAllowed("10.20.30.40", "443")).toBe(true);
  });

  it("infers port 80 for http servers", async () => {
    await registerKubeconfigClusterEndpoints(kubeconfigWithServers("http://192.168.49.2"));
    expect(isK8sApiEndpointAllowed("192.168.49.2", "80")).toBe(true);
    expect(isK8sApiEndpointAllowed("192.168.49.2", "443")).toBe(false);
  });

  it("ignores cluster servers with non-http(s) schemes", async () => {
    await registerKubeconfigClusterEndpoints(kubeconfigWithServers("ftp://192.168.77.1:21"));
    expect(isK8sApiEndpointAllowed("192.168.77.1", "21")).toBe(false);
  });

  it("registers nothing for a malformed kubeconfig, without throwing", async () => {
    await expect(registerKubeconfigClusterEndpoints("not: [valid")).resolves.toBeUndefined();
    await expect(
      registerKubeconfigClusterEndpoints("apiVersion: v1\nkind: Config\nclusters: 12\n"),
    ).resolves.toBeUndefined();
    expect(isK8sApiEndpointAllowed("127.0.0.1", "9999")).toBe(false);
  });

  it("is a no-op for undefined or empty input", async () => {
    await expect(registerKubeconfigClusterEndpoints(undefined)).resolves.toBeUndefined();
    await expect(registerKubeconfigClusterEndpoints("")).resolves.toBeUndefined();
  });
});

describe("resolveK8sApiEndpoint", () => {
  const resolvesTo =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("returns the vetted address of a public name", async () => {
    await expect(
      resolveK8sApiEndpoint("k8s.example.com", "443", { lookupAll: resolvesTo("34.1.2.3") }),
    ).resolves.toEqual({ address: "34.1.2.3", family: 4 });
  });

  it("refuses a public name that resolves to loopback, private or metadata addresses", async () => {
    for (const addr of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1"]) {
      await expect(
        resolveK8sApiEndpoint("rebind.example.com", "443", {
          lookupAll: resolvesTo("34.1.2.3", addr),
        }),
      ).rejects.toThrow(/private\/loopback/);
    }
  });

  it("refuses private literals unless registered or trusted", async () => {
    await expect(resolveK8sApiEndpoint("100.64.0.1", "443")).rejects.toThrow();
    registerK8sEndpoint("10.99.0.1", 6443);
    await expect(resolveK8sApiEndpoint("10.99.0.1", "6443")).resolves.toEqual({
      address: "10.99.0.1",
      family: 4,
    });
    await expect(
      resolveK8sApiEndpoint("search.corp", "9200", {
        lookupAll: resolvesTo("10.5.5.5"),
        trusted: true,
      }),
    ).resolves.toEqual({ address: "10.5.5.5", family: 4 });
  });
});

describe("isPrivateAddress", () => {
  it("covers the ranges a literal-prefix check missed", () => {
    expect(isPrivateAddress("100.64.1.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(false);
  });
});
