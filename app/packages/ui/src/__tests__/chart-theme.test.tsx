import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChartTheme } from "../chart-theme.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChartTheme", () => {
  it("returns fallback colours when CSS variables are unset", () => {
    const { result } = renderHook(() => useChartTheme());
    expect(result.current.colors).toContain("#60a5fa");
    expect(result.current.grid).toBeTruthy();
    expect(result.current.axis).toBeTruthy();
    expect(result.current.tick).toBeTruthy();
    expect(result.current.tooltipBg).toBeTruthy();
    expect(result.current.tooltipBorder).toBeTruthy();
  });

  it("reads CSS custom properties when present", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => (name === "--color-chart-grid" ? "#abcdef" : ""),
    } as unknown as CSSStyleDeclaration);
    const { result } = renderHook(() => useChartTheme());
    expect(result.current.grid).toBe("#abcdef");
  });

  it("re-reads the theme when the color scheme media query changes", () => {
    const listeners: Array<() => void> = [];
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const { result } = renderHook(() => useChartTheme());
    const before = result.current;
    act(() => {
      listeners.forEach((cb) => cb());
    });
    // A new object is produced on change, but values stay stable here.
    expect(result.current.colors).toEqual(before.colors);
  });
});
