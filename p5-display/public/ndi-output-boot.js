/**
 * NDI output page: load one p5 scene, subscribe to OSC /ws, drive window.data, attach frame capture.
 */
window.data = window.data || {};

const LS_MAPPINGS = "nt.p5osc.mappings";
const LS_SPIDER_HEX = "nt.p5osc.spiderHex";
const LS_SPIDER_DRAW = "nt.p5osc.spiderDrawOverlays";
const LS_SPIDER_RADIUS = "nt.p5osc.spiderRadius";
const LS_SPIDER_DATA_LINES = "nt.p5osc.spiderDataLines";

const latestByAddress = {};

/** @type {object|null} */
let activeScene = null;

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
  return Boolean(scene && scene.file === "spider-plot-neon-streams.p5");
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

function branchLabelFromMaps(maps, branchIndex) {
  for (let p = 0; p < 12; p++) {
    const parsed = parseOscAddressParts(maps[`plot_${p}_axis_${branchIndex}`]);
    if (parsed && parsed.prefix) return parsed.prefix;
  }
  return `Branch ${branchIndex + 1}`;
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
      for (let a = 0; a < branchN; a++) {
        out[`__branchLabel_${a}`] = branchLabelFromMaps(maps, a);
      }
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
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    setStatus(`OSC WS error: ${e.message || e}`);
    setTimeout(connectOscWs, 2000);
    return;
  }
  ws.onopen = () => setStatus(`OSC live · ${wsUrl()}`);
  ws.onclose = () => {
    setStatus("OSC WS closed — retrying");
    setTimeout(connectOscWs, 2000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
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

async function loadScene(sceneFile) {
  const url = "p5-scenes/" + encodeURIComponent(sceneFile);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load scene: HTTP " + res.status);
  const code = await res.text();
  const blob = new Blob([code], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
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
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  const sceneFile = params.get("scene") || "";
  if (!sceneFile || !/^[a-zA-Z0-9._-]+\.p5$/.test(sceneFile)) {
    setStatus("Missing ?scene=… query param");
    return;
  }

  const cfg = window.__ntNdiCapture || { width: 1920, height: 1080 };
  document.documentElement.style.width = cfg.width + "px";
  document.documentElement.style.height = cfg.height + "px";
  document.body.style.width = cfg.width + "px";
  document.body.style.height = cfg.height + "px";

  connectOscWs();
  startDataPump();

  setStatus("Loading scene " + sceneFile);
  const reg = await fetch("/api/p5-scenes");
  const regJson = await reg.json();
  const scenes = Array.isArray(regJson.scenes) ? regJson.scenes : [];
  activeScene = scenes.find((s) => s.file === sceneFile) || { file: sceneFile, inputs: [] };

  await loadScene(sceneFile);
  setStatus(`Scene ${sceneFile} · configure mappings in operator UI if needed`);
}

main().catch((err) => {
  console.error(err);
  setStatus(String(err && err.message ? err.message : err));
});
