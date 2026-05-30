/**
 * Copy three.module.js + examples/jsm from node_modules into public/vendor/three/.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const threeRoot = path.join(root, "node_modules", "three");
const outRoot = path.join(root, "public", "vendor", "three");

const copies = [
  {
    src: path.join(threeRoot, "build", "three.module.js"),
    dest: path.join(outRoot, "build", "three.module.js"),
  },
  {
    src: path.join(threeRoot, "examples", "jsm"),
    dest: path.join(outRoot, "examples", "jsm"),
    dir: true,
  },
];

if (!fs.existsSync(threeRoot)) {
  console.error("vendor-three: three not found in node_modules. Run: npm install");
  process.exit(1);
}

for (const item of copies) {
  if (!fs.existsSync(item.src)) {
    console.error("vendor-three: missing", path.relative(root, item.src));
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(item.dest), { recursive: true });
  if (item.dir) {
    fs.cpSync(item.src, item.dest, { recursive: true });
    console.log(
      "vendor-three: copied",
      path.relative(root, item.src) + "/",
      "->",
      path.relative(root, item.dest) + "/"
    );
  } else {
    fs.copyFileSync(item.src, item.dest);
    console.log(
      "vendor-three: copied",
      path.relative(root, item.src),
      "->",
      path.relative(root, item.dest)
    );
  }
}
