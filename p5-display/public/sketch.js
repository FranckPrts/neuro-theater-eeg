/* global p5 */
/**
 * Host page: WebSocket OSC, live stream grid, panel modes (Stream / Scene),
 * mapping UI, iframe scene runner + placeholder p5 canvas when no scene.
 */

const LS_PANEL_MODE = "nt.p5osc.panelMode";
const LS_ACTIVE_SCENE = "nt.p5osc.activeScene";
const LS_MAPPINGS = "nt.p5osc.mappings";
const LS_SPIDER_HEX = "nt.p5osc.spiderHex";
const LS_SPIDER_DRAW = "nt.p5osc.spiderDrawOverlays";
const LS_SPIDER_RADIUS = "nt.p5osc.spiderRadius";
const LS_OSC_PORT = "nt.p5osc.oscPort";

const OSC_PORT_PRESETS = [8000, 7999, 8001, 8888];
const LS_SPIDER_DATA_LINES = "nt.p5osc.spiderDataLines";
const LS_SPIDER_RADAR = "nt.p5osc.spiderRadar";
const LS_SIGNAL_VIEW = "nt.p5osc.signalView";
const LS_WAVE_AGITATION = "nt.p5osc.waveAgitation";

const WAVE_AGITATION_FILE = "wave-agitation.p5";

const SPIDER_STREAM_GROUPED_FILES = new Set([
  "spider-plot-neon-streams.p5",
  "spider-plot-collective.p5",
]);
const SPIDER_COLLECTIVE_FILE = "spider-plot-collective.p5";
const LEGACY_COLLECTIVE_FILE = "spider-plot-alpha-radar.p5";

const SIGNAL_VIEW_HISTORY_PRESETS = [300, 500, 800, 1200, 1800, 2400];
const SIGNAL_VIEW_SPEED_PRESETS = [1, 2, 3, 5, 8, 12];

/** Full-address snapshot */
const latestByAddress = {};
const seenStreamAddresses = new Set();

let ws;
let gridRoot;
let statusEl;
let oscBindEl;
let toggleBtn;
let peekBtn;
let bannerAside;
let modeStreamsBtn;
let modeSceneBtn;
let modeNdiBtn;
let streamsModePanel;
let sceneModePanel;
let ndiModePanel;
let ndiPanelStatusEl;
let ndiSyncSceneEl;
let ndiEnableBtn;
let ndiOpenOutputBtn;
let ndiActiveBridgeEl;
let ndiSceneSelectEl;
let ndiSceneHintEl;
let ndiBridgeListEl;
let ndiAddBridgeBtn;
let ndiSaveBridgesBtn;
let ndiStreamStatusEl;
/** @type {object|null} */
let ndiConfig = null;
/** @type {Window|null} */
let ndiOutputWin = null;
/** @type {ReturnType<typeof setInterval>|null} */
let ndiStatusPollTimer = null;
let sceneButtonsEl;
let sceneStatusEl;
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

function inputValueType(input) {
  const t = String(input?.type || input?.valueType || "").trim().toLowerCase();
  if (t === "bool" || t === "boolean") return "bool";
  if (t === "select" || t === "preset") return "select";
  return "osc";
}

function selectInputOptions(input) {
  const raw = input?.options || input?.presets || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => {
      if (typeof o === "string") return { value: o, label: o };
      return {
        value: String(o?.value ?? o?.label ?? ""),
        label: String(o?.label ?? o?.value ?? ""),
      };
    })
    .filter((o) => o.value !== "");
}

function defaultSelectValue(input) {
  const opts = selectInputOptions(input);
  const def = input?.default != null ? String(input.default) : "";
  if (def && opts.some((o) => o.value === def)) return def;
  return opts.length ? opts[0].value : def;
}

function seedEnobioConceptGuiDefaults(sceneMap, scene) {
  if (activeSceneFile !== "ENOBIO-concept.p5" || !scene) return sceneMap;
  const next = { ...sceneMap };
  const visitorInp = (scene.inputs || []).find((inp) => inp.id === "visitor");
  if (visitorInp && (next.visitor == null || next.visitor === "")) {
    next.visitor = defaultSelectValue(visitorInp);
  }
  return next;
}

function parseBoolValue(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function defaultBoolValue(input) {
  return parseBoolValue(input?.default, false);
}

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

function setSceneLoadStatus(status, message) {
  if (!sceneStatusEl) return;
  const label =
    status === "loading" ? "Loading" : status === "ready" ? "Displayed" : status === "error" ? "Error" : "Blank";
  sceneStatusEl.textContent = label;
  sceneStatusEl.title = message || label;
  sceneStatusEl.classList.toggle("is-loading", status === "loading");
  sceneStatusEl.classList.toggle("is-ready", status === "ready");
  sceneStatusEl.classList.toggle("is-error", status === "error");
  sceneStatusEl.classList.toggle("is-idle", !status || status === "idle");
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

function getSpiderBranchCount(scene) {
  if (!scene || !scene.spiderPlot) return 5;
  const n = scene.spiderPlot.branchCount;
  return typeof n === "number" && n >= 3 ? Math.floor(n) : 5;
}

function isSpiderStreamGroupedScene(scene) {
  return Boolean(scene && SPIDER_STREAM_GROUPED_FILES.has(scene.file));
}

function isSpiderCollectiveScene(scene) {
  return Boolean(scene && scene.file === SPIDER_COLLECTIVE_FILE);
}

function isSignalViewScene(scene) {
  return Boolean(scene && /^signal-view/i.test(String(scene.file || "")));
}

function isWaveAgitationScene(scene) {
  return Boolean(scene && scene.file === WAVE_AGITATION_FILE);
}

function normalizeWaveMotionMode(value) {
  const v = String(value || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return v === "envelopescroll" ? "envelopeScroll" : "inPlace";
}

function readWaveAgitationSettings(sceneFile) {
  const fallback = { motionMode: "inPlace", historyLength: 500, scrollSpeed: 4 };
  try {
    const raw = localStorage.getItem(LS_WAVE_AGITATION);
    const o = raw ? JSON.parse(raw) : {};
    if (typeof o !== "object" || o === null) return fallback;
    const per = o[sceneFile];
    if (!per || typeof per !== "object") return fallback;
    let historyLength = per.historyLength;
    historyLength =
      typeof historyLength === "number" && Number.isFinite(historyLength)
        ? historyLength
        : parseInt(String(historyLength), 10);
    historyLength = Number.isFinite(historyLength)
      ? Math.max(100, Math.min(4000, Math.floor(historyLength)))
      : fallback.historyLength;
    let scrollSpeed = per.scrollSpeed;
    scrollSpeed =
      typeof scrollSpeed === "number" && Number.isFinite(scrollSpeed)
        ? scrollSpeed
        : parseInt(String(scrollSpeed), 10);
    scrollSpeed = Number.isFinite(scrollSpeed)
      ? Math.max(1, Math.min(20, Math.floor(scrollSpeed)))
      : fallback.scrollSpeed;
    return {
      motionMode: normalizeWaveMotionMode(per.motionMode),
      historyLength,
      scrollSpeed,
    };
  } catch (_) {
    return fallback;
  }
}

function writeWaveAgitationSettings(sceneFile, patch) {
  try {
    const cur = readWaveAgitationSettings(sceneFile);
    const next = { ...cur, ...patch };
    next.motionMode = normalizeWaveMotionMode(next.motionMode);
    next.historyLength = Math.max(100, Math.min(4000, Math.floor(next.historyLength)));
    next.scrollSpeed = Math.max(1, Math.min(20, Math.floor(next.scrollSpeed)));
    const raw = localStorage.getItem(LS_WAVE_AGITATION);
    let o = {};
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) o = parsed;
    }
    o[sceneFile] = next;
    localStorage.setItem(LS_WAVE_AGITATION, JSON.stringify(o));
  } catch (_) {
    /* ignore */
  }
}

function appendWaveAgitationMappingControls(parentEl, sceneFile) {
  const wa = readWaveAgitationSettings(sceneFile);

  const motionRow = document.createElement("div");
  motionRow.className = "mapping-row mapping-row--control";
  const motionLab = document.createElement("label");
  motionLab.htmlFor = "wave-agitation-motion";
  motionLab.textContent = "Wave motion";
  const motionSel = document.createElement("select");
  motionSel.id = "wave-agitation-motion";
  motionSel.className = "mapping-osc mapping-osc--control";
  for (const [val, lab] of [
    ["inPlace", "In-place oscillation"],
    ["envelopeScroll", "Amplitude envelope scroll"],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = lab;
    if (val === wa.motionMode) opt.selected = true;
    motionSel.appendChild(opt);
  }
  motionSel.addEventListener("change", () => {
    writeWaveAgitationSettings(sceneFile, { motionMode: motionSel.value });
  });
  motionRow.appendChild(motionLab);
  motionRow.appendChild(motionSel);
  parentEl.appendChild(motionRow);

  const histRow = document.createElement("div");
  histRow.className = "mapping-row mapping-row--control";
  const histLab = document.createElement("label");
  histLab.htmlFor = "wave-agitation-history";
  histLab.textContent = "Envelope · history (samples)";
  const histSel = document.createElement("select");
  histSel.id = "wave-agitation-history";
  histSel.className = "mapping-osc mapping-osc--control";
  for (const n of SIGNAL_VIEW_HISTORY_PRESETS) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === wa.historyLength) opt.selected = true;
    histSel.appendChild(opt);
  }
  if (!SIGNAL_VIEW_HISTORY_PRESETS.includes(wa.historyLength)) {
    const opt = document.createElement("option");
    opt.value = String(wa.historyLength);
    opt.textContent = String(wa.historyLength);
    opt.selected = true;
    histSel.appendChild(opt);
  }
  histSel.addEventListener("change", () => {
    const n = parseInt(histSel.value, 10);
    writeWaveAgitationSettings(sceneFile, {
      historyLength: Number.isFinite(n) ? n : 500,
    });
  });
  histRow.appendChild(histLab);
  histRow.appendChild(histSel);
  parentEl.appendChild(histRow);

  const speedRow = document.createElement("div");
  speedRow.className = "mapping-row mapping-row--control";
  const speedLab = document.createElement("label");
  speedLab.htmlFor = "wave-agitation-speed";
  speedLab.textContent = "Envelope · scroll speed";
  const speedSel = document.createElement("select");
  speedSel.id = "wave-agitation-speed";
  speedSel.className = "mapping-osc mapping-osc--control";
  for (const n of SIGNAL_VIEW_SPEED_PRESETS) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === wa.scrollSpeed) opt.selected = true;
    speedSel.appendChild(opt);
  }
  if (!SIGNAL_VIEW_SPEED_PRESETS.includes(wa.scrollSpeed)) {
    const opt = document.createElement("option");
    opt.value = String(wa.scrollSpeed);
    opt.textContent = String(wa.scrollSpeed);
    opt.selected = true;
    speedSel.appendChild(opt);
  }
  speedSel.addEventListener("change", () => {
    const n = parseInt(speedSel.value, 10);
    writeWaveAgitationSettings(sceneFile, {
      scrollSpeed: Number.isFinite(n) ? n : 4,
    });
  });
  speedRow.appendChild(speedLab);
  speedRow.appendChild(speedSel);
  parentEl.appendChild(speedRow);
}

