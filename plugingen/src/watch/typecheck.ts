import fs from "node:fs";
import path from "node:path";
import { pluginDir } from "../config.js";
import type { GeneratedFile } from "../generate.js";
import { readCommitted, writeGenerated } from "../output.js";
import { run } from "../process.js";
import { stripAnsi } from "../text.js";
import type { TypecheckResult } from "./render.js";

const TIMEOUT_MS = 15 * 60 * 1000;

export type Typecheck = (
  plugin: string,
  files: readonly GeneratedFile[],
) => Promise<TypecheckResult>;

/**
 * What goes in the pull request. Only the diagnostics, when there are any: Turbo's
 * timings and cache lines change every run, and a description that changes daily gets
 * rewritten daily.
 */
export function distillOutput(output: string): string {
  const lines = stripAnsi(output).split("\n");
  const diagnostics = lines.filter((line) => /\berror TS\d+:/.test(line));
  if (diagnostics.length > 0) return diagnostics.join("\n");
  return lines
    .filter((line) => !/^\s*(Time:|Cached:|cache (hit|miss)|•)/.test(line))
    .join("\n")
    .trim();
}

function packageName(root: string, plugin: string): string | undefined {
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(pluginDir(root, plugin), "package.json"), "utf8"),
  );
  if (typeof raw !== "object" || raw === null || !("name" in raw)) return undefined;
  return typeof raw.name === "string" ? raw.name : undefined;
}

/**
 * Compiles the plugin against the fresh types and puts the committed files back. Turbo
 * builds what the plugin depends on first. The child gets no GitHub token: nothing here
 * runs a vendor's text, but it also has no reason to hold one.
 */
export function createTypecheck(root: string): Typecheck {
  return async (plugin, files) => {
    const name = packageName(root, plugin);
    if (!name) return { state: "not-run", reason: "the plugin's package.json has no name" };
    const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...env } = process.env;
    const originals = files.map((file) => ({
      fileName: file.fileName,
      text: readCommitted(root, plugin, file.fileName),
    }));
    try {
      for (const file of files) writeGenerated(root, plugin, file.fileName, file.text);
      const result = await run(
        path.join(root, "node_modules/.bin/turbo"),
        [
          "run",
          "typecheck",
          `--filter=${name}`,
          "--output-logs=errors-only",
          "--ui=stream",
          "--log-prefix=none",
        ],
        { cwd: root, env: { ...env, TURBO_TELEMETRY_DISABLED: "1" }, timeoutMs: TIMEOUT_MS },
      );
      if (result.code === 0) return { state: "passed" };
      return { state: "failed", output: distillOutput(`${result.stdout}\n${result.stderr}`) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { state: "not-run", reason };
    } finally {
      for (const original of originals) {
        if (original.text === undefined) {
          fs.rmSync(path.join(pluginDir(root, plugin), "src", original.fileName), { force: true });
        } else {
          writeGenerated(root, plugin, original.fileName, original.text);
        }
      }
    }
  };
}
