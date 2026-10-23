// Builds the GAIA Core map (an interactive one-page diagram)
// from gaia-map.src.html: inlines the GAIA logo as a data URI.
//   node docs/map/build.mjs  →  docs/map/dist/index.html
// Deploy: dist/index.html is a static page.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const here = (p) => new URL(p, import.meta.url);
const logo = readFileSync(here("../../stage/public/assets/gaia/gaia-logo.png")).toString("base64");
const html = readFileSync(here("gaia-map.src.html"), "utf8").replace("__LOGO__", `data:image/png;base64,${logo}`);
mkdirSync(here("dist/"), { recursive: true });
writeFileSync(
  here("dist/index.html"),
  html.trimStart().toLowerCase().startsWith("<!doctype")
    ? html
    : `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">\n${html}\n</html>`,
);
console.log("docs/map/dist/index.html");
