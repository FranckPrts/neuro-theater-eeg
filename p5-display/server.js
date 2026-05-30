#!/usr/bin/env node
/**
 * HTTP static server + WebSocket hub + OSC UDP listener.
 * Relays proxied OSC (e.g. LAN broadcast from osc_proxy_failover.py to :8000) to browsers.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const osc = require("osc");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "public");
const MAP_ROOT = path.join(ROOT, "p5-mapping");

const MAX_NDI_BRIDGES = 2;

function resolveNdiConfigPath(httpPort) {
  const portFile = path.join(__dirname, `ndi-config-${httpPort}.json`);
  const legacy = path.join(__dirname, "ndi-config.json");
  if (httpPort === 8765 && fs.existsSync(legacy) && !fs.existsSync(portFile)) return legacy;
  return portFile;
}

function defaultNdiConfig() {
  return {
    bridges: [
      {
        id: "bridge-a",
        label: "NDI 1080p",
        host: "127.0.0.1",
        port: 8766,
        width: 1920,
        height: 1080,
        fps: 30,
        ndiName: "",
      },
    ],
    activeBridgeId: "bridge-a",
    enabled: false,
    sceneFile: "",
    syncSceneWithDashboard: true,
  };
}

/** @type {Record<string, object>} */
let ndiStatusByBridge = {};

function sanitizeBridgeId(id) {
  const s = String(id || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  return s || "bridge";
}

function normalizeBridge(b, index) {
  const id = sanitizeBridgeId(b.id || `bridge-${index + 1}`);
  const port = typeof b.port === "number" ? b.port : parseInt(String(b.port), 10);
  const width = typeof b.width === "number" ? b.width : parseInt(String(b.width), 10);
  const height = typeof b.height === "number" ? b.height : parseInt(String(b.height), 10);
  const fps = typeof b.fps === "number" ? b.fps : parseInt(String(b.fps), 10);
  return {
    id,
    label: String(b.label || id).trim() || id,
    host: String(b.host || "127.0.0.1").trim() || "127.0.0.1",
    port: Number.isFinite(port) ? port : 8766,
    width: Number.isFinite(width) ? Math.max(320, Math.min(3840, width)) : 1920,
    height: Number.isFinite(height) ? Math.max(240, Math.min(2160, height)) : 1080,
    fps: Number.isFinite(fps) ? Math.max(1, Math.min(60, fps)) : 30,
    ndiName: String(b.ndiName || "").trim(),
  };
}

function loadNdiConfigFromDisk(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return mergeNdiConfig(defaultNdiConfig(), parsed);
  } catch (_) {
    return defaultNdiConfig();
  }
}

function mergeNdiConfig(base, patch) {
  const out = { ...base };
  if (patch && typeof patch === "object") {
    if (Array.isArray(patch.bridges)) {
      out.bridges = patch.bridges.slice(0, MAX_NDI_BRIDGES).map((b, i) => normalizeBridge(b, i));
    }
    if (typeof patch.activeBridgeId === "string") out.activeBridgeId = sanitizeBridgeId(patch.activeBridgeId);
    if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
    if (typeof patch.sceneFile === "string") out.sceneFile = patch.sceneFile;
    if (typeof patch.syncSceneWithDashboard === "boolean") {
      out.syncSceneWithDashboard = patch.syncSceneWithDashboard;
    }
  }
  if (!out.bridges.length) out.bridges = defaultNdiConfig().bridges;
  if (!out.bridges.some((b) => b.id === out.activeBridgeId)) {
    out.activeBridgeId = out.bridges[0].id;
  }
  const ports = new Set();
  for (const b of out.bridges) {
    if (!isValidUdpPort(b.port)) b.port = 8766;
    if (ports.has(b.port)) {
      b.port = 8766 + ports.size;
    }
    ports.add(b.port);
  }
  if (out.sceneFile && !/^[a-zA-Z0-9._-]+\.p5$/.test(out.sceneFile)) out.sceneFile = "";
  return out;
}

