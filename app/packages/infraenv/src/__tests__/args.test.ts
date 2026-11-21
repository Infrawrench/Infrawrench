import { describe, expect, it } from "vitest";
import { parseCommandLine, parseVars } from "../args";
import { UsageError } from "../io";

describe("parseCommandLine", () => {
  it("reads pull's flags in both spellings, before or after the command", () => {
    const args = parseCommandLine([
      "--org=abcd1234",
      "pull",
      "-e",
      "production",
      "--file",
      "apps/web/.infraenv",
      "--out=.env.local",
      "--var",
      "stage=prod",
      "--var=region=eu-west-1",
      "-q",
      "--force",
    ]);
    expect(args.command).toBe("pull");
    expect(args.env).toBe("production");
    expect(args.file).toBe("apps/web/.infraenv");
    expect(args.out).toBe(".env.local");
    expect(args.vars).toEqual({ stage: "prod", region: "eu-west-1" });
    expect(args.quiet).toBe(true);
    expect(args.force).toBe(true);
    expect(args.org).toBe("abcd1234");
    expect(args.stdout).toBe(false);
    expect([...args.given].sort()).toEqual(["env", "file", "force", "org", "out", "quiet", "var"]);
  });

  it("treats a bare invocation, --help and --version as no command", () => {
    expect(parseCommandLine([]).command).toBeNull();
    expect(parseCommandLine(["--help"]).help).toBe(true);
    expect(parseCommandLine(["-v"]).version).toBe(true);
    expect(parseCommandLine(["pull", "-h"]).help).toBe(true);
  });

  it("refuses an unknown command, an unknown flag and a flag the command does not take", () => {
    expect(() => parseCommandLine(["push"])).toThrow(/Unknown command "push"/);
    expect(() => parseCommandLine(["pull", "--nope"])).toThrow(UsageError);
    expect(() => parseCommandLine(["install", "--env", "x"])).toThrow(
      "infraenv install does not take --env",
    );
    expect(() => parseCommandLine(["check", "--stdout"])).toThrow(/does not take --stdout/);
    expect(() => parseCommandLine(["--json"])).toThrow(/needs a command/);
  });

  it("refuses stray positionals and a string flag with no value", () => {
    expect(() => parseCommandLine(["pull", "production"])).toThrow(/Unexpected argument/);
    expect(() => parseCommandLine(["pull", "--env"])).toThrow(UsageError);
  });

  it("takes a topic after help", () => {
    const args = parseCommandLine(["help", "pull"]);
    expect(args.command).toBe("help");
    expect(args.rest).toEqual(["pull"]);
  });
});

describe("parseVars", () => {
  it("splits on the first =, keeps empty values, and lets the last one win", () => {
    expect(parseVars(["a=1", "b=x=y", "c=", "a=2"])).toEqual({ a: "2", b: "x=y", c: "" });
  });

  it("refuses a pair without a name", () => {
    expect(() => parseVars(["novalue"])).toThrow(/--var takes name=value/);
    expect(() => parseVars(["=x"])).toThrow(UsageError);
  });
});
