import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The permission gate a workflow run executes under.
 *
 * The bug this covers: the sandbox's host bridge can create resources, delete
 * them, run SSH commands and execute SQL, and the only check on any of it used
 * to be `workflows:write` — which the built-in Member role holds, while
 * `resources:delete` deliberately does not. A member could do through
 * `infra.…delete()` exactly what `delete_resource` refuses them, and a cron
 * trigger made it durable.
 *
 * `hasPermission` is the real implementation, not a mock: the point of these
 * tests is that a role's permission set produces the right verdict, and mocking
 * the matcher would assert only that the map was consulted.
 */

const resolveEffectivePermissions = vi.fn();
vi.mock("../permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => resolveEffectivePermissions(...a),
}));

vi.mock("../db/schema", () => ({
  workflows: { id: "id", createdByUserId: "created_by_user_id" },
}));

/** The `workflows` row `buildWorkflowAuthorizer` falls back to for author lookup. */
let workflowRow: Array<{ createdByUserId: string | null }> = [{ createdByUserId: "author-1" }];
const db = {
  select: () => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(workflowRow) }) }),
  }),
};
vi.mock("../db/client", () => ({ db }));

const { buildWorkflowAuthorizer, WORKFLOW_OPERATION_PERMISSIONS } =
  await import("../workflows/authorize");

/** The built-in Member role's grants, trimmed to what these tests exercise. */
const MEMBER = [
  "accounts:read",
  "resources:read",
  "resources:execute",
  "secrets:read",
  "storage:read",
  "workflows:read",
  "workflows:write",
  "workflows:approve",
];

function grant(permissions: string[]) {
  resolveEffectivePermissions.mockResolvedValue({ permissions, role: null });
}

describe("buildWorkflowAuthorizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowRow = [{ createdByUserId: "author-1" }];
  });

  it("refuses the operations a member's role does not grant", async () => {
    grant(MEMBER);
    const authorize = await buildWorkflowAuthorizer("org-1", "wf-1", { userId: "u1" });

    // The escalation itself: a member holds workflows:write but not
    // resources:write / resources:delete / storage:write.
    expect(() => authorize("resource.delete")).toThrow(/resources:delete/);
    expect(() => authorize("resource.create")).toThrow(/resources:write/);
    expect(() => authorize("resource.update")).toThrow(/resources:write/);
    expect(() => authorize("resource.applyManifest")).toThrow(/resources:write/);
    expect(() => authorize("sftp.put")).toThrow(/storage:write/);
    expect(() => authorize("costs.write")).toThrow(/costs:write/);
  });

  it("allows what the same role does grant", async () => {
    grant(MEMBER);
    const authorize = await buildWorkflowAuthorizer("org-1", "wf-1", { userId: "u1" });

    expect(() => authorize("resource.list")).not.toThrow();
    expect(() => authorize("resource.resolveOutput")).not.toThrow();
    expect(() => authorize("ssh.exec")).not.toThrow();
    expect(() => authorize("resource.query")).not.toThrow();
    expect(() => authorize("sftp.get")).not.toThrow();
  });

  it("lets an owner through everything", async () => {
    grant(["*"]);
    const authorize = await buildWorkflowAuthorizer("org-1", "wf-1", { userId: "u1" });
    for (const method of Object.keys(WORKFLOW_OPERATION_PERMISSIONS)) {
      expect(() => authorize(method), method).not.toThrow();
    }
  });

  it("never gates the operations that only touch the run itself", async () => {
    // A member with no grants at all must still be able to log, emit output,
    // read and write its own metrics, and raise a page — otherwise the gate
    // would break every workflow rather than the privileged ones.
    grant([]);
    const authorize = await buildWorkflowAuthorizer("org-1", "wf-1", { userId: "u1" });
    for (const method of ["log", "output", "metric.get", "metric.set", "line", "fetch", "page"]) {
      expect(() => authorize(method), method).not.toThrow();
    }
  });

  it("falls back to the workflow's author when no user triggered the run", async () => {
    grant(["*"]);
    await buildWorkflowAuthorizer("org-1", "wf-1");
    expect(resolveEffectivePermissions).toHaveBeenCalledWith("org-1", {
      kind: "user",
      userId: "author-1",
    });
  });

  it("prefers an explicit runAs user over the author", async () => {
    grant(["*"]);
    await buildWorkflowAuthorizer("org-1", "wf-1", { userId: "presser-9" });
    expect(resolveEffectivePermissions).toHaveBeenCalledWith("org-1", {
      kind: "user",
      userId: "presser-9",
    });
  });

  it("grants nothing when the author is gone", async () => {
    // A workflow whose author left the org must not keep running with their
    // access. Denying is loud (the run fails on the first privileged call)
    // rather than silent, which is the point.
    workflowRow = [{ createdByUserId: null }];
    const authorize = await buildWorkflowAuthorizer("org-1", "wf-1");
    expect(resolveEffectivePermissions).not.toHaveBeenCalled();
    expect(() => authorize("resource.list")).toThrow(/resources:read/);
    expect(() => authorize("log")).not.toThrow();
  });

  it("denies an operation missing from the policy map", async () => {
    grant(["*"]);
    const authorize = await buildWorkflowAuthorizer("org-1", "wf-1", { userId: "u1" });
    // Fail closed: a new `case` in dispatch that nobody mapped must not ship
    // as an ungated capability, even for an owner.
    expect(() => authorize("resource.somethingNew")).toThrow(/no entry in the workflow permission/);
  });
});

describe("WORKFLOW_OPERATION_PERMISSIONS", () => {
  it("covers every operation dispatch can route", async () => {
    // Guards the fail-closed branch above from becoming a production surprise:
    // if someone adds a `case` to dispatch without a policy entry, this fails
    // in CI rather than at 3am inside a customer's cron run.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../../workflow-runtime/src/host.ts", import.meta.url),
      "utf8",
    );
    const dispatchBody = source.slice(source.indexOf("export async function dispatch"));
    const methods = [...dispatchBody.matchAll(/^ {4}case "([^"]+)":/gm)].map((m) => m[1]!);

    expect(methods.length).toBeGreaterThan(40);
    const unmapped = methods.filter((m) => !(m in WORKFLOW_OPERATION_PERMISSIONS));
    expect(unmapped).toEqual([]);
  });
});
