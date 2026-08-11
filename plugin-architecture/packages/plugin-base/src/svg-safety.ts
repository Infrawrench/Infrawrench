/**
 * Inertness rules for `PluginManifest.logoSvg`.
 *
 * Every host surface renders that string with `dangerouslySetInnerHTML` —
 * eighteen call sites across `@infrawrench/ui`, the web app and the desktop
 * app, all of them ultimately reading `plugin.manifest.logoSvg` off the loaded
 * registry. The manifest is therefore the trust boundary for that markup, and
 * this module is what makes the boundary an enforced one rather than an
 * assumed one: {@link pluginManifestSchema} refines `logoSvg` through
 * {@link isInertSvg}, so a logo that could execute anything is rejected by the
 * loader and the plugin never reaches a renderer at all.
 *
 * There is no `script-src` CSP in front of those call sites — see
 * `web/src/api/security-headers.ts` for why that is separate work — so this
 * check is the only line of defence they have. It is written accordingly.
 *
 * Why an element allowlist rather than a list of banned tags
 * ---------------------------------------------------------
 * Denylist sanitisers for HTML/SVG leak: namespace confusion, mXSS on
 * re-serialisation and the HTML parser's SVG integration points (`<desc>`,
 * `<title>` and `<foreignObject>` all switch the parser back into HTML, so
 * `<desc><img src=x onerror=...>` runs inside an otherwise ordinary `<svg>`)
 * have each defeated one in the past. A brand logo needs a vocabulary of about
 * ten elements, so the safe list is short enough to write out, and anything
 * outside it — including every construct that has ever been an SVG XSS vector —
 * is rejected by default. The failure mode is a build failure naming the
 * element, which is the right way to learn that a new logo wants `<circle>`.
 *
 * The rules, in order of what they stop:
 *
 *   - **Elements**: allowlisted, compared case-insensitively so `<SCRIPT>` and
 *     `<ScRiPt>` fall out with `<script>`. `foreignObject`, `iframe`, `image`,
 *     `style`, `animate` and friends are simply absent from the list.
 *   - **Event handlers**: any attribute whose name starts with `on`.
 *   - **URLs**: `href` / `xlink:href` must be a same-document fragment, which
 *     is what stops `<use>` pulling in an external document as well as
 *     `javascript:` and `data:`. Any `url(...)` in any attribute — `clip-path`,
 *     `fill`, `filter`, `style` — must likewise target a fragment. Attributes
 *     that only ever fetch (`src`, `srcset`, `poster`, `xlink:base`, …) are
 *     rejected outright, since no allowed element has a use for them.
 *   - **Scheme smuggling**: values are entity-decoded and stripped of control
 *     characters before the scheme check, so `&#106;avascript:` and
 *     `java&#9;script:` are seen for what they are.
 *   - **Document shape**: no DOCTYPE (entity expansion), no processing
 *     instruction (`<?xml-stylesheet?>`), no CDATA, no stray `<`, and tags must
 *     nest and close, because half-open markup is where re-serialisation bugs
 *     live.
 *
 * The module is dependency-free and side-effect-free by design: `plugin-base`
 * is the zero-runtime-dependency package, and this predicate runs in Node (the
 * server loader), in Electron (the desktop loader) and in tests.
 */

/**
 * Elements a plugin logo may contain. Deliberately narrow: everything here is
 * pure geometry, paint or accessible text, and none of it can fetch or execute.
 *
 * Compared lowercased, so the camelCase SVG names appear lowercased here.
 * `image` is absent because it fetches; `style` because a stylesheet can
 * `@import`; `foreignObject`, `script`, `handler`, `set` and the `animate*`
 * family because they are the known SVG script vectors.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  // Structure
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "switch",
  // Accessible text (parsed as HTML by the browser — the allowlist is what
  // keeps an <img onerror> out of them)
  "title",
  "desc",
  // Shapes
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  // Text
  "text",
  "tspan",
  // Paint servers and clipping
  "lineargradient",
  "radialgradient",
  "stop",
  "pattern",
  "clippath",
  "mask",
  "marker",
  // Filters
  "filter",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "feconvolvematrix",
  "fediffuselighting",
  "fedisplacementmap",
  "fedropshadow",
  "feflood",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "femorphology",
  "feoffset",
  "fespecularlighting",
  "fetile",
  "feturbulence",
]);

/**
 * Attributes that exist to fetch something. No allowed element needs one, and
 * every one of them has been an injection vector somewhere, so they are
 * rejected by name rather than by scheme.
 */
const FETCHING_ATTRIBUTES: ReadonlySet<string> = new Set([
  "src",
  "srcset",
  "data",
  "poster",
  "background",
  "action",
  "formaction",
  "ping",
  "xml:base",
  "xlink:base",
  "xlink:actuate",
  "xlink:show",
]);

/** Attributes whose value must be a same-document fragment reference. */
const FRAGMENT_ONLY_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "xlink:href"]);

/**
 * Schemes that can execute or inline a document. Matched after entity decoding
 * and control-character stripping, at a value boundary rather than anywhere, so
 * `xmlns="http://www.w3.org/2000/svg"` passes and `url(javascript:…)` does not.
 */
