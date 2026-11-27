/**
 * Which `RepoReader` the Worker uses. The one place it is chosen: the API
 * handlers and the queue consumer both come through {@link repoReaderFor}.
 * It is the repository's Durable Object (`./reader-do.ts`); `./reader.ts` is
 * the interface, and `unavailableRepoReader` there is what a test without
 * storage can pass instead.
 */
import type { Env } from "../env";
import { durableRepoReader } from "./reader-do";
import type { RepoLocator, RepoReader } from "./reader";

/** Makes the reader of one repository. Tests pass their own. */
export type RepoReaderFactory = (env: Env, locator: RepoLocator) => RepoReader;

export const repoReaderFor: RepoReaderFactory = durableRepoReader;
