/**
 * The steps `pull` and `check` share before they make a request: who runs the
 * command (this package with a key, the desktop CLI, or nobody), then which
 * organization the file resolves in.
 */
import { ApiFailure } from "./api";
import type { ParsedArgs } from "./args";
import {
  chooseOrg,
  configPath,
  findCredentials,
  readStored,
  type Credentials,
  type OrgSource,
} from "./config";
import { DESKTOP_CLI, delegatedArgv, findOnPath, route, runDelegated } from "./delegate";
import { Failure, type Io } from "./io";

export const NO_CREDENTIALS =
  "No Infrawrench API key. Run `infraenv login`, or set INFRAWRENCH_API_KEY to an iwk_ key (Settings > API keys in Infrawrench).";

/**
 * This package's credentials, or the desktop CLI's exit code once it has run
 * the command instead.
 */
export async function credentialsOrDelegate(
  io: Io,
  command: "pull" | "check",
  args: ParsedArgs,
): Promise<Credentials | { delegated: number }> {
  const credentials = findCredentials(io.env, readStored(configPath(io)));
  const next = route(credentials !== null, credentials ? null : findOnPath(DESKTOP_CLI, io));
  switch (next.kind) {
    case "self":
      return credentials!;
    case "none":
      throw new Failure(NO_CREDENTIALS);
    case "delegate": {
      const argv = delegatedArgv(command, args);
      if (!args.quiet) {
        io.err(
          `infraenv: no API key; running \`${DESKTOP_CLI} ${argv.slice(0, 2).join(" ")}\` from the desktop app instead.\n`,
        );
      }
      return { delegated: await runDelegated(next.executable, argv, io) };
    }
  }
}

export interface ResolvedOrg {
  readonly id: string;
  readonly from: OrgSource;
}

/** `--org`, the environment, the file, the login, else the key's own organization. */
export async function resolveOrg(
  io: Io,
  args: ParsedArgs,
  credentials: Credentials,
  fileOrg: string | undefined,
  whoami: () => Promise<{ organizationId: string }>,
): Promise<ResolvedOrg> {
  const chosen = chooseOrg({ flag: args.org, env: io.env, file: fileOrg, credentials });
  if (chosen) return chosen;
  return { id: (await whoami()).organizationId, from: "key" };
}

const ORG_FROM: Record<OrgSource, string> = {
  flag: "--org",
  env: "INFRAWRENCH_ORG_ID",
  file: "the file's [infrawrench] org",
  login: "the organization stored at login",
  key: "the key's organization",
};

/**
 * A request refused because the key belongs to another organization than the
 * one chosen, said with both ids.
 */
export async function explainWrongOrg(
  error: unknown,
  org: ResolvedOrg,
  whoami: () => Promise<{ organizationId: string }>,
): Promise<never> {
  if (
    error instanceof ApiFailure &&
    error.status === 403 &&
    /different organization/i.test(error.serverMessage)
  ) {
    const keyOrg = await whoami().then(
      (w) => w.organizationId,
      () => null,
    );
    throw new Failure(
      `The API key belongs to ${keyOrg ? `organization ${keyOrg}` : "another organization"}, but ${ORG_FROM[org.from]} names ${org.id}. Use a key for ${org.id}, or drop ${ORG_FROM[org.from]}.`,
    );
  }
  throw error;
}
