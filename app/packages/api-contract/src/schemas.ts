// Not an entry of tsdown's (that is src/schemas/index.ts); it is here so a
// tsc declaration build (`tsc --emitDeclarationOnly`, as Infrawrench CI
// writes them) puts the `./schemas` export's types at dist/schemas.d.ts,
// where package.json points, as tsdown does.
export * from "./schemas/index.js";
