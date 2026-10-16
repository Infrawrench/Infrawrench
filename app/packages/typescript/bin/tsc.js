#!/usr/bin/env node
// `tsc` for every package that aliases `typescript` to this one. Mirrors the upstream launcher:
// replace this process with the native compiler where Node can, else run it as a child.
//
// INFRAWRENCH_TSC_FAST=1 adds tsc-rs's `--fast`: one checker per core (at least 4, at most one
// per 32 files) plus lazy members and the faster never order. Its diagnostics equal TypeScript
// 7's at that checker count. It is opt-in because no package here is big enough to gain from it,
// and it costs CPU and memory that a parallel `turbo typecheck` needs (KNOWLEDGE.md, "Type
// checking"). The TypeScript 7 fallback has no such flag and always gets the arguments unchanged.
import { execFileSync } from "node:child_process";
import { chooseCompiler } from "../lib/getExePath.js";

const { exe, compiler } = chooseCompiler();
const args = process.argv.slice(2);

// Appended, not prepended: in build mode `-b` has to be the first argument.
if (compiler === "tsc-rs" && process.env.INFRAWRENCH_TSC_FAST === "1" && !args.includes("--fast")) {
  args.push("--fast");
}

if (process.platform !== "win32" && typeof process.execve === "function") {
  try {
    process.execve(exe, [exe, ...args]);
  } catch {
    // execve unavailable here; fall through to a child process.
  }
}

try {
  execFileSync(exe, args, { stdio: "inherit" });
} catch (e) {
  if (e.status) process.exitCode = e.status;
  else throw e;
}
