/**
 * `infraenv login`, `logout` and `whoami`: the API key this package uses when
 * INFRAWRENCH_API_KEY is not set.
 *
 * `login` checks the key with `GET /api/v1/whoami` before storing it, which
 * also says which organization the key belongs to, so nobody has to type an
 * organization id: it is stored beside the key.
 */
import { createApi } from "../api";
import type { ParsedArgs } from "../args";
import {
  DEFAULT_BASE_URL,
  configPath,
  deleteStored,
  findCredentials,
  normalizeBaseUrl,
  orgIdFrom,
  readStored,
  writeStored,
} from "../config";
import { Exit, Failure, printer, safe, type Io } from "../io";
import { NO_CREDENTIALS } from "../session";

/** Read everything piped to standard input. */
export function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((done, fail) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (text += chunk));
    stream.on("end", () => done(text));
    stream.on("error", fail);
  });
}

/** Ask on the terminal without echoing what is typed (or pasted). */
export function promptHidden(io: Io, question: string): Promise<string> {
  const stdin = io.stdin;
  io.err(question);
  return new Promise((done, fail) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      io.err("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          return done(value);
        }
        if (ch === "\u0003") {
          cleanup();
          return fail(new Exit(130));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

export async function login(io: Io, args: ParsedArgs): Promise<number> {
  const p = printer(io);
  let key: string;
  if (args.keyStdin) {
    key = (await readAll(io.stdin)).trim();
  } else if (io.stdin.isTTY) {
    p.errLine("Create an API key in Infrawrench under Settings > API keys (secrets:read to pull).");
    key = (await promptHidden(io, "API key: ")).trim();
  } else {
    throw new Failure(
      "No terminal to ask for the key on. Pipe it in with `infraenv login --key-stdin`, or set INFRAWRENCH_API_KEY instead.",
    );
  }
  if (!key) throw new Failure("No API key given.");
  if (!key.startsWith("iwk_")) {
    throw new Failure("That is not an Infrawrench API key: they start with iwk_.");
  }

  const baseUrl = normalizeBaseUrl(io.env.INFRAWRENCH_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const who = await createApi({ apiKey: key, baseUrl }).whoami();
  if (args.org !== null) {
    const wanted = orgIdFrom(args.org, "--org");
    if (wanted !== who.organizationId) {
      throw new Failure(
        `That key belongs to organization ${who.organizationId}, not ${wanted}. Create the key in the organization you mean.`,
      );
    }
  }

  const path = configPath(io);
  try {
    writeStored(path, {
      apiKey: key,
      orgId: who.organizationId,
      ...(baseUrl === DEFAULT_BASE_URL ? {} : { baseUrl }),
    });
  } catch (error) {
    throw new Failure(
      `Could not save the key to ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  p.line(`Logged in to organization ${who.organizationId}. The key is in ${path}.`);
  if (io.env.INFRAWRENCH_API_KEY?.trim()) {
    p.errLine(
      p.ec.yellow(
        "warning: INFRAWRENCH_API_KEY is set in this shell, and it wins over the stored key.",
      ),
    );
  }
  return 0;
}

export async function logout(io: Io): Promise<number> {
  const p = printer(io);
  const path = configPath(io);
  p.line(deleteStored(path) ? `Removed the stored key (${path}).` : "No stored key.");
  if (io.env.INFRAWRENCH_API_KEY?.trim()) {
    p.errLine(p.ec.yellow("INFRAWRENCH_API_KEY is still set in this shell, and is still used."));
  }
  return 0;
}

export async function whoami(io: Io, args: ParsedArgs): Promise<number> {
  const p = printer(io);
  const path = configPath(io);
  const credentials = findCredentials(io.env, readStored(path));
  if (credentials === null) throw new Failure(NO_CREDENTIALS);
  const who = await createApi(credentials).whoami();
  const source = credentials.source === "env" ? "INFRAWRENCH_API_KEY" : path;
  if (args.json) {
    p.json({ source, baseUrl: credentials.baseUrl, ...who });
    return 0;
  }
  const { c } = p;
  p.line(`${c.dim("organization")}  ${safe(who.organizationId)}`);
  p.line(`${c.dim("user        ")}  ${safe(who.userId)}`);
  p.line(
    `${c.dim("credential  ")}  ${who.principal === "api_key" ? "API key" : safe(who.principal)}`,
  );
  p.line(`${c.dim("from        ")}  ${source}`);
  p.line(`${c.dim("server      ")}  ${credentials.baseUrl}`);
  return 0;
}
