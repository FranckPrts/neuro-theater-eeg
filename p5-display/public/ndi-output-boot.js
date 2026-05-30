/**
 * NDI output page: config from server, OSC /ws, scene load + hot reload, frame capture.
 */
window.data = window.data || {};

const { buildSceneData } = window.NtSceneData;

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
    window.data = buildSceneData(activeScene, latestByAddress);
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
