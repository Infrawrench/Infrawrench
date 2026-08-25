import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ProbeStatus = z.enum(["up", "down", "unknown"]);

const StatusComponentState = z.enum(["operational", "degraded", "down", "unknown"]).openapi({
  description:
    "A component's public state. A paused probe reads `unknown` regardless of its last " +
    "result — the page is a claim about what is being checked now.",
});

const StatusPageState = z.enum(["operational", "degraded", "major_outage", "unknown"]).openapi({
  description:
    "Rollup over the components. `degraded` means some but not all are down; components with " +
    "no data are ignored rather than dragging the page to unknown.",
});

export function registerStatusPagePaths(ctx: BuildContext) {
  const { registry } = ctx;

  const StatusPageComponent = strict({
    id: Uuid,
    probeId: Uuid,
    label: z.string().nullable().describe("Public name; null falls back to the probe's own name."),
    groupName: z.string().nullable(),
    position: z.number().int().describe("Ascending display order."),
    probeName: z.string().describe("The probe's internal name — editor-only."),
    probeStatus: ProbeStatus,
    probeEnabled: z.boolean().describe("False when the probe is paused."),
  }).openapi("StatusPageComponent");

  const StatusPageHostnameVerification = strict({
    cnameTarget: z
      .string()
      .describe("Target of the customer's CNAME (e.g. statuspages.infrawrench.com)."),
    txtName: z.string().optional().describe("Ownership TXT name, when Cloudflare asked for one."),
    txtValue: z.string().optional().describe("Ownership TXT value, when Cloudflare asked for one."),
  }).openapi("StatusPageHostnameVerification");

  const StatusPageCustomHostnameStatus = z
    .enum(["none", "pending_dns", "pending_ssl", "active", "error"])
    .openapi("StatusPageCustomHostnameStatus");

  const StatusPage = strict({
    id: Uuid,
    slug: z
      .string()
      .describe(
        "The public URL segment on the app host, and the page's access credential there. " +
          "Generated with real entropy rather than derived from the title.",
      ),
    title: z.string(),
    description: z.string().nullable(),
    published: z
      .boolean()
      .describe("False until deliberately published; a fresh page is never reachable."),
    showHistory: z.boolean(),
    showUptime: z.boolean(),
    supportUrl: z.string().nullable(),
    customHostname: z
      .string()
      .nullable()
      .describe("Vanity subdomain (e.g. status.acme.com), or null when none is attached."),
    customHostnameStatus: StatusPageCustomHostnameStatus,
    customHostnameError: z.string().nullable(),
    customHostnameVerification: StatusPageHostnameVerification.nullable(),
    components: z.array(StatusPageComponent),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("StatusPage");

  const StatusPageCustomHostnameAttach = strict({
    hostname: z
      .string()
      .describe("Subdomain to attach, e.g. status.example.com. Apex domains are not supported."),
  }).openapi("StatusPageCustomHostnameAttach");

  const StatusPageList = strict({ pages: z.array(StatusPage) }).openapi("StatusPageListResponse");

  const StatusPageComponentInput = strict({
    probeId: Uuid,
    label: z.string().nullable().optional(),
    groupName: z.string().nullable().optional(),
  }).openapi("StatusPageComponentInput");

  const StatusPageCreate = strict({
    title: z.string(),
    description: z.string().nullable().optional(),
    published: z.boolean().optional().describe("Defaults to false."),
    showHistory: z.boolean().optional(),
    showUptime: z.boolean().optional(),
    supportUrl: z.string().nullable().optional(),
    components: z
      .array(StatusPageComponentInput)
      .optional()
      .describe("Order is significant — it is the public render order."),
  }).openapi("StatusPageCreate");

  const StatusPagePatch = strict({
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    published: z.boolean().optional(),
    showHistory: z.boolean().optional(),
    showUptime: z.boolean().optional(),
    supportUrl: z.string().nullable().optional(),
    components: z
      .array(StatusPageComponentInput)
      .optional()
      .describe("When present, replaces the whole set."),
  }).openapi("StatusPagePatch");

  const StatusHistoryDay = strict({
    day: z.string().describe("`YYYY-MM-DD`, UTC.").openapi({ example: "2026-08-07" }),
    uptime: z
      .number()
      .nullable()
      .describe(
        "Fraction of the day the endpoint was up (0–1), or null when nothing was recorded.",
      ),
  }).openapi("StatusHistoryDay");

  const PublicStatusComponent = strict({
    id: Uuid.describe("Stable per page. Deliberately not the probe id."),
    name: z.string(),
    groupName: z.string().nullable(),
    state: StatusComponentState,
    uptime24h: z.number().nullable(),
    history: z.array(StatusHistoryDay).describe("Oldest first; empty when history is hidden."),
  }).openapi("PublicStatusComponent");

  const PublicStatusPage = strict({
    title: z.string(),
    description: z.string().nullable(),
    state: StatusPageState,
    summary: z.string().describe("One sentence describing `state`."),
    components: z.array(PublicStatusComponent),
    supportUrl: z.string().nullable(),
    showHistory: z.boolean(),
    showUptime: z.boolean(),
    historyDays: z.number().int(),
    generatedAt: IsoDateTime,
  }).openapi("PublicStatusPage");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/status-pages",
    tags: ["Status pages"],
    summary: "List status pages",
    description:
      "Every status page in the organization, with the probes each publishes and whether it is " +
      "currently reachable.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's status pages",
        content: { "application/json": { schema: StatusPageList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/status-pages",
    tags: ["Status pages"],
    summary: "Create a status page",
    description:
      "Creates a page with a freshly generated slug. `published` defaults to false, so creating " +
      "a page never exposes anything — publish it as a separate, deliberate step.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: StatusPageCreate } } },
    },
    responses: {
      201: {
        description: "The created page",
        content: { "application/json": { schema: StatusPage } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/status-pages/{id}",
    tags: ["Status pages"],
    summary: "Update a status page",
    description:
      "Omitted fields keep their value. `components`, when present, replaces the whole ordered " +
      "set — which is also how a reorder is expressed.",
    request: {
      params: OrgIdParam.extend({ id: Uuid }),
      body: { content: { "application/json": { schema: StatusPagePatch } } },
    },
    responses: {
      200: {
        description: "The updated page",
        content: { "application/json": { schema: StatusPage } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/status-pages/{id}/rotate-slug",
    tags: ["Status pages"],
    summary: "Issue a new public link",
    description:
      "Replaces the slug, revoking the current public URL immediately — the reroll for a link " +
      "that ended up somewhere unintended. The page stays published. If a custom hostname is " +
      "attached, its hostname→slug mapping is updated so the vanity URL keeps working.",
    request: { params: OrgIdParam.extend({ id: Uuid }) },
    responses: {
      200: {
        description: "The page, with its new slug",
        content: { "application/json": { schema: StatusPage } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/status-pages/{id}/custom-hostname",
    tags: ["Status pages"],
    summary: "Attach a custom domain",
    description:
      "Creates a Cloudflare Custom Hostname for a subdomain and returns the DNS records the " +
      "customer must add. Paid plan only. Apex domains are rejected. At most one hostname per page.",
    request: {
      params: OrgIdParam.extend({ id: Uuid }),
      body: { content: { "application/json": { schema: StatusPageCustomHostnameAttach } } },
    },
    responses: {
      200: {
        description: "The page with custom-hostname fields populated",
        content: { "application/json": { schema: StatusPage } },
      },
      400: ErrorResponses[400],
      402: ErrorResponses[402],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/status-pages/{id}/custom-hostname/refresh",
    tags: ["Status pages"],
    summary: "Refresh custom domain status",
    description:
      "Re-fetches Cloudflare hostname and certificate status and updates the page record.",
    request: { params: OrgIdParam.extend({ id: Uuid }) },
    responses: {
      200: {
        description: "The page with refreshed custom-hostname fields",
        content: { "application/json": { schema: StatusPage } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/status-pages/{id}/custom-hostname",
    tags: ["Status pages"],
    summary: "Detach a custom domain",
    description:
      "Removes the Cloudflare Custom Hostname and the edge hostname→slug mapping. The secret " +
      "slug URL is unaffected.",
    request: { params: OrgIdParam.extend({ id: Uuid }) },
    responses: {
      200: {
        description: "The page with custom-hostname fields cleared",
        content: { "application/json": { schema: StatusPage } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/status-pages/{id}",
    tags: ["Status pages"],
    summary: "Delete a status page",
    description: "The page's link stops working. The probes it published are untouched.",
    request: { params: OrgIdParam.extend({ id: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/status/{slug}",
    tags: ["Status pages"],
    summary: "Read a public status page",
    // Opts out of the document's global `security`, which would otherwise
    // advertise bearer/cookie auth this route neither wants nor reads — and
    // make generated clients attach a token to an anonymous endpoint.
    security: [],
    description:
      "**Unauthenticated.** The only endpoint in this API that takes no credentials — a status " +
      "page exists for people with no account. The payload carries labels, states and uptime " +
      "history only: probe URLs, resource and account ids, the organization id and error detail " +
      "are never included. An unpublished page and an unknown slug both answer 404, so the " +
      "endpoint cannot be used to confirm that a slug is real.",
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: {
        description: "The public status snapshot",
        content: { "application/json": { schema: PublicStatusPage } },
      },
      404: ErrorResponses[404],
    },
  });
}