function readSignalViewSettings(sceneFile) {
  const fallback = { historyLength: 500, scrollSpeed: 4 };
  try {
    const raw = localStorage.getItem(LS_SIGNAL_VIEW);
    const o = raw ? JSON.parse(raw) : {};
    if (typeof o !== "object" || o === null) return fallback;
    const per = o[sceneFile];
    if (!per || typeof per !== "object") return fallback;
    let historyLength = per.historyLength;
    historyLength =
      typeof historyLength === "number" && Number.isFinite(historyLength)
        ? historyLength
        : parseInt(String(historyLength), 10);
    historyLength = Number.isFinite(historyLength)
      ? Math.max(100, Math.min(4000, Math.floor(historyLength)))
      : fallback.historyLength;
    let scrollSpeed = per.scrollSpeed;
    scrollSpeed =
      typeof scrollSpeed === "number" && Number.isFinite(scrollSpeed)
        ? scrollSpeed
        : parseInt(String(scrollSpeed), 10);
    scrollSpeed = Number.isFinite(scrollSpeed)
      ? Math.max(1, Math.min(20, Math.floor(scrollSpeed)))
      : fallback.scrollSpeed;
    return { historyLength, scrollSpeed };
  } catch (_) {
    return fallback;
  }
}

function writeSignalViewSettings(sceneFile, patch) {
  try {
    const cur = readSignalViewSettings(sceneFile);
    const next = { ...cur, ...patch };
    next.historyLength = Math.max(100, Math.min(4000, Math.floor(next.historyLength)));
    next.scrollSpeed = Math.max(1, Math.min(20, Math.floor(next.scrollSpeed)));
    const raw = localStorage.getItem(LS_SIGNAL_VIEW);
    let o = {};
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) o = parsed;
    }
    o[sceneFile] = next;
    localStorage.setItem(LS_SIGNAL_VIEW, JSON.stringify(o));
  } catch (_) {
    /* ignore */
  }
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

function normalizeSpiderDataLineDisplay(value) {
  const v = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  return v === "powerbands" || v === "powerbandaxes" ? "powerBands" : "electrodes";
}

function readSpiderDataLineDisplay(sceneFile) {
  try {
    const raw = localStorage.getItem(LS_SPIDER_DATA_LINES);
    const o = raw ? JSON.parse(raw) : {};
    if (typeof o !== "object" || o === null) return "electrodes";
    return normalizeSpiderDataLineDisplay(o[sceneFile]);
  } catch (_) {
    return "electrodes";
  }
}

function writeSpiderDataLineDisplay(sceneFile, value) {
  try {
    const raw = localStorage.getItem(LS_SPIDER_DATA_LINES);
    let o = {};
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) o = parsed;
    }
    o[sceneFile] = normalizeSpiderDataLineDisplay(value);
    localStorage.setItem(LS_SPIDER_DATA_LINES, JSON.stringify(o));
  } catch (_) {
    /* ignore */
  }
}

/** Collective spider plot sweep + trail (per scene file). */
function readSpiderRadar(sceneFile) {
  const fallback = { sweepEnabled: true, trailDecayMs: 2000 };
  try {
    const raw = localStorage.getItem(LS_SPIDER_RADAR);
    const o = raw ? JSON.parse(raw) : {};
    if (typeof o !== "object" || o === null) return fallback;
    const per = o[sceneFile];
    if (!per || typeof per !== "object") return fallback;
    const sweepEnabled = per.sweepEnabled !== false;
    let trailDecayMs = per.trailDecayMs;
    trailDecayMs =
      typeof trailDecayMs === "number" && Number.isFinite(trailDecayMs)
        ? trailDecayMs
        : parseInt(String(trailDecayMs), 10);
    trailDecayMs = Number.isFinite(trailDecayMs)
      ? Math.max(0, Math.min(5000, Math.floor(trailDecayMs)))
      : fallback.trailDecayMs;
    return { sweepEnabled, trailDecayMs };
  } catch (_) {
    return fallback;
  }
}

function writeSpiderRadar(sceneFile, patch) {
  try {
    const cur = readSpiderRadar(sceneFile);
    const next = { ...cur, ...patch };
    next.sweepEnabled = next.sweepEnabled !== false;
    next.trailDecayMs = Math.max(
      0,
      Math.min(
        5000,
        Math.floor(
          typeof next.trailDecayMs === "number" && Number.isFinite(next.trailDecayMs)
            ? next.trailDecayMs
            : 2000
        )
      )
    );
    const raw = localStorage.getItem(LS_SPIDER_RADAR);
    let o = {};
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) o = parsed;
    }
    o[sceneFile] = next;
    localStorage.setItem(LS_SPIDER_RADAR, JSON.stringify(o));
  } catch (_) {
    /* ignore */
  }
}

function sortedStreamAddresses() {
  return Object.keys(latestByAddress)
    .filter(isDeviceStreamAddress)
    .sort();
}

/** Default stream suffix per spider axis when no mapping exists yet. */
const SPIDER_AXIS_DEFAULT_SUFFIX = [
  "deltaNorm",
  "thetaNorm",
  "alphaNorm",
  "lowbetaNorm",
  "highbetaNorm",
];

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

/** Unique headset prefixes from live OSC addresses and saved mappings. */
function discoverOscPrefixes(addressList, sceneMaps) {
  const set = new Set();
  for (const addr of addressList || []) {
    const parsed = parseOscAddressParts(addr);
    if (parsed) set.add(parsed.prefix);
  }
  if (sceneMaps && typeof sceneMaps === "object") {
    for (const v of Object.values(sceneMaps)) {
      if (typeof v !== "string") continue;
      const parsed = parseOscAddressParts(v);
      if (parsed) set.add(parsed.prefix);
    }
  }
  return [...set].sort();
}

/** Unique stream suffixes from live OSC addresses (defaults first when present). */
function discoverStreamSuffixes(addressList, sceneMaps) {
  const set = new Set();
  for (const addr of addressList || []) {
    const parsed = parseOscAddressParts(addr);
    if (parsed && parsed.suffix) set.add(parsed.suffix);
  }
  if (sceneMaps && typeof sceneMaps === "object") {
    for (const v of Object.values(sceneMaps)) {
      if (typeof v !== "string") continue;
      const parsed = parseOscAddressParts(v);
      if (parsed && parsed.suffix) set.add(parsed.suffix);
    }
  }
  const ordered = [];
  for (const s of SPIDER_AXIS_DEFAULT_SUFFIX) {
    if (set.has(s)) {
      ordered.push(s);
      set.delete(s);
    }
  }
  return ordered.concat([...set].sort());
}

