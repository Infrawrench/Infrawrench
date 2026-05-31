import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorNotice } from "../../components/ErrorNotice.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorNotice", () => {
  it("renders each non-empty line as a paragraph", () => {
    render(<ErrorNotice message={"First line\n\nSecond line"} />);
    expect(screen.getByText("First line")).toBeInTheDocument();
    expect(screen.getByText("Second line")).toBeInTheDocument();
  });

  it("renders a button for an http link line", () => {
    render(<ErrorNotice message={"Something failed\nhttps://example.com/fix"} />);
    expect(screen.getByText("Something failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open example.com" })).toBeInTheDocument();
  });

  it("labels a Google Cloud console link specially", () => {
    render(
      <ErrorNotice message={"Enable the API\nhttps://console.cloud.google.com/apis/library"} />,
    );
    expect(screen.getByRole("button", { name: "Open Google Cloud Console" })).toBeInTheDocument();
  });

  it("calls onOpenLink when provided", () => {
    const onOpenLink = vi.fn();
    render(<ErrorNotice message={"https://example.com/x"} onOpenLink={onOpenLink} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/x");
  });

  it("falls back to window.open when no handler is given", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ErrorNotice message={"https://example.com/y"} />);
    fireEvent.click(screen.getByRole("button"));
    expect(openSpy).toHaveBeenCalledWith("https://example.com/y", "_blank", "noopener,noreferrer");
  });

  it("renders no link buttons when the message has none", () => {
    render(<ErrorNotice message={"plain error"} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("applies custom class names", () => {
    const { container } = render(
      <ErrorNotice message={"x"} className="outer" textClassName="inner" />,
    );
    expect(container.querySelector(".outer")).toBeTruthy();
    expect(container.querySelector(".inner")).toBeTruthy();
  });
});
