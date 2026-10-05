// Motor CDP (chrome.debugger): input *trusted* (pasa React, canvas y menús que ignoran el.click()),
// capturas sin activar la pestaña, JavaScript, consola, red y archivos.
//
// Se engancha una vez por pestaña y se queda enganchado mientras el panel viva; Chrome muestra la
// barra «Ghosty está depurando este navegador», igual que con Claude in Chrome. Si la persona la
// cierra (o abre DevTools), `onDetach` limpia y el siguiente comando se vuelve a enganchar.

const VERSION = "1.3";
const MAX_BUFFER = 500;
// Un diálogo nativo sin contestar se cancela solo a los 2 min (da tiempo de pedir el sí en el chat).
const DIALOG_TTL_MS = 120_000;

const attached = new Map(); // tabId → { console: [], network: Map(requestId → req) }

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const st = attached.get(tabId);
  if (!st) return;
  if (method === "Runtime.consoleAPICalled") {
    const text = params.args.map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.type)).join(" ");
    pushCapped(st.console, { level: params.type, text, url: params.stackTrace?.callFrames?.[0]?.url ?? "", at: params.timestamp, nav: st.navs });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails;
    pushCapped(st.console, { level: "exception", text: d.exception?.description ?? d.text, url: d.url ?? "", at: params.timestamp, nav: st.navs });
  } else if (method === "Log.entryAdded") {
    const e = params.entry;
    pushCapped(st.console, { level: e.level, text: e.text, url: e.url ?? "", at: e.timestamp, nav: st.navs });
  } else if (method === "Network.requestWillBeSent") {
    // `seq` ordena las peticiones para saber cuáles nacieron durante una acción (waitForCompletion).
    // Una redirección reusa el requestId: se conserva el seq original.
    const prev = st.network.get(params.requestId);
    st.network.set(params.requestId, { id: params.requestId, method: params.request.method, url: params.request.url, type: params.type, at: params.wallTime, seq: prev?.seq ?? ++st.seq, isNavigation: params.type === "Document" && params.requestId === params.loaderId, finished: false, nav: st.navs });
    if (st.network.size > MAX_BUFFER) st.network.delete(st.network.keys().next().value);
  } else if (method === "Network.responseReceived") {
    const r = st.network.get(params.requestId);
    if (r) Object.assign(r, { status: params.response.status, mimeType: params.response.mimeType });
  } else if (method === "Network.loadingFinished") {
    const r = st.network.get(params.requestId);
    if (r) r.finished = true;
  } else if (method === "Network.loadingFailed") {
    const r = st.network.get(params.requestId);
    if (r) Object.assign(r, { failed: params.errorText ?? "failed", finished: true });
  } else if (method === "Page.javascriptDialogOpening") {
    // alert/confirm/prompt/beforeunload: la página queda en PAUSA (ni scripts ni eventos) hasta que
    // alguien lo conteste. Se guarda para avisar al agente en vez de colgarse.
    const d = (st.dialog = { type: params.type, message: String(params.message ?? "").slice(0, 500), defaultPrompt: params.defaultPrompt ?? "", url: params.url ?? "", at: Date.now() });
    for (const w of st.dialogWaiters.splice(0)) w(d);
    // Nadie lo contestó (ni el agente ni la persona): se cancela solo para no dejar la página en pausa.
    setTimeout(() => {
      if (attached.get(tabId)?.dialog === d) void handleDialog(tabId, false).catch(() => {});
    }, DIALOG_TTL_MS);
  } else if (method === "Page.fileChooserOpened") {
    // Con la intercepción encendida (sólo durante una acción del agente) Chrome NO abre el selector de
    // archivos del sistema: avisa con el input, y file_upload lo llena sin que la persona vea nada.
    st.chooser = { backendNodeId: params.backendNodeId, mode: params.mode, at: Date.now() };
  } else if (method === "Page.javascriptDialogClosed") {
    st.dialog = null;
  } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
    // Navegación de la página principal: los buffers se quedan (como DevTools con «preserve log»)
    // pero se marca el corte.
    st.navs++;
    pushCapped(st.console, { level: "info", text: `— navegó a ${params.frame.url} —`, url: params.frame.url, at: Date.now() / 1000, nav: st.navs, marker: true });
  }
});

