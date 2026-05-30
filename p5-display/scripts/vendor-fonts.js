/**
 * Copy @fontsource woff2 files for EEG Brain Graphic; emit local @font-face CSS.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "public", "vendor", "fonts");
const cssFile = path.join(outDir, "eeg-brain-graphic.css");

/** @type {{ pkg: string, family: string, weights: number[] }[]} */
const FONTS = [
  { pkg: "@fontsource/share-tech-mono", family: "Share Tech Mono", weights: [400] },
  { pkg: "@fontsource/orbitron", family: "Orbitron", weights: [400, 600, 700] },
  { pkg: "@fontsource/jetbrains-mono", family: "JetBrains Mono", weights: [300, 400, 500, 600] },
];

function findWoff2(filesDir, weight) {
  if (!fs.existsSync(filesDir)) return null;
  const names = fs.readdirSync(filesDir);
  const re = new RegExp(`-${weight}-normal\\.woff2$`);
  const matches = names.filter((n) => re.test(n));
  if (!matches.length) return null;
  const latin = matches.find((n) => n.includes("-latin-"));
  const chosen = latin || matches[0];
  return path.join(filesDir, chosen);
}

function copyFont(src, destName) {
  fs.copyFileSync(src, path.join(outDir, destName));
  return destName;
}

fs.mkdirSync(outDir, { recursive: true });

/** @type {string[]} */
const cssRules = [];

for (const font of FONTS) {
  const pkgRoot = path.join(root, "node_modules", font.pkg);
  const filesDir = path.join(pkgRoot, "files");
  if (!fs.existsSync(pkgRoot)) {
    console.error(`vendor-fonts: ${font.pkg} not found. Run: npm install`);
    process.exit(1);
  }

  for (const weight of font.weights) {
    const src = findWoff2(filesDir, weight);
    if (!src) {
      console.error(`vendor-fonts: weight ${weight} woff2 missing in ${font.pkg}/files`);
      process.exit(1);
    }
    const slug = font.family.toLowerCase().replace(/\s+/g, "-");
    const destName = `${slug}-${weight}.woff2`;
    copyFont(src, destName);
    cssRules.push(`@font-face {
  font-family: '${font.family}';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url('./${destName}') format('woff2');
}`);
    console.log("vendor-fonts: copied", path.relative(root, src), "->", path.relative(root, path.join(outDir, destName)));
  }
}

fs.writeFileSync(cssFile, cssRules.join("\n\n") + "\n", "utf8");
console.log("vendor-fonts: wrote", path.relative(root, cssFile));
