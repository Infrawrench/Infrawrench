import { Schema } from "effect";
import { Num } from "./primitives.js";

export const associationSourceSchema = Schema.Struct({
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  outputKey: Schema.String,
});

const selectOptionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
});

const showWhenConditionSchema = Schema.Struct({
  fieldKey: Schema.String,
  fieldValue: Schema.optional(Schema.String),
  fieldValues: Schema.optional(Schema.Array(Schema.String)),
  fieldValuesNot: Schema.optional(Schema.Array(Schema.String)),
});

const createFieldShape = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  kind: Schema.Literals([
    "text",
    "hostname",
    "password",
    "number",
    "datetime",
    "select",
    "size-picker",
    "region-picker",
    "disk-slider",
    "image-picker",
    "disk-picker",
    "ssh-key-picker",
    "resource-picker",
    "policy-picker",
    "key-value-list",
    "string-list",
    "code",
    "json-schema",
  ]),
  required: Schema.Boolean,
  description: Schema.optional(Schema.String),
  defaultValue: Schema.optional(Schema.String),
  placeholder: Schema.optional(Schema.String),
  showWhen: Schema.optional(
    Schema.Union([
      showWhenConditionSchema,
      Schema.Struct({ allOf: Schema.Array(showWhenConditionSchema) }),
      Schema.Struct({ anyOf: Schema.Array(showWhenConditionSchema) }),
    ]),
  ),
  hidden: Schema.optional(Schema.Boolean),
  transient: Schema.optional(Schema.Boolean),
  referenceMode: Schema.optional(Schema.Boolean),
  multiline: Schema.optional(Schema.Boolean),
  hostnameSuffix: Schema.optional(Schema.String),
  hostnamePath: Schema.optional(Schema.Boolean),
  options: Schema.optional(Schema.Array(selectOptionSchema)),
  minValue: Schema.optional(Num),
  maxValue: Schema.optional(Num),
  stepValue: Schema.optional(Num),
  datetimeMode: Schema.optional(Schema.Literals(["datetime", "date", "epoch-ms"])),
  sizes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        vcpus: Num,
        memoryMb: Num,
        diskGb: Schema.optional(Num),
        priceMonthly: Schema.optional(Num),
        category: Schema.optional(Schema.String),
        availableFor: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  regions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        location: Schema.optional(Schema.String),
        flag: Schema.optional(Schema.String),
        availableFor: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  minGb: Schema.optional(Num),
  maxGb: Schema.optional(Num),
  defaultGb: Schema.optional(Num),
  stepGb: Schema.optional(Num),
  images: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        description: Schema.optional(Schema.String),
        family: Schema.optional(Schema.String),
        isOwned: Schema.optional(Schema.Boolean),
        category: Schema.optional(Schema.String),
      }),
    ),
  ),
  disks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        sizeGb: Num,
        zone: Schema.optional(Schema.String),
        diskType: Schema.optional(Schema.String),
      }),
    ),
  ),
  associationSources: Schema.optional(Schema.Array(associationSourceSchema)),
  associationRole: Schema.optional(Schema.Literals(["dns-ipv4", "dns-ipv6", "dns-hostname"])),
  scopeFromFieldKey: Schema.optional(Schema.String),
  filterByFieldKey: Schema.optional(Schema.String),
  policies: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        description: Schema.optional(Schema.String),
        category: Schema.optional(Schema.String),
        badge: Schema.optional(Schema.String),
      }),
    ),
  ),
  entryKeyLabel: Schema.optional(Schema.String),
  entryKeyPlaceholder: Schema.optional(Schema.String),
  entryKeyName: Schema.optional(Schema.String),
  entryValueLabel: Schema.optional(Schema.String),
  entryValueName: Schema.optional(Schema.String),
  entryValueOptions: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  ),
  entryValueDefault: Schema.optional(Schema.String),
  codeLanguage: Schema.optional(Schema.String),
  addLabel: Schema.optional(Schema.String),
  minEntries: Schema.optional(Num),
  maxEntries: Schema.optional(Num),
});

export type CreateFieldShape = typeof createFieldShape.Type;

// A field action's form holds create fields, which is the recursion the
// annotation has to break.
export interface DecodedCreateField extends CreateFieldShape {
  readonly actions?: ReadonlyArray<DecodedFieldAction> | undefined;
}

export interface DecodedFieldAction {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly formFields?: ReadonlyArray<DecodedCreateField> | undefined;
  readonly submitLabel?: string | undefined;
}

const fieldActionSchema: Schema.Codec<DecodedFieldAction> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
  formFields: Schema.optional(Schema.Array(Schema.suspend(() => createFieldConfigSchema))),
  submitLabel: Schema.optional(Schema.String),
});

export const createFieldConfigSchema: Schema.Codec<DecodedCreateField> = Schema.Struct({
  ...createFieldShape.fields,
  actions: Schema.optional(Schema.Array(fieldActionSchema)),
});

export const peerGuidanceActionSchema = Schema.Struct({
  label: Schema.String,
  command: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  submitLabel: Schema.optional(Schema.String),
  fields: Schema.Array(createFieldConfigSchema),
});
