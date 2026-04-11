import type { CreateFieldConfig } from "@infrawrench/plugin-base";
import { SelectPicker } from "./SelectPicker.js";
import { RegionPicker } from "./RegionPicker.js";
import { SizePicker } from "./SizePicker.js";
import { DiskSlider } from "./DiskSlider.js";
import { ImagePicker } from "./ImagePicker.js";
import { DiskPicker } from "./DiskPicker.js";
import { SshKeyPicker, type SshKeyEntry, type SystemSshKey } from "./SshKeyPicker.js";

export interface SshKeyPickerCallbacks {
  loadKeys: () => Promise<SshKeyEntry[]>;
  generateKey: (name: string) => Promise<SshKeyEntry & { privateKey?: string }>;
  deleteKey: (id: string) => Promise<void>;
  /** The current user's ID — used to determine which keys are deletable */
  currentUserId?: string;
  /** System-level keys (e.g. from ~/.ssh on desktop). Omit on web. */
  systemKeys?: SystemSshKey[];
  /** When false, shows a sign-in prompt instead of cloud keys. Defaults to true. */
  cloudEnabled?: boolean;
  /** When false, hides the cloud keys section entirely (e.g. desktop in local-only mode). Defaults to true. */
  showCloudSection?: boolean;
  /** Called when the user clicks "Sign in" in the cloud keys section. */
  onCloudSignIn?: () => void;
}

export interface FieldRendererProps {
  field: CreateFieldConfig;
  value: string;
  onChange: (v: string) => void;
  /** Cloud-managed + optional system SSH key callbacks. If omitted, falls back to a plain textarea. */
  sshKeyProps?: SshKeyPickerCallbacks;
}

export function FieldRenderer({ field, value, onChange, sshKeyProps }: FieldRendererProps) {
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
        sshKeyProps ? (
          <SshKeyPicker
            value={value}
            onChange={onChange}
            loadKeys={sshKeyProps.loadKeys}
            generateKey={sshKeyProps.generateKey}
            deleteKey={sshKeyProps.deleteKey}
            currentUserId={sshKeyProps.currentUserId}
            systemKeys={sshKeyProps.systemKeys}
            cloudEnabled={sshKeyProps.cloudEnabled}
            showCloudSection={sshKeyProps.showCloudSection}
            onCloudSignIn={sshKeyProps.onCloudSignIn}
          />
        ) : (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Paste SSH public key..."
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono resize-none"
          />
        )
      )}
    </div>
  );
}
