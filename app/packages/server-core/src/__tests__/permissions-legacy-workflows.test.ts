import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, hasPermission, intersectPermissions } from "../permissions/catalog";
import {
  WORKFLOW_PERMISSION_CUTOVER,
  grandfatherWorkflowPermissions,
  grandfatherWorkflowPermissionsIfLegacy,
} from "../permissions/legacy-workflows";

const BEFORE = new Date(WORKFLOW_PERMISSION_CUTOVER.getTime() - 1);
const AFTER = new Date(WORKFLOW_PERMISSION_CUTOVER.getTime() + 1);

describe("workflow permissions are in the catalog", () => {
  it("has read, write and approve", () => {
    expect(ALL_PERMISSIONS).toContain("workflows:read");
    expect(ALL_PERMISSIONS).toContain("workflows:write");
    expect(ALL_PERMISSIONS).toContain("workflows:approve");
  });
});

describe("grandfatherWorkflowPermissions", () => {
  it("maps dashboards:read onto workflows:read only", () => {
    const out = grandfatherWorkflowPermissions(["dashboards:read"]);
    expect(out).toContain("workflows:read");
    expect(out).not.toContain("workflows:write");
    expect(out).not.toContain("workflows:approve");
  });

  it("maps dashboards:write onto the full workflow family", () => {
    // Every one of these was reachable with `dashboards:write` before the
    // split — approve/deny included, which is why approve is on this list.
    const out = grandfatherWorkflowPermissions(["dashboards:write"]);
    expect(out).toContain("workflows:read");
    expect(out).toContain("workflows:write");
    expect(out).toContain("workflows:approve");
  });

  it("keeps the dashboard grants — it expands, it does not rename", () => {
    const out = grandfatherWorkflowPermissions(["dashboards:read", "dashboards:write"]);
    expect(out).toContain("dashboards:read");
    expect(out).toContain("dashboards:write");
  });

  it("leaves unrelated grants alone and adds nothing without a dashboard grant", () => {
    expect(grandfatherWorkflowPermissions(["resources:read", "costs:read"])).toEqual([
      "resources:read",
      "costs:read",
    ]);
  });

  it("does not duplicate an already-granted workflow permission", () => {
    const out = grandfatherWorkflowPermissions(["dashboards:write", "workflows:write"]);
    expect(out.filter((p) => p === "workflows:write")).toHaveLength(1);
  });

  it("needs no help for wildcards — they expand against the catalog", () => {
    expect(intersectPermissions(["*"], ["dashboards:*"])).not.toContain("workflows:write");
    expect(intersectPermissions(["*"], ["workflows:*"])).toEqual([
      "workflows:read",
      "workflows:write",
      "workflows:approve",
    ]);
    expect(hasPermission(["*"], "workflows:approve")).toBe(true);
  });
});

describe("grandfatherWorkflowPermissionsIfLegacy", () => {
  it("expands grants written before the cutover", () => {
    expect(grandfatherWorkflowPermissionsIfLegacy(["dashboards:write"], BEFORE)).toContain(
      "workflows:write",
    );
  });

  it("leaves grants written after the cutover exactly as written", () => {
    expect(grandfatherWorkflowPermissionsIfLegacy(["dashboards:write"], AFTER)).toEqual([
      "dashboards:write",
    ]);
  });

  it("treats an unknown write time as post-cutover", () => {
    expect(grandfatherWorkflowPermissionsIfLegacy(["dashboards:write"], null)).toEqual([
      "dashboards:write",
    ]);
    expect(grandfatherWorkflowPermissionsIfLegacy(["dashboards:write"], undefined)).toEqual([
      "dashboards:write",
    ]);
  });

  it("copies rather than mutating the caller's array", () => {
    const granted = ["dashboards:write"];
    grandfatherWorkflowPermissionsIfLegacy(granted, BEFORE);
    expect(granted).toEqual(["dashboards:write"]);
  });
});
