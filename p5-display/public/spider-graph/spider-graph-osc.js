/**
 * OSC wiring for spider-graph.html — live LAN prefix discovery, /ws.
 * ENOB → Cosmonaut; other 4-char prefixes → Visitors 1–6; FA## for missing slots.
 */
(function () {
  const CSV_URL = "../p5-mapping/spider-graph-mapping.csv";
  const SCENE = "spider-graph.html";
  const BRANCH_COUNT = 7;
  const COSMONAUT_PREFIX = "ENOB";
  const VISITOR_COUNT = 6;
  const ALPHA_SUFFIXES = ["alpha", "alphaNorm"];
  const HARDWARE_ID_RE = /^[A-Za-z0-9]{4}$/;

  /** @type {Record<string, string>} branch_0 … → CSV OSC address (documentation only) */
  window.__ntBranchAddressByKey = Object.create(null);
  /** @type {Record<string, string>} branch_0 … → CSV device prefix */
  window.__ntBranchDefaultPrefix = Object.create(null);

  /** @type {(string|null)[]} stable FA## per visitor branch slot (indices 0–5 → branches 1–6) */
  const simulatedPrefixesBySlot = new Array(VISITOR_COUNT).fill(null);

  /** @type {({ address: string, prefix: string, simulated: boolean, role: string }|null)[]} */
  let resolvedByBranch = new Array(BRANCH_COUNT).fill(null);

  function isDeviceStreamAddress(address) {
    if (typeof address !== "string" || !address.startsWith("/")) return false;
    if (address.startsWith("/nt/")) return false;
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

  function isHardwarePrefix(prefix) {
    return typeof prefix === "string" && HARDWARE_ID_RE.test(prefix);
  }

  /** Unique 4-char hardware IDs seen on the LAN (any stream suffix). */
  function discoverHardwarePrefixes(latest) {
    const set = new Set();
    for (const addr of Object.keys(latest || {})) {
      const parsed = parseOscAddressParts(addr);
      if (parsed && isHardwarePrefix(parsed.prefix)) set.add(parsed.prefix);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** Prefer /prefix/alpha, then /prefix/alphaNorm. */
  function pickAlphaAddress(prefix, latest) {
    for (const suffix of ALPHA_SUFFIXES) {
      const address = composeOscAddress(prefix, suffix);
      if (address && address in latest) return { address, suffix };
    }
    return { address: composeOscAddress(prefix, "alpha"), suffix: "alpha" };
  }

  function allocateFaPrefix(used) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const digits = String(Math.floor(Math.random() * 100)).padStart(2, "0");
      const prefix = `FA${digits}`;
      if (!used.has(prefix)) return prefix;
    }
    let n = 0;
    while (used.has(`FA${String(n).padStart(2, "0")}`)) n++;
    return `FA${String(n).padStart(2, "0")}`;
  }

  function branchRole(i) {
    return i === 0 ? "cosmonaut" : "visitor";
  }

  function liveBranch(prefix, latest) {
    const { address } = pickAlphaAddress(prefix, latest);
    return {
      address,
      prefix,
      simulated: false,
      role: branchRole(0),
    };
  }

  function rebuildResolved() {
    const latest = window.NtOscWs?.latestByAddress || Object.create(null);
    const discovered = discoverHardwarePrefixes(latest);
    const discoveredSet = new Set(discovered);
    const used = new Set(discovered);
    const next = new Array(BRANCH_COUNT).fill(null);

    // Branch 0 — Cosmonaut (ENOB)
    if (discoveredSet.has(COSMONAUT_PREFIX)) {
      const picked = pickAlphaAddress(COSMONAUT_PREFIX, latest);
      next[0] = {
        address: picked.address,
        prefix: COSMONAUT_PREFIX,
        simulated: false,
        role: "cosmonaut",
      };
    } else {
      next[0] = {
        address: "",
        prefix: COSMONAUT_PREFIX,
        simulated: true,
        role: "cosmonaut",
      };
    }

    const visitors = discovered.filter((p) => p !== COSMONAUT_PREFIX);

    for (let v = 0; v < VISITOR_COUNT; v++) {
      const branchIndex = v + 1;
      const prefix = visitors[v];
      if (prefix) {
        simulatedPrefixesBySlot[v] = null;
        const picked = pickAlphaAddress(prefix, latest);
        next[branchIndex] = {
          address: picked.address,
          prefix,
          simulated: false,
          role: "visitor",
        };
        continue;
      }

      if (!simulatedPrefixesBySlot[v]) {
        simulatedPrefixesBySlot[v] = allocateFaPrefix(used);
      }
      used.add(simulatedPrefixesBySlot[v]);
      next[branchIndex] = {
        address: "",
        prefix: simulatedPrefixesBySlot[v],
        simulated: true,
        role: "visitor",
      };
    }

    resolvedByBranch = next;
  }

  window.__ntSpiderResolveBranch = function (i) {
    if (i < 0 || i >= BRANCH_COUNT) {
      return { address: "", prefix: "", simulated: false, role: "visitor" };
    }
    const r = resolvedByBranch[i];
    if (r) return r;
    return {
      address: "",
      prefix: i === 0 ? COSMONAUT_PREFIX : "",
      simulated: true,
      role: branchRole(i),
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