/** All device OSC addresses for one stream suffix, sorted by headset prefix. */
function addressesForStreamSuffix(suffix, addressList) {
  const want = String(suffix || "").replace(/^\/+|\/+$/g, "");
  if (!want) return [];
  const out = [];
  for (const addr of addressList || []) {
    const parsed = parseOscAddressParts(addr);
    if (parsed && parsed.suffix === want) out.push(addr);
  }
  return out.sort((a, b) => {
    const pa = parseOscAddressParts(a)?.prefix || "";
    const pb = parseOscAddressParts(b)?.prefix || "";
    return pa.localeCompare(pb);
  });
}

function activePrefixForPlot(plotIndex, maps, branchN = 5) {
  for (let a = 0; a < branchN; a++) {
    const parsed = parseOscAddressParts(maps[`plot_${plotIndex}_axis_${a}`]);
    if (parsed) return parsed.prefix;
  }
  return null;
}

function activeSuffixForPlot(plotIndex, maps, branchN = 5) {
  for (let a = 0; a < branchN; a++) {
    const parsed = parseOscAddressParts(maps[`plot_${plotIndex}_axis_${a}`]);
    if (parsed) return parsed.suffix;
  }
  return null;
}

/** Rewrite band/stream mappings for one plot to use a new headset prefix (band spider scenes). */
function applyPlotGroupPrefix(plotIndex, newPrefix, maps, branchN = 5) {
  const updates = {};
  const prefix = String(newPrefix || "").replace(/^\/+|\/+$/g, "");
  if (!prefix) return updates;
  for (let a = 0; a < branchN; a++) {
    const id = `plot_${plotIndex}_axis_${a}`;
    const cur = maps[id];
    let suffix = SPIDER_AXIS_DEFAULT_SUFFIX[a] || SPIDER_AXIS_DEFAULT_SUFFIX[0];
    const parsed = parseOscAddressParts(cur);
    if (parsed) suffix = parsed.suffix;
    const addr = composeOscAddress(prefix, suffix);
    if (addr && isDeviceStreamAddress(addr)) updates[id] = addr;
  }
  return updates;
}

/**
 * Stream-grouped spider: map one stream onto branches — one device per branch.
 * Uses all live/mapped addresses that publish that suffix (sorted by headset prefix).
 */
function applyPlotStreamSuffix(plotIndex, newSuffix, maps, branchN = 5, addressList = null) {
  const updates = {};
  const suffix = String(newSuffix || "").replace(/^\/+|\/+$/g, "");
  if (!suffix) return updates;

  const addrs = addressList || sortedStreamAddresses();
  const matching = addressesForStreamSuffix(suffix, addrs);

  if (matching.length) {
    for (let a = 0; a < branchN; a++) {
      const id = `plot_${plotIndex}_axis_${a}`;
      if (a < matching.length) updates[id] = matching[a];
      else updates[id] = "";
    }
    return updates;
  }

  for (let a = 0; a < branchN; a++) {
    const id = `plot_${plotIndex}_axis_${a}`;
    const cur = maps[id];
    const parsed = parseOscAddressParts(cur);
    if (!parsed || !parsed.prefix) continue;
    const addr = composeOscAddress(parsed.prefix, suffix);
    if (addr && isDeviceStreamAddress(addr)) updates[id] = addr;
  }
  return updates;
}

function applyPlotStreamFromAddress(plotIndex, selectedAddress, branchN = 5, addressList = null) {
  const parsed = parseOscAddressParts(selectedAddress);
  if (!parsed || !parsed.suffix) return {};
  return applyPlotStreamSuffix(
    plotIndex,
    parsed.suffix,
    readMappings()[activeSceneFile] || {},
    branchN,
    addressList
  );
}

function applyStreamGroupPatchToUi(group, plotIndex, patch, branchN) {
  if (!group || !patch) return;
  writePlotGroupMappings(plotIndex, patch);
  for (const sel of group.querySelectorAll("select.mapping-osc")) {
    const inputId = sel.dataset.inputId;
    if (!inputId || !Object.prototype.hasOwnProperty.call(patch, inputId)) continue;
    sel.value = patch[inputId] || "";
  }
  const freshMaps = readMappings()[activeSceneFile] || {};
  const scene = sceneList.find((s) => s.file === activeSceneFile);
  const collective = isSpiderCollectiveScene(scene);
  for (const row of group.querySelectorAll(".mapping-plot-group__bands .mapping-row")) {
    const sel = row.querySelector("select.mapping-osc");
    const lab = row.querySelector("label");
    if (!sel || !lab) continue;
    const inputId = sel.dataset.inputId || "";
    const m = /^plot_(\d+)_axis_(\d+)$/.exec(inputId);
    if (!m || parseInt(m[1], 10) !== plotIndex) continue;
    const a = parseInt(m[2], 10);
    lab.textContent = collective
      ? branchLabelFromInputId(freshMaps, inputId)
      : branchLabelFromMaps(freshMaps, a, branchN);
  }
  syncPlotSuffixButtons(group, plotIndex, branchN);
}

function branchLabelFromMaps(maps, branchIndex, branchN) {
  for (let p = 0; p < 12; p++) {
    const parsed = parseOscAddressParts(maps[`plot_${p}_axis_${branchIndex}`]);
    if (parsed && parsed.prefix) return parsed.prefix;
  }
  return `Branch ${branchIndex + 1}`;
}

function branchLabelFromInputId(maps, inputId) {
  const parsed = parseOscAddressParts(maps[inputId]);
  if (parsed && parsed.prefix) return parsed.prefix;
  const m = /^plot_\d+_axis_(\d+)$/.exec(inputId || "");
  if (m) return `Branch ${parseInt(m[1], 10) + 1}`;
  return "Branch";
}

