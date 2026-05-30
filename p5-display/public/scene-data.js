/**
 * Shared scene data builder: localStorage mappings + OSC cache → sketch `data` object.
 * Used by dashboard preview (sketch.js) and NDI output (ndi-output-boot.js).
 */
(function (global) {
  const LS_MAPPINGS = "nt.p5osc.mappings";
  const LS_SPIDER_HEX = "nt.p5osc.spiderHex";
  const LS_SPIDER_DRAW = "nt.p5osc.spiderDrawOverlays";
  const LS_SPIDER_RADIUS = "nt.p5osc.spiderRadius";
  const LS_SPIDER_DATA_LINES = "nt.p5osc.spiderDataLines";
  const LS_SPIDER_RADAR = "nt.p5osc.spiderRadar";
  const LS_SIGNAL_VIEW = "nt.p5osc.signalView";
  const LS_WAVE_AGITATION = "nt.p5osc.waveAgitation";

  const WAVE_AGITATION_FILE = "wave-agitation.p5";

  const SPIDER_STREAM_GROUPED_FILES = new Set([
    "spider-plot-neon-streams.p5",
    "spider-plot-collective.p5",
  ]);
  const SPIDER_COLLECTIVE_FILE = "spider-plot-collective.p5";

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

  function isWaveAgitationScene(scene) {
    return Boolean(scene && scene.file === WAVE_AGITATION_FILE);
  }

  function normalizeWaveMotionMode(value) {
    const v = String(value || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    return v === "envelopescroll" ? "envelopeScroll" : "inPlace";
  }

  function readWaveAgitationSettings(sceneFile) {
    const fallback = { motionMode: "inPlace", historyLength: 500, scrollSpeed: 4 };
    try {
      const raw = localStorage.getItem(LS_WAVE_AGITATION);
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
      return {
        motionMode: normalizeWaveMotionMode(per.motionMode),
        historyLength,
        scrollSpeed,
      };
    } catch (_) {
      return fallback;
    }
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
      if (typeof o !== "object" || o === null) return "electrodes";
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

  function branchLabelsForCollectivePlot(maps, branchN) {
    const labels = [];
    for (let a = 0; a < branchN; a++) {
      labels.push(branchLabelFromInputId(maps, `plot_0_axis_${a}`));
    }
    return labels;
  }

  function migrateCollectivePlotMappings(sceneMap, branchN, railN = 12) {
    if (!sceneMap || typeof sceneMap !== "object") return false;
    for (let a = 0; a < branchN; a++) {
      if (sceneMap[`plot_0_axis_${a}`]) return false;
    }
    for (let p = 1; p < railN; p++) {
      let hasAny = false;
      for (let a = 0; a < branchN; a++) {
        const src = sceneMap[`plot_${p}_axis_${a}`];
        if (src) {
          sceneMap[`plot_0_axis_${a}`] = src;
          hasAny = true;
        }
      }
      if (hasAny) return true;
    }
    return false;
  }

  function inputValueType(input) {
    const t = String(input?.type || input?.valueType || "")
      .trim()
      .toLowerCase();
    if (t === "bool" || t === "boolean") return "bool";
    if (t === "select" || t === "preset") return "select";
    return "osc";
  }

  function selectInputOptions(input) {
    const raw = input?.options || input?.presets || [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((o) => {
        if (typeof o === "string") return { value: o, label: o };
        return {
          value: String(o?.value ?? o?.label ?? ""),
          label: String(o?.label ?? o?.value ?? ""),
        };
      })
      .filter((o) => o.value !== "");
  }

  function defaultSelectValue(input) {
    const opts = selectInputOptions(input);
    const def = input?.default != null ? String(input.default) : "";
    if (def && opts.some((o) => o.value === def)) return def;
    return opts.length ? opts[0].value : def;
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

  function buildSceneData(scene, latestByAddress) {
    if (!scene || !scene.file) return {};
    const sceneFile = scene.file;
    const oscCache = latestByAddress || {};

    const spiderN = getSpiderPlotCount(scene);
    if (spiderN > 0) {
      const allMaps = readMappings();
      const maps = { ...(allMaps[sceneFile] || {}) };
      const branchN = getSpiderBranchCount(scene);
      const out = {};
      const railN = spiderN;
      const collective = isSpiderCollectiveScene(scene);
      if (collective) {
        migrateCollectivePlotMappings(maps, branchN);
      }
      const drawN = collective
        ? 1
        : Math.max(1, Math.min(railN, readSpiderDrawCount(sceneFile, railN)));
      out.__plotCount = drawN;
      out.__branchCount = branchN;
      const rad = readSpiderRadiusAll(sceneFile);
      out.__radiusMode = rad.mode;
      out.__absoluteMean = rad.mean;
      out.__absoluteMax = rad.max;
      if (!isSpiderStreamGroupedScene(scene) && !isWaveAgitationScene(scene)) {
        out.__dataLineDisplay = readSpiderDataLineDisplay(sceneFile);
      }
      if (isSpiderStreamGroupedScene(scene)) {
        if (collective) {
          const labels = branchLabelsForCollectivePlot(maps, branchN);
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
      if (isWaveAgitationScene(scene)) {
        const wa = readWaveAgitationSettings(sceneFile);
        out.__waveMotionMode = wa.motionMode;
        out.__historyLength = wa.historyLength;
        out.__scrollSpeed = wa.scrollSpeed;
      }
      const plotDataN = collective ? 1 : railN;
      for (let p = 0; p < plotDataN; p++) {
        for (let a = 0; a < branchN; a++) {
          const id = `plot_${p}_axis_${a}`;
          const addr = maps[id];
          if (!addr) continue;
          const rec = oscCache[addr];
          if (!rec || !Array.isArray(rec.args) || !rec.args.length) continue;
          const n = coerceFirstNumeric(rec.args[0]);
          if (n !== null) out[id] = n;
        }
      }
      if (!collective) {
        const hexPer = readSpiderHex()[sceneFile] || {};
        for (let p = 0; p < railN; p++) {
          const c = hexPer[String(p)];
          if (c) out[`plot_${p}_color`] = c;
        }
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
      if (inputValueType(inp) === "select") {
        const v = maps[inp.id];
        out[inp.id] = v != null && v !== "" ? String(v) : defaultSelectValue(inp);
        continue;
      }

      const addr = maps[inp.id];
      if (!addr) continue;
      const rec = oscCache[addr];
      if (!rec || !Array.isArray(rec.args) || !rec.args.length) continue;
      const n = coerceFirstNumeric(rec.args[0]);
      if (n !== null) out[inp.id] = n;
    }
    return out;
  }

  global.NtSceneData = {
    buildSceneData,
    readMappings,
    readSpiderHex,
    readSpiderDrawCount,
    readSpiderRadiusAll,
    readSpiderDataLineDisplay,
    readSpiderRadar,
    readSignalViewSettings,
    readWaveAgitationSettings,
    getSpiderPlotCount,
    getSpiderBranchCount,
    isSpiderStreamGroupedScene,
    isSpiderCollectiveScene,
    isSignalViewScene,
    isWaveAgitationScene,
    inputValueType,
    selectInputOptions,
    defaultSelectValue,
    parseBoolValue,
    defaultBoolValue,
    coerceFirstNumeric,
    parseOscAddressParts,
    isDeviceStreamAddress,
    branchLabelFromMaps,
    branchLabelFromInputId,
    branchLabelsForCollectivePlot,
    migrateCollectivePlotMappings,
    normalizeWaveMotionMode,
    normalizeSpiderDataLineDisplay,
  };
})(window);
