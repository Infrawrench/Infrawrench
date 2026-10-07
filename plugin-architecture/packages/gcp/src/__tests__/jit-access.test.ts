import { describe, expect, it } from "vitest";
import type { JitGrantSpec } from "@infrawrench/plugin-base";

import {
  checkGcpJitAccess,
  expiryExpression,
  grantGcpJitAccess,
  revokeGcpJitAccess,
  type GcpJitContext,
} from "../jit-access.js";

interface Binding {
  role: string;
  members?: string[];
  condition?: { title?: string; expression?: string };
}

function fakeProject(initial: Binding[] = []) {
  let policy = { version: 1, etag: "e0", bindings: initial };
  let conflicts = 0;
  const writes: unknown[] = [];
  const ctx: GcpJitContext = {
    project: "proj",
    get: async () => ({}) as never,
    paginate: async () => [],
    async post<T>(url: string, body: unknown): Promise<T> {
      if (url.endsWith(":getIamPolicy")) return structuredClone(policy) as T;
      if (conflicts > 0) {
        conflicts--;
        throw Object.assign(new Error("GCP API 409: ABORTED"), { status: 409 });
      }
      const next = (body as { policy: typeof policy }).policy;
      writes.push(next);
      policy = { ...next, etag: `e${writes.length}` };
      return policy as T;
    },
  };
  return {
    ctx,
    writes,
    current: () => policy,
    conflictOnce: () => {
      conflicts = 1;
    },
  };
}

const spec = (over: Partial<JitGrantSpec> = {}): JitGrantSpec => ({
  grantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  scopeId: "proj",
  roleId: "roles/storage.admin",
  principal: { id: "user:dana@example.com", name: "Dana", kind: "user" },
  expiresAt: new Date("2026-10-07T12:00:00.000Z"),
  ...over,
});

describe("gcp just-in-time access", () => {
  it("writes a version 3 conditional binding that expires on its own", async () => {
    const p = fakeProject([{ role: "roles/storage.admin", members: ["user:dana@example.com"] }]);
    await grantGcpJitAccess(p.ctx, spec());
    const policy = p.current();
    expect(policy.version).toBe(3);
    const ours = policy.bindings.find((b) => b.condition?.title?.startsWith("iw-jit-"));
    expect(ours?.condition?.expression).toBe('request.time < timestamp("2026-10-07T12:00:00Z")');
    // The standing, unconditional binding is untouched.
    expect(policy.bindings.filter((b) => !b.condition)).toHaveLength(1);
  });

  it("is idempotent, and an extension rewrites the same binding", async () => {
    const p = fakeProject();
    await grantGcpJitAccess(p.ctx, spec());
    await grantGcpJitAccess(p.ctx, spec());
    expect(p.writes).toHaveLength(1);
    await grantGcpJitAccess(p.ctx, spec({ expiresAt: new Date("2026-10-07T14:00:00Z") }));
    expect(p.current().bindings).toHaveLength(1);
    expect(p.current().bindings[0]!.condition!.expression).toBe(
      expiryExpression(new Date("2026-10-07T14:00:00Z")),
    );
  });

  it("revokes only its own binding, and retries a concurrent write", async () => {
    const p = fakeProject([{ role: "roles/storage.admin", members: ["user:dana@example.com"] }]);
    await grantGcpJitAccess(p.ctx, spec());
    p.conflictOnce();
    await revokeGcpJitAccess(p.ctx, spec());
    expect(p.current().bindings).toEqual([
      { role: "roles/storage.admin", members: ["user:dana@example.com"] },
    ]);
    expect(await checkGcpJitAccess(p.ctx, spec())).toBe("absent");
    // A second revoke writes nothing.
    const writes = p.writes.length;
    await revokeGcpJitAccess(p.ctx, spec());
    expect(p.writes.length).toBe(writes);
  });

  it("refuses basic roles, which IAM Conditions cannot carry", async () => {
    const p = fakeProject();
    await expect(grantGcpJitAccess(p.ctx, spec({ roleId: "roles/editor" }))).rejects.toThrow(
      /basic role/,
    );
  });
});