function pushCapped(arr, item) {
  arr.push(item);
  if (arr.length > MAX_BUFFER) arr.splice(0, arr.length - MAX_BUFFER);
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, VERSION);
  } catch (e) {
    // Otro cliente (DevTools abierto, otra extensión) ya está enganchado.
    if (!/already attached/i.test(e.message)) throw new Error(`No pude engancharme a la pestaña (${e.message}). Si tiene DevTools abierto, ciérralo.`);
  }
  attached.set(tabId, { console: [], network: new Map(), seq: 0, navs: 0, dialog: null, dialogWaiters: [] });
  await Promise.all(["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"].map((m) => chrome.debugger.sendCommand({ tabId }, m).catch(() => {})));
  await keepAlive(tabId);
}

/**
 * Pestañas en SEGUNDO PLANO (trabajo en paralelo): Chrome las congela y deja de pintarlas, y entonces
 * un script inyectado o una captura esperan para siempre. Como Claude in Chrome: se emula el foco y se
 * fuerza el ciclo de vida «active». Se repite antes de cada tool en una pestaña oculta.
 */
export async function keepAlive(tabId) {
  await Promise.all([
    chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {}),
    chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" }).catch(() => {}),
  ]);
}

// ── Diálogos nativos (alert/confirm/prompt/beforeunload) ──

/** El diálogo abierto en la pestaña, o null. */
export function pendingDialog(tabId) {
  return attached.get(tabId)?.dialog ?? null;
}

/** Promesa que se cumple cuando la pestaña abre un diálogo nativo (nunca se rechaza). */
export function dialogOpened(tabId) {
  const st = attached.get(tabId);
  if (!st) return new Promise(() => {});
  if (st.dialog) return Promise.resolve(st.dialog);
  return new Promise((r) => st.dialogWaiters.push(r));
}

export async function handleDialog(tabId, accept, promptText) {
  const d = pendingDialog(tabId);
  if (!d) throw new Error("No hay ningún diálogo abierto en esa pestaña.");
  await send(tabId, "Page.handleJavaScriptDialog", { accept: !!accept, ...(promptText != null && d.type === "prompt" ? { promptText: String(promptText) } : {}) });
  const st = attached.get(tabId);
  if (st) st.dialog = null;
  return d;
}

// ── Selector de archivos ──

/** Intercepta (o deja de interceptar) el selector de archivos del sistema en la pestaña. */
export async function interceptChooser(tabId, on) {
  const st = attached.get(tabId);
  if (!st || st.intercepting === on) return;
  st.intercepting = on;
  await send(tabId, "Page.setInterceptFileChooserDialog", { enabled: on }).catch(() => {});
}

/** El selector que se interceptó y nadie ha llenado (2 min), o null. */
export function pendingChooser(tabId) {
  const c = attached.get(tabId)?.chooser;
  return c && Date.now() - c.at < 120_000 ? c : null;
}

/** Llena el input del selector interceptado y apaga la intercepción. */
export async function fillChooser(tabId, files) {
  const st = attached.get(tabId);
  const c = pendingChooser(tabId);
  if (!c) throw new Error("No hay selector de archivos interceptado.");
  await send(tabId, "DOM.setFileInputFiles", { backendNodeId: c.backendNodeId, files: c.mode === "selectSingle" ? files.slice(0, 1) : files });
  st.chooser = null;
  await interceptChooser(tabId, false);
}

export async function send(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    // Se soltó entre comandos (barra cerrada): un reintento con enganche nuevo.
    if (/not attached|detached/i.test(e.message)) {
      attached.delete(tabId);
      await attach(tabId);
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw e;
  }
}

