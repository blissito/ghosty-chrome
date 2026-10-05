// Prueba en producción: la extensión de la tienda (store/build/ext) en Chrome for Testing, la
// cuenta de prueba con sesión, y en /c se le pide al agente que use el navegador.
import puppeteer from "puppeteer-core";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "evidencia", "prod");
mkdirSync(OUT, { recursive: true });
const GS = "https://www.ghosty.studio";
const sess = JSON.parse(readFileSync(process.env.SESS, "utf8"));
const auth = { authorization: `Bearer ${sess.token}` };
const PROMPT = process.env.PROMPT ?? "abre ghosty.studio/planes y dime el precio de Pro";

const browser = await puppeteer.launch({
  executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  headless: process.env.HEADFUL ? false : "new",
  userDataDir: mkdtempSync(join(tmpdir(), "fx-prod-")),
  defaultViewport: null,
  args: [`--disable-extensions-except=${ROOT}/store/build/ext`, `--load-extension=${ROOT}/store/build/ext`, "--no-first-run", "--window-size=1280,900"],
});
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extId = new URL(sw.url()).host;
const [page] = await browser.pages();
await page.setCookie({ name: "gs_session", value: sess.cookie, domain: "www.ghosty.studio", path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
const panel = await browser.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
const tc = Date.now();
for (;;) {
  const s = await (await fetch(`${GS}/api/browser/call`, { headers: auth })).json();
  if (s.connected && s.tools?.length) break;
  if (Date.now() - tc > 45_000) {
    console.log("panel:", await panel.evaluate(() => document.querySelector("main").innerText));
    throw new Error("la extensión no se conectó a prod");
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`extensión conectada a prod en ${Date.now() - tc} ms`);

await page.bringToFront();
await page.goto(`${GS}/c`, { waitUntil: "networkidle2" });
await page.screenshot({ path: join(OUT, "c-antes.png") });
const box = await page.waitForSelector("textarea", { timeout: 20_000 });
await box.click();
await box.type(PROMPT);
const t0 = Date.now();
await page.keyboard.press("Enter");
// Espera la respuesta: el último paso del relay y un precio en el hilo.
let firstTool = null;
let reply = "";
for (;;) {
  const s = await (await fetch(`${GS}/api/browser/call`, { headers: auth })).json();
  if (s.lastStep && !firstTool) firstTool = { ...s.lastStep, sinceSend: Date.now() - t0 };
  reply = await page.evaluate(() => document.body.innerText).catch(() => reply);
  if (/\$\s?\d{3}/.test(reply.split(PROMPT).slice(1).join(" ")) && Date.now() - t0 > 3000) break;
  if (Date.now() - t0 > 180_000) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const total = Date.now() - t0;
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: join(OUT, "c-despues.png") });
const tabs = (await browser.pages()).map((p) => p.url());
const after = reply.split(PROMPT).slice(1).join(" ").replace(/\s+/g, " ").slice(0, 400);
console.log(JSON.stringify({ totalMs: total, firstTool, tabs, reply: after }, null, 1));
await browser.close();
