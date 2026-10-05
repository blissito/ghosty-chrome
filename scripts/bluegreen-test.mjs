// Simulación local del blue/green de gs: dos cajas (A :5183, B :5184) detrás de un «www» (:5190) que
// cambia de caja como el takeover del deploy. Mientras el agente manda tools, A pasa a espera.
// Mide: tools idempotentes que siguen, clics en vuelo que avisan, y cuánto tarda en volver.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const BG = process.env.BG;
const sess = JSON.parse(readFileSync(process.env.SESS, "utf8"));
const WWW = "http://localhost:5190";
const auth = { authorization: `Bearer ${sess.token}`, "content-type": "application/json" };
// Una página con un botón LENTO: el clic tarda 3 s en volver (para que el corte lo agarre en vuelo).
const PAGE = `<!doctype html><title>banco</title><button id=b onclick="window.n=(window.n||0)+1">Lento</button><input id=t aria-label="Campo"><p>texto</p>`;
const srv = http.createServer((q, r) => r.writeHead(200, { "content-type": "text/html" }).end(PAGE));
await new Promise((r) => srv.listen(5195, "127.0.0.1", r));
const b = await puppeteer.launch({ executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), headless: "new", userDataDir: mkdtempSync(join(tmpdir(), "bg-")), args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`] });
const sw = await b.waitForTarget((t) => t.type() === "service_worker");
const [p] = await b.pages();
await p.setCookie({ name: "gs_session", value: sess.cookie, domain: "localhost", path: "/" });
await p.goto("http://127.0.0.1:5195/");
const panel = await b.newPage();
await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
await panel.evaluate((gs) => chrome.storage.local.set({ gsUrl: gs }), WWW);
await new Promise((r) => setTimeout(r, 500));
await panel.evaluate(() => chrome.runtime.sendMessage({ type: "fx-reconnect" }));
await p.bringToFront();
const status = async () => (await (await fetch(`${WWW}/api/browser/call`, { headers: auth })).json()).connected;
for (let i = 0; !(await status()); i++) { if (i > 80) { console.log(await panel.evaluate(() => chrome.storage.session.get("relay"))); throw new Error("no conectó"); } await new Promise((r) => setTimeout(r, 250)); }
console.log("conectada a A vía www");
const call = async (tool, input) => { const t0 = Date.now(); const j = await (await fetch(`${WWW}/api/browser/call`, { method: "POST", headers: auth, body: JSON.stringify({ tool, input, client: "bg-test" }) })).json().catch((e) => ({ ok: false, error: e.message })); return { tool, ok: j.ok, ms: Date.now() - t0, err: j.error?.slice(0, 90) }; };
const snap = String((await call("read_page", {})).ok);
// Aguanta el clic 3 s DENTRO de la extensión: wait_for no es clic, así que para el clic en vuelo se usa
// `computer wait` (idempotente) y `press_key` (no idempotente) con una espera previa en la página.
const tasks = [];
const loop = async (label, fn, n) => { for (let i = 0; i < n; i++) { tasks.push({ label, ...(await fn()) }); } };
const switchAt = Date.now() + 2500;
setTimeout(() => {
  // Deploy: www pasa a B (takeover), B entra como activa, y 1 s después A pasa a espera.
  writeFileSync(join(BG, "b-active"), "");
  writeFileSync(join(BG, "target"), "5184");
  setTimeout(() => rmSync(join(BG, "a-active"), { force: true }), 1000);
  console.log("— cambio de caja A → B —");
}, 2500);
await Promise.all([
  loop("read_page", () => call("read_page", {}), 12),
  loop("lento-idempotente", () => call("computer", { action: "wait", duration: 3 }), 3),
  loop("lento-no-idempotente", () => call("wait_for", { time: 3 }).then(() => call("press_key", { key: "a" })), 2),
  // Tecleo lento (no idempotente) que cruza el cambio de caja: debe avisar, no repetirse.
  new Promise((r) => setTimeout(r, 1500)).then(() => loop("teclear-en-vuelo", () => call("type", { target: "#t", text: "x".repeat(400), slowly: true }), 1)),
]);
const t1 = Date.now();
for (const t of tasks) console.log(`${t.ok ? "✓" : "✗"} ${t.label.padEnd(22)} ${t.tool.padEnd(10)} ${String(t.ms).padStart(6)} ms ${t.err ?? ""}`);
console.log("conectada al final:", await status(), "· ok", tasks.filter((t) => t.ok).length, "/", tasks.length, "· tecleado:", await p.evaluate(() => document.getElementById("t").value.length));
await b.close(); srv.close();
