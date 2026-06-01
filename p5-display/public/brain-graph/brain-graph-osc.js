/**
 * OSC wiring for brain-graph.html — live LAN prefix discovery, /ws.
 * ENOB → Kantor; other 4-char prefixes → Visitors 1–6; FA## for missing slots.
 */
(function () {
  const CSV_URL = "../p5-mapping/brain-graph-mapping.csv";
  const SCENE = "brain-graph.html";
  const SLOT_COUNT = 7;
  const COSMONAUT_PREFIX = "ENOB";
  const VISITOR_COUNT = 6;
  const HARDWARE_ID_RE = /^[A-Za-z0-9]{4}$/;

  const BAND_SUFFIX_CANDIDATES = {
    delta: ["delta", "deltaNorm"],
    theta: ["theta", "thetaNorm"],
    alpha: ["alpha", "alphaNorm"],
    lowbeta: ["lowbeta", "lowbetaNorm"],
    lowBeta: ["lowbeta", "lowbetaNorm"],
    highbeta: ["highbeta", "highbetaNorm"],
    highBeta: ["highbeta", "highbetaNorm"],
  };

  /** @type {Record<string, string>} band key → CSV template suffix */
  window.__ntBandSuffixByKey = Object.create(null);
  /** @type {Record<string, string>} band key → full CSV address (legacy) */
  window.__ntBandAddressByKey = Object.create(null);

  /** @type {(string|null)[]} stable FA## per visitor slot (indices 0–5 → slots 1–6) */
  const simulatedPrefixesBySlot = new Array(VISITOR_COUNT).fill(null);

  /** @type {({ prefix: string, simulated: boolean, role: string }|null)[]} */
  let resolvedBySlot = new Array(SLOT_COUNT).fill(null);

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

  function discoverHardwarePrefixes(latest) {
    const set = new Set();
    for (const addr of Object.keys(latest || {})) {
      const parsed = parseOscAddressParts(addr);
      if (parsed && isHardwarePrefix(parsed.prefix)) set.add(parsed.prefix);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
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

  function slotRole(i) {
    return i === 0 ? "cosmonaut" : "visitor";
  }

  function pickBandSuffix(prefix, bandKey, latest) {
    const csvSuffix = window.__ntBandSuffixByKey[bandKey];
    const candidates = BAND_SUFFIX_CANDIDATES[bandKey] || (csvSuffix ? [csvSuffix] : []);
    const tryList = csvSuffix
      ? [...new Set([...candidates, csvSuffix])]
      : candidates;
    for (const suffix of tryList) {
      const address = composeOscAddress(prefix, suffix);
      if (address && address in latest) return suffix;
    }
    return tryList[0] || csvSuffix || String(bandKey).toLowerCase();
  }

  function rebuildResolved() {
    const latest = window.NtOscWs?.latestByAddress || Object.create(null);
    const discovered = discoverHardwarePrefixes(latest);
    const discoveredSet = new Set(discovered);
    const used = new Set(discovered);
    const next = new Array(SLOT_COUNT).fill(null);

    if (discoveredSet.has(COSMONAUT_PREFIX)) {
      next[0] = {
        prefix: COSMONAUT_PREFIX,
        simulated: false,
        role: "cosmonaut",
      };
    } else {
      next[0] = {
        prefix: COSMONAUT_PREFIX,
        simulated: true,
        role: "cosmonaut",
      };
    }

    const visitors = discovered.filter((p) => p !== COSMONAUT_PREFIX);

    for (let v = 0; v < VISITOR_COUNT; v++) {
      const slotIndex = v + 1;
      const prefix = visitors[v];
      if (prefix) {
        simulatedPrefixesBySlot[v] = null;
        next[slotIndex] = {
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
      next[slotIndex] = {
        prefix: simulatedPrefixesBySlot[v],
        simulated: true,
        role: "visitor",
      };
    }

    resolvedBySlot = next;
    window.__ntBrainRefreshPrefixLabels();
  }

  window.__ntBrainRefreshPrefixLabels = function () {
    const kantor = document.getElementById("btnKantor");
    if (kantor) {
      const r = window.__ntBrainResolveSlot(0);
      const code = r.prefix || "ENOB";
      kantor.textContent = code;
      kantor.classList.toggle("simulated", Boolean(r.simulated));
      kantor.title = r.simulated
        ? `KANTOR · ${code} (no LAN stream)`
        : `KANTOR · ${code}`;
    }
    document.querySelectorAll("#visitor-tog .vt-btn[data-v]").forEach((btn) => {
      const v = Number(btn.dataset.v);
      const r = window.__ntBrainResolveSlot(v);
      const code = r.prefix || "—";
      btn.textContent = code;
      btn.dataset.prefix = code;
      btn.classList.toggle("simulated", Boolean(r.simulated));
      btn.title = r.simulated
        ? `Visitor ${v} · ${code} (simulated)`
        : `Visitor ${v} · ${code}`;
    });
    if (typeof window.__ntBrainPaintVisitorButtons === "function") {
      window.__ntBrainPaintVisitorButtons();
    }
  };

  window.__ntBrainResolveSlot = function (i) {
    if (i < 0 || i >= SLOT_COUNT) {
      return { prefix: "", simulated: false, role: "visitor" };
    }
    const r = resolvedBySlot[i];
    if (r) return r;
    return {
      prefix: i === 0 ? COSMONAUT_PREFIX : "",
      simulated: true,
      role: slotRole(i),
    };
  };

  window.__ntBrainActiveSlot = function () {
    const museOn = document.getElementById("btnMuse")?.classList.contains("on");
    if (!museOn) return 0;
    const onBtn = document.querySelector("#visitor-tog .vt-btn.on");
    const v = onBtn ? Number(onBtn.dataset.v) : 1;
    if (!Number.isFinite(v) || v < 1 || v > VISITOR_COUNT) return 1;
    return v;
  };

  window.__ntBrainActivePrefix = function () {
    return window.__ntBrainResolveSlot(window.__ntBrainActiveSlot()).prefix;
  };

  window.__ntBrainBandAddress = function (bandKey) {
    const slot = window.__ntBrainActiveSlot();
    const { prefix, simulated } = window.__ntBrainResolveSlot(slot);
    if (!prefix || simulated) return "";
    const latest = window.NtOscWs?.latestByAddress || Object.create(null);
    const suffix = pickBandSuffix(prefix, bandKey, latest);
    return composeOscAddress(prefix, suffix);
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
      if (!inputId || !address) continue;
      window.__ntBandAddressByKey[inputId] = address;
      if (inputId === "highbeta") window.__ntBandAddressByKey.highBeta = address;
      if (inputId === "lowbeta") window.__ntBandAddressByKey.lowBeta = address;
      const parsed = parseOscAddressParts(address);
      if (parsed) {
        window.__ntBandSuffixByKey[inputId] = parsed.suffix;
        if (inputId === "highbeta") window.__ntBandSuffixByKey.highBeta = parsed.suffix;
        if (inputId === "lowbeta") window.__ntBandSuffixByKey.lowBeta = parsed.suffix;
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
    .catch((err) => console.warn("[brain-graph-osc] mapping CSV:", err));

  if (window.NtOscWs) {
    window.NtOscWs.connectOscWs(onOscMessage);
    rebuildResolved();
  }
})();

