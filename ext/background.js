// Relay de la extensión (fase 5): la extensión SÓLO ejecuta. Corre las tools que le pida el agente
// que conversa en otra superficie (/c, iOS, Claude Code por `scripts/browser-mcp.mjs`, CLI `ghosty`).
//
// La red con gs la lleva un documento offscreen (`relay.html`): Chrome 139+ bloquea con «Local
// Network Access» los fetch del service worker a la red local/IPs privadas, pero no los de una página
// de la extensión. El offscreen abre el SSE con la cookie de sesión, pasa cada comando aquí por
// mensaje y sube el resultado. No hace falta tener el panel abierto.
//
// Otros dos caminos llegan a las mismas tools (`runCommand`):
// - la página de Ghosty Studio (/c) por `externally_connectable`: se empareja sola con la sesión;
// - la terminal en la misma Mac por `nativeMessaging` (host `studio.ghosty.browser`), sin pasar por gs.
import * as cdp from "./cdp.js";
import { buildTools, paintFrame } from "./tools.js";
import { ensureInGroup, groupOf, markGroupBusy } from "./tools/tabs.js";
import { pageChallenge, pageCommitments } from "./guard.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const DEFAULT_GS = "http://localhost:5180";
// Protocolo con gs (NO la versión del manifest: la tienda sale como 1.0.0 y desarrollo como 1.4.0 con el
// mismo código). gs rechaza con «Actualiza» lo que esté debajo de su mínimo (/api/browser/version).
//   3 = puerta de confirmación, headers x-ghosty-ext*, emparejamiento con prueba (2026-10-04).
const GHOSTY_BROWSER_PROTOCOL = 3;
// Qué código corre de verdad: hash del código (cambia con cada edición aunque la versión del manifest
// no) y las capacidades, para que el agente y la persona sepan si la recarga ya tomó lo nuevo.
const CAPABILITIES = ["tabId", "dialogs", "fileChooser", "newTabNotice", "maskSecrets", "fastNav", "sessions"];
const buildId = (async () => {
  try {
    const files = ["background.js", "tools.js", "cdp.js", "guard.js", "tools/tabs.js", "tools/computer.js", "tools/record.js"];
    const parts = await Promise.all(files.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => (r.ok ? r.text() : ""))));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
    return [...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "?";
  }
})();
// Los ÚNICOS servidores a los que la extensión se conecta (de ahí le llegan los comandos). Un servidor
// ajeno pegado en el panel o pedido por una página tendría el navegador entero: no se acepta.
const ALLOWED_GS = ["https://www.ghosty.studio", "http://localhost:5180"];
const allowedGs = (u) => (ALLOWED_GS.includes(u) ? u : DEFAULT_GS);
const RECONNECT_EVERY_MS = 4 * 60_000; // el SW no aguanta un fetch de más de 5 min
const STOP_WINDOW_MS = 15_000;

// ── Estado visible en el panel (chrome.storage.session) ──
const state = { status: "connecting", email: null, reason: null, gs: DEFAULT_GS, client: null, lastStep: null, busy: null, stoppedAt: 0 };
function publish(patch) {
  Object.assign(state, patch);
  chrome.storage.session.set({ relay: { ...state } }).catch(() => {});
}

// ── Host de las tools en el service worker ──
// Pestaña de cada agente: `session` (una por conversación de gs o por proceso MCP) → tabId. "" = los
// que no mandan session (protocolo viejo). Va a storage.session porque el SW se duerme.
const sessions = new Map();
const sessionsReady = chrome.storage.session
  .get("sessions")
  .then(({ sessions: s }) => {
    for (const [k, v] of Object.entries(s ?? {})) if (!sessions.has(k)) sessions.set(k, v);
  })
  .catch(() => {});
const saveSessions = () => chrome.storage.session.set({ sessions: Object.fromEntries(sessions) }).catch(() => {});
chrome.tabs.onRemoved.addListener((tabId) => {
  let changed = false;
  for (const [k, v] of sessions) if (v === tabId) (sessions.delete(k), (changed = true));
  if (changed) void saveSessions();
});
const frame = { state: "off", tabId: null };
let frameTimer = null;
const running = new Map(); // id → AbortController de cada comando en vuelo
const recorder = { on: false, frames: [] };
const images = { shots: new Map() };

