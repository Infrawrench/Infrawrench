import type { ResourceInstance } from "@infrawrench/plugin-base";
import { makeInstance } from "./kit.js";
import type {
  HkAddon,
  HkApp,
  HkCoupling,
  HkDomain,
  HkDyno,
  HkFormation,
  HkLogDrain,
  HkPipeline,
  HkRelease,
  HkReviewApp,
  HkSniEndpoint,
  HkSpace,
  HkTeam,
} from "./types.js";

/** Pure mapping from Heroku payloads to host resource instances. */

type AppRef = { id: string; name: string };

function mb(bytes: number | null | undefined): number | undefined {
  return typeof bytes === "number" ? Math.round((bytes / 1_000_000) * 10) / 10 : undefined;
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function mapTeam(t: HkTeam, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "team",
    externalId: t.id,
    displayName: t.name,
    fields: {
      name: t.name,
      role: t.role ?? "",
      type: t.type ?? "",
      ...(t.default !== undefined ? { default: t.default } : {}),
      enterpriseAccount: t.enterprise_account?.name ?? "",
    },
    outputs: { teamId: t.id },
    ...(t.created_at ? { createdAt: t.created_at } : {}),
  });
}

export function mapApp(a: HkApp, accountId: string): ResourceInstance {
  const slug = mb(a.slug_size);
  const repo = mb(a.repo_size);
  return makeInstance({
    accountId,
    typeId: "app",
    externalId: a.id,
    displayName: a.name,
    fields: {
      name: a.name,
      region: a.region?.name ?? "",
      stack: a.stack?.name ?? "",
      buildStack: a.build_stack?.name ?? "",
      generation: a.generation?.name ?? "",
      ...(a.maintenance !== undefined ? { maintenance: a.maintenance } : {}),
      ...(a.acm !== undefined ? { acm: a.acm } : {}),
      team: a.team?.name ?? "",
      teamId: a.team?.id ?? "",
      owner: a.owner?.email ?? "",
      space: a.space?.name ?? "",
      spaceId: a.space?.id ?? "",
      ...(typeof a.internal_routing === "boolean" ? { internalRouting: a.internal_routing } : {}),
      webUrl: a.web_url ?? "",
      gitUrl: a.git_url ?? "",
      buildpack: a.buildpack_provided_description ?? "",
      ...(slug !== undefined ? { slugSizeMb: slug } : {}),
      ...(repo !== undefined ? { repoSizeMb: repo } : {}),
      releasedAt: a.released_at ?? "",
      createdAt: a.created_at ?? "",
    },
    outputs: { appName: a.name, appId: a.id, webUrl: a.web_url ?? "", hostname: hostOf(a.web_url) },
    ...(a.created_at ? { createdAt: a.created_at } : {}),
    ...(a.updated_at ? { updatedAt: a.updated_at } : {}),
  });
}

function child(app: AppRef) {
  return { appId: app.id, appName: app.name };
}

export function mapFormation(fm: HkFormation, app: AppRef, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "formation",
    externalId: `${app.id}/${fm.type}`,
    displayName: `${app.name} ${fm.type}`,
    fields: {
      type: fm.type,
      quantity: fm.quantity,
      size: fm.dyno_size?.name ?? fm.size ?? "",
      command: fm.command ?? "",
      running: fm.quantity > 0,
      ...child(app),
      updatedAt: fm.updated_at ?? "",
    },
    parentTypeId: "app",
    parentExternalId: app.id,
    ...(fm.created_at ? { createdAt: fm.created_at } : {}),
    ...(fm.updated_at ? { updatedAt: fm.updated_at } : {}),
  });
}

export function mapDyno(d: HkDyno, app: AppRef, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "dyno",
    externalId: `${app.id}/${d.id}`,
    displayName: `${app.name} ${d.name}`,
    fields: {
      name: d.name,
      state: d.state ?? "",
      type: d.type ?? "",
      size: d.size ?? "",
      command: d.command ?? "",
      ...(d.release ? { releaseVersion: d.release.version } : {}),
      ...child(app),
      createdAt: d.created_at ?? "",
    },
    parentTypeId: "app",
    parentExternalId: app.id,
    ...(d.created_at ? { createdAt: d.created_at } : {}),
  });
}

export function mapRelease(r: HkRelease, app: AppRef, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "release",
    externalId: `${app.id}/${r.id}`,
    displayName: `${app.name} v${r.version}`,
    fields: {
      version: r.version,
      status: r.status ?? "",
      description: r.description ?? "",
      ...(r.current !== undefined ? { current: r.current } : {}),
      ...(r.eligible_for_rollback !== undefined
        ? { eligibleForRollback: r.eligible_for_rollback }
        : {}),
      user: r.user?.email ?? "",
      addonPlans: (r.addon_plan_names ?? []).join(", "),
      ...child(app),
      createdAt: r.created_at ?? "",
    },
    outputs: { releaseId: r.id },
    parentTypeId: "app",
    parentExternalId: app.id,
    ...(r.created_at ? { createdAt: r.created_at } : {}),
  });
}

export function mapConfigVar(
  key: string,
  app: AppRef,
  addonVars: Map<string, string>,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "config-var",
    externalId: `${app.id}/${key}`,
    displayName: key,
    fields: { key, fromAddon: addonVars.get(key) ?? "", ...child(app) },
    outputs: { key },
    parentTypeId: "app",
    parentExternalId: app.id,
  });
}

