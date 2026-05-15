/* global p5 */
/**
 * Host page: WebSocket OSC, dual stream grids, panel modes (Streams / Scene),
 * mapping UI, iframe scene runner + placeholder p5 canvas when no scene.
 */

const LS_PANEL_MODE = "nt.p5osc.panelMode";
const LS_ACTIVE_SCENE = "nt.p5osc.activeScene";
const LS_MAPPINGS = "nt.p5osc.mappings";
const LS_SPIDER_HEX = "nt.p5osc.spiderHex";
const LS_SPIDER_DRAW = "nt.p5osc.spiderDrawOverlays";
const LS_SPIDER_RADIUS = "nt.p5osc.spiderRadius";
const LS_OSC_PORT = "nt.p5osc.oscPort";

const OSC_PORT_PRESETS = [7999, 8000, 8001, 8888];
const LS_SPIDER_DATA_LINES = "nt.p5osc.spiderDataLines";

/** Full-address snapshot */
const latestByAddress = {};
const seenStreamAddresses = new Set();

let ws;
let gridRoot;
let gridSceneRoot;
let statusEl;
let oscBindEl;
let toggleBtn;
let peekBtn;
let bannerAside;
let modeStreamsBtn;
let modeSceneBtn;
let streamsModePanel;
let sceneModePanel;
let sceneButtonsEl;
let mappingRowsEl;
let sceneFrameEl;
let placeholderMountEl;

let mappingCsvSelectEl;
let mappingCsvLoadBtn;
let mappingCsvSaveBtn;
let mappingCsvFilenameEl;
let mappingCsvStatusEl;

let oscPortPresetsEl;
let oscPortCustomEl;
let oscPortApplyBtn;
let oscPortStatusEl;
/** @type {number} */
let oscTargetPort = OSC_PORT_PRESETS[0];

let sceneList = [];
/** @type {string} */
let activeSceneFile = "";
let hostP5Instance = null;

const rowCacheMain = new Map();
const rowCacheScene = new Map();

function wsUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function isDeviceStreamOsc(msg) {
  if (!msg.address || msg.address[0] !== "/") return false;
  if (msg.address.startsWith("/nt/")) return false;
  return Boolean(msg.hardware && msg.stream);
}

function isDeviceStreamAddress(address) {
  if (!address || address[0] !== "/" || address.startsWith("/nt/")) return false;
  const parts = address.split("/").filter(Boolean);
  return parts.length >= 2;
}

function formatArg(a) {
  if (a === null || a === undefined) return "—";
  if (typeof a === "number") {
    if (!Number.isFinite(a)) return String(a);
    if (Number.isInteger(a)) return String(a);
    const t = Number(a.toFixed(5));
    return Object.is(t, -0) ? "0" : String(t);
  }
  return String(a);
}

function formatArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return "—";
  return args.map(formatArg).join(", ");
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function isValidOscUdpPort(n) {
  return Number.isFinite(n) && n >= 1 && n <= 65535;
}

