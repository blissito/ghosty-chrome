// Capturas para la Chrome Web Store (1280×800): la página trabajando + el panel lateral, compuestas.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "store", "capturas");
const GS = "http://localhost:5180";
const auth = { authorization: `Bearer ${process.env.GS_BROWSER_TOKEN}`, "content-type": "application/json" };
const FORM = readFileSync(join(import.meta.dirname, "fixtures/registro.html"));
const srv = http.createServer((q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FORM));
await new Promise((r) => srv.listen(5197, "127.0.0.1", r));

const browser = await puppeteer.launch({
  executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  headless: "new",
  userDataDir: mkdtempSync(join(tmpdir(), "fx-store-")),
  defaultViewport: null,
  args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`, "--no-first-run", "--window-size=1280,860"],
});
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extId = new URL(sw.url()).host;
const [page] = await browser.pages();
await page.setCookie({ name: "gs_session", value: process.env.GS_COOKIE, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" });
const panel = await browser.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await page.bringToFront();
for (const t0 = Date.now(); ; ) {
  const s = await (await fetch(`${GS}/api/browser/call`, { headers: auth })).json();
  if (s.connected && s.tools.length) break;
  if (Date.now() - t0 > 30_000) throw new Error("sin conexión");
  await new Promise((r) => setTimeout(r, 400));
}
const call = async (tool, input) => (await (await fetch(`${GS}/api/browser/call`, { method: "POST", headers: auth, body: JSON.stringify({ tool, input, client: "Ghosty" }) })).json()).result;
const refFor = (snap, re) => re.exec(snap)?.[1];

async function shot(pageW, name, opts = {}) {
  await page.setViewport({ width: pageW, height: 800 });
  const pageImg = await page.screenshot({ encoding: "base64" });
  // El panel en su tamaño real; el correo de la cuenta no sale en la ficha.
  await panel.setViewport({ width: 1280 - pageW, height: 800 });
  await panel.evaluate(() => {
    const s = document.getElementById("status");
    if (/^Conectado/.test(s.textContent)) s.textContent = "Conectado";
  });
  const panelImg = await panel.screenshot({ encoding: "base64" });
  const comp = await browser.newPage();
  await comp.setViewport({ width: 1280, height: 800 });
  await comp.setContent(`<body style="margin:0;display:flex;background:#0b0b0f"><img src="data:image/png;base64,${pageImg}" style="width:${pageW}px;height:800px;display:block"><div style="width:1px;background:#24242e"></div><img src="data:image/png;base64,${panelImg}" style="width:${1280 - pageW - 1}px;height:800px;object-fit:cover;object-position:left top;display:block"></body>`);
  await comp.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: 1280, height: 800 } });
  await comp.close();
  await page.bringToFront();
}

// 1. ghosty.studio: escribe en el compositor y da clic (borde lila + cursor con etiqueta).
await page.setViewport({ width: 900, height: 800 });
let snap = await call("navigate", { url: "https://www.ghosty.studio/" });
const box = refFor(snap, /textbox "Pide algo o encarga una tarea"[^\n]*\[ref=(e\d+)\]/);
await call("type", { target: box, text: "Hazme una landing para mi cafetería en Oaxaca" });
await call("click", { element: "pestaña", target: refFor(snap, /tab "Con tus clientes"[^\n]*\[ref=(e\d+)\]/) });
await shot(900, "1-ghosty-trabajando");

// 2. Formulario llenándose: la etiqueta del cursor queda en el último campo.
snap = await call("navigate", { url: "http://127.0.0.1:5197/" });
const r = (label) => refFor(snap, new RegExp(`(?:textbox|combobox) "${label}"[^\\n]*\\[ref=(e\\d+)\\]`));
await call("fill_form", {
  fields: [
    { name: "Nombre del negocio", type: "textbox", target: r("Nombre del negocio"), value: "Café Tierra Mixteca" },
    { name: "Contacto", type: "textbox", target: r("Contacto"), value: "Lucía Hernández" },
    { name: "Ciudad", type: "combobox", target: r("Ciudad"), value: "Oaxaca" },
    { name: "Pedido semanal", type: "textbox", target: r("Pedido semanal"), value: "40 conchas, 30 bolillos y 12 panes de yema, los lunes a las 7:00" },
  ],
});
await call("type", { target: r("Teléfono"), text: "951 123 4567" });
await call("hover", { element: "Requiere factura", target: refFor(snap, /checkbox "Requiere factura"[^\n]*\[ref=(e\d+)\]/) });
await shot(900, "2-formulario");

// 3. El panel en primer plano: conectado, quién lo usa y el último paso.
await call("navigate", { url: "https://www.ghosty.studio/planes" });
await call("read_page", {});
await shot(760, "3-panel");

await browser.close();
srv.close();
