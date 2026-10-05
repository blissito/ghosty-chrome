// ¿«Vibra» la página en cada acción? Cuenta eventos `resize` y cambios de innerHeight/outerHeight
// en la pestaña mientras el agente hace pasos (con grabación GIF y capturas), y si el depurador
// se suelta y se vuelve a pegar entre pasos (eso mueve la barra «depurando este navegador»).
import puppeteer from "puppeteer-core";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const sess = JSON.parse(readFileSync(process.env.SESS, "utf8"));
const auth = { authorization: `Bearer ${sess.token}`, "content-type": "application/json" };
const PAGE = readFileSync(join(ROOT, "scripts/fixtures/banco.html"), "utf8").replace("</body>", `<script>window.__rz=0;window.__h=[];addEventListener("resize",()=>{__rz++;__h.push(innerWidth+"x"+innerHeight)});</script></body>`);
const srv = http.createServer((q, r) => r.writeHead(200, { "content-type": "text/html" }).end(PAGE));
await new Promise((r) => srv.listen(5196, "127.0.0.1", r));
const b = await puppeteer.launch({ executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), headless: process.env.HEADFUL ? false : "new", userDataDir: mkdtempSync(join(tmpdir(), "vib-")), defaultViewport: null, args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`, "--window-size=1200,850", "--force-device-scale-factor=2"] });
const sw = await b.waitForTarget((t) => t.type() === "service_worker");
const [p] = await b.pages();
await p.setCookie({ name: "gs_session", value: sess.cookie, domain: "localhost", path: "/" });
await p.goto("http://127.0.0.1:5196/");
const panel = await b.newPage();
await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
await p.bringToFront();
let ok = false;
for (let i = 0; i < 60 && !ok; i++) { const s = await (await fetch("http://localhost:5180/api/browser/call", { headers: auth })).json(); ok = s.connected; if (!ok) await new Promise((r) => setTimeout(r, 500)); }
if (!ok) { console.log("no conectó:", await panel.evaluate(() => chrome.storage.session.get("relay"))); process.exit(1); }
const call = async (tool, input) => { const t0 = Date.now(); const j = await (await fetch("http://localhost:5180/api/browser/call", { method: "POST", headers: auth, body: JSON.stringify({ tool, input }) })).json(); return { ...j, wall: Date.now() - t0 }; };
// (puppeteer no logra evaluar en el service worker de la extensión: se pregunta desde el panel)
const attachedTabs = () => panel.evaluate(() => chrome.storage.session.get("relay").then(({ relay }) => (relay?.debuggerAttached ? "pegado" : "suelto")));
const snap = await call("read_page", {});
const ref = (re) => re.exec(snap.result)?.[1];
const steps = [
  ["gif_creator", { action: "start_recording" }],
  ["click", { target: ref(/button "Contador: 0" \[ref=(e\d+)\]/) }],
  ["click", { target: ref(/button "Contador: 0" \[ref=(e\d+)\]/) }],
  ["select_option", { target: ref(/combobox "Estado"[^\n]*\[ref=(e\d+)\]/), values: ["Oaxaca"] }],
  ["take_screenshot", {}],
  ["computer", { action: "screenshot" }],
  ["computer", { action: "zoom", region: [0, 0, 400, 300] }],
  ["gif_creator", { action: "stop_recording" }],
  ["gif_creator", { action: "export", filename: "vibra" }],
];
for (const [tool, input] of steps) {
  const before = await p.evaluate(() => ({ rz: __rz, h: innerHeight }));
  const r = await call(tool, input);
  const after = await p.evaluate(() => ({ rz: __rz, h: innerHeight }));
  console.log(`${tool.padEnd(16)} ${String(r.wall).padStart(5)} ms  resize+${after.rz - before.rz}  innerHeight ${before.h}→${after.h}  depurador:${await attachedTabs()}  ${r.ok ? "" : r.error}${/not found/i.test(JSON.stringify(r)) ? " REF PERDIDO" : ""}${tool === "gif_creator" && r.result?.text ? ` · ${r.result.text}` : ""}`);
}
console.log("tamaños vistos:", await p.evaluate(() => [...new Set(__h)].join(" ")));
await new Promise((r) => setTimeout(r, Number(process.env.IDLE_MS ?? 0)));
console.log("depurador tras inactividad:", await attachedTabs());
await b.close(); srv.close();
