// Prueba en prod con un agente de prueba (no de bliss): skill `navegador` y captura como imagen.
// Por la API de la app (bearer OAuth) y con la extensión de desarrollo emparejada sola vía /c.
import puppeteer from "puppeteer-core";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const GS = "https://www.ghosty.studio";
const d = JSON.parse(readFileSync(process.env.ACC, "utf8"));
const AG = process.env.AGENT ?? d.agentId;
const H = { authorization: `Bearer ${d.at}`, "content-type": "application/json" };
const api = async (p, init = {}) => (await fetch(`${GS}${p}`, { ...init, headers: H })).json().catch(() => null);
async function ask(sid, content, ms = 240_000) {
  const a = Date.now();
  const n0 = ((await api(`/api/v2/me/agents/${AG}/conversations/${sid}`))?.messages ?? []).length;
  const p = await fetch(`${GS}/api/v2/me/agents/${AG}/conversations/${sid}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content }) });
  if (p.status >= 300) return `HTTP ${p.status} ${(await p.text()).slice(0, 200)}`;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const c = await api(`/api/v2/me/agents/${AG}/conversations/${sid}`);
    const msgs = c?.messages ?? [];
    if (msgs.length >= n0 + 2 && msgs.at(-1).role !== "user" && !c.ultimoTurno?.enCurso) return `${Math.round((Date.now() - a) / 1000)} s · ${String(msgs.at(-1).text ?? msgs.at(-1).content ?? "").replace(/\s+/g, " ")}`;
    if (Date.now() - a > ms) return `(timeout) ${JSON.stringify(c?.ultimoTurno ?? null).slice(0, 200)}`;
  }
}
const sid = (await api(`/api/v2/me/agents/${AG}/conversations`, { method: "POST", body: "{}" }))?.id;
console.log("agente", AG, "conversación", sid);
console.log("1) skills:", (await ask(sid, "¿Qué skills tienes del navegador? Dime sus nombres exactos.")).slice(0, 500));
if (process.env.SKILLS_ONLY) process.exit(0);
const browser = await puppeteer.launch({ executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), headless: "new", userDataDir: mkdtempSync(join(tmpdir(), "fx-w-")), defaultViewport: null, args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`, "--window-size=1280,900"] });
await browser.waitForTarget((t) => t.type() === "service_worker");
const [page] = await browser.pages();
await page.setCookie({ name: "gs_session", value: d.cookie, domain: "www.ghosty.studio", path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
await page.goto(`${GS}/c`, { waitUntil: "networkidle2" });
for (const t0 = Date.now(); !(await api("/api/browser/call"))?.connected; ) if (Date.now() - t0 > 40_000) throw new Error("sin conexión"); else await new Promise((r) => setTimeout(r, 500));
console.log("extensión conectada");
// Lo que se pregunta sólo se sabe VIENDO la captura (colores, ilustración), no del texto.
const sid2 = (await api(`/api/v2/me/agents/${AG}/conversations`, { method: "POST", body: "{}" }))?.id;
console.log("2) captura:", (await ask(sid2, "Abre https://www.ghosty.studio en mi navegador, toma una captura con take_screenshot y dime SÓLO lo que ves en la imagen: de qué color es el fondo, de qué color es el botón «Probar gratis» y cómo es el personaje/ilustración que aparece. Si no recibiste una imagen, dilo.")).slice(0, 700));
const last = (await api("/api/browser/call"))?.lastStep;
console.log("último paso del navegador:", JSON.stringify(last));
await browser.close();
