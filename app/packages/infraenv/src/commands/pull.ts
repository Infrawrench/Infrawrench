/**
 * `infraenv pull`: resolve one environment of `.infraenv` through Infrawrench
 * and write the `.env` it describes. Mirrors `infrawrench env pull`: same
 * flags, same refusals, same `--json` shape (`{ org, file, path, ...response }`).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  INFRAENV_FILE_NAME,
  infraenvEnvironmentNames,
  infraenvOutputPath,
  infraenvPullDecision,
  parseInfraenv,
  type InfraenvProblem,
} from "@infrawrench/client-core";
import { createApi } from "../api";
import type { ParsedArgs } from "../args";
import { writeSecretFile } from "../config";
import { ignoreState } from "../git";
import { Exit, Failure, UsageError, plural, printer, safe, type Io } from "../io";
import { display, locateInfraenv, posix, readText } from "../locate";
import { credentialsOrDelegate, explainWrongOrg, resolveOrg } from "../session";

/** `.infraenv:12 DATABASE_URL: Resource not found`. */
export const problemLine = (file: string, problem: InfraenvProblem): string =>
  `${file}${problem.line > 0 ? `:${problem.line}` : ""} ${problem.key ? `${safe(problem.key)}: ` : ""}${safe(problem.message)}`;

export async function pull(io: Io, args: ParsedArgs): Promise<number> {
  const p = printer(io);
  if (args.stdout && args.out !== null) {
    throw new UsageError("--stdout and --out are mutually exclusive");
  }
  if (args.stdout && args.json) {
    throw new UsageError(
      "--stdout prints the .env itself; drop --json, or drop --stdout to write the file",
    );
  }

  const credentials = await credentialsOrDelegate(io, "pull", args);
  if ("delegated" in credentials) return credentials.delegated;

  const path = await locateInfraenv(io.cwd, args.file);
  const shown = display(io.cwd, path);
  const source = readText(io.cwd, path);
  const { document, problems: syntax } = parseInfraenv(source);

  // The server refuses a file that does not parse; say where, offline.
  if (syntax.length > 0) {
    if (args.json) p.json({ file: path, problems: syntax });
    else for (const problem of syntax) p.errLine(problemLine(shown, problem));
    throw new Exit(1);
  }

  const environment = args.env;
  const declared = infraenvEnvironmentNames(document);
  if (environment !== null && !declared.includes(environment)) {
    throw new Failure(
      `${shown} has no [env.${environment}] section. ${
        declared.length > 0
          ? `Its environments: ${declared.join(", ")}.`
          : "It declares no environments, only [env]."
      }`,
    );
  }

  const target = args.stdout
    ? null
    : args.out !== null
      ? resolve(io.cwd, args.out)
      : resolve(dirname(path), infraenvOutputPath(document));

  if (target !== null) {
    if (target === path) {
      throw new Failure(
        `Refusing to write the .env over ${shown} itself. Check the output setting or --out.`,
      );
    }
    if (existsSync(target) && !args.force) {
      let existing: string;
      try {
        // A directory or a device is never "generated": refuse it like a hand-written file.
        existing = statSync(target).isFile() ? readFileSync(target, "utf8") : "";
      } catch (error) {
        throw new Failure(
          `Could not read ${display(io.cwd, target)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (infraenvPullDecision(existing) === "confirm") {
        throw new Failure(
          `${display(io.cwd, target)} exists and looks hand-written (it does not start with Infrawrench's generated header). Move it aside, or pass --force to replace it.`,
        );
      }
    }
  }

  const api = createApi(credentials);
  const org = await resolveOrg(io, args, credentials, document.settings.org, api.whoami);
  const sourceName = posix(relative(target === null ? io.cwd : dirname(target), path));
  const vars = Object.keys(args.vars).length > 0 ? args.vars : undefined;
  const resolved = await api
    .resolve(org.id, {
      source,
      ...(environment === null ? {} : { environment }),
      ...(vars ? { vars } : {}),
      sourceName: sourceName || INFRAENV_FILE_NAME,
    })
    .catch((error: unknown) => explainWrongOrg(error, org, api.whoami));

  if (target !== null) {
    try {
      writeSecretFile(target, resolved.dotenv);
    } catch (error) {
      throw new Failure(
        `Could not write ${display(io.cwd, target)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (args.json) {
    p.json({ org: org.id, file: path, path: target, ...resolved });
  } else if (target === null) {
    io.out(resolved.dotenv);
  } else if (!args.quiet) {
    const count = resolved.values.length;
    const env = resolved.environment ?? environment;
    p.line(
      `Wrote ${display(io.cwd, target)} (${plural(count, "variable")}${env ? `, environment ${safe(env)}` : ""})`,
    );
  }

  if (!args.json) {
    for (const problem of resolved.problems) p.errLine(problemLine(shown, problem));
  }

  if (target !== null && !args.quiet && !args.json) {
    if ((await ignoreState(target)) === "not-ignored") {
      p.errLine(
        p.ec.yellow(
          `warning: ${display(io.cwd, target)} is not ignored by Git, and it holds secret values. Add it to .gitignore.`,
        ),
      );
    }
  }

  if (resolved.problems.length > 0) {
    if (!args.json) {
      p.errLine(
        p.ec.red(
          resolved.problems.length === 1
            ? "1 variable did not resolve and was left out."
            : `${resolved.problems.length} variables did not resolve and were left out.`,
        ),
      );
    }
    return 1;
  }
  return 0;
}
