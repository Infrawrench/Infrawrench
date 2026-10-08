import { describe, expect, it } from "vitest";
import type { JitGrantSpec } from "@infrawrench/plugin-base";

import {
  CLUSTER_SCOPE,
  buildJitBinding,
  checkK8sJitAccess,
  grantK8sJitAccess,
  listK8sJitRoles,
  revokeK8sJitAccess,
  type K8sJitContext,
} from "../jit-access.js";

const spec = (over: Partial<JitGrantSpec> = {}): JitGrantSpec => ({
  grantId: "11111111-2222-3333-4444-555555555555",
  scopeId: "payments",
  roleId: "ClusterRole:edit",
  principal: { id: "dana@example.com", name: "Dana", kind: "user" },
  expiresAt: new Date("2026-10-07T12:00:00Z"),
  reason: "INC-42 rollback",
  ...over,
});

function fakeCluster() {
  const objects = new Map<string, unknown>();
  const calls: Array<{ method: string; path: string }> = [];
  const ctx: K8sJitContext = {
    async fetch<T>(path: string, options?: RequestInit): Promise<T> {
      const method = options?.method ?? "GET";
      calls.push({ method, path });
      if (method === "POST") {
        const body = JSON.parse(String(options!.body)) as { metadata: { name: string } };
        const key = `${path}/${body.metadata.name}`;
        if (objects.has(key)) throw new Error(`K8s API error 409 at ${path}: AlreadyExists`);
        objects.set(key, body);
        return body as T;
      }
      if (method === "DELETE") {
        if (!objects.delete(path)) throw new Error(`K8s API error 404 at ${path}: NotFound`);
        return {} as T;
      }
      if (method === "PATCH") return {} as T;
      if (path.endsWith("/clusterroles")) {
        return {
          items: [
            { metadata: { name: "edit" } },
            { metadata: { name: "cluster-admin" } },
            { metadata: { name: "system:node" } },
          ],
        } as T;
      }
      if (path.endsWith("/roles")) return { items: [{ metadata: { name: "deployer" } }] } as T;
      if (objects.has(path)) return objects.get(path) as T;
      throw new Error(`K8s API error 404 at ${path}: NotFound`);
    },
  };
  return { ctx, objects, calls };
}

describe("kubernetes just-in-time access", () => {
  it("offers user-facing ClusterRoles plus the namespace's Roles", async () => {
    const { ctx } = fakeCluster();
    const roles = await listK8sJitRoles(ctx, "payments");
    expect(roles.map((r) => r.id)).toEqual([
      "ClusterRole:cluster-admin",
      "Role:deployer",
      "ClusterRole:edit",
    ]);
    expect(roles.find((r) => r.id === "ClusterRole:cluster-admin")?.privileged).toBe(true);
    const cluster = await listK8sJitRoles(ctx, CLUSTER_SCOPE);
    expect(cluster.some((r) => r.id.startsWith("Role:"))).toBe(false);
  });

  it("creates a binding named after the grant, idempotently", async () => {
    const { ctx, objects } = fakeCluster();
    await grantK8sJitAccess(ctx, spec());
    await grantK8sJitAccess(ctx, spec());
    expect(objects.size).toBe(1);
    expect(await checkK8sJitAccess(ctx, spec())).toBe("present");
  });

  it("revokes idempotently, including a grant that never landed", async () => {
    const { ctx } = fakeCluster();
    await revokeK8sJitAccess(ctx, spec());
    await grantK8sJitAccess(ctx, spec());
    await revokeK8sJitAccess(ctx, spec());
    await revokeK8sJitAccess(ctx, spec());
    expect(await checkK8sJitAccess(ctx, spec())).toBe("absent");
  });

  it("uses a ClusterRoleBinding for the cluster scope and refuses a namespaced Role there", () => {
    const body = buildJitBinding(spec({ scopeId: CLUSTER_SCOPE }));
    expect(body["kind"]).toBe("ClusterRoleBinding");
    expect(() =>
      buildJitBinding(spec({ scopeId: CLUSTER_SCOPE, roleId: "Role:deployer" })),
    ).toThrow();
  });
});
