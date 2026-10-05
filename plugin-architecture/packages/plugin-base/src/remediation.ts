/**
 * Remediation commands: the "here is exactly what to run" half of every
 * savings finding.
 *
 * The savings finder already says *what* is wasteful (an unattached volume, an
 * oversized VM, an idle commitment) and, where the plugin supports it, offers
 * a one-click fix. Plenty of teams cannot or will not click: changes go through
 * a terminal, a runbook, a ticket, or Terraform. For them the finding is only
 * actionable once it carries the provider CLI command, filled in with the real
 * resource id, region and target size.
 *
 * The capability is declared on the `Plugin` object (not the client), exactly
 * like `terraformExport`: generating a command is pure string work over the
 * already-synced `fields`, so it needs no credentials and no provider API
 * calls, and every host (web server, desktop main process, CLI) can run it over
 * its own store. Account-level identifiers the stored row does not carry (the
 * AWS profile, the GCP project, the Azure subscription) are written as shell
 * variables and declared as {@link RemediationPlaceholder}s, so a command is
 * paste-ready after one `export`.
 *
 * Plugins own the syntax; the host owns everything generic: calling the
 * plugin defensively ({@link resolveRemediationCommands}), and the Terraform
 * hint for IaC-managed resources ({@link terraformRemediationHint}), which is
 * derived from the plugin's own `terraformExport` mapper rather than written a
 * second time.
 */
import type { ResourceInstance } from "./instance.js";
import type { CommitmentKind } from "./cost.js";
import type { TerraformExportCapability, TerraformValue } from "./terraform.js";
import { renderTerraformValue } from "./terraform-hcl.js";

/**
 * The CLI a command is written for. Open-ended on purpose (a plugin may name
 * its provider's own CLI), but the well-known names below are what surfaces
 * label and group by.
 */
export type RemediationTool =
  | "aws-cli"
  | "gcloud"
  | "az"
  | "doctl"
  | "hcloud"
  | "scw"
  | "linode-cli"
  | "oci"
  | "kubectl"
  | "terraform"
  | "confluent"
  | "atlas"
  | "gh"
  | "twilio"
  | "snowflake-sql"
  | "anyscale"
  | "curl"
  | (string & {});

/** A shell variable a command references instead of a value the row lacks. */
export interface RemediationPlaceholder {
  /** Variable name without the `$`, e.g. "AWS_PROFILE". */
  name: string;
  /** What to set it to, e.g. "The AWS CLI profile for this account". */
  description: string;
}

/** One ready-to-run command. */
export interface RemediationCommand {
  tool: RemediationTool;
  /** The command line itself, values already shell-quoted. */
  command: string;
  /** What the command does, one sentence. */
  description: string;
  /**
   * True when running it destroys data or releases something that cannot be
   * got back (deleting a volume, releasing an address). Surfaces mark these,
   * and plugins precede them with a snapshot/backup command where one exists.
   */
  destructive: boolean;
  /** Shell variables the command expects to be set. */
  placeholders?: RemediationPlaceholder[];
}

/** The stored resource a finding is about. */
export interface RemediationResource {
  resourceTypeId: string;
  displayName: string;
  /** Provider-native id, when the lister stored one. */
  externalId: string | null;
  /** The instance's synced `fields` bag (primitives only). */
  fields: Record<string, string | number | boolean>;
}

/** The commitment an idle-commitment finding is about. */
export interface RemediationCommitment {
  /** Provider-native commitment id (an RI id, a savings plan ARN, a reservation order path). */
  id: string;
  kind: CommitmentKind;
  description: string;
  scope: string | null;
  region: string | null;
}

/**
 * Every finding type the savings surfaces render. A plugin answers the kinds
 * it can and returns `[]` for the rest.
 */
export type RemediationFinding =
  | {
      /** Orphan / idle resource ("Potential savings"). */
      kind: "orphan";
      resource: RemediationResource;
      /** The plugin's own `orphanRule.reason`. */
      reason: string;
    }
  | {
      /** Right-sizing ("Oversized"). */
      kind: "oversized";
      resource: RemediationResource;
      /** The `rightsizing.sizeFieldKey` the sizes below are values of. */
      sizeFieldKey: string;
      currentSize: string;
      targetSize: string;
      region: string | null;
    }
  | {
      /** A resource under (or suggested for) a sleep/wake schedule. */
      kind: "sleep-schedule";
      resource: RemediationResource;
    }
  | {
      /** A commitment whose utilization fell under the idle threshold. */
      kind: "idle-commitment";
      commitment: RemediationCommitment;
    };

