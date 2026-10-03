import { describe, expect, it } from "vitest";
import { toolInputPreview } from "../chat/tool-input-preview";

describe("toolInputPreview", () => {
  it("lifts multi-line strings out so code reads verbatim", () => {
    const source = "const a = 1;\ninfra.log(a);";
    expect(toolInputPreview({ workflowId: "w1", source, enabled: true })).toEqual({
      fields: { workflowId: "w1", enabled: true },
      blocks: [{ key: "source", text: source }],
    });
  });

  it("leaves single-line strings and nested values in the JSON", () => {
    const input = { exec: "xterm -e top", trigger: { kind: "cron", cron: "0 * * * *" } };
    expect(toolInputPreview(input)).toEqual({ fields: input, blocks: [] });
  });
});
