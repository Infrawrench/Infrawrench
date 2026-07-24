/**
 * Dark theme constants, matching the web app's surface palette. Kept as plain
 * values (not a ThemeProvider) — the app is dark-only for v1, like the
 * desktop default.
 */
export const colors = {
  background: "#0b0d10",
  surface: "#14171c",
  surfaceOverlay: "#1c2027",
  border: "#262b33",
  borderStrong: "#343b45",
  text: "#e6e9ed",
  textSecondary: "#b3bac3",
  textMuted: "#8a919b",
  textFaint: "#5d646e",
  accent: "#3b82f6",
  accentPressed: "#2563eb",
  danger: "#f87171",
  success: "#4ade80",
  warning: "#fbbf24",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;
