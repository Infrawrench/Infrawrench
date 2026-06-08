import type {
  FieldDefinition,
  FieldKind,
  ResourceOutput,
  ResourceTypeDefinition,
} from "./resource.js";

export type CompactField = Omit<FieldDefinition, "key" | "label" | "kind" | "required"> & {
  kind?: FieldKind;
  required?: boolean;
};

export type CompactOutput = Omit<ResourceOutput, "key" | "label" | "sensitive"> & {
  sensitive?: boolean;
};

export type CompactResourceType = Omit<
  ResourceTypeDefinition,
  "displayName" | "pluralDisplayName" | "dashboardPinnable" | "fields" | "outputs"
> & {
  name: string;
  plural?: string;
  pinnable?: boolean;
  fields?: FieldDefinition[];
  outputs?: ResourceOutput[];
};

export function field(key: string, label: string, opts: CompactField = {}): FieldDefinition {
  const { kind = "string", required = true, ...rest } = opts;
  return { key, label, kind, required, ...rest };
}

export function output(key: string, label: string, opts: CompactOutput = {}): ResourceOutput {
  const { sensitive = false, ...rest } = opts;
  return { key, label, sensitive, ...rest };
}

export function resourceType(def: CompactResourceType): ResourceTypeDefinition {
  const { name, plural = `${name}s`, pinnable = true, fields = [], outputs = [], ...rest } = def;
  return {
    ...rest,
    displayName: name,
    pluralDisplayName: plural,
    fields,
    outputs,
    dashboardPinnable: pinnable,
  };
}

export { field as f, output as o, resourceType as rt };
