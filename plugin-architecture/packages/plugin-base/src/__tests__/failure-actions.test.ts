import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_STOP_FAILURE_ACTION,
  failureActionsForType,
  isLifecycleFailureAction,
} from "../failure-actions.js";
import { clientContractProblems } from "../define-plugin.js";
import { resourceTypeDefinitionSchema, validate } from "../validation/index.js";
import type { PluginManifest } from "../manifest.js";
import type { ResourceTypeDefinition } from "../resource.js";

const lifecycle = { startActionId: "start", stopActionId: "stop" };
const scale = { id: "scale-to-zero", label: "Scale to zero", undoLabel: "Scale back" };

describe("failureActionsForType", () => {
  it("derives stop from a lifecycle pair", () => {
    expect(failureActionsForType({ lifecycle })).toEqual([LIFECYCLE_STOP_FAILURE_ACTION]);
    expect(isLifecycleFailureAction({ lifecycle }, "stop")).toBe(true);
  });

  it("lists declared actions after the derived stop", () => {
    expect(failureActionsForType({ lifecycle, failureActions: [scale] }).map((a) => a.id)).toEqual([
      "stop",
      "scale-to-zero",
    ]);
  });

  it("lets a declared stop replace the derived one", () => {
    const own = { id: "stop", label: "Power off", undoLabel: "Power on" };
    expect(failureActionsForType({ lifecycle, failureActions: [own] })).toEqual([own]);
    expect(isLifecycleFailureAction({ lifecycle, failureActions: [own] }, "stop")).toBe(false);
  });

  it("offers nothing for a type with neither", () => {
    expect(failureActionsForType({})).toEqual([]);
    expect(isLifecycleFailureAction({}, "stop")).toBe(false);
  });
});

describe("failureActions validation", () => {
  const base = {
    id: "t",
    displayName: "T",
    pluralDisplayName: "Ts",
    description: "d",
    fields: [],
    outputs: [],
    dashboardPinnable: false,
  };

  it("keeps the declaration through validation", () => {
    const result = validate(resourceTypeDefinitionSchema, { ...base, failureActions: [scale] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ failureActions: [scale] });
  });

  it("refuses duplicate ids and an empty list", () => {
    expect(
      validate(resourceTypeDefinitionSchema, { ...base, failureActions: [scale, scale] }).success,
    ).toBe(false);
    expect(validate(resourceTypeDefinitionSchema, { ...base, failureActions: [] }).success).toBe(
      false,
    );
  });
});

describe("failureActions contract", () => {
  it("obliges the three client methods", () => {
    const type: ResourceTypeDefinition = {
      id: "t",
      displayName: "T",
      pluralDisplayName: "Ts",
      description: "d",
      fields: [],
      outputs: [],
      dashboardPinnable: false,
      failureActions: [scale],
    };
    const plugin = {
      manifest: { id: "p" } as PluginManifest,
      resourceTypes: [type],
    };
    expect(clientContractProblems(plugin, {})).toEqual([
      "t.failureActions is set but the client has no prepareFailure()",
      "t.failureActions is set but the client has no injectFailure()",
      "t.failureActions is set but the client has no undoFailure()",
    ]);
    const fn = () => undefined;
    expect(
      clientContractProblems(plugin, {
        prepareFailure: fn,
        injectFailure: fn,
        undoFailure: fn,
      }),
    ).toEqual([]);
  });
});
