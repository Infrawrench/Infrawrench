import type { SelectOption, SizeOption } from "@infrawrench/plugin-base";

/**
 * Instance types the create and edit forms offer. Render has no API that
 * lists plans, so these come from the `plan` enums in the OpenAPI spec, with
 * CPU, memory and list price from https://render.com/pricing (2026-10).
 * The API accepts both the hardware-shaped ids (`2c-4g`) and the older named
 * plans (`pro`); workspaces created before the switch still use the names.
 */

export const SERVICE_SIZES: SizeOption[] = [
  { id: "free", label: "Free", vcpus: 0.1, memoryMb: 512, priceMonthly: 0, category: "Free" },
  {
    id: "0.5c-512mb",
    label: "0.5 CPU, 512 MB",
    vcpus: 0.5,
    memoryMb: 512,
    priceMonthly: 7,
    category: "Compute",
  },
  {
    id: "1c-2g",
    label: "1 CPU, 2 GB",
    vcpus: 1,
    memoryMb: 2048,
    priceMonthly: 25,
    category: "Compute",
  },
  {
    id: "2c-4g",
    label: "2 CPU, 4 GB",
    vcpus: 2,
    memoryMb: 4096,
    priceMonthly: 85,
    category: "Compute",
  },
  {
    id: "2c-8g",
    label: "2 CPU, 8 GB",
    vcpus: 2,
    memoryMb: 8192,
    priceMonthly: 135,
    category: "Compute",
  },
  {
    id: "2c-16g",
    label: "2 CPU, 16 GB",
    vcpus: 2,
    memoryMb: 16384,
    priceMonthly: 200,
    category: "Compute",
  },
  {
    id: "4c-8g",
    label: "4 CPU, 8 GB",
    vcpus: 4,
    memoryMb: 8192,
    priceMonthly: 175,
    category: "Compute",
  },
  {
    id: "4c-16g",
    label: "4 CPU, 16 GB",
    vcpus: 4,
    memoryMb: 16384,
    priceMonthly: 225,
    category: "Compute",
  },
  {
    id: "4c-32g",
    label: "4 CPU, 32 GB",
    vcpus: 4,
    memoryMb: 32768,
    priceMonthly: 350,
    category: "Compute",
  },
  {
    id: "8c-16g",
    label: "8 CPU, 16 GB",
    vcpus: 8,
    memoryMb: 16384,
    priceMonthly: 300,
    category: "Compute",
  },
  {
    id: "8c-32g",
    label: "8 CPU, 32 GB",
    vcpus: 8,
    memoryMb: 32768,
    priceMonthly: 450,
    category: "Compute",
  },
  {
    id: "8c-64g",
    label: "8 CPU, 64 GB",
    vcpus: 8,
    memoryMb: 65536,
    priceMonthly: 1000,
    category: "Compute",
  },
  {
    id: "12c-24g",
    label: "12 CPU, 24 GB",
    vcpus: 12,
    memoryMb: 24576,
    priceMonthly: 450,
    category: "Compute",
  },
  {
    id: "12c-48g",
    label: "12 CPU, 48 GB",
    vcpus: 12,
    memoryMb: 49152,
    priceMonthly: 800,
    category: "Compute",
  },
  {
    id: "12c-96g",
    label: "12 CPU, 96 GB",
    vcpus: 12,
    memoryMb: 98304,
    priceMonthly: 1500,
    category: "Compute",
  },
  {
    id: "starter",
    label: "Starter",
    vcpus: 0.5,
    memoryMb: 512,
    priceMonthly: 7,
    category: "Named plans",
  },
  {
    id: "standard",
    label: "Standard",
    vcpus: 1,
    memoryMb: 2048,
    priceMonthly: 25,
    category: "Named plans",
  },
  { id: "pro", label: "Pro", vcpus: 2, memoryMb: 4096, priceMonthly: 85, category: "Named plans" },
  {
    id: "pro_plus",
    label: "Pro Plus",
    vcpus: 4,
    memoryMb: 8192,
    priceMonthly: 175,
    category: "Named plans",
  },
  {
    id: "pro_max",
    label: "Pro Max",
    vcpus: 4,
    memoryMb: 16384,
    priceMonthly: 225,
    category: "Named plans",
  },
  {
    id: "pro_ultra",
    label: "Pro Ultra",
    vcpus: 8,
    memoryMb: 32768,
    priceMonthly: 450,
    category: "Named plans",
  },
];

