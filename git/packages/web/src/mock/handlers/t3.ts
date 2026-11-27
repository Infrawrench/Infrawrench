import { T3_CONNECT_REFUSAL, t3ConnectOrigin } from "@infrawrench/git-contract";
import { badRequest, conflict, defineMockHandlers, notFound, ok, unprocessable } from "../define";
import { requireUser } from "../db";
import {
  newT3Id,
  signInT3,
  t3Environments,
  t3ProjectDefaults,
  t3Providers,
  t3Threads,
} from "../t3-data";

const LOCALHOST =
  "git.infrawrench.com cannot reach an environment on localhost. Link T3 Connect in T3 Code and use the public https address it gives.";

/** The origin of what was typed, refused the way the API refuses it. */
const originOf = (typed: string): string => {
  const value = typed.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw badRequest("That is not an address");
  }
  if (url.hostname === "localhost" || /^127\./.test(url.hostname)) throw badRequest(LOCALHOST);
  if (url.protocol !== "https:") throw badRequest("The address has to start with https://");
  return url.origin;
};

/** The origin of a pasted T3 Connect address, refused the way the API refuses it. */
const connectOriginOf = (pasted: string): string => {
  const found = t3ConnectOrigin(pasted);
  if ("origin" in found) return found.origin;
  throw badRequest(
    found.problem === "not-https"
      ? "The address has to start with https://"
      : found.problem === "empty"
        ? "That is not an address"
        : T3_CONNECT_REFUSAL,
  );
};

const find = (environmentId: string) => {
  requireUser();
  const environment = t3Environments.find((each) => each.id === environmentId);
  if (!environment) throw notFound("No such environment");
  return environment;
};

export default defineMockHandlers({
  t3: {
    list: () => {
      requireUser();
      return { environments: t3Environments };
    },
    create: ({ payload }) => {
      requireUser();
      const baseUrl =
        payload.via === "t3-connect" ? connectOriginOf(payload.baseUrl) : originOf(payload.baseUrl);
      if (t3Environments.some((each) => each.baseUrl === baseUrl)) {
        throw conflict("You already have an environment at that address");
      }
      const now = new Date().toISOString();
      const environment = {
        id: newT3Id(),
        label: payload.label.trim(),
        baseUrl,
        status: "pending" as const,
        scopes: [],
        tokenExpiresAt: null,
        lastError: null,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      t3Environments.push(environment);
      return environment;
    },
    update: ({ params, payload }) => {
      const environment = find(params.environmentId);
      if (payload.label !== undefined) {
        if (payload.label.trim() === "") throw badRequest("Give the environment a name");
        environment.label = payload.label.trim();
        environment.updatedAt = new Date().toISOString();
      }
      return environment;
    },
    remove: ({ params }) => {
      const environment = find(params.environmentId);
      t3Environments.splice(t3Environments.indexOf(environment), 1);
      return ok;
    },
    // The mock has no environment to send the browser to: the sign-in is
    // done on the spot and the page comes straight back, as the callback would send it.
    beginOAuth: ({ params, payload }) => {
      const environment = find(params.environmentId);
      signInT3(environment);
      const back = payload.returnTo?.startsWith("/") ? payload.returnTo : "/settings/t3";
      return { authorizeUrl: `${back}${back.includes("?") ? "&" : "?"}t3=connected` };
    },
    listThreads: ({ params, query }) => {
      const environment = find(params.environmentId);
      if (environment.status !== "connected") {
        throw unprocessable("Sign in to this environment first");
      }
      const wanted = (query?.q ?? "").trim().toLowerCase();
      return {
        threads: (t3Threads[environment.id] ?? []).filter((thread) =>
          thread.title.toLowerCase().includes(wanted),
        ),
      };
    },
    listModels: ({ params, query }) => {
      const environment = find(params.environmentId);
      if (environment.status !== "connected") {
        throw unprocessable("Sign in to this environment first");
      }
      const repository = `${query?.owner ?? ""}/${query?.repo ?? ""}`;
      return {
        providers: t3Providers,
        default: t3ProjectDefaults[environment.id]?.[repository] ?? null,
      };
    },
  },
});
