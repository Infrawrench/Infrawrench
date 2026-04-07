import type { CreateFieldConfig } from "@infrawrench/plugin-base";
import { SelectPicker } from "./SelectPicker";
import { RegionPicker } from "./RegionPicker";
import { SizePicker } from "./SizePicker";
import { DiskSlider } from "./DiskSlider";
import { ImagePicker } from "./ImagePicker";
import { DiskPicker } from "./DiskPicker";
import { SshKeyPicker } from "./SshKeyPicker";

export function FieldRenderer({ field, value, onChange }: { field: CreateFieldConfig; value: string; onChange: (v: string) => void }) {
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

      {field.kind === "number" && (
        <input
          type="number"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.label}
          min={field.minValue}
          max={field.maxValue}
          step={field.stepValue ?? 1}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
      )}

      {field.kind === "select" && field.options && (
        field.options.length <= 4 && Math.max(...field.options.map((opt) => opt.label.length)) < 28 ? (
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
        ) : (
          <SelectPicker options={field.options} value={value} onChange={onChange} />
        )
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
