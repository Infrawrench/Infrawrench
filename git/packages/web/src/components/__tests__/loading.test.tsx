import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Loading } from "../states";

describe("Loading", () => {
  it.each(["rows", "table", "file", "code", "text", "page"] as const)(
    "draws the %s outline in grey, announced once and with no spinner",
    (shape) => {
      const { container } = render(<Loading shape={shape} label="Loading files" />);
      expect(within(container).getByRole("status").textContent).toBe("Loading files");
      expect(container.querySelectorAll(".motion-safe\\:animate-pulse").length).toBeGreaterThan(2);
      expect(container.querySelector("svg")).toBeNull();
    },
  );

  it("draws no frame of its own inside a panel", () => {
    const framed = render(<Loading />).container.querySelector(".rounded-md.border");
    const bare = render(<Loading framed={false} />).container.querySelector(".rounded-md.border");
    expect(framed).not.toBeNull();
    expect(bare).toBeNull();
  });

  it("keeps the spinner for a small control", () => {
    const { container } = render(<Loading shape="inline" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
