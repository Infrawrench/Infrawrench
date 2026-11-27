import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Languages } from "../Languages";

describe("Languages", () => {
  it("splits the bar by bytes, links each language to a search, and folds the smallest into Other", () => {
    const { container } = render(
      <Languages
        languages={[
          { name: "TypeScript", bytes: 7_000 },
          { name: "Rust", bytes: 2_995 },
          { name: "Shell", bytes: 5 },
        ]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("TypeScript70.0%");
    expect(text).toContain("Rust29.9%");
    expect(text).toContain("Other0.1%");
    expect(text).not.toContain("Shell");
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/explore?language=TypeScript", "/explore?language=Rust"]);
    const segments = container.querySelectorAll("[aria-hidden='true'] > span");
    expect([...segments].map((segment) => (segment as HTMLElement).style.width)).toEqual([
      "70%",
      "29.95%",
      "0.05%",
    ]);
  });

  it("shows nothing before languages are measured", () => {
    const { container } = render(<Languages languages={[]} />);
    expect(container.textContent).toBe("");
  });
});
