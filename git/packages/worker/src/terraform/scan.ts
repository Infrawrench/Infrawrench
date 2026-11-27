/**
 * A repository's Terraform at a ref, scanned from its files and kept in
 * `git_terraform_scans` by tree (`@infrawrench/git-terraform`
 * `scanTerraformSnapshot`).
 *
 * The cache has three levels. A commit already scanned is one row read. A
 * commit whose tree was scanned (another branch, a push that changed no file)
 * is one Durable Object call, answered from the object's own memory, and one
 * row read. Only a new tree is walked: one call that reads every Terraform
 * file beside the data (`terraformFiles`), however large the repository.
 *
 * The row is the repository's own text reduced to what the Infrastructure tab
 * shows and what pricing needs; the API never serves `pricingInputs`. The
 * gateway's pass prices a pending row in the background
 * (server-core `git-terraform/config-cost.ts`).
 */
import { and, desc, eq } from "drizzle-orm";
import {
  TERRAFORM_SCANNER_VERSION,
  type TerraformScanSummary,
  scanTerraformSnapshot,
  summarizeScan,
} from "@infrawrench/git-terraform";
import { gitTerraformScans } from "@infrawrench/server-core/db/schema";
import { db, newId } from "../db/client";
import type { RefInput, RepoReader } from "../repo/reader";

export type ScanRow = typeof gitTerraformScans.$inferSelect;

/** What a scan row's `summary` holds. */
export const summaryOf = (row: ScanRow): TerraformScanSummary =>
  row.summary as unknown as TerraformScanSummary;

const byCommit = async (repositoryId: string, commitOid: string): Promise<ScanRow | null> => {
  const [row] = await db
    .select()
    .from(gitTerraformScans)
    .where(
      and(
        eq(gitTerraformScans.repositoryId, repositoryId),
        eq(gitTerraformScans.commitOid, commitOid),
        eq(gitTerraformScans.scannerVersion, TERRAFORM_SCANNER_VERSION),
      ),
    )
    .orderBy(desc(gitTerraformScans.createdAt))
    .limit(1);
  return row ?? null;
};

const byTree = async (repositoryId: string, treeOid: string): Promise<ScanRow | null> => {
  const [row] = await db
    .select()
    .from(gitTerraformScans)
    .where(
      and(
        eq(gitTerraformScans.repositoryId, repositoryId),
        eq(gitTerraformScans.treeOid, treeOid),
        eq(gitTerraformScans.scannerVersion, TERRAFORM_SCANNER_VERSION),
      ),
    )
    .limit(1);
  return row ?? null;
};

/**
 * The scan of `ref` (a branch, a tag or a commit id; the default branch when
 * undefined). Reader refusals (`repository_empty`, `ref_not_found`) are the
 * caller's to answer.
 */
export const scanAt = async (
  input: { readonly reader: RepoReader; readonly repositoryId: string },
  ref: RefInput,
): Promise<ScanRow> => {
  const { reader, repositoryId } = input;
  // A full commit id needs no resolving; anything else is resolved once.
  const commitOid =
    ref !== undefined && /^[0-9a-f]{40}$/.test(ref)
      ? ref
      : (await reader.resolveRef(ref)).commitOid;
  const known = await byCommit(repositoryId, commitOid);
  if (known) return known;

  const files = await reader.terraformFiles({ ref: commitOid });
  const sameTree = await byTree(repositoryId, files.treeOid);
  if (sameTree) return sameTree;

  const result = await scanTerraformSnapshot(files.snapshot);
  const summary = summarizeScan(result);
  await db
    .insert(gitTerraformScans)
    .values({
      id: newId(),
      repositoryId,
      treeOid: files.treeOid,
      scannerVersion: TERRAFORM_SCANNER_VERSION,
      commitOid,
      summary: summary as unknown as Record<string, unknown>,
      pricingInputs: result.roots.map((root) => root.pricing as unknown as Record<string, unknown>),
      // Nothing to price: settled at once rather than waiting on the pass.
      ...(result.roots.length === 0
        ? { pricingStatus: "priced" as const, estimates: {}, pricedAt: new Date() }
        : {}),
    })
    .onConflictDoNothing();
  const row = await byTree(repositoryId, files.treeOid);
  if (!row) throw new Error("The Terraform scan was written and is not there");
  return row;
};
