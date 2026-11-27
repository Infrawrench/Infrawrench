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

  it("lends what Terraform's mysql provider reads, beside what was lent before", () => {
    const url = "mysql://app%40prod:pa55word@db.example.com:3307/shop";
    const m = lendMysql(url, undefined, { alias: "prod-db" });
    expect(text(m.env["MYSQL_ENDPOINT"]!)).toBe("db.example.com:3307");
    expect(text(m.env["MYSQL_USERNAME"]!)).toBe("app@prod");
    // The address and the user show in a log; the password is the secret.
    expect(secrets(m.env["MYSQL_ENDPOINT"]!)).toEqual([]);
    expect(secrets(m.env["MYSQL_USERNAME"]!)).toEqual([]);
    expect(secrets(m.env["MYSQL_PASSWORD"]!)).toEqual(["pa55word"]);
    expect(Object.keys(m.env).sort()).toEqual([
      "DATABASE_URL",
      "MYSQL_ENDPOINT",
      "MYSQL_GROUP_SUFFIX",
      "MYSQL_PASSWORD",
      "MYSQL_USERNAME",
    ]);
    expect(m.env["DATABASE_URL"]).toBe(url);
    expect(m.env["MYSQL_TLS_CA_CERT"]).toBeUndefined();
  });

  it("gives the endpoint the default port, and an IPv6 address its brackets", () => {
    const plain = lendMysql("mysql://app:pw@db.example.com/shop", undefined, { alias: "db" });
    expect(text(plain.env["MYSQL_ENDPOINT"]!)).toBe("db.example.com:3306");
    const v6 = lendMysql("mysql://app:pw@[2001:db8::1]:3307/shop", undefined, { alias: "db" });
    expect(text(v6.env["MYSQL_ENDPOINT"]!)).toBe("[2001:db8::1]:3307");
    expect(text(v6.files.find((f) => f.path === "/root/.my.cnf")!.content)).toContain(
      'host="2001:db8::1"\n',
    );
  });

  it("names the connection's CA for the provider's custom_tls as well as for mysql", () => {
    const m = lendMysql(
      "mysql://app:pw@db.example.com/shop",
      "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
      { alias: "prod-db" },
    );
    const caPath = "/root/.mysql/prod-db-ca.pem";
    expect(m.files.some((f) => f.path === caPath)).toBe(true);
    expect(m.env["MYSQL_TLS_CA_CERT"]).toEqual([{ text: caPath }]);
    expect(text(m.files.find((f) => f.path === "/root/.my.cnf")!.content)).toContain(
      `ssl-ca="${caPath}"\n`,
    );
  });

  it("lends a string that is not a mysql URL as it is, with nothing derived from it", () => {
    const m = lendMysql("host=db user=x password=y", undefined, { alias: "db" });
    expect(m.env).toEqual({ DATABASE_URL: "host=db user=x password=y" });
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
