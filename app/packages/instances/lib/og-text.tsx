import { localeDir } from "./i18n/locales";

/**
 * Right-to-left text for the share cards. Satori shapes Hebrew and Arabic but
 * has no bidirectional layout: it loses spaces between words and scrambles
 * anything mixed with Latin. So the card lays the words out itself, each in its
 * own box in a reversed row, which is all the bidi these short strings need.
 */
const RTL_LETTERS = "\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF";
const HAS_RTL = new RegExp(`[${RTL_LETTERS}]`);
const SCRIPT_PIECES = new RegExp(`[${RTL_LETTERS}]+|[^${RTL_LETTERS}]+`, "g");
const NEUTRAL_EDGES = /^([/\-–,:;.!?()[\]"']*)(.*?)([/\-–,:;.!?()[\]"']*)$/;
const CONTROLS = /[‎‏؜‪-‮⁦-⁩]/g;
const MIRRORED: Readonly<Record<string, string>> = { "(": ")", ")": "(", "[": "]", "]": "[" };

const mirror = (neutrals: string) => [...neutrals].map((c) => MIRRORED[c] ?? c).join("");

const balanced = (word: string) => word.split("(").length === word.split(")").length;

/** A word's pieces in logical order, punctuation on a boundary split off and mirrored. */
function pieces(word: string): string[] {
  return (word.match(SCRIPT_PIECES) ?? []).flatMap((piece) => {
    if (HAS_RTL.test(piece)) return [piece];
    const [, before = "", core = "", after = ""] = NEUTRAL_EDGES.exec(piece) ?? [];
    return [mirror(before), core, mirror(after)].filter(Boolean);
  });
}

/**
 * The boxes of a right-to-left line, in logical order, each a word's pieces.
 * Neighbouring Latin words share a box so they keep their own order
 * ("m5.large (AWS)"), and one that ends a clause gives up its punctuation.
 */
export function rtlBoxes(text: string): string[][] {
  const boxes: string[][] = [];
  let latin = false;
  for (const word of text.replace(CONTROLS, "").split(/\s+/).filter(Boolean)) {
    if (HAS_RTL.test(word) || !balanced(word) || /[.,:;!?]$/.test(word)) {
      boxes.push(pieces(word));
      latin = false;
    } else if (latin) {
      const last = boxes.at(-1)!;
      last[0] = `${last[0]} ${word}`;
    } else {
      boxes.push([word]);
      latin = true;
    }
  }
  return boxes;
}

/**
 * `text` as a card draws it in `locale`: unchanged unless the locale reads right
 * to left. One line unless `wrap`: a row of boxes that may wrap shrinks to its
 * longest word, so a short label would break where plain text would not.
 */
export function cardText(
  locale: string,
  text: string,
  { wrap = false }: { wrap?: boolean } = {},
): React.ReactNode {
  if (localeDir(locale) !== "rtl" || !HAS_RTL.test(text)) return text;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row-reverse",
        flexWrap: wrap ? "wrap" : "nowrap",
        flexShrink: wrap ? 1 : 0,
        // Latin digits and Arabic letters come from different fonts, with different ascents.
        alignItems: "baseline",
        columnGap: "0.28em",
      }}
    >
      {rtlBoxes(text).map((box, i) => (
        <div
          key={i}
          style={{ display: "flex", flexDirection: "row-reverse", alignItems: "baseline" }}
        >
          {box.map((piece, j) => (
            <span key={j}>{piece}</span>
          ))}
        </div>
      ))}
    </div>
  );
}