// La pestaña donde la persona platica con su agente (/c, la ficha, la app web) nunca se usa: si
// está activa, el agente trabaja en una pestaña nueva de su grupo, como Claude in Chrome.
const isChatSurface = (url) => /^https:\/\/(www\.)?ghosty\.studio\/(c|app)(\/|\?|#|$)/.test(url ?? "") || /^http:\/\/localhost:5180\/(c|app)(\/|\?|#|$)/.test(url ?? "");

// Sin tabId explícito el agente trabaja en SU grupo «Ghosty»: la pestaña activa del grupo o la más
// reciente; si no hay grupo, abre una pestaña nueva. Nunca toma la pestaña que la persona está usando.
// Una pestaña que ya es de otro agente no se toma: el segundo agente abre la suya en segundo plano.
async function pickTargetTab(session) {
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const windowId = win?.id ?? (await chrome.windows.getCurrent().catch(() => null))?.id;
  if (windowId == null) return null;
  const taken = new Set([...sessions].filter(([k]) => k !== session).map(([, v]) => v));
  const groupId = await groupOf(windowId);
  if (groupId != null) {
    const tabs = (await chrome.tabs.query({ groupId })).filter((t) => !taken.has(t.id));
    const pick = tabs.find((t) => t.active) ?? tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (pick) return pick.id;
  }
  const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: taken.size === 0 });
  return tab.id;
}
// Las elecciones van una a la vez: dos agentes que arrancan juntos no agarran la misma pestaña.
let picking = Promise.resolve();
async function targetTab(session = "") {
  await sessionsReady;
  const mine = sessions.get(session);
  if (mine != null) {
    try {
      await chrome.tabs.get(mine);
      return mine;
    } catch {}
  }
  const pick = picking.then(async () => {
    const again = sessions.get(session);
    if (again != null && (await chrome.tabs.get(again).catch(() => null))) return again;
    const id = await pickTargetTab(session);
    if (id == null) throw new Error("No hay ninguna pestaña abierta en Chrome.");
    sessions.set(session, id);
    void saveSessions();
    void ensureInGroup(id);
    return id;
  });
  picking = pick.catch(() => {});
  return pick;
}
function setTargetTab(id, session = "") {
  if (frame.tabId != null && frame.tabId !== id) void paintFrame(frame.tabId, "off");
  if (id == null) sessions.delete(session);
  else sessions.set(session, id);
  void saveSessions();
}

const tools = buildTools({
  targetTab,
  setTargetTab,
  signal: () => null, // cada llamada trae su propia señal (ver runCommand)
  complete: async ({ system, user }) => {
    // Sin conexión con Ghosty Studio (vía nativa sin sesión) no se espera: `find` busca local.
    if (state.status !== "connected") throw new Error("sin Ghosty Studio");
    await ensureOffscreen();
    const j = await chrome.runtime.sendMessage({ type: "relay-post", body: { type: "find", system, user } });
    if (!j?.ok) throw new Error(`find: ${j?.error ?? "sin respuesta"}`);
    return j.json?.text ?? "";
  },
  vision: true,
  onTiming: () => {},
  images,
  frame,
  recorder,
});
const byName = new Map(tools.map((t) => [t.name, t]));
const toolList = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

