/**
 * The organization / enterprise picker on the add-account form.
 *
 * Fine-grained tokens and classic tokens see different things, so two
 * sources are asked and merged:
 *
 * - `GET /user/orgs`: organizations the authenticated user belongs to
 *   (classic tokens; fine-grained tokens are not documented for it).
 * - GraphQL `viewer { organizations, enterprises }`: organizations and, for a
 *   token with `read:enterprise`, enterprises (`User.enterprises` in GitHub's
 *   public GraphQL schema, verified 2026-10).
 *
 * Either may fail for a narrowly scoped token; only both failing is an error,
 * and the form then lets the user type the name.
 */

import type { CredentialFieldOption, HostServices } from "@infrawrench/plugin-base";
import type { GitHubHost } from "./api.js";
import { formatOwner, ghFetch, ghGraphql, resolveHost } from "./api.js";

interface ViewerOwners {
  viewer?: {
    organizations?: { nodes?: Array<{ login?: string; name?: string | null } | null> } | null;
    enterprises?: { nodes?: Array<{ slug?: string; name?: string | null } | null> } | null;
  };
}

const OWNERS_QUERY = `query {
  viewer {
    organizations(first: 100) { nodes { login name } }
    enterprises(first: 100) { nodes { slug name } }
  }
}`;

export async function listOwnerOptions(
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  const token = (credentials["token"] ?? "").trim();
  if (!token) throw new Error("Enter a personal access token first.");
  const host: GitHubHost = resolveHost(credentials["host"]);
  const caCert = credentials["caCert"] ?? "";
  const ctx = {
    token,
    host,
    ...(caCert ? { caCert } : {}),
    ...(services?.http ? { http: services.http } : {}),
  };

  const options = new Map<string, CredentialFieldOption>();
  const errors: string[] = [];

  const [rest, graph] = await Promise.allSettled([
    ghFetch<Array<{ login?: string; description?: string | null }>>(ctx, "/user/orgs", {
      query: { per_page: 100 },
    }),
    ghGraphql<ViewerOwners>(ctx, OWNERS_QUERY),
  ]);

  if (graph.status === "fulfilled") {
    for (const e of graph.value.data?.viewer?.enterprises?.nodes ?? []) {
      if (!e?.slug) continue;
      const id = formatOwner({ kind: "enterprise", slug: e.slug });
      options.set(id, { id, label: e.name || e.slug, description: `Enterprise ${e.slug}` });
    }
    for (const o of graph.value.data?.viewer?.organizations?.nodes ?? []) {
      if (!o?.login) continue;
      const id = formatOwner({ kind: "org", slug: o.login });
      options.set(id, { id, label: o.name || o.login, description: `Organization ${o.login}` });
    }
  } else {
    errors.push(graph.reason instanceof Error ? graph.reason.message : String(graph.reason));
  }
  if (rest.status === "fulfilled") {
    for (const o of rest.value ?? []) {
      if (!o.login) continue;
      const id = formatOwner({ kind: "org", slug: o.login });
      if (!options.has(id)) {
        options.set(id, { id, label: o.login, description: `Organization ${o.login}` });
      }
    }
  } else {
    errors.push(rest.reason instanceof Error ? rest.reason.message : String(rest.reason));
  }

  if (options.size === 0) {
    if (errors.some((e) => /\b401\b/.test(e))) {
      throw new Error(`GitHub rejected the token on ${host.host}. Check it has not expired.`);
    }
    throw new Error(
      "This token cannot list your organizations or enterprises. Type the organization name, or enterprise:<slug> for an enterprise.",
    );
  }
  // Enterprises first (they own the bill when there is one), then organizations.
  return [...options.values()].sort((a, b) => {
    const ea = a.id.startsWith("enterprise:") ? 0 : 1;
    const eb = b.id.startsWith("enterprise:") ? 0 : 1;
    return ea - eb || a.label.localeCompare(b.label);
  });
}
