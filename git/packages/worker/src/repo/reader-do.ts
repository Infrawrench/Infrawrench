/**
 * The `RepoReader` the Worker uses: every method is one call to the
 * repository's Durable Object, which runs it beside the data
 * (`queries/index.ts`, through `RepoDO.reader`). Nothing is computed here.
 * NOTES.md ("The reader") has the measurements behind that.
 */
import type { Env } from "../env";
import { repoClient } from "./do/client";
import { READER_METHODS, type ReaderMethod, type ReaderReply } from "./queries";
import { type RepoLocator, type RepoReader, RepoReaderError } from "./reader";

/** An error the platform raised for the object itself (overloaded, reset mid-call), not one our code threw. */
const fromPlatform = (error: unknown): boolean => {
  const flags = error as { retryable?: unknown; overloaded?: unknown } | null;
  return (
    flags !== null &&
    typeof flags === "object" &&
    (flags.retryable === true || flags.overloaded === true)
  );
};

export function durableRepoReader(env: Pick<Env, "REPO">, locator: RepoLocator): RepoReader {
  const names = { owner: locator.owner, name: locator.name };
  const call = async (method: ReaderMethod, args: readonly unknown[]): Promise<unknown> => {
    let reply: ReaderReply;
    try {
      // Looked up per call: a stub that saw its object reset does not recover.
      reply = await repoClient(env, locator.id).reader(names, method, args);
    } catch (error) {
      if (fromPlatform(error)) {
        throw new RepoReaderError("unavailable", "The repository's storage did not answer");
      }
      throw error;
    }
    if (reply.ok) return reply.value;
    throw new RepoReaderError(reply.code, reply.message);
  };
  return Object.fromEntries(
    READER_METHODS.map((method) => [method, (...args: unknown[]) => call(method, args)]),
  ) as unknown as RepoReader;
}
