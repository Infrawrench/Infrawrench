import { describe, expect, it } from "vitest";
import { schemaNodeSchema, validate } from "../validation/index.js";

describe("schemaNodeSchema table node", () => {
  it("accepts a table with string and action cells", () => {
    const r = validate(schemaNodeSchema, {
      kind: "table",
      columns: [
        { key: "name", label: "Name", width: "wide", mono: true },
        { key: "act", label: "" },
      ],
      rows: [
        {
          cells: {
            name: "widgets",
            act: {
              kind: "action",
              label: "Delete",
              action: { type: "refresh-resource" },
              variant: "danger",
            },
          },
          depth: 1,
        },
      ],
      emphasizeFirstColumn: true,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a table whose columns are malformed", () => {
    const r = validate(schemaNodeSchema, {
      kind: "table",
      columns: [{ label: "no key" }],
      rows: [],
    });
    expect(r.success).toBe(false);
  });
});
