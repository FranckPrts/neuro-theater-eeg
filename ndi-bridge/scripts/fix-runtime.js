#!/usr/bin/env node
/**
 * Fix macOS runtime loading for ndi_addon.node -> libndi.dylib.
 * Links with -lndi but ndi-node does not embed LC_RPATH; copy dylib beside the addon.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SYSTEM_LIB = "/Library/NDI SDK for Apple/lib/macOS/libndi.dylib";
const NDI_NODE = path.join(ROOT, "node_modules", "@vygr-labs", "ndi-node");
const ADDON = path.join(NDI_NODE, "build", "Release", "ndi_addon.node");
const DEPS_LIB = path.join(NDI_NODE, "deps", "ndi", "lib", "libndi.dylib");

function resolveLibndi() {
  if (fs.existsSync(DEPS_LIB)) return fs.realpathSync(DEPS_LIB);
  if (fs.existsSync(SYSTEM_LIB)) return SYSTEM_LIB;
  return null;
}

function main() {
  if (process.platform !== "darwin") return;
  if (!fs.existsSync(ADDON)) {
    console.warn("[fix-runtime] ndi_addon.node not built yet — run npm rebuild @vygr-labs/ndi-node");
    process.exitCode = 1;
    return;
  }

  const libSrc = resolveLibndi();
  if (!libSrc) {
    console.warn("[fix-runtime] libndi.dylib not found — run npm run setup-sdk");
    process.exitCode = 1;
    return;
  }

  const releaseDir = path.dirname(ADDON);
  const libDest = path.join(releaseDir, "libndi.dylib");
  fs.copyFileSync(libSrc, libDest);

  try {
    execFileSync("install_name_tool", ["-change", "@rpath/libndi.dylib", "@loader_path/libndi.dylib", ADDON], {
      stdio: "pipe",
    });
    console.log("[fix-runtime] Patched ndi_addon.node -> @loader_path/libndi.dylib");
  } catch (err) {
    const libDir = path.dirname(libSrc);
    try {
      execFileSync("install_name_tool", ["-add_rpath", libDir, ADDON], { stdio: "pipe" });
      console.log("[fix-runtime] Added rpath to", libDir);
    } catch (err2) {
      console.warn("[fix-runtime] install_name_tool failed:", err2.message || err2);
      process.exitCode = 1;
    }
  }

  console.log("[fix-runtime] Copied libndi.dylib to", libDest);
}

main();
