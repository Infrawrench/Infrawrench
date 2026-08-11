import { visit } from "unist-util-visit";

// Markdown tables (GFM) always render their header row as bare `<th>` with no
// `scope`, which leaves a screen reader guessing at the header/cell
// association on every table in the docs. Stamp the scope in at build time so
// authors don't have to drop into raw HTML to get a readable table.
//
// `thead` cells are column headers; a `th` inside `tbody` can only be a row
// header, which is what a leading `|` column in a GFM table produces.
export default function rehypeTableScope() {
  return (tree) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "thead" && node.tagName !== "tbody") return;
      const scope = node.tagName === "thead" ? "col" : "row";
      visit(node, "element", (cell) => {
        if (cell.tagName !== "th") return;
        cell.properties = { ...cell.properties, scope };
      });
    });
  };
}