export async function detachAll() {
  // Una pestaña con un diálogo nativo abierto se queda enganchada: soltarla perdería el diálogo (y su
  // cancelación automática); se suelta en la siguiente vuelta.
  const free = [...attached.entries()].filter(([, st]) => !st.dialog).map(([tabId]) => tabId);
  await Promise.all(free.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
  for (const tabId of free) attached.delete(tabId);
}

export const isAttached = (tabId) => attached.has(tabId);
export const attachedCount = () => attached.size;

// ── Consola y red ──

// Severidad como Playwright MCP: cada nivel incluye los más severos.
const SEVERITY = { error: 0, exception: 0, assert: 0, warning: 1, warn: 1, info: 2, log: 2, verbose: 3, debug: 3, trace: 3 };
const LEVEL_MAX = { error: 0, warning: 1, info: 2, debug: 3 };

export function consoleMessages(tabId, { level = "info", all = false, pattern, limit = 100, clear } = {}) {
  const st = attached.get(tabId);
  if (!st) return null;
  const re = pattern ? new RegExp(pattern, "i") : null;
  const max = LEVEL_MAX[level] ?? 2;
  let list = st.console.filter((m) => !m.marker && (all || m.nav === st.navs) && (SEVERITY[m.level] ?? 2) <= max && (!re || re.test(m.text) || re.test(m.url) || re.test(m.level)));
  list = list.slice(-limit);
  if (clear) st.console.length = 0;
  return list;
}

const STATIC = new Set(["Image", "Font", "Script", "Stylesheet", "Media", "Manifest", "Other"]);

/** Como browser_network_requests: sin estáticos exitosos salvo `static`; `filter` es regex de URL. */
export function networkRequests(tabId, { filter, static: withStatic = false, limit = 100, clear } = {}) {
  const st = attached.get(tabId);
  if (!st) return null;
  const re = filter ? new RegExp(filter, "i") : null;
  const list = [...st.network.values()]
    .filter((r) => r.nav === st.navs || r.isNavigation)
    .filter((r) => withStatic || !(STATIC.has(r.type) && !r.failed && (r.status ?? 200) < 400))
    .filter((r) => !re || re.test(r.url))
    .slice(-limit);
  if (clear) st.network.clear();
  return list;
}

export const requestSeq = (tabId) => attached.get(tabId)?.seq ?? 0;
export const requestsSince = (tabId, seq) => [...(attached.get(tabId)?.network.values() ?? [])].filter((r) => r.seq > seq);

// ── Input trusted ──

const BUTTON = { left: "left", right: "right", middle: "middle" };

export async function mouseMove(tabId, x, y) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

export async function mouseClick(tabId, x, y, { button = "left", clickCount = 1, modifiers = 0 } = {}) {
  await mouseMove(tabId, x, y);
  for (let i = 1; i <= clickCount; i++) {
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: BUTTON[button] ?? "left", clickCount: i, modifiers });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: BUTTON[button] ?? "left", clickCount: i, modifiers });
  }
}

export async function mouseDrag(tabId, from, to) {
  await mouseMove(tabId, from.x, from.y);
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
}

export async function wheel(tabId, x, y, deltaX, deltaY) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

export async function insertText(tabId, text) {
  await send(tabId, "Input.insertText", { text });
}

// Teclas con nombre (formato xdotool, como computer use: "Enter", "ctrl+a", "cmd+shift+t").
const KEYS = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  comma: { key: ",", code: "Comma", keyCode: 188, text: "," },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
const MODS = { alt: 1, option: 1, ctrl: 2, control: 2, cmd: 4, meta: 4, command: 4, super: 4, shift: 8 };

function keyDef(name) {
  const k = KEYS[name.toLowerCase()];
  if (k) return k;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /[a-z]/i.test(name);
    const isDigit = /[0-9]/.test(name);
    return { key: name, code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : "", keyCode: upper.charCodeAt(0), text: name };
  }
  throw new Error(`Tecla desconocida: ${name}`);
}