function persistNdiConfig(config, configPath) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    console.warn("[NDI] could not persist config:", e && e.message ? e.message : e);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function ensureMapDir() {
  try {
    fs.mkdirSync(MAP_ROOT, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

/** Safe single-segment .csv basename for p5-mapping writes. */
function sanitizeMappingBasename(name) {
  let base = String(name || "").trim();
  base = path.basename(base);
  base = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (!base || base === "." || base === "..") base = "mapping";
  if (!base.toLowerCase().endsWith(".csv")) base += ".csv";
  return base;
}

function safeResolveMappingFile(segment) {
  const base = sanitizeMappingBasename(segment || "mapping");
  const resolved = path.normalize(path.join(MAP_ROOT, base));
  if (!resolved.startsWith(MAP_ROOT)) return null;
  if (path.basename(resolved) !== base) return null;
  return resolved;
}

function parseArgs(argv) {
  const out = {
    oscHost: "0.0.0.0",
    oscPort: 8000,
    httpHost: "0.0.0.0",
    httpPort: 8765,
    oscBindOnStart: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--osc-host" && argv[i + 1]) {
      out.oscHost = argv[++i];
    } else if (a === "--osc-port" && argv[i + 1]) {
      out.oscPort = parseInt(argv[++i], 10);
    } else if (a === "--http-host" && argv[i + 1]) {
      out.httpHost = argv[++i];
    } else if (a === "--http-port" && argv[i + 1]) {
      out.httpPort = parseInt(argv[++i], 10);
    } else if (a === "--osc-bind-on-start") {
      out.oscBindOnStart = true;
    } else if (a === "--help" || a === "-h") {
      console.log(`
Usage: node server.js [options]

  --osc-host 0.0.0.0     UDP bind for OSC (default 0.0.0.0; receives LAN broadcast on --osc-port)
  --osc-port 8000        Default OSC UDP port for UI Apply / auto-bind (default 8000)
  --http-host 0.0.0.0    HTTP + WebSocket bind (default 0.0.0.0 for LAN browsers)
  --http-port 8765       HTTP port (default 8765)
  --osc-bind-on-start    Bind OSC UDP at process start (default: defer until UI Apply)
`);
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.oscPort) || out.oscPort < 1 || out.oscPort > 65535) {
    throw new Error("Invalid --osc-port");
  }
  if (!Number.isFinite(out.httpPort) || out.httpPort < 1 || out.httpPort > 65535) {
    throw new Error("Invalid --http-port");
  }
  return out;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".p5": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
  };
  return map[ext] || "application/octet-stream";
}

function safeResolvePublic(reqPath) {
  const decoded = decodeURIComponent(reqPath.split("?")[0] || "/");
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.normalize(path.join(ROOT, rel));
  if (!resolved.startsWith(ROOT)) {
    return null;
  }
  return resolved;
}

function serializeOscArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map((a) => {
    if (a === null || a === undefined) return null;
    if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") return a;
    if (typeof a === "bigint") return Number(a);
    if (Buffer.isBuffer(a)) return a.toString("base64");
    if (typeof a === "object" && a !== null && "value" in a) return a.value;
    return String(a);
  });
}

function parseAddressParts(address) {
  const parts = address.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return { hardware: parts[0], stream: parts.slice(1).join("/") };
  }
  return { hardware: null, stream: parts.join("/") || null };
}

/** @param {number} port */
function isValidUdpPort(port) {
  return Number.isFinite(port) && port >= 1 && port <= 65535;
}

/**
 * Close an osc UDPPort if present.
 * @param {any} p
 */
function closeOscUdpPort(p) {
  if (!p) return;
  try {
    p.close();
  } catch (_) {
    /* ignore */
  }
}

/**
 * Open UDP OSC listener; resolves when port is ready.
 * @param {string} oscHost
 * @param {number} oscPort
 * @param {(payload: object) => void} broadcast
 * @param {number} [readyMs]
 */
function openOscUdpPort(oscHost, oscPort, broadcast, readyMs = 8000) {
  return new Promise((resolve, reject) => {
    const p = new osc.UDPPort({
      localAddress: oscHost,
      localPort: oscPort,
      metadata: true,
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      closeOscUdpPort(p);
      reject(new Error("OSC bind timed out"));
    }, readyMs);

    function onMessage(oscMsg) {
      const address = oscMsg.address;
      const args = serializeOscArgs(oscMsg.args);
      const { hardware, stream } = parseAddressParts(address);
      broadcast({
        type: "osc",
        address,
        hardware,
        stream,
        args,
        receivedAt: Date.now(),
      });
    }

    function onError(err) {
      console.error("[OSC]", err && err.message ? err.message : err);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        closeOscUdpPort(p);
        reject(err);
      }
    }

    function onReady() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(p);
    }

    p.on("message", onMessage);
    p.on("error", onError);
    p.once("ready", onReady);

    try {
      p.open();
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        closeOscUdpPort(p);
        reject(e);
      }
    }
  });
}

