import { useState, useEffect } from "react";
import { SERIES_COLORS } from "@infrawrench/client-core";

interface ChartTheme {
  colors: string[];
  grid: string;
  axis: string;
  tick: string;
  tooltipBg: string;
  tooltipBorder: string;
}

function readChartTheme(): ChartTheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    // The categorical rotation is shared with mobile rather than restated
    // here, so the same series is the same colour on every surface.
    colors: [...SERIES_COLORS],
    grid: v("--color-chart-grid") || "#374151",
    axis: v("--color-chart-axis") || "#4b5563",
    tick: v("--color-chart-tick") || "#9ca3af",
    tooltipBg: v("--color-chart-tooltip-bg") || "#1f2937",
    tooltipBorder: v("--color-chart-tooltip-border") || "#374151",
  };
}

export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState(readChartTheme);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setTheme(readChartTheme());
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return theme;
}