function readSavedOscPortPreference() {
  try {
    const raw = localStorage.getItem(LS_OSC_PORT);
    if (raw == null || raw === "") return null;
    const n = parseInt(String(raw), 10);
    return isValidOscUdpPort(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function writeSavedOscPortPreference(n) {
  try {
    localStorage.setItem(LS_OSC_PORT, String(n));
  } catch (_) {
    /* ignore */
  }
}

function setOscPortStatus(text, isError) {
  if (!oscPortStatusEl) return;
  oscPortStatusEl.textContent = text || "";
  oscPortStatusEl.classList.toggle("is-error", Boolean(isError));
}

function syncOscPresetButtons() {
  if (!oscPortPresetsEl) return;
  const customEmpty = !oscPortCustomEl || String(oscPortCustomEl.value).trim() === "";
  for (const b of oscPortPresetsEl.querySelectorAll(".osc-port-bar__preset")) {
    const p = parseInt(b.dataset.port || "", 10);
    b.classList.toggle("is-active", customEmpty && isValidOscUdpPort(p) && p === oscTargetPort);
  }
}

function getPortToApply() {
  const custom = oscPortCustomEl && String(oscPortCustomEl.value).trim();
  if (custom !== "") {
    const n = parseInt(custom, 10);
    return isValidOscUdpPort(n) ? n : NaN;
  }
  return oscTargetPort;
}

async function applyOscPortFromUi() {
  const n = getPortToApply();
  if (!isValidOscUdpPort(n)) {
    setOscPortStatus("Enter a valid port (1–65535).", true);
    return;
  }
  setOscPortStatus("Applying…", false);
  if (oscPortApplyBtn) oscPortApplyBtn.disabled = true;
  try {
    const r = await fetch("/api/osc-port", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ port: n }),
    });
    let j = {};
    try {
      j = await r.json();
    } catch (_) {
      j = {};
    }
    if (!r.ok || !j.ok) {
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    writeSavedOscPortPreference(n);
    oscTargetPort = n;
    if (OSC_PORT_PRESETS.includes(n) && oscPortCustomEl) {
      oscPortCustomEl.value = "";
    } else if (oscPortCustomEl) {
      oscPortCustomEl.value = String(n);
    }
    syncOscPresetButtons();
    await refreshOscBindLine();
    setOscPortStatus(`UDP :${j.oscPort}`, false);
  } catch (e) {
    setOscPortStatus(String(e && e.message ? e.message : e), true);
    await refreshOscBindLine();
  } finally {
    if (oscPortApplyBtn) oscPortApplyBtn.disabled = false;
  }
}

function initOscPortBarFromHealth(health) {
  if (readSavedOscPortPreference() != null) {
    syncOscPresetButtons();
    return;
  }
  const serverPort =
    health && typeof health.oscPort === "number" && isValidOscUdpPort(health.oscPort)
      ? health.oscPort
      : null;
  if (serverPort != null) {
    oscTargetPort = serverPort;
    if (OSC_PORT_PRESETS.includes(serverPort)) {
      if (oscPortCustomEl) oscPortCustomEl.value = "";
    } else if (oscPortCustomEl) {
      oscPortCustomEl.value = String(serverPort);
    }
  }
  syncOscPresetButtons();
}

function setupOscPortBar() {
  oscPortPresetsEl = document.getElementById("oscPortPresets");
  oscPortCustomEl = document.getElementById("oscPortCustom");
  oscPortApplyBtn = document.getElementById("oscPortApply");
  oscPortStatusEl = document.getElementById("oscPortStatus");
  if (!oscPortPresetsEl || !oscPortApplyBtn) return;

  const saved = readSavedOscPortPreference();
  if (saved != null) {
    oscTargetPort = saved;
    if (oscPortCustomEl) {
      oscPortCustomEl.value = OSC_PORT_PRESETS.includes(saved) ? "" : String(saved);
    }
  } else {
    oscTargetPort = OSC_PORT_PRESETS[0];
    if (oscPortCustomEl) oscPortCustomEl.value = "";
  }

  oscPortPresetsEl.textContent = "";
  for (const port of OSC_PORT_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "osc-port-bar__preset";
    b.textContent = String(port);
    b.dataset.port = String(port);
    b.addEventListener("click", () => {
      oscTargetPort = port;
      if (oscPortCustomEl) oscPortCustomEl.value = "";
      syncOscPresetButtons();
    });
    oscPortPresetsEl.appendChild(b);
  }

  if (oscPortCustomEl) {
    oscPortCustomEl.addEventListener("input", () => {
      syncOscPresetButtons();
    });
  }

  oscPortApplyBtn.addEventListener("click", () => {
    applyOscPortFromUi();
  });

  syncOscPresetButtons();
}

async function refreshOscBindLine() {
  if (!oscBindEl) return null;
  try {
    const r = await fetch("/health");
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    if (d.oscHost != null && d.oscPort != null) {
      oscBindEl.textContent = `Listening UDP ${d.oscHost}:${d.oscPort}`;
    } else if (d.oscPort != null) {
      oscBindEl.textContent = `Listening UDP port ${d.oscPort}`;
    } else {
      oscBindEl.textContent = "Listening port: —";
    }
    return d;
  } catch (_) {
    oscBindEl.textContent = "Listening port: —";
    return null;
  }
}

function selAttr(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function rowCacheKey(hw, stream) {
  return `${hw}\0${stream}`;
}

function insertSorted(parent, el, keyOf) {
  const k = keyOf(el);
  for (const child of parent.children) {
    if (keyOf(child) > k) {
      parent.insertBefore(el, child);
      return;
    }
  }
  parent.appendChild(el);
}

function ensureDeviceSection(gridRoot, hw) {
  let sec = gridRoot.querySelector(`section.device[data-hw="${selAttr(hw)}"]`);
  if (sec) return sec;

  sec = document.createElement("section");
  sec.className = "device";
  sec.dataset.hw = hw;

  const head = document.createElement("div");
  head.className = "device__header";
  head.textContent = hw;

  const rows = document.createElement("div");
  rows.className = "device__rows";

  sec.appendChild(head);
  sec.appendChild(rows);

  insertSorted(gridRoot, sec, (n) => n.dataset.hw || "");
  return sec;
}

function ensureStreamRow(gridRoot, rowCache, hw, stream) {
  const key = rowCacheKey(hw, stream);
  let row = rowCache.get(key);
  if (row && row.isConnected) return row;

  const sec = ensureDeviceSection(gridRoot, hw);
  const rowsEl = sec.querySelector(".device__rows");

  row = rowsEl.querySelector(`.stream-row[data-stream="${selAttr(stream)}"]`);
  if (!row) {
    row = document.createElement("div");
    row.className = "stream-row";
    row.dataset.stream = stream;

    const name = document.createElement("span");
    name.className = "stream-row__name";
    name.textContent = stream;

    const val = document.createElement("span");
    val.className = "stream-row__value";
    val.textContent = "—";

    row.appendChild(name);
    row.appendChild(val);

    insertSorted(rowsEl, row, (n) => n.dataset.stream || "");
  }
  rowCache.set(key, row);
  return row;
}

function updateDeviceStreamForGrid(gridRoot, rowCache, msg) {
  if (!gridRoot || !isDeviceStreamOsc(msg)) return;
  const { hardware: hw, stream, args } = msg;
  const row = ensureStreamRow(gridRoot, rowCache, hw, stream);
  const valEl = row.querySelector(".stream-row__value");
  if (valEl) valEl.textContent = formatArgs(args);
}

function readMappings() {
  try {
    const raw = localStorage.getItem(LS_MAPPINGS);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return typeof o === "object" && o !== null ? o : {};
  } catch (_) {
    return {};
  }
}

function writeMappings(all) {
  try {
    localStorage.setItem(LS_MAPPINGS, JSON.stringify(all));
  } catch (_) {
    /* ignore quota */
  }
}

function readSpiderHex() {
  try {
    const raw = localStorage.getItem(LS_SPIDER_HEX);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return typeof o === "object" && o !== null ? o : {};
  } catch (_) {
    return {};
  }
}

function writeSpiderHexForScene(sceneFile, plotIndex, hex) {
  try {
    const all = readSpiderHex();
    const per = { ...(all[sceneFile] || {}) };
    if (hex && String(hex).trim()) per[String(plotIndex)] = String(hex).trim();
    else delete per[String(plotIndex)];
    all[sceneFile] = per;
    localStorage.setItem(LS_SPIDER_HEX, JSON.stringify(all));
  } catch (_) {
    /* ignore */
  }
}

function getSpiderPlotCount(scene) {
  if (!scene || !scene.spiderPlot) return 0;
  const n = scene.spiderPlot.plotCount;
  return typeof n === "number" && n > 0 ? Math.floor(n) : 0;
}

function readSpiderDrawCount(sceneFile, railMax) {
  try {
    const raw = localStorage.getItem(LS_SPIDER_DRAW);
    const o = raw ? JSON.parse(raw) : {};
    const v = o[sceneFile];
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n) || n < 1) return railMax;
    return Math.min(railMax, Math.floor(n));
  } catch (_) {
    return railMax;
  }
}