export type RemediationFindingKind = RemediationFinding["kind"];

/** One attribute a Terraform-managed resource should change. */
export interface IacAttributeChange {
  attribute: string;
  /** HCL rendering of the current value; null when the attribute is new. */
  from: string | null;
  /** HCL rendering of the target value; null when it should be removed. */
  to: string | null;
}

/**
 * The resource is managed by Terraform, so running the CLI commands would
 * create drift the next `terraform apply` reverts. The hint says which block
 * to edit, and how.
 */
export interface IacRemediationHint {
  /** Terraform address, e.g. `aws_instance.web`. */
  address: string;
  /** Label of the state document that says so. */
  stateLabel: string | null;
  /** Attribute edits for a resize; empty for a removal. */
  attributeChanges: IacAttributeChange[];
  commands: RemediationCommand[];
}

/** What hosts attach to a finding. */
export interface FindingRemediation {
  commands: RemediationCommand[];
  /** Every placeholder the commands reference, deduplicated. */
  placeholders: RemediationPlaceholder[];
  /** Set when the resource is managed by Terraform; see {@link IacRemediationHint}. */
  iac: IacRemediationHint | null;
}

/** The part of a plugin {@link resolveRemediationCommands} reads. */
export interface RemediationSource {
  remediationCommands?: ((finding: RemediationFinding) => RemediationCommand[]) | undefined;
}

/** Cap per finding: anything longer is a script, not a command list. */
export const MAX_REMEDIATION_COMMANDS = 12;

/**
 * Quote one value for a POSIX shell. Values come from the provider (resource
 * names, ids, tags), so a name like `prod; rm -rf ~` must reach the CLI as one
 * argument and never as shell syntax. Safe-character values pass through
 * unquoted so the common case stays readable.
 */
