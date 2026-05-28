#!/usr/bin/env node
/**
 * WebSocket RGBA frame receiver -> NDI sender (fixed output clock).
 *
 * Frame wire format (binary):
 *   uint32 LE width
 *   uint32 LE height
 *   uint8 format (0 = RGBA)
 *   raw RGBA bytes (width * height * 4)
 */

const os = require("os");
const { WebSocketServer } = require("ws");
const { NdiVideoSender } = require("./ndi-sender");

const FORMAT_RGBA = 0;

function parseArgs(argv) {
  const out = {
    name: `NeuroTheater (${os.hostname()})`,
    host: "127.0.0.1",
    port: 8766,
    width: 1920,
    height: 1080,
    fps: 30,
    groups: "Public",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name" && argv[i + 1]) out.name = argv[++i];
    else if (a === "--host" && argv[i + 1]) out.host = argv[++i];
    else if (a === "--port" && argv[i + 1]) out.port = parseInt(argv[++i], 10);
    else if (a === "--width" && argv[i + 1]) out.width = parseInt(argv[++i], 10);
    else if (a === "--height" && argv[i + 1]) out.height = parseInt(argv[++i], 10);
    else if (a === "--fps" && argv[i + 1]) out.fps = parseInt(argv[++i], 10);
    else if (a === "--groups" && argv[i + 1]) out.groups = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage: node src/bridge.js [options]

  --name "NeuroTheater p5"   NDI source name (default: NeuroTheater (<hostname>))
  --host 127.0.0.1           WebSocket bind host
  --port 8766                WebSocket port for browser frames
  --width 1920               Expected frame width
  --height 1080              Expected frame height
  --fps 30                   NDI output frame rate
  --groups Public            NDI send groups (default Public; use Public,NeuroTheater for both)
`);
      process.exit(0);
    }
  }
  return out;
}

function parseFrameMessage(buf, expectedW, expectedH) {
  if (!Buffer.isBuffer(buf) || buf.length < 9) return null;
  const w = buf.readUInt32LE(0);
  const h = buf.readUInt32LE(4);
  const format = buf.readUInt8(8);
  if (format !== FORMAT_RGBA) return null;
  const payloadLen = w * h * 4;
  if (buf.length !== 9 + payloadLen) return null;
  if (w !== expectedW || h !== expectedH) return null;
  return buf.subarray(9, 9 + payloadLen);
}

async function main() {
  const opts = parseArgs(process.argv);
  const sender = new NdiVideoSender({
    name: opts.name,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    groups: opts.groups,
  });

  /** @type {Buffer|null} */
  let latestFrame = null;
  let framesReceived = 0;
  let framesSent = 0;
  let framesDropped = 0;
  let framesRejected = 0;
  let wsClients = 0;
  let lastFrameAt = 0;

  const wss = new WebSocketServer({ host: opts.host, port: opts.port });
  wss.on("connection", (ws) => {
    wsClients++;
    ws.on("message", (data) => {
      const rgba = parseFrameMessage(data, opts.width, opts.height);
      if (!rgba) {
        framesRejected++;
        return;
      }
      latestFrame = Buffer.from(rgba);
      framesReceived++;
      lastFrameAt = Date.now();
    });
    ws.on("close", () => {
      wsClients--;
    });
  });

  console.log(`[ndi-bridge] NDI source "${opts.name}"`);
  console.log(`[ndi-bridge] WS ws://${opts.host}:${opts.port} expecting ${opts.width}x${opts.height} RGBA`);
  console.log(`[ndi-bridge] Output ${opts.fps} fps`);

  const intervalMs = 1000 / opts.fps;
  const tick = setInterval(async () => {
    if (!latestFrame) return;
    const frame = latestFrame;
    latestFrame = null;
    try {
      await sender.sendRgbaFrame(frame);
      framesSent++;
    } catch (err) {
      framesDropped++;
      console.error("[ndi-bridge] send error:", err.message || err);
    }
  }, intervalMs);

  const stats = setInterval(async () => {
    let connections = 0;
    try {
      connections = await sender.getConnections();
    } catch (_) {
      /* ignore */
    }
    const age = lastFrameAt ? `${Date.now() - lastFrameAt}ms ago` : "never";
    console.log(
      `[ndi-bridge] ws=${wsClients} ndi=${connections} recv=${framesReceived} sent=${framesSent} drop=${framesDropped} last=${age}`
    );
  }, 5000);

  function shutdown() {
    clearInterval(tick);
    clearInterval(stats);
    wss.close();
    sender.destroy();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
