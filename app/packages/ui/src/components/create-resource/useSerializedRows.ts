import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export interface SerializedRowsOptions<Row> {
  /** The field's current value, as the form holds it. */
  value: string;
  /** Called with the serialized rows whenever they stop matching `value`. */
  onChange: (next: string) => void;
  /** Turn a field value into editable rows. May mint fresh row ids. */
  parse: (value: string) => Row[];
  /** Turn editable rows back into a field value. Must ignore row ids. */
  serialize: (rows: Row[]) => string;
  /** Rows to show when `value` parses to nothing — e.g. one blank row. */
  blankRows: () => Row[];
}

/**
 * Row state for the editors whose field value is a serialized blob —
 * `StringListPicker` (comma list), `KeyValueListPicker` (JSON array),
 * `JsonSchemaEditor` (JSON Schema). They keep rows locally so each one can
 * carry a stable id and an in-progress, not-yet-serializable value (a blank
 * row, a property with no name), and publish the serialized form upward.
 *
 * The reason this is shared rather than three copies: seeding row state from
 * `value` only at mount silently drops anything the parent writes afterwards.
 * A React parent's effects run *after* its children's, so a value the parent
 * computes in an effect — the create modal's `key=` tag-policy stubs — always
 * lands after the picker has already snapshotted the empty value, leaving the
 * form state and the visible rows disagreeing (#116). The same applies to a
 * field action that mints a value and to the form reset when the create
 * modal's deps change.
 *
 * Adopting an incoming value cannot fight the publish effect or clobber an
 * edit in progress, because the comparison is on the *serialized* form: the
 * parent echoing back what these rows just emitted compares equal and is
 * ignored, and so does a parent that stores a differently-normalized spelling
 * of the same rows. Only a genuinely different value replaces the rows, which
 * is what a controlled editor should do.
 */
export function useSerializedRows<Row>(
  options: SerializedRowsOptions<Row>,
): [Row[], Dispatch<SetStateAction<Row[]>>] {
  const { value } = options;
  // Read the callbacks off a ref so neither effect has to depend on props that
  // are rebuilt every render.
  const latest = useRef(options);
  latest.current = options;

  const [rows, setRows] = useState<Row[]>(() => {
    const parsed = options.parse(options.value);
    return parsed.length > 0 ? parsed : options.blankRows();
  });

  // Publish the rows upward.
  useEffect(() => {
    const { serialize, value: current, onChange } = latest.current;
    const next = serialize(rows);
    if (next !== current) onChange(next);
  }, [rows]);

  // Adopt a value that changed underneath us.
  useEffect(() => {
    const { parse, serialize, blankRows } = latest.current;
    setRows((prev) => {
      const parsed = parse(value);
      const next = parsed.length > 0 ? parsed : blankRows();
      return serialize(next) === serialize(prev) ? prev : next;
    });
  }, [value]);

  return [rows, setRows];
}
