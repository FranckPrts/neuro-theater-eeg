/**
 * Copy p5.min.js from node_modules into public/vendor/ after `npm install`.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const candidates = [
  path.join(root, "node_modules", "p5", "lib", "p5.min.js"),
  path.join(root, "node_modules", "p5", "dist", "p5.min.js"),
];

const outDir = path.join(root, "public", "vendor");
const outFile = path.join(outDir, "p5.min.js");

let src = null;
for (const p of candidates) {
  if (fs.existsSync(p)) {
    src = p;
    break;
  }
}

if (!src) {
  console.error("vendor-p5: p5 not found in node_modules. Run: npm install");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, outFile);
console.log("vendor-p5: copied", path.relative(root, src), "->", path.relative(root, outFile));
