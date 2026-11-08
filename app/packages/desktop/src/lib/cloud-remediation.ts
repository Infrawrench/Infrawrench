/**
 * A finding row's `remediation` as the panels' client-core types hold it.
 *
 * The contract declares the field `remediation?: FindingRemediation | null`
 * (the server writes `null` for a finding with no fix to offer), while
 * client-core's row types say `remediation?: FindingRemediation`. The panels
 * treat both the same (`r.remediation && ...`), so a `null` is dropped here
 * rather than widening the shared type.
 */
type WithRemediation<Row extends { readonly remediation?: unknown }> = Omit<Row, "remediation"> & {
  remediation?: NonNullable<Row["remediation"]>;
};

export function withoutNullRemediation<Row extends { readonly remediation?: unknown }>(
  row: Row,
): WithRemediation<Row> {
  const { remediation, ...rest } = row;
  return remediation === null || remediation === undefined ? rest : { ...rest, remediation };
}