function writeSpiderDrawCount(sceneFile, n) {
  try {
    const raw = localStorage.getItem(LS_SPIDER_DRAW);
    let o = {};
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) o = parsed;
    }
    o[sceneFile] = n;
    localStorage.setItem(LS_SPIDER_DRAW, JSON.stringify(o));
  } catch (_) {
    /* ignore */
  }
}

/** Shared spider radius mode + absolute scale (per scene file). */
function readSpiderRadiusAll(sceneFile) {
  const fallback = { mode: "relative", mean: 0, max: 1 };
  try {
    const raw = localStorage.getItem(LS_SPIDER_RADIUS);
    const o = raw ? JSON.parse(raw) : {};
    if (typeof o !== "object" || o === null) return fallback;
    const per = o[sceneFile];
    if (!per || typeof per !== "object") return fallback;
    const mode = String(per.mode || "").toLowerCase() === "absolute" ? "absolute" : "relative";
    let mean = per.mean;
    mean = typeof mean === "number" && Number.isFinite(mean) ? mean : parseFloat(String(mean));
    mean = Number.isFinite(mean) ? mean : 0;
    let max = per.max;
    max = typeof max === "number" && Number.isFinite(max) ? max : parseFloat(String(max));
    max = Number.isFinite(max) && max > 0 ? max : 1;
    return { mode, mean, max };
  } catch (_) {
    return fallback;
  }
}

function writeSpiderRadiusAll(sceneFile, patch) {
  try {
    const cur = readSpiderRadiusAll(sceneFile);
    const next = { ...cur, ...patch };
    next.mode = String(next.mode || "").toLowerCase() === "absolute" ? "absolute" : "relative";
    next.mean = typeof next.mean === "number" && Number.isFinite(next.mean) ? next.mean : 0;
    next.max =
      typeof next.max === "number" && Number.isFinite(next.max) && next.max > 0 ? next.max : 1;
    const raw = localStorage.getItem(LS_SPIDER_RADIUS);
    let o = {};
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) o = parsed;
    }
    o[sceneFile] = next;
    localStorage.setItem(LS_SPIDER_RADIUS, JSON.stringify(o));
  } catch (_) {
    /* ignore */
  }
}

function sortedStreamAddresses() {
  return Object.keys(latestByAddress)
    .filter(isDeviceStreamAddress)
    .sort();
}

function coerceFirstNumeric(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function buildSceneData() {
  const scene = sceneList.find((s) => s.file === activeSceneFile);
  if (!scene) return {};

  const spiderN = getSpiderPlotCount(scene);
  if (spiderN > 0) {
    const allMaps = readMappings();
    const maps = allMaps[activeSceneFile] || {};
    const out = {};
    const railN = spiderN;
    const drawN = Math.max(1, Math.min(railN, readSpiderDrawCount(activeSceneFile, railN)));
    out.__plotCount = drawN;
    const rad = readSpiderRadiusAll(activeSceneFile);
    out.__radiusMode = rad.mode;
    out.__absoluteMean = rad.mean;
    out.__absoluteMax = rad.max;
    for (let p = 0; p < railN; p++) {
      for (let a = 0; a < 5; a++) {
        const id = `plot_${p}_axis_${a}`;
        const addr = maps[id];
        if (!addr) continue;
        const rec = latestByAddress[addr];
        if (!rec || !Array.isArray(rec.args) || !rec.args.length) continue;
        const n = coerceFirstNumeric(rec.args[0]);
        if (n !== null) out[id] = n;
      }
    }
    const hexPer = readSpiderHex()[activeSceneFile] || {};
    for (let p = 0; p < railN; p++) {
      const c = hexPer[String(p)];
      if (c) out[`plot_${p}_color`] = c;
    }
    return out;
  }

  if (!Array.isArray(scene.inputs) || !scene.inputs.length) return {};
  const allMaps = readMappings();
  const maps = allMaps[activeSceneFile] || {};
  const out = {};
  for (const inp of scene.inputs) {
    const addr = maps[inp.id];
    if (!addr) continue;
    const rec = latestByAddress[addr];
    if (!rec || !Array.isArray(rec.args) || !rec.args.length) continue;
    const n = coerceFirstNumeric(rec.args[0]);
    if (n !== null) out[inp.id] = n;
  }
  return out;
}

function addAddressOptionToMappingSelects(addr) {
  if (!isDeviceStreamAddress(addr) || seenStreamAddresses.has(addr)) return;
  seenStreamAddresses.add(addr);
  const selects = mappingRowsEl ? mappingRowsEl.querySelectorAll("select.mapping-osc:not(.mapping-osc--control)") : [];
  for (const sel of selects) {
    let exists = false;
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === addr) {
        exists = true;
        break;
      }
    }
    if (exists) continue;
    const opt = document.createElement("option");
    opt.value = addr;
    opt.textContent = addr;
    let inserted = false;
    for (let i = 0; i < sel.options.length; i++) {
      const o = sel.options[i];
      if (o.value && o.value !== "" && o.value > addr) {
        sel.insertBefore(opt, o);
        inserted = true;
        break;
      }
    }
    if (!inserted) sel.appendChild(opt);
  }
}

function syncSeenAddressesFromSelects() {
  const selects = mappingRowsEl ? mappingRowsEl.querySelectorAll("select.mapping-osc:not(.mapping-osc--control)") : [];
  for (const sel of selects) {
    for (const opt of sel.querySelectorAll("option")) {
      if (opt.value && isDeviceStreamAddress(opt.value)) seenStreamAddresses.add(opt.value);
    }
  }
}

