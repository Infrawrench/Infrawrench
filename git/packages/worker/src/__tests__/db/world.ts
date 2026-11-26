/**
 * What the database suites share: people, organisations and the API served
 * end to end (the real gates and handlers, a header in place of a session, a
 * `RepoReader` fake in place of the storage) against `DATABASE_URL`.
 *
 * Every name carries the run's own suffix, so suites and reruns on one
 * database never meet, and {@link World.cleanup} deletes what was made
 * (repositories and everything under them go by cascade).
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  gitNamespaces,
  gitUsers,
  gitFeatureAccess,
  organizationMembers,
  organizations,
  users,
} from "@infrawrench/server-core/db/schema";
import { makeGitApi } from "../../api/server";
import type { Authenticated } from "../../auth/authenticate";
import { ANONYMOUS, type Principal } from "../../auth/principal";
import { db, newId } from "../../db/client";
import { claimOrganizationNamespace, claimUserNamespace } from "../../db/namespaces";
import type { Env } from "../../env";
import { type FakeStorage, fakeStorage } from "../helpers/fake-reader";

export const configured = Boolean(process.env["DATABASE_URL"]);

/** A branch page's API path: its key is one percent-encoded segment (`feature%2Fa`). */
export const pagePath = (repo: string, key: string): string =>
  `${repo}/branches/${encodeURIComponent(key)}`;

export interface Person {
  readonly id: string;
  readonly username: string;
  readonly email: string;
}

export interface Answer<T = any> {
  readonly status: number;
  readonly body: T;
}

export interface CallOptions {
  /** Who is calling: a signed-in person, or nobody when left out. */
  readonly as?: Person | undefined;
  /** Call with a personal access token of these scopes instead of a session. */
  readonly scopes?: ReadonlyArray<"repo:read" | "repo:write">;
  /** Call with a CI job's token for this repository, instead of as a person. */
  readonly job?: {
    readonly repositoryId: string;
    readonly write: boolean;
    /** A token bound to one branch: its full ref name. */
    readonly ref?: string;
  };
  /** Call as this principal (a CI job, an API key), whatever `as` says. */
  readonly principal?: Principal;
  readonly body?: unknown;
}

export interface World {
  readonly suffix: string;
  readonly storage: FakeStorage;
  readonly env: Env;
  /** A person with a username (`<name>-<suffix>`), as after their first sign-in. */
  person(name: string, options?: { readonly username?: boolean }): Promise<Person>;
  /** An organisation, with its members by legacy role. `paid` makes it complimentary. */
  organization(
    name: string,
    options: {
      readonly paid?: boolean;
      readonly members: ReadonlyArray<readonly [Person, "owner" | "admin" | "member"]>;
      /** Claim `<name>-<suffix>` as its namespace. Default true. */
      readonly namespace?: boolean;
      /** git-feature-flag: turn Git on for it, as `/admin` does. Default false. */
      readonly git?: boolean;
    },
  ): Promise<{ readonly id: string; readonly slug: string }>;
  call<T = any>(method: string, path: string, options?: CallOptions): Promise<Answer<T>>;
  /** A repository made through the API, with a first commit on `main`. */
  repository(
    owner: Person,
    namespace: string,
    name: string,
    visibility?: "public" | "private",
  ): Promise<{ readonly id: string; readonly path: string }>;
  cleanup(): Promise<void>;
}

