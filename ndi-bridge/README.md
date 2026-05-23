# neurotheater-ndi-bridge

**GPL-3.0-or-later** — separate from the Apache-2.0 `p5-display` package.

Receives RGBA canvas frames from the browser over WebSocket and publishes them as an NDI source via [`@vygr-labs/ndi-node`](https://github.com/vygr-labs/ndi-node).

## Prerequisites

- macOS with [NDI SDK](https://ndi.video/download-ndi-sdk/) installed at `/Library/NDI SDK for Apple`
- [NDI Runtime / NDI Tools](https://ndi.video/tools/) on sender and consumer machines
- Node.js 18+
- Xcode Command Line Tools (for `node-gyp`)

## Setup

```bash
cd ndi-bridge
npm run install:all
```

This installs dependencies without running native builds first, links the system NDI SDK into `@vygr-labs/ndi-node/deps/ndi`, rebuilds the addon, and patches macOS runtime paths for `libndi.dylib`.

If you already ran `npm install` and the native build failed:

```bash
npm run setup-sdk
npm rebuild @vygr-labs/ndi-node
npm run fix-runtime
```

If `npm start` fails with `Library not loaded: @rpath/libndi.dylib`, run `npm run fix-runtime` once.

If build fails, ensure:

```bash
npm run setup-sdk
ls deps/ndi/lib/libndi.dylib deps/ndi/include/Processing.NDI.Lib.h
```

## Phase 0 — test pattern (no browser)

```bash
npm run test-pattern
# or
node examples/test-pattern.js --name "NeuroTheater-Test"
```

Verify in **NDI Studio Monitor** or TouchDesigner **NDI In TOP**.

## Phase 1 — bridge + p5-display

Terminal 1:

```bash
cd p5-display && npm start
```

Terminal 2:

```bash
cd ndi-bridge && npm start -- --name "NeuroTheater-$(hostname)"
```

Browser (NDI output — clean canvas, no OSC strip):

```
http://127.0.0.1:8765/ndi-output.html?scene=spider-plot-neon-cells.p5&w=1920&h=1080
```

Configure OSC mappings in the operator UI (`http://127.0.0.1:8765/`) first — mappings share `localStorage` on the same origin.

## CLI

```bash
node src/bridge.js --help

node src/bridge.js \
  --name "NeuroTheater p5" \
  --host 127.0.0.1 \
  --port 8766 \
  --width 1920 \
  --height 1080 \
  --fps 30
```

## Wire format

Binary WebSocket message:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | width (uint32 LE) |
| 4 | 4 | height (uint32 LE) |
| 8 | 1 | format (0 = RGBA) |
| 9 | w×h×4 | raw RGBA pixels |

## Fallback

If `@vygr-labs/ndi-node` fails to build, swap `src/ndi-sender.js` for [grandi](https://www.npmjs.com/package/grandi) (Apache-2.0) — same BGRA buffer contract.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
