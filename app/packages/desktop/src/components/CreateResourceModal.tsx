import { useState, useEffect, useMemo } from "react";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "../lib/sql-drivers";
import type { ResourceTypeDefinition, CreateResourceConfig, CreateFieldConfig, SizeOption, ImageOption, DiskOption } from "@infrawrench/plugin-base";

interface CreateResourceModalProps {
  accountId: string;
  pluginId: string;
  resourceType: ResourceTypeDefinition;
  onClose: () => void;
  onCreated: (resource: import("@infrawrench/plugin-base").ResourceInstance) => void;
}

export function CreateResourceModal({
  accountId,
  pluginId,
  resourceType,
  onClose,
  onCreated,
}: CreateResourceModalProps) {
  const [config, setConfig] = useState<CreateResourceConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the create config (API-driven: regions, sizes, etc.)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const db = await getDb();
        const rows = await db.select<{ encrypted_credentials: string; credentials_iv: string }[]>(
          "SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
          [accountId],
        );
        if (!rows[0]) throw new Error("Account not found");
        const plaintext = await invoke<string>("decrypt_value", {
          ciphertext: rows[0].encrypted_credentials,
          iv: rows[0].credentials_iv,
        });
        const credentials = JSON.parse(plaintext) as Record<string, string>;
        const loaded = await getPlugin(pluginId);
        if (!loaded) throw new Error(`Plugin "${pluginId}" not loaded`);
        const { plugin } = loaded;
        const services = buildPluginHostServices(plugin.manifest, credentials);
        const client = plugin.createClient(credentials, services);
        if (!client.getCreateConfig) throw new Error("Plugin does not support dynamic create config");
        const cfg = await client.getCreateConfig(resourceType.id);
        if (!cancelled) {
          setConfig(cfg);
          // Seed defaults
          const init: Record<string, string> = {};
          for (const f of cfg.fields) {
            if (f.defaultValue) init[f.key] = f.defaultValue;
            else if (f.kind === "disk-slider") init[f.key] = String(f.defaultGb ?? f.minGb ?? 20);
          }
          setFields(init);
        }
      } catch (e) {
        if (!cancelled) setConfigError(String(e));
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [accountId, pluginId, resourceType.id]);

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const db = await getDb();
      const rows = await db.select<{ encrypted_credentials: string; credentials_iv: string }[]>(
        "SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
        [accountId],
      );
      if (!rows[0]) throw new Error("Account not found");
      const plaintext = await invoke<string>("decrypt_value", {
        ciphertext: rows[0].encrypted_credentials,
        iv: rows[0].credentials_iv,
      });
      const credentials = JSON.parse(plaintext) as Record<string, string>;
      const loaded = await getPlugin(pluginId);
      if (!loaded) throw new Error(`Plugin "${pluginId}" not loaded`);
      const { plugin } = loaded;
      const services = buildPluginHostServices(plugin.manifest, credentials);
      const client = plugin.createClient(credentials, services);
      if (!client.createResource) throw new Error("Plugin does not support resource creation");
      // Only submit fields that are currently visible (respect showWhen)
      const cfg = config;
      const visibleFields: Record<string, string> = {};
      for (const f of (cfg?.fields ?? [])) {
        if (f.showWhen && fields[f.showWhen.fieldKey] !== f.showWhen.fieldValue) continue;
        if (fields[f.key] !== undefined) visibleFields[f.key] = fields[f.key]!;
      }
      const created = await client.createResource(resourceType.id, accountId, visibleFields);
      onCreated(created);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[560px] max-h-[72vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-100">
            Create {resourceType.displayName}
          </h2>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {loadingConfig ? (
            <div className="flex items-center gap-3 text-sm text-gray-500 py-8 justify-center">
              <span className="animate-spin inline-block w-4 h-4 rounded-full border-2 border-gray-600 border-t-gray-300" />
              Fetching available options…
            </div>
          ) : configError ? (
            <p className="text-sm text-red-400">{configError}</p>
          ) : config ? (
            <div className="space-y-6">
              {config.fields
                .filter((f) => !f.showWhen || fields[f.showWhen.fieldKey] === f.showWhen.fieldValue)
                .map((f) => (
                  <FieldRenderer key={f.key} field={f} value={fields[f.key] ?? ""} onChange={(v) => setField(f.key, v)} />
                ))}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex-shrink-0">
          {error && (
            <p className="text-xs text-red-400 bg-red-900/20 rounded px-3 py-2 mb-3">{error}</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={creating || loadingConfig || !!configError}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {creating ? "Creating…" : `Create ${resourceType.displayName}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Field renderers ──────────────────────────────────────────────────────────

function FieldRenderer({ field, value, onChange }: { field: CreateFieldConfig; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-2">
        {field.label}
        {field.required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {field.description && <p className="text-xs text-gray-600 mb-2">{field.description}</p>}

      {field.kind === "text" && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.label}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
      )}

      {field.kind === "select" && field.options && (
        <div className="flex gap-2 flex-wrap">
          {field.options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => onChange(opt.id)}
              className={`px-4 py-2 rounded-lg border text-sm transition-all ${
                value === opt.id
                  ? "border-blue-500 bg-blue-600/10 text-blue-300"
                  : "border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {field.kind === "region-picker" && field.regions && (
        <RegionPicker regions={field.regions} value={value} onChange={onChange} />
      )}

      {field.kind === "size-picker" && field.sizes && (
        <SizePicker sizes={field.sizes} value={value} onChange={onChange} />
      )}

      {field.kind === "disk-slider" && (
        <DiskSlider
          value={Number(value) || field.defaultGb || field.minGb || 10}
          min={field.minGb ?? 10}
          max={field.maxGb ?? 2000}
          step={field.stepGb ?? 10}
          onChange={(n) => onChange(String(n))}
        />
      )}

      {field.kind === "image-picker" && field.images && (
        <ImagePicker images={field.images} value={value} onChange={onChange} />
      )}

      {field.kind === "disk-picker" && field.disks && (
        <DiskPicker disks={field.disks} value={value} onChange={onChange} />
      )}

      {field.kind === "ssh-key-picker" && (
        <SshKeyPicker value={value} onChange={onChange} />
      )}
    </div>
  );
}

// ─── Region picker ────────────────────────────────────────────────────────────

function RegionPicker({ regions, value, onChange }: { regions: { id: string; label: string; location?: string; flag?: string }[]; value: string; onChange: (v: string) => void }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? regions.filter((r) =>
          r.label.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          r.location?.toLowerCase().includes(q),
        )
      : regions;
  }, [regions, search]);

  const selected = regions.find((r) => r.id === value);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-700 bg-gray-800/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by location or zone…"
          className="flex-1 bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none"
        />
        {selected && !search && (
          <span className="text-xs text-blue-400 flex-shrink-0 flex items-center gap-1">
            {selected.flag && <span>{selected.flag}</span>}
            <span>{selected.location ?? selected.label}</span>
            <span className="font-mono text-blue-400/60">({selected.id})</span>
          </span>
        )}
      </div>
      <div className="max-h-44 overflow-y-auto">
        {filtered.map((r) => (
          <button
            key={r.id}
            onClick={() => onChange(r.id)}
            className={`w-full text-left px-3 py-2.5 transition-colors flex items-center gap-3 ${
              value === r.id ? "bg-blue-600/20" : "hover:bg-gray-800"
            }`}
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${value === r.id ? "bg-blue-400" : "bg-gray-700"}`} />
            {r.flag && <span className="text-base leading-none flex-shrink-0">{r.flag}</span>}
            <span className="min-w-0 flex-1">
              <span className={`block text-sm ${value === r.id ? "text-blue-300" : "text-gray-300"}`}>
                {r.location ?? r.label}
              </span>
              <span className={`block text-[11px] font-mono mt-0.5 ${value === r.id ? "text-blue-400/70" : "text-gray-600"}`}>{r.id}</span>
            </span>
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="px-3 py-3 text-xs text-gray-600">No matches</p>
        )}
      </div>
    </div>
  );
}

// ─── Size picker ──────────────────────────────────────────────────────────────

function SizePicker({ sizes, value, onChange }: { sizes: SizeOption[]; value: string; onChange: (v: string) => void }) {
  const categories = useMemo(() => {
    const map = new Map<string, SizeOption[]>();
    for (const s of sizes) {
      const cat = s.category ?? "Standard";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(s);
    }
    return map;
  }, [sizes]);

  // Find which category contains the current selection, default it open
  const selectedCategory = useMemo(() => {
    for (const [cat, catSizes] of categories) {
      if (catSizes.some((s) => s.id === value)) return cat;
    }
    return [...categories.keys()][0] ?? null;
  }, [categories, value]);

  const [openCats, setOpenCats] = useState<Set<string>>(() => new Set(selectedCategory ? [selectedCategory] : []));

  function toggleCat(cat: string) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  const maxMemory = useMemo(() => Math.max(...sizes.map((s) => s.memoryMb)), [sizes]);
  const maxCpu = useMemo(() => Math.max(...sizes.map((s) => s.vcpus)), [sizes]);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
    <div className="divide-y divide-gray-700/60 max-h-[260px] overflow-y-auto">
      {[...categories.entries()].map(([cat, catSizes]) => {
        const isOpen = openCats.has(cat);
        const hasSelection = catSizes.some((s) => s.id === value);
        const selectedInCat = hasSelection ? catSizes.find((s) => s.id === value) : null;
        return (
          <div key={cat}>
            <button
              onClick={() => toggleCat(cat)}
              className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-800/60 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="text-gray-600 text-[10px] transition-transform flex-shrink-0"
                  style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}
                >
                  ▶
                </span>
                <span className="text-xs font-medium text-gray-400">{cat}</span>
              </div>
              {hasSelection && !isOpen && selectedInCat && (
                <span className="text-xs text-blue-400 font-mono truncate ml-2">{selectedInCat.label}</span>
              )}
              {!hasSelection && (
                <span className="text-xs text-gray-600">{catSizes.length} options</span>
              )}
            </button>
            {isOpen && (
              <div className="px-3 pb-3 pt-1 grid grid-cols-3 gap-2 bg-gray-900/40">
                {catSizes.map((s) => (
                  <SizeCard
                    key={s.id}
                    size={s}
                    selected={value === s.id}
                    maxMemory={maxMemory}
                    maxCpu={maxCpu}
                    onSelect={() => onChange(s.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
    </div>
  );
}

function SizeCard({ size, selected, maxMemory, maxCpu, onSelect }: {
  size: SizeOption;
  selected: boolean;
  maxMemory: number;
  maxCpu: number;
  onSelect: () => void;
}) {
  const memPct = Math.max(4, Math.round((size.memoryMb / maxMemory) * 100));
  const cpuPct = Math.max(4, Math.round((size.vcpus / maxCpu) * 100));
  const memLabel = size.memoryMb >= 1024 ? `${(size.memoryMb / 1024).toFixed(size.memoryMb % 1024 === 0 ? 0 : 1)} GB` : `${size.memoryMb} MB`;

  return (
    <button
      onClick={onSelect}
      className={`text-left p-3 rounded-lg border transition-all ${
        selected
          ? "border-blue-500 bg-blue-600/10"
          : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
      }`}
    >
      <p className={`text-xs font-mono font-medium mb-2 truncate ${selected ? "text-blue-300" : "text-gray-300"}`}>
        {size.label}
      </p>

      {/* CPU bar */}
      <div className="mb-1.5">
        <div className="flex justify-between mb-0.5">
          <span className="text-[10px] text-gray-600">CPU</span>
          <span className="text-[10px] text-gray-500">{size.vcpus} vCPU{size.vcpus !== 1 ? "s" : ""}</span>
        </div>
        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${selected ? "bg-blue-500" : "bg-gray-500"}`}
            style={{ width: `${cpuPct}%` }}
          />
        </div>
      </div>

      {/* RAM bar */}
      <div className="mb-2">
        <div className="flex justify-between mb-0.5">
          <span className="text-[10px] text-gray-600">RAM</span>
          <span className="text-[10px] text-gray-500">{memLabel}</span>
        </div>
        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${selected ? "bg-blue-400" : "bg-gray-500"}`}
            style={{ width: `${memPct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        {size.diskGb != null && (
          <span className="text-[10px] text-gray-600">{size.diskGb} GB disk</span>
        )}
        {size.priceMonthly != null && (
          <span className={`text-[10px] ml-auto ${selected ? "text-blue-400" : "text-gray-500"}`}>
            ${size.priceMonthly}/mo
          </span>
        )}
      </div>
    </button>
  );
}

// ─── Disk slider ──────────────────────────────────────────────────────────────

function DiskSlider({ value, min, max, step, onChange }: {
  value: number; min: number; max: number; step: number; onChange: (n: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500">{min} GB</span>
        <span className="text-sm font-medium text-gray-200">{value} GB</span>
        <span className="text-xs text-gray-500">{max} GB</span>
      </div>
      <div className="relative h-6 flex items-center">
        <div className="absolute w-full h-1.5 bg-gray-700 rounded-full">
          <div
            className="absolute h-full bg-blue-500 rounded-full"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute w-full appearance-none bg-transparent cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-blue-300 [&::-webkit-slider-thumb]:shadow-md"
        />
      </div>
    </div>
  );
}

// ─── Image picker ─────────────────────────────────────────────────────────────

function ImagePicker({ images, value, onChange }: { images: ImageOption[]; value: string; onChange: (v: string) => void }) {
  const [search, setSearch] = useState("");

  const categories = useMemo(() => {
    const map = new Map<string, ImageOption[]>();
    for (const img of images) {
      const cat = img.category ?? "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(img);
    }
    return map;
  }, [images]);

  const filtered = useMemo(() => {
    if (!search) return null; // no search — show categorised
    const q = search.toLowerCase();
    return images.filter((i) => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q));
  }, [images, search]);

  const selectedImage = images.find((i) => i.id === value);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      {/* Search + selected summary */}
      <div className="px-3 py-2 border-b border-gray-700 bg-gray-800/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search images…"
          className="flex-1 bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none"
        />
        {selectedImage && !search && (
          <span className="text-xs text-blue-400 truncate max-w-[160px]">{selectedImage.label}</span>
        )}
      </div>

      <div className="max-h-52 overflow-y-auto">
        {filtered ? (
          // Flat search results
          filtered.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-600">No matches</p>
          ) : (
            filtered.map((img) => (
              <ImageRow key={img.id} img={img} selected={value === img.id} onSelect={() => onChange(img.id)} />
            ))
          )
        ) : (
          // Categorised
          [...categories.entries()].map(([cat, catImages]) => (
            <div key={cat}>
              <div className="px-3 py-1 bg-gray-800/30 border-b border-gray-700/40">
                <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">{cat}</span>
              </div>
              {catImages.map((img) => (
                <ImageRow key={img.id} img={img} selected={value === img.id} onSelect={() => onChange(img.id)} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ImageRow({ img, selected, onSelect }: { img: ImageOption; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
        selected ? "bg-blue-600/20 text-blue-300" : "text-gray-300 hover:bg-gray-800"
      }`}
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-gray-700"}`} />
      <span className="truncate">{img.label}</span>
      {img.isOwned && <span className="text-[10px] text-gray-600 ml-auto flex-shrink-0">owned</span>}
    </button>
  );
}

// ─── Disk picker ──────────────────────────────────────────────────────────────

function DiskPicker({ disks, value, onChange }: { disks: DiskOption[]; value: string; onChange: (v: string) => void }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? disks.filter((d) => d.label.toLowerCase().includes(q) || d.zone?.toLowerCase().includes(q)) : disks;
  }, [disks, search]);

  if (disks.length === 0) {
    return <p className="text-sm text-gray-600 py-1">No existing disks found in this project.</p>;
  }

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-700 bg-gray-800/50">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search disks…"
          className="w-full bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none"
        />
      </div>
      <div className="max-h-52 overflow-y-auto">
        {filtered.map((d) => (
          <button
            key={d.id}
            onClick={() => onChange(d.id)}
            className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
              value === d.id ? "bg-blue-600/20 text-blue-300" : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${value === d.id ? "bg-blue-400" : "bg-gray-700"}`} />
            <span className="flex-1 min-w-0">
              <span className="font-medium truncate block">{d.label}</span>
              <span className="text-[11px] text-gray-500">{d.sizeGb} GB{d.zone ? ` · ${d.zone}` : ""}{d.diskType ? ` · ${d.diskType}` : ""}</span>
            </span>
          </button>
        ))}
        {filtered.length === 0 && <p className="px-3 py-3 text-xs text-gray-600">No matches</p>}
      </div>
    </div>
  );
}

// ─── SSH key picker ───────────────────────────────────────────────────────────

interface SshKeyEntry {
  name: string;       // display label, e.g. "id_rsa"
  publicKey: string;  // full public key content
  source: "system";
}

function SshKeyPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [keys, setKeys] = useState<SshKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const sysKeys = await invoke<{ name: string }[]>("ssh_list_system_keys");
        const entries: SshKeyEntry[] = [];
        await Promise.all(sysKeys.map(async ({ name }) => {
          try {
            const pub = await invoke<string>("ssh_read_system_key", { name: `${name}.pub` });
            if (!cancelled && pub.trim()) {
              entries.push({ name, publicKey: pub.trim(), source: "system" });
            }
          } catch { /* no .pub file for this key */ }
        }));
        if (!cancelled) setKeys(entries.sort((a, b) => a.name.localeCompare(b.name)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <p className="text-xs text-gray-600 py-1">Scanning ~/.ssh…</p>;
  }

  if (keys.length === 0) {
    return <p className="text-xs text-gray-600 py-1">No public keys found in ~/.ssh/</p>;
  }

  const noneSelected = !value;

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden divide-y divide-gray-700/40">
      {/* None option */}
      <button
        onClick={() => onChange("")}
        className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-2 ${
          noneSelected ? "bg-blue-600/20 text-blue-300" : "text-gray-500 hover:bg-gray-800"
        }`}
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${noneSelected ? "bg-blue-400" : "bg-gray-700"}`} />
        No SSH key
      </button>

      {keys.map((k) => {
        const selected = value === k.publicKey;
        const keyType = k.publicKey.split(" ")[0] ?? "";
        return (
          <button
            key={k.name}
            onClick={() => onChange(k.publicKey)}
            className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
              selected ? "bg-blue-600/20 text-blue-300" : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-gray-700"}`} />
            <span className="flex-1 min-w-0">
              <span className="font-medium block">{k.name}</span>
              <span className="text-[11px] text-gray-600">~/.ssh/{k.name}.pub · {keyType}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
