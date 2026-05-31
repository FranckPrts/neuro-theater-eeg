/**
 * OSC wiring for spider-graph.html — CSV defaults, live prefix discovery, /ws.
 */
(function () {
  const CSV_URL = "../p5-mapping/spider-graph-mapping.csv";
  const SCENE = "spider-graph.html";
  const STREAM_SUFFIX = "alpha";
  const BRANCH_COUNT = 7;
  const FALLBACK_PREFIXES = ["ENOB", "2262", "1D1A", "4F77", "9B30", "7AC1", "3E0F"];

  /** @type {Record<string, string>} branch_0 … → default OSC address */
  window.__ntBranchAddressByKey = Object.create(null);
  /** @type {Record<string, string>} branch_0 … → default device prefix */
  window.__ntBranchDefaultPrefix = Object.create(null);

  let networkPrefixes = [];
  /** @type {({ address: string, prefix: string }|null)[]} */
  let resolvedByBranch = new Array(BRANCH_COUNT).fill(null);

  function isDeviceStreamAddress(address) {
    if (typeof address !== "string" || !address.startsWith("/")) return false;
    const parts = address.split("/").filter(Boolean);
    return parts.length >= 2;
  }

  function parseOscAddressParts(address) {
    if (!isDeviceStreamAddress(address)) return null;
    const parts = String(address).split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { prefix: parts[0], suffix: parts.slice(1).join("/") };
  }

  function composeOscAddress(prefix, suffix) {
    const p = String(prefix || "").replace(/^\/+|\/+$/g, "");
    const s = String(suffix || "").replace(/^\/+|\/+$/g, "");
    if (!p || !s) return "";
    return `/${p}/${s}`;
  }

  function defaultPrefixForBranch(i) {
    const key = `branch_${i}`;
    const fromCsv = window.__ntBranchDefaultPrefix[key];
    if (fromCsv) return fromCsv;
    const addr = window.__ntBranchAddressByKey[key];
    const parsed = parseOscAddressParts(addr);
    return parsed ? parsed.prefix : "";
  }

  function defaultAddressForBranch(i) {
    const key = `branch_${i}`;
    const addr = window.__ntBranchAddressByKey[key];
    if (addr) return addr;
    const prefix = defaultPrefixForBranch(i);
    return prefix ? composeOscAddress(prefix, STREAM_SUFFIX) : "";
  }

  function refreshNetworkPrefixes() {
    const latest = window.NtOscWs?.latestByAddress;
    if (!latest) {
      networkPrefixes = [];
      return;
    }
    const set = new Set();
    for (const addr of Object.keys(latest)) {
      const parsed = parseOscAddressParts(addr);
      if (parsed && parsed.suffix === STREAM_SUFFIX) set.add(parsed.prefix);
    }
    networkPrefixes = [...set].sort();
  }

  function rebuildResolved() {
    refreshNetworkPrefixes();
    const latest = window.NtOscWs?.latestByAddress || Object.create(null);
    const used = new Set();
    const next = new Array(BRANCH_COUNT).fill(null);

    for (let i = 0; i < BRANCH_COUNT; i++) {
      const defPrefix = defaultPrefixForBranch(i);
      const defAddr = composeOscAddress(defPrefix, STREAM_SUFFIX);
      if (defPrefix && defAddr in latest && !used.has(defPrefix)) {
        next[i] = { address: defAddr, prefix: defPrefix };
        used.add(defPrefix);
      }
    }

    for (let i = 0; i < BRANCH_COUNT; i++) {
      if (next[i]) continue;
      const spare = networkPrefixes.find((p) => !used.has(p));
      if (spare) {
        const addr = composeOscAddress(spare, STREAM_SUFFIX);
        next[i] = { address: addr, prefix: spare };
        used.add(spare);
      } else {
        const defPrefix = defaultPrefixForBranch(i);
        const defAddr = defaultAddressForBranch(i);
        if (defAddr) next[i] = { address: defAddr, prefix: defPrefix };
      }
    }

    resolvedByBranch = next;
  }

  window.__ntSpiderResolveBranch = function (i) {
    if (i < 0 || i >= BRANCH_COUNT) return { address: "", prefix: "" };
    const r = resolvedByBranch[i];
    if (r) return r;
    const defPrefix = defaultPrefixForBranch(i);
    return {
      address: defaultAddressForBranch(i),
      prefix: defPrefix,
    };
  };

  function parseMappingCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return;
    const header = lines[0].split(",");
    const iScene = header.indexOf("scene");
    const iInput = header.indexOf("inputId");
    const iAddr = header.indexOf("address");
    const iType = header.indexOf("valueType");
    if (iScene < 0 || iInput < 0 || iAddr < 0) return;
    for (let li = 1; li < lines.length; li++) {
      const cols = lines[li].split(",");
      if (cols.length < 4) continue;
      if (cols[iScene] !== SCENE) continue;
      if (iType >= 0 && cols[iType] !== "osc") continue;
      const inputId = cols[iInput].trim();
      const address = cols[iAddr].trim();
      if (inputId && address) {
        window.__ntBranchAddressByKey[inputId] = address;
        const parsed = parseOscAddressParts(address);
        if (parsed) window.__ntBranchDefaultPrefix[inputId] = parsed.prefix;
      }
    }
    rebuildResolved();
  }

  function onOscMessage() {
    rebuildResolved();
  }

  for (let i = 0; i < BRANCH_COUNT; i++) {
    const key = `branch_${i}`;
    const prefix = FALLBACK_PREFIXES[i];
    if (prefix) {
      window.__ntBranchDefaultPrefix[key] = prefix;
      window.__ntBranchAddressByKey[key] = composeOscAddress(prefix, STREAM_SUFFIX);
    }
  }
  rebuildResolved();

  fetch(CSV_URL)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
    .then(parseMappingCsv)
    .catch((err) => console.warn("[spider-graph-osc] mapping CSV:", err));

  if (window.NtOscWs) {
    window.NtOscWs.connectOscWs(onOscMessage);
    rebuildResolved();
  }
})();
