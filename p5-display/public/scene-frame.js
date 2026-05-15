/**
 * Loads a single global-mode .p5 file; parent posts { type: 'nt-data', data } each frame.
 */
window.data = window.data || {};

window.addEventListener("message", (e) => {
  if (e.origin !== window.location.origin) return;
  if (e.data && e.data.type === "nt-data" && e.data.data && typeof e.data.data === "object") {
    window.data = e.data.data;
  }
});

async function main() {
  const params = new URLSearchParams(window.location.search);
  const scene = params.get("scene") || "";
  if (!scene || !/^[a-zA-Z0-9._-]+\.p5$/.test(scene)) {
    document.body.textContent = "";
    const p = document.createElement("p");
    p.style.cssText = "color:#888;font-family:system-ui,sans-serif;padding:1rem;margin:0";
    p.textContent = "No scene selected.";
    document.body.appendChild(p);
    return;
  }

  const url = "p5-scenes/" + encodeURIComponent(scene);
  const res = await fetch(url);
  if (!res.ok) {
    document.body.textContent = "Failed to load scene: " + res.status;
    return;
  }
  const code = await res.text();
  const blob = new Blob([code], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = blobUrl;
    s.onload = () => {
      URL.revokeObjectURL(blobUrl);
      resolve();
    };
    s.onerror = () => reject(new Error("Scene script error"));
    document.head.appendChild(s);
  });

  if (typeof window.setup === "function" || typeof window.draw === "function") {
    try {
      if (window.__ntSceneP5 && typeof window.__ntSceneP5.remove === "function") {
        window.__ntSceneP5.remove();
      }
    } catch (_) {
      /* ignore */
    }
    window.__ntSceneP5 = new p5();
  }
}

main().catch((err) => {
  console.error(err);
  document.body.textContent = String(err && err.message ? err.message : err);
});
