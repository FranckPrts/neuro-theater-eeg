#!/usr/bin/env node
/**
 * Phase 0 spike: animated color bars -> NDI (no browser).
 */

const os = require("os");
const { NdiVideoSender } = require("../src/ndi-sender");

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

async function main() {
  const name = process.argv.includes("--name")
    ? process.argv[process.argv.indexOf("--name") + 1]
    : `NeuroTheater-Test (${os.hostname()})`;

  const sender = new NdiVideoSender({
    name,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    groups: "NeuroTheater",
  });

  console.log(`[test-pattern] NDI source "${name}" at ${WIDTH}x${HEIGHT} ${FPS}fps`);
  console.log("[test-pattern] Open NDI Studio Monitor or TouchDesigner NDI In to verify.");
  console.log("[test-pattern] Ctrl+C to stop.");

  const buf = Buffer.allocUnsafe(WIDTH * HEIGHT * 4);
  let frame = 0;

  const interval = setInterval(async () => {
    const offset = (frame * 4) % WIDTH;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 4;
        const bar = Math.floor(((x + offset) % WIDTH) / (WIDTH / 7));
        const colors = [
          [255, 0, 0, 255],
          [255, 127, 0, 255],
          [255, 255, 0, 255],
          [0, 255, 0, 255],
          [0, 255, 255, 255],
          [0, 0, 255, 255],
          [255, 0, 255, 255],
        ];
        const c = colors[bar] || [128, 128, 128, 255];
        buf[i] = c[0];
        buf[i + 1] = c[1];
        buf[i + 2] = c[2];
        buf[i + 3] = c[3];
      }
    }
    frame++;
    try {
      await sender.sendRgbaFrame(buf);
    } catch (err) {
      console.error("[test-pattern] send error:", err.message || err);
    }
  }, 1000 / FPS);

  process.on("SIGINT", () => {
    clearInterval(interval);
    sender.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
