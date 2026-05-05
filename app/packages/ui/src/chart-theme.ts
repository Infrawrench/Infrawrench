import { useState, useEffect } from "react";

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
    colors: ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c"],
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
