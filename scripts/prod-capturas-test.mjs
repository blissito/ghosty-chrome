// Prueba en prod: las capturas del agente se ven en /c como tira de miniaturas (en vivo y al
// recargar). Cuenta de prueba claude-worker; /c real en Chrome for Testing con la extensión.
import puppeteer from "puppeteer-core";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "evidencia", "prod");
mkdirSync(OUT, { recursive: true });
const GS = "https://www.ghosty.studio";
const d = JSON.parse(readFileSync(process.env.ACC, "utf8"));
const H = { authorization: `Bearer ${d.at}` };
const browser = await puppeteer.launch({ executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), headless: "new", userDataDir: mkdtempSync(join(tmpdir(), "fx-cap-")), defaultViewport: null, args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`, "--window-size=1300,950"] });
await browser.waitForTarget((t) => t.type() === "service_worker");
const [page] = await browser.pages();
await page.setCookie({ name: "gs_session", value: d.cookie, domain: "www.ghosty.studio", path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
await page.goto(`${GS}/c`, { waitUntil: "networkidle2" });
for (const t0 = Date.now(); !(await (await fetch(`${GS}/api/browser/call`, { headers: H })).json())?.connected; ) if (Date.now() - t0 > 40_000) throw new Error("sin conexión"); else await new Promise((r) => setTimeout(r, 500));
console.log("extensión conectada; /c en", page.url());
const box = await page.waitForSelector("textarea", { timeout: 20_000 });
await box.click();
await box.type("Abre https://example.com y https://www.ghosty.studio/planes en mi navegador; en cada una toma una captura con take_screenshot. Luego dime en una línea qué viste en cada captura.");
const t0 = Date.now();
await page.keyboard.press("Enter");
let tira = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  tira = await page.evaluate(() => document.querySelectorAll('[aria-label^="Capturas del navegador"] button').length).catch(() => 0);
  const done = await page.evaluate(() => !document.querySelector('[aria-label="Detener"], button[title*="Detener"]')).catch(() => false);
  if ((tira >= 2 && done) || Date.now() - t0 > 180_000) break;
}
console.log(`en vivo: ${tira} miniaturas · ${Math.round((Date.now() - t0) / 1000)} s`);
await new Promise((r) => setTimeout(r, 4000));
const chatTab = (await browser.pages()).find((p) => /\/c\//.test(p.url())) ?? page;
await chatTab.bringToFront();
const imgsLive = await chatTab.evaluate(() => [...document.querySelectorAll('[aria-label^="Capturas del navegador"] img')].filter((i) => i.complete && i.naturalWidth > 0).length);
await chatTab.screenshot({ path: join(OUT, "capturas-en-vivo.png") });
await chatTab.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3000));
const tiraReload = await chatTab.evaluate(() => [...document.querySelectorAll('[aria-label^="Capturas del navegador"]')].map((t) => t.querySelectorAll("img").length));
const sueltas = await chatTab.evaluate(() => [...document.querySelectorAll("button[title]")].filter((b) => /^captura-\d+\.jpg$/.test(b.getAttribute("title") ?? "")).length);
await chatTab.screenshot({ path: join(OUT, "capturas-al-recargar.png") });
// Clic en la primera miniatura: se abre el panel de artefactos.
await chatTab.click('[aria-label^="Capturas del navegador"] button').catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const panel = await chatTab.evaluate(() => !!document.querySelector('[class*="artefact"], [data-artefacto], aside img'));
await chatTab.screenshot({ path: join(OUT, "capturas-panel.png") });
console.log(JSON.stringify({ imgsLive, tiraReload, sueltasComoEntrega: sueltas, panelAbierto: panel, url: chatTab.url() }));
await browser.close();
