// Prueba en prod de turnos programados con el navegador (como la app iOS, por la API):
// A) con Chrome conectado → el turno de las HH:MM maneja el navegador; B) con Chrome cerrado → el
// agente recibe «no conectado» (y gs manda push a la persona).
import puppeteer from "puppeteer-core";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const GS = "https://www.ghosty.studio";
const sess = JSON.parse(readFileSync(process.env.SESS, "utf8"));
const AT = JSON.parse(readFileSync(process.env.IOS, "utf8")).at;
const H = { authorization: `Bearer ${AT}`, "content-type": "application/json" };
const AG = "cmutz706h0001gbw4ebz4pbt8";
const api = async (p, init = {}) => (await fetch(`${GS}${p}`, { ...init, headers: H })).json().catch(() => null);
const agentMsgs = async (sid) => ((await api(`/api/v2/me/agents/${AG}/conversations/${sid}`))?.messages ?? []).filter((m) => m.role === "agent");

const browser = await puppeteer.launch({ executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), headless: "new", userDataDir: mkdtempSync(join(tmpdir(), "fx-sch-")), defaultViewport: null, args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`] });
await browser.waitForTarget((t) => t.type() === "service_worker");
const [page] = await browser.pages();
await page.setCookie({ name: "gs_session", value: sess.cookie, domain: "www.ghosty.studio", path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
await page.goto(`${GS}/c`, { waitUntil: "networkidle2" });
for (const t0 = Date.now(); !(await api("/api/browser/call"))?.connected; ) if (Date.now() - t0 > 40_000) throw new Error("sin conexión"); else await new Promise((r) => setTimeout(r, 500));

const sid = (await api(`/api/v2/me/agents/${AG}/conversations`, { method: "POST", body: "{}" })).id;
// Programar por la API de la app (lo mismo que hace la tool programar_seguimiento del agente).
const programar = (prompt) => api(`/api/v2/me/agents/${AG}/conversations/${sid}/schedule`, { method: "POST", body: JSON.stringify({ prompt, inMinutes: 1 }) });
const wait = async (n, ms) => { const t0 = Date.now(); for (;;) { const a = await agentMsgs(sid); if (a.length >= n) return a.at(-1); if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 5000)); } };

if (!process.env.ONLY_B) console.log("A programado:", JSON.stringify(await programar("Abre ghosty.studio/planes en mi navegador y dime el precio de Pro.")).slice(0, 120));
const a = await wait(1, 200_000);
console.log("A respuesta:", String(a?.text ?? a?.content ?? "(nada)").replace(/\s+/g, " ").slice(0, 220));
const pasos = (await api("/api/browser/call"))?.lastStep;
console.log("A último paso del navegador:", JSON.stringify(pasos));

await browser.close();
await new Promise((r) => setTimeout(r, 30_000)); // gs la da por desconectada a los 25 s sin pong
console.log("B conectado tras cerrar Chrome:", (await api("/api/browser/call"))?.connected);
console.log("B programado:", JSON.stringify(await programar("Abre ghosty.studio/docs en mi navegador y dime el título de la página; si la tool falla, dime el error tal cual.")).slice(0, 120));
const b = await wait(2, 200_000);
console.log("B respuesta:", String(b?.text ?? b?.content ?? "(nada)").replace(/\s+/g, " ").slice(0, 260));
