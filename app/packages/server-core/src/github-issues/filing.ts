/**
 * Filing findings as GitHub issues, deduplicated by fingerprint.
 *
 * The lifecycle a finding's issue goes through:
 *
 *   1. **File.** The first filing opens an issue in the routed repository with
 *      the evidence, the money and the remediation, plus a hidden marker
 *      (`<!-- infrawrench-finding:<fingerprint> -->`) naming the finding.
 *   2. **Refile = comment.** Filing the same finding again (a person clicking
 *      on a second surface, a routing rule re-raising it) finds the open issue
 *      and comments on it instead of opening another. The open link is the
 *      fast path; the marker search is the fallback for a link we lost.
 *   3. **Resolve.** When the savings scan stops seeing a finding (or an
 *      anomaly is acknowledged) the issue is closed with a comment, or only
 *      commented on, per the org's `resolveAction`.
 *
 * A partial unique index (one *open* link per org + fingerprint) is the
 * database half of step 2, so two replicas racing the same routed alert
 * produce one issue and one comment rather than two issues.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  extractRecordTags,
  githubSourceKindLabel,
  resolveGithubIssueRoute,
  type GithubIssueLink,
  type GithubIssueRouteResolution,
  type GithubIssueSettings,
  type GithubIssueSourceKind,
  type GithubRepoRef,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { costAllocationRules, githubIssueLinks, resources } from "../db/schema.js";
import {
  GithubApiError,
  closeIssue,
  commentOnIssue,
  createIssue,
  findOpenIssueByMarker,
  getIssue,
} from "../github/issues-api.js";
import { getIacResourceStatus } from "../iac/service.js";
import { getGithubIssueSettings, orgInstallationIds } from "./settings.js";

/** What a finding carries into an issue. Built by a UI row or an alert raise site. */
export interface GithubFinding {
  sourceKind: GithubIssueSourceKind;
  sourceId: string;
  title: string;
  details?: Array<{ label: string; value: string | number | null | undefined }> | undefined;
  note?: string | undefined;
  resourceId?: string | undefined;
  monthlyCost?: { amount: number; currency: string } | undefined;
  remediation?: string[] | undefined;
  appUrl?: string | null | undefined;
}

export class GithubFilingError extends Error {
  readonly status: 400 | 404 | 409 | 502;
  constructor(message: string, status: 400 | 404 | 409 | 502 = 400) {
    super(message);
    this.name = "GithubFilingError";
    this.status = status;
  }
}

/**
 * Stable, org-scoped identity of a finding. Org-scoped so two organizations
 * filing into one shared repository never comment on each other's issues.
 */
export function findingFingerprint(
  organizationId: string,
  sourceKind: string,
  sourceId: string,
): string {
  return createHash("sha256")
    .update(`${organizationId}\x00${sourceKind}\x00${sourceId}`)
    .digest("hex")
    .slice(0, 24);
}

export function findingMarker(fingerprint: string): string {
  return `infrawrench-finding:${fingerprint}`;
}

function cell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 500);
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export interface IssueBodyContext {
  fingerprint: string;
  autoFiled: boolean;
  terraform?: { address: string; stateLabel: string | null } | null;
}

/**
 * The issue body: markdown, with the evidence as a table. Pure, so the
 * exact text an issue gets is pinned by tests rather than discovered on
 * GitHub.
 */
