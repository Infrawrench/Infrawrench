/**
 * Types for the dynamic create-resource form.
 * Plugins implement `getCreateConfig` to return a fully-populated config
 * (including live API data like available regions, sizes, images, disks)
 * so the host can render a rich, platform-agnostic creation UI.
 */

export interface SizeOption {
  id: string;
  label: string;
  vcpus: number;
  memoryMb: number;
  /** Included boot disk in GB, if the platform bundles it with the size */
  diskGb?: number;
  priceMonthly?: number;
  category?: string;
}

export interface RegionOption {
  id: string;
  /** Short identifier shown in the selected-state summary */
  label: string;
  /** Human-readable city/country, e.g. "Iowa, USA" or "Frankfurt, Germany" */
  location?: string;
  /** Emoji flag, e.g. "🇺🇸" */
  flag?: string;
}

export interface ImageOption {
  /** Value submitted in `createResource` fields */
  id: string;
  label: string;
  description?: string;
  /** OS family slug, e.g. "debian-12", "ubuntu-2404-lts-amd64" */
  family?: string;
  /** True for images owned by the account (not public) */
  isOwned?: boolean;
  /** Grouping label, e.g. "Debian", "Ubuntu", "My Images" */
  category?: string;
}

export interface DiskOption {
  /** Value submitted in `createResource` fields */
  id: string;
  label: string;
  sizeGb: number;
  zone?: string;
  diskType?: string;
}

export type CreateFieldKind =
  | "text" // single-line text input
  | "number" // numeric input
  | "select" // simple dropdown with static options
  | "size-picker" // visual size selector with RAM/CPU bars
  | "region-picker" // searchable list of region/zone options
  | "disk-slider" // boot-disk GB slider
  | "image-picker" // OS image + account image picker
  | "disk-picker" // existing disk picker
  | "ssh-key-picker"; // SSH public key — host resolves from ~/.ssh and app registry

export interface CreateFieldConfig {
  /** Key used in the `fields` map passed to `createResource` */
  key: string;
  label: string;
  kind: CreateFieldKind;
  required: boolean;
  description?: string;
  defaultValue?: string;
  /**
   * When set, this field is only shown when `fieldKey` equals `fieldValue`.
   * Hidden fields are excluded from the submitted form data.
   */
  showWhen?: { fieldKey: string; fieldValue: string };
  /** `select` options */
  options?: { id: string; label: string }[];
  /** `number` input bounds */
  minValue?: number;
  maxValue?: number;
  stepValue?: number;
  /** `size-picker` data */
  sizes?: SizeOption[];
  /** `region-picker` data */
  regions?: RegionOption[];
  /** `disk-slider` — all values in GB */
  minGb?: number;
  maxGb?: number;
  defaultGb?: number;
  stepGb?: number;
  /** `image-picker` data */
  images?: ImageOption[];
  /** `disk-picker` data */
  disks?: DiskOption[];
}

export interface CreateResourceConfig {
  fields: CreateFieldConfig[];
}

/**
 * Optional follow-up pricing request for size-picker options.
 * Used by hosts to progressively hydrate prices after initial create-form render.
 */
export interface CreateSizePricingRequest {
  /** Region/zone selected in the create form (provider-specific identifier). */
  regionId?: string;
  /** Size options currently shown in the create form. */
  sizes: Array<{
    id: string;
    vcpus: number;
    memoryMb: number;
  }>;
}
