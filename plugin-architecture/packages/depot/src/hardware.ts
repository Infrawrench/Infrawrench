/**
 * Depot's `Hardware` enum (`depot.core.v1.Hardware`): the builder size a
 * project's container builds run on, as vCPUs x GB of memory. The user sees
 * and picks the friendly form; the wire carries the enum name.
 */

export const HARDWARE_OPTIONS: ReadonlyArray<{ value: string; wire: string; label: string }> = [
  { value: "default", wire: "HARDWARE_UNSPECIFIED", label: "Depot default" },
  { value: "4x4", wire: "HARDWARE_4X4", label: "4 vCPU, 4 GB" },
  { value: "4x8", wire: "HARDWARE_4X8", label: "4 vCPU, 8 GB" },
  { value: "8x8", wire: "HARDWARE_8X8", label: "8 vCPU, 8 GB" },
  { value: "8x16", wire: "HARDWARE_8X16", label: "8 vCPU, 16 GB" },
  { value: "16x32", wire: "HARDWARE_16X32", label: "16 vCPU, 32 GB" },
  { value: "32x64", wire: "HARDWARE_32X64", label: "32 vCPU, 64 GB" },
  { value: "64x128", wire: "HARDWARE_64X128", label: "64 vCPU, 128 GB" },
  { value: "96x192", wire: "HARDWARE_96X192", label: "96 vCPU, 192 GB" },
  { value: "192x384", wire: "HARDWARE_192X384", label: "192 vCPU, 384 GB" },
  { value: "384x768", wire: "HARDWARE_384X768", label: "384 vCPU, 768 GB" },
];

export function hardwareFromWire(wire: string | undefined): string {
  return HARDWARE_OPTIONS.find((h) => h.wire === wire)?.value ?? "default";
}

/** `undefined` for "default": the field is left out and Depot keeps its own choice. */
export function hardwareToWire(value: string | undefined): string | undefined {
  const match = HARDWARE_OPTIONS.find((h) => h.value === (value ?? "").trim().toLowerCase());
  return match && match.value !== "default" ? match.wire : undefined;
}

export function hardwareLabel(value: string): string {
  return HARDWARE_OPTIONS.find((h) => h.value === value)?.label ?? value;
}

/** Regions a project's builders can live in (`CreateProjectRequest.region_id`). */
export const DEPOT_REGIONS = [
  {
    id: "us-east-1",
    label: "US East (us-east-1)",
    location: "Virginia, United States",
    flag: "🇺🇸",
  },
  {
    id: "eu-central-1",
    label: "EU Central (eu-central-1)",
    location: "Frankfurt, Germany",
    flag: "🇩🇪",
  },
];