function csvEscapeCell(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let i = 0;
  let inQ = false;
  while (i < line.length) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  out.push(cur);
  return out;
}

function parseMappingCsvDataRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((h) => String(h).trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const iScene = idx("scene");
  const iId = idx("inputid");
  const iAddr = idx("address");
  if (iScene < 0 || iId < 0 || iAddr < 0) return [];
  const iLab = idx("label");
  const iType = idx("valuetype");
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = parseCsvLine(lines[li]);
    rows.push({
      scene: cells[iScene] != null ? String(cells[iScene]) : "",
      inputId: cells[iId] != null ? String(cells[iId]) : "",
      label: iLab >= 0 && cells[iLab] != null ? String(cells[iLab]) : "",
      address: cells[iAddr] != null ? String(cells[iAddr]) : "",
      valueType: iType >= 0 && cells[iType] != null ? String(cells[iType]).trim().toLowerCase() : "osc",
    });
  }
  return rows;
}

function getExpectedMappingFields(scene, sceneFile) {
  if (!scene || !sceneFile) return [];
  const spiderN = getSpiderPlotCount(scene);
  const out = [];
  if (spiderN > 0) {
    const axisNames = ["Δ", "θ", "α", "low β", "high β"];
    out.push({ inputId: "__plotCount", label: "Overlays to visualize", valueType: "control" });
    out.push({ inputId: "__radiusMode", label: "Radius mode", valueType: "control" });
    out.push({ inputId: "__absoluteMean", label: "Absolute · mean (center)", valueType: "control" });
    out.push({ inputId: "__absoluteMax", label: "Absolute · max deviation (outer)", valueType: "control" });
    for (let p = 0; p < spiderN; p++) {
      for (let a = 0; a < 5; a++) {
        const id = `plot_${p}_axis_${a}`;
        out.push({ inputId: id, label: `Plot ${p + 1} · ${axisNames[a]}`, valueType: "osc" });
      }
      out.push({ inputId: `plot_${p}_color`, label: `Plot ${p + 1} · color (HEX)`, valueType: "hex" });
    }
    return out;
  }
  for (const inp of scene.inputs || []) {
    out.push({ inputId: inp.id, label: inp.label || inp.id, valueType: "osc" });
  }
  return out;
}

function seedMappingSelectAddresses(addr) {
  if (!isDeviceStreamAddress(addr)) return;
  seenStreamAddresses.add(addr);
  const selects = mappingRowsEl ? mappingRowsEl.querySelectorAll("select.mapping-osc:not(.mapping-osc--control)") : [];
  for (const sel of selects) {
    let exists = false;
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === addr) {
        exists = true;
        break;
      }
    }
    if (exists) continue;
    const opt = document.createElement("option");
    opt.value = addr;
    opt.textContent = addr;
    let inserted = false;
    for (let i = 0; i < sel.options.length; i++) {
      const o = sel.options[i];
      if (o.value && o.value !== "" && o.value > addr) {
        sel.insertBefore(opt, o);
        inserted = true;
        break;
      }
    }
    if (!inserted) sel.appendChild(opt);
  }
}

