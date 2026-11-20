import { describe, expect, it } from "vitest";
import {
  INFRAENV_HOOKS,
  infraenvForeignHookProblem,
  infraenvHookBlock,
  infraenvHookState,
  withInfraenvHook,
  withoutInfraenvHook,
} from "../infraenv-hooks";

const opts = { file: ".infraenv", output: ".env" };

describe("hook text", () => {
  it("creates, updates and removes our own hook", () => {
    const block = infraenvHookBlock("post-merge", opts);
    const created = withInfraenvHook(null, block);
    expect(created.change).toBe("created");
    expect(infraenvHookState(created.text)).toBe("ours");
    expect(withInfraenvHook(created.text, block).change).toBe("unchanged");
    expect(withoutInfraenvHook(created.text)).toBeNull();
  });

  it("appends to someone else's hook and gives it back intact", () => {
    const theirs = "#!/bin/sh\nnpx lint-staged\n";
    const added = withInfraenvHook(theirs, infraenvHookBlock("post-commit", opts));
    expect(added.change).toBe("appended");
    expect(infraenvHookState(added.text)).toBe("shared");
    expect(withoutInfraenvHook(added.text)).toBe(theirs);
  });

  it("refuses a hook in another language", () => {
    expect(infraenvForeignHookProblem("#!/usr/bin/env node\n")).toMatch(/not a shell/);
    expect(infraenvForeignHookProblem("#!/usr/bin/env bash\n")).toBeNull();
  });

  it("names every hook it installs", () => {
    expect(INFRAENV_HOOKS).toEqual(["post-checkout", "post-merge", "post-rewrite", "post-commit"]);
  });
});
