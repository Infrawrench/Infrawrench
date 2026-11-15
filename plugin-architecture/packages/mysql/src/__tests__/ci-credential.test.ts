import { describe, expect, it } from "vitest";
import type { CiLentValue } from "@infrawrench/plugin-base";

import { lendMysql } from "../ci-credential.js";

const text = (value: CiLentValue) =>
  typeof value === "string" ? value : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
const secrets = (value: CiLentValue) =>
  typeof value === "string" ? [value] : value.flatMap((p) => ("secret" in p ? [p.secret] : []));

describe("lendMysql", () => {
  it("writes an option group the suffix selects, the password masked bare", () => {
    const url = "mysql://app:pa55word@db.example.com/shop";
    const m = lendMysql(url, undefined, { alias: "prod-db" });
    expect(m.env["DATABASE_URL"]).toBe(url);
    expect(text(m.env["MYSQL_GROUP_SUFFIX"]!)).toBe("_prod_db");
    const cnf = m.files.find((f) => f.path === "/root/.my.cnf")!;
    expect(cnf.mode).toBe("600");
    expect(text(cnf.content)).toBe(
      '[client_prod_db]\nhost="db.example.com"\nport="3306"\nuser="app"\npassword="pa55word"\ndatabase="shop"\n',
    );
    expect(secrets(cnf.content)).toEqual(["pa55word"]);
  });

  it("quotes a password with a quote in it, masked as a whole", () => {
    const m = lendMysql("mysql://app:a%22b@db/x", undefined, { alias: "db" });
    const cnf = m.files.find((f) => f.path === "/root/.my.cnf")!;
    expect(text(cnf.content)).toContain('password="a\\"b"\n');
    expect(secrets(cnf.content)).toEqual(['"a\\"b"']);
  });
});
