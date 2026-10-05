// Documento offscreen: la conexión con gs (SSE para bajar comandos, POST para subir resultados).
// Las tools corren en el service worker; aquí sólo se pasa cada comando por mensaje.
const RECONNECT_EVERY_MS = 4 * 60_000;
let gs = "http://localhost:5180";
let conn = null;
let connecting = false;
let inflight = 0; // comandos corriendo: el corte periódico del SSE espera a que terminen
let quick = 0; // reintentos rápidos seguidos (deploy de gs: 503 de la caja en espera, cierre por drain)
// Reconexión: inmediata tras un corte o un 503 (un deploy dura segundos); si sigue fallando, más espaciada.
const retryLater = () => setTimeout(connect, quick++ < 30 ? 400 : 5000);

const toSW = (msg) => chrome.runtime.sendMessage(msg);
// Cada petición a gs se identifica como la extensión: gs rechaza el SSE y los POST sin este header (una
// página no puede ponerlo con la cookie de la persona) y, por el protocolo, las copias viejas.
// (El documento offscreen no tiene `chrome.runtime.getManifest`: la versión la da el service worker.)
const EXT_HEADERS = { "x-ghosty-ext": "1", "x-ghosty-ext-version": "0", "x-ghosty-ext-protocol": "0" };
const state = (patch) => toSW({ type: "relay-state", patch }).catch(() => {});

async function post(body, base = gs) {
  const r = await fetch(`${base}/api/browser/connect`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", ...EXT_HEADERS }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json, error: r.ok ? null : json?.error ?? `gs ${r.status}` };
}

async function runCmd(cmd) {
  // El SW contesta cuando la tool termina; si se durmió, el mensaje lo despierta.
  inflight++;
  try {
    const res = await toSW({ type: "relay-cmd", cmd }).catch((e) => ({ id: cmd.id, error: `la extensión no contestó: ${e.message}` }));
    await post({ type: "result", id: cmd.id, result: res?.result, error: res?.error }).catch(() => {});
  } finally {
    inflight--;
  }
}

async function connect() {
  if (connecting || conn) return;
  connecting = true;
  const cfg = await toSW({ type: "relay-config" }).catch(() => null);
  gs = cfg?.gs ?? gs;
  if (cfg?.version) EXT_HEADERS["x-ghosty-ext-version"] = cfg.version;
  if (cfg?.protocol) EXT_HEADERS["x-ghosty-ext-protocol"] = String(cfg.protocol);
  state({ gs, status: "connecting", reason: null });
  const ac = new AbortController();
  let res;
  try {
    res = await fetch(`${gs}/api/browser/connect`, { credentials: "include", signal: ac.signal, headers: { accept: "text/event-stream", ...EXT_HEADERS } });
  } catch (e) {
    connecting = false;
    state({ status: "disconnected", reason: `gs no responde (${gs}): ${e.message}` });
    retryLater();
    return;
  }
  connecting = false;
  if (!res.ok || !res.body) {
    const j = res.status === 426 || res.status === 403 ? await res.json().catch(() => null) : null;
    // 426: esta copia es más vieja que la mínima de gs → el panel muestra «Actualiza» con la descarga.
    state({ status: "disconnected", outdated: res.status === 426 ? { message: j?.error, download: j?.download } : null, reason: res.status === 401 ? `Sin sesión: entra a ${gs} en este Chrome` : j?.error ?? `gs ${res.status}` });
    if (res.status === 426) setTimeout(connect, 10 * 60_000);
    else if (res.status === 401 || res.status === 403) setTimeout(connect, 10_000);
    else retryLater(); // 503 = caja en espera durante un deploy: la activa contesta en segundos
    return;
  }
  conn = ac;
  quick = 0;
  state({ outdated: null });
  // Corte periódico (el SW no aguanta un fetch eterno), pero nunca con un comando en vuelo: su
  // resultado podría quedarse sin dueño.
  let refresh;
  const scheduleRefresh = (ms) => {
    refresh = setTimeout(() => (inflight ? scheduleRefresh(2000) : ac.abort()), ms);
  };
  scheduleRefresh(RECONNECT_EVERY_MS);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        let payload = null;
        try {
          payload = data ? JSON.parse(data) : null;
        } catch {}
        if (event === "hello") {
          state({ status: "connected", email: payload?.email ?? null, reason: null });
          const tools = await toSW({ type: "relay-tools" }).catch(() => []);
          void post({ type: "tools", tools });
        } else if (event === "cmd" && payload) void runCmd(payload);
        else if (event === "ping") {
          // Latido de vuelta: gs da por muerta una conexión sin noticias en 25 s.
          // Si contesta una caja que no tiene esta conexión (deploy: `www` ya apunta a la nueva y el SSE
          // sigue en la que drena), se reconecta ya para mudarse a la activa.
          void post({ type: "pong" })
            .then((r) => {
              if (r.ok && r.json?.here === false) {
                conn?.abort();
              }
            })
            .catch(() => {});
          void toSW({ type: "relay-state", patch: { status: "connected" } }).catch(() => {});
        }
        else if (event === "replaced") state({ reason: "otra conexión tomó el lugar" });
      }
    }
  } catch {}
  clearTimeout(refresh);
  conn = null;
  state({ status: "disconnected" });
  // Corte por deploy (la caja que drena cierra) o periódico: de vuelta de inmediato.
  setTimeout(connect, 150);
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === "relay-post") {
    // `gs`: otro servidor (verificar el emparejamiento ANTES de mudarse a él).
    post(msg.body, msg.gs ?? gs).then(reply, (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "relay-reconnect") {
    conn?.abort();
    conn = null;
    void connect();
  }
  if (msg?.type === "relay-wake" && !conn) void connect();
});

void connect();