function firstCompletePlotIndexForData(maps, branchN, drawN) {
  for (let p = 0; p < drawN; p++) {
    let ok = true;
    for (let a = 0; a < branchN; a++) {
      const id = `plot_${p}_axis_${a}`;
      const addr = maps[id];
      if (!addr) {
        ok = false;
        break;
      }
      const rec = latestByAddress[addr];
      if (!rec || !Array.isArray(rec.args) || !rec.args.length) {
        ok = false;
        break;
      }
      if (coerceFirstNumeric(rec.args[0]) === null) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return -1;
}

function branchLabelsForCollectivePlot(maps, branchN, drawN) {
  const labels = [];
  const plotIdx = firstCompletePlotIndexForData(maps, branchN, drawN);
  const labelPlot = plotIdx >= 0 ? plotIdx : 0;
  for (let a = 0; a < branchN; a++) {
    labels.push(branchLabelFromInputId(maps, `plot_${labelPlot}_axis_${a}`));
  }
  return labels;
}

function syncPlotPrefixButtons(groupEl, plotIndex, branchN = 5) {
  if (!groupEl) return;
  const maps = readMappings()[activeSceneFile] || {};
  const active = activePrefixForPlot(plotIndex, maps, branchN);
  for (const btn of groupEl.querySelectorAll(".mapping-prefix-btn")) {
    const p = btn.dataset.prefix || "";
    btn.classList.toggle("is-active", Boolean(active && p === active));
  }
}

function syncPlotSuffixButtons(groupEl, plotIndex, branchN = 5) {
  if (!groupEl) return;
  const maps = readMappings()[activeSceneFile] || {};
  const active = activeSuffixForPlot(plotIndex, maps, branchN);
  for (const btn of groupEl.querySelectorAll(".mapping-suffix-btn")) {
    const s = btn.dataset.suffix || "";
    btn.classList.toggle("is-active", Boolean(active && s === active));
  }
}

function writePlotGroupMappings(plotIndex, patchByInputId) {
  const cur = readMappings();
  const next = { ...cur };
  const sceneMap = { ...(next[activeSceneFile] || {}) };
  for (const [id, addr] of Object.entries(patchByInputId)) {
    if (addr) sceneMap[id] = addr;
    else delete sceneMap[id];
  }
  next[activeSceneFile] = sceneMap;
  writeMappings(next);
  for (const addr of Object.values(patchByInputId)) {
    if (addr) seedMappingSelectAddresses(addr);
  }
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
    const branchN = getSpiderBranchCount(scene);
    const out = {};
    const railN = spiderN;
    const drawN = Math.max(1, Math.min(railN, readSpiderDrawCount(activeSceneFile, railN)));
    out.__plotCount = drawN;
    out.__branchCount = branchN;
    const rad = readSpiderRadiusAll(activeSceneFile);
    out.__radiusMode = rad.mode;
    out.__absoluteMean = rad.mean;
    out.__absoluteMax = rad.max;
    if (!isSpiderStreamGroupedScene(scene) && !isWaveAgitationScene(scene)) {
      out.__dataLineDisplay = readSpiderDataLineDisplay(activeSceneFile);
    }
    if (isSpiderStreamGroupedScene(scene)) {
      if (isSpiderCollectiveScene(scene)) {
        const labels = branchLabelsForCollectivePlot(maps, branchN, drawN);
        for (let a = 0; a < branchN; a++) {
          out[`__branchLabel_${a}`] = labels[a];
        }
      } else {
        for (let a = 0; a < branchN; a++) {
          out[`__branchLabel_${a}`] = branchLabelFromMaps(maps, a, branchN);
        }
      }
    }
    if (isSpiderCollectiveScene(scene)) {
      const radar = readSpiderRadar(activeSceneFile);
      out.__sweepEnabled = radar.sweepEnabled;
      out.__trailDecayMs = radar.trailDecayMs;
    }
    if (isWaveAgitationScene(scene)) {
      const wa = readWaveAgitationSettings(activeSceneFile);
      out.__waveMotionMode = wa.motionMode;
      out.__historyLength = wa.historyLength;
      out.__scrollSpeed = wa.scrollSpeed;
    }
    for (let p = 0; p < railN; p++) {
      for (let a = 0; a < branchN; a++) {
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
  if (isSignalViewScene(scene)) {
    const sv = readSignalViewSettings(activeSceneFile);
    out.__historyLength = sv.historyLength;
    out.__scrollSpeed = sv.scrollSpeed;
  }
  for (const inp of scene.inputs) {
    if (inputValueType(inp) === "bool") {
      out[inp.id] = parseBoolValue(maps[inp.id], defaultBoolValue(inp));
      continue;
    }
    if (inputValueType(inp) === "select") {
      const v = maps[inp.id];
      out[inp.id] = v != null && v !== "" ? String(v) : defaultSelectValue(inp);
      continue;
    }

    const addr = maps[inp.id];
    if (!addr) continue;
    const rec = latestByAddress[addr];
    if (!rec || !Array.isArray(rec.args) || !rec.args.length) continue;
    const n = coerceFirstNumeric(rec.args[0]);
    if (n !== null) out[inp.id] = n;
  }
  return out;
}

function maybeRefreshMappingPrefixBars(addr) {
  if (!mappingRowsEl || !activeSceneFile) return;
  const scene = sceneList.find((s) => s.file === activeSceneFile);
  if (!getSpiderPlotCount(scene)) return;
  const parsed = parseOscAddressParts(addr);
  if (!parsed) return;
  const bar = mappingRowsEl.querySelector(".mapping-prefix-bar");
  if (!bar || bar.querySelector(`[data-prefix="${parsed.prefix}"]`)) return;
  buildMappingRows();
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
  maybeRefreshMappingPrefixBars(addr);
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
  const branchN = getSpiderBranchCount(scene);
  const streamGrouped = isSpiderStreamGroupedScene(scene);
  const out = [];
  if (spiderN > 0) {
    const axisNames = ["Δ", "θ", "α", "low β", "high β"];
    out.push({ inputId: "__plotCount", label: "Overlays to visualize", valueType: "control" });
    if (!streamGrouped && !isWaveAgitationScene(scene)) {
      out.push({ inputId: "__dataLineDisplay", label: "Data line display", valueType: "control" });
    }
    if (isWaveAgitationScene(scene)) {
      out.push({ inputId: "__waveMotionMode", label: "Wave motion", valueType: "control" });
      out.push({ inputId: "__historyLength", label: "Envelope · history (samples)", valueType: "control" });
      out.push({ inputId: "__scrollSpeed", label: "Envelope · scroll speed", valueType: "control" });
    }
    out.push({ inputId: "__radiusMode", label: "Radius mode", valueType: "control" });
    out.push({ inputId: "__absoluteMean", label: "Absolute · mean (center)", valueType: "control" });
    out.push({ inputId: "__absoluteMax", label: "Absolute · max deviation (outer)", valueType: "control" });
    for (let p = 0; p < spiderN; p++) {
      for (let a = 0; a < branchN; a++) {
        const id = `plot_${p}_axis_${a}`;
        const axisLabel = streamGrouped
          ? `Headset branch ${a + 1}`
          : axisNames[a] || `axis ${a + 1}`;
        const plotLabel = streamGrouped ? `Stream group ${p + 1}` : `Plot ${p + 1}`;
        out.push({ inputId: id, label: `${plotLabel} · ${axisLabel}`, valueType: "osc" });
      }
      const colorLabel = streamGrouped
        ? `Stream group ${p + 1} · color (HEX)`
        : `Plot ${p + 1} · color (HEX)`;
      out.push({ inputId: `plot_${p}_color`, label: colorLabel, valueType: "hex" });
    }
    return out;
  }
  if (isSignalViewScene(scene)) {
    out.push({ inputId: "__historyLength", label: "X axis · history (samples)", valueType: "control" });
    out.push({ inputId: "__scrollSpeed", label: "Scroll speed", valueType: "control" });
  }
  for (const inp of scene.inputs || []) {
    out.push({
      inputId: inp.id,
      label: inp.label || inp.id,
      valueType: inputValueType(inp),
      defaultValue:
        inputValueType(inp) === "bool"
          ? defaultBoolValue(inp)
          : inputValueType(inp) === "select"
            ? defaultSelectValue(inp)
            : undefined,
    });
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
    } else if (f.valueType === "bool") {
      addr = String(parseBoolValue(maps[f.inputId], Boolean(f.defaultValue)));
    } else if (f.valueType === "select") {
      const inp = (scene?.inputs || []).find((i) => i.id === f.inputId);
      const v = maps[f.inputId];
      addr = v != null && v !== "" ? String(v) : defaultSelectValue(inp || {});
    } else if (f.valueType === "hex") {
      const m = /^plot_(\d+)_color$/.exec(f.inputId);
      addr = m && hexAll[String(m[1])] != null ? String(hexAll[String(m[1])]) : "";
    } else if (f.valueType === "control" && spiderN > 0) {
      const rad = readSpiderRadiusAll(activeSceneFile);
      if (f.inputId === "__plotCount") {
        addr = String(readSpiderDrawCount(activeSceneFile, spiderN));
      } else if (f.inputId === "__dataLineDisplay") {
        addr = readSpiderDataLineDisplay(activeSceneFile);
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
      else if (vType === "bool") delete sceneMap[exp.inputId];
      else if (vType === "select") delete sceneMap[exp.inputId];
      else if (vType === "hex") {
        const m = /^plot_(\d+)_color$/.exec(exp.inputId);
        if (m) writeSpiderHexForScene(activeSceneFile, parseInt(m[1], 10), "");
      } else if (vType === "control" && spiderN > 0) {
        if (exp.inputId === "__plotCount") {
          writeSpiderDrawCount(activeSceneFile, spiderN);
        } else if (exp.inputId === "__dataLineDisplay") {
          writeSpiderDataLineDisplay(activeSceneFile, "electrodes");
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
    } else if (vType === "bool") {
      sceneMap[exp.inputId] = parseBoolValue(addr, Boolean(exp.defaultValue));
    } else if (vType === "select") {
      const inp = (scene?.inputs || []).find((i) => i.id === exp.inputId);
      const opts = selectInputOptions(inp || {});
      if (addr && opts.some((o) => o.value === addr)) sceneMap[exp.inputId] = addr;
      else sceneMap[exp.inputId] = defaultSelectValue(inp || {});
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
      } else if (exp.inputId === "__dataLineDisplay") {
        writeSpiderDataLineDisplay(activeSceneFile, addr);
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

function writeSceneMappingValue(inputId, value) {
  const cur = readMappings();
  const next = { ...cur };
  const sceneMap = { ...(next[activeSceneFile] || {}) };
  if (value === undefined || value === null || value === "") delete sceneMap[inputId];
  else sceneMap[inputId] = value;

  next[activeSceneFile] = sceneMap;
  writeMappings(next);
}

function createOscMappingRow(input, addrs, maps) {
  const id = input.id;
  const row = document.createElement("div");
  row.className = "mapping-row";

  const lab = document.createElement("label");
  lab.htmlFor = `map-${id}`;
  lab.textContent = input.label || id;

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
    writeSceneMappingValue(id, sel.value || undefined);
  });

  row.appendChild(lab);
  row.appendChild(sel);
  return row;
}

function createSelectMappingRow(input, maps) {
  const id = input.id;
  const options = selectInputOptions(input);
  const row = document.createElement("div");
  row.className = "mapping-row mapping-row--select";

  const lab = document.createElement("label");
  lab.htmlFor = `map-${id}`;
  lab.textContent = input.label || id;

  const sel = document.createElement("select");
  sel.id = `map-${id}`;
  sel.className = "mapping-osc mapping-osc--control";
  sel.dataset.inputId = id;

  const cur = maps[id] != null && maps[id] !== "" ? String(maps[id]) : defaultSelectValue(input);

  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === cur) o.selected = true;
    sel.appendChild(o);
  }

  sel.addEventListener("change", () => {
    writeSceneMappingValue(id, sel.value);
  });

  row.appendChild(lab);
  row.appendChild(sel);
  return row;
}

function createBoolMappingRow(input, maps) {
  const id = input.id;
  const row = document.createElement("div");
  row.className = "mapping-row mapping-row--bool";

  const lab = document.createElement("label");
  lab.htmlFor = `map-${id}`;
  lab.textContent = input.label || id;

  const boolWrap = document.createElement("label");
  boolWrap.className = "mapping-bool";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = `map-${id}`;
  checkbox.dataset.inputId = id;
  checkbox.checked = parseBoolValue(maps[id], defaultBoolValue(input));

  const text = document.createElement("span");
  text.textContent = "Enabled";

  checkbox.addEventListener("change", () => {
    writeSceneMappingValue(id, checkbox.checked);
  });

  boolWrap.appendChild(checkbox);
  boolWrap.appendChild(text);
  row.appendChild(lab);
  row.appendChild(boolWrap);
  return row;
}

function createSceneInputMappingRow(input, addrs, maps) {
  const t = inputValueType(input);
  if (t === "bool") return createBoolMappingRow(input, maps);
  if (t === "select") return createSelectMappingRow(input, maps);
  return createOscMappingRow(input, addrs, maps);
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
  const storedMaps = { ...(allMaps[activeSceneFile] || {}) };
  const maps = seedEnobioConceptGuiDefaults(storedMaps, scene);
  if (activeSceneFile === "ENOBIO-concept.p5") {
    const changed = Object.keys(maps).some((k) => maps[k] !== storedMaps[k])
      || Object.keys(storedMaps).some((k) => maps[k] !== storedMaps[k]);
    if (changed) {
      allMaps[activeSceneFile] = maps;
      writeMappings(allMaps);
    }
  }
  const addrs = sortedStreamAddresses();

  if (spiderN > 0) {
    const branchN = getSpiderBranchCount(scene);
    const streamGrouped = isSpiderStreamGroupedScene(scene);
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

    if (!streamGrouped && !isWaveAgitationScene(scene)) {
      const dataLineRow = document.createElement("div");
      dataLineRow.className = "mapping-row mapping-row--control";
      const dataLineLab = document.createElement("label");
      dataLineLab.htmlFor = "spider-data-line-display";
      dataLineLab.textContent = "Data line display";
      const dataLineSel = document.createElement("select");
      dataLineSel.id = "spider-data-line-display";
      dataLineSel.className = "mapping-osc mapping-osc--control";
      const dataLineValue = readSpiderDataLineDisplay(activeSceneFile);
      for (const [val, lab] of [
        ["electrodes", "Electrode labels"],
        ["powerBands", "Power-band axes"],
      ]) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = lab;
        if (val === dataLineValue) opt.selected = true;
        dataLineSel.appendChild(opt);
      }
      dataLineSel.addEventListener("change", () => {
        writeSpiderDataLineDisplay(activeSceneFile, dataLineSel.value);
      });
      dataLineRow.appendChild(dataLineLab);
      dataLineRow.appendChild(dataLineSel);
      mappingRowsEl.appendChild(dataLineRow);
    }

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

    if (isWaveAgitationScene(scene)) {
      appendWaveAgitationMappingControls(mappingRowsEl, activeSceneFile);
    }

    if (isSpiderCollectiveScene(scene)) {
      const radarCfg = readSpiderRadar(activeSceneFile);

      const sweepRow = document.createElement("div");
      sweepRow.className = "mapping-row mapping-row--control";
      const sweepLab = document.createElement("label");
      sweepLab.htmlFor = "spider-collective-sweep";
      sweepLab.textContent = "Radar sweep";
      const sweepBtn = document.createElement("button");
      sweepBtn.type = "button";
      sweepBtn.id = "spider-collective-sweep";
      sweepBtn.className = "mapping-prefix-btn";
      sweepBtn.setAttribute("aria-pressed", radarCfg.sweepEnabled ? "true" : "false");
      sweepBtn.textContent = radarCfg.sweepEnabled ? "ON" : "OFF";
      sweepBtn.addEventListener("click", () => {
        const on = sweepBtn.getAttribute("aria-pressed") !== "true";
        sweepBtn.setAttribute("aria-pressed", on ? "true" : "false");
        sweepBtn.textContent = on ? "ON" : "OFF";
        writeSpiderRadar(activeSceneFile, { sweepEnabled: on });
      });
      sweepRow.appendChild(sweepLab);
      sweepRow.appendChild(sweepBtn);
      mappingRowsEl.appendChild(sweepRow);

      const trailRow = document.createElement("div");
      trailRow.className = "mapping-row mapping-row--control";
      const trailLab = document.createElement("label");
      trailLab.htmlFor = "spider-collective-trail";
      trailLab.textContent = "Trail decay";
      const trailWrap = document.createElement("div");
      trailWrap.className = "spider-collective-trail";
      const trailInp = document.createElement("input");
      trailInp.type = "range";
      trailInp.id = "spider-collective-trail";
      trailInp.min = "0";
      trailInp.max = "5000";
      trailInp.step = "50";
      trailInp.value = String(radarCfg.trailDecayMs);
      const trailVal = document.createElement("span");
      trailVal.className = "spider-collective-trail__val";
      trailVal.textContent = `${(radarCfg.trailDecayMs / 1000).toFixed(2)}s`;
      trailInp.addEventListener("input", () => {
        const ms = parseInt(trailInp.value, 10);
        writeSpiderRadar(activeSceneFile, { trailDecayMs: ms });
        trailVal.textContent = `${(ms / 1000).toFixed(2)}s`;
      });
      trailWrap.appendChild(trailInp);
      trailWrap.appendChild(trailVal);
      trailRow.appendChild(trailLab);
      trailRow.appendChild(trailWrap);
      mappingRowsEl.appendChild(trailRow);
    }

    const hint = document.createElement("p");
    hint.className = "mapping-hint";
    hint.textContent = streamGrouped
      ? isSpiderCollectiveScene(scene)
        ? `Up to ${spiderN} stream group(s), ${branchN} headset branch(es) each. Use suffix buttons for auto-fill, or map each branch manually (same headset allowed on multiple branches).`
        : `Up to ${spiderN} stream group(s), ${branchN} headset branch(es) each. Pick a stream (button or any branch dropdown) to map that stream from every device that publishes it.`
      : `Up to ${spiderN} plot(s) can be mapped (from NUM_OVERLAY_PLOTS in the .p5 file). Use headset prefix buttons to remap all bands for a plot.`;
    mappingRowsEl.appendChild(hint);

    const oscPrefixes = discoverOscPrefixes(addrs, maps);
    const streamSuffixes = streamGrouped ? discoverStreamSuffixes(addrs, maps) : [];

    for (let p = 0; p < spiderN; p++) {
      const group = document.createElement("section");
      group.className = "mapping-plot-group";
      group.dataset.plotIndex = String(p);

      const head = document.createElement("div");
      head.className = "mapping-plot-group__head";

      const title = document.createElement("span");
      title.className = "mapping-plot-group__title";
      title.textContent = streamGrouped ? `Stream group ${p + 1}` : `Plot ${p + 1}`;

      const quickBar = document.createElement("div");
      quickBar.className = streamGrouped ? "mapping-suffix-bar" : "mapping-prefix-bar";
      quickBar.setAttribute("role", "group");
      quickBar.setAttribute(
        "aria-label",
        streamGrouped ? `Stream group ${p + 1} stream suffix` : `Plot ${p + 1} headset prefix`
      );

      if (streamGrouped) {
        if (streamSuffixes.length) {
          for (const suffix of streamSuffixes) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "mapping-suffix-btn mapping-prefix-btn";
            btn.dataset.suffix = suffix;
            btn.textContent = suffix;
            btn.title = `Map stream group ${p + 1} to …/${suffix} on all devices that stream it`;
            btn.addEventListener("click", () => {
              const patch = applyPlotStreamSuffix(
                p,
                suffix,
                readMappings()[activeSceneFile] || {},
                branchN,
                addrs
              );
              if (!Object.keys(patch).length) return;
              applyStreamGroupPatchToUi(group, p, patch, branchN);
            });
            quickBar.appendChild(btn);
          }
        } else {
          const noStreams = document.createElement("span");
          noStreams.className = "mapping-prefix-bar__empty";
          noStreams.textContent = "No streams yet";
          quickBar.appendChild(noStreams);
        }
      } else if (oscPrefixes.length) {
        for (const prefix of oscPrefixes) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "mapping-prefix-btn";
          btn.dataset.prefix = prefix;
          btn.textContent = prefix;
          btn.title = `Map Plot ${p + 1} bands to /${prefix}/…`;
          btn.addEventListener("click", () => {
            const patch = applyPlotGroupPrefix(
              p,
              prefix,
              readMappings()[activeSceneFile] || {},
              branchN
            );
            if (!Object.keys(patch).length) return;
            writePlotGroupMappings(p, patch);
            for (const sel of group.querySelectorAll("select.mapping-osc")) {
              const inputId = sel.dataset.inputId;
              if (inputId && patch[inputId]) sel.value = patch[inputId];
            }
            syncPlotPrefixButtons(group, p, branchN);
          });
          quickBar.appendChild(btn);
        }
      } else {
        const noQuick = document.createElement("span");
        noQuick.className = "mapping-prefix-bar__empty";
        noQuick.textContent = streamGrouped ? "Map branches first" : "No prefixes yet";
        quickBar.appendChild(noQuick);
      }

      head.appendChild(title);
      head.appendChild(quickBar);
      group.appendChild(head);

      const bands = document.createElement("div");
      bands.className = "mapping-plot-group__bands";

      for (let a = 0; a < branchN; a++) {
        const id = `plot_${p}_axis_${a}`;
        const row = document.createElement("div");
        row.className = "mapping-row";

        const lab = document.createElement("label");
        lab.htmlFor = `map-${id}`;
        lab.textContent = streamGrouped
          ? isSpiderCollectiveScene(scene)
            ? branchLabelFromInputId(maps, id)
            : branchLabelFromMaps(maps, a, branchN)
          : axisNames[a] || `axis ${a + 1}`;

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
          const bulkStreamGrouped =
            streamGrouped && sel.value && !isSpiderCollectiveScene(scene);
          if (bulkStreamGrouped) {
            const patch = applyPlotStreamFromAddress(p, sel.value, branchN, addrs);
            if (Object.keys(patch).length) {
              applyStreamGroupPatchToUi(group, p, patch, branchN);
              return;
            }
          }
          const cur = readMappings();
          const next = { ...cur };
          const sceneMap = { ...(next[activeSceneFile] || {}) };
          if (sel.value) sceneMap[id] = sel.value;
          else delete sceneMap[id];
          next[activeSceneFile] = sceneMap;
          writeMappings(next);
          if (streamGrouped) {
            const freshMaps = readMappings()[activeSceneFile] || {};
            lab.textContent = isSpiderCollectiveScene(scene)
              ? branchLabelFromInputId(freshMaps, id)
              : branchLabelFromMaps(freshMaps, a, branchN);
            syncPlotSuffixButtons(group, p, branchN);
          } else {
            syncPlotPrefixButtons(group, p, branchN);
          }
        });

        row.appendChild(lab);
        row.appendChild(sel);
        bands.appendChild(row);
      }

      group.appendChild(bands);

      const hexRow = document.createElement("div");
      hexRow.className = "mapping-row mapping-row--hex";

      const hexLab = document.createElement("label");
      hexLab.htmlFor = `hex-plot-${p}`;
      hexLab.textContent = "Color (HEX)";

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
      group.appendChild(hexRow);

      if (streamGrouped) syncPlotSuffixButtons(group, p, branchN);
      else syncPlotPrefixButtons(group, p, branchN);
      mappingRowsEl.appendChild(group);
    }

    syncSeenAddressesFromSelects();
    updateMappingCsvBarState();
    return;
  }

  if (isSignalViewScene(scene)) {
    const sv = readSignalViewSettings(activeSceneFile);

    const histRow = document.createElement("div");
    histRow.className = "mapping-row mapping-row--control";
    const histLab = document.createElement("label");
    histLab.htmlFor = "signal-view-history";
    histLab.textContent = "X axis · history (samples)";
    const histSel = document.createElement("select");
    histSel.id = "signal-view-history";
    histSel.className = "mapping-osc mapping-osc--control";
    for (const n of SIGNAL_VIEW_HISTORY_PRESETS) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = String(n);
      if (n === sv.historyLength) opt.selected = true;
      histSel.appendChild(opt);
    }
    if (!SIGNAL_VIEW_HISTORY_PRESETS.includes(sv.historyLength)) {
      const opt = document.createElement("option");
      opt.value = String(sv.historyLength);
      opt.textContent = String(sv.historyLength);
      opt.selected = true;
      histSel.appendChild(opt);
    }
    histSel.addEventListener("change", () => {
      const n = parseInt(histSel.value, 10);
      writeSignalViewSettings(activeSceneFile, {
        historyLength: Number.isFinite(n) ? n : 500,
      });
    });
    histRow.appendChild(histLab);
    histRow.appendChild(histSel);
    mappingRowsEl.appendChild(histRow);

    const speedRow = document.createElement("div");
    speedRow.className = "mapping-row mapping-row--control";
    const speedLab = document.createElement("label");
    speedLab.htmlFor = "signal-view-speed";
    speedLab.textContent = "Scroll speed";
    const speedSel = document.createElement("select");
    speedSel.id = "signal-view-speed";
    speedSel.className = "mapping-osc mapping-osc--control";
    for (const n of SIGNAL_VIEW_SPEED_PRESETS) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = n === 1 ? "1× (normal)" : `${n}×`;
      if (n === sv.scrollSpeed) opt.selected = true;
      speedSel.appendChild(opt);
    }
    speedSel.addEventListener("change", () => {
      const n = parseInt(speedSel.value, 10);
      writeSignalViewSettings(activeSceneFile, {
        scrollSpeed: Number.isFinite(n) ? n : 4,
      });
    });
    speedRow.appendChild(speedLab);
    speedRow.appendChild(speedSel);
    mappingRowsEl.appendChild(speedRow);

    const hint = document.createElement("p");
    hint.className = "mapping-hint";
    hint.textContent =
      "History sets how many samples span the plot width. Scroll speed adds multiple samples per OSC update so traces move faster.";
    mappingRowsEl.appendChild(hint);
  }

  for (const inp of scene.inputs) {
    mappingRowsEl.appendChild(createSceneInputMappingRow(inp, addrs, maps));
  }

  syncSeenAddressesFromSelects();
  updateMappingCsvBarState();
}