function main() {
  const opts = parseArgs(process.argv);
  const ndiConfigPath = resolveNdiConfigPath(opts.httpPort);

  const clients = new Set();
  /** @type {any} */
  let udpPort = null;
  /** @type {null | ((port: number) => Promise<{ oscHost: string; oscPort: number }>)} */
  let rebindOscPort = null;
  /** @type {ReturnType<typeof defaultNdiConfig>} */
  let ndiConfig = loadNdiConfigFromDisk(ndiConfigPath);
  /** @type {((payload: object) => void) | null} */
  let broadcastRef = null;

  function broadcastNdiConfig() {
    if (broadcastRef) {
      broadcastRef({ type: "ndi-config", config: ndiConfig });
    }
  }

  const server = http.createServer((req, res) => {
    const u = url.parse(req.url || "/", true);
    const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

    if (u.pathname === "/health") {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          ok: true,
          wsClients: clients.size,
          oscHost: opts.oscHost,
          oscPort: opts.oscPort,
          oscListening: Boolean(udpPort),
          ndi: {
            outputPage: "/ndi-output.html",
            enabled: ndiConfig.enabled,
            activeBridgeId: ndiConfig.activeBridgeId,
            bridgeCount: ndiConfig.bridges.length,
            sceneFile: ndiConfig.sceneFile,
          },
        })
      );
      return;
    }

    if (u.pathname === "/api/ndi-config" && req.method === "GET") {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ ok: true, config: ndiConfig }));
      return;
    }

    if (u.pathname === "/api/ndi-config" && req.method === "POST") {
      readJsonBody(req)
        .then((body) => {
          ndiConfig = mergeNdiConfig(ndiConfig, body);
          persistNdiConfig(ndiConfig, ndiConfigPath);
          broadcastNdiConfig();
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify({ ok: true, config: ndiConfig }));
        })
        .catch((e) => {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        });
      return;
    }

    if (u.pathname === "/api/ndi-status" && req.method === "GET") {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ ok: true, status: ndiStatusByBridge }));
      return;
    }

    if (u.pathname === "/api/ndi-status" && req.method === "POST") {
      readJsonBody(req)
        .then((body) => {
          const bridgeId = sanitizeBridgeId(body.bridgeId || "unknown");
          ndiStatusByBridge[bridgeId] = {
            bridgeId,
            wsOpen: Boolean(body.wsOpen),
            framesSent: typeof body.framesSent === "number" ? body.framesSent : 0,
            lastFrameAt: typeof body.lastFrameAt === "number" ? body.lastFrameAt : 0,
            sceneFile: String(body.sceneFile || ""),
            error: String(body.error || ""),
            updatedAt: Date.now(),
          };
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((e) => {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        });
      return;
    }

    if (u.pathname === "/api/osc-port" && req.method === "POST") {
      const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        let portNum;
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = raw.trim() ? JSON.parse(raw) : {};
          const p = body.port;
          portNum = typeof p === "number" ? p : parseInt(String(p), 10);
        } catch (_) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          return;
        }
        if (!isValidUdpPort(portNum)) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: "Invalid port (use 1–65535)" }));
          return;
        }
        if (!rebindOscPort) {
          res.writeHead(503, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: "OSC listener not ready" }));
          return;
        }
        try {
          const result = await rebindOscPort(portNum);
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          res.writeHead(500, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      });
      req.on("error", () => {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Bad request" }));
      });
      return;
    }

    if (u.pathname === "/api/p5-scenes") {
      const scenesDir = path.join(ROOT, "p5-scenes");
      let registry = { scenes: [] };
      try {
        const regPath = path.join(scenesDir, "registry.json");
        registry = JSON.parse(fs.readFileSync(regPath, "utf8"));
      } catch (_) {
        /* missing or invalid registry */
      }
      const regByFile = new Map(
        (Array.isArray(registry.scenes) ? registry.scenes : []).map((s) => [s.file, s])
      );
      let files = [];
      try {
        files = fs
          .readdirSync(scenesDir)
          .filter((f) => f.endsWith(".p5"))
          .sort();
      } catch (_) {
        files = [];
      }

      function extractSpiderOverlayCount(src) {
        const m = String(src).match(/\bNUM_OVERLAY_PLOTS\s*=\s*(\d+)\s*;/);
        if (!m) return 1;
        const n = parseInt(m[1], 10);
        if (!Number.isFinite(n)) return 1;
        return Math.max(1, Math.min(12, n));
      }

      function extractSpiderBranchCount(src) {
        const m = String(src).match(/\bNUM_SPIDER_BRANCHES\s*=\s*(\d+)\s*;/);
        if (!m) return 5;
        const n = parseInt(m[1], 10);
        if (!Number.isFinite(n)) return 5;
        return Math.max(3, Math.min(16, n));
      }

      const scenes = files.map((file) => {
        const r = regByFile.get(file);
        const base = {
          file,
          title: r && typeof r.title === "string" ? r.title : file.replace(/\.p5$/i, ""),
          inputs: Array.isArray(r && r.inputs) ? r.inputs : [],
          favorite: Boolean(r && r.favorite),
        };
        try {
          const src = fs.readFileSync(path.join(scenesDir, file), "utf8");
          if (/\bNUM_OVERLAY_PLOTS\s*=\s*\d+\s*;/.test(src)) {
            base.spiderPlot = {
              plotCount: extractSpiderOverlayCount(src),
              branchCount: extractSpiderBranchCount(src),
            };
          }
        } catch (_) {
          /* ignore unreadable scenes */
        }
        return base;
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ scenes }));
      return;
    }

    if (u.pathname === "/api/p5-mappings" && req.method === "GET") {
      ensureMapDir();
      let files = [];
      try {
        files = fs
          .readdirSync(MAP_ROOT)
          .filter((f) => f.toLowerCase().endsWith(".csv"))
          .sort();
      } catch (_) {
        files = [];
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ files }));
      return;
    }

    const mapGet = u.pathname.match(/^\/api\/p5-mappings\/([^/]+)$/);
    if (mapGet && req.method === "GET") {
      let seg = mapGet[1];
      try {
        seg = decodeURIComponent(seg);
      } catch (_) {
        /* keep raw */
      }
      const filePath = safeResolveMappingFile(seg);
      if (!filePath) {
        res.writeHead(400);
        res.end("Bad filename");
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(err.code === "ENOENT" ? 404 : 500);
          res.end(err.code === "ENOENT" ? "Not found" : String(err));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
        res.end(data);
      });
      return;
    }

    const mapPost = u.pathname.match(/^\/api\/p5-mappings\/([^/]+)$/);
    if (mapPost && req.method === "POST") {
      let seg = mapPost[1];
      try {
        seg = decodeURIComponent(seg);
      } catch (_) {
        /* keep raw */
      }
      const filePath = safeResolveMappingFile(seg);
      if (!filePath) {
        res.writeHead(400);
        res.end("Bad filename");
        return;
      }
      ensureMapDir();
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        fs.writeFile(filePath, body, (err) => {
          if (err) {
            res.writeHead(500);
            res.end(String(err));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, file: path.basename(filePath) }));
        });
      });
      req.on("error", () => {
        res.writeHead(400);
        res.end("Bad request");
      });
      return;
    }

    const filePath = safeResolvePublic(u.pathname || "/");
    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(err.code === "ENOENT" ? 404 : 500);
        res.end(err.code === "ENOENT" ? "Not found" : String(err));
        return;
      }
      res.writeHead(200, { "Content-Type": mimeType(filePath) });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    try {
      ws.send(JSON.stringify({ type: "ndi-config", config: ndiConfig }));
    } catch (_) {
      /* ignore */
    }
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  function broadcast(payload) {
    const s = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(s);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  broadcastRef = broadcast;

  rebindOscPort = async function rebindOscPortFn(newPort) {
    if (newPort === opts.oscPort && udpPort) {
      return { oscHost: opts.oscHost, oscPort: opts.oscPort, oscListening: true };
    }
    const wasListening = Boolean(udpPort);
    const prevPort = wasListening ? opts.oscPort : null;
    closeOscUdpPort(udpPort);
    udpPort = null;
    try {
      udpPort = await openOscUdpPort(opts.oscHost, newPort, broadcast);
      opts.oscPort = newPort;
      console.log(`[OSC] listening udp://${opts.oscHost}:${opts.oscPort}`);
      return { oscHost: opts.oscHost, oscPort: opts.oscPort, oscListening: true };
    } catch (e) {
      if (wasListening && prevPort != null && prevPort !== newPort) {
        try {
          udpPort = await openOscUdpPort(opts.oscHost, prevPort, broadcast);
          opts.oscPort = prevPort;
          console.warn(
            `[OSC] rebind failed (${e && e.message ? e.message : e}); reverted to udp://${opts.oscHost}:${opts.oscPort}`
          );
          return { oscHost: opts.oscHost, oscPort: opts.oscPort, oscListening: true };
        } catch (e2) {
          console.error("[OSC] could not restore previous UDP bind:", e2 && e2.message ? e2.message : e2);
        }
      }
      throw e;
    }
  };

  (async () => {
    if (opts.oscBindOnStart) {
      try {
        await rebindOscPort(opts.oscPort);
      } catch (e) {
        console.error("[OSC] initial bind failed:", e && e.message ? e.message : e);
        process.exit(1);
      }
    } else {
      console.log(
        `[OSC] deferred — not listening until UI Apply (default port ${opts.oscPort} on ${opts.oscHost})`
      );
    }
    server.listen(opts.httpPort, opts.httpHost, () => {
      console.log(`[HTTP] http://${opts.httpHost}:${opts.httpPort}/`);
      console.log(`[WS]   ws://${opts.httpHost}:${opts.httpPort}/ws`);
      console.log(`[NDI]  config → ${path.basename(ndiConfigPath)}`);
    });
  })();

  function shutdown() {
    try {
      closeOscUdpPort(udpPort);
    } catch (_) {
      /* ignore */
    }
    try {
      wss.close();
    } catch (_) {
      /* ignore */
    }
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
