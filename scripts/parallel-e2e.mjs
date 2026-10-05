// e2e de paralelo por la vía nativa: dos procesos MCP (@ghostystudio/browser-mcp) suben cada uno un
// «video» a una página falsa (input file OCULTO, descripción, Publicar) en su propia pestaña, a la vez.
// Comprueba que no se pisan y mide paralelo vs uno tras otro.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
const ROOT = resolve(import.meta.dirname, "..");
const MCP = process.env.MCP ?? join(homedir(), "ghosty-studio/packages/browser-mcp/bin/browser-mcp.mjs");
const pages = { tubo: readFileSync(join(ROOT, "scripts/fixtures/subida-tubo.html")), toktok: readFileSync(join(ROOT, "scripts/fixtures/subida-toktok.html")) };
const srv = http.createServer((q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pages[q.url.slice(1)] ?? "nada"));
await new Promise((r) => srv.listen(5194, "127.0.0.1", r));
const VID = join(mkdtempSync(join(tmpdir(), "vid-")), "short.mp4");
writeFileSync(VID, Buffer.alloc(200_000, 7));

const profile = mkdtempSync(join(tmpdir(), "par-"));
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

function mcp(name) {
  const p = spawn("node", [MCP], { env: { ...process.env, GHOSTY_BROWSER_VIA: "native", GS_BROWSER_CLIENT: name }, stdio: ["pipe", "pipe", "inherit"] });
  const w = new Map();
  let n = 1;
  createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); w.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise((res) => { const id = n++; w.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = async (tname, args) => {
    const t0 = Date.now();
    const r = await rpc("tools/call", { name: tname, arguments: args });
    const txt = r.result.content.map((c) => c.text ?? "").join("\n");
    if (process.env.TRACE) console.error(`[${name}] ${tname} ${Date.now() - t0}ms ${txt.replace(/\s+/g, " ").slice(0, 110)}`);
    return txt;
  };
  return { p, rpc, tool };
}
const ref = (txt, re) => re.exec(txt)?.[1];
async function subir(m, site, texto, log) {
  const t0 = Date.now();
  const opened = await m.tool("browser_tabs", { action: "new", url: `http://127.0.0.1:5194/${site}`, background: true });
  const tabId = Number(/Opened tabId (\d+)/.exec(opened)?.[1]);
  const snap = await m.tool("browser_read_page", { tabId });
  const file = ref(snap, /file input \[ref=(ref_\d+)\][^\n]*\(oculto\)/);
  const desc = ref(snap, /textbox "Descripción"[^\n]*\[ref=(e\d+)\]/);
  log.push(`${site}: tab ${tabId}, file ${file}, desc ${desc}`);
  const up = await m.tool("browser_file_upload", { tabId, target: file, paths: [VID] });
  await m.tool("browser_type", { tabId, target: desc, text: texto });
  const snap2 = await m.tool("browser_read_page", { tabId });
  const pub = ref(snap2, /button "Publicar"[^\n]*\[ref=(e\d+)\]/);
  let click = await m.tool("browser_click", { tabId, target: pub });
  // «Publicar» es irreversible: la extensión pide confirmación; aquí la persona dice que sí.
  const nonce = /"nonce": ?"([0-9a-f]{16})"/.exec(click)?.[1];
  if (nonce) click = await m.tool("browser_click", { tabId, target: pub, confirm: true, nonce });
  const fin = await m.tool("browser_wait_for", { tabId, text: "Publicado" });
  // El estado se lee del DOM de ESA pestaña (no del texto del agente).
  const tab = (await b.pages()).find((pg) => pg.url().endsWith(`/${site}`) && pg.target()._targetId) ?? null;
  const estados = await Promise.all((await b.pages()).filter((pg) => pg.url().endsWith(`/${site}`)).map((pg) => pg.evaluate(() => document.getElementById("estado").textContent)));
  const estado = estados.find((e) => e.includes(texto)) ?? `(sin publicar: ${estados.join(" | ")})`;
  return { site, tabId, ms: Date.now() - t0, estado, tabEnRespuesta: /^\[tab \d+\]/.test(click), upOk: !/error/i.test(up) };
}
const A = mcp("Agente YouTube"), B = mcp("Agente TikTok");
await Promise.all([A.rpc("initialize", {}), B.rpc("initialize", {})]);
const log = [];
const tPar = Date.now();
const par = await Promise.all([subir(A, "tubo", "Mi short en Tubo #ghosty", log), subir(B, "toktok", "Mi short en TokTok #ghosty", log)]);
const parMs = Date.now() - tPar;
const tSeq = Date.now();
const seq = [await subir(A, "tubo", "Segunda vuelta Tubo", log), await subir(B, "toktok", "Segunda vuelta TokTok", log)];
const seqMs = Date.now() - tSeq;
// find sin gs: cae a la búsqueda local en vez de colgarse.
const tf = Date.now();
const find = await A.tool("browser_find", { tabId: par[0].tabId, query: "el botón Publicar" });
const findMs = Date.now() - tf;
const status = await A.tool("browser_status", {});
console.log(log.join("\n"));
for (const r of [...par, ...seq]) console.log(`${r.estado.startsWith("Publicado") ? "✓" : "✗"} ${r.site} tab ${r.tabId} ${r.ms} ms · upload ${r.upOk ? "ok" : "FALLA"} · respuesta con [tab]: ${r.tabEnRespuesta} · ${r.estado}`);
console.log(`paralelo ${parMs} ms vs uno tras otro ${seqMs} ms`);
console.log(`find sin gs: ${findMs} ms · ${find.replace(/\s+/g, " ").slice(0, 160)}`);
console.log(`status sin token: ${status.replace(/\s+/g, " ").slice(0, 160)}`);
A.p.kill(); B.p.kill(); await b.close(); srv.close();
