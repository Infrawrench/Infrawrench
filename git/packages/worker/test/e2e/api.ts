/**
 * The JSON API for the end-to-end worker: the real `makeGitApi` over the
 * real reader, with its two gates answered from the fixture instead of
 * Postgres. Every request is an anonymous reader of the repository its path
 * names. Loaded on the first `/api` request, as the API is in production.
 */
import {
  Authentication,
  Caller,
  CurrentRepository,
  RepositoryAccess,
} from "@infrawrench/git-contract";
import { Effect, Layer } from "effect";
import { RepoRef } from "../../src/api/context";
import { RequestErrorsLive } from "../../src/api/errors";
import { type GitApiHandler, makeGitApi } from "../../src/api/server";
import { ANONYMOUS } from "../../src/auth/principal";
import type { RepositoryWithOwner } from "../../src/db/repositories";
import { repoReaderFor } from "../../src/repo/select";
import type { Fixture } from "./entry";

type FixtureRepository = Fixture["repositories"][number];

const apis = new Map<string, GitApiHandler>();

function build(found: FixtureRepository): GitApiHandler {
  const row = {
    repository: {
      id: found.id,
      namespaceId: "ns-1",
      name: found.name,
      nameLower: found.name.toLowerCase(),
      visibility: found.visibility,
      archived: false,
      defaultBranch: "main",
    },
    owner: {
      id: "ns-1",
      slug: found.owner,
      kind: "user",
      userId: found.ownerUserId,
      organizationId: null,
      displayName: null,
      avatarUrl: null,
    },
  } as unknown as RepositoryWithOwner;
  const gates = Layer.mergeAll(
    Layer.succeed(Authentication)((httpEffect) =>
      Effect.provideService(httpEffect, Caller, { userId: null, username: null, via: "anonymous" }),
    ),
    Layer.succeed(RepositoryAccess)((httpEffect) =>
      httpEffect.pipe(
        Effect.provideService(CurrentRepository, {
          id: found.id,
          namespaceId: "ns-1",
          owner: found.owner,
          name: found.name,
          visibility: found.visibility,
          archived: false,
          defaultBranch: "main",
          access: "read",
        }),
        Effect.provideService(RepoRef, { found: row, access: "read", unarchived: "read" }),
      ),
    ),
    RequestErrorsLive,
  );
  return makeGitApi({
    middleware: gates,
    readers: repoReaderFor,
    authenticate: async () => ({
      principal: ANONYMOUS,
      refused: false,
      setCookies: [],
      email: null,
    }),
  });
}

/** The API for the repository `/api/repos/<owner>/<name>/...` names, or null when the fixture has none. */
export function apiFor(fixture: Fixture, pathname: string): GitApiHandler | null {
  const [, , , owner, name] = pathname.split("/");
  const found = fixture.repositories.find((each) => each.owner === owner && each.name === name);
  if (!found) return null;
  let api = apis.get(found.id);
  if (!api) apis.set(found.id, (api = build(found)));
  return api;
}
