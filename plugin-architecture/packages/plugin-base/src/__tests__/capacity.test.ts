import { describe, expect, it } from "vitest";
import {
  capacityDeclarations,
  readCapacityNumber,
  resolveCapacityLimit,
  typeHasCapacity,
} from "../capacity.js";
import { resourceTypeDefinitionSchema, validate } from "../validation/index.js";

const validateResourceTypes = (_plugin: string, types: unknown[]) => {
  for (const type of types) {
    const result = validate(resourceTypeDefinitionSchema, type);
    if (!result.success) throw new Error(result.issues.join("; "));
  }
};

describe("readCapacityNumber", () => {
  it("reads numbers and numeric strings, and nothing else", () => {
    expect(readCapacityNumber(12)).toBe(12);
    expect(readCapacityNumber(" 42.5 ")).toBe(42.5);
    expect(readCapacityNumber("")).toBeNull();
    expect(readCapacityNumber("unlimited")).toBeNull();
    expect(readCapacityNumber(null)).toBeNull();
    expect(readCapacityNumber(Number.NaN)).toBeNull();
  });
});

describe("resolveCapacityLimit", () => {
  const values = { size: "10", plan: "Launch", other: 0 };

  it("reads a field limit as the provider's number, scaled into the usage's unit", () => {
    expect(resolveCapacityLimit({ field: "size", scale: 1024 }, values)).toEqual({
      limit: 10_240,
      source: "provider",
      plan: null,
    });
  });

  it("refuses a missing or non-positive field limit rather than guessing", () => {
    expect(resolveCapacityLimit({ field: "missing" }, values)).toBeNull();
    expect(resolveCapacityLimit({ field: "other" }, values)).toBeNull();
  });

  it("looks a plan up case-insensitively and yields nothing for an unlisted plan", () => {
    const allowances = { launch: 300, scale: 750 };
    expect(resolveCapacityLimit({ plan: { field: "plan", allowances } }, values)).toEqual({
      limit: 300,
      source: "plan",
      plan: "Launch",
    });
    expect(
      resolveCapacityLimit({ plan: { field: "plan", allowances: { scale: 750 } } }, values),
    ).toBeNull();
  });

  it("passes a positive constant through", () => {
    expect(resolveCapacityLimit({ constant: 100 }, values)).toEqual({
      limit: 100,
      source: "constant",
      plan: null,
    });
  });
});

describe("capacityDeclarations", () => {
  const type = {
    fields: [
      { key: "name", label: "Name" },
      { key: "storageBytes", label: "Storage", usage: { limit: { field: "maxBytes" } } },
    ],
    outputs: [
      { key: "conn", label: "Connections", sensitive: false, usage: { limit: { constant: 100 } } },
      { key: "secret", label: "Secret", sensitive: true, usage: { limit: { constant: 1 } } },
    ],
    capacityMetrics: [{ seriesLabel: "Disk used %", limit: { constant: 100 }, label: "Disk" }],
  };

  it("lists fields, then non-sensitive outputs, then metrics, under stable keys", () => {
    expect(capacityDeclarations(type).map((d) => [d.key, d.source, d.label])).toEqual([
      ["storageBytes", "field", "Storage"],
      ["conn", "output", "Connections"],
      ["metric:Disk used %", "metric", "Disk"],
    ]);
    expect(typeHasCapacity(type)).toBe(true);
    expect(typeHasCapacity({ fields: [], outputs: [] })).toBe(false);
  });
});

describe("usage validation", () => {
  const base = {
    id: "db",
    displayName: "Database",
    pluralDisplayName: "Databases",
    description: "A database",
    dashboardPinnable: false,
    outputs: [],
  };

  it("accepts the three limit shapes and a monthly cycle", () => {
    expect(() =>
      validateResourceTypes("test", [
        {
          ...base,
          fields: [
            {
              key: "used",
              label: "Used",
              kind: "number",
              required: false,
              usage: { limit: { field: "max", scale: 2 }, unit: "bytes" },
            },
            {
              key: "hours",
              label: "Hours",
              kind: "number",
              required: false,
              usage: {
                limit: { plan: { field: "plan", allowances: { free: 191.9 } } },
                cycle: { period: "monthly", anchorDay: 1 },
              },
            },
            {
              key: "pct",
              label: "Pct",
              kind: "number",
              required: false,
              usage: { limit: { constant: 100 } },
            },
          ],
        },
      ]),
    ).not.toThrow();
  });

  it("rejects an empty plan table and a usage on a secret", () => {
    expect(() =>
      validateResourceTypes("test", [
        {
          ...base,
          fields: [
            {
              key: "hours",
              label: "Hours",
              kind: "number",
              required: false,
              usage: { limit: { plan: { field: "plan", allowances: {} } } },
            },
          ],
        },
      ]),
    ).toThrow();
    expect(() =>
      validateResourceTypes("test", [
        {
          ...base,
          fields: [
            {
              key: "token",
              label: "Token",
              kind: "secret",
              required: false,
              usage: { limit: { constant: 1 } },
            },
          ],
        },
      ]),
    ).toThrow();
  });
});
