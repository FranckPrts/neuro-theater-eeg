/**
 * Capture p5 canvas frames and send RGBA to ndi-bridge over WebSocket.
 */
(function () {
  const FORMAT_RGBA = 0;
  const params = new URLSearchParams(window.location.search);
  const outW = Math.max(320, parseInt(params.get("w") || "1920", 10) || 1920);
  const outH = Math.max(240, parseInt(params.get("h") || "1080", 10) || 1080);
  const bridgePort = Math.max(1, parseInt(params.get("bridge") || "8766", 10) || 8766);
  const maxFps = Math.max(1, Math.min(60, parseInt(params.get("fps") || "30", 10) || 30));

  /** @type {WebSocket|null} */
  let frameWs = null;
  /** @type {Uint8Array|null} */
  let headerBuf = null;
  let captureEnabled = false;
  let webglWarned = false;
  let framesSent = 0;
  let lastCaptureAt = 0;

  window.__ntNdiCapture = {
    width: outW,
    height: outH,
    bridgePort,
    maxFps,
  };

  function setStatus(text) {
    const el = document.getElementById("status");
    if (el) el.textContent = text;
  }

  function frameWsUrl() {
    const host = params.get("bridgeHost") || "127.0.0.1";
    return `ws://${host}:${bridgePort}`;
  }

  function connectFrameWs() {
    const url = frameWsUrl();
    try {
      frameWs = new WebSocket(url);
      frameWs.binaryType = "arraybuffer";
    } catch (e) {
      setStatus(`Frame WS error: ${e.message || e}`);
      setTimeout(connectFrameWs, 2000);
      return;
    }
    frameWs.onopen = () => {
      setStatus(`NDI capture ${outW}x${outH} -> ${url}`);
      captureEnabled = true;
    };
    frameWs.onclose = () => {
      captureEnabled = false;
      setStatus(`Frame WS closed — retrying ${url}`);
      setTimeout(connectFrameWs, 2000);
    };
    frameWs.onerror = () => {
      /* onclose follows */
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
    if (!frameWs || frameWs.readyState !== WebSocket.OPEN) return;
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
      setStatus(`NDI capture ${outW}x${outH} · ${framesSent} frames -> ${frameWsUrl()}`);
    }
  }

  function captureFromP5(p5Inst) {
    if (!captureEnabled || !p5Inst || !p5Inst.canvas) return;
    const canvas = p5Inst.canvas;
    if (p5Inst._renderer && p5Inst._renderer.isP3D) {
      if (!webglWarned) {
        webglWarned = true;
        setStatus("WEBGL capture not supported in Phase 1 — use 2D scenes for NDI");
      }
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (canvas.width !== outW || canvas.height !== outH) {
      p5Inst.resizeCanvas(outW, outH);
    }
    const img = ctx.getImageData(0, 0, outW, outH);
    sendRgbaFrame(img.data);
  }

  window.__ntNdiAttachCapture = function attachCapture(p5Inst) {
    if (!p5Inst || typeof p5Inst.registerMethod !== "function") return;
    p5Inst.registerMethod("post", function () {
      captureFromP5(this);
    });
  };

  connectFrameWs();
})();
