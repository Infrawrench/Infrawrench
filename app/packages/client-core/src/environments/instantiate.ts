/**
 * What an instantiation actually does: the ordered plan, the resolution of
 * each member's template fields into the literal `createResource` map, and
 * the display name a member's resource is expected to end up with.
 */
import type { EnvironmentTemplateMember } from "./types";
import { applyNamePrefix, orderTemplateMembers } from "./template";

// ---------------------------------------------------------------------------
// Instantiation plan
// ---------------------------------------------------------------------------

export interface InstantiationStep {
  member: EnvironmentTemplateMember;
  /** Outputs of earlier members this step needs resolved before it runs. */
  needs: { member: string; outputKey: string }[];
}

export interface InstantiationPlan {
  steps: InstantiationStep[];
  /**
   * Which outputs must be resolved from each created member, so the runner
   * asks the plugin for exactly those and nothing else.
   */
  outputsNeeded: Record<string, string[]>;
}

/** Build the ordered plan. Throws nothing — callers validate first. */
export function buildInstantiationPlan(members: EnvironmentTemplateMember[]): InstantiationPlan {
  const { ordered } = orderTemplateMembers(members);
  const outputsNeeded: Record<string, string[]> = {};
  const steps: InstantiationStep[] = ordered.map((member) => {
    const needs: { member: string; outputKey: string }[] = [];
    for (const value of Object.values(member.fields)) {
      if (value.kind !== "output") continue;
      needs.push({ member: value.member, outputKey: value.outputKey });
      const list = (outputsNeeded[value.member] ??= []);
      if (!list.includes(value.outputKey)) list.push(value.outputKey);
    }
    return { member, needs };
  });
  return { steps, outputsNeeded };
}

/** What the runner knows about members it has already created. */
export interface CreatedMemberState {
  /** The provider-side id of the created resource. */
  externalId: string;
  /** Outputs resolved from it so far, keyed by output key. */
  outputs: Record<string, string>;
}

export type ResolveFieldsResult =
  { fields: Record<string, string>; problem?: undefined } | { fields?: undefined; problem: string };

/**
 * Turn a member's template fields into the literal `fields` map
 * `createResource` takes.
 *
 * Everything a provider would reject is caught here rather than mid-apply: an
 * unresolved parameter, a reference to a member that has not been created, an
 * output the source did not produce. A missing value is **never** substituted
 * with an empty string — that is how you create a resource in the wrong region
 * and find out from the bill.
 */
export function resolveMemberFields(
  member: EnvironmentTemplateMember,
  context: {
    parameters: Record<string, string>;
    created: Record<string, CreatedMemberState>;
    namePrefix: string;
  },
): ResolveFieldsResult {
  const fields: Record<string, string> = {};
  for (const [fieldKey, value] of Object.entries(member.fields)) {
    switch (value.kind) {
      case "literal":
        fields[fieldKey] = value.value;
        break;
      case "parameter": {
        const resolved = context.parameters[value.parameter];
        if (resolved === undefined || resolved === "") {
          return { problem: `Parameter "${value.parameter}" has no value.` };
        }
        fields[fieldKey] = resolved;
        break;
      }
      case "member-id": {
        const source = context.created[value.member];
        if (!source) {
          return { problem: `"${value.member}" has not been created yet.` };
        }
        fields[fieldKey] = source.externalId;
        break;
      }
      case "output": {
        const source = context.created[value.member];
        if (!source) {
          return { problem: `"${value.member}" has not been created yet.` };
        }
        const resolved = source.outputs[value.outputKey];
        if (resolved === undefined) {
          return {
            problem: `"${value.member}" did not produce an output named "${value.outputKey}".`,
          };
        }
        fields[fieldKey] = resolved;
        break;
      }
    }
  }

  // The name prefix is applied last and only to the field capture identified
  // as the name, so a template whose plugin has no name field simply keeps the
  // captured value rather than having a prefix pushed somewhere arbitrary.
  if (member.nameFieldKey && fields[member.nameFieldKey] !== undefined) {
    fields[member.nameFieldKey] = applyNamePrefix(fields[member.nameFieldKey]!, context.namePrefix);
  }
  return { fields };
}

/**
 * The display name a member's resource is expected to end up with.
 *
 * Teardown needs this to find a resource whose creation **succeeded but was
 * never confirmed** — a create that returned right before the confirming write
 * failed. It resolves the name field the same way `resolveMemberFields` does
 * (literal or parameter; both are known before the run starts, unlike output
 * references) and falls back to the captured name when the plugin has no name
 * field to prefix.
 */
export function expectedMemberDisplayName(
  member: EnvironmentTemplateMember,
  parameters: Record<string, string>,
  namePrefix: string,
): string {
  const key = member.nameFieldKey;
  if (!key) return member.sourceName;
  const value = member.fields[key];
  const raw =
    value?.kind === "literal"
      ? value.value
      : value?.kind === "parameter"
        ? parameters[value.parameter]
        : undefined;
  if (raw === undefined || raw === "") return member.sourceName;
  return applyNamePrefix(raw, namePrefix);
}