function createSceneButton(sc) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn-scene";
  b.textContent = sc.title || sc.file;
  b.dataset.file = sc.file;
  if (sc.file === activeSceneFile) b.classList.add("is-active");
  b.addEventListener("click", () => selectScene(sc.file));
  return b;
}

function buildSceneButtons() {
  if (!sceneButtonsEl) return;
  sceneButtonsEl.textContent = "";
  sceneButtonsEl.classList.add("scene-buttons--grouped");

  const favoriteFiles = new Set(sceneList.filter((s) => s.favorite).map((s) => s.file));
  if (activeSceneFile) favoriteFiles.add(activeSceneFile);

  let primaryScenes = sceneList.filter((s) => favoriteFiles.has(s.file));
  if (!primaryScenes.length) primaryScenes = [...sceneList];

  const moreScenes = sceneList.filter((s) => !favoriteFiles.has(s.file));

  const primaryRow = document.createElement("div");
  primaryRow.className = "scene-buttons__row";

  const none = document.createElement("button");
  none.type = "button";
  none.className = "btn-scene";
  none.textContent = "None (blank)";
  none.dataset.file = "";
  if (!activeSceneFile) none.classList.add("is-active");
  none.addEventListener("click", () => selectScene(""));
  primaryRow.appendChild(none);

  for (const sc of primaryScenes) {
    primaryRow.appendChild(createSceneButton(sc));
  }
  sceneButtonsEl.appendChild(primaryRow);

  if (moreScenes.length) {
    const details = document.createElement("details");
    details.className = "scene-details";

    const summary = document.createElement("summary");
    summary.textContent = `More scenes (${moreScenes.length})`;
    details.appendChild(summary);

    const scroll = document.createElement("div");
    scroll.className = "scene-buttons scene-details__scroll scene-buttons__row";
    for (const sc of moreScenes) {
      scroll.appendChild(createSceneButton(sc));
    }
    details.appendChild(scroll);
    sceneButtonsEl.appendChild(details);
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
    setSceneLoadStatus("idle");
    if (sceneFrameEl) {
      sceneFrameEl.hidden = true;
      sceneFrameEl.removeAttribute("src");
    }
    stopPlaceholderP5();
    startPlaceholderP5();
  } else {
    stopPlaceholderP5();
    setSceneLoadStatus("loading");
    if (sceneFrameEl) {
      sceneFrameEl.hidden = false;
      sceneFrameEl.src = `scene-frame.html?scene=${encodeURIComponent(activeSceneFile)}`;
    }
  }

  buildMappingRows();
  suggestMappingCsvBasename();
  syncNdiSceneIfNeeded();
  window.dispatchEvent(new Event("resize"));
}

