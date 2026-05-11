import { describe, expect, it } from "vitest";
import {
  MAX_PARAMS,
  MAX_SQL_BYTES,
  classifyMutation,
  firstKeyword,
  validateParams,
  validateSql,
} from "../db-guard";

describe("validateSql", () => {
  it("accepts a simple single SELECT", () => {
    expect(() => validateSql("SELECT id FROM accounts WHERE id = ? LIMIT 1")).not.toThrow();
  });

  it("accepts a single SELECT with a trailing semicolon and whitespace", () => {
    expect(() => validateSql("SELECT 1;   \n  ")).not.toThrow();
    expect(() => validateSql("SELECT 1; -- trailing comment\n")).not.toThrow();
    expect(() => validateSql("SELECT 1;/* trailing */")).not.toThrow();
  });

  it("rejects two stacked statements", () => {
    expect(() => validateSql("SELECT 1; DROP TABLE accounts")).toThrow(/multi-statement/);
  });

  it("allows a semicolon inside a single-quoted literal", () => {
    expect(() => validateSql("SELECT 'a;b' AS x")).not.toThrow();
  });

  it("handles SQLite-style escaped quotes inside a literal", () => {
    expect(() => validateSql("SELECT 'O''Brien;cohort' AS x")).not.toThrow();
  });

  it("allows a semicolon inside a double-quoted identifier", () => {
    expect(() => validateSql('SELECT "weird;col" FROM accounts')).not.toThrow();
  });

  it("allows a semicolon inside a backticked identifier", () => {
    expect(() => validateSql("SELECT `weird;col` FROM accounts")).not.toThrow();
  });

  it("allows comments before the keyword", () => {
    expect(() => validateSql("-- foo\nSELECT 1")).not.toThrow();
    expect(() => validateSql("/* block */ SELECT 1")).not.toThrow();
  });

  it("does NOT treat a semicolon inside a line comment as a separator", () => {
    expect(() => validateSql("SELECT 1 -- ;DROP TABLE accounts\n")).not.toThrow();
  });

  it("rejects ATTACH", () => {
    expect(() => validateSql("ATTACH DATABASE 'evil.db' AS evil")).toThrow(/not allowed/);
  });

  it("rejects DETACH", () => {
    expect(() => validateSql("DETACH DATABASE evil")).toThrow(/not allowed/);
  });

  it("rejects PRAGMA", () => {
    expect(() => validateSql("PRAGMA journal_mode")).toThrow(/not allowed/);
  });

  it("rejects VACUUM", () => {
    expect(() => validateSql("VACUUM")).toThrow(/not allowed/);
  });

  it("rejects PRAGMA even when preceded by a comment", () => {
    expect(() => validateSql("-- hi\nPRAGMA foreign_keys = OFF")).toThrow(/not allowed/);
  });

  it("rejects oversized SQL", () => {
    const big = "SELECT '" + "x".repeat(MAX_SQL_BYTES) + "'";
    expect(() => validateSql(big)).toThrow(/byte cap/);
  });

  it("rejects empty SQL", () => {
    expect(() => validateSql("")).toThrow(/empty/);
  });

  it("accepts a parameterized INSERT", () => {
    expect(() => validateSql("INSERT INTO accounts (id, plugin_id) VALUES ($1, $2)")).not.toThrow();
  });

  it("accepts INSERT OR REPLACE", () => {
    expect(() =>
      validateSql("INSERT OR REPLACE INTO cloud_sync_state (key, value) VALUES ($1, $2)"),
    ).not.toThrow();
  });
});

describe("firstKeyword", () => {
  it("returns the leading keyword uppercased", () => {
    expect(firstKeyword("select 1")).toBe("SELECT");
    expect(firstKeyword("  /* x */ insert into t")).toBe("INSERT");
  });

  it("returns null for whitespace-only input", () => {
    expect(firstKeyword("   ")).toBeNull();
  });
});

describe("validateParams", () => {
  it("accepts an empty/undefined params list", () => {
    expect(validateParams(undefined)).toEqual([]);
    expect(validateParams([])).toEqual([]);
  });

  it("accepts strings, numbers, booleans, null, and Uint8Array", () => {
    const buf = new Uint8Array([1, 2, 3]);
    expect(() => validateParams(["a", 1, true, null, buf])).not.toThrow();
  });

  it("accepts Node Buffer (which is a Uint8Array)", () => {
    expect(() => validateParams([Buffer.from("hi")])).not.toThrow();
  });

  it("rejects plain objects", () => {
    expect(() => validateParams([{ x: 1 }])).toThrow(/unsupported type/);
  });

  it("rejects functions", () => {
    expect(() => validateParams([() => 1])).toThrow(/unsupported type/);
  });

  it("rejects symbols", () => {
    expect(() => validateParams([Symbol("x")])).toThrow(/unsupported type/);
  });

  it("rejects oversized params arrays", () => {
    const arr = new Array(MAX_PARAMS + 1).fill("x");
    expect(() => validateParams(arr)).toThrow(/exceeds/);
  });
});

describe("classifyMutation", () => {
  it("returns null for SELECT", () => {
    expect(classifyMutation("SELECT * FROM accounts")).toBeNull();
  });

  it("classifies INSERT into accounts", () => {
    expect(classifyMutation("INSERT INTO accounts (id) VALUES ($1)")).toEqual({
      op: "INSERT",
      table: "accounts",
    });
  });

  it("classifies INSERT OR REPLACE into cloud_sync_state", () => {
    expect(
      classifyMutation("INSERT OR REPLACE INTO cloud_sync_state (key, value) VALUES ($1, $2)"),
    ).toEqual({
      op: "INSERT",
      table: "cloud_sync_state",
    });
  });

  it("classifies DELETE from ssh_keys", () => {
    expect(classifyMutation("DELETE FROM ssh_keys WHERE id = $1")).toEqual({
      op: "DELETE",
      table: "ssh_keys",
    });
  });

  it("classifies UPDATE on accounts", () => {
    expect(classifyMutation("UPDATE accounts SET display_name = $1 WHERE id = $2")).toEqual({
      op: "UPDATE",
      table: "accounts",
    });
  });

  it("returns null for mutations on non-audit tables", () => {
    expect(classifyMutation("DELETE FROM dashboard_pins WHERE dashboard_id = $1")).toBeNull();
    expect(classifyMutation("UPDATE resources SET outputs_json = $1 WHERE id = $2")).toBeNull();
  });
});
