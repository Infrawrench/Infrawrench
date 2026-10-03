import { useMemo } from "react";
import { useGT } from "gt-react";

import type { WorkflowMetricDef, WorkflowMetricRow } from "./types.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";

export function MetricsEditor({
  defs,
  values,
  onChange,
}: {
  defs: WorkflowMetricDef[];
  values: WorkflowMetricRow[];
  onChange: (defs: WorkflowMetricDef[]) => void;
}) {
  const gt = useGT();
  const valueByKey = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const v of values) m.set(v.key, v.value);
    return m;
  }, [values]);

  const update = (i: number, p: Partial<WorkflowMetricDef>) => {
    onChange(defs.map((d, idx) => (idx === i ? { ...d, ...p } : d)));
  };

  return (
    <div className="px-3 py-2 border-b border-white/10 text-xs">
      <div className="flex items-center justify-between mb-1">
        <span className="opacity-60">{gt("Metrics")}</span>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...defs,
              { key: `metric${defs.length + 1}`, label: gt("Metric"), type: "number" },
            ])
          }
          className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
        >
          {gt("+ Add metric")}
        </button>
      </div>
      {defs.length === 0 && (
        <div className="opacity-50">
          {gt("No metrics. Add one to read/write it from the workflow.")}
        </div>
      )}
      {defs.map((d, i) => (
        <div key={i} className="flex items-center gap-1 mb-1 flex-wrap">
          <input
            value={d.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={gt("key")}
            aria-label={gt("Metric key")}
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-28 font-mono"
          />
          <input
            value={d.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder={gt("label")}
            aria-label={gt("Metric label")}
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-32"
          />
          <select
            value={d.type}
            onChange={(e) => update(i, { type: e.target.value as WorkflowMetricDef["type"] })}
            aria-label={gt("Metric type")}
            className="bg-transparent border border-white/15 rounded px-1 py-0.5"
          >
            <option value="number">number</option>
            <option value="string">string</option>
            <option value="boolean">boolean</option>
          </select>
          <input
            value={d.unit ?? ""}
            onChange={(e) => update(i, { unit: e.target.value })}
            placeholder={gt("unit")}
            aria-label={gt("Metric unit")}
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-16"
          />
          <span className="opacity-60">= {String(valueByKey.get(d.key) ?? "—")}</span>
          <button
            type="button"
            onClick={() => onChange(defs.filter((_, idx) => idx !== i))}
            aria-label={gt("Remove metric {name}", { name: d.key || d.label || String(i + 1) })}
            title={gt("Remove metric {name}", { name: d.key || d.label || String(i + 1) })}
            className="px-1 opacity-60 hover:opacity-100"
          >
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
