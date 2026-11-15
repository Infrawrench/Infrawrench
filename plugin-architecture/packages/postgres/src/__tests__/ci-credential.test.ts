import { describe, expect, it } from "vitest";
import type { CiLentValue } from "@infrawrench/plugin-base";
import { runPluginEffect } from "@infrawrench/plugin-base/effect";

import { lendPostgres } from "../ci-credential.js";
import { plugin } from "../plugin.js";

const text = (value: CiLentValue) =>
  typeof value === "string" ? value : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
const secrets = (value: CiLentValue) =>
  typeof value === "string" ? [value] : value.flatMap((p) => ("secret" in p ? [p.secret] : []));

const URL_ = "postgresql://app%40prod:s3cr%23t@db.example.com:6543/shop?sslmode=require";

describe("lendPostgres", () => {
  it("lends the string and what psql reads, the password only as a secret", () => {
    const m = lendPostgres(URL_, undefined, { alias: "prod-db" });
    expect(m.env["DATABASE_URL"]).toBe(URL_);
    expect(text(m.env["PGHOST"]!)).toBe("db.example.com");
    expect(text(m.env["PGPORT"]!)).toBe("6543");
    expect(text(m.env["PGDATABASE"]!)).toBe("shop");
    expect(text(m.env["PGUSER"]!)).toBe("app@prod");
    expect(m.env["PGPASSWORD"]).toBe("s3cr#t");
    expect(text(m.env["PGSSLMODE"]!)).toBe("require");
    for (const k of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE"]) {
      expect(secrets(m.env[k]!)).toEqual([]);
    }
    const service = m.files.find((f) => f.path === "/root/.pg_service.conf")!;
    expect(service.mode).toBe("600");
    expect(text(service.content)).toBe(
      "[prod-db]\nhost=db.example.com\nport=6543\ndbname=shop\nuser=app@prod\npassword=s3cr#t\nsslmode=require\n",
    );
    expect(secrets(service.content)).toEqual(["s3cr#t"]);
  });

  it("writes the connection's CA and names it", () => {
    const m = lendPostgres(URL_, "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----", {
      alias: "prod-db",
    });
    const ca = m.files.find((f) => f.path === "/root/.postgresql/prod-db-root.crt")!;
    expect(text(ca.content)).toContain("BEGIN CERTIFICATE");
    expect(text(m.env["PGSSLROOTCERT"]!)).toBe("/root/.postgresql/prod-db-root.crt");
    expect(text(m.files.find((f) => f.path.endsWith("pg_service.conf"))!.content)).toContain(
      "sslrootcert=/root/.postgresql/prod-db-root.crt\n",
    );
  });

  it("lends a key/value string as it is", () => {
    const m = lendPostgres("host=db user=x password=y", undefined, { alias: "db" });
    expect(m.env).toEqual({ DATABASE_URL: "host=db user=x password=y" });
    expect(m.files).toEqual([]);
  });

  it("refuses a database with no endpoint yet", () => {
    expect(() => lendPostgres("", undefined, { alias: "db" })).toThrow(/no connection string/);
  });

  it("is declared, and the client lends it", async () => {
    expect(plugin.manifest.ciCredential?.shortLived).toBe(false);
    const client = plugin.createClient({ connectionString: URL_ });
    const m = await runPluginEffect(
      client.lendCiCredential!({
        name: "prod db",
        alias: "prod-db",
        ttlSeconds: 600,
        references: {},
        pinnedHostKey: async () => null,
      }),
    );
    expect(m.env["DATABASE_URL"]).toBe(URL_);
  });
});
