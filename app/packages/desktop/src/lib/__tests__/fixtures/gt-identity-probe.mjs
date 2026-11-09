// Renders one component six times under production React, jsdom and the
// real gt-react client build, and prints how many different `gt` functions
// `useGT()` returned. Run by gt-identity.test.ts as its own Node process,
// because vitest loads gt-react differently from a browser bundle.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "https://app.example/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", {
  value: dom.window.localStorage,
  configurable: true,
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const gtReact = await import("gt-react");
// As both apps do before rendering anything: no GTProvider.
await gtReact.initializeGTSPA({ defaultLocale: "en", locales: ["en", "fr"], locale: "en" });

const seen = new Set();
function Probe() {
  const gt = gtReact.useGT();
  seen.add(gt);
  const [renders, setRenders] = React.useState(0);
  React.useEffect(() => {
    if (renders < 5) setRenders(renders + 1);
  }, [renders]);
  return React.createElement("span", null, gt("Hello"));
}
createRoot(document.getElementById("root")).render(React.createElement(Probe));
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({ distinct: seen.size }));
process.exit(0);