const DANGEROUS_SCHEME =
  /(?:^|[(,;'"])(?:javascript|vbscript|livescript|mocha|data|blob|filesystem|about|view-source):/;

/** CSS constructs that fetch or execute, for the `style` attribute. */
const DANGEROUS_CSS = /(?:expression\s*\(|@import|-moz-binding|behaviou?r\s*:)/i;

/** A tag, anchored at the start of the slice, with quoted values kept whole. */
const TAG = /^<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/;

/** One attribute of a tag's attribute chunk. */
const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  tab: "\t",
  newline: "\n",
  sol: "/",
  lpar: "(",
  rpar: ")",
};

/**
 * Resolve the entity forms a browser resolves in an attribute value, so a
 * scheme check sees `javascript:` in `&#106;avascript&colon;`.
 */
function decodeEntities(value: string): string {
  return value.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (whole: string, body: string) => {
      if (body.charAt(0) === "#") {
        const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
        const digits = hex ? body.slice(2) : body.slice(1);
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

/**
 * The form a URL check should run against: entities resolved, whitespace and
 * control characters removed (browsers ignore them inside a scheme), lowercased.
 */
function normalizeUrlish(value: string): string {
  return decodeEntities(value)
    .replace(/[\u0000-\u0020\u007f-\u00a0\u200b-\u200f\u2028\u2029\ufeff]/g, "")
    .toLowerCase();
}

/** Every `url(...)` target in a value, entity-decoded. */
function urlFunctionTargets(value: string): string[] {
  const decoded = decodeEntities(value);
  const targets: string[] = [];
  for (const match of decoded.matchAll(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)?/gi)) {
    targets.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
  }
  return targets;
}

function checkAttribute(element: string, rawName: string, rawValue: string, out: string[]): void {
  const name = rawName.toLowerCase();

  if (name.startsWith("on")) {
    out.push(`<${element}> carries the event handler attribute "${rawName}"`);
    return;
  }
  if (FETCHING_ATTRIBUTES.has(name)) {
    out.push(`<${element}> carries the fetching attribute "${rawName}"`);
    return;
  }

  const normalized = normalizeUrlish(rawValue);

  if (FRAGMENT_ONLY_ATTRIBUTES.has(name)) {
    if (!normalized.startsWith("#")) {
      out.push(
        `<${element}> has ${rawName}="${rawValue}"; only same-document fragment references (#id) are allowed`,
      );
      return;
    }
  } else if (DANGEROUS_SCHEME.test(normalized)) {
    out.push(`<${element}> has ${rawName}="${rawValue}", which carries an executable URL scheme`);
    return;
  }

  for (const target of urlFunctionTargets(rawValue)) {
    if (!target.startsWith("#")) {
      out.push(
        `<${element}> has ${rawName} referencing url(${target}); only same-document fragments (#id) are allowed`,
      );
      return;
    }
  }

  if (name === "style" && DANGEROUS_CSS.test(decodeEntities(rawValue))) {
    out.push(`<${element}> has a style attribute containing a fetching or executing CSS construct`);
  }
}

function checkTagAttributes(element: string, chunk: string, out: string[]): void {
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(chunk)) !== null) {
    if (match[0].trim() === "") {
      // Zero-width match: step forward so the scan terminates.
      ATTRIBUTE.lastIndex += 1;
      continue;
    }
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    checkAttribute(element, match[1] ?? "", value, out);
  }
}

/**
 * Describe everything about `svg` that would make it more than a picture.
 *
 * Returns an empty array for markup that is inert. Each entry is a sentence
 * naming the construct, written to be readable in a failing test or a loader
 * log line without further context.
 */
export function findUnsafeSvgConstructs(svg: string): string[] {
  const problems: string[] = [];
  const source = svg.trim();

  if (source === "") return ["the logo is empty"];
  if (!/^<svg[\s/>]/i.test(source)) {
    problems.push("the logo does not start with an <svg> element");
    return problems;
  }

  const stack: string[] = [];
  let index = 0;
  let sawRoot = false;

  while (index < source.length) {
    const lt = source.indexOf("<", index);
    if (lt === -1) break;
    const rest = source.slice(lt);

    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end === -1) {
        problems.push("the logo contains an unterminated comment");
        return problems;
      }
      index = lt + end + 3;
      continue;
    }
    if (rest.startsWith("<![")) {
      problems.push("the logo contains a CDATA or conditional section");
      return problems;
    }
    if (rest.startsWith("<!")) {
      problems.push("the logo contains a markup declaration (DOCTYPE or ENTITY)");
      return problems;
    }
    if (rest.startsWith("<?")) {
      problems.push("the logo contains a processing instruction");
      return problems;
    }

    const tag = TAG.exec(rest);
    if (!tag) {
      problems.push("the logo contains malformed markup (a `<` that does not open a tag)");
      return problems;
    }

    const closing = tag[1] === "/";
    const rawName = tag[2] ?? "";
    const name = rawName.toLowerCase();
    const chunk = tag[3] ?? "";
    const selfClosing = tag[4] === "/";

    if (!ALLOWED_ELEMENTS.has(name)) {
      problems.push(`<${rawName}> is not an element a logo may contain`);
    } else if (closing) {
      const open = stack.pop();
      if (open !== name) {
        problems.push(`</${rawName}> closes an element that is not open`);
        return problems;
      }
    } else {
      if (name === "svg") {
        if (sawRoot && stack.length === 0) {
          problems.push("the logo contains more than one root <svg> element");
          return problems;
        }
        sawRoot = true;
      } else if (stack.length === 0) {
        problems.push(`<${rawName}> appears outside the root <svg> element`);
        return problems;
      }
      checkTagAttributes(rawName, chunk, problems);
      if (!selfClosing) stack.push(name);
    }

    index = lt + tag[0].length;
  }

  if (stack.length > 0) {
    problems.push(`the logo leaves <${stack[stack.length - 1]}> unclosed`);
  }

  return problems;
}

/**
 * Whether `svg` is a logo the hosts may inject as-is.
 *
 * This is the predicate `pluginManifestSchema` refines `logoSvg` with, so a
 * `false` here means the plugin does not load. Use
 * {@link findUnsafeSvgConstructs} when you need to say why.
 */
export function isInertSvg(svg: string): boolean {
  return findUnsafeSvgConstructs(svg).length === 0;
}
