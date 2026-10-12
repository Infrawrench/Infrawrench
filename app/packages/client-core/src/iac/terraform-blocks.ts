import type { CloudFetch } from "../fetch";
import type {
  IacReconciliationEntry,
  IacReconciliationResponse,
  IacStateListResponse,
  IacStateSummary,
} from "./index";

/**
 * Tying a `resource` block in a `.tf` file to the live resources it manages,
 * for editor surfaces (the VS Code hover and CodeLens).
 *
 * The join goes through **IaC reconciliation**: an uploaded state records each
 * block's address, and the reconciliation already matched every state entry
 * to a synced resource. So a block `resource "aws_instance" "web"` finds its
 * resource by address, and nothing here re-derives a match from attributes.
 *
 * A file does not know which module it is instantiated as, so the lookup
 * matches the `type.name` tail of the address and returns every module
 * instance and every `count`/`for_each` element it finds. A block used by two
 * modules honestly manages two sets of resources.
 */

export interface TerraformResourceBlock {
  terraformType: string;
  name: string;
  /** `type.name`. */
  address: string;
  /** 0-based line of the block header. */
  line: number;
  /** 0-based columns of the header's `resource` keyword and of the line end. */
  startColumn: number;
  endColumn: number;
}

const RESOURCE_HEADER = /^(\s*)resource\s+"([A-Za-z0-9_-]+)"\s+"([A-Za-z0-9_-]+)"/;

/**
 * Every top-level `resource` block header in an HCL document. A line scanner,
 * not a parser: it skips `#`, `//` and `/* *\/` comments and heredoc bodies,
 * which is everything that could make a header-shaped line not be one.
 */
export function findTerraformResourceBlocks(text: string): TerraformResourceBlock[] {
  const out: TerraformResourceBlock[] = [];
  const lines = text.split(/\r?\n/);
  let inBlockComment = false;
  let heredocEnd: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (heredocEnd) {
      if (raw.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    if (inBlockComment) {
      const close = raw.indexOf("*/");
      if (close === -1) continue;
      inBlockComment = false;
      continue;
    }
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/", 2)) inBlockComment = true;
      continue;
    }
    const heredoc = /<<-?([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(raw);
    if (heredoc) heredocEnd = heredoc[1]!;
    const m = RESOURCE_HEADER.exec(raw);
    if (!m) continue;
    const terraformType = m[2]!;
    const name = m[3]!;
    out.push({
      terraformType,
      name,
      address: `${terraformType}.${name}`,
      line: i,
      startColumn: m[1]!.length,
      endColumn: raw.length,
    });
  }
  return out;
}

export interface ParsedTerraformAddress {
  /** `module.a.module.b`, or "" for the root module. */
  modulePath: string;
  terraformType: string;
  name: string;
  /** `[0]` / `["key"]`, or "" when the block has no `count`/`for_each`. */
  instanceKey: string;
}

/**
 * Split a state address (`module.net["eu"].aws_subnet.private["a"]`) into its
 * module path, type, name and instance key. Null for data sources and for
 * anything that is not an address.
 */
export function parseTerraformAddress(address: string): ParsedTerraformAddress | null {
  const m =
    /^(.*?)(?:^|\.)([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(\[(?:"(?:[^"\\]|\\.)*"|[0-9]+)\])?$/.exec(
      address,
    );
  if (!m) return null;
  const modulePath = m[1] ?? "";
  if (modulePath === "data" || modulePath.endsWith(".data")) return null;
  if (m[2] === "data") return null;
  return { modulePath, terraformType: m[2]!, name: m[3]!, instanceKey: m[4] ?? "" };
}

export interface IacAddressMatch {
  /** The full state address, module path and instance key included. */
  address: string;
  modulePath: string;
  instanceKey: string;
  state: Pick<IacStateSummary, "id" | "label">;
  resource: IacReconciliationEntry;
}

/** `type.name` → every reconciled resource whose state address ends in it. */
export type IacAddressIndex = Map<string, IacAddressMatch[]>;

/**
 * Index reconciliations (one per uploaded state) by block address. Only
 * resources a state manages are indexed: an unmanaged resource has no address.
 */
export function buildIacAddressIndex(
  reconciliations: readonly IacReconciliationResponse[],
): IacAddressIndex {
  const index: IacAddressIndex = new Map();
  for (const rec of reconciliations) {
    for (const resource of rec.resources) {
      if (!resource.terraformAddress) continue;
      const parsed = parseTerraformAddress(resource.terraformAddress);
      if (!parsed) continue;
      const key = `${parsed.terraformType}.${parsed.name}`;
      const list = index.get(key) ?? [];
      list.push({
        address: resource.terraformAddress,
        modulePath: parsed.modulePath,
        instanceKey: parsed.instanceKey,
        state: { id: rec.state.id, label: rec.state.label },
        resource,
      });
      index.set(key, list);
    }
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.address.localeCompare(b.address));
  }
  return index;
}

/** The live resources a block manages, root module first. */
export function lookupTerraformBlock(
  index: IacAddressIndex,
  block: Pick<TerraformResourceBlock, "address">,
): IacAddressMatch[] {
  const list = index.get(block.address) ?? [];
  return [...list].sort((a, b) => {
    if (a.modulePath === "" && b.modulePath !== "") return -1;
    if (b.modulePath === "" && a.modulePath !== "") return 1;
    return a.address.localeCompare(b.address);
  });
}

/* ------------------------------------------------------------------ *
 * Bearer fetch helpers (`iac:read`)
 * ------------------------------------------------------------------ */

export async function fetchIacStates(
  api: CloudFetch,
  orgId: string,
): Promise<IacStateListResponse["states"]> {
  return (await api.org<IacStateListResponse>(orgId, "/iac/states"))?.states ?? [];
}

export async function fetchIacReconciliation(
  api: CloudFetch,
  orgId: string,
  stateId: string,
): Promise<IacReconciliationResponse | null> {
  return api.org<IacReconciliationResponse>(
    orgId,
    `/iac/reconciliation?stateId=${encodeURIComponent(stateId)}`,
  );
}

/**
 * Reconcile every uploaded state and index the result by block address. One
 * request per state; a state whose reconciliation fails is skipped rather
 * than failing the index, and reported in `failedStates`.
 */
export async function loadIacAddressIndex(
  api: CloudFetch,
  orgId: string,
): Promise<{ index: IacAddressIndex; states: IacStateSummary[]; failedStates: string[] }> {
  const states = await fetchIacStates(api, orgId);
  const failedStates: string[] = [];
  const results = await Promise.all(
    states.map(async (s) => {
      try {
        return await fetchIacReconciliation(api, orgId, s.id);
      } catch {
        failedStates.push(s.label);
        return null;
      }
    }),
  );
  return {
    index: buildIacAddressIndex(results.filter((r): r is IacReconciliationResponse => r !== null)),
    states,
    failedStates,
  };
}
