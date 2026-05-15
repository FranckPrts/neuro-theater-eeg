# p5 OSC browser bridge (MVP)

Small **Node** utility: listen for **UDP OSC** (the same proxied stream you send to TouchDesigner), forward each message to the browser over **WebSocket**, and render a **[p5.js](https://p5js.org/)** page.

- **Main area:** placeholder canvas when no scene is selected; otherwise an **iframe** runs a chosen global-mode sketch from `public/p5-scenes/*.p5`, fed mapped OSC values via `postMessage`.
- **Right strip:** **Streams** mode shows latest values grouped by **OSC device prefix** (same as before). **Scene** mode adds collapsible sections: scene picker, stream reference grid, and **OSC → parameter mapping**. Messages under `/nt/…` are omitted from stream panels.
- **Discreet `hide` control** in the strip header; a **`data`** tab appears top-right to show the strip again.

## Prerequisites

- **Node.js 18+** (uses built-in `http`; depends on `ws` + `osc`).
- Proxied OSC reaching this machine on the chosen UDP port (default **7999**), e.g. from [`osc_proxy_failover.py`](../osc_proxy_failover.py) using `output_ports` or `--out-port 7999,8000`.

## Install

```bash
cd osc-io/p5-osc-visual
npm install
```

`postinstall` copies **`p5.min.js`** into `public/vendor/` from the `p5` devDependency so the page works **offline** after a single install.

## Run

```bash
npm start
```

Defaults:

| Role        | Default              |
| ----------- | -------------------- |
| OSC UDP bind | `0.0.0.0:7999`      |
| HTTP + WS   | `http://127.0.0.1:8765/` |
| WebSocket path | `/ws` (same host/port as the page) |

Open **http://127.0.0.1:8765/** in a browser.

### CLI overrides

```bash
node server.js --osc-host 0.0.0.0 --osc-port 7999 --http-host 127.0.0.1 --http-port 8765
```

`node server.js --help` prints options.

## Wire with the OSC proxy

**Local dev (simplest):** send everything to loopback so the bridge always receives packets:

```bash
cd osc-io
python osc_proxy_failover.py --out-host 127.0.0.1 --out-port 7999,8000
```

- **:8000** — show consumers (e.g. TouchDesigner on this machine).
- **:7999** — this bridge.

Your [`proxy_config.json`](../proxy_config.json) may already list `"output_ports": [7999, 8000]`. You still need `--out-host` to reach **127.0.0.1** for local browser testing.

**MVP limitation:** the proxy currently uses **one** `--out-host` for all output ports. If you need **LAN broadcast** to `:8000` and **loopback** to `:7999` simultaneously, run two proxy instances or extend the proxy with per-destination outputs later.

## Panel modes (right strip)

- **Streams:** single live table of latest OSC values per device/stream.
- **OSC UDP port:** presets **7999**, **8000**, **8001**, **8888**, optional **Custom** port, and **Apply** — rebinding the bridge’s UDP listener without restarting Node (see **`POST /api/osc-port`** below). Your OSC proxy/sender must target the same UDP port.
- **Scene:** three collapsible blocks:
  1. **Scenes** — buttons for each `*.p5` under `public/p5-scenes/` (from **`GET /api/p5-scenes`**) plus **None (blank)** to restore the empty placeholder canvas.
  2. **Streams (reference)** — duplicate latest-value table for use while mapping.
  3. **OSC mapping** — one row per **input** for the active scene (from [`registry.json`](public/p5-scenes/registry.json) for most scenes). Each OSC row is a dropdown of addresses seen so far (first numeric argument → `data[inputId]`). Spider scenes are special: the server derives **`plotCount`** from the line `const NUM_OVERLAY_PLOTS = <n>;` in that file; the rail shows **5 OSC dropdowns + 1 HEX text field per plot**, plus **data line display** (electrodes vs power-band axes), **radius mode** (relative vs absolute), **mean**, and **max deviation** for absolute scaling. HEX colors persist under `nt.p5osc.spiderHex`. **Mapping CSV** — load/save the active scene’s mapping from `public/p5-mapping/*.csv` via the strip (see below).

**Persistence:** `localStorage` keys `nt.p5osc.panelMode`, `nt.p5osc.activeScene`, `nt.p5osc.mappings` (per-scene OSC maps), **`nt.p5osc.oscPort`** (last successfully applied UDP listen port from the strip), **`nt.p5osc.spiderHex`** (per-plot colors for the spider scene), **`nt.p5osc.spiderDrawOverlays`** (how many spider layers to draw, 1…rail max), **`nt.p5osc.spiderDataLines`** (electrode labels vs power-band axes, per scene file), and **`nt.p5osc.spiderRadius`** (spider radius mode + absolute mean/max, per scene file).

## Scene registry and API

**`GET /api/p5-scenes`** returns JSON:

```json
{
  "scenes": [
    { "file": "data-representation.p5", "title": "…", "inputs": [{ "id": "Time Series", "label": "…" }] }
  ]
}
```

Files are discovered by listing `public/p5-scenes/*.p5` on the server. **`registry.json`** in that folder supplies `title` and `inputs` per file; files without an entry still appear with a fallback title and **empty `inputs`**.

For **`spider-plot.p5`**, the API adds **`spiderPlot: { plotCount: N }`** where `N` is read from the source line `const NUM_OVERLAY_PLOTS = N;` (clamped 1–12). That sets how many **full** plot blocks appear in the rail (5 OSC + HEX each). Use **“Overlays to visualize”** in the mapping panel to draw fewer layers without remapping. After changing `NUM_OVERLAY_PLOTS`, **restart the Node server** and refresh the page so `/api/p5-scenes` updates.

**Spider radius:** In **relative** mode (default), each branch length is proportional to that axis’s share of the sum of `|v|` across the five bands (with small fallbacks when the sum is zero). In **absolute** mode, each branch uses `|v − mean| / max` clamped to the outer pentagon, where **mean** and **max** are shared controls in the mapping rail (and CSV). If **max** is missing or invalid in CSV, it defaults to `1`.

Each scene script is written in **global p5 mode** (`setup` / `draw`, global `data` object). The host maps OSC into `data` keys that match each input **`id`**, and for spider scenes adds `data.plot_<p>_color` strings, `data.__plotCount`, `data.__dataLineDisplay` (`electrodes` or `powerBands`), `data.__radiusMode`, `data.__absoluteMean`, and `data.__absoluteMax` from the rail.

## JSON message shape (WebSocket → browser)

Each OSC packet is one JSON object:

| Field        | Meaning                                      |
| ------------ | -------------------------------------------- |
| `type`       | `"osc"`                                      |
| `address`    | Full OSC path, e.g. `/22FC/alphaNorm`        |
| `hardware`   | First path segment when applicable           |
| `stream`     | Remainder after `/<hardware>/`               |
| `args`       | Array of serializable arguments              |
| `receivedAt` | Bridge receive time (`Date.now()`, ms)       |

## Health check

`GET /health` → `{"ok":true,"wsClients":n,"oscHost":"…","oscPort":7999}` (used by the page to show the UDP bind in the live strip).

## OSC UDP port (live rebind)

**`POST /api/osc-port`** with JSON body `{ "port": <number> }` (1–65535) closes the current UDP listener and opens a new one on the same **`--osc-host`**. Success: `{ "ok": true, "oscHost": "…", "oscPort": <n> }`. Errors: `400` for invalid JSON/port, `500` with `{ "ok": false, "error": "…" }` if the new bind fails (the server attempts to restore the previous port).

The right strip includes preset buttons **7999**, **8000**, **8001**, **8888**, an optional **Custom** field, and **Apply**. After a successful apply, the chosen port is stored under **`nt.p5osc.oscPort`**. Point your OSC source (e.g. `osc_proxy_failover.py` `--out-port`) at the same UDP port the bridge is listening on.

## Mapping CSV (`public/p5-mapping`)

Saved presets live as **`*.csv`** under [`public/p5-mapping/`](public/p5-mapping/). The Scene panel lists them in the **CSV** dropdown; **Load** applies rows for the **active scene only** into `localStorage` (missing rows clear that field; extra rows or unknown `inputId`s are ignored). **Save as** names the file (`.csv` added if omitted); unsafe characters are normalized server-side.

**`GET /api/p5-mappings`** → `{ "files": ["a.csv", …] }` (sorted).

**`GET /api/p5-mappings/<file>.csv`** → raw CSV (`text/csv`).

**`POST /api/p5-mappings/<file>.csv`** with body `text/csv` → writes the file, responds `{ "ok": true, "file": "…" }`.

CSV columns (header required):

| Column     | Meaning |
| ---------- | ------- |
| `scene`    | Scene filename, e.g. `spider-plot.p5` (must match active scene when loading). |
| `inputId`  | Registry input `id`, or spider ids `plot_<n>_axis_<0-4>`, `plot_<n>_color`, `__plotCount`, `__dataLineDisplay`, `__radiusMode`, `__absoluteMean`, `__absoluteMax`. |
| `label`    | Human label (informational; export fills from UI). |
| `address`  | OSC path for `osc` rows; HEX string for `hex`; control payload for `control` rows (`__plotCount` = overlay count; `__radiusMode` = `relative` or `absolute`; `__absoluteMean` / `__absoluteMax` = numbers). |
| `valueType`| `osc`, `hex`, or `control`. |

Example (spider):

```csv
scene,inputId,label,address,valueType
spider-plot.p5,plot_0_axis_0,Plot 1 · Δ,/22FC/deltaNorm,osc
spider-plot.p5,plot_0_color,Plot 1 · color (HEX),#88aacc,hex
spider-plot.p5,__plotCount,Overlays to visualize,2,control
spider-plot.p5,__dataLineDisplay,Data line display,electrodes,control
spider-plot.p5,__radiusMode,Radius mode,relative,control
spider-plot.p5,__absoluteMean,Absolute · mean (center),0,control
spider-plot.p5,__absoluteMax,Absolute · max deviation (outer),1,control
```

## Files

- `server.js` — static files from `public/`, WebSocket on `/ws`, OSC UDP listener (rebind via **`POST /api/osc-port`**), **`GET /api/p5-scenes`**, mapping CSV **`GET/POST /api/p5-mappings`**.
- `public/index.html`, `public/sketch.js`, `public/styles.css` — host UI + placeholder p5 instance.
- `public/scene-frame.html`, `public/scene-frame.js` — iframe loader: p5 + selected `.p5`, `postMessage` → `window.data`.
- `public/p5-scenes/*.p5` — scene sketches; `public/p5-scenes/registry.json` — titles and mappable inputs.
- `public/p5-mapping/*.csv` — optional saved mapping presets (created by Save in the UI).
- `public/vendor/p5.min.js` — generated by `npm install` (from `p5` package).

## Security note

Scene code is loaded and executed in the iframe from **trusted local files** only. Do not point this tool at untrusted remote `.p5` sources.
