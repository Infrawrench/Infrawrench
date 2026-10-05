/**
 * Pull requests for IaC-managed findings: when the resource behind an
 * oversized or orphan finding is managed by Terraform in a repository the org
 * has mapped, and the fix is mechanical, open a PR that edits the HCL.
 *
 * What "mechanical" means here, and everything else is refused with a reason:
 *
 * - **Resize.** The plugin's own Terraform export mapper (`terraformExport`)
 *   is run twice, once on the resource as synced and once with its size field
 *   set to the recommendation; exactly one top-level attribute may differ
 *   (that is the size attribute, derived rather than hard-coded per provider,
 *   the same derivation trick IaC reconciliation uses for its type map). The
 *   block must set that attribute to a plain literal; a variable or expression
 *   is not mechanical.
 * - **Remove.** A confirmed orphan's block is deleted, provided nothing else
 *   in the module references it.
 * - The resource must be addressed as a plain `type.name` in the root module
 *   of the mapped directory: no module prefix, no `count`/`for_each` index.
 *
 * The recommendation is re-checked against the live finding (the cached
 * rightsizing / orphan scan), so a forged size or a resource that is no
 * longer flagged never becomes a PR. Gated by the org's
 * `pullRequestsEnabled`, a per-finding click, and `github-issues:write`;
 * nothing here enables auto-merge.
 */
import { and, eq } from "drizzle-orm";
import type {
  GithubIssueLink,
  GithubPullRequestArgs,
  GithubPullRequestPreview,
  GithubRepoRef,
} from "@infrawrench/client-core";
import type { TerraformValue } from "@infrawrench/plugin-base";

import { db } from "../db/client.js";
import { resources } from "../db/schema.js";
import {
  createBranch,
  createPullRequest,
  deleteFile,
  getBranchSha,
  getDefaultBranch,
  getFile,
  listTreeFiles,
  putFile,
} from "../github/issues-api.js";
import { getIacState } from "../iac/store.js";
import { getIacResourceStatus, loadCapabilities, toResourceInstance } from "../iac/service.js";
import { loadPlugins } from "../plugin-loader.js";
import { listOrphans } from "../savings/orphans.js";
import { listRightsizing } from "../savings/rightsizing.js";
import {
  HclEditError,
  findResourceBlocks,
  referencesResource,
  removeResourceBlock,
  setResourceAttribute,
  unifiedDiff,
  type HclLiteral,
} from "./hcl.js";
import { attachPullRequestToLink, findingFingerprint } from "./filing.js";
import { getGithubIssueSettings, orgInstallationIds } from "./settings.js";

/** Files read from the mapped directory before giving up. */
const MAX_TF_FILES = 200;

interface Plan {
  repo: GithubRepoRef;
  baseBranch: string;
  baseSha: string;
  path: string;
  fileSha: string;
  before: string;
  after: string;
  terraformAddress: string;
  title: string;
  body: string;
  diff: string;
  branchName: string;
}

type PlanResult = { ok: true; plan: Plan } | { ok: false; reason: string };

const refuse = (reason: string): PlanResult => ({ ok: false, reason });

function literalOf(value: TerraformValue | undefined): HclLiteral | null {
  if (!value) return null;
  if (value.kind === "string") return { kind: "string", value: value.value };
  if (value.kind === "number") return { kind: "number", value: value.value };
  return null;
}

