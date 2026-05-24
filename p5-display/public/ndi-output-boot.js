/**
 * NDI output page: config from server, OSC /ws, scene load + hot reload, frame capture.
 */
window.data = window.data || {};

const LS_MAPPINGS = "nt.p5osc.mappings";
const LS_SPIDER_HEX = "nt.p5osc.spiderHex";
const LS_SPIDER_DRAW = "nt.p5osc.spiderDrawOverlays";
const LS_SPIDER_RADIUS = "nt.p5osc.spiderRadius";
const LS_SPIDER_DATA_LINES = "nt.p5osc.spiderDataLines";
const LS_SPIDER_RADAR = "nt.p5osc.spiderRadar";
const LS_SIGNAL_VIEW = "nt.p5osc.signalView";

const SPIDER_STREAM_GROUPED_FILES = new Set([
  "spider-plot-neon-streams.p5",
  "spider-plot-collective.p5",
]);
const SPIDER_COLLECTIVE_FILE = "spider-plot-collective.p5";
const LEGACY_COLLECTIVE_FILE = "spider-plot-alpha-radar.p5";

const latestByAddress = {};
/** @type {object[]} */
let sceneRegistry = [];
/** @type {object|null} */
let activeScene = null;
/** @type {string} */
let loadedSceneFile = "";
/** @type {object|null} */
let currentConfig = null;
/** @type {WebSocket|null} */
let oscWs = null;

function wsUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function isDeviceStreamAddress(address) {
  if (!address || address[0] !== "/" || address.startsWith("/nt/")) return false;
  const parts = address.split("/").filter(Boolean);
  return parts.length >= 2;
}

