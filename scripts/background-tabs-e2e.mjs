// Tres pestañas de FONDO (YouTube Studio, TikTok Studio y una página local) manejadas a la vez por la
// vía nativa sin activarlas: read_page, click, type y screenshot en las tres. La pestaña visible no
// cambia. Registra los avisos de avance (notifications/progress).
import puppeteer from "puppeteer-core";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
const ROOT = resolve(import.meta.dirname, "..");
const MCP = join(homedir(), "ghosty-studio/packages/browser-mcp/bin/browser-mcp.mjs");
const PAGE = readFileSync(join(ROOT, "scripts/fixtures/subida-tubo.html"));
const srv = http.createServer((q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
await new Promise((r) => srv.listen(5193, "127.0.0.1", r));
const profile = mkdtempSync(join(tmpdir(), "bgt-"));
execFileSync("node", [MCP, "install-host", "--dir", join(profile, "NativeMessagingHosts")], { stdio: "ignore" });
const b = await puppeteer.launch({ executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), headless: process.env.HEADFUL ? false : "new", userDataDir: profile, defaultViewport: null, args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`, "--window-size=1200,850"] });
const sw = await b.waitForTarget((t) => t.type() === "service_worker");
const [home] = await b.pages();
await home.goto("https://example.com");
const panel = await b.newPage();
await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
await home.bringToFront();
for (let i = 0; !(await panel.evaluate(() => chrome.storage.session.get("relay"))).relay?.native; i++) { if (i > 60) throw new Error("sin host nativo"); await new Promise((r) => setTimeout(r, 500)); }
const p = spawn("node", [MCP], { env: { ...process.env, GHOSTY_BROWSER_VIA: "native" }, stdio: ["pipe", "pipe", "inherit"] });
const w = new Map();
const progress = [];
let n = 1;
createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); if (m.method === "notifications/progress") progress.push(m.params.message); else w.get(m.id)?.(m); });
const rpc = (method, params) => new Promise((res) => { const id = n++; w.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const tool = async (name, args) => { const t0 = Date.now(); const r = await rpc("tools/call", { name, arguments: args, _meta: { progressToken: `${name}-${n}` } }); const c = r.result.content; return { ms: Date.now() - t0, err: r.result.isError, text: c.map((x) => x.text ?? `[${x.type}]`).join("\n"), img: c.some((x) => x.type === "image") }; };
await rpc("initialize", {});
const sites = [
  { name: "youtube-studio", url: "https://studio.youtube.com/" },
  { name: "tiktok-studio", url: "https://www.tiktok.com/tiktokstudio/upload" },
  { name: "local", url: "http://127.0.0.1:5193/" },
];
console.log("al inicio:", await panel.evaluate(async () => JSON.stringify((await chrome.tabs.query({})).map((t) => [t.id, t.active, t.windowId, t.url.slice(0, 40)]))));
const t0 = Date.now();
const res = await Promise.all(sites.map(async (s) => {
  const out = { site: s.name, steps: [] };
  const open = await tool("browser_tabs", { action: "new", url: s.url, background: true });
  const tabId = Number(/Opened tabId (\d+)/.exec(open.text)?.[1]);
  out.tabId = tabId;
  out.steps.push(["tabs new", open.ms, !open.err]);
  const snap = await tool("browser_read_page", { tabId });
  out.steps.push(["read_page", snap.ms, !snap.err && /Page URL/.test(snap.text)]);
  out.url = /Page URL: (\S+)/.exec(snap.text)?.[1];
  const box = /(?:textbox|searchbox|combobox)[^\n]*\[ref=(e\d+)\]/.exec(snap.text)?.[1];
  const btn = /(?:button|link) "[^"]+"[^\n]*\[ref=(e\d+)\]/.exec(snap.text)?.[1];
  if (box) { const t = await tool("browser_type", { tabId, target: box, text: "hola" }); out.steps.push(["type", t.ms, !t.err]); }
  else out.steps.push(["type", 0, "sin campo"]);
  if (btn) { const c = await tool("browser_hover", { tabId, target: btn }); out.steps.push(["hover/click", c.ms, !c.err]); }
  const sh = await tool("browser_take_screenshot", { tabId });
  out.steps.push(["screenshot", sh.ms, !sh.err && sh.img ? "imagen" : sh.text.slice(0, 80)]);
  return out;
}));
// click real en la local (no navega fuera): el botón Seleccionar archivos.
const local = res.find((r) => r.site === "local");
const ls = await tool("browser_read_page", { tabId: local.tabId });
const pick = /button "Seleccionar archivos"[^\n]*\[ref=(e\d+)\]/.exec(ls.text)?.[1];
const cl = await tool("browser_click", { tabId: local.tabId, target: pick });
local.steps.push(["click", cl.ms, !cl.err]);
// Una tool lenta (8 s) para ver el avance en vivo.
const slow = await tool("browser_wait_for", { tabId: local.tabId, time: 8 });
local.steps.push(["wait 8s", slow.ms, !slow.err]);
const visible = await home.evaluate(() => document.visibilityState);
const activa = await panel.evaluate(async () => JSON.stringify((await chrome.tabs.query({})).map((t) => [t.id, t.active, t.windowId, t.url.slice(0, 40), t.openerTabId ?? null])));
for (const r of res) console.log(`${r.site} tab ${r.tabId} (${r.url}):`, r.steps.map(([s, ms, ok]) => `${s} ${ms}ms ${ok === true ? "✓" : ok}`).join(" · "));
console.log(`total ${Date.now() - t0} ms · pestaña activa al final: ${activa}`);
console.log(`avisos de avance: ${progress.length}`, progress.slice(0, 4));
p.kill(); await b.close(); srv.close();
