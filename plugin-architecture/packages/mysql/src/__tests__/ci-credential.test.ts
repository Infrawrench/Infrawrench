import { describe, expect, it } from "vitest";
import type { CiLentValue } from "@infrawrench/plugin-base";

import { lendMysql, optionValue } from "../ci-credential.js";

const text = (value: CiLentValue) =>
  typeof value === "string" ? value : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
const secrets = (value: CiLentValue) =>
  typeof value === "string" ? [value] : value.flatMap((p) => ("secret" in p ? [p.secret] : []));

/**
 * What MySQL's option file reader (`mysys/my_default.cc`) makes of a value:
 * a matching quote at both ends dropped, then `\\` and the other escapes
 * turned into characters. Only the escapes this module could produce.
 */
function readBack(value: string): string {
  let v = value;
  if ((v[0] === '"' || v[0] === "'") && v.length > 1 && v[0] === v[v.length - 1]) {
    v = v.slice(1, -1);
  }
  return v.replace(/\\\\/g, "\\");
}

describe("lendMysql", () => {
  it("writes an option group the suffix selects, the password masked bare", () => {
    const url = "mysql://app:pa55word@db.example.com/shop";
    const m = lendMysql(url, undefined, { alias: "prod-db" });
    expect(m.env["DATABASE_URL"]).toBe(url);
    expect(m.env["MYSQL_PASSWORD"]).toBe("pa55word");
    expect(text(m.env["MYSQL_GROUP_SUFFIX"]!)).toBe("_prod_db");
    const cnf = m.files.find((f) => f.path === "/root/.my.cnf")!;
    expect(cnf.mode).toBe("600");
    expect(text(cnf.content)).toBe(
      '[client_prod_db]\nhost="db.example.com"\nport="3306"\nuser="app"\npassword="pa55word"\ndatabase="shop"\n',
    );
    expect(secrets(cnf.content)).toEqual(["pa55word"]);
  });

  it.each([
    ['a"b', `'a"b'`],
    ["a'b", `"a'b"`],
    ["back\\slash", '"back\\\\slash"'],
    ["hash#tag", '"hash#tag"'],
    [" padded ", '" padded "'],
  ])("quotes %j so MySQL reads it back as it is", (password, written) => {
    expect(optionValue(password)).toBe(written);
    expect(readBack(written)).toBe(password);
  });

  it("leaves out a password no quoting can carry, and still masks it raw", () => {
    expect(optionValue(`a"b'c`)).toBeNull();
    const m = lendMysql(`mysql://app:${encodeURIComponent(`a"b'c`)}@db/x`, undefined, {
      alias: "db",
    });
    expect(m.env["MYSQL_PASSWORD"]).toBe(`a"b'c`);
    expect(text(m.files.find((f) => f.path === "/root/.my.cnf")!.content)).not.toContain(
      "password=",
    );
  });

  it("masks the raw password even where the file doubles its backslashes", () => {
    const m = lendMysql(`mysql://app:${encodeURIComponent("x\\y")}@db/x`, undefined, {
      alias: "db",
    });
    expect(m.env["MYSQL_PASSWORD"]).toBe("x\\y");
    const cnf = m.files.find((f) => f.path === "/root/.my.cnf")!;
    expect(text(cnf.content)).toContain('password="x\\\\y"\n');
  });
});