function sameValue(a: TerraformValue | undefined, b: TerraformValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

async function plan(organizationId: string, args: GithubPullRequestArgs): Promise<PlanResult> {
  const settings = await getGithubIssueSettings(organizationId);
  if (!settings.pullRequestsEnabled) {
    return refuse("Pull requests are turned off. Enable them in Settings → GitHub issues.");
  }
  if (args.change.kind === "resize" && args.sourceKind !== "oversized") {
    return refuse("Only oversized findings can be resized.");
  }
  if (args.change.kind === "remove" && args.sourceKind !== "orphan") {
    return refuse("Only orphaned resources can be removed.");
  }

  const [row] = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, args.resourceId)))
    .limit(1);
  if (!row) return refuse("That resource no longer exists.");
  const instance = toResourceInstance({
    ...row,
    fieldsJson: (row.fieldsJson ?? {}) as Record<string, unknown>,
    outputsJson: (row.outputsJson ?? {}) as Record<string, unknown>,
  });

  // The finding must still stand.
  let recommendationNote = "";
  if (args.change.kind === "resize") {
    const rightsizing = await listRightsizing(organizationId);
    const flagged = rightsizing.accounts.flatMap((g) => g.resources).find((r) => r.id === row.id);
    if (!flagged) return refuse("This resource is no longer flagged as oversized.");
    if (flagged.recommendedSize.id !== args.change.recommendedSizeId) {
      return refuse("The recommendation has changed since this page loaded. Refresh and retry.");
    }
    recommendationNote =
      `Right-size from **${flagged.currentSize.label}** to **${flagged.recommendedSize.label}**. ` +
      `Over the last ${rightsizing.windowDays} days p95 CPU was ${flagged.cpuP95}%` +
      (flagged.memoryMeasured && flagged.memoryP95 !== null
        ? ` and p95 memory ${flagged.memoryP95}%`
        : " (memory is not measured for this type)") +
      `; projected p95 CPU on the new size is ${flagged.projectedCpuP95}%.` +
      (flagged.monthlySaving !== null
        ? ` Estimated saving: ${flagged.monthlySaving.toFixed(2)} ${flagged.currency}/month.`
        : "") +
      (flagged.resizeNote ? `\n\n> ${flagged.resizeNote}` : "");
  } else {
    const orphans = await listOrphans(organizationId, { includeCosts: true });
    const flagged = orphans.accounts.flatMap((g) => g.resources).find((r) => r.id === row.id);
    if (!flagged) return refuse("This resource is no longer flagged as orphaned.");
    recommendationNote =
      `Remove the orphaned resource. Infrawrench flagged it because: ${flagged.reason}` +
      (flagged.cost
        ? ` It cost ${flagged.cost.amount.toFixed(2)} ${flagged.cost.currency} over the last ${orphans.costWindowDays} days.`
        : "");
  }

  // Managed by Terraform, at a plain root-module address?
  const status = await getIacResourceStatus(organizationId, row.id);
  if (!status.stateId || !status.terraformAddress) {
    return refuse(
      "No uploaded Terraform state manages this resource, so there is no HCL to change.",
    );
  }
  if (status.status !== "managed" && status.status !== "drifted") {
    return refuse("The uploaded Terraform state does not manage this resource.");
  }
  const address = status.terraformAddress;
  const parts = /^([a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(address);
  if (!parts) {
    return refuse(
      `${address} is inside a module or uses count/for_each, so editing it is not a mechanical change.`,
    );
  }
  const [, tfType, tfName] = parts as unknown as [string, string, string];

  const state = await getIacState(organizationId, status.stateId);
  const scope = state?.accountId ?? null;
  const source = settings.iacSources.find((s) => (s.iacAccountId ?? null) === scope);
  if (!source) {
    return refuse(
      `No repository is mapped to the IaC state "${status.stateLabel ?? "unnamed"}". Map one in Settings → GitHub issues.`,
    );
  }
  if (!(await orgInstallationIds(organizationId)).has(source.repo.installationId)) {
    return refuse("The mapped repository's GitHub installation is no longer connected.");
  }

  // Compute the new attribute value before touching GitHub.
  let attribute: { name: string; value: HclLiteral } | null = null;
  if (args.change.kind === "resize") {
    const plugins = await loadPlugins();
    const plugin = plugins.find((p) => p.plugin.manifest.id === row.pluginId)?.plugin;
    const declaration = plugin?.resourceTypes.find((t) => t.id === row.resourceTypeId)?.rightsizing;
    const { capabilityFor } = await loadCapabilities();
    const capability = capabilityFor(row.pluginId);
    if (!declaration || !capability) {
      return refuse("This provider cannot express the resize as Terraform.");
    }
    const before = capability.mapResource(instance);
    const after = capability.mapResource({
      ...instance,
      fields: { ...instance.fields, [declaration.sizeFieldKey]: args.change.recommendedSizeId },
    });
    if (!before || !after) return refuse("This resource cannot be mapped to Terraform.");
    const keys = new Set([
      ...Object.keys(before.resource.attributes),
      ...Object.keys(after.resource.attributes),
    ]);
    const changed = [...keys].filter(
      (k) => !sameValue(before.resource.attributes[k], after.resource.attributes[k]),
    );
    const only = changed.length === 1 ? changed[0]! : null;
    const literal = only ? literalOf(after.resource.attributes[only]) : null;
    if (!only || !literal) {
      return refuse(
        "The resize does not map to a single Terraform attribute, so it is not mechanical.",
      );
    }
    attribute = { name: only, value: literal };
  }

  // Find the block in the mapped directory.
  const repo = source.repo;
  const baseBranch =
    source.baseBranch ?? (await getDefaultBranch(repo.installationId, repo.fullName));
  const baseSha = await getBranchSha(repo.installationId, repo.fullName, baseBranch);
  const tree = await listTreeFiles(repo.installationId, repo.fullName, baseSha);
  const dir = source.directory;
  const tfFiles = tree.paths.filter((p) => {
    if (!p.endsWith(".tf")) return false;
    const rel = dir ? (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : null) : p;
    return rel !== null && !rel.includes("/");
  });
  if (tfFiles.length === 0) {
    return refuse(`No .tf files in ${dir || "the repository root"} on ${baseBranch}.`);
  }
  if (tfFiles.length > MAX_TF_FILES) {
    return refuse(`${dir || "The repository root"} has more than ${MAX_TF_FILES} .tf files.`);
  }

  const contents = new Map<string, { content: string; sha: string }>();
  for (const path of tfFiles) {
    const file = await getFile(repo.installationId, repo.fullName, path, baseSha);
    if (file) contents.set(path, file);
  }
  const holders: string[] = [];
  for (const [path, file] of contents) {
    try {
      if (findResourceBlocks(file.content, tfType, tfName).length > 0) holders.push(path);
    } catch (err) {
      if (err instanceof HclEditError) return refuse(`${path}: ${err.message}`);
      throw err;
    }
  }
  if (holders.length === 0) {
    return refuse(
      `${address} is not declared in ${dir || "the repository root"} on ${baseBranch}.`,
    );
  }
  if (holders.length > 1) return refuse(`${address} is declared in more than one file.`);
  const path = holders[0]!;
  const file = contents.get(path)!;

  let after: string;
  let summary: string;
  try {
    if (attribute) {
      const edited = setResourceAttribute(
        file.content,
        tfType,
        tfName,
        attribute.name,
        attribute.value,
      );
      after = edited.text;
      summary = `Set \`${attribute.name}\` on \`${address}\` from \`${String(edited.previous.value)}\` to \`${String(attribute.value.value)}\`.`;
    } else {
      const block = findResourceBlocks(file.content, tfType, tfName)[0]!;
      for (const [other, f] of contents) {
        const skip = other === path ? { from: block.lineStart, to: block.close } : undefined;
        if (referencesResource(f.content, tfType, tfName, skip)) {
          return refuse(`${address} is referenced in ${other}, so removing it is not mechanical.`);
        }
      }
      after = removeResourceBlock(file.content, tfType, tfName);
      summary = `Remove the \`${address}\` block from \`${path}\`.`;
    }
  } catch (err) {
    if (err instanceof HclEditError) return refuse(err.message);
    throw err;
  }
  if (after === file.content) return refuse(`${address} already has the recommended value.`);

  const fingerprint = findingFingerprint(organizationId, args.sourceKind, args.sourceId);
  const title =
    args.change.kind === "resize"
      ? `Right-size ${address} (${row.displayName})`
      : `Remove orphaned ${address} (${row.displayName})`;
  const body = [
    `<!-- infrawrench-finding:${fingerprint} -->`,
    summary,
    "",
    recommendationNote,
    "",
    "**Review before merging.** Run `terraform plan` and check it changes only this resource" +
      (args.change.kind === "remove"
        ? ": removing the block destroys the resource on the next apply."
        : ": some providers stop or replace an instance to change its size."),
    "",
    `<sub>Opened by Infrawrench from a savings finding. It is never merged automatically.</sub>`,
  ].join("\n");

  return {
    ok: true,
    plan: {
      repo,
      baseBranch,
      baseSha,
      path,
      fileSha: file.sha,
      before: file.content,
      after,
      terraformAddress: address,
      title,
      body,
      diff: unifiedDiff(path, file.content, after),
      branchName: `infrawrench/${args.change.kind}-${slug(tfName)}-${fingerprint.slice(0, 8)}`,
    },
  };
}

/** What the PR would change, or why it cannot be opened. Reads only. */
export async function previewIacPullRequest(
  organizationId: string,
  args: GithubPullRequestArgs,
): Promise<GithubPullRequestPreview> {
  const result = await plan(organizationId, args);
  if (!result.ok) return { eligible: false, reason: result.reason };
  const p = result.plan;
  return {
    eligible: true,
    repo: p.repo,
    baseBranch: p.baseBranch,
    path: p.path,
    terraformAddress: p.terraformAddress,
    title: p.title,
    body: p.body,
    diff: p.diff,
  };
}

export class IacPullRequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IacPullRequestRefused";
  }
}