export function buildGithubIssueBody(finding: GithubFinding, ctx: IssueBodyContext): string {
  const out: string[] = [];
  out.push(`<!-- ${findingMarker(ctx.fingerprint)} -->`);
  out.push(`**${githubSourceKindLabel(finding.sourceKind)}** found by Infrawrench.`);
  out.push("");
  out.push(`> ${cell(finding.title)}`);

  const rows = (finding.details ?? []).filter(
    (d) => d.value !== null && d.value !== undefined && d.value !== "",
  );
  if (finding.monthlyCost) {
    rows.push({
      label: "Monthly cost",
      value: formatMoney(finding.monthlyCost.amount, finding.monthlyCost.currency),
    });
  }
  if (rows.length > 0) {
    out.push("");
    out.push("| Evidence | |");
    out.push("| --- | --- |");
    for (const row of rows)
      out.push(`| ${cell(row.label)} | ${cell(row.value as string | number)} |`);
  }
  if (finding.note?.trim()) {
    out.push("");
    out.push(finding.note.trim());
  }
  const commands = (finding.remediation ?? []).filter((c) => c.trim().length > 0);
  if (commands.length > 0) {
    out.push("");
    out.push("### Remediation");
    out.push("");
    out.push("Review before running:");
    out.push("");
    out.push("```sh");
    // A fence inside a command would end the block early.
    for (const c of commands) out.push(c.replace(/```/g, "'''"));
    out.push("```");
  }
  if (ctx.terraform) {
    out.push("");
    out.push(
      `Managed by Terraform as \`${ctx.terraform.address}\`${
        ctx.terraform.stateLabel ? ` (state "${cell(ctx.terraform.stateLabel)}")` : ""
      }: change it there rather than in the console, or the next apply reverts the fix.`,
    );
  }
  if (finding.appUrl) {
    out.push("");
    out.push(`[View in Infrawrench](${finding.appUrl})`);
  }
  out.push("");
  out.push(
    `<sub>${
      ctx.autoFiled
        ? "Filed automatically by an Infrawrench alert routing rule."
        : "Filed from Infrawrench."
    } Filing this finding again comments here rather than opening a new issue.</sub>`,
  );
  return out.join("\n").slice(0, 60_000);
}

function toLink(row: typeof githubIssueLinks.$inferSelect): GithubIssueLink {
  return {
    id: row.id,
    sourceKind: row.sourceKind as GithubIssueSourceKind,
    sourceId: row.sourceId,
    fingerprint: row.fingerprint,
    repo: row.repo,
    installationId: row.installationId,
    issueNumber: row.issueNumber,
    issueUrl: row.issueUrl,
    state: row.state === "closed" ? "closed" : "open",
    autoFiled: row.autoFiled,
    pullRequestNumber: row.pullRequestNumber,
    pullRequestUrl: row.pullRequestUrl,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/** What routing knows about a resource: its tags and its cost centre. */
async function resourceRouteFacts(
  organizationId: string,
  resourceId: string | undefined,
): Promise<{ tags: Record<string, string> | null; costCentreId: string | null }> {
  if (!resourceId) return { tags: null, costCentreId: null };
  const [row] = await db
    .select({
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      fieldsJson: resources.fieldsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, resourceId)))
    .limit(1);
  if (!row) return { tags: null, costCentreId: null };
  const tags = extractRecordTags((row.fieldsJson ?? {}) as Record<string, unknown>);

  // The resource's cost centre is the first allocation rule (by priority) that
  // matches what we know about it. Rules matching on `service` cannot be
  // judged from a resource, so they never match here rather than guessing.
  const rules = await db
    .select({ costCentreId: costAllocationRules.costCentreId, match: costAllocationRules.match })
    .from(costAllocationRules)
    .where(eq(costAllocationRules.organizationId, organizationId))
    .orderBy(asc(costAllocationRules.priority), asc(costAllocationRules.createdAt));
  let costCentreId: string | null = null;
  for (const rule of rules) {
    const m = rule.match ?? {};
    if (m.service) continue;
    if (m.accountId && m.accountId !== row.accountId) continue;
    if (m.pluginId && m.pluginId !== row.pluginId) continue;
    if (m.tagKey) {
      if (!tags || !(m.tagKey in tags)) continue;
      if (m.tagValue !== undefined && m.tagValue !== "" && tags[m.tagKey] !== m.tagValue) continue;
    }
    costCentreId = rule.costCentreId;
    break;
  }
  return { tags, costCentreId };
}

/** Where a finding about `resourceId` would be filed. */
export async function resolveFindingRoute(
  organizationId: string,
  resourceId: string | undefined,
  settings?: GithubIssueSettings,
): Promise<GithubIssueRouteResolution> {
  const s = settings ?? (await getGithubIssueSettings(organizationId));
  const facts = await resourceRouteFacts(organizationId, resourceId);
  return resolveGithubIssueRoute(s, facts);
}

async function terraformContext(
  organizationId: string,
  resourceId: string | undefined,
): Promise<{ address: string; stateLabel: string | null } | null> {
  if (!resourceId) return null;
  try {
    const status = await getIacResourceStatus(organizationId, resourceId);
    if ((status.status === "managed" || status.status === "drifted") && status.terraformAddress) {
      return { address: status.terraformAddress, stateLabel: status.stateLabel };
    }
  } catch (err) {
    console.warn(`[github-issues] IaC lookup failed for ${resourceId}:`, err);
  }
  return null;
}

export interface FileFindingOptions {
  userId: string | null;
  autoFiled: boolean;
  repo?: GithubRepoRef | undefined;
  labels?: string[] | undefined;
  assignees?: string[] | undefined;
}

export interface FileFindingResult {
  action: "created" | "commented";
  link: GithubIssueLink;
}

async function openLinkFor(
  organizationId: string,
  fingerprint: string,
): Promise<typeof githubIssueLinks.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(githubIssueLinks)
    .where(
      and(
        eq(githubIssueLinks.organizationId, organizationId),
        eq(githubIssueLinks.fingerprint, fingerprint),
        eq(githubIssueLinks.state, "open"),
      ),
    )
    .limit(1);
  return row;
}

function refileComment(finding: GithubFinding, autoFiled: boolean): string {
  const lines = [
    autoFiled
      ? "Infrawrench detected this finding again."
      : "This finding was filed again from Infrawrench.",
  ];
  if (finding.monthlyCost) {
    lines.push(
      `Current monthly cost: ${formatMoney(finding.monthlyCost.amount, finding.monthlyCost.currency)}.`,
    );
  }
  if (finding.note?.trim()) lines.push("", finding.note.trim());
  if (finding.appUrl) lines.push("", `[View in Infrawrench](${finding.appUrl})`);
  return lines.join("\n");
}

/**
 * File one finding. Comments on its open issue when there is one; opens a new
 * issue otherwise. Throws {@link GithubFilingError} for configuration problems
 * and {@link GithubApiError} for GitHub's own refusals (a missing permission
 * among them), which the route maps onto statuses.
 */
export async function fileFindingToGithub(
  organizationId: string,
  finding: GithubFinding,
  options: FileFindingOptions,
): Promise<FileFindingResult> {
  const settings = await getGithubIssueSettings(organizationId);
  if (!settings.enabled) {
    throw new GithubFilingError("GitHub issue filing is turned off for this organization.", 409);
  }
  const fingerprint = findingFingerprint(organizationId, finding.sourceKind, finding.sourceId);

  // 1. Our own open link: comment, unless GitHub says it was closed meanwhile.
  const existing = await openLinkFor(organizationId, fingerprint);
  if (existing) {
    const issue = await getIssue(existing.installationId, existing.repo, existing.issueNumber);
    if (issue && issue.state === "open") {
      await commentOnIssue(
        existing.installationId,
        existing.repo,
        existing.issueNumber,
        refileComment(finding, options.autoFiled),
      );
      const [touched] = await db
        .update(githubIssueLinks)
        .set({ updatedAt: new Date(), resolvedAt: null })
        .where(eq(githubIssueLinks.id, existing.id))
        .returning();
      return { action: "commented", link: toLink(touched ?? existing) };
    }
    // Closed or gone on GitHub: the finding is back, so it gets a new issue.
    await db
      .update(githubIssueLinks)
      .set({
        state: "closed",
        updatedAt: new Date(),
        resolvedAt: existing.resolvedAt ?? new Date(),
      })
      .where(eq(githubIssueLinks.id, existing.id));
  }

  const route = await resolveFindingRoute(organizationId, finding.resourceId, settings);
  const repo = options.repo ?? route.repo;
  if (!repo) {
    throw new GithubFilingError("Choose a default repository in Settings → GitHub issues first.");
  }
  if (!(await orgInstallationIds(organizationId)).has(repo.installationId)) {
    throw new GithubFilingError("That GitHub installation is not connected to this organization.");
  }
  const labels = options.labels ?? route.labels;
  const assignees = options.assignees ?? route.assignees;

  // 2. An open issue carrying the marker that our table lost track of.
  const marked = await findOpenIssueByMarker(
    repo.installationId,
    repo.fullName,
    findingMarker(fingerprint),
  );
  if (marked) {
    await commentOnIssue(
      repo.installationId,
      repo.fullName,
      marked.number,
      refileComment(finding, options.autoFiled),
    );
    const link = await insertLink(organizationId, finding, fingerprint, repo, marked, options);
    return { action: "commented", link };
  }

  // 3. A new issue.
  const body = buildGithubIssueBody(finding, {
    fingerprint,
    autoFiled: options.autoFiled,
    terraform: await terraformContext(organizationId, finding.resourceId),
  });
  // The shared draft builder already prefixes the kind; do not do it twice.
  const prefix = `${githubSourceKindLabel(finding.sourceKind)}: `;
  const title = finding.title.startsWith(prefix) ? finding.title : `${prefix}${finding.title}`;
  const issue = await createIssue(repo.installationId, repo.fullName, {
    title,
    body,
    labels,
    assignees,
  });
  const link = await insertLink(organizationId, finding, fingerprint, repo, issue, options);
  return { action: "created", link };
}

async function insertLink(
  organizationId: string,
  finding: GithubFinding,
  fingerprint: string,
  repo: GithubRepoRef,
  issue: { number: number; url: string },
  options: FileFindingOptions,
): Promise<GithubIssueLink> {
  const [row] = await db
    .insert(githubIssueLinks)
    .values({
      id: randomUUID(),
      organizationId,
      sourceKind: finding.sourceKind,
      sourceId: finding.sourceId,
      fingerprint,
      installationId: repo.installationId,
      repo: repo.fullName,
      issueNumber: issue.number,
      issueUrl: issue.url,
      autoFiled: options.autoFiled,
      createdByUserId: options.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return toLink(row);
  // Lost a race with another replica filing the same finding: theirs stands.
  const winner = await openLinkFor(organizationId, fingerprint);
  if (!winner) throw new GithubFilingError("Failed to record the GitHub issue link", 502);
  return toLink(winner);
}

export interface ListGithubIssueLinksFilter {
  sourceKind?: GithubIssueSourceKind | undefined;
  sourceIds?: readonly string[] | undefined;
  state?: "open" | "closed" | undefined;
}

/** Links for a list view, newest first. Ambient: never throws. */
export async function listGithubIssueLinks(
  organizationId: string,
  filter: ListGithubIssueLinksFilter = {},
): Promise<GithubIssueLink[]> {
  try {
    const conditions = [eq(githubIssueLinks.organizationId, organizationId)];
    if (filter.sourceKind) conditions.push(eq(githubIssueLinks.sourceKind, filter.sourceKind));
    if (filter.state) conditions.push(eq(githubIssueLinks.state, filter.state));
    if (filter.sourceIds && filter.sourceIds.length > 0) {
      conditions.push(inArray(githubIssueLinks.sourceId, [...filter.sourceIds]));
    }
    const rows = await db
      .select()
      .from(githubIssueLinks)
      .where(and(...conditions))
      .orderBy(desc(githubIssueLinks.createdAt))
      .limit(2000);
    return rows.map(toLink);
  } catch (err) {
    console.error("[github-issues] failed to list links for org", organizationId, err);
    return [];
  }
}

/** Attach a pull request to a finding's open link, when it has one. */
export async function attachPullRequestToLink(
  organizationId: string,
  sourceKind: GithubIssueSourceKind,
  sourceId: string,
  pullRequest: { number: number; url: string },
): Promise<GithubIssueLink | null> {
  const fingerprint = findingFingerprint(organizationId, sourceKind, sourceId);
  const existing = await openLinkFor(organizationId, fingerprint);
  if (!existing) return null;
  const [row] = await db
    .update(githubIssueLinks)
    .set({
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      updatedAt: new Date(),
    })
    .where(eq(githubIssueLinks.id, existing.id))
    .returning();
  await commentOnIssue(
    existing.installationId,
    existing.repo,
    existing.issueNumber,
    `Infrawrench opened a pull request for this finding: ${pullRequest.url}`,
  ).catch((err: unknown) => console.warn("[github-issues] PR comment failed:", err));
  return row ? toLink(row) : null;
}

/**
 * The finding behind these links is gone. Close with a comment, or only
 * comment, per the org's `resolveAction`; `none` leaves the issue alone and
 * only records it. Each link is acted on once (`resolvedAt` guards a repeat
 * comment every scan). Never throws: this runs from the poller and from an
 * acknowledgement route that must not fail because GitHub did.
 */
export async function resolveFindingIssues(
  organizationId: string,
  findings: ReadonlyArray<{ sourceKind: GithubIssueSourceKind; sourceId: string }>,
  reason: string,
): Promise<{ closed: number; commented: number }> {
  const result = { closed: 0, commented: 0 };
  if (findings.length === 0) return result;
  let settings: GithubIssueSettings;
  try {
    settings = await getGithubIssueSettings(organizationId);
  } catch (err) {
    console.error("[github-issues] settings read failed while resolving:", err);
    return result;
  }
  const fingerprints = findings.map((f) =>
    findingFingerprint(organizationId, f.sourceKind, f.sourceId),
  );
  let rows: Array<typeof githubIssueLinks.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(githubIssueLinks)
      .where(
        and(
          eq(githubIssueLinks.organizationId, organizationId),
          eq(githubIssueLinks.state, "open"),
          isNull(githubIssueLinks.resolvedAt),
          inArray(githubIssueLinks.fingerprint, fingerprints),
        ),
      );
  } catch (err) {
    console.error("[github-issues] link read failed while resolving:", err);
    return result;
  }
  for (const row of rows) {
    try {
      const now = new Date();
      if (settings.resolveAction !== "none") {
        await commentOnIssue(
          row.installationId,
          row.repo,
          row.issueNumber,
          `Infrawrench no longer sees this finding: ${reason}${
            settings.resolveAction === "close" ? " Closing." : ""
          }`,
        );
        if (settings.resolveAction === "close") {
          await closeIssue(row.installationId, row.repo, row.issueNumber);
        }
      }
      await db
        .update(githubIssueLinks)
        .set({
          resolvedAt: now,
          updatedAt: now,
          ...(settings.resolveAction === "close" ? { state: "closed" } : {}),
        })
        .where(eq(githubIssueLinks.id, row.id));
      if (settings.resolveAction === "close") result.closed += 1;
      else if (settings.resolveAction === "comment") result.commented += 1;
    } catch (err) {
      const detail = err instanceof GithubApiError ? err.message : err;
      console.error(`[github-issues] resolving ${row.repo}#${row.issueNumber} failed:`, detail);
    }
  }
  return result;
}

/** Clear `resolvedAt` on open links whose finding reappeared, so a later resolve acts again. */
export async function reopenResolvedLinks(
  organizationId: string,
  findings: ReadonlyArray<{ sourceKind: GithubIssueSourceKind; sourceId: string }>,
): Promise<void> {
  if (findings.length === 0) return;
  const fingerprints = findings.map((f) =>
    findingFingerprint(organizationId, f.sourceKind, f.sourceId),
  );
  for (let i = 0; i < fingerprints.length; i += 500) {
    await db
      .update(githubIssueLinks)
      .set({ resolvedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(githubIssueLinks.organizationId, organizationId),
          eq(githubIssueLinks.state, "open"),
          isNotNull(githubIssueLinks.resolvedAt),
          inArray(githubIssueLinks.fingerprint, fingerprints.slice(i, i + 500)),
        ),
      );
  }
}
