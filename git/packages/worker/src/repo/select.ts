/**
 * Which `RepoReader` the Worker uses. The one place it is chosen: the API
 * handlers and the queue consumer both come through {@link repoReaderFor}.
 *
 * TODO(git-storage): return the Durable Object backed reader here, built
 * from `env.REPO.get(env.REPO.idFromName(locator.id))` and `env.OBJECTS`.
 * Nothing else changes: `./reader.ts` is the interface it implements.
 */
import type { Env } from "../env";
import { type RepoLocator, type RepoReader, unavailableRepoReader } from "./reader";

/** Makes the reader of one repository. Tests pass their own. */
export type RepoReaderFactory = (env: Env, locator: RepoLocator) => RepoReader;

export const repoReaderFor: RepoReaderFactory = () => unavailableRepoReader;