/** Open the pull request: branch, one commit, PR. Throws when ineligible. */
export async function openIacPullRequest(
  organizationId: string,
  args: GithubPullRequestArgs,
): Promise<{ pullRequest: { number: number; url: string }; link: GithubIssueLink | null }> {
  const result = await plan(organizationId, args);
  if (!result.ok) throw new IacPullRequestRefused(result.reason);
  const p = result.plan;
  const { installationId, fullName } = p.repo;
  // A re-run for the same finding gets a fresh branch rather than failing on
  // the name: the old one may hold a closed PR somebody wants to keep.
  const branch = `${p.branchName}-${Date.now().toString(36)}`;
  await createBranch(installationId, fullName, branch, p.baseSha);
  const message = p.title;
  if (p.after.trim().length === 0) {
    await deleteFile(installationId, fullName, { path: p.path, branch, sha: p.fileSha, message });
  } else {
    await putFile(installationId, fullName, {
      path: p.path,
      branch,
      content: p.after,
      sha: p.fileSha,
      message,
    });
  }
  const pullRequest = await createPullRequest(installationId, fullName, {
    title: p.title,
    head: branch,
    base: p.baseBranch,
    body: p.body,
  });
  const link = await attachPullRequestToLink(
    organizationId,
    args.sourceKind,
    args.sourceId,
    pullRequest,
  );
  return { pullRequest, link };
}
