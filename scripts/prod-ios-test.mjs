// Prueba en prod como la app iOS: bearer OAuth del cliente `ghosty-app-ios`, conversación por la API
// /api/v2/me/…, y el Chrome de la persona (Chrome for Testing con ext/ de desarrollo) emparejado solo
// al abrir www.ghosty.studio/c (externally_connectable). Mide también página→extensión vs relay.
import puppeteer from "puppeteer-core";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "evidencia", "prod");
mkdirSync(OUT, { recursive: true });
const GS = "https://www.ghosty.studio";
const sess = JSON.parse(readFileSync(process.env.SESS, "utf8"));
const AT = JSON.parse(readFileSync(process.env.IOS, "utf8")).at;
const bearer = { authorization: `Bearer ${AT}`, "content-type": "application/json", "user-agent": "GhostyApp/99 CFNetwork" };
const api = async (path, init = {}) => {
  const r = await fetch(`${GS}${path}`, { ...init, headers: { ...bearer, ...(init.headers ?? {}) } });
  const t = await r.text();
  try {
    return { status: r.status, json: JSON.parse(t) };
  } catch {
    return { status: r.status, text: t.slice(0, 300) };
  }
};

const browser = await puppeteer.launch({
  executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  headless: "new",
  userDataDir: mkdtempSync(join(tmpdir(), "fx-ios-")),
  defaultViewport: null,
  args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`, "--no-first-run", "--window-size=1280,900"],
});
await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const [page] = await browser.pages();
await page.setCookie({ name: "gs_session", value: sess.cookie, domain: "www.ghosty.studio", path: "/", httpOnly: true, secure: true, sameSite: "Lax" });

// 1) Emparejamiento: abrir /c basta (la extensión de desarrollo arranca apuntando a localhost).
const t0 = Date.now();
await page.goto(`${GS}/c`, { waitUntil: "networkidle2" });
let st;
for (;;) {
  st = (await api("/api/browser/call")).json; // 2) OAuth first-party
  if (st?.connected) break;
  if (Date.now() - t0 > 45_000) throw new Error(`no se emparejó: ${JSON.stringify(st).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`emparejada sola al abrir /c y conectada a prod en ${Date.now() - t0} ms (consulta con bearer OAuth de ghosty-app-ios)`);

if (process.env.SKIP_LAT) { /* sin medición */ }
// 3) Latencia: página → extensión directo vs agente → gs → extensión.
const direct = await page.evaluate(async () => {
  const id = "okgofgcccjajcokgpjmdlpgjpjoibpca";
  const once = (msg) => new Promise((res) => { const a = performance.now(); chrome.runtime.sendMessage(id, msg, (r) => res({ ms: Math.round(performance.now() - a), ok: !!r })); });
  const ping = []; for (let i = 0; i < 5; i++) ping.push((await once({ type: "ghosty-ping" })).ms);
  const tool = []; for (let i = 0; i < 5; i++) tool.push((await once({ type: "ghosty-tool", tool: "viewport", input: {} })).ms);
  return { ping, tool };
});
const relay = [];
for (let i = 0; i < 5; i++) {
  const a = Date.now();
  const r = await api("/api/browser/call", { method: "POST", body: JSON.stringify({ tool: "viewport", input: {}, client: "medición" }) });
  relay.push({ total: Date.now() - a, gs: r.json?.ms });
}
console.log("página→extensión ping ms", direct.ping, "· tool viewport ms", direct.tool);
console.log("relay vía gs (desde aquí) ms", relay.map((r) => `${r.total}(gs ${r.gs})`).join(" "));

// 4) Como la app iOS: agente, conversación nueva, mensaje y lectura del hilo.
const agents = (await api("/api/v2/me/agents")).json;
const agent = (agents.agentes ?? agents.agents ?? [])[0];
console.log("agente:", agent?.id, agent?.nombre, agent?.motor);
async function ask(sid, content, until, ms = 150_000) {
  const a = Date.now();
  const p = await api(`/api/v2/me/agents/${agent.id}/conversations/${sid}/messages`, { method: "POST", body: JSON.stringify({ content }) });
  if (p.status >= 300) return { error: `${p.status} ${JSON.stringify(p.json ?? p.text).slice(0, 200)}` };
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const c = await api(`/api/v2/me/agents/${agent.id}/conversations/${sid}`);
    const msgs = c.json?.messages ?? [];
    const last = msgs.filter((m) => m.role === "assistant").at(-1);
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const after = msgs.length && msgs.at(-1)?.role === "assistant";
    if (after && until(text)) return { ms: Date.now() - a, text };
    if (Date.now() - a > ms) return { ms: Date.now() - a, text: `(timeout) ${text}` };
  }
}
const sid = (await api(`/api/v2/me/agents/${agent.id}/conversations`, { method: "POST", body: "{}" })).json?.id;
console.log("conversación:", sid);
const results = {};
results.planes = await ask(sid, "Abre ghosty.studio/planes en mi navegador, toma una captura y dime el precio de Pro y qué se ve en la captura.", (t) => /\$\s?\d{3}/.test(t));
console.log("planes:", results.planes.ms, "ms ·", String(results.planes.text).replace(/\s+/g, " ").slice(0, 300));
results.atajo1 = await ask(sid, "Guarda esto como atajo /precios: abre ghosty.studio/planes en mi navegador y dime el precio de Pro.", (t) => /precios/i.test(t));
console.log("guardar atajo:", String(results.atajo1.text).replace(/\s+/g, " ").slice(0, 160));
results.atajo2 = await ask(sid, "/precios", (t) => /\$\s?\d{3}/.test(t));
console.log("/precios:", results.atajo2.ms, "ms ·", String(results.atajo2.text).replace(/\s+/g, " ").slice(0, 200));
results.gif = await ask(sid, "Grábame lo que hagas: abre ghosty.studio/planes, baja un poco y regresa arriba; luego exporta el GIF.", (t) => /gif/i.test(t), 200_000);
console.log("gif:", results.gif.ms, "ms ·", String(results.gif.text).replace(/\s+/g, " ").slice(0, 300));
const conv = (await api(`/api/v2/me/agents/${agent.id}/conversations/${sid}`)).json;
writeFileSync(join(OUT, "ios-hilo.json"), JSON.stringify({ direct, relay, results, files: conv?.files ?? conv?.deliveries ?? null }, null, 1));
await browser.close();
