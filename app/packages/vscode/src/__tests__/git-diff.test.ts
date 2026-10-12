import { describe, expect, it } from "vitest";
import { collectWorkingTreeDiff, parseNameStatus, type GitRunner } from "../git-diff";

function fakeGit(opts: {
  diff: string;
  untracked?: string[];
  head: Record<string, string>;
  disk: Record<string, string>;
}): GitRunner {
  return {
    async run(args) {
      if (args[0] === "diff") return opts.diff;
      if (args[0] === "ls-files") return (opts.untracked ?? []).map((p) => `${p}\0`).join("");
      if (args[0] === "show") {
        const path = args[1]!.slice("HEAD:".length);
        if (path in opts.head) return opts.head[path]!;
        throw new Error("not in HEAD");
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    readFile: async (p) => opts.disk[p] ?? null,
  };
}

describe("parseNameStatus", () => {
  it("reads NUL-separated status/path pairs", () => {
    expect(parseNameStatus("M\0main.tf\0D\0old.tf\0")).toEqual([
      { status: "M", path: "main.tf" },
      { status: "D", path: "old.tf" },
    ]);
  });
});

describe("collectWorkingTreeDiff", () => {
  it("pairs before and after for infrastructure files only", async () => {
    const git = fakeGit({
      diff: "M\0infra/main.tf\0D\0infra/old.tf\0M\0README.md\0M\0k8s/app.yaml\0",
      untracked: ["infra/new.tf"],
      head: {
        "infra/main.tf": "a",
        "infra/old.tf": "gone",
        "README.md": "x",
        "k8s/app.yaml": "apiVersion: v1\nkind: ConfigMap\n",
      },
      disk: {
        "infra/main.tf": "b",
        "README.md": "y",
        "infra/new.tf": "n",
        "k8s/app.yaml": "apiVersion: v1\nkind: ConfigMap\ndata: {}\n",
      },
    });
    const { files } = await collectWorkingTreeDiff(git);
    expect(files).toEqual([
      { path: "infra/main.tf", before: "a", after: "b" },
      { path: "infra/old.tf", before: "gone", after: null },
      {
        path: "k8s/app.yaml",
        before: "apiVersion: v1\nkind: ConfigMap\n",
        after: "apiVersion: v1\nkind: ConfigMap\ndata: {}\n",
      },
      { path: "infra/new.tf", before: null, after: "n" },
    ]);
  });

  it("prefers unsaved editor text and picks up files dirty only in the editor", async () => {
    const git = fakeGit({
      diff: "M\0main.tf\0",
      head: { "main.tf": "a", "vars.tf": "v" },
      disk: { "main.tf": "b", "vars.tf": "v" },
    });
    const { files } = await collectWorkingTreeDiff(
      git,
      new Map([
        ["main.tf", "c"],
        ["vars.tf", "v2"],
      ]),
    );
    expect(files).toEqual([
      { path: "main.tf", before: "a", after: "c" },
      { path: "vars.tf", before: "v", after: "v2" },
    ]);
  });

  it("skips oversized files with a reason", async () => {
    const big = "x".repeat(600 * 1024);
    const git = fakeGit({ diff: "M\0big.tf\0", head: { "big.tf": "a" }, disk: { "big.tf": big } });
    const out = await collectWorkingTreeDiff(git);
    expect(out.files).toEqual([]);
    expect(out.skipped[0]!.path).toBe("big.tf");
  });
});