// Borde lila mientras llegan comandos; se apaga a los 4 s sin actividad.
async function frameOn(tabHint, session) {
  clearTimeout(frameTimer);
  const tabId = tabHint ?? (await targetTab(session).catch(() => null));
  if (tabId == null) return;
  if (frame.tabId != null && frame.tabId !== tabId) void paintFrame(frame.tabId, "off");
  frame.state = "work";
  frame.tabId = tabId;
  void paintFrame(tabId, "work");
  void markGroupBusy(tabId, true);
}
let burst = 0; // pasos de la tarea en curso (se reinicia al terminar)
// El depurador se queda pegado TODA la tarea (la barra «depurando este navegador» no aparece y
// desaparece en cada paso, que empujaba el viewport) y se suelta tras 30 s sin pasos o con Detener.
const DEBUGGER_IDLE_MS = 30_000;
let debuggerTimer = null;
function releaseDebuggerLater() {
  clearTimeout(debuggerTimer);
  debuggerTimer = setTimeout(
    () =>
      void cdp.detachAll().then(() => {
        publish({ debuggerAttached: cdp.attachedCount() > 0 });
        // Quedó alguna con un diálogo abierto: otra vuelta.
        if (cdp.attachedCount()) releaseDebuggerLater();
      }),
    DEBUGGER_IDLE_MS,
  );
}
function frameLater() {
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => {
    frame.state = "off";
    if (frame.tabId != null) void paintFrame(frame.tabId, "off");
    if (frame.tabId != null) void markGroupBusy(frame.tabId, false);
    // Fin de la tarea (4 s sin pasos): si la persona no está viendo esa pestaña, se le avisa.
    if (burst >= 2) void notifyDone(frame.tabId);
    burst = 0;
  }, 4000);
}

// ── Notificaciones: «terminé» y «necesito que inicies sesión» ──
async function tabHidden(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return !tab.active || !win?.focused;
}
async function notifyDone(tabId) {
  if (tabId == null || !(await tabHidden(tabId))) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  chrome.notifications.create(`tab:${tabId}:${Date.now()}`, { type: "basic", iconUrl: "icons/icon-128.png", title: "Ghosty terminó", message: tab?.title ? `Listo en «${tab.title.slice(0, 80)}».` : "Tu agente terminó en el navegador.", priority: 0 });
}
const loginNotified = new Map(); // host → cuándo se avisó (una vez cada 10 min)
// Una página de login: un campo de contraseña visible.
function pageNeedsLogin() {
  const pw = [...document.querySelectorAll("input[type=password]")].find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  });
  return pw ? { host: location.hostname, title: document.title } : null;
}
async function checkLogin(tabId) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageNeedsLogin }).catch(() => []);
  const need = r?.result;
  if (!need) return null;
  if (Date.now() - (loginNotified.get(need.host) ?? 0) > 10 * 60_000) {
    loginNotified.set(need.host, Date.now());
    chrome.notifications.create(`tab:${tabId}:${Date.now()}`, { type: "basic", iconUrl: "icons/icon-128.png", title: "Ghosty necesita que inicies sesión", message: `Inicia sesión en ${need.host} y dile a tu agente que siga.`, priority: 2, requireInteraction: true });
  }
  return need.host;
}
chrome.notifications.onClicked.addListener((nid) => {
  const tabId = Number(/^tab:(\d+):/.exec(nid)?.[1]);
  if (!tabId) return;
  chrome.tabs.get(tabId).then((t) => {
    chrome.tabs.update(tabId, { active: true });
    chrome.windows.update(t.windowId, { focused: true });
  }, () => {});
  chrome.notifications.clear(nid);
});

// Comandos en fila POR PESTAÑA: en la misma pestaña, uno a la vez (como un turno); en pestañas
// distintas (`tabId`), en paralelo — dos agentes no se esperan ni se pisan.
const queues = new Map();
function handleCommand(cmd, onProgress) {
  cmd.session = typeof cmd.session === "string" ? cmd.session.slice(0, 80) : "";
  // Sin tabId, cada agente (session) tiene su fila y su pestaña: dos conversaciones no se esperan.
  const key = cmd.input?.tabId != null ? `tab:${cmd.input.tabId}` : cmd.session ? `s:${cmd.session}` : "actual";
  const prev = queues.get(key) ?? Promise.resolve();
  const done = prev.then(() => runCommand(cmd, onProgress));
  const tail = done.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => queues.get(key) === tail && queues.delete(key));
  return done;
}

