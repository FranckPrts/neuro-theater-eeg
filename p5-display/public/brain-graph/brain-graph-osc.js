/**
 * OSC wiring for brain-graph.html — loads band mapping CSV and connects /ws.
 */
(function () {
  const CSV_URL = "../p5-mapping/brain-graph-mapping.csv";
  const SCENE = "brain-graph.html";

  /** @type {Record<string, string>} band key (alpha, delta, …) → OSC address */
  window.__ntBandAddressByKey = Object.create(null);

  function parseMappingCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return;
    const header = lines[0].split(",");
    const iScene = header.indexOf("scene");
    const iInput = header.indexOf("inputId");
    const iAddr = header.indexOf("address");
    const iType = header.indexOf("valueType");
    if (iScene < 0 || iInput < 0 || iAddr < 0) return;
    for (let li = 1; li < lines.length; li++) {
      const cols = lines[li].split(",");
      if (cols.length < 4) continue;
      if (cols[iScene] !== SCENE) continue;
      if (iType >= 0 && cols[iType] !== "osc") continue;
      const inputId = cols[iInput].trim();
      const address = cols[iAddr].trim();
      if (inputId && address) {
        window.__ntBandAddressByKey[inputId] = address;
        if (inputId === "highbeta") window.__ntBandAddressByKey.highBeta = address;
        if (inputId === "lowbeta") window.__ntBandAddressByKey.lowBeta = address;
      }
    }
  }

  function montageHardwarePrefix() {
    const museOn = document.getElementById("btnMuse")?.classList.contains("on");
    return museOn ? "MUSE" : "ENOB";
  }

  window.__ntMontageHardwarePrefix = montageHardwarePrefix;

  fetch(CSV_URL)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
    .then(parseMappingCsv)
    .catch((err) => console.warn("[brain-graph-osc] mapping CSV:", err));

  if (window.NtOscWs) window.NtOscWs.connectOscWs();
})();
