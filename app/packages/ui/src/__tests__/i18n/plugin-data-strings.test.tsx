import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { msg, decodeOptions } from "gt-react";
import { useDataString } from "../../i18n/data-strings.js";

/**
 * Plugin-provided strings (display names, resource type labels…) reach the UI
 * as data, not literals, so they can't be statically extracted at the render
 * site. The pipeline instead relies on content hashing agreeing at both ends:
 * `gt translate` hashes the sources in ui/src/i18n/plugin-strings.gen.ts into
 * the catalogs, and a dynamic `gt(dataString)` render call re-derives the same
 * hash to look the translation up. (The translated path itself isn't unit
 * testable: the SPA singleton applies a locale only through a full page
 * reload, which jsdom can't do.)
 */

/** The content hash gt-react derives for a source string, via msg()'s encoding. */
function hashOf(source: string): string {
  const encoded = msg(source, {});
  const options = decodeOptions(encoded) as { $_hash?: string } | undefined;
  if (!options?.$_hash) throw new Error(`no hash encoded for ${source}`);
  return options.$_hash;
}

function Probe({ label }: { label: string }) {
  const gtData = useDataString();
  return <div>{gtData(label)}</div>;
}

describe("plugin data string translation", () => {
  it("keeps the runtime hash scheme aligned with CLI extraction", () => {
    // dc33c5008fcab30f is hashSource({ source: "S3 Bucket", dataFormat: "ICU" })
    // from generaltranslation/id — the hash the gt CLI writes into the
    // catalogs for a msg() source. If a gt upgrade changes either side's
    // scheme, every committed plugin-string translation silently stops
    // resolving; this pin turns that into a loud failure.
    expect(hashOf("S3 Bucket")).toBe("dc33c5008fcab30f");
  });

  it("falls back to the source string when the catalog has no entry", () => {
    render(<Probe label={"Drop" + "let"} />);
    expect(screen.getByText("Droplet")).toBeInTheDocument();
  });
});
