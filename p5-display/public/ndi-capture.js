/**
 * Capture p5 canvas frames and send RGBA to ndi-bridge over WebSocket.
 * Driven by /api/ndi-config and WS ndi-config messages.
 */
(function () {
  const FORMAT_RGBA = 0;
  const params = new URLSearchParams(window.location.search);

  let outW = Math.max(320, parseInt(params.get("w") || "1920", 10) || 1920);
  let outH = Math.max(240, parseInt(params.get("h") || "1080", 10) || 1080);
  let bridgeHost = params.get("bridgeHost") || "127.0.0.1";
  let bridgePort = Math.max(1, parseInt(params.get("bridge") || "8766", 10) || 8766);
  let maxFps = Math.max(1, Math.min(60, parseInt(params.get("fps") || "30", 10) || 30));
  let ndiEnabled = false;
  let activeBridgeId = "";

  /** @type {WebSocket|null} */
  let frameWs = null;
  /** @type {Uint8Array|null} */
  let headerBuf = null;
  let captureSending = false;
  let webglWarned = false;
  let framesSent = 0;
  let lastCaptureAt = 0;
  let wsOpen = false;
  let statusError = "";
  /** @type {ReturnType<typeof setInterval>|null} */
  let statusInterval = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let captureIntervalId = null;

  window.__ntNdiCapture = {
    get width() {
      return outW;
    },
    get height() {
      return outH;
    },
  };

  function setStatus(text) {
    const el = document.getElementById("status");
    if (el) el.textContent = text;
  }

  function frameWsUrl() {
    return `ws://${bridgeHost}:${bridgePort}`;
  }

  function stopCaptureLoop() {
    if (captureIntervalId) {
      clearInterval(captureIntervalId);
      captureIntervalId = null;
    }
  }

  function captureLoopTick() {
    if (!ndiEnabled || !captureSending) return;
    const p5Inst = window.__ntSceneP5;
    if (!p5Inst) return;
    captureFromP5(p5Inst);
  }

  function startCaptureLoop() {
    stopCaptureLoop();
    const ms = Math.max(16, Math.floor(1000 / maxFps));
    captureIntervalId = setInterval(captureLoopTick, ms);
    captureLoopTick();
  }

  function disconnectFrameWs() {
    stopCaptureLoop();
    if (frameWs) {
      try {
        frameWs.onclose = null;
        frameWs.close();
      } catch (_) {
        /* ignore */
      }
      frameWs = null;
    }
    wsOpen = false;
    captureSending = false;
  }

  function connectFrameWs() {
    disconnectFrameWs();
    if (!ndiEnabled) {
      setStatus("NDI disabled — waiting for enable");
      return;
    }
    const url = frameWsUrl();
    try {
      frameWs = new WebSocket(url);
      frameWs.binaryType = "arraybuffer";
    } catch (e) {
      statusError = e.message || String(e);
      setStatus(`Frame WS error: ${statusError}`);
      setTimeout(connectFrameWs, 2000);
      return;
    }
    frameWs.onopen = () => {
      wsOpen = true;
      statusError = "";
      captureSending = true;
      startCaptureLoop();
      setStatus(`NDI capture ${outW}x${outH} @ ${maxFps}fps -> ${url}`);
    };
    frameWs.onclose = () => {
      wsOpen = false;
      captureSending = false;
      stopCaptureLoop();
      if (ndiEnabled) {
        setStatus(`Frame WS closed — retrying ${url}`);
        setTimeout(connectFrameWs, 2000);
      }
    };
    frameWs.onerror = () => {
      statusError = "WebSocket error";
    };
  }

  function buildHeader() {
    if (!headerBuf) headerBuf = new Uint8Array(9);
    const view = new DataView(headerBuf.buffer);
    view.setUint32(0, outW, true);
    view.setUint32(4, outH, true);
    headerBuf[8] = FORMAT_RGBA;
    return headerBuf;
  }

  function sendRgbaFrame(rgba) {
    if (!ndiEnabled || !captureSending || !frameWs || frameWs.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - lastCaptureAt < 1000 / maxFps) return;
    lastCaptureAt = now;
    const header = buildHeader();
    const payload = new Uint8Array(9 + rgba.length);
    payload.set(header, 0);
    payload.set(rgba, 9);
    frameWs.send(payload.buffer);
    framesSent++;
    if (framesSent % 150 === 0) {
      setStatus(`NDI ${outW}x${outH} · ${framesSent} frames -> ${frameWsUrl()}`);
    }
  }

  function captureFromP5(p5Inst) {
    if (!ndiEnabled || !captureSending || !p5Inst) return;
    if (p5Inst._renderer && p5Inst._renderer.isP3D) {
      if (!webglWarned) {
        webglWarned = true;
        statusError = "WEBGL capture not supported in Phase 1";
        setStatus(statusError);
      }
      return;
    }
    const ctx = p5Inst.drawingContext;
    if (!ctx || typeof ctx.getImageData !== "function") {
      statusError = "No 2D drawingContext on p5 instance";
      return;
    }
    if (p5Inst.width !== outW || p5Inst.height !== outH) {
      p5Inst.resizeCanvas(outW, outH);
    }
    let img;
    try {
      img = ctx.getImageData(0, 0, outW, outH);
    } catch (err) {
      statusError = err && err.message ? err.message : String(err);
      return;
    }
    sendRgbaFrame(img.data);
  }

  window.__ntNdiAttachCapture = function attachCapture(_p5Inst) {
    /* capture runs via interval loop after frame WS opens */
  };

  function applyViewportSize() {
    document.documentElement.style.width = outW + "px";
    document.documentElement.style.height = outH + "px";
    document.body.style.width = outW + "px";
    document.body.style.height = outH + "px";
    headerBuf = null;
  }

  function postStatus(sceneFile) {
    fetch("/api/ndi-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bridgeId: activeBridgeId || "unknown",
        wsOpen,
        framesSent,
        lastFrameAt: lastCaptureAt ? Date.now() : 0,
        sceneFile: sceneFile || "",
        error: statusError,
      }),
    }).catch(() => {});
  }

  function startStatusHeartbeat(sceneFile) {
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => postStatus(sceneFile), 2000);
  }

  /**
   * @param {{ enabled?: boolean, bridge?: object, sceneFile?: string }} opts
   */
  window.__ntNdiApplyRuntimeConfig = function applyNdiRuntimeConfig(opts) {
    const bridge = opts.bridge;
    const wasEnabled = ndiEnabled;
    if (typeof opts.enabled === "boolean") ndiEnabled = opts.enabled;
    if (ndiEnabled) webglWarned = false;

    if (bridge) {
      activeBridgeId = bridge.id || "";
      bridgeHost = String(bridge.host || "127.0.0.1");
      bridgePort = Math.max(1, parseInt(String(bridge.port), 10) || 8766);
      outW = Math.max(320, parseInt(String(bridge.width), 10) || 1920);
      outH = Math.max(240, parseInt(String(bridge.height), 10) || 1080);
      maxFps = Math.max(1, Math.min(60, parseInt(String(bridge.fps), 10) || 30));
      applyViewportSize();
    }

    if (!ndiEnabled) {
      disconnectFrameWs();
      setStatus("NDI disabled");
      return;
    }

    const hostChanged =
      bridge &&
      (frameWsUrl() !== `ws://${bridgeHost}:${bridgePort}` || !wasEnabled);
    if (hostChanged || !frameWs) {
      connectFrameWs();
    } else if (frameWs && frameWs.readyState === WebSocket.OPEN) {
      captureSending = true;
      startCaptureLoop();
    }

    startStatusHeartbeat(opts.sceneFile || "");
  };

  applyViewportSize();
})();