const WEBGL_SCENE_FILES = new Set(["MUSE.p5", "ENOBIO.p5", "head-cube.p5"]);

function isWebglSceneFile(file) {
  return Boolean(file && WEBGL_SCENE_FILES.has(file));
}

async function fetchNdiConfig() {
  const r = await fetch("/api/ndi-config");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  ndiConfig = j.config || j;
  return ndiConfig;
}

async function postNdiConfig(patch) {
  const r = await fetch("/api/ndi-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  ndiConfig = j.config || j;
  return ndiConfig;
}

function ndiEffectiveSceneFile() {
  if (!ndiConfig) return activeSceneFile || "";
  if (ndiConfig.syncSceneWithDashboard) return activeSceneFile || ndiConfig.sceneFile || "";
  return ndiConfig.sceneFile || activeSceneFile || "";
}

function setNdiPanelStatus(text) {
  if (ndiPanelStatusEl) ndiPanelStatusEl.textContent = text;
}

function setNdiStreamStatus(text, kind) {
  if (!ndiStreamStatusEl) return;
  ndiStreamStatusEl.textContent = text;
  ndiStreamStatusEl.classList.remove("is-warn", "is-ok");
  if (kind) ndiStreamStatusEl.classList.add(kind === "ok" ? "is-ok" : "is-warn");
}

async function syncNdiSceneIfNeeded() {
  if (!ndiConfig || !ndiConfig.enabled || !ndiConfig.syncSceneWithDashboard) return;
  const scene = activeSceneFile || "";
  if (scene === ndiConfig.sceneFile) return;
  try {
    await postNdiConfig({ sceneFile: scene });
  } catch (e) {
    setNdiStreamStatus(String(e && e.message ? e.message : e), "warn");
  }
}

function openNdiOutputWindow() {
  const features = "width=960,height=540,menubar=no,toolbar=no,location=no,status=no";
  if (ndiOutputWin && !ndiOutputWin.closed) {
    ndiOutputWin.focus();
    return ndiOutputWin;
  }
  ndiOutputWin = window.open("/ndi-output.html", "nt-ndi-output", features);
  if (!ndiOutputWin) {
    setNdiPanelStatus("Popup blocked — allow popups for this site, then click Open output window");
    return null;
  }
  return ndiOutputWin;
}

function readBridgeDraftFromDom() {
  const cards = ndiBridgeListEl ? ndiBridgeListEl.querySelectorAll(".ndi-bridge-card") : [];
  const bridges = [];
  cards.forEach((card, index) => {
    const get = (sel) => {
      const el = card.querySelector(sel);
      return el ? el.value : "";
    };
    bridges.push({
      id: get('[data-field="id"]') || `bridge-${index + 1}`,
      label: get('[data-field="label"]'),
      host: get('[data-field="host"]'),
      port: parseInt(get('[data-field="port"]'), 10),
      width: parseInt(get('[data-field="width"]'), 10),
      height: parseInt(get('[data-field="height"]'), 10),
      fps: parseInt(get('[data-field="fps"]'), 10),
      ndiName: get('[data-field="ndiName"]'),
    });
  });
  return bridges;
}

function renderNdiBridgeCards() {
  if (!ndiBridgeListEl || !ndiConfig) return;
  ndiBridgeListEl.textContent = "";
  for (const b of ndiConfig.bridges) {
    const card = document.createElement("div");
    card.className = "ndi-bridge-card";
    card.dataset.bridgeId = b.id;
    const title = document.createElement("div");
    title.className = "ndi-bridge-card__title";
    title.innerHTML = `<span>${b.label || b.id}</span>`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "ndi-panel__btn";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      if (!ndiConfig || ndiConfig.bridges.length <= 1) return;
      ndiConfig.bridges = ndiConfig.bridges.filter((x) => x.id !== b.id);
      renderNdiBridgeCards();
      renderNdiBridgeSelect();
    });
    title.appendChild(rm);
    card.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "ndi-bridge-card__grid";
    const fields = [
      ["id", "ID", b.id],
      ["label", "Label", b.label],
      ["host", "Host", b.host],
      ["port", "Port", b.port],
      ["width", "Width", b.width],
      ["height", "Height", b.height],
      ["fps", "FPS", b.fps],
      ["ndiName", "NDI name (ref)", b.ndiName],
    ];
    for (const [key, lab, val] of fields) {
      const wrap = document.createElement("div");
      const lbl = document.createElement("label");
      lbl.textContent = lab;
      const inp = document.createElement("input");
      inp.dataset.field = key;
      inp.value = val == null ? "" : String(val);
      if (key === "id") inp.readOnly = true;
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      grid.appendChild(wrap);
    }
    card.appendChild(grid);
    ndiBridgeListEl.appendChild(card);
  }
  if (ndiAddBridgeBtn) {
    ndiAddBridgeBtn.disabled = ndiConfig.bridges.length >= 2;
  }
}