// Tope duro por tool: ninguna se queda colgada (ni detiene la fila de su pestaña).
function timeoutFor(tool, input) {
  if (tool === "wait_for") return (Math.min(30, Number(input?.time) || 0) + 35) * 1000;
  if (tool === "computer" && input?.action === "wait") return (Math.min(10, Number(input?.duration) || 1) + 15) * 1000;
  if (/^(gif_creator|file_upload|navigate|navigate_back|tabs)$/.test(tool)) return 60_000;
  if (tool === "find") return 25_000;
  return 45_000;
}
// Qué está haciendo cada tool, para el avance en vivo (MCP `notifications/progress` y el panel).
const PHASE = {
  navigate: "esperando a que la página termine de cargar",
  navigate_back: "esperando a que la página termine de cargar",
  read_page: "leyendo la página",
  find: "buscando el elemento",
  click: "dando clic y esperando a que la página reaccione",
  type: "escribiendo",
  file_upload: "subiendo el archivo",
  wait_for: "esperando el texto en la página",
  take_screenshot: "tomando la captura",
  gif_creator: "armando el GIF",
  tabs: "abriendo la pestaña",
};
async function runCommand({ id, tool, input, client, session }, onProgress) {
  const t0 = Date.now();
  let result;
  let error;
  if (Date.now() - state.stoppedAt < STOP_WINDOW_MS) {
    error = "La persona detuvo a Ghosty desde el navegador. Pregúntale en el chat antes de seguir.";
  } else if (!byName.has(tool)) {
    error = `tool desconocida: ${tool}`;
  } else {
    publish({ client, session: session || null, busy: tool });
    burst++;
    clearTimeout(debuggerTimer);
    // `tabs` no pinta el borde de antemano: pedir «la actual» abriría una pestaña en blanco.
    if (tool !== "tabs" || input?.tabId != null) await frameOn(input?.tabId != null ? Number(input.tabId) : undefined, session);
    const abort = new AbortController();
    running.set(id, abort);
    const limit = timeoutFor(tool, input);
    let timer;
    // Avance en vivo: una tool que pasa de 3 s avisa cada 2 s qué está haciendo y cuánto lleva.
    const started = Date.now();
    let tick = 0;
    const progress = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      if (secs < 3 || (secs - 3) % 2) return; // a los 3 s y luego cada 2 s
      tick++;
      const where = input?.tabId != null ? ` (tab ${input.tabId})` : "";
      const message = `${tool}: ${PHASE[tool] ?? "trabajando"}… ${secs} s${where}`;
      publish({ busy: `${tool} · ${secs} s` });
      try {
        onProgress?.({ progress: tick, message });
      } catch {}
    }, 1000);
    try {
      result = await Promise.race([
        byName.get(tool).execute(input ?? {}, { signal: abort.signal, session }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error(`La tool ${tool} no terminó en ${Math.round(limit / 1000)} s (se canceló). Revisa la página con read_page antes de seguir.`));
          }, limit);
        }),
      ]);
      // ¿Quedó en una página de login? Se avisa a la persona y se le dice al agente.
      const where = result?.tabId ?? (input?.tabId != null ? Number(input.tabId) : frame.tabId);
      // Con un diálogo nativo abierto la página está en pausa: cualquier executeScript se colgaría.
      if (/^(navigate|navigate_back|click|tabs|press_key)$/.test(tool) && where != null && !cdp.pendingDialog(where)) {
        const host = await checkLogin(where);
        // Captcha o 2FA: los resuelve la persona. Se le avisa y el agente espera.
        const [ch] = await chrome.scripting.executeScript({ target: { tabId: where }, func: pageChallenge }).catch(() => []);
        const challenge = ch?.result;
        if (challenge) {
          chrome.notifications.create(`tab:${where}:${Date.now()}`, { type: "basic", iconUrl: "icons/icon-128.png", title: challenge === "captcha" ? "Ghosty necesita que resuelvas un captcha" : "Ghosty necesita tu código de verificación", message: "Complétalo en la pestaña y dile a tu agente que siga.", priority: 2, requireInteraction: true });
          const cnote = challenge === "captcha"
            ? "\n\n[La página muestra un captcha. Lo resuelve la persona: no lo intentes ni lo rodees. Avisé con una notificación; dile que lo complete y espera a que te diga que siga.]"
            : "\n\n[La página pide un código de verificación (2FA / dos pasos). Lo escribe la persona: no lo pidas para teclearlo tú ni lo busques en su correo o teléfono. Avisé con una notificación; espera a que te diga que siga.]";
          if (typeof result === "string") result += cnote;
          else if (result && typeof result === "object" && !Array.isArray(result)) result = { ...result, challenge, note: cnote.trim() };
        }
        // Pagos y acuerdos legales: los decide la persona. Se avisa al agente para que se detenga.
        const [cm] = await chrome.scripting.executeScript({ target: { tabId: where }, func: pageCommitments }).catch(() => []);
        const commit = cm?.result;
        if (commit) {
          const what = [commit.payment ? `un pago («${commit.payment}»)` : "", commit.legal ? `aceptar ${commit.legal.map((l) => `«${l}»`).join(", ")}` : ""].filter(Boolean).join(" y ");
          const mnote = `\n\n[La página pide ${what}. Pagar y aceptar acuerdos los decide la persona: detente, cítale exactamente lo que pide y espera su respuesta. Nunca escribas datos de tarjeta.]`;
          if (typeof result === "string") result += mnote;
          else if (result && typeof result === "object" && !Array.isArray(result)) result = { ...result, commitment: commit, note: [result.note, mnote.trim()].filter(Boolean).join(" ") };
        }
        const note = host ? `\n\n[La página pide iniciar sesión en ${host}. Avisé a la persona con una notificación; pídele que inicie sesión ella (nunca tecleas contraseñas) y sigue cuando te diga.]` : "";
        if (note && typeof result === "string") result += note;
        else if (note && result && typeof result === "object" && !Array.isArray(result)) result = { ...result, login_required: host };
      }
    } catch (e) {
      error = e.message;
    } finally {
      clearTimeout(timer);
      clearInterval(progress);
      running.delete(id);
      frameLater();
      publish({ debuggerAttached: cdp.attachedCount() > 0 });
      releaseDebuggerLater();
    }
  }
  const ms = Date.now() - t0;
  const failed = !!error || !!result?.error;
  publish({ busy: null, lastStep: { tool, client, session: session || null, ms, ok: !failed, at: Date.now(), detail: String(error ?? result?.error ?? "").slice(0, 140) } });
  return { id, result, error };
}

