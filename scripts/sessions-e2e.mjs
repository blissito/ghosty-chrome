// e2e de sesiones: dos procesos MCP (cada uno con su `session`) trabajan a la vez SIN pasar tabId.
// Cada uno debe quedar en su propia pestaña, leer sólo su página y no esperar al otro. Un tercero sin
// session (protocolo viejo) sigue usando «la pestaña actual».
import puppeteer from "puppeteer-core";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
const ROOT = resolve(import.meta.dirname, "..");
const MCP = process.env.MCP ?? join(homedir(), "ghosty-studio/packages/browser-mcp/bin/browser-mcp.mjs");
const page = (name) => `<!doctype html><title>${name}</title><h1>Página ${name}</h1><p id="m">marca-${name}</p>`;
const srv = http.createServer((q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(new URL(q.url, "http://x").pathname.slice(1) || "raiz")));
await new Promise((r) => srv.listen(5195, "127.0.0.1", r));
const URL0 = "http://127.0.0.1:5195";

const profile = mkdtempSync(join(tmpdir(), "ses-"));
execFileSync("node", [MCP, "install-host", "--dir", join(profile, "NativeMessagingHosts")], { stdio: "ignore" });
const b = await puppeteer.launch({ executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), headless: "new", userDataDir: profile, defaultViewport: null, args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`, "--window-size=1200,850"] });
const sw = await b.waitForTarget((t) => t.type() === "service_worker");
const [home] = await b.pages();
await home.goto("https://example.com");
const panel = await b.newPage();
await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
await home.bringToFront();
for (let i = 0; !(await panel.evaluate(() => chrome.storage.session.get("relay"))).relay?.native; i++) { if (i > 60) throw new Error("sin host nativo"); await new Promise((r) => setTimeout(r, 500)); }
console.error("host nativo conectado");

function mcp(name, session) {
  const env = { ...process.env, GHOSTY_BROWSER_VIA: "native", GS_BROWSER_CLIENT: name, GS_BROWSER_SESSION: session };
  const p = spawn("node", [MCP], { env, stdio: ["pipe", "pipe", "inherit"] });
  const w = new Map();
  let n = 1;
  createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); w.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise((res) => { const id = n++; w.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = async (tname, args) => (await rpc("tools/call", { name: tname, arguments: args })).result.content.map((c) => c.text ?? "").join("\n");
  return { p, rpc, tool };
}
const tabOf = (txt) => Number(/\[tab (\d+)\]|"tabId": ?(\d+)/.exec(txt)?.slice(1).find(Boolean));

// Una «tarea» sin tabId: navegar, esperar 2 s (en ese hueco el otro agente navega), leer, repetir.
async function tarea(m, site) {
  const t0 = Date.now();
  const nav = await m.tool("browser_navigate", { url: `${URL0}/${site}` });
  await m.tool("browser_wait_for", { time: 2 });
  const t1 = await m.tool("browser_get_page_text", {});
  await m.tool("browser_navigate", { url: `${URL0}/${site}-2` });
  await m.tool("browser_wait_for", { time: 1 });
  const t2 = await m.tool("browser_get_page_text", {});
  return { site, tab: tabOf(nav), ms: Date.now() - t0, ok: t1.includes(`marca-${site}`) && t2.includes(`marca-${site}-2`), t1: t1.replace(/\s+/g, " ").slice(0, 80) };
}

const A = mcp("Agente A", "conv-a"), B = mcp("Agente B", "conv-b"), C = mcp("Agente viejo", "");
await Promise.all([A.rpc("initialize", {}), B.rpc("initialize", {}), C.rpc("initialize", {})]);
const tPar = Date.now();
const [ra, rb] = await Promise.all([tarea(A, "alfa"), tarea(B, "beta")]);
const parMs = Date.now() - tPar;
const tSeq = Date.now();
await tarea(A, "alfa");
await tarea(B, "beta");
const seqMs = Date.now() - tSeq;
// A sigue en su misma pestaña en la segunda vuelta.
const ra2 = await tarea(A, "alfa");
const rc = await tarea(C, "gama");

const checks = [
  [`A y B en pestañas distintas (${ra.tab} / ${rb.tab})`, ra.tab && rb.tab && ra.tab !== rb.tab],
  [`A leyó sólo su página`, ra.ok],
  [`B leyó sólo su página`, rb.ok],
  [`en paralelo (${parMs} ms) más rápido que uno tras otro (${seqMs} ms)`, parMs < seqMs * 0.75],
  [`A conserva su pestaña (${ra.tab} → ${ra2.tab})`, ra.tab === ra2.tab && ra2.ok],
  [`sin session funciona (tab ${rc.tab})`, rc.ok],
];
for (const [msg, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${msg}`);
A.p.kill(); B.p.kill(); C.p.kill(); await b.close(); srv.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
