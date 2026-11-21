/**
 * Finding the `.infraenv` a command is about, and reading it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { INFRAENV_FILE_NAME } from "@infrawrench/client-core";
import { gitRoot, realpathOr } from "./git";
import { Failure } from "./io";

/** A path as the person would type it from the working directory. */
export const display = (cwd: string, path: string): string => relative(cwd, path) || ".";

/** A relative path with `/` separators, as it is written into files and hooks. */
export const posix = (path: string): string => path.split(sep).join("/");

/**
 * The nearest `.infraenv` walking up from `cwd`, stopping at the repository
 * root (or `cwd` alone outside a repository); null when there is none.
 */
export async function findInfraenv(cwd: string): Promise<string | null> {
  const root = await gitRoot(cwd);
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, INFRAENV_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (root === null || parent === dir || realpathOr(dir) === root) return null;
    dir = parent;
  }
}

/** `--file`, else the nearest `.infraenv`; a failure that says what to do when there is none. */
export async function locateInfraenv(cwd: string, file: string | null): Promise<string> {
  if (file !== null) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) throw new Failure(`${file} does not exist.`);
    return path;
  }
  const found = await findInfraenv(cwd);
  if (found !== null) return found;
  const root = await gitRoot(cwd);
  throw new Failure(
    `No ${INFRAENV_FILE_NAME} here${root === null ? "" : " or in a parent directory up to the repository root"}. Create one in the Infrawrench app (Env files) or with \`infrawrench env init\`, or pass -f <path>.`,
  );
}

export function readText(cwd: string, path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Failure(
      `Could not read ${display(cwd, path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
