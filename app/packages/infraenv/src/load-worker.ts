/**
 * The child process behind `configSync()`: reads `LoadOptions` as JSON on
 * stdin, resolves, and answers `{ ok, result }` or `{ ok: false, error }` as
 * JSON on stdout. Problems are left to the parent to print or throw.
 */
import { InfraenvError, resolveValues, type LoadOptions } from "./resolve";

function readStdin(): Promise<string> {
  return new Promise((done, fail) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.on("end", () => done(text));
    process.stdin.on("error", fail);
  });
}

try {
  const options = JSON.parse(await readStdin()) as LoadOptions;
  const result = await resolveValues({ ...options, quiet: true, strict: false });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  const known = error instanceof InfraenvError;
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: {
        // An unexpected error's message is still only ever about files and
        // keys; its stack is left out.
        message: error instanceof Error ? error.message : String(error),
        ...(known ? { problems: error.problems, missing: error.missing } : {}),
      },
    }),
  );
  process.exitCode = 1;
}
