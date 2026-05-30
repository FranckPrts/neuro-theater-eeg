/**
 * Minimal OSC-over-WebSocket client for p5-display server (/ws).
 */
(function (global) {
  const latestByAddress = Object.create(null);
  /** @type {WebSocket|null} */
  let ws = null;

  function wsUrl() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }

  function coerceFirstNumeric(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function clamp01(n) {
    return Math.max(0, Math.min(1, n));
  }

  /**
   * @param {(msg: { address: string, args: unknown[] }) => void} [onOscMessage]
   */
  function connectOscWs(onOscMessage) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      ws = new WebSocket(wsUrl());
    } catch (_) {
      setTimeout(() => connectOscWs(onOscMessage), 2000);
      return;
    }
    ws.onclose = () => {
      ws = null;
      setTimeout(() => connectOscWs(onOscMessage), 2000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.type !== "osc" || !msg.address) return;
      const n = Array.isArray(msg.args) && msg.args.length ? coerceFirstNumeric(msg.args[0]) : null;
      if (n !== null) latestByAddress[msg.address] = n;
      if (typeof onOscMessage === "function") onOscMessage(msg);
    };
  }

  /**
   * @param {string} address
   * @returns {number|null} clamped 0–1 or null if unseen
   */
  function getOscValue(address) {
    if (!address || !(address in latestByAddress)) return null;
    return clamp01(latestByAddress[address]);
  }

  global.NtOscWs = {
    connectOscWs,
    getOscValue,
    latestByAddress,
  };
})(window);
