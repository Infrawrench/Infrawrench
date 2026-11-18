import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ChatStreamEvent } from "@infrawrench/plugin-base";
import { ChatPanel } from "../components/detail/ChatPanel.js";

async function* reply(text: string): AsyncIterable<ChatStreamEvent> {
  // Two deltas, so the turn renders while it is still streaming too.
  const half = Math.floor(text.length / 2);
  yield { kind: "delta", text: text.slice(0, half) };
  yield { kind: "delta", text: text.slice(half) };
  yield { kind: "done", message: { role: "assistant", content: text } };
}

function send(message: string) {
  fireEvent.change(screen.getByPlaceholderText("Send a message…"), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("model playground", () => {
  // Replies used to render as plain text, so `**bold**` kept its asterisks and
  // lists and code blocks were not formatted (#1351).
  it("renders an assistant reply as Markdown", async () => {
    render(
      <ChatPanel
        capability={{}}
        onStream={() => reply("Use **bold** here.\n\n- one\n- two\n\n```\nnpm test\n```")}
      />,
    );
    send("Format something");

    const bold = await screen.findByText("bold", {}, { timeout: 5000 });
    expect(bold.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*bold\*\*/)).toBeNull();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getByText("npm test").closest("pre")).not.toBeNull();
  });

  it("shows what the user typed as typed", async () => {
    render(<ChatPanel capability={{}} onStream={() => reply("ok")} />);
    send("keep **these** asterisks");

    expect(await screen.findByText("keep **these** asterisks")).toBeInTheDocument();
  });
});
