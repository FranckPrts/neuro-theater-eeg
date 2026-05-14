#!/usr/bin/env node
/**
 * HTTP static server + WebSocket hub + OSC UDP listener.
 * Relays proxied OSC (e.g. from osc_proxy_failover.py on :7999) to connected browsers.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const osc = require("osc");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "public");
const MAP_ROOT = path.join(ROOT, "p5-mapping");

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
    oscPort: 7999,
    httpHost: "127.0.0.1",
    httpPort: 8765,
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
    } else if (a === "--help" || a === "-h") {
      console.log(`
Usage: node server.js [options]

  --osc-host 0.0.0.0     UDP bind address for OSC (default 0.0.0.0)
  --osc-port 7999       UDP port for OSC (default 7999)
  --http-host 127.0.0.1 HTTP + WebSocket bind (default 127.0.0.1)
  --http-port 8765      HTTP port (default 8765)
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

function main() {
  const opts = parseArgs(process.argv);

  const clients = new Set();

  const server = http.createServer((req, res) => {
    const u = url.parse(req.url || "/", true);
    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          wsClients: clients.size,
          oscHost: opts.oscHost,
          oscPort: opts.oscPort,
        })
      );
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

      const scenes = files.map((file) => {
        const r = regByFile.get(file);
        const base = {
          file,
          title: r && typeof r.title === "string" ? r.title : file.replace(/\.p5$/i, ""),
          inputs: Array.isArray(r && r.inputs) ? r.inputs : [],
        };
        if (file === "spider-plot.p5") {
          try {
            const src = fs.readFileSync(path.join(scenesDir, file), "utf8");
            base.spiderPlot = { plotCount: extractSpiderOverlayCount(src) };
          } catch (_) {
            base.spiderPlot = { plotCount: 1 };
          }
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

  const udpPort = new osc.UDPPort({
    localAddress: opts.oscHost,
    localPort: opts.oscPort,
    metadata: true,
  });

  udpPort.on("message", (oscMsg) => {
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
  });

  udpPort.on("error", (err) => {
    console.error("[OSC]", err.message);
  });

  udpPort.open();

  udpPort.on("ready", () => {
    console.log(`[OSC] listening udp://${opts.oscHost}:${opts.oscPort}`);
  });

  server.listen(opts.httpPort, opts.httpHost, () => {
    console.log(`[HTTP] http://${opts.httpHost}:${opts.httpPort}/`);
    console.log(`[WS]   ws://${opts.httpHost}:${opts.httpPort}/ws`);
  });

  function shutdown() {
    try {
      udpPort.close();
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