function renderNdiBridgeSelect() {
  if (!ndiActiveBridgeEl || !ndiConfig) return;
  ndiActiveBridgeEl.textContent = "";
  for (const b of ndiConfig.bridges) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = `${b.label} (${b.width}x${b.height} @ :${b.port})`;
    if (b.id === ndiConfig.activeBridgeId) opt.selected = true;
    ndiActiveBridgeEl.appendChild(opt);
  }
}

function renderNdiSceneSelect() {
  if (!ndiSceneSelectEl || !ndiConfig) return;
  const sync = Boolean(ndiConfig.syncSceneWithDashboard);
  ndiSceneSelectEl.disabled = sync;
  ndiSceneSelectEl.textContent = "";
  for (const sc of sceneList) {
    const opt = document.createElement("option");
    opt.value = sc.file;
    opt.textContent = sc.title || sc.file;
    ndiSceneSelectEl.appendChild(opt);
  }
  const eff = ndiEffectiveSceneFile();
  if (eff) ndiSceneSelectEl.value = eff;
  if (ndiSceneHintEl) {
    if (sync) {
      ndiSceneHintEl.textContent = "Scene follows dashboard Scene tab.";
    } else {
      ndiSceneHintEl.textContent = "Pick NDI scene independently of dashboard preview.";
    }
  }
  if (eff && isWebglSceneFile(eff)) {
    setNdiStreamStatus("Warning: WEBGL scenes are not supported for NDI capture yet.", "warn");
  }
}

function applyNdiConfigToPanel() {
  if (!ndiConfig) return;
  if (ndiSyncSceneEl) ndiSyncSceneEl.checked = Boolean(ndiConfig.syncSceneWithDashboard);
  if (ndiEnableBtn) {
    ndiEnableBtn.textContent = ndiConfig.enabled ? "Disable NDI" : "Enable NDI";
  }
  renderNdiBridgeCards();
  renderNdiBridgeSelect();
  renderNdiSceneSelect();
  const bridge = ndiConfig.bridges.find((b) => b.id === ndiConfig.activeBridgeId);
  if (ndiConfig.enabled && bridge) {
    setNdiPanelStatus(`NDI on → ${bridge.label} (${bridge.width}x${bridge.height})`);
  } else if (ndiConfig.enabled) {
    setNdiPanelStatus("NDI enabled — register a bridge");
  } else {
    setNdiPanelStatus("NDI off — launch ndi-bridge on CLI, register preset, then enable");
  }
}

function onNdiConfigMessage(config) {
  ndiConfig = config;
  applyNdiConfigToPanel();
}

async function refreshNdiStreamStatus() {
  if (!ndiConfig) return;
  try {
    const r = await fetch("/api/ndi-status");
    if (!r.ok) return;
    const j = await r.json();
    const status = j.status || {};
    const bridge = ndiConfig.bridges.find((b) => b.id === ndiConfig.activeBridgeId);
    const st = bridge ? status[bridge.id] : null;
    if (!ndiConfig.enabled) {
      setNdiStreamStatus("");
      return;
    }
    if (!st) {
      setNdiStreamStatus("Output window not reporting — open output or enable NDI", "warn");
      return;
    }
    if (st.error) {
      setNdiStreamStatus(st.error, "warn");
      return;
    }
    if (st.wsOpen && st.framesSent > 0) {
      setNdiStreamStatus(`Streaming · ${st.framesSent} frames · ${st.sceneFile || "no scene"}`, "ok");
    } else if (st.wsOpen) {
      setNdiStreamStatus(
        "WS connected — no frames yet (check bridge CLI width/height/port matches registry)",
        "warn"
      );
    } else {
      setNdiStreamStatus("Frame WS not connected — is ndi-bridge running?", "warn");
    }
  } catch (_) {
    /* ignore */
  }
}