function stop() {
  state.stoppedAt = Date.now();
  for (const a of running.values()) a.abort();
  clearTimeout(debuggerTimer);
  void cdp.detachAll();
  frame.state = "off";
  if (frame.tabId != null) void paintFrame(frame.tabId, "off");
  if (frame.tabId != null) void markGroupBusy(frame.tabId, false);
  publish({ busy: null, stoppedAt: state.stoppedAt });
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "fx-stop") stop();
  else if (msg?.type === "relay-cmd") {
    handleCommand(msg.cmd).then(reply, (e) => reply({ id: msg.cmd.id, error: e.message }));
    return true; // respuesta asíncrona
  } else if (msg?.type === "relay-state") publish(msg.patch);
  else if (msg?.type === "relay-tools") reply(toolList);
  else if (msg?.type === "relay-config") {
    const version = chrome.runtime.getManifest().version;
    const protocol = GHOSTY_BROWSER_PROTOCOL;
    chrome.storage.local.get("gsUrl").then(({ gsUrl }) => reply({ gs: allowedGs(gsUrl || DEFAULT_GS), version, protocol }), () => reply({ gs: DEFAULT_GS, version, protocol }));
    return true;
  } else if (msg?.type === "fx-reconnect" || msg?.type === "fx-reconnect-if-needed") {
    void ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: msg.type === "fx-reconnect" ? "relay-reconnect" : "relay-wake" }).catch(() => {}));
  }
});

// ── Atajos de teclado (manifest `commands`): _execute_action abre el panel; éste detiene. ──
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "stop-agent") stop();
});