export function shellQuote(value: string | number | boolean): string {
  const s = String(value);
  if (s !== "" && /^[A-Za-z0-9_\-.,/:=@+%]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/** A field as a trimmed string ("" when absent or not a primitive). */
export function remediationField(resource: RemediationResource, key: string): string {
  const v = resource.fields[key];
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/**
 * The provider id to address a resource by: the named field when set, else
 * the stored externalId, else "".
 */
export function remediationId(resource: RemediationResource, fieldKey?: string): string {
  const fromField = fieldKey ? remediationField(resource, fieldKey) : "";
  return fromField || (resource.externalId ?? "").trim();
}

/** Today as YYYYMMDD, for snapshot names. Injectable so snapshots stay stable. */
export function remediationDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Call a plugin's `remediationCommands` defensively: a plugin bug must cost
 * the commands, never the finding. Drops malformed entries, caps the list,
 * and collects the placeholders.
 */
export function resolveRemediationCommands(
  source: RemediationSource | undefined,
  finding: RemediationFinding,
): FindingRemediation {
  const empty: FindingRemediation = { commands: [], placeholders: [], iac: null };
  const fn = source?.remediationCommands;
  if (typeof fn !== "function") return empty;
  let raw: unknown;
  try {
    raw = fn.call(source, finding);
  } catch (err) {
    console.error("[remediation] plugin threw while generating commands:", err);
    return empty;
  }
  if (!Array.isArray(raw)) return empty;
  const commands: RemediationCommand[] = [];
  for (const entry of raw as unknown[]) {
    if (!isCommand(entry)) continue;
    commands.push({
      tool: entry.tool,
      command: entry.command,
      description: entry.description,
      destructive: entry.destructive === true,
      ...(entry.placeholders?.length ? { placeholders: entry.placeholders } : {}),
    });
    if (commands.length >= MAX_REMEDIATION_COMMANDS) break;
  }
  return { commands, placeholders: collectPlaceholders(commands), iac: null };
}

function isCommand(v: unknown): v is RemediationCommand {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<RemediationCommand>;
  return (
    typeof c.tool === "string" &&
    c.tool.length > 0 &&
    typeof c.command === "string" &&
    c.command.trim().length > 0 &&
    typeof c.description === "string"
  );
}

/** Every placeholder across a command list, first description wins. */
export function collectPlaceholders(
  commands: readonly RemediationCommand[],
): RemediationPlaceholder[] {
  const seen = new Map<string, RemediationPlaceholder>();
  for (const c of commands) {
    for (const p of c.placeholders ?? []) {
      if (!seen.has(p.name)) seen.set(p.name, p);
    }
  }
  return [...seen.values()];
}

/** The finding as the stored instance the export mapper reads. */
function asInstance(
  resource: RemediationResource & { id: string; pluginId: string; accountId: string },
): ResourceInstance {
  return {
    id: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: resource.resourceTypeId,
    accountId: resource.accountId,
    displayName: resource.displayName,
    fields: resource.fields,
    resolvedOutputs: {},
    secretStates: [],
    ...(resource.externalId ? { externalId: resource.externalId } : {}),
    createdAt: "",
    updatedAt: "",
  };
}

export interface TerraformRemediationInput {
  /** The plugin's `terraformExport`, when it has one. */
  capability: TerraformExportCapability | undefined;
  /** The resource, with the identifiers the mapper may read. */
  resource: RemediationResource & { id: string; pluginId: string; accountId: string };
  finding: RemediationFinding;
  /** Where Terraform tracks it (from IaC reconciliation). */
  address: string;
  stateLabel: string | null;
}

/**
 * The Terraform-side remediation for a resource IaC reconciliation says is
 * managed: which block to edit and the plan to review, instead of a CLI change
 * Terraform would revert.
 *
 * For a resize the attribute to edit is *derived*: the plugin's own export
 * mapper runs twice, once over the stored fields and once with the size field
 * swapped for the target, and whatever attributes differ are the edit. No
 * per-provider table of "the size attribute is called `instance_type`", so the
 * hint can never disagree with what eject-to-Terraform writes. When the mapper
 * cannot express the resource the hint still names the address; it just
 * cannot say which line.
 */
export function terraformRemediationHint(
  input: TerraformRemediationInput,
): IacRemediationHint | null {
  const { finding, address, stateLabel } = input;
  if (finding.kind === "idle-commitment") return null;
  const target = shellQuote(address);
  if (finding.kind === "orphan") {
    return {
      address,
      stateLabel,
      attributeChanges: [],
      commands: [
        {
          tool: "terraform",
          command: `terraform plan -destroy -target=${target}`,
          description: `Preview destroying ${address}. Prefer deleting its block from your configuration and running terraform apply, so the code stays the source of truth.`,
          destructive: false,
        },
      ],
    };
  }
  if (finding.kind === "sleep-schedule") {
    return {
      address,
      stateLabel,
      attributeChanges: [],
      commands: [
        {
          tool: "terraform",
          command: `terraform plan -target=${target}`,
          description: `Stopping and starting ${address} out of band is safe for Terraform, but confirm the configuration does not pin its power state before scheduling it.`,
          destructive: false,
        },
      ],
    };
  }

  const attributeChanges = diffMappedAttributes(input.capability, input.resource, {
    [finding.sizeFieldKey]: finding.targetSize,
  });
  const edit =
    attributeChanges.length > 0
      ? attributeChanges.map((c) => `${c.attribute} = ${c.to ?? "(remove)"}`).join(", ")
      : `the size (${finding.targetSize})`;
  return {
    address,
    stateLabel,
    attributeChanges,
    commands: [
      {
        tool: "terraform",
        command: `terraform plan -target=${target}`,
        description: `After setting ${edit} on ${address} in your configuration, review the planned in-place change before terraform apply.`,
        destructive: false,
      },
    ],
  };
}

function diffMappedAttributes(
  capability: TerraformExportCapability | undefined,
  resource: TerraformRemediationInput["resource"],
  overrides: Record<string, string>,
): IacAttributeChange[] {
  if (!capability || !capability.supportedResourceTypeIds.includes(resource.resourceTypeId)) {
    return [];
  }
  try {
    const before = capability.mapResource(asInstance(resource));
    const after = capability.mapResource(
      asInstance({ ...resource, fields: { ...resource.fields, ...overrides } }),
    );
    if (!before || !after) return [];
    const changes: IacAttributeChange[] = [];
    const keys = new Set([
      ...Object.keys(before.resource.attributes),
      ...Object.keys(after.resource.attributes),
    ]);
    for (const key of keys) {
      const from = renderOrNull(before.resource.attributes[key]);
      const to = renderOrNull(after.resource.attributes[key]);
      if (from !== to) changes.push({ attribute: key, from, to });
    }
    return changes;
  } catch {
    return [];
  }
}

function renderOrNull(value: TerraformValue | undefined): string | null {
  return value ? renderTerraformValue(value) : null;
}
