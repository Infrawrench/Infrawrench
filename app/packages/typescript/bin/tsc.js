#!/usr/bin/env node
// `tsc` for every package that aliases `typescript` to this one. Mirrors the upstream launcher:
// replace this process with the native compiler where Node can, else run it as a child.
import { execFileSync } from "node:child_process";
import getExePath from "../lib/getExePath.js";

const exe = getExePath();
const args = process.argv.slice(2);

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