function parseOscAddressParts(address) {
  if (!isDeviceStreamAddress(address)) return null;
  const parts = String(address).split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { prefix: parts[0], suffix: parts.slice(1).join("/") };
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

function normalizeSpiderDataLineDisplay(value) {
  const v = String(value || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return v === "powerbands" || v === "powerbandaxes" ? "powerBands" : "electrodes";
}

function readSpiderDataLineDisplay(sceneFile) {
  try {
    const raw = localStorage.getItem(LS_SPIDER_DATA_LINES);
    const o = raw ? JSON.parse(raw) : {};
    return normalizeSpiderDataLineDisplay(o[sceneFile]);
  } catch (_) {
    return "electrodes";
  }
}

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

function branchLabelFromMaps(maps, branchIndex) {
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

function inputValueType(input) {
  const t = String(input?.type || input?.valueType || "")
    .trim()
    .toLowerCase();
  return t === "bool" || t === "boolean" ? "bool" : "osc";
}

function parseBoolValue(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
  }
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function defaultBoolValue(input) {
  return parseBoolValue(input?.default, false);
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
  const scene = activeScene;
  if (!scene) return {};
  const sceneFile = scene.file;

  const spiderN = getSpiderPlotCount(scene);
  if (spiderN > 0) {
    const allMaps = readMappings();
    const maps = allMaps[sceneFile] || {};
    const branchN = getSpiderBranchCount(scene);
    const out = {};
    const railN = spiderN;
    const drawN = Math.max(1, Math.min(railN, readSpiderDrawCount(sceneFile, railN)));
    out.__plotCount = drawN;
    out.__branchCount = branchN;
    const rad = readSpiderRadiusAll(sceneFile);
    out.__radiusMode = rad.mode;
    out.__absoluteMean = rad.mean;
    out.__absoluteMax = rad.max;
    if (!isSpiderStreamGroupedScene(scene)) {
      out.__dataLineDisplay = readSpiderDataLineDisplay(sceneFile);
    }
    if (isSpiderStreamGroupedScene(scene)) {
      if (isSpiderCollectiveScene(scene)) {
        const labels = branchLabelsForCollectivePlot(maps, branchN, drawN);
        for (let a = 0; a < branchN; a++) {
          out[`__branchLabel_${a}`] = labels[a];
        }
      } else {
        for (let a = 0; a < branchN; a++) {
          out[`__branchLabel_${a}`] = branchLabelFromMaps(maps, a);
        }
      }
    }
    if (isSpiderCollectiveScene(scene)) {
      const radar = readSpiderRadar(sceneFile);
      out.__sweepEnabled = radar.sweepEnabled;
      out.__trailDecayMs = radar.trailDecayMs;
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
    const hexPer = readSpiderHex()[sceneFile] || {};
    for (let p = 0; p < railN; p++) {
      const c = hexPer[String(p)];
      if (c) out[`plot_${p}_color`] = c;
    }
    return out;
  }

  if (!Array.isArray(scene.inputs) || !scene.inputs.length) return {};
  const allMaps = readMappings();
  const maps = allMaps[sceneFile] || {};
  const out = {};
  if (isSignalViewScene(scene)) {
    const sv = readSignalViewSettings(sceneFile);
    out.__historyLength = sv.historyLength;
    out.__scrollSpeed = sv.scrollSpeed;
  }
  for (const inp of scene.inputs) {
    if (inputValueType(inp) === "bool") {
      out[inp.id] = parseBoolValue(maps[inp.id], defaultBoolValue(inp));
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

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function connectOscWs() {
  if (oscWs && oscWs.readyState === WebSocket.OPEN) return;
  try {
    oscWs = new WebSocket(wsUrl());
  } catch (e) {
    setStatus(`OSC WS error: ${e.message || e}`);
    setTimeout(connectOscWs, 2000);
    return;
  }
  oscWs.onopen = () => {
    if (currentConfig && currentConfig.enabled) {
      setStatus(`OSC live · NDI enabled`);
    } else {
      setStatus(`OSC live · NDI disabled`);
    }
  };
  oscWs.onclose = () => {
    setTimeout(connectOscWs, 2000);
  };
  oscWs.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (msg.type === "ndi-config" && msg.config) {
      applyServerConfig(msg.config);
      return;
    }
    if (msg.type !== "osc" || !msg.address) return;
    latestByAddress[msg.address] = msg;
  };
}

function startDataPump() {
  function tick() {
    requestAnimationFrame(tick);
    window.data = buildSceneData();
  }
  requestAnimationFrame(tick);
}

function activeBridgeFromConfig(config) {
  if (!config || !Array.isArray(config.bridges)) return null;
  return config.bridges.find((b) => b.id === config.activeBridgeId) || config.bridges[0] || null;
}

function lockWindowResizedForBridge(bridge) {
  if (!bridge) return;
  const w = Math.max(320, parseInt(String(bridge.width), 10) || 1920);
  const h = Math.max(240, parseInt(String(bridge.height), 10) || 1080);
  window.windowResized = function ntNdiLockedWindowResized() {
    if (window.__ntSceneP5 && typeof window.__ntSceneP5.resizeCanvas === "function") {
      window.__ntSceneP5.resizeCanvas(w, h);
    }
  };
}

async function loadScene(sceneFile) {
  if (!sceneFile || !/^[a-zA-Z0-9._-]+\.p5$/.test(sceneFile)) return;
  setStatus("Loading " + sceneFile);
  const url = "p5-scenes/" + encodeURIComponent(sceneFile);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load scene: HTTP " + res.status);

  for (const s of document.querySelectorAll("script[data-nt-scene]")) {
    s.remove();
  }
  delete window.setup;
  delete window.draw;
  delete window.preload;

  const code = await res.text();
  const blob = new Blob([code], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.setAttribute("data-nt-scene", sceneFile);
    s.src = blobUrl;
    s.onload = () => {
      URL.revokeObjectURL(blobUrl);
      resolve();
    };
    s.onerror = () => reject(new Error("Scene script error"));
    document.head.appendChild(s);
  });

  if (typeof window.setup === "function" || typeof window.draw === "function") {
    try {
      if (window.__ntSceneP5 && typeof window.__ntSceneP5.remove === "function") {
        window.__ntSceneP5.remove();
      }
    } catch (_) {
      /* ignore */
    }
    window.__ntSceneP5 = new p5();
    if (typeof window.__ntNdiAttachCapture === "function") {
      window.__ntNdiAttachCapture(window.__ntSceneP5);
    }
  }
  loadedSceneFile = sceneFile;
  activeScene = sceneRegistry.find((s) => s.file === sceneFile) || { file: sceneFile, inputs: [] };
}

let configApplySerial = Promise.resolve();
let configApplyToken = 0;

function applyServerConfig(config) {
  const token = ++configApplyToken;
  configApplySerial = configApplySerial.then(() => applyServerConfigInner(config, token));
  return configApplySerial;
}

async function applyServerConfigInner(config, token) {
  currentConfig = config;
  const bridge = activeBridgeFromConfig(config);
  const sceneFile = config.sceneFile || "";

  if (!config.enabled) {
    if (typeof window.__ntNdiApplyRuntimeConfig === "function") {
      window.__ntNdiApplyRuntimeConfig({
        enabled: false,
        bridge: bridge || undefined,
        sceneFile,
      });
    }
    setStatus("NDI disabled — waiting for enable from dashboard");
    return;
  }

  if (!bridge) {
    setStatus("No bridge registered — add one in dashboard NDI tab");
    return;
  }

  if (!sceneFile) {
    setStatus(`NDI enabled · ${bridge.label} — waiting for scene`);
    return;
  }

  if (sceneFile !== loadedSceneFile) {
    try {
      await loadScene(sceneFile);
    } catch (err) {
      setStatus(String(err && err.message ? err.message : err));
      return;
    }
  }

  if (token !== configApplyToken) return;

  lockWindowResizedForBridge(bridge);

  if (window.__ntSceneP5 && bridge) {
    window.__ntSceneP5.resizeCanvas(bridge.width, bridge.height);
    if (typeof window.__ntNdiAttachCapture === "function") {
      window.__ntNdiAttachCapture(window.__ntSceneP5);
    }
  }

  if (typeof window.__ntNdiApplyRuntimeConfig === "function") {
    window.__ntNdiApplyRuntimeConfig({
      enabled: true,
      bridge,
      sceneFile,
    });
  }

  if (token !== configApplyToken) return;
  setStatus(`${sceneFile} → ${bridge.label} (${bridge.width}x${bridge.height})`);
}

async function fetchRegistry() {
  const reg = await fetch("/api/p5-scenes");
  const regJson = await reg.json();
  sceneRegistry = Array.isArray(regJson.scenes) ? regJson.scenes : [];
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("visible") === "1") {
    document.getElementById("status").style.opacity = "1";
  }

  connectOscWs();
  startDataPump();
  await fetchRegistry();

  let config;
  try {
    const res = await fetch("/api/ndi-config");
    const json = await res.json();
    config = json.config || json;
  } catch (e) {
    setStatus("Failed to load NDI config");
    return;
  }

  await applyServerConfig(config);
}

main().catch((err) => {
  console.error(err);
  setStatus(String(err && err.message ? err.message : err));
});