function startNdiStatusPoll() {
  if (ndiStatusPollTimer) clearInterval(ndiStatusPollTimer);
  ndiStatusPollTimer = setInterval(refreshNdiStreamStatus, 2500);
}

function setupNdiPanel() {
  if (!ndiEnableBtn) return;

  ndiEnableBtn.addEventListener("click", async () => {
    try {
      if (!ndiConfig) await fetchNdiConfig();
      const nextEnabled = !ndiConfig.enabled;
      if (nextEnabled) {
        const scene = ndiEffectiveSceneFile();
        if (scene && isWebglSceneFile(scene)) {
          setNdiPanelStatus("Cannot enable NDI for WEBGL scenes in Phase 1");
          return;
        }
        if (!ndiConfig.bridges.length) {
          setNdiPanelStatus("Add at least one bridge preset");
          return;
        }
        openNdiOutputWindow();
        if (ndiOutputWin && ndiOutputWin.closed) return;
      }
      const bridges = readBridgeDraftFromDom();
      await postNdiConfig({
        bridges: bridges.length ? bridges : ndiConfig.bridges,
        activeBridgeId: ndiActiveBridgeEl ? ndiActiveBridgeEl.value : ndiConfig.activeBridgeId,
        enabled: nextEnabled,
        syncSceneWithDashboard: ndiSyncSceneEl ? ndiSyncSceneEl.checked : true,
        sceneFile: ndiEffectiveSceneFile(),
      });
      applyNdiConfigToPanel();
    } catch (e) {
      setNdiPanelStatus(String(e && e.message ? e.message : e));
    }
  });

  ndiOpenOutputBtn.addEventListener("click", () => {
    openNdiOutputWindow();
  });

  ndiActiveBridgeEl.addEventListener("change", async () => {
    try {
      await postNdiConfig({ activeBridgeId: ndiActiveBridgeEl.value });
      applyNdiConfigToPanel();
    } catch (e) {
      setNdiStreamStatus(String(e && e.message ? e.message : e), "warn");
    }
  });

  ndiSyncSceneEl.addEventListener("change", async () => {
    try {
      const sync = ndiSyncSceneEl.checked;
      await postNdiConfig({
        syncSceneWithDashboard: sync,
        sceneFile: sync ? activeSceneFile : ndiSceneSelectEl.value,
      });
      applyNdiConfigToPanel();
    } catch (e) {
      setNdiStreamStatus(String(e && e.message ? e.message : e), "warn");
    }
  });

  ndiSceneSelectEl.addEventListener("change", async () => {
    if (ndiSyncSceneEl && ndiSyncSceneEl.checked) return;
    try {
      await postNdiConfig({ sceneFile: ndiSceneSelectEl.value });
      applyNdiConfigToPanel();
    } catch (e) {
      setNdiStreamStatus(String(e && e.message ? e.message : e), "warn");
    }
  });

  ndiSaveBridgesBtn.addEventListener("click", async () => {
    try {
      const bridges = readBridgeDraftFromDom();
      await postNdiConfig({
        bridges,
        activeBridgeId: ndiActiveBridgeEl ? ndiActiveBridgeEl.value : undefined,
      });
      applyNdiConfigToPanel();
      setNdiStreamStatus("Bridge presets saved", "ok");
    } catch (e) {
      setNdiStreamStatus(String(e && e.message ? e.message : e), "warn");
    }
  });

  ndiAddBridgeBtn.addEventListener("click", () => {
    if (!ndiConfig || ndiConfig.bridges.length >= 2) return;
    const n = ndiConfig.bridges.length + 1;
    ndiConfig.bridges.push({
      id: `bridge-${String.fromCharCode(96 + n)}`,
      label: `NDI preset ${n}`,
      host: "127.0.0.1",
      port: 8766 + n - 1,
      width: n === 2 ? 1280 : 1920,
      height: n === 2 ? 720 : 1080,
      fps: 30,
      ndiName: "",
    });
    renderNdiBridgeCards();
    renderNdiBridgeSelect();
  });
}

function setPanelMode(mode) {
  const isStreams = mode === "streams";
  const isScene = mode === "scene";
  const isNdi = mode === "ndi";
  if (modeStreamsBtn && modeSceneBtn && modeNdiBtn) {
    modeStreamsBtn.classList.toggle("is-active", isStreams);
    modeSceneBtn.classList.toggle("is-active", isScene);
    modeNdiBtn.classList.toggle("is-active", isNdi);
  }
  if (streamsModePanel && sceneModePanel && ndiModePanel) {
    streamsModePanel.classList.toggle("is-hidden", !isStreams);
    sceneModePanel.classList.toggle("is-hidden", !isScene);
    ndiModePanel.classList.toggle("is-hidden", !isNdi);
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
    if (s === "scene" || s === "streams" || s === "ndi") mode = s;
  } catch (_) {
    /* ignore */
  }
  setPanelMode(mode);
}

function migrateCollectiveSceneStorage() {
  try {
    if (localStorage.getItem(LS_ACTIVE_SCENE) === LEGACY_COLLECTIVE_FILE) {
      localStorage.setItem(LS_ACTIVE_SCENE, SPIDER_COLLECTIVE_FILE);
    }
    for (const key of [
      LS_MAPPINGS,
      LS_SPIDER_HEX,
      LS_SPIDER_DRAW,
      LS_SPIDER_RADIUS,
      LS_SPIDER_RADAR,
    ]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const o = JSON.parse(raw);
      if (typeof o !== "object" || o === null) continue;
      if (o[LEGACY_COLLECTIVE_FILE] && !o[SPIDER_COLLECTIVE_FILE]) {
        o[SPIDER_COLLECTIVE_FILE] = o[LEGACY_COLLECTIVE_FILE];
        localStorage.setItem(key, JSON.stringify(o));
      }
    }
  } catch (_) {
    /* ignore */
  }
}

function applySavedActiveScene() {
  migrateCollectiveSceneStorage();
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
    setSceneLoadStatus("loading");
    if (sceneFrameEl) {
      sceneFrameEl.hidden = false;
      sceneFrameEl.src = `scene-frame.html?scene=${encodeURIComponent(activeSceneFile)}`;
    }
  } else {
    setSceneLoadStatus("idle");
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
    if (msg.type === "ndi-config" && msg.config) {
      onNdiConfigMessage(msg.config);
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
  statusEl = document.getElementById("bannerStatus");
  oscBindEl = document.getElementById("bannerOscBind");
  toggleBtn = document.getElementById("toggleBanner");
  peekBtn = document.getElementById("peekBanner");
  bannerAside = document.getElementById("dataBanner");
  modeStreamsBtn = document.getElementById("modeStreams");
  modeSceneBtn = document.getElementById("modeScene");
  modeNdiBtn = document.getElementById("modeNdi");
  streamsModePanel = document.getElementById("streamsModePanel");
  sceneModePanel = document.getElementById("sceneModePanel");
  ndiModePanel = document.getElementById("ndiModePanel");
  ndiPanelStatusEl = document.getElementById("ndiPanelStatus");
  ndiSyncSceneEl = document.getElementById("ndiSyncScene");
  ndiEnableBtn = document.getElementById("ndiEnableBtn");
  ndiOpenOutputBtn = document.getElementById("ndiOpenOutputBtn");
  ndiActiveBridgeEl = document.getElementById("ndiActiveBridge");
  ndiSceneSelectEl = document.getElementById("ndiSceneSelect");
  ndiSceneHintEl = document.getElementById("ndiSceneHint");
  ndiBridgeListEl = document.getElementById("ndiBridgeList");
  ndiAddBridgeBtn = document.getElementById("ndiAddBridgeBtn");
  ndiSaveBridgesBtn = document.getElementById("ndiSaveBridgesBtn");
  ndiStreamStatusEl = document.getElementById("ndiStreamStatus");
  sceneButtonsEl = document.getElementById("sceneButtons");
  sceneStatusEl = document.getElementById("sceneStatus");
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
  if (modeNdiBtn) modeNdiBtn.addEventListener("click", () => setPanelMode("ndi"));
  setupNdiPanel();

  window.addEventListener("message", (e) => {
    if (e.origin !== window.location.origin) return;
    const data = e.data || {};
    if (data.type !== "nt-scene-status") return;
    if ((data.scene || "") !== activeSceneFile) return;
    setSceneLoadStatus(data.status, data.message);
  });
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
  try {
    await fetchNdiConfig();
    applyNdiConfigToPanel();
    startNdiStatusPoll();
  } catch (e) {
    setNdiPanelStatus("NDI config unavailable");
  }
}

init();
