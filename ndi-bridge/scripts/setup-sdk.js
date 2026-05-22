#!/usr/bin/env node
/**
 * Link NDI SDK headers/libs for @vygr-labs/ndi-node node-gyp build.
 * Targets deps/ndi inside the ndi-node package (and a local mirror under ndi-bridge/deps/ndi).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SYSTEM_SDK = "/Library/NDI SDK for Apple";
const SYSTEM_INCLUDE = path.join(SYSTEM_SDK, "include");
const SYSTEM_LIB = path.join(SYSTEM_SDK, "lib", "macOS", "libndi.dylib");
const NDI_NODE_DEPS = path.join(ROOT, "node_modules", "@vygr-labs", "ndi-node", "deps", "ndi");
const LOCAL_DEPS = path.join(ROOT, "deps", "ndi");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function symlinkOrCopy(src, dest) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) {
    try {
      const st = fs.lstatSync(dest);
      if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(dest);
      else if (st.isDirectory()) return true;
    } catch (_) {
      /* ignore */
    }
  }
  try {
    fs.symlinkSync(src, dest);
    return true;
  } catch (_) {
    try {
      fs.copyFileSync(src, dest);
      return true;
    } catch (err) {
      console.warn(`[setup-sdk] Could not link ${src} -> ${dest}:`, err.message);
      return false;
    }
  }
}

function setupAt(depsRoot) {
  ensureDir(depsRoot);
  ensureDir(path.join(depsRoot, "lib"));

  const includeDest = path.join(depsRoot, "include");
  if (fs.existsSync(includeDest)) {
    try {
      const st = fs.lstatSync(includeDest);
      if (st.isSymbolicLink()) {
        const target = fs.realpathSync(includeDest);
        if (target === SYSTEM_INCLUDE) {
          /* already correct */
        } else {
          fs.unlinkSync(includeDest);
        }
      } else {
        fs.rmSync(includeDest, { recursive: true, force: true });
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!fs.existsSync(includeDest)) {
    try {
      fs.symlinkSync(SYSTEM_INCLUDE, includeDest);
    } catch (err) {
      console.warn("[setup-sdk] Could not link include dir:", err.message);
      return false;
    }
  }

  const libDest = path.join(depsRoot, "lib", "libndi.dylib");
  return symlinkOrCopy(SYSTEM_LIB, libDest);
}

function main() {
  if (process.platform !== "darwin") {
    console.log("[setup-sdk] Non-macOS: set deps/ndi manually per @vygr-labs/ndi-node README.");
    return;
  }
  if (!fs.existsSync(SYSTEM_SDK)) {
    console.warn(
      "[setup-sdk] NDI SDK not found at",
      SYSTEM_SDK,
      "— install from https://ndi.video/download-ndi-sdk/"
    );
    process.exitCode = 1;
    return;
  }

  const targets = [LOCAL_DEPS];
  if (fs.existsSync(path.join(ROOT, "node_modules", "@vygr-labs", "ndi-node"))) {
    targets.push(NDI_NODE_DEPS);
  }

  let ok = false;
  for (const t of targets) {
    if (setupAt(t)) {
      console.log("[setup-sdk] Linked SDK at", t);
      ok = true;
    }
  }
  if (!ok) {
    console.warn("[setup-sdk] libndi.dylib not linked — check", SYSTEM_LIB);
    process.exitCode = 1;
  }
}

main();
