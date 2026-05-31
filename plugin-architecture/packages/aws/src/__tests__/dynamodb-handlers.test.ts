import { describe, it, expect, vi, beforeEach } from "vitest";

const jsonCall = vi.fn();
vi.mock("../client-transport.js", () => ({ jsonCall: (...a: unknown[]) => jsonCall(...a) }));

import { executeDynamoDbCommand } from "../dynamodb-handlers.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

const describeWithSk = {
  Table: {
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    ItemCount: 7,
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
  },
};

beforeEach(() => jsonCall.mockReset());

describe("executeDynamoDbCommand", () => {
  it("throws without a table name", async () => {
    await expect(executeDynamoDbCommand(creds, "", "listCollections", [])).rejects.toThrow(
      /no table name/,
    );
  });

  it("listCollections returns the single table", async () => {
    expect(await executeDynamoDbCommand(creds, "T", "listCollections", [])).toEqual({
      collections: ["T"],
    });
  });

  it("countDocuments returns DescribeTable item count", async () => {
    jsonCall.mockResolvedValue(describeWithSk);
    expect(await executeDynamoDbCommand(creds, "T", "countDocuments", [])).toEqual({ count: 7 });
  });

  it("find scans, slices, encodes composite key into _name, reports hasMore", async () => {
    jsonCall.mockImplementation(async (_c, _s, target) => {
      if (String(target).endsWith("DescribeTable")) return describeWithSk;
      return {
        Items: [
          { pk: { S: "a" }, sk: { S: "1" }, n: { N: "3" }, b: { BOOL: true } },
          { pk: { S: "a" }, sk: { S: "2" } },
          { pk: { S: "a" }, sk: { S: "3" } },
        ],
        LastEvaluatedKey: { pk: { S: "a" } },
      };
    });
    const out = (await executeDynamoDbCommand(creds, "T", "find", ["T", 0, 2])) as {
      documents: Array<Record<string, unknown>>;
      hasMore: boolean;
    };
    expect(out.documents.length).toBe(2);
    expect(out.documents[0]!["_name"]).toBe("a::1");
    expect(out.documents[0]!["n"]).toBe(3);
    expect(out.documents[0]!["b"]).toBe(true);
    expect(out.hasMore).toBe(true);
  });

  it("getDocument decodes the key and returns the item, or null", async () => {
    jsonCall.mockImplementation(async (_c, _s, target) => {
      if (String(target).endsWith("DescribeTable")) return describeWithSk;
      if (String(target).endsWith("GetItem"))
        return { Item: { pk: { S: "a" }, sk: { S: "1" }, list: { L: [{ N: "1" }] } } };
      return {};
    });
    const out = (await executeDynamoDbCommand(creds, "T", "getDocument", ["a::1"])) as Record<
      string,
      unknown
    >;
    expect(out["list"]).toEqual([1]);
    const getItemBody = jsonCall.mock.calls.find((c) => String(c[2]).endsWith("GetItem"))![3] as {
      Key: Record<string, unknown>;
    };
    expect(getItemBody.Key).toEqual({ pk: { S: "a" }, sk: { S: "1" } });
  });

  it("getDocument returns null when item absent", async () => {
    jsonCall.mockImplementation(async (_c, _s, target) => {
      if (String(target).endsWith("DescribeTable")) return describeWithSk;
      return {};
    });
    expect(await executeDynamoDbCommand(creds, "T", "getDocument", ["a::1"])).toBeNull();
  });

  it("insertDocument PutItems and strips _name", async () => {
    jsonCall.mockResolvedValue({});
    const out = await executeDynamoDbCommand(creds, "T", "insertDocument", [
      "T",
      JSON.stringify({ _name: "x", pk: "a", n: 2 }),
    ]);
    expect(out).toEqual({ ok: true });
    const body = jsonCall.mock.calls[0]![3] as { Item: Record<string, unknown> };
    expect(body.Item["_name"]).toBeUndefined();
    expect(body.Item["pk"]).toEqual({ S: "a" });
    expect(body.Item["n"]).toEqual({ N: "2" });
  });

  it("insertDocument rejects invalid JSON", async () => {
    await expect(
      executeDynamoDbCommand(creds, "T", "insertDocument", ["T", "not json"]),
    ).rejects.toThrow(/Invalid JSON/);
  });

  it("insertDocument rejects non-object", async () => {
    await expect(
      executeDynamoDbCommand(creds, "T", "insertDocument", ["T", "[1,2]"]),
    ).rejects.toThrow(/JSON object/);
  });

  it("deleteDocument deletes by key (single-key table)", async () => {
    jsonCall.mockImplementation(async (_c, _s, target) => {
      if (String(target).endsWith("DescribeTable")) {
        return { Table: { KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], ItemCount: 0 } };
      }
      return {};
    });
    expect(await executeDynamoDbCommand(creds, "T", "deleteDocument", ["onlykey"])).toEqual({
      ok: true,
    });
    const del = jsonCall.mock.calls.find((c) => String(c[2]).endsWith("DeleteItem"))![3] as {
      Key: Record<string, unknown>;
    };
    expect(del.Key).toEqual({ pk: { S: "onlykey" } });
  });

  it("deleteCollection refuses", async () => {
    await expect(executeDynamoDbCommand(creds, "T", "deleteCollection", [])).rejects.toThrow(
      /Cannot drop/,
    );
  });

  it("createIndex builds a GSI with INCLUDE projection", async () => {
    jsonCall.mockImplementation(async (_c, _s, target) => {
      if (String(target).endsWith("DescribeTable")) {
        return { Table: { AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }] } };
      }
      return {};
    });
    const values = JSON.stringify({
      indexName: "GSI1",
      partitionKey: "gpk",
      partitionKeyType: "S",
      sortKey: "gsk",
      sortKeyType: "N",
      projection: "INCLUDE",
      projectionInclude: "a, b",
    });
    const out = await executeDynamoDbCommand(creds, "T", "createIndex", [values]);
    expect(out).toEqual({ ok: true });
    const update = jsonCall.mock.calls.find((c) => String(c[2]).endsWith("UpdateTable"))![3] as {
      GlobalSecondaryIndexUpdates: Array<{ Create: { Projection: Record<string, unknown> } }>;
      AttributeDefinitions: Array<{ AttributeName: string }>;
    };
    expect(update.GlobalSecondaryIndexUpdates[0]!.Create.Projection["NonKeyAttributes"]).toEqual([
      "a",
      "b",
    ]);
    expect(update.AttributeDefinitions.map((a) => a.AttributeName)).toContain("gsk");
  });

  it("createIndex validates required fields", async () => {
    await expect(
      executeDynamoDbCommand(creds, "T", "createIndex", [JSON.stringify({})]),
    ).rejects.toThrow(/Index name is required/);
    await expect(
      executeDynamoDbCommand(creds, "T", "createIndex", [JSON.stringify({ indexName: "x" })]),
    ).rejects.toThrow(/Partition key/);
  });

  it("createIndex INCLUDE requires attributes", async () => {
    jsonCall.mockResolvedValue({ Table: {} });
    await expect(
      executeDynamoDbCommand(creds, "T", "createIndex", [
        JSON.stringify({ indexName: "x", partitionKey: "p", projection: "INCLUDE" }),
      ]),
    ).rejects.toThrow(/INCLUDE projection requires/);
  });

  it("deleteIndex requires name and issues UpdateTable delete", async () => {
    jsonCall.mockResolvedValue({});
    await expect(
      executeDynamoDbCommand(creds, "T", "deleteIndex", [JSON.stringify({})]),
    ).rejects.toThrow(/Index name is required/);
    const out = await executeDynamoDbCommand(creds, "T", "deleteIndex", [
      JSON.stringify({ indexName: "GSI1" }),
    ]);
    expect(out).toEqual({ ok: true });
  });

  it("rejects unknown command", async () => {
    await expect(executeDynamoDbCommand(creds, "T", "bogus", [])).rejects.toThrow(
      /Unknown DynamoDB/,
    );
  });

  it("describeTable throws when no partition key", async () => {
    jsonCall.mockResolvedValue({ Table: { KeySchema: [] } });
    await expect(executeDynamoDbCommand(creds, "T", "countDocuments", [])).rejects.toThrow(
      /no partition key/,
    );
  });
});
