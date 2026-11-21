import { describe, expect, it } from "vitest";
import {
  buildTargetFields,
  equivalenceCategories,
  equivalenceRuleForCategory,
  readResourceSizing,
  resolveEquivalence,
  sizingFieldKeys,
} from "../equivalence.js";
import { f, rt } from "../resource-builders.js";
import { resourceTypeDefinitionSchema } from "../validation/resource.schema.js";
import { validate } from "../validation/validate.js";

const vm = rt({
  name: "Server",
  id: "server",
  description: "A server",
  equivalence: "vm",
  fields: [
    f("name", "Name"),
    f("size", "Size", { sizing: "instance-type" }),
    f("location", "Location", { sizing: "region" }),
    f("diskGb", "Disk", { kind: "number", sizing: "disk-gb" }),
  ],
});

const database = rt({
  name: "Database",
  id: "database",
  description: "A managed database",
  equivalence: [
    {
      category: "managed-postgres",
      when: { fieldKey: "engine", oneOf: ["pg", "postgres"] },
      createFields: { engine: "pg" },
    },
    {
      category: "managed-mysql",
      when: { fieldKey: "engine", prefix: "mysql" },
      createFields: { engine: "mysql" },
    },
  ],
  fields: [
    f("engine", "Engine"),
    f("size", "Size", { sizing: "instance-type" }),
    f("region", "Region", { sizing: "region" }),
    f("memoryMb", "Memory", { kind: "number", sizing: "memory-mb" }),
    f("nodes", "Nodes", { kind: "number", sizing: "node-count" }),
  ],
});

describe("equivalence", () => {
  it("reads a single category as one unconditional rule", () => {
    expect(resolveEquivalence(vm, {})).toEqual({ category: "vm" });
    expect(equivalenceCategories(vm)).toEqual(["vm"]);
  });

  it("picks the first rule whose condition matches the stored fields", () => {
    expect(resolveEquivalence(database, { engine: "PG" })?.category).toBe("managed-postgres");
    expect(resolveEquivalence(database, { engine: "mysql8" })?.category).toBe("managed-mysql");
    expect(resolveEquivalence(database, { engine: "redis" })).toBeNull();
    expect(resolveEquivalence(database, {})).toBeNull();
  });

  it("offers a target rule per category regardless of its condition", () => {
    expect(equivalenceRuleForCategory(database, "managed-mysql")?.createFields).toEqual({
      engine: "mysql",
    });
    expect(equivalenceRuleForCategory(database, "vm")).toBeNull();
  });

  it("reads sizing through the flagged fields and leaves unknowns out", () => {
    expect(sizingFieldKeys(vm)).toEqual({
      "instance-type": "size",
      region: "location",
      "disk-gb": "diskGb",
    });
    expect(readResourceSizing(vm, { size: "cx22", location: "fsn1", diskGb: "40" })).toEqual({
      instanceType: "cx22",
      region: "fsn1",
      diskGb: 40,
    });
    expect(readResourceSizing(vm, { size: "", diskGb: "lots" })).toEqual({});
    expect(readResourceSizing(database, { memoryMb: 4096, nodes: 3 })).toEqual({
      memoryGb: 4,
      nodeCount: 3,
    });
  });

  it("writes target fields into the same-flagged keys, then the rule's create fields", () => {
    const rule = equivalenceRuleForCategory(database, "managed-postgres");
    expect(
      buildTargetFields(database, rule, {
        instanceType: "db-s-2vcpu-4gb",
        region: "nyc3",
        memoryGb: 2,
        nodeCount: 2,
        diskGb: 100,
      }),
    ).toEqual({
      size: "db-s-2vcpu-4gb",
      region: "nyc3",
      memoryMb: "2048",
      nodes: "2",
      engine: "pg",
    });
  });

  it("validates the declarations", () => {
    expect(validate(resourceTypeDefinitionSchema, vm).success).toBe(true);
    expect(validate(resourceTypeDefinitionSchema, database).success).toBe(true);
    const duplicate = {
      ...vm,
      fields: [...vm.fields, f("type", "Type", { sizing: "instance-type" })],
    };
    expect(validate(resourceTypeDefinitionSchema, duplicate).success).toBe(false);
    const secret = { ...vm, fields: [f("key", "Key", { kind: "secret", sizing: "region" })] };
    expect(validate(resourceTypeDefinitionSchema, secret).success).toBe(false);
    const emptyCondition = {
      ...database,
      equivalence: [{ category: "vm", when: { fieldKey: "engine" } }],
    };
    expect(validate(resourceTypeDefinitionSchema, emptyCondition).success).toBe(false);
  });
});
