import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { showBidi, splitBidi } from "../../lib/bidi";
import { AppLink } from "../AppLink";
import { CodeLine, CodeView } from "../CodeView";
import { LabelDot, labelColor } from "../LabelChip";
import { Avatar } from "../people";

const push = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ history: { push, replace: vi.fn() } }),
  useLocation: () => "/",
}));

afterEach(() => {
  cleanup();
  push.mockClear();
});

describe("bidirectional controls are shown, not obeyed", () => {
  test("a file name that hides its extension", () => {
    expect(showBidi("invoice‮txt.exe")).toBe("invoice<U+202E>txt.exe");
    expect(showBidi("plain name.ts")).toBe("plain name.ts");
    // Marks that only place punctuation in right-to-left text are left alone.
    expect(showBidi("שלום‏!")).toBe("שלום‏!");
  });

  test("every override and isolate", () => {
    const controls = "‪‫‬‭‮⁦⁧⁨⁩";
    expect(showBidi(controls)).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(splitBidi(`a${controls}b`).filter((part) => part.control)).toHaveLength(9);
  });

  test("code with an override shows a marked escape in place of the character", () => {
    // The classic case: a comment that reads as if it closed before the code after it.
    const line = "if (isAdmin) { /* ‮ } ⁦if (isAdmin)⁩ ⁦ begin admins only */";
    const { container } = render(
      <pre>
        <CodeLine text={line} />
      </pre>,
    );
    expect(container.textContent).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(container.textContent).toContain("<U+202E>");
    expect(container.querySelectorAll("[title='Bidirectional control character']")).toHaveLength(4);
  });

  test("highlighted tokens are marked too, and stay text", () => {
    const { container } = render(
      <pre>
        <CodeLine
          text="x"
          tokens={[
            {
              content: "</span><img src=x onerror=alert(1)>",
              light: "#000",
              dark: "#fff",
              italic: false,
            },
            { content: "‮end", light: undefined, dark: undefined, italic: false },
          ]}
        />
      </pre>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("</span><img src=x onerror=alert(1)><U+202E>end");
  });

  test("a file's lines are text nodes", () => {
    render(
      <CodeView
        text={"<script>alert(1)</script>\n</td><img src=x>"}
        language={null}
        label="file"
      />,
    );
    expect(document.querySelector("script, img")).toBeNull();
    expect(screen.getByRole("table", { name: "file" }).textContent).toContain("<script>");
  });
});

describe("AppLink", () => {
  test.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "//evil.example/",
    "/\\evil.example",
  ])("%j is not a link", (href) => {
    const { container } = render(<AppLink href={href}>details</AppLink>);
    const anchor = container.querySelector("a")!;
    expect(anchor.hasAttribute("href")).toBe(false);
    fireEvent.click(anchor);
    expect(push).not.toHaveBeenCalled();
  });

  test("a path on this site navigates in the router", () => {
    render(<AppLink href="/acme/infra">repo</AppLink>);
    fireEvent.click(screen.getByRole("link", { name: "repo" }));
    expect(push).toHaveBeenCalledWith("/acme/infra");
  });

  test("another site is a plain link with no opener and no referrer", () => {
    render(<AppLink href="https://ci.example/run/1">Details</AppLink>);
    const link = screen.getByRole("link", { name: "Details" });
    expect(link.getAttribute("href")).toBe("https://ci.example/run/1");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(link);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("pictures and colours from data", () => {
  test.each([
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/onload=alert(1)>",
    "ftp://example.com/a.png",
  ])("an avatar from %j falls back to initials", (src) => {
    const { container } = render(<Avatar name="Mara Lind" src={src} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("ML");
  });

  test("an avatar from another site loads through the image proxy, with no referrer", () => {
    const { container } = render(<Avatar name="Mara" src="https://avatars.example/m.png" />);
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/-/image?url=https%3A%2F%2Favatars.example%2Fm.png");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("a label colour is six hex digits or nothing", () => {
    expect(labelColor("d73a4a")).toBe("#d73a4a");
    for (const value of ["red", "fff", "d73a4a;position:fixed", "url(x)", "", "d73a4a\n"]) {
      expect(labelColor(value)).toBeNull();
    }
    const { container } = render(<LabelDot color="000;background:url(https://evil.example)" />);
    expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe("");
  });
});
