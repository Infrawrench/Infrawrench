import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { CostDimensionOption } from "./config.js";
import type { CostApi } from "./types.js";

/**
 * A picker over the org's virtual tags, by key, labelled with their names.
 *
 * Every editor that groups by or filters on `virtual_tag` needs the same list,
 * and nobody should have to type a key from memory. Loads through the host's
 * existing dimension call (`virtual-tag-keys`), so any host that can populate
 * a filter picker can populate this one. A value that no longer resolves stays
 * selectable, so a config referencing a deleted tag shows what it references.
 */
export function VirtualTagKeySelect({
  client,
  value,
  onChange,
  className,
  id,
}: {
  client: Pick<CostApi, "loadDimensionValues">;
  value: string;
  onChange: (key: string | undefined) => void;
  className?: string | undefined;
  id?: string | undefined;
}) {
  const gt = useGT();
  const [options, setOptions] = useState<CostDimensionOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .loadDimensionValues("virtual-tag-keys")
      .then((next) => {
        if (!cancelled) setOptions(next);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const all =
    value && !(options ?? []).some((o) => o.value === value)
      ? [...(options ?? []), { value, label: value }]
      : (options ?? []);

  return (
    <select
      id={id}
      aria-label={gt("Virtual tag")}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">
        {options === null
          ? gt("Loading…")
          : options.length === 0
            ? gt("No virtual tags yet")
            : gt("Choose a virtual tag…")}
      </option>
      {all.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
