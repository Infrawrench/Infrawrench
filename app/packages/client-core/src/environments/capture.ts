/**
 * Capture: turn a selection of live resources into a draft template, suggest
 * parameters worth varying, and promote the chosen ones into the document.
 */
import type {
  CaptureCreateField,
  CaptureDraft,
  CaptureDraftMember,
  CaptureSourceResource,
  EnvironmentParameter,
  EnvironmentTemplateMember,
  TemplateFieldValue,
} from "./types";
import { slugifyEnvironmentName } from "./template";

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Field kinds worth offering as a parameter, and what to call the parameter. */
const PARAMETERISABLE_KINDS: Record<string, string> = {
  "region-picker": "region",
  "size-picker": "size",
  "disk-slider": "disk",
  select: "option",
};

function uniqueKey(base: string, taken: Set<string>): string {
  const slug = slugifyEnvironmentName(base) || "item";
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  for (let i = 2; ; i += 1) {
    const candidate = `${slug}-${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * Build a draft template out of a selection of live resources.
 *
 * The shape of every member comes from the plugin's own create-field list:
 * a captured field that is not a create field is dropped (it is derived or
 * read-only, and feeding it back would fail), and a create field the source
 * has no value for is left out (its default applies). That is the whole reason
 * this is provider-agnostic — no per-provider table decides what is
 * reproducible, the plugin's create form does.
 *
 * References are preserved in two ways, in confidence order: a recorded output
 * reference whose target is also in the selection becomes an `output` value;
 * otherwise a field whose literal value is exactly another selected resource's
 * external id becomes a `member-id` value. Containment (`parentResourceId`)
 * becomes `parentMember`. Anything pointing outside the selection stays a
 * literal — the environment does not own it.
 */
export function buildCaptureDraft(input: {
  resources: CaptureSourceResource[];
  /** Create fields per `${pluginId}:${resourceTypeId}`. */
  createFields: Record<string, CaptureCreateField[]>;
}): CaptureDraft {
  const skipped: CaptureDraft["skipped"] = [];
  const takenKeys = new Set<string>();
  const keyByResourceId = new Map<string, string>();
  const captureable: { source: CaptureSourceResource; fields: CaptureCreateField[] }[] = [];

  for (const source of input.resources) {
    const fields = input.createFields[`${source.pluginId}:${source.resourceTypeId}`];
    if (!fields || fields.length === 0) {
      skipped.push({
        resourceId: source.resourceId,
        displayName: source.displayName,
        reason: "This resource type cannot be created by its plugin, so it cannot be stamped out.",
      });
      continue;
    }
    captureable.push({ source, fields });
    keyByResourceId.set(source.resourceId, uniqueKey(source.displayName, takenKeys));
  }

  const externalIdToKey = new Map<string, string>();
  for (const { source } of captureable) {
    const key = keyByResourceId.get(source.resourceId)!;
    // Only unambiguous ids may act as an identity: two resources sharing one
    // external id would let a reference resolve to either.
    if (source.externalId && externalIdToKey.has(source.externalId)) {
      externalIdToKey.set(source.externalId, "");
    } else if (source.externalId) {
      externalIdToKey.set(source.externalId, key);
    }
  }

  const members: CaptureDraftMember[] = [];
  for (const { source, fields } of captureable) {
    const key = keyByResourceId.get(source.resourceId)!;
    const refByField = new Map(
      (source.outputRefs ?? [])
        .filter((r) => keyByResourceId.has(r.targetResourceId))
        .map((r) => [r.fieldKey, r]),
    );

    const templateFields: Record<string, TemplateFieldValue> = {};
    const fieldMeta: CaptureDraftMember["fieldMeta"] = {};
    let nameFieldKey: string | undefined;

    for (const field of fields) {
      if (field.transient) continue;
      const captured = source.fields[field.key];
      if (captured === undefined || captured === "") continue;

      const ref = refByField.get(field.key);
      let value: TemplateFieldValue;
      if (ref) {
        value = {
          kind: "output",
          member: keyByResourceId.get(ref.targetResourceId)!,
          outputKey: ref.outputKey,
        };
      } else {
        const target = externalIdToKey.get(captured);
        value =
          target && target !== "" && target !== key
            ? { kind: "member-id", member: target }
            : { kind: "literal", value: captured };
      }
      templateFields[field.key] = value;

      // The name field is whichever create field the provider echoed back as
      // the resource's display name. No key spellings are guessed at.
      if (nameFieldKey === undefined && captured === source.displayName) {
        nameFieldKey = field.key;
      }

      fieldMeta[field.key] = {
        label: field.label,
        kind: field.kind,
        required: field.required,
        ...(field.options ? { options: field.options } : {}),
        parameterisable: value.kind === "literal",
      };
    }

    const parentKey = source.parentResourceId
      ? keyByResourceId.get(source.parentResourceId)
      : undefined;

    members.push({
      key,
      pluginId: source.pluginId,
      resourceTypeId: source.resourceTypeId,
      accountId: source.accountId,
      sourceName: source.displayName,
      sourceResourceId: source.resourceId,
      ...(nameFieldKey ? { nameFieldKey } : {}),
      ...(parentKey ? { parentMember: parentKey } : {}),
      fields: templateFields,
      fieldMeta,
    });
  }

  return { members, suggestedParameters: suggestParameters(members), skipped };
}

/**
 * Offer one parameter per create-field key whose kind says it is a knob
 * (region, size, disk). Keyed by field key rather than per member, so a
 * template whose four resources all live in `region` gets one "Region"
 * parameter that moves all four.
 */
export function suggestParameters(members: CaptureDraftMember[]): EnvironmentParameter[] {
  const byFieldKey = new Map<
    string,
    { label: string; kind: string; values: Set<string>; options?: { id: string; label: string }[] }
  >();

  for (const member of members) {
    for (const [fieldKey, meta] of Object.entries(member.fieldMeta)) {
      if (!meta.parameterisable) continue;
      if (!PARAMETERISABLE_KINDS[meta.kind]) continue;
      const value = member.fields[fieldKey];
      if (!value || value.kind !== "literal") continue;
      const entry = byFieldKey.get(fieldKey) ?? {
        label: meta.label,
        kind: meta.kind,
        values: new Set<string>(),
        ...(meta.options ? { options: meta.options } : {}),
      };
      entry.values.add(value.value);
      byFieldKey.set(fieldKey, entry);
    }
  }

  const out: EnvironmentParameter[] = [];
  const taken = new Set<string>();
  for (const [fieldKey, entry] of byFieldKey) {
    // A field the members already disagree on is not one knob; making it a
    // single parameter would quietly rewrite the ones that differ.
    if (entry.values.size !== 1) continue;
    const key = uniqueKey(PARAMETERISABLE_KINDS[entry.kind] ?? fieldKey, taken);
    const [defaultValue] = [...entry.values];
    out.push({
      key,
      label: entry.label,
      type: entry.kind === "select" ? "select" : "string",
      required: true,
      defaultValue: defaultValue!,
      ...(entry.kind === "select" && entry.options ? { options: entry.options } : {}),
    });
  }
  return out;
}

/**
 * Turn a draft into the parameterised document, promoting the chosen fields to
 * parameters. `chosen` names which suggested parameters the user kept.
 */
export function applyChosenParameters(
  draft: CaptureDraft,
  chosen: string[],
): { parameters: EnvironmentParameter[]; members: EnvironmentTemplateMember[] } {
  const keep = new Set(chosen);
  const parameters = draft.suggestedParameters.filter((p) => keep.has(p.key));
  const byLabel = new Map(parameters.map((p) => [p.label, p.key]));

  const members = draft.members.map((member) => {
    const fields: Record<string, TemplateFieldValue> = {};
    for (const [fieldKey, value] of Object.entries(member.fields)) {
      const meta = member.fieldMeta[fieldKey];
      const parameterKey = meta ? byLabel.get(meta.label) : undefined;
      const suggestion = parameters.find((p) => p.key === parameterKey);
      if (
        parameterKey &&
        suggestion &&
        value.kind === "literal" &&
        value.value === suggestion.defaultValue
      ) {
        fields[fieldKey] = { kind: "parameter", parameter: parameterKey };
      } else {
        fields[fieldKey] = value;
      }
    }
    const { fieldMeta: _fieldMeta, ...rest } = member;
    return { ...rest, fields };
  });

  return { parameters, members };
}
