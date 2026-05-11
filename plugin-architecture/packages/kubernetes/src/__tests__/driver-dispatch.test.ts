import { describe, it, expect, vi } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";

import { KubernetesClient } from "../client.js";

// A representative kubeconfig the hand-rolled parser handles. The point of
// the test is that when the driver is wired in, the client routes through
// `services.k8s.command(...)` instead of issuing direct HTTP — so even an
// otherwise-broken kubeconfig (e.g. one using exec credentials) would
// still work via the driver path.
const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - name: c1
    cluster:
      server: https://cluster.example
users:
  - name: u1
    user:
      token: tok
contexts:
  - name: ctx1
    context: { cluster: c1, user: u1 }
current-context: ctx1
`;

const EXEC_KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - name: c1
    cluster:
      server: https://cluster.example
users:
  - name: u1
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1
        command: gke-gcloud-auth-plugin
contexts:
  - name: ctx1
    context: { cluster: c1, user: u1 }
current-context: ctx1
`;

describe("KubernetesClient with services.k8s driver", () => {
  it("dispatches listResources through services.k8s.command rather than direct fetch", async () => {
    const command = vi.fn(async (op: string, args?: Record<string, unknown>) => {
      // The lister calls k8sFetch which becomes a `request` op against the
      // driver. The shape returned must mirror the real K8s REST response.
      if (op === "request" && args?.["path"] === "/api/v1/namespaces") {
        return {
          items: [
            {
              metadata: {
                name: "my-app",
                uid: "u",
                creationTimestamp: "2024-01-01T00:00:00Z",
              },
              status: { phase: "Active" },
            },
          ],
        };
      }
      throw new Error(`unexpected op: ${op} ${JSON.stringify(args)}`);
    });
    const services: HostServices = { k8s: { command } };

    const client = new KubernetesClient({ kubeconfig: KUBECONFIG }, services);
    const result = await client.listResources("k8s-namespace", "acct1");

    expect(command).toHaveBeenCalledWith(
      "request",
      expect.objectContaining({ path: "/api/v1/namespaces", method: "GET" }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.fields["name"]).toBe("my-app");
  });

  it("constructs client even when kubeconfig uses exec credentials (driver path)", () => {
    const command = vi.fn();
    const services: HostServices = { k8s: { command } };

    // The hand-rolled parser would silently drop the exec block, leaving no
    // token. As long as the driver is present the client must still
    // construct so the driver can do its job.
    expect(() => new KubernetesClient({ kubeconfig: EXEC_KUBECONFIG }, services)).not.toThrow();
  });

  it("falls back to direct fetch when no services.k8s is provided", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const client = new KubernetesClient({ kubeconfig: KUBECONFIG });
      await client.listResources("k8s-namespace", "acct1");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://cluster.example/api/v1/namespaces",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
