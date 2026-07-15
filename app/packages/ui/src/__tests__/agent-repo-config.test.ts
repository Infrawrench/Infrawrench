import { describe, expect, it } from "vitest";
import { buildAgentEnvFile, resolveAgentEnvTemplate } from "../agents/repo-config.js";

describe("resolveAgentEnvTemplate", () => {
  const resource = {
    fields: { region: "fra1" },
    resolvedOutputs: { connectionString: "postgres://u:p@host/db", host: "db.example" },
  };

  it("substitutes outputs and fields placeholders", () => {
    expect(resolveAgentEnvTemplate("{{outputs.connectionString}}", resource)).toBe(
      "postgres://u:p@host/db",
    );
    expect(
      resolveAgentEnvTemplate("host={{ outputs.host }} region={{fields.region}}", resource),
    ).toBe("host=db.example region=fra1");
  });

  it("passes through templates without placeholders", () => {
    expect(resolveAgentEnvTemplate("plain-value", resource)).toBe("plain-value");
  });

  it("throws on missing keys instead of producing a half-templated value", () => {
    expect(() => resolveAgentEnvTemplate("{{outputs.nope}}", resource)).toThrow(/outputs\.nope/);
    expect(() => resolveAgentEnvTemplate("{{fields.nope}}", resource)).toThrow(/fields\.nope/);
  });
});

describe("buildAgentEnvFile", () => {
  it("renders sourceable KEY='value' lines", () => {
    const file = buildAgentEnvFile({ DATABASE_URL: "postgres://u:p@host/db", DEBUG: "1" });
    expect(file).toContain("DATABASE_URL='postgres://u:p@host/db'");
    expect(file).toContain("DEBUG='1'");
    expect(file.endsWith("\n")).toBe(true);
  });

  it("escapes single quotes in values", () => {
    const file = buildAgentEnvFile({ MSG: "it's fine" });
    expect(file).toContain(`MSG='it'\\''s fine'`);
  });

  it("rejects keys that are not shell identifiers", () => {
    expect(() => buildAgentEnvFile({ "BAD-KEY": "x" })).toThrow(/BAD-KEY/);
    expect(() => buildAgentEnvFile({ "1BAD": "x" })).toThrow(/1BAD/);
  });
});