/** `combo`: "Enter", "ctrl+a", "cmd+shift+t". Varias separadas por espacio: "Tab Tab Enter". */
export async function pressKeys(tabId, combo) {
  for (const chord of String(combo).trim().split(/\s+/)) {
    const parts = chord.split("+");
    const main = parts.pop();
    let modifiers = 0;
    for (const m of parts) {
      const bit = MODS[m.toLowerCase()];
      if (bit === undefined) throw new Error(`Modificador desconocido: ${m}`);
      modifiers |= bit;
    }
    const k = keyDef(main);
    // Con modificadores (salvo shift) no se manda texto: si no, ctrl+a escribiría «a».
    const text = modifiers & ~8 ? undefined : k.text;
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    // En Mac, los atajos de edición (cmd+a/c/v/x/z) los ejecuta el navegador por `commands`.
    const commands = modifiers & 4 && /^[acvxz]$/i.test(main) ? [{ a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" }[main.toLowerCase()]] : undefined;
    await send(tabId, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) });
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

// ── Capturas ──

/**
 * Captura en píxeles CSS (las coordenadas de la imagen = las de los clics). `clip` opcional {x,y,w,h}
 * y `scale` para el zoom. ⚠️ Nunca se pide a CDP con `clip`/`scale`: eso emula otras métricas por un
 * instante y la página «vibra» en Chrome con ventana (medido en blissmo al grabar un GIF). Se captura
 * el viewport tal cual, en píxeles del dispositivo, y se recorta y escala aquí con OffscreenCanvas.
 */
export async function screenshot(tabId, { clip, scale, format = "jpeg", quality = 75 } = {}) {
  const m = await send(tabId, "Page.getLayoutMetrics");
  const vw = m.cssVisualViewport?.clientWidth ?? m.layoutViewport.clientWidth;
  const vh = m.cssVisualViewport?.clientHeight ?? m.layoutViewport.clientHeight;
  // En una pestaña de fondo la captura puede no llegar nunca: tope de 10 s con error claro.
  const r = await Promise.race([
    send(tabId, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("La captura no llegó en 10 s (pestaña en segundo plano sin pintar). Inténtalo con la pestaña activa (tabs select).")), 10_000)),
  ]);
  const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.data}`)).blob());
  // DPR real = ancho de la captura / ancho CSS del viewport.
  const dpr = bmp.width / vw;
  const region = clip ? { x: clip.x, y: clip.y, w: clip.w, h: clip.h } : { x: 0, y: 0, w: vw, h: vh };
  const s = scale ?? 1;
  const outW = Math.max(1, Math.round(region.w * s));
  const outH = Math.max(1, Math.round(region.h * s));
  const canvas = new OffscreenCanvas(outW, outH);
  canvas.getContext("2d").drawImage(bmp, region.x * dpr, region.y * dpr, region.w * dpr, region.h * dpr, 0, 0, outW, outH);
  bmp.close();
  const out = await canvas.convertToBlob({ type: `image/${format}`, ...(format === "jpeg" ? { quality: quality / 100 } : {}) });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), mimeType: `image/${format}`, width: outW, height: outH, viewport: { width: vw, height: vh } };
}

// ── JavaScript y archivos ──

export async function evaluate(tabId, expression) {
  const r = await send(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 10_000 });
  if (r.exceptionDetails) return { ok: false, error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return { ok: true, type: r.result.type, value: r.result.value ?? r.result.description ?? null };
}

/** Pone archivos LOCALES (rutas absolutas) en un <input type=file> elegido por selector. */
export async function setFileInputFiles(tabId, selector, files) {
  const { root } = await send(tabId, "DOM.getDocument", { depth: 0 });
  const { nodeId } = await send(tabId, "DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`No encontré ${selector}`);
  await send(tabId, "DOM.setFileInputFiles", { nodeId, files });
}