// ── Páginas de Ghosty Studio (externally_connectable): se emparejan solas con la sesión ──
// /c manda `ghosty-pair` con una prueba de un solo uso firmada por gs y ligada a SU sesión. La extensión
// sólo la acepta de los orígenes exactos (www/apex en https; el servidor local sólo en la build de desarrollo),
// la verifica con ese gs (cookie de la persona) y entonces usa ESE gs. Por este canal NO se ejecutan
// tools: las tools llegan sólo por la conexión con gs y por el host nativo.
const PAGE_ORIGINS = ["https://www.ghosty.studio", "https://ghosty.studio", "http://localhost:5180"];
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  // `sender.origin` lo pone Chrome (la página no lo puede falsear).
  const origin = sender.origin ?? "";
  if (!PAGE_ORIGINS.includes(origin)) return;
  if (msg?.type === "ghosty-ping") return void reply({ ok: true, t: Date.now() });
  if (msg?.type === "ghosty-hello" || msg?.type === "ghosty-pair") {
    (async () => {
      let paired = null;
      if (msg.type === "ghosty-pair") {
        const gs = allowedGs(origin === "https://ghosty.studio" ? "https://www.ghosty.studio" : origin);
        await ensureOffscreen();
        const v = typeof msg.proof === "string" ? await chrome.runtime.sendMessage({ type: "relay-post", gs, body: { type: "pair", proof: msg.proof.slice(0, 2000) } }).catch(() => null) : null;
        paired = !!v?.json?.ok;
        if (paired) {
          const { gsUrl } = await chrome.storage.local.get("gsUrl");
          if ((gsUrl || DEFAULT_GS) !== gs) await chrome.storage.local.set({ gsUrl: gs }); // reconecta solo
          else if (state.status !== "connected") void chrome.runtime.sendMessage({ type: "relay-wake" }).catch(() => {});
        }
      }
      reply({ ok: true, version: chrome.runtime.getManifest().version, protocol: GHOSTY_BROWSER_PROTOCOL, status: state.status, ...(paired != null ? { paired } : {}), native: native.connected });
    })();
    return true;
  }
});

// ── Terminal en la misma Mac (nativeMessaging): `browser-mcp.mjs` → host nativo → aquí ──
// El host (`scripts/install-native-host.sh`) abre un socket local; cada petición llega como
// {id, tool, input, client} y se contesta {id, result, error}. Si el host no está instalado,
// se reintenta con la alarma sin hacer ruido.
const NATIVE_HOST = "studio.ghosty.browser";
const native = { port: null, connected: false };
function connectNative() {
  if (native.port) return;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    return;
  }
  native.port = port;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "hello") {
      native.connected = true;
      publish({ native: true });
      return;
    }
    if (msg?.type === "tools") return port.postMessage({ id: msg.id, result: toolList });
    if (msg?.type === "status") {
      return port.postMessage({ id: msg.id, result: { connected: true, via: "native", version: chrome.runtime.getManifest().version, build: await buildId, capabilities: CAPABILITIES, protocol: GHOSTY_BROWSER_PROTOCOL, gs: { status: state.status, email: state.email }, lastStep: state.lastStep, busy: state.busy } });
    }
    if (msg?.tool) {
      const r = await handleCommand({ id: msg.id, tool: msg.tool, input: msg.input ?? {}, client: msg.client ?? "Ghosty (terminal)", session: msg.session }, (p) => {
        try {
          port.postMessage({ id: msg.id, progress: p });
        } catch {}
      });
      try {
        port.postMessage(r);
      } catch {}
    }
  });
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message ?? null;
    const was = native.connected;
    native.port = null;
    native.connected = false;
    publish({ native: false, nativeError: why });
    // Se cayó un host que sí estaba: se reconecta en 1 s en vez de esperar la alarma de 30 s (la
    // terminal espera 8 s). Si no hay host instalado, `was` es false y no hay bucle.
    if (was) setTimeout(connectNative, 1000);
  });
}

// ── Documento offscreen: dueño de la conexión con gs ──
let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument().catch(() => false)) return;
  creating ??= chrome.offscreen
    .createDocument({ url: "relay.html", reasons: ["WORKERS"], justification: "Mantener la conexión con Ghosty Studio que trae los comandos del agente" })
    .catch((e) => {
      if (!/single offscreen/i.test(e.message)) throw e;
    })
    .finally(() => (creating = null));
  await creating;
}

// El SW puede dormirse: una alarma cada 30 s lo despierta y se asegura de que el offscreen viva.
chrome.alarms.create("ghosty-relay", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "ghosty-relay") return;
  void ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: "relay-wake" }).catch(() => {}));
  connectNative();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.gsUrl) void ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: "relay-reconnect" }).catch(() => {}));
});
publish({ status: "connecting" });
void ensureOffscreen();
connectNative();
