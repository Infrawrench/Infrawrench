import { describe, expect, it } from "vitest";
import { f, o, rt } from "../resource-builders.js";

describe("resource builders", () => {
  it("expands compact fields, outputs, and resource types", () => {
    expect(f("name", "Name")).toEqual({
      key: "name",
      label: "Name",
      kind: "string",
      required: true,
    });
    expect(f("status", "Status", { required: false })).toMatchObject({ required: false });
    expect(o("password", "Password", { sensitive: true })).toMatchObject({ sensitive: true });

    expect(
      rt({
        id: "thing",
        name: "Thing",
        description: "A thing",
      }),
    ).toEqual({
      id: "thing",
      displayName: "Thing",
      pluralDisplayName: "Things",
      description: "A thing",
      fields: [],
      outputs: [],
      dashboardPinnable: true,
    });
  });
});
