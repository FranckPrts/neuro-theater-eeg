# NeuroTheater — live show quick ref

Full docs: [README.md](README.md) · [p5-display/README.md](p5-display/README.md) · Conda/goofi setup: [README#conda-goofi-env](README.md#conda-goofi-env)

**Pipeline:** Muse/Enobio → LSL → goofi (`:8001`) → proxy (`:8001`→`:8000`) → LAN + p5 (`:8765`) → OBS → NDI

## Boot order

1. `source run_env_neurtheater.sh` (repo root; must be **sourced**)
2. Acquisition: Muse Direct on tablets **or** `bash scripts/muse_stream_resilient.sh <HW>` per head
3. One terminal per headset: `goofi-pipe goofi-files/<FILE>.gfi --headless`
4. Proxy (below)
5. `cd p5-display && npm start`
6. Open **brain-graph** + **spider-graph** (URLs below); dashboard **Stream → Apply → 8000** if no OSC
7. Consumers on **UDP 8000** (`192.168.10.255` on show LAN)

## OSC proxy

**LAN (show — TouchDesigner, p5, collaborators on subnet):**

```bash
python osc-io/osc_proxy_failover.py \
  --config osc-io/proxy_config.json \
  --allowed-hardware 22FC,2265,2262,1D1A,1FD6,2615,1E58,ENOB \
  --in-port 8001 --out-port 8000 \
  --out-host 192.168.10.255
```

**Local (one machine — proxy + p5 on same Mac, no broadcast):**

```bash
python osc-io/osc_proxy_failover.py \
  --config osc-io/proxy_config.json \
  --allowed-hardware 22FC,2265,2262,1D1A,1FD6,2615,1E58,ENOB \
  --in-port 8001 --out-port 8000 \
  --out-host 127.0.0.1
```

- **In** `8001` ← goofi; **out** `8000` ← consumers. Only `--out-host` differs above.
- With `--config`, [`osc-io/proxy_config.json`](osc-io/proxy_config.json) may also fan out to **7999** and **8000** (`output_ports`); CLI `--out-port` overrides single-port behavior.
- Failover clips: `hardware_recordings` in that JSON (`22FC`, `ENOB`, …).
- **Suffix exclusions** (optional): in `proxy_config.json` → `session.excluded_suffixes`, e.g. `["*/alphaNorm"]` drops every `/<id>/alphaNorm` from proxy output while `/<id>/alpha` still passes. CLI: `--exclude-suffixes alphaNorm,thetaNorm`.

Record · replay: `python osc-io/osc_recorder.py --port 8001` · `python osc-io/osc_replay.py osc-io/recordings/failovers/ENOBIO.json --port 8001 --loop`

## p5-display (brain + spider)

```bash
cd p5-display && npm start
```

| View | URL |
|------|-----|
| Dashboard | http://127.0.0.1:8765/ |
| **Brain graphic** | http://127.0.0.1:8765/brain-graph/brain-graph.html (**H** = hide sphere button) |
| **Spider graph** | http://127.0.0.1:8765/spider-graph/spider-graph.html (**H** = hide sweep/trail UI) |
| Health | http://127.0.0.1:8765/health |

Default OSC listen port is **8000**; standalone pages still need `npm start` (WebSocket bridge).

## Goofi graphs

```bash
goofi-pipe goofi-files/<FILE>.gfi --headless
```

| File | OSC prefix / ports | When |
|------|-------------------|------|
| `22FC_MUSEDIRECT.gfi` | `/22FC` → `:8001` | Muse Direct **22FC** |
| `2265_MUSEDIRECT.gfi` | `/2265` → `:8001` | **2265** |
| `2262_MUSEDIRECT.gfi` | `/2262` → `:8001` | **2262** |
| `1D1A_MUSEDIRECT.gfi` | `/1D1A` → `:8001` | **1D1A** |
| `1FD6_MUSEDIRECT.gfi` | `/1FD6` → `:8001` | **1FD6** |
| `1E58_MUSEDIRECT.gfi` | `/1E58` → `:8001` | **1E58** |
| `ENOBIO.gfi` | `/ENOB` → `:8001` | Enobio via **proxy** (normal) |
| `ENOBIO_SAVE_DUAL.gfi` | `/ENOB` → `:8001` **and** `:8000` | Enobio + **direct** to consumers |
| `MUSELSL_ALL.gfi` | `/22FC` → `:8001` (hardcoded) | **muselsl**; edit prefix/`source_name` before show |
| `RAW_MUSE.gfi` | `/RAWM` → `:8001` | Debug raw Muse |
| `RAW_ENOBIO.gfi` | `/RAWE` → `:8080` | Debug raw Enobio |
| `collectMuses.gfi` | (no OSC out) | Multi-LSL in Goofi UI only |
| `NormalizationTest_MuseDirect.gfi` | `/1FD6` | Normalization tests |
| `May18-Archive-1D1A_MUSEDIRECT.gfi` | `/1D1A` | **Archive** — use `1D1A_MUSEDIRECT.gfi` |

One `goofi-pipe` per active headset. **2615** is in proxy `allowed-hardware` but has no `2615_MUSEDIRECT.gfi` yet — add/duplicate a graph before show.

## Also useful

- **Muse LSL (Mac):** `bash scripts/muse_stream_resilient.sh 22FC -- --ppg --acc --gyro`
- **Flower2 (Enobio LSL viz):** `python flower2-app/app.py --live --config flower2-data/live-enobio.local.json` → http://127.0.0.1:5000 ([NEUROTHEATER_LIVE.md](flower2-app/NEUROTHEATER_LIVE.md))
- **Synthetic electrodes (p5 test):** `python osc-io/enobio_electrode_stream.py --port 8000`
- **NDI:** `cd ndi-bridge && npm start -- --port 8766 …` + p5 **NDI** tab ([ndi-bridge/README.md](ndi-bridge/README.md))
- **Proxy status OSC:** add `--status --status-port 8888` to `osc_proxy_failover.py`
- **Ports:** `8001` in · `8000` out · `8765` HTTP · `8888` status (optional)
- **Second p5 UI:** `node server.js --http-port 8768` (different UDP port per instance)