export function mapAddon(a: HkAddon, accountId: string): ResourceInstance {
  const cents = a.billed_price?.cents;
  return makeInstance({
    accountId,
    typeId: "add-on",
    externalId: a.id,
    displayName: a.name,
    fields: {
      name: a.name,
      service: a.addon_service?.name ?? "",
      plan: a.plan?.name ?? "",
      state: a.state ?? "",
      ...(typeof cents === "number" ? { priceMonthly: cents / 100 } : {}),
      ...(a.billed_price?.contract !== undefined ? { contract: a.billed_price.contract } : {}),
      billedTo: a.billing_entity?.name ?? "",
      configVars: (a.config_vars ?? []).join(", "),
      appId: a.app?.id ?? "",
      appName: a.app?.name ?? "",
      webUrl: a.web_url ?? "",
      createdAt: a.created_at ?? "",
    },
    outputs: { addonId: a.id, configVarNames: (a.config_vars ?? []).join(", ") },
    ...(a.created_at ? { createdAt: a.created_at } : {}),
    ...(a.updated_at ? { updatedAt: a.updated_at } : {}),
  });
}

export function mapDomain(d: HkDomain, app: AppRef, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "domain",
    externalId: `${app.id}/${d.id}`,
    displayName: d.hostname,
    fields: {
      hostname: d.hostname,
      kind: d.kind ?? "",
      cname: d.cname ?? "",
      status: d.status ?? "",
      acmStatus: d.acm_status ?? "",
      acmStatusReason: d.acm_status_reason ?? "",
      sniEndpointId: d.sni_endpoint?.id ?? "",
      ...child(app),
      createdAt: d.created_at ?? "",
    },
    outputs: { hostname: d.hostname, cname: d.cname ?? "" },
    parentTypeId: "app",
    parentExternalId: app.id,
    ...(d.created_at ? { createdAt: d.created_at } : {}),
  });
}

export function mapSniEndpoint(s: HkSniEndpoint, app: AppRef, accountId: string): ResourceInstance {
  const c = s.ssl_cert ?? {};
  return makeInstance({
    accountId,
    typeId: "sni-endpoint",
    externalId: `${app.id}/${s.id}`,
    displayName: s.display_name || s.name,
    fields: {
      name: s.name,
      subject: c.subject ?? "",
      issuer: c.issuer ?? "",
      certDomains: (c.cert_domains ?? []).join(", "),
      domains: (s.domains ?? []).join(", "),
      expiresAt: c.expires_at ?? "",
      startsAt: c.starts_at ?? "",
      ...(c.self_signed !== undefined ? { selfSigned: c.self_signed } : {}),
      ...child(app),
    },
    parentTypeId: "app",
    parentExternalId: app.id,
    ...(s.created_at ? { createdAt: s.created_at } : {}),
  });
}

export function mapLogDrain(d: HkLogDrain, app: AppRef, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "log-drain",
    externalId: `${app.id}/${d.id}`,
    displayName: d.addon?.name ? `${d.addon.name} drain` : hostOf(d.url) || d.url.slice(0, 60),
    fields: {
      url: d.url,
      token: d.token ?? "",
      addon: d.addon?.name ?? "",
      ...child(app),
      createdAt: d.created_at ?? "",
    },
    parentTypeId: "app",
    parentExternalId: app.id,
    ...(d.created_at ? { createdAt: d.created_at } : {}),
  });
}

export function mapPipeline(
  p: HkPipeline,
  appCount: number,
  reviewApps: boolean | undefined,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "pipeline",
    externalId: p.id,
    displayName: p.name,
    fields: {
      name: p.name,
      ownerType: p.owner?.type ?? "",
      ownerId: p.owner?.id ?? "",
      appCount,
      ...(reviewApps !== undefined ? { reviewApps } : {}),
      generation: p.generation?.name ?? "",
      createdAt: p.created_at ?? "",
    },
    outputs: { pipelineId: p.id },
    ...(p.created_at ? { createdAt: p.created_at } : {}),
  });
}

export function mapCoupling(
  c: HkCoupling,
  pipeline: { id: string; name: string },
  appNames: Map<string, string>,
  accountId: string,
): ResourceInstance {
  const appName = appNames.get(c.app.id) ?? c.app.id;
  return makeInstance({
    accountId,
    typeId: "pipeline-coupling",
    externalId: c.id,
    displayName: `${appName} (${c.stage})`,
    fields: {
      appName,
      stage: c.stage,
      appId: c.app.id,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      createdAt: c.created_at ?? "",
    },
    parentTypeId: "pipeline",
    parentExternalId: pipeline.id,
    ...(c.created_at ? { createdAt: c.created_at } : {}),
  });
}

export function mapReviewApp(
  r: HkReviewApp,
  pipelineId: string,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "review-app",
    externalId: r.id,
    displayName: r.pr_number ? `#${r.pr_number} ${r.branch ?? ""}`.trim() : (r.branch ?? r.id),
    fields: {
      branch: r.branch ?? "",
      ...(typeof r.pr_number === "number" ? { prNumber: r.pr_number } : {}),
      status: r.status ?? "",
      error: r.error_status || r.message || "",
      appId: r.app?.id ?? "",
      pipelineId,
      createdAt: r.created_at ?? "",
    },
    parentTypeId: "pipeline",
    parentExternalId: pipelineId,
    ...(r.created_at ? { createdAt: r.created_at } : {}),
  });
}

export function mapSpace(s: HkSpace, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "space",
    externalId: s.id,
    displayName: s.name,
    fields: {
      name: s.name,
      region: s.region?.name ?? "",
      team: s.team?.name ?? "",
      teamId: s.team?.id ?? "",
      ...(s.shield !== undefined ? { shield: s.shield } : {}),
      state: s.state ?? "",
      cidr: s.cidr ?? "",
      dataCidr: s.data_cidr ?? "",
      generation: s.generation?.name ?? "",
      createdAt: s.created_at ?? "",
    },
    outputs: { spaceId: s.id },
    ...(s.created_at ? { createdAt: s.created_at } : {}),
  });
}
