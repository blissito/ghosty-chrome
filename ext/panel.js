// Panel mínimo: estado de la conexión con gs, quién usa el navegador, el último paso y ■ Detener.
// El trabajo lo hace el service worker (`background.js`); esto sólo lo pinta.
const $ = (id) => document.getElementById(id);
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `hace ${s} s` : `hace ${Math.round(s / 60)} min`;
};

function render(r) {
  if (!r) return;
  const on = r.status === "connected";
  $("dot").className = `dot ${on ? (r.busy ? "busy" : "on") : "off"}`;
  $("status").textContent = on ? `Conectado${r.email ? ` · ${r.email}` : ""}` : r.status === "connecting" ? "Conectando…" : "Desconectado";
  // Copia vieja (gs contestó 426): «Actualiza» con la liga de descarga.
  $("update").hidden = !r.outdated;
  if (r.outdated) {
    $("update-msg").textContent = r.outdated.message ?? "Esta versión de Ghosty ya no es compatible.";
    $("update-link").href = r.outdated.download ?? "https://www.ghosty.studio/chrome";
  }
  $("reason").hidden = !r.reason || !!r.outdated;
  $("reason").textContent = r.reason ?? "";
  $("client").textContent = r.client || "Ghosty";
  $("busy").textContent = r.busy ? `${r.busy}…` : Date.now() - (r.stoppedAt || 0) < 15_000 ? "detenido" : "—";
  const l = r.lastStep;
  $("last").textContent = l ? `${l.ok ? "✓" : "✗"} ${l.tool} · ${l.ms} ms · ${ago(l.at)}${l.detail ? `\n${l.detail}` : ""}` : "—";
  // Encendido mientras el agente trabaja (los comandos llegan en ráfagas: 8 s tras el último paso).
  $("native").textContent = r.native ? "conectada en esta Mac" : "—";
  $("stop").disabled = !(r.busy || (l && Date.now() - l.at < 8000));
  if (document.activeElement !== $("gs")) $("gs").value = r.gs ?? "";
}

chrome.storage.session.get("relay").then(({ relay }) => render(relay));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.relay) render(changes.relay.newValue);
});
// Refresca los «hace N s».
setInterval(() => chrome.storage.session.get("relay").then(({ relay }) => render(relay)), 5000);
// Abrir el panel despierta al service worker y reintenta si estaba desconectado.
chrome.runtime.sendMessage({ type: "fx-reconnect-if-needed" }).catch(() => {});

$("stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "fx-stop" }));

$("connect").addEventListener("toggle", async () => {
  if (!$("connect").open) return;
  const { relay } = await chrome.storage.session.get("relay");
  const r = await fetch(`${relay?.gs ?? "http://localhost:5180"}/api/browser/token`, { credentials: "include" }).catch(() => null);
  const j = r?.ok ? await r.json() : null;
  $("mcp").textContent = j?.mcp ?? "Entra primero a Ghosty Studio en este Chrome.";
});
$("copy").addEventListener("click", () => navigator.clipboard.writeText($("mcp").textContent));

$("gs-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("gs").value.trim().replace(/\/$/, "");
  // Sólo los servidores de Ghosty (uno ajeno recibiría el control del navegador).
  if (["https://www.ghosty.studio", "http://localhost:5180"].includes(v)) chrome.storage.local.set({ gsUrl: v });
});
