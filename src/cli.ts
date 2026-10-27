#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { transform } from "./transform";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const files = args.filter((a) => a !== "--dry");
if (!files.length) {
  console.error("usage: ff2async [--dry] <file>...");
  process.exit(2);
}

let converted = 0;
let skipped = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const out = transform(source, file);
  converted += out.converted;
  skipped += out.skipped.length;
  for (const s of out.skipped) console.log(`${file}:${s.line}: skipped: ${s.reason}`);
  if (out.converted) {
    console.log(`${file}: converted ${out.converted} chain(s)`);
    if (dry) console.log(out.text);
    else writeFileSync(file, out.text);
  }
}
console.log(`\n${converted} converted, ${skipped} skipped`);
