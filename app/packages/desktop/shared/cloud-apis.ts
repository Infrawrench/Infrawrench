/**
 * The contract domains the desktop calls through its cloud transport, by the
 * name the renderer asks for them with (`cloudClient("probes")`).
 *
 * One list for both ends. The renderer derives its typed client from an
 * entry (`src/lib/cloud-client.ts`), and the main process derives its
 * allowlist from every endpoint of every entry (`electron/cloud-allowlist.ts`),
 * so a domain without an entry cannot be called by name, and a request built
 * for it by hand is refused before it leaves the main process. Migrating a
 * `cloud-data/<area>.ts` file adds its domain here; KNOWLEDGE.md ("Desktop
 * IPC on Effect RPC") has the recipe.
 */
import type { Context } from "effect";
import { HttpApi, type HttpApiEndpoint, type HttpApiGroup } from "effect/http-api";
import { ProbesApi, SlosApi } from "@infrawrench/api-contract";

/** One endpoint of a registered domain, as `HttpApi.reflect` walks it. */
export interface DesktopCloudEndpoint {
  readonly group: string;
  readonly endpoint: HttpApiEndpoint.Top;
  /** The API's, group's and endpoint's annotations merged (parse options live here). */
  readonly annotations: Context.Context<never>;
}

/**
 * A registered domain: the `HttpApi` itself, which the renderer's client type
 * is derived from, and its endpoints walked once, which both ends build from
 * at runtime without needing the API's exact type.
 */
export interface DesktopCloudApi<Api> {
  readonly api: Api;
  readonly endpoints: ReadonlyArray<DesktopCloudEndpoint>;
}

function desktopCloudApi<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): DesktopCloudApi<HttpApi.HttpApi<Id, Groups>> {
  const endpoints: Array<DesktopCloudEndpoint> = [];
  HttpApi.reflect(api, {
    onGroup() {},
    onEndpoint({ group, endpoint, mergedAnnotations }) {
      endpoints.push({ group: group.identifier, endpoint, annotations: mergedAnnotations });
    },
  });
  return { api, endpoints };
}

export const DESKTOP_CLOUD_APIS = {
  probes: desktopCloudApi(ProbesApi),
  slos: desktopCloudApi(SlosApi),
} as const;

export type DesktopCloudApis = typeof DESKTOP_CLOUD_APIS;
export type DesktopCloudApiName = keyof DesktopCloudApis;