export const makeWorld = (): World => {
  const suffix = randomUUID().slice(0, 8);
  const storage = fakeStorage();
  const env = {
    SITE_ORIGIN: "https://git.example.test",
    APP_ORIGIN: "https://app.example.test",
  } as Env;
  const people = new Map<string, Person>();
  const organizationIds: string[] = [];

  const principals = new Map<string, Principal>();
  const principalOf = (request: Request): Principal => {
    const job = request.headers.get("x-test-job");
    if (job) {
      const [repositoryId, access, ref] = job.split(" ") as [string, string, string?];
      return {
        kind: "job",
        repositoryId,
        write: access === "write",
        runId: "run-1",
        ...(ref ? { ref } : {}),
      };
    }
    const given = principals.get(request.headers.get("x-test-principal") ?? "");
    if (given) return given;
    const userId = request.headers.get("x-test-user");
    if (!userId) return ANONYMOUS;
    const scopes = request.headers.get("x-test-scopes");
    return scopes === null
      ? { kind: "user", userId, via: "session", scopes: null, credentialId: null }
      : {
          kind: "user",
          userId,
          via: "token",
          scopes: scopes.split(",").filter(Boolean) as Array<"repo:read" | "repo:write">,
          credentialId: "token-1",
        };
  };
  const api = makeGitApi({
    readers: storage.readers,
    authenticate: async (request): Promise<Authenticated> => ({
      principal: principalOf(request),
      refused: false,
      setCookies: [],
      email: null,
    }),
  });
  const pending: Promise<unknown>[] = [];

  const world: World = {
    suffix,
    storage,
    env,

    async person(name, options = {}) {
      const person: Person = {
        id: `test-user-${name}-${suffix}`,
        username: `${name}-${suffix}`,
        email: `${name}-${suffix}@example.test`,
      };
      await db.insert(users).values({ id: person.id, email: person.email, displayName: name });
      await db.insert(gitUsers).values({ userId: person.id });
      if (options.username !== false) await claimUserNamespace(person.id, person.username);
      people.set(person.id, person);
      return person;
    },

    async organization(name, options) {
      const id = `test-org-${name}-${suffix}`;
      const slug = `${name}-${suffix}`;
      await db
        .insert(organizations)
        .values({ id, displayName: name, complimentary: options.paid ?? false });
      organizationIds.push(id);
      for (const [person, role] of options.members) {
        await db
          .insert(organizationMembers)
          .values({ id: newId(), userId: person.id, organizationId: id, role });
      }
      if (options.namespace !== false) {
        await claimOrganizationNamespace(id, slug, options.members[0]![0].id);
      }
      // git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
      if (options.git === true) {
        await db.insert(gitFeatureAccess).values({ organizationId: id, enabledBy: null });
      }
      return { id, slug };
    },

    async call(method, path, options = {}) {
      const headers = new Headers();
      if (options.as) headers.set("x-test-user", options.as.id);
      if (options.scopes) headers.set("x-test-scopes", options.scopes.join(","));
      if (options.job) {
        headers.set(
          "x-test-job",
          `${options.job.repositoryId} ${options.job.write ? "write" : "read"} ${options.job.ref ?? ""}`.trim(),
        );
      }
      if (options.principal) {
        const key = newId();
        principals.set(key, options.principal);
        headers.set("x-test-principal", key);
      }
      if (options.body !== undefined) headers.set("content-type", "application/json");
      const response = await api.handle(
        new Request(`https://git.example.test${path}`, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        }),
        env,
        { waitUntil: (promise) => void pending.push(promise) },
      );
      // What a handler left for after the response is part of what it did.
      await Promise.all(pending.splice(0));
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },

    async repository(owner, namespace, name, visibility = "public") {
      const created = await world.call("POST", "/api/repos", {
        as: owner,
        body: { owner: namespace, name, visibility, initialize: { readme: true } },
      });
      if (created.status !== 200) {
        throw new Error(`creating ${namespace}/${name}: ${JSON.stringify(created)}`);
      }
      return { id: created.body.id, path: `/api/repos/${namespace}/${name}` };
    },

    async cleanup() {
      await Promise.allSettled(pending.splice(0));
      const userIds = [...people.keys()];
      // Namespaces first: their repositories, and everything under those, cascade.
      if (organizationIds.length > 0) {
        await db
          .delete(gitNamespaces)
          .where(inArray(gitNamespaces.organizationId, organizationIds));
        await db.delete(organizations).where(inArray(organizations.id, organizationIds));
      }
      if (userIds.length > 0) {
        await db.delete(gitNamespaces).where(inArray(gitNamespaces.userId, userIds));
        await db.delete(users).where(inArray(users.id, userIds));
      }
    },
  };
  return world;
};
