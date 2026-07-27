import { describe, it, expect } from "vitest";
import { htmlToMarkdown, extractTitle, decodeEntities } from "../html-to-markdown";

const BASE = "https://docs.example.com/guide/intro";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#39;d&#39; &#x2014; e&nbsp;f")).toBe(
      "a & b <c> 'd' — e f",
    );
  });

  it("leaves unknown entities alone rather than mangling them", () => {
    expect(decodeEntities("&notareal; &#xZZZ;")).toBe("&notareal; &#xZZZ;");
  });

  it("ignores out-of-range code points", () => {
    expect(decodeEntities("&#1114112;")).toBe("&#1114112;");
  });
});

describe("extractTitle", () => {
  it("reads <title>", () => {
    expect(extractTitle("<html><head><title>  Hello &amp; welcome </title></head></html>")).toBe(
      "Hello & welcome",
    );
  });

  it("falls back to og:title in either attribute order", () => {
    expect(extractTitle(`<meta property="og:title" content="From OG">`)).toBe("From OG");
    expect(extractTitle(`<meta content="Reversed" property="og:title">`)).toBe("Reversed");
  });

  it("returns null when there is no title", () => {
    expect(extractTitle("<html><body>hi</body></html>")).toBeNull();
  });
});

describe("htmlToMarkdown", () => {
  it("drops scripts, styles and nav chrome but keeps prose", () => {
    const html = `
      <html><head><style>.a{color:red}</style></head>
      <body>
        <nav><a href="/x">Menu</a></nav>
        <script>alert('nope')</script>
        <p>Real content here.</p>
        <footer>Copyright</footer>
      </body></html>`;
    const out = htmlToMarkdown(html, BASE);
    expect(out).toBe("Real content here.");
  });

  it("drops an unterminated script instead of leaking its body", () => {
    const out = htmlToMarkdown("<p>Keep</p><script>var x = 1; leaked()", BASE);
    expect(out).toBe("Keep");
  });

  it("converts headings and resolves relative links", () => {
    const html = `<h2>Setup</h2><p>See <a href="../install">the installer</a> first.</p>`;
    expect(htmlToMarkdown(html, BASE)).toBe(
      "## Setup\n\nSee [the installer](https://docs.example.com/install) first.",
    );
  });

  it("keeps link text but drops non-http targets", () => {
    const html = `<p><a href="javascript:evil()">click</a> and <a href="#top">top</a></p>`;
    expect(htmlToMarkdown(html, BASE)).toBe("click and top");
  });

  it("fences pre blocks and preserves their whitespace", () => {
    const html = `<p>Run:</p><pre><code>npm  install\n  --save</code></pre>`;
    expect(htmlToMarkdown(html, BASE)).toBe("Run:\n\n```\nnpm  install\n  --save\n```");
  });

  it("does not treat page text that looks like the fence placeholder as one", () => {
    const out = htmlToMarkdown("<p>FENCE0 is a literal string</p>", BASE);
    expect(out).toBe("FENCE0 is a literal string");
  });

  it("renders inline code, lists and emphasis", () => {
    const html = `<ul><li>Set <code>FOO=1</code></li><li><strong>Restart</strong> it</li></ul>`;
    expect(htmlToMarkdown(html, BASE)).toBe("- Set `FOO=1`\n- **Restart** it");
  });

  it("collapses runaway whitespace and blank lines", () => {
    const html = "<p>one</p>\n\n\n<p>   two   </p>\n\n\n\n<p>three</p>";
    expect(htmlToMarkdown(html, BASE)).toBe("one\n\ntwo\n\nthree");
  });

  it("flattens table rows into pipe-separated cells", () => {
    const html = `<table><tr><td>Region</td><td>Price</td></tr><tr><td>us</td><td>$5</td></tr></table>`;
    expect(htmlToMarkdown(html, BASE)).toBe("Region | Price\n\nus | $5");
  });

  it("decodes entities in body text", () => {
    expect(htmlToMarkdown("<p>a &amp;&amp; b &gt; c</p>", BASE)).toBe("a && b > c");
  });
});
