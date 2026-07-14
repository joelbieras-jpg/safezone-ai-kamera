#!/usr/bin/env node
/**
 * SafeZone - echter Syntax-Check fuer JS/JSX (Ersatz fuer `node --check`).
 *
 * WARUM: `node --check datei.js` ist fuer dieses Projekt WERTLOS. Sobald eine
 * Datei ein `import` enthaelt, erkennt Node sie als ES-Modul und liefert
 * Exit-Code 0 ZURUECK, OHNE den Inhalt zu parsen. Der klassische Build-Breaker
 * (deutsches oeffnendes Anfuehrungszeichen + ASCII-schliessendes INNERHALB eines
 * String-Literals, z.B. "Er sagte „Hallo" und ging") rutscht so glatt durch
 * und sprengt erst spaeter den Metro-Bundler:
 *     SyntaxError: Expecting Unicode escape sequence
 *
 * Dieses Skript laesst stattdessen den ECHTEN Parser laufen (@babel/parser,
 * derselbe, den Metro/Babel benutzt) - inkl. JSX-Plugin.
 *
 * Aufruf:  npm run check          (alle Quelldateien)
 *          node tools/check-quotes.mjs src/api.js   (einzelne Dateien)
 * Exit 0 = sauber, Exit 1 = Syntaxfehler (Push/Build stoppen!).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";

const ROOT = process.cwd();
const SKIP = new Set([
  "node_modules", "android", "ios", ".git", ".expo", ".expo-shared",
  "build", "dist", "coverage",
]);
const EXT = /\.(js|jsx|mjs|cjs)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const dateien = args.length
  ? args.filter((f) => existsSync(f))
  : walk(ROOT);

let fehler = 0;
for (const f of dateien) {
  const rel = relative(ROOT, f) || f;
  let code;
  try { code = readFileSync(f, "utf8"); } catch (e) {
    console.error("LESEFEHLER " + rel + ": " + e.message);
    fehler++;
    continue;
  }
  try {
    parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      plugins: ["jsx"],
    });
  } catch (err) {
    fehler++;
    const loc = err.loc ? err.loc.line + ":" + err.loc.column : "?";
    console.error("SYNTAXFEHLER  " + rel + ":" + loc + "  " + err.message);
    const zeile = err.loc && code.split("\n")[err.loc.line - 1];
    if (zeile) console.error("              > " + zeile.trim().slice(0, 120));
  }
}

if (fehler > 0) {
  console.error("\n[check] " + fehler + " Datei(en) mit Syntaxfehler - NICHT pushen, NICHT bauen!");
  process.exit(1);
}
console.log("[check] " + dateien.length + " Datei(en) geparst, keine Syntaxfehler.");