function buildMappingCsvString() {
  const scene = sceneList.find((s) => s.file === activeSceneFile);
  const fields = getExpectedMappingFields(scene, activeSceneFile);
  if (!activeSceneFile || !fields.length) return "";

  const maps = readMappings()[activeSceneFile] || {};
  const hexAll = readSpiderHex()[activeSceneFile] || {};
  const spiderN = getSpiderPlotCount(scene);

  const lines = ["scene,inputId,label,address,valueType"];
  for (const f of fields) {
    let addr = "";
    if (f.valueType === "osc") {
      addr = maps[f.inputId] || "";
    } else if (f.valueType === "hex") {
      const m = /^plot_(\d+)_color$/.exec(f.inputId);
      addr = m && hexAll[String(m[1])] != null ? String(hexAll[String(m[1])]) : "";
    } else if (f.valueType === "control" && spiderN > 0) {
      const rad = readSpiderRadiusAll(activeSceneFile);
      if (f.inputId === "__plotCount") {
        addr = String(readSpiderDrawCount(activeSceneFile, spiderN));
      } else if (f.inputId === "__radiusMode") {
        addr = rad.mode;
      } else if (f.inputId === "__absoluteMean") {
        addr = String(rad.mean);
      } else if (f.inputId === "__absoluteMax") {
        addr = String(rad.max);
      }
    }
    lines.push(
      [activeSceneFile, f.inputId, f.label, addr, f.valueType].map(csvEscapeCell).join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

function applyMappingCsvText(csvText) {
  const scene = sceneList.find((s) => s.file === activeSceneFile);
  const expected = getExpectedMappingFields(scene, activeSceneFile);
  if (!activeSceneFile || !expected.length) return;

  const idSet = new Set(expected.map((e) => e.inputId));
  const typeById = new Map(expected.map((e) => [e.inputId, e.valueType]));
  const spiderN = scene ? getSpiderPlotCount(scene) : 0;

  const rows = parseMappingCsvDataRows(csvText);
  const byId = new Map();
  for (const row of rows) {
    if (String(row.scene).trim() !== activeSceneFile) continue;
    const id = String(row.inputId).trim();
    if (!idSet.has(id)) continue;
    byId.set(id, row);
  }

  const oscToSeed = new Set();
  const allMaps = readMappings();
  const sceneMap = { ...(allMaps[activeSceneFile] || {}) };

  for (const exp of expected) {
    const row = byId.get(exp.inputId);
    const vType = typeById.get(exp.inputId);

    if (!row) {
      if (vType === "osc") delete sceneMap[exp.inputId];
      else if (vType === "hex") {
        const m = /^plot_(\d+)_color$/.exec(exp.inputId);
        if (m) writeSpiderHexForScene(activeSceneFile, parseInt(m[1], 10), "");
      } else if (vType === "control" && spiderN > 0) {
        if (exp.inputId === "__plotCount") {
          writeSpiderDrawCount(activeSceneFile, spiderN);
        } else if (exp.inputId === "__radiusMode") {
          writeSpiderRadiusAll(activeSceneFile, { mode: "relative" });
        } else if (exp.inputId === "__absoluteMean") {
          writeSpiderRadiusAll(activeSceneFile, { mean: 0 });
        } else if (exp.inputId === "__absoluteMax") {
          writeSpiderRadiusAll(activeSceneFile, { max: 1 });
        }
      }
      continue;
    }

    const addr = String(row.address != null ? row.address : "").trim();

    if (vType === "osc") {
      if (addr && isDeviceStreamAddress(addr)) {
        sceneMap[exp.inputId] = addr;
        oscToSeed.add(addr);
      } else {
        delete sceneMap[exp.inputId];
      }
    } else if (vType === "hex") {
      const m = /^plot_(\d+)_color$/.exec(exp.inputId);
      if (m) writeSpiderHexForScene(activeSceneFile, parseInt(m[1], 10), addr);
    } else if (vType === "control" && spiderN > 0) {
      if (exp.inputId === "__plotCount") {
        const n = parseInt(addr, 10);
        if (Number.isFinite(n)) {
          writeSpiderDrawCount(activeSceneFile, Math.max(1, Math.min(spiderN, Math.floor(n))));
        } else {
          writeSpiderDrawCount(activeSceneFile, spiderN);
        }
      } else if (exp.inputId === "__radiusMode") {
        const m = String(addr).trim().toLowerCase() === "absolute" ? "absolute" : "relative";
        writeSpiderRadiusAll(activeSceneFile, { mode: m });
      } else if (exp.inputId === "__absoluteMean") {
        const n = parseFloat(addr);
        writeSpiderRadiusAll(activeSceneFile, { mean: Number.isFinite(n) ? n : 0 });
      } else if (exp.inputId === "__absoluteMax") {
        const n = parseFloat(addr);
        const mm = Number.isFinite(n) && n > 0 ? n : 1;
        writeSpiderRadiusAll(activeSceneFile, { max: mm });
      }
    }
  }

  allMaps[activeSceneFile] = sceneMap;
  writeMappings(allMaps);

  for (const a of oscToSeed) seedMappingSelectAddresses(a);

  buildMappingRows();
}

function setMappingCsvStatus(text, isError) {
  if (!mappingCsvStatusEl) return;
  mappingCsvStatusEl.textContent = text || "";
  mappingCsvStatusEl.classList.toggle("is-error", Boolean(isError));
}

function clientMappingBasenameForPost(raw) {
  let base = String(raw || "").trim();
  if (!base) base = "mapping";
  const slash = base.lastIndexOf("/");
  const bslash = base.lastIndexOf("\\");
  const cut = Math.max(slash, bslash);
  if (cut >= 0) base = base.slice(cut + 1);
  base = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (!base.toLowerCase().endsWith(".csv")) base += ".csv";
  return base;
}

async function refreshMappingFileList() {
  if (!mappingCsvSelectEl) return;
  const cur = mappingCsvSelectEl.value;
  mappingCsvSelectEl.textContent = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "— select file —";
  mappingCsvSelectEl.appendChild(def);
  try {
    const r = await fetch("/api/p5-mappings");
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const files = Array.isArray(j.files) ? j.files : [];
    for (const f of files) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f;
      mappingCsvSelectEl.appendChild(opt);
    }
    if (cur && files.includes(cur)) mappingCsvSelectEl.value = cur;
  } catch (_) {
    /* keep placeholder only */
  }
}

function updateMappingCsvBarState() {
  const scene = sceneList.find((s) => s.file === activeSceneFile);
  const fields = getExpectedMappingFields(scene, activeSceneFile);
  const ok = Boolean(activeSceneFile && fields.length);
  if (mappingCsvLoadBtn) mappingCsvLoadBtn.disabled = !ok;
  if (mappingCsvSaveBtn) mappingCsvSaveBtn.disabled = !ok;
  if (mappingCsvFilenameEl) mappingCsvFilenameEl.disabled = !ok;
  if (mappingCsvSelectEl) mappingCsvSelectEl.disabled = !ok;
}

function suggestMappingCsvBasename() {
  if (!mappingCsvFilenameEl) return;
  if (!activeSceneFile) {
    mappingCsvFilenameEl.value = "";
    return;
  }
  const base = activeSceneFile.replace(/\.p5$/i, "");
  mappingCsvFilenameEl.value = `${base}-mapping`;
}

function buildMappingRows() {
  if (!mappingRowsEl) return;
  mappingRowsEl.textContent = "";
  const scene = sceneList.find((s) => s.file === activeSceneFile);
  const spiderN = scene ? getSpiderPlotCount(scene) : 0;

  if (!activeSceneFile || !scene || (!scene.inputs.length && !spiderN)) {
    const p = document.createElement("p");
    p.className = "mapping-empty";
    p.textContent = activeSceneFile
      ? "No mappable inputs for this scene."
      : "Select a scene to map OSC addresses to parameters.";
    mappingRowsEl.appendChild(p);
    updateMappingCsvBarState();
    return;
  }

  const allMaps = readMappings();
  const maps = { ...allMaps[activeSceneFile] };
  const addrs = sortedStreamAddresses();

  if (spiderN > 0) {
    const axisNames = ["Δ", "θ", "α", "low β", "high β"];
    const hexStore = readSpiderHex()[activeSceneFile] || {};
    const drawSelVal = readSpiderDrawCount(activeSceneFile, spiderN);

    const ctrl = document.createElement("div");
    ctrl.className = "mapping-row mapping-row--control";

    const ctrlLab = document.createElement("label");
    ctrlLab.htmlFor = "spider-overlay-draw-count";
    ctrlLab.textContent = "Overlays to visualize";

    const ctrlSel = document.createElement("select");
    ctrlSel.id = "spider-overlay-draw-count";
    ctrlSel.className = "mapping-osc mapping-osc--control";
    for (let k = 1; k <= spiderN; k++) {
      const opt = document.createElement("option");
      opt.value = String(k);
      opt.textContent = String(k);
      if (k === drawSelVal) opt.selected = true;
      ctrlSel.appendChild(opt);
    }
    ctrlSel.addEventListener("change", () => {
      const v = parseInt(ctrlSel.value, 10);
      writeSpiderDrawCount(activeSceneFile, Number.isFinite(v) ? v : spiderN);
    });

    ctrl.appendChild(ctrlLab);
    ctrl.appendChild(ctrlSel);
    mappingRowsEl.appendChild(ctrl);

    const radCfg = readSpiderRadiusAll(activeSceneFile);

    const modeRow = document.createElement("div");
    modeRow.className = "mapping-row mapping-row--control";
    const modeLab = document.createElement("label");
    modeLab.htmlFor = "spider-radius-mode";
    modeLab.textContent = "Radius mode";
    const modeSel = document.createElement("select");
    modeSel.id = "spider-radius-mode";
    modeSel.className = "mapping-osc mapping-osc--control";
    for (const [val, lab] of [
      ["relative", "Relative (share of total)"],
      ["absolute", "Absolute (vs mean / max)"],
    ]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = lab;
      if (val === radCfg.mode) opt.selected = true;
      modeSel.appendChild(opt);
    }
    modeSel.addEventListener("change", () => {
      const m = modeSel.value === "absolute" ? "absolute" : "relative";
      writeSpiderRadiusAll(activeSceneFile, { mode: m });
      syncSpiderAbsoluteInputsDisabled();
    });
    modeRow.appendChild(modeLab);
    modeRow.appendChild(modeSel);
    mappingRowsEl.appendChild(modeRow);

    const meanRow = document.createElement("div");
    meanRow.className = "mapping-row mapping-row--control";
    const meanLab = document.createElement("label");
    meanLab.htmlFor = "spider-absolute-mean";
    meanLab.textContent = "Absolute · mean (center)";
    const meanInp = document.createElement("input");
    meanInp.type = "number";
    meanInp.id = "spider-absolute-mean";
    meanInp.className = "spider-radius-num";
    meanInp.step = "any";
    meanInp.value = String(radCfg.mean);
    meanInp.addEventListener("change", () => {
      const n = parseFloat(meanInp.value);
      writeSpiderRadiusAll(activeSceneFile, { mean: Number.isFinite(n) ? n : 0 });
      meanInp.value = String(readSpiderRadiusAll(activeSceneFile).mean);
    });
    meanRow.appendChild(meanLab);
    meanRow.appendChild(meanInp);
    mappingRowsEl.appendChild(meanRow);

    const maxRow = document.createElement("div");
    maxRow.className = "mapping-row mapping-row--control";
    const maxLab = document.createElement("label");
    maxLab.htmlFor = "spider-absolute-max";
    maxLab.textContent = "Absolute · max deviation (outer)";
    const maxInp = document.createElement("input");
    maxInp.type = "number";
    maxInp.id = "spider-absolute-max";
    maxInp.className = "spider-radius-num";
    maxInp.min = "0";
    maxInp.step = "any";
    maxInp.value = String(radCfg.max);
    maxInp.addEventListener("change", () => {
      const n = parseFloat(maxInp.value);
      const mm = Number.isFinite(n) && n > 0 ? n : 1;
      writeSpiderRadiusAll(activeSceneFile, { max: mm });
      maxInp.value = String(readSpiderRadiusAll(activeSceneFile).max);
    });
    maxRow.appendChild(maxLab);
    maxRow.appendChild(maxInp);
    mappingRowsEl.appendChild(maxRow);

    function syncSpiderAbsoluteInputsDisabled() {
      const abs = readSpiderRadiusAll(activeSceneFile).mode === "absolute";
      meanInp.disabled = !abs;
      maxInp.disabled = !abs;
    }
    syncSpiderAbsoluteInputsDisabled();

    const hint = document.createElement("p");
    hint.className = "mapping-hint";
    hint.textContent = `Up to ${spiderN} plot(s) can be mapped (from NUM_OVERLAY_PLOTS in the .p5 file).`;
    mappingRowsEl.appendChild(hint);

    for (let p = 0; p < spiderN; p++) {
      for (let a = 0; a < 5; a++) {
        const id = `plot_${p}_axis_${a}`;
        const row = document.createElement("div");
        row.className = "mapping-row";

        const lab = document.createElement("label");
        lab.htmlFor = `map-${id}`;
        lab.textContent = `Plot ${p + 1} · ${axisNames[a]}`;

        const sel = document.createElement("select");
        sel.id = `map-${id}`;
        sel.className = "mapping-osc";
        sel.dataset.inputId = id;

        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "— none —";
        sel.appendChild(empty);

        for (const addr of addrs) {
          const opt = document.createElement("option");
          opt.value = addr;
          opt.textContent = addr;
          if (maps[id] === addr) opt.selected = true;
          sel.appendChild(opt);
        }

        sel.addEventListener("change", () => {
          const cur = readMappings();
          const next = { ...cur };
          const sceneMap = { ...(next[activeSceneFile] || {}) };
          if (sel.value) sceneMap[id] = sel.value;
          else delete sceneMap[id];
          next[activeSceneFile] = sceneMap;
          writeMappings(next);
        });

        row.appendChild(lab);
        row.appendChild(sel);
        mappingRowsEl.appendChild(row);
      }

      const hexRow = document.createElement("div");
      hexRow.className = "mapping-row mapping-row--hex";

      const hexLab = document.createElement("label");
      hexLab.htmlFor = `hex-plot-${p}`;
      hexLab.textContent = `Plot ${p + 1} · color (HEX)`;

      const hexInp = document.createElement("input");
      hexInp.type = "text";
      hexInp.id = `hex-plot-${p}`;
      hexInp.className = "spider-hex";
      hexInp.dataset.plotIndex = String(p);
      hexInp.placeholder = "#88aacc";
      hexInp.autocomplete = "off";
      hexInp.spellcheck = false;
      hexInp.value = hexStore[String(p)] || "";

      const onHex = () => {
        writeSpiderHexForScene(activeSceneFile, p, hexInp.value);
      };
      hexInp.addEventListener("input", onHex);
      hexInp.addEventListener("change", onHex);

      hexRow.appendChild(hexLab);
      hexRow.appendChild(hexInp);
      mappingRowsEl.appendChild(hexRow);
    }

    syncSeenAddressesFromSelects();
    updateMappingCsvBarState();
    return;
  }

  for (const inp of scene.inputs) {
    const row = document.createElement("div");
    row.className = "mapping-row";

    const lab = document.createElement("label");
    lab.htmlFor = `map-${inp.id}`;
    lab.textContent = inp.label || inp.id;

    const sel = document.createElement("select");
    sel.id = `map-${inp.id}`;
    sel.className = "mapping-osc";
    sel.dataset.inputId = inp.id;

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "— none —";
    sel.appendChild(empty);

    for (const a of addrs) {
      const opt = document.createElement("option");
      opt.value = a;
      opt.textContent = a;
      if (maps[inp.id] === a) opt.selected = true;
      sel.appendChild(opt);
    }

    sel.addEventListener("change", () => {
      const cur = readMappings();
      const next = { ...cur };
      const sceneMap = { ...(next[activeSceneFile] || {}) };
      if (sel.value) sceneMap[inp.id] = sel.value;
      else delete sceneMap[inp.id];
      next[activeSceneFile] = sceneMap;
      writeMappings(next);
    });

    row.appendChild(lab);
    row.appendChild(sel);
    mappingRowsEl.appendChild(row);
  }

  syncSeenAddressesFromSelects();
  updateMappingCsvBarState();
}

function buildSceneButtons() {
  if (!sceneButtonsEl) return;
  sceneButtonsEl.textContent = "";

  const none = document.createElement("button");
  none.type = "button";
  none.className = "btn-scene";
  none.textContent = "None (blank)";
  none.dataset.file = "";
  if (!activeSceneFile) none.classList.add("is-active");
  none.addEventListener("click", () => selectScene(""));
  sceneButtonsEl.appendChild(none);

  for (const sc of sceneList) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-scene";
    b.textContent = sc.title || sc.file;
    b.dataset.file = sc.file;
    if (sc.file === activeSceneFile) b.classList.add("is-active");
    b.addEventListener("click", () => selectScene(sc.file));
    sceneButtonsEl.appendChild(b);
  }
}

function selectScene(file) {
  activeSceneFile = file || "";
  try {
    localStorage.setItem(LS_ACTIVE_SCENE, activeSceneFile);
  } catch (_) {
    /* ignore */
  }

  for (const b of sceneButtonsEl.querySelectorAll(".btn-scene")) {
    b.classList.toggle("is-active", (b.dataset.file || "") === activeSceneFile);
  }

  if (!activeSceneFile) {
    if (sceneFrameEl) {
      sceneFrameEl.hidden = true;
      sceneFrameEl.removeAttribute("src");
    }
    stopPlaceholderP5();
    startPlaceholderP5();
  } else {
    stopPlaceholderP5();
    if (sceneFrameEl) {
      sceneFrameEl.hidden = false;
      sceneFrameEl.src = `scene-frame.html?scene=${encodeURIComponent(activeSceneFile)}`;
    }
  }

  buildMappingRows();
  suggestMappingCsvBasename();
  window.dispatchEvent(new Event("resize"));
}

function setPanelMode(mode) {
  const isStreams = mode === "streams";
  if (modeStreamsBtn && modeSceneBtn) {
    modeStreamsBtn.classList.toggle("is-active", isStreams);
    modeSceneBtn.classList.toggle("is-active", !isStreams);
  }
  if (streamsModePanel && sceneModePanel) {
    streamsModePanel.classList.toggle("is-hidden", !isStreams);
    sceneModePanel.classList.toggle("is-hidden", isStreams);
  }
  try {
    localStorage.setItem(LS_PANEL_MODE, mode);
  } catch (_) {
    /* ignore */
  }
  window.dispatchEvent(new Event("resize"));
}

async function loadScenesFromApi() {
  try {
    const r = await fetch("/api/p5-scenes");
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    sceneList = Array.isArray(j.scenes) ? j.scenes : [];
  } catch (_) {
    sceneList = [];
  }
}

function applySavedPanelMode() {
  let mode = "streams";
  try {
    const s = localStorage.getItem(LS_PANEL_MODE);
    if (s === "scene" || s === "streams") mode = s;
  } catch (_) {
    /* ignore */
  }
  setPanelMode(mode);
}

function applySavedActiveScene() {
  try {
    const s = localStorage.getItem(LS_ACTIVE_SCENE);
    if (s && sceneList.some((x) => x.file === s)) {
      activeSceneFile = s;
    } else {
      activeSceneFile = "";
    }
  } catch (_) {
    activeSceneFile = "";
  }
  buildSceneButtons();
  if (activeSceneFile) {
    stopPlaceholderP5();
    if (sceneFrameEl) {
      sceneFrameEl.hidden = false;
      sceneFrameEl.src = `scene-frame.html?scene=${encodeURIComponent(activeSceneFile)}`;
    }
  } else {
    startPlaceholderP5();
  }
  buildMappingRows();
  suggestMappingCsvBasename();
}

function applyOscMessage(msg) {
  latestByAddress[msg.address] = {
    args: msg.args,
    receivedAt: msg.receivedAt,
    hardware: msg.hardware,
    stream: msg.stream,
  };
  if (gridRoot) updateDeviceStreamForGrid(gridRoot, rowCacheMain, msg);
  if (gridSceneRoot) updateDeviceStreamForGrid(gridSceneRoot, rowCacheScene, msg);
  if (isDeviceStreamAddress(msg.address)) {
    addAddressOptionToMappingSelects(msg.address);
  }
}

function connectWebSocket() {
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    setStatus(`WebSocket error: ${e}`);
    return;
  }

  ws.onopen = () => {
    setStatus(`Live · ${wsUrl()}`);
  };

  ws.onclose = () => {
    setStatus("Disconnected — retry in 2s…");
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {
    /* onclose follows */
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (msg.type !== "osc" || !msg.address) return;
    applyOscMessage(msg);
  };
}

function startRafDataPump() {
  function tick() {
    requestAnimationFrame(tick);
    if (!sceneFrameEl || sceneFrameEl.hidden || !activeSceneFile) return;
    const w = sceneFrameEl.contentWindow;
    if (!w) return;
    try {
      const data = buildSceneData();
      w.postMessage({ type: "nt-data", data }, window.location.origin);
    } catch (_) {
      /* iframe navigating */
    }
  }
  requestAnimationFrame(tick);
}

function sketch(p) {
  p.setup = function () {
    const mount = placeholderMountEl || document.getElementById("placeholderMount");
    const w = Math.max(120, mount.clientWidth || 400);
    const h = Math.max(120, mount.clientHeight || 300);
    const canvas = p.createCanvas(w, h);
    canvas.parent(mount);
    p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
    p.colorMode(p.RGB, 255);
  };

  p.draw = function () {
    p.background(13, 13, 15);
  };

  p.windowResized = function () {
    const mount = placeholderMountEl || document.getElementById("placeholderMount");
    const w = Math.max(120, mount.clientWidth || p.width);
    const h = Math.max(120, mount.clientHeight || p.height);
    p.resizeCanvas(w, h);
  };
}

function startPlaceholderP5() {
  if (hostP5Instance || activeSceneFile) return;
  hostP5Instance = new p5(sketch);
}

function stopPlaceholderP5() {
  if (!hostP5Instance) return;
  hostP5Instance.remove();
  hostP5Instance = null;
}

function setupDomControls() {
  placeholderMountEl = document.getElementById("placeholderMount");
  sceneFrameEl = document.getElementById("sceneFrame");
  gridRoot = document.getElementById("bannerGrid");
  gridSceneRoot = document.getElementById("bannerGridScene");
  statusEl = document.getElementById("bannerStatus");
  oscBindEl = document.getElementById("bannerOscBind");
  toggleBtn = document.getElementById("toggleBanner");
  peekBtn = document.getElementById("peekBanner");
  bannerAside = document.getElementById("dataBanner");
  modeStreamsBtn = document.getElementById("modeStreams");
  modeSceneBtn = document.getElementById("modeScene");
  streamsModePanel = document.getElementById("streamsModePanel");
  sceneModePanel = document.getElementById("sceneModePanel");
  sceneButtonsEl = document.getElementById("sceneButtons");
  mappingRowsEl = document.getElementById("mappingRows");
  mappingCsvSelectEl = document.getElementById("mappingCsvSelect");
  mappingCsvLoadBtn = document.getElementById("mappingCsvLoad");
  mappingCsvSaveBtn = document.getElementById("mappingCsvSave");
  mappingCsvFilenameEl = document.getElementById("mappingCsvFilename");
  mappingCsvStatusEl = document.getElementById("mappingCsvStatus");

  setupOscPortBar();

  if (mappingCsvLoadBtn) {
    mappingCsvLoadBtn.addEventListener("click", async () => {
      const name = mappingCsvSelectEl && mappingCsvSelectEl.value;
      if (!name || !activeSceneFile) {
        setMappingCsvStatus("Pick a CSV file.", true);
        return;
      }
      setMappingCsvStatus("Loading…", false);
      try {
        const r = await fetch(`/api/p5-mappings/${encodeURIComponent(name)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        applyMappingCsvText(text);
        setMappingCsvStatus(`Loaded ${name}`, false);
      } catch (e) {
        setMappingCsvStatus(String(e && e.message ? e.message : e), true);
      }
    });
  }

  if (mappingCsvSaveBtn) {
    mappingCsvSaveBtn.addEventListener("click", async () => {
      const body = buildMappingCsvString();
      if (!body) {
        setMappingCsvStatus("Nothing to save for this scene.", true);
        return;
      }
      const fname = clientMappingBasenameForPost(mappingCsvFilenameEl && mappingCsvFilenameEl.value);
      setMappingCsvStatus("Saving…", false);
      try {
        const r = await fetch(`/api/p5-mappings/${encodeURIComponent(fname)}`, {
          method: "POST",
          headers: { "Content-Type": "text/csv; charset=utf-8" },
          body,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await refreshMappingFileList();
        if (mappingCsvSelectEl) mappingCsvSelectEl.value = fname;
        setMappingCsvStatus(`Saved ${fname}`, false);
      } catch (e) {
        setMappingCsvStatus(String(e && e.message ? e.message : e), true);
      }
    });
  }

  toggleBtn.addEventListener("click", () => {
    bannerAside.classList.add("is-collapsed");
    peekBtn.hidden = false;
    window.dispatchEvent(new Event("resize"));
  });

  peekBtn.addEventListener("click", () => {
    bannerAside.classList.remove("is-collapsed");
    peekBtn.hidden = true;
    window.dispatchEvent(new Event("resize"));
  });

  modeStreamsBtn.addEventListener("click", () => setPanelMode("streams"));
  modeSceneBtn.addEventListener("click", () => setPanelMode("scene"));
}

async function init() {
  setupDomControls();
  const health = await refreshOscBindLine();
  initOscPortBarFromHealth(health);
  await loadScenesFromApi();
  sortedStreamAddresses().forEach((a) => seenStreamAddresses.add(a));
  applySavedPanelMode();
  applySavedActiveScene();
  await refreshMappingFileList();
  connectWebSocket();
  startRafDataPump();
  if (!activeSceneFile) startPlaceholderP5();
}

init();
