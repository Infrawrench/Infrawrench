import { describe, expect, it } from "vitest";
import { dialTargets } from "../driver.js";

describe("postgres dialTargets", () => {
  it("reports the URL host and port", () => {
    expect(dialTargets("postgres://u:p@db.example.com:6543/app")).toEqual([
      { kind: "host", host: "db.example.com", port: 6543 },
    ]);
  });

  it("defaults the port to 5432 and unbrackets IPv6", () => {
    expect(dialTargets("postgres://u@[2606:4700::1]/app")).toEqual([
      { kind: "host", host: "2606:4700::1", port: 5432 },
    ]);
  });

  it("lets a host query parameter override the URL host, as pg does", () => {
    expect(dialTargets("postgres://u@public.example.com/app?host=169.254.169.254")).toEqual([
      { kind: "host", host: "169.254.169.254", port: 5432 },
    ]);
  });

  it.each([
    "/var/run/postgresql app",
    "socket:/var/run/postgresql?db=app",
    "postgres://u@/app",
    "postgres://u@x/app?host=/var/run/postgresql",
    "postgres://u@db.example.com/app?sslrootcert=/etc/passwd",
    "postgres://u@db.example.com/app?sslkey=/proc/self/environ",
    "postgres://u@db.example.com/app?sslcert=/x",
  ])("reports %s as local", (cs) => {
    expect(dialTargets(cs)[0]!.kind).toBe("local");
  });
});