export const POSTGRES_PLANS: SelectOption[] = [
  { id: "free", label: "Free (256 MB, expires after 30 days)" },
  { id: "basic_256mb", label: "Basic 256 MB" },
  { id: "basic_1gb", label: "Basic 1 GB" },
  { id: "basic_4gb", label: "Basic 4 GB" },
  { id: "pro_4gb", label: "Pro 4 GB (1 CPU)" },
  { id: "pro_8gb", label: "Pro 8 GB (2 CPU)" },
  { id: "pro_16gb", label: "Pro 16 GB (4 CPU)" },
  { id: "pro_32gb", label: "Pro 32 GB (8 CPU)" },
  { id: "pro_64gb", label: "Pro 64 GB (16 CPU)" },
  { id: "pro_128gb", label: "Pro 128 GB (32 CPU)" },
  { id: "pro_192gb", label: "Pro 192 GB (48 CPU)" },
  { id: "pro_256gb", label: "Pro 256 GB (64 CPU)" },
  { id: "pro_384gb", label: "Pro 384 GB (96 CPU)" },
  { id: "pro_512gb", label: "Pro 512 GB (128 CPU)" },
  { id: "accelerated_16gb", label: "Accelerated 16 GB (2 CPU)" },
  { id: "accelerated_32gb", label: "Accelerated 32 GB (4 CPU)" },
  { id: "accelerated_64gb", label: "Accelerated 64 GB (8 CPU)" },
  { id: "accelerated_128gb", label: "Accelerated 128 GB (16 CPU)" },
  { id: "accelerated_256gb", label: "Accelerated 256 GB (32 CPU)" },
  { id: "accelerated_384gb", label: "Accelerated 384 GB (48 CPU)" },
  { id: "accelerated_512gb", label: "Accelerated 512 GB (64 CPU)" },
  { id: "accelerated_768gb", label: "Accelerated 768 GB (96 CPU)" },
  { id: "accelerated_1024gb", label: "Accelerated 1024 GB (128 CPU)" },
];

export const POSTGRES_VERSIONS = ["18", "17", "16", "15", "14", "13", "12", "11"];

export const KEY_VALUE_PLANS: SelectOption[] = [
  { id: "free", label: "Free (25 MB, no persistence)" },
  { id: "starter", label: "Starter (256 MB)" },
  { id: "standard", label: "Standard (1 GB)" },
  { id: "pro", label: "Pro (5 GB)" },
  { id: "pro_plus", label: "Pro Plus (10 GB)" },
  { id: "256mb", label: "256 MB" },
  { id: "1g", label: "1 GB" },
  { id: "5g", label: "5 GB" },
  { id: "10g", label: "10 GB" },
  { id: "20g", label: "20 GB" },
  { id: "40g", label: "40 GB" },
];

export const REGION_OPTIONS = [
  { id: "oregon", label: "Oregon", location: "Oregon, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "ohio", label: "Ohio", location: "Ohio, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "virginia", label: "Virginia", location: "Virginia, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  {
    id: "frankfurt",
    label: "Frankfurt",
    location: "Frankfurt, Germany",
    flag: "\u{1F1E9}\u{1F1EA}",
  },
  { id: "singapore", label: "Singapore", location: "Singapore", flag: "\u{1F1F8}\u{1F1EC}" },
];

export const EVICTION_POLICIES: SelectOption[] = [
  { id: "allkeys_lru", label: "allkeys-lru (cache)" },
  { id: "noeviction", label: "noeviction (queue / persistent store)" },
  { id: "allkeys_lfu", label: "allkeys-lfu" },
  { id: "allkeys_random", label: "allkeys-random" },
  { id: "volatile_lru", label: "volatile-lru" },
  { id: "volatile_lfu", label: "volatile-lfu" },
  { id: "volatile_random", label: "volatile-random" },
  { id: "volatile_ttl", label: "volatile-ttl" },
];
