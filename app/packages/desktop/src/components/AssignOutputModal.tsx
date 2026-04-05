import { useState, useEffect } from "react";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";

interface Props {
  /** The resource that is providing the output (e.g. a pg-database) */
  providerResourceId: string;
  providerPluginId: string;
  providerResourceTypeId: string;
  /** The output key being assigned (e.g. "connectionString") */
  outputKey: string;
  onClose: () => void;
}

interface StoredResource {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
}

interface TargetField {
  resource: StoredResource;
  fieldKey: string;
  fieldLabel: string;
}

export function AssignOutputModal({ providerResourceId, providerPluginId, providerResourceTypeId, outputKey, onClose }: Props) {
  const [targets, setTargets] = useState<TargetField[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [existingAssoc, setExistingAssoc] = useState<Map<string, string>>(new Map()); // resourceId:fieldKey → assoc id
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const db = await getDb();

        // Load all resources (excluding the provider itself)
        const rows = await db.select<StoredResource[]>(
          "SELECT id, plugin_id, resource_type_id, account_id, display_name FROM resources WHERE id != $1",
          [providerResourceId],
        );

        // Load existing associations where this provider is already assigned
        const assocRows = await db.select<{ id: string; consumer_resource_id: string; consumer_field_key: string }[]>(
          "SELECT id, consumer_resource_id, consumer_field_key FROM associations WHERE provider_resource_id = $1 AND provider_output_key = $2",
          [providerResourceId, outputKey],
        );
        const assocMap = new Map<string, string>();
        for (const a of assocRows) {
          assocMap.set(`${a.consumer_resource_id}:${a.consumer_field_key}`, a.id);
        }
        if (!cancelled) setExistingAssoc(assocMap);

        // For each resource, check if its type has a field that can accept this output
        const matchingTargets: TargetField[] = [];
        await Promise.all(
          rows.map(async (resource) => {
            const loaded = await getPlugin(resource.plugin_id);
            if (!loaded) return;
            const typeDef = loaded.plugin.resourceTypes.find((t) => t.id === resource.resource_type_id);
            if (!typeDef) return;

            for (const field of typeDef.fields) {
              const acceptsKey = field.resolvableOutputKeys?.includes(outputKey);
              const acceptsFrom = field.resolvableFrom?.some(
                (src) =>
                  src.pluginId === providerPluginId &&
                  src.resourceTypeId === providerResourceTypeId &&
                  src.outputKey === outputKey,
              );
              if (acceptsKey || acceptsFrom) {
                matchingTargets.push({ resource, fieldKey: field.key, fieldLabel: field.label });
              }
            }
          }),
        );

        if (!cancelled) {
          setTargets(matchingTargets);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [providerResourceId, providerPluginId, providerResourceTypeId, outputKey]);

  async function save() {
    if (selectedIdx === null) return;
    const target = targets[selectedIdx];
    if (!target) return;
    setSaving(true);
    try {
      const db = await getDb();
      const key = `${target.resource.id}:${target.fieldKey}`;
      const existingId = existingAssoc.get(key);

      if (existingId) {
        // Already assigned — remove (toggle off)
        await db.execute("DELETE FROM associations WHERE id = $1", [existingId]);
      } else {
        // Remove any prior association for this consumer field (UNIQUE constraint)
        await db.execute(
          "DELETE FROM associations WHERE consumer_resource_id = $1 AND consumer_field_key = $2",
          [target.resource.id, target.fieldKey],
        );
        await db.execute(
          `INSERT INTO associations (id, consumer_resource_id, consumer_field_key, provider_resource_id, provider_output_key)
           VALUES ($1, $2, $3, $4, $5)`,
          [crypto.randomUUID(), target.resource.id, target.fieldKey, providerResourceId, outputKey],
        );
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-2xl w-[480px] max-h-[70vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-100">Assign connection string</h2>
          <p className="text-xs text-gray-500 mt-1">
            Pick a resource field to link to this database's <span className="font-mono">{outputKey}</span> output.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="text-xs text-gray-600">Loading resources…</p>
          ) : error ? (
            <p className="text-xs text-red-400">{error}</p>
          ) : targets.length === 0 ? (
            <p className="text-xs text-gray-500">
              No resources with a compatible field found. Add a resource that accepts a{" "}
              <span className="font-mono">connectionString</span> (e.g. another PostgreSQL database resource).
            </p>
          ) : (
            <ul className="space-y-1.5">
              {targets.map((target, i) => {
                const key = `${target.resource.id}:${target.fieldKey}`;
                const alreadyAssigned = existingAssoc.has(key);
                const isSelected = selectedIdx === i;
                return (
                  <li key={key}>
                    <button
                      onClick={() => setSelectedIdx(isSelected ? null : i)}
                      className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${
                        isSelected
                          ? "border-blue-500 bg-blue-500/10"
                          : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="text-sm font-medium text-gray-200 block truncate">
                            {target.resource.display_name}
                          </span>
                          <span className="text-xs text-gray-500">
                            {target.resource.plugin_id} · {target.fieldLabel}
                          </span>
                        </div>
                        {alreadyAssigned && (
                          <span className="shrink-0 text-xs text-blue-400 font-medium">linked</span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-800 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={selectedIdx === null || saving}
            className="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            {saving ? "Saving…" : (() => {
              if (selectedIdx === null) return "Assign";
              const target = targets[selectedIdx];
              if (!target) return "Assign";
              const key = `${target.resource.id}:${target.fieldKey}`;
              return existingAssoc.has(key) ? "Unlink" : "Assign";
            })()}
          </button>
        </div>
      </div>
    </div>
  );
}
