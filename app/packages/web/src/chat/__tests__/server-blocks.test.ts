import { describe, it, expect } from "vitest";
import { withoutServerToolBlocks } from "../server-blocks";

describe("withoutServerToolBlocks", () => {
  it("drops tool search blocks and keeps everything the UI renders", () => {
    const content = [
      { type: "text", text: "Looking." },
      { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: {} },
      { type: "tool_search_tool_result", tool_use_id: "srvtoolu_1", content: {} },
      { type: "tool_use", id: "toolu_1", name: "list_resources", input: {} },
      { type: "thinking", thinking: "", signature: "sig" },
    ];
    expect(withoutServerToolBlocks(content)).toEqual([content[0], content[3], content[4]]);
  });

  it("passes anything that is not an array through", () => {
    expect(withoutServerToolBlocks(null)).toBeNull();
    expect(withoutServerToolBlocks("x")).toBe("x");
  });
});
