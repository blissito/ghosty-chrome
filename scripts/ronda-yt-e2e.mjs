// Ronda YouTube (4-oct) por la vía nativa: diálogo tardío, botón custom sin nombre, borrar un
// editor enriquecido, etiquetas por coma y `find` local.
// (Plantilla de: casos difíciles por la vía nativa (Chrome for Testing, HOME y perfil temporales):
//   iframe de OTRO origen (snapshot por frame, clic y tecleo adentro), Shadow DOM abierto, app de puro
//   canvas (debe caer a computer + captura), captcha y 2FA (el agente avisa y espera; nunca resuelve).
import puppeteer from "puppeteer-core";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const ROOT = resolve(import.meta.dirname, "..");
const EXT = process.env.EXT ?? join(ROOT, "ext");
const MCP = process.env.MCP ?? join(homedir(), "ghosty-studio/packages/browser-mcp/bin/browser-mcp.mjs");
const CHROME = process.env.CHROME ?? join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const FIX = join(ROOT, "scripts/fixtures");
const handler = (q, r) => {
  try {
    const body = readFileSync(join(FIX, q.url.slice(1).split("?")[0]));
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  } catch {
    r.writeHead(404).end("nada");
  }
};
// Dos orígenes: la página en 127.0.0.1:5186 y el iframe en localhost:5187.
const s1 = http.createServer(handler);
const s2 = http.createServer(handler);
await new Promise((r) => s1.listen(5186, "127.0.0.1", r));
await new Promise((r) => s2.listen(5187, "localhost", r));
const BASE = "http://127.0.0.1:5186";

const HOME = mkdtempSync(join(tmpdir(), "ronda-home-"));
const profile = mkdtempSync(join(tmpdir(), "ronda-prof-"));
const env = { ...process.env, HOME };
execFileSync("node", [MCP, "install-host", "--dir", join(profile, "NativeMessagingHosts")], { env, stdio: "ignore" });
const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", userDataDir: profile, env, defaultViewport: null, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--window-size=1200,850"] });
const sw = await b.waitForTarget((t) => t.type() === "service_worker");
const [home] = await b.pages();
await home.goto("https://example.com");
const panel = await b.newPage();
await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
await home.bringToFront();
for (let i = 0; !(await panel.evaluate(() => chrome.storage.session.get("relay"))).relay?.native; i++) {
  if (i > 60) throw new Error("sin host nativo");
  await new Promise((r) => setTimeout(r, 500));
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` · ${String(detail).replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
};
const p = spawn("node", [MCP], { env: { ...env, GHOSTY_BROWSER_VIA: "native", GS_BROWSER_CLIENT: "Ronda YouTube" }, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map();
let n = 1;
createInterface({ input: p.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  waiting.get(m.id)?.(m);
});
const rpc = (method, params) => new Promise((res) => {
  const id = n++;
  waiting.set(id, res);
  p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const tool = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
await rpc("initialize", {});
const pageOf = async (path) => (await b.pages()).find((pg) => pg.url().startsWith(`${BASE}/${path}`));
const frameText = async (sel) => {
  const pg = await pageOf("dificil.html");
  const fr = pg.frames().find((f) => f.url().includes("marco.html"));
  return fr ? fr.evaluate((s) => document.querySelector(s)?.textContent, sel) : "(sin marco)";
};

const opened = await tool("browser_tabs", { action: "new", url: `${BASE}/ronda.html`, background: true });
const tabId = Number(/tabId["\s:]*(\d+)/.exec(opened)?.[1] ?? /Opened tabId (\d+)/.exec(opened)?.[1]);
await new Promise((r) => setTimeout(r, 800));
const pg = await pageOf("ronda.html");
let snap = await tool("browser_read_page", { tabId });
const sig = /button "Siguiente"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
check("R1 botón custom sin nombre sale con su texto", !!sig, snap.split("\n").find((l) => /Siguiente/.test(l)) ?? "");
let r = sig ? await tool("browser_click", { tabId, target: sig }) : "sin ref";
check("R2 clic en ese botón", (await pg.evaluate(() => document.getElementById("estado-sig").textContent)) === "siguiente:ok", r.slice(0, 60));

const rev = /button "Revisar video"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
r = await tool("browser_click", { tabId, target: rev });
const dlgLine = r.split("\n").find((l) => /Apareció un diálogo/.test(l)) ?? "";
check("R3 el clic avisa del diálogo que salió 800 ms después", /Revisión pendiente/.test(dlgLine) && /\[ref=e\d+\] «Publicar de todas formas»/.test(dlgLine), dlgLine);

snap = await tool("browser_read_page", { tabId });
const tit = /textbox "Título del video"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
r = await tool("browser_type", { tabId, target: tit, text: "Tu agente se come el archivo" });
let got = await pg.evaluate(() => document.getElementById("titulo").innerText.trim());
check("R4 type borra lo de fábrica en el editor (rápido)", got === "Tu agente se come el archivo" && !/⚠️/.test(r), got);
r = await tool("browser_type", { tabId, target: tit, text: "Segunda versión", slowly: true });
got = await pg.evaluate(() => document.getElementById("titulo").innerText.trim());
check("R5 type slowly también borra antes", got === "Segunda versión" && !/⚠️/.test(r), got);
r = await tool("browser_type", { tabId, target: tit, text: " #shorts", clear: false });
got = await pg.evaluate(() => document.getElementById("titulo").innerText.trim());
check("R6 clear:false agrega al final", got === "Segunda versión #shorts", got);

const tags = /textbox "Etiquetas"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
r = await tool("browser_type", { tabId, target: tags, text: "agentes de IA,claude code,tokens,", slowly: true });
const chips = await pg.evaluate(() => [...document.querySelectorAll(".chip")].map((c) => c.textContent));
check("R7 la coma crea cada etiqueta", JSON.stringify(chips) === JSON.stringify(["agentes de IA", "claude code", "tokens"]), JSON.stringify(chips));

const t0 = Date.now();
r = await tool("browser_find", { tabId, query: "botón Revisar video" });
const ms = Date.now() - t0;
check("R8 find local sin modelo y rápido", /búsqueda local/.test(r) && r.includes(rev) && ms < 1500, `${ms} ms · ${r.slice(0, 80)}`);

// ── Diálogos nativos (sesión Shopify): default cancelar, armado aceptar, nada se cuelga ──
snap = await tool("browser_read_page", { tabId });
const desc = /button "Desconectar servicio"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
let t2 = Date.now();
r = await tool("browser_click", { tabId, target: desc });
let est = await pg.evaluate(() => document.getElementById("estado-desc").textContent);
check("R10 confirm sin armar: se cancela, avisa el texto y no se cuelga", est === "cancelado" && /cancelado por default/.test(r) && /¿Desconectar el servicio\?/.test(r) && Date.now() - t2 < 8000, `${Date.now() - t2} ms · ${r.split("\n").find((l) => /confirm/.test(l)) ?? r.slice(0, 100)}`);
r = await tool("browser_handle_dialog", { tabId, accept: true });
const r2 = await tool("browser_click", { tabId, target: desc });
est = await pg.evaluate(() => document.getElementById("estado-desc").textContent);
check("R11 armado con handle_dialog: se acepta", /Armado/.test(r) && est === "aceptado", `${est} · ${r2.split("\n").find((l) => /confirm/.test(l)) ?? ""}`);
const luego = /button "Avisar luego"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
await tool("browser_click", { tabId, target: luego });
await new Promise((res) => setTimeout(res, 2500));
t2 = Date.now();
r = await tool("browser_read_page", { tabId });
check("R12 alert abierto fuera de una acción: read_page avisa al instante", /PAUSA/.test(r) && /Se terminó de procesar/.test(r) && Date.now() - t2 < 3000, `${Date.now() - t2} ms · ${r.slice(0, 120)}`);
r = await tool("browser_handle_dialog", { tabId, accept: true });
const after = await tool("browser_read_page", { tabId });
check("R13 handle_dialog lo cierra y la pestaña vuelve", /Aceptado: alert/.test(r) && /Ronda YouTube/.test(after), r.slice(0, 80));
// ── Pestaña nueva, secreto y lista larga ──
const otra = /link "Abrir en otra pestaña"[^\n]*\[ref=(e\d+)\]/.exec(after)?.[1];
r = await tool("browser_click", { tabId, target: otra });
check("R14 un clic que abre otra pestaña lo dice con su tabId", /abrió una pestaña nueva \[tabId \d+\]/.test(r), r.split("\n").find((l) => /pestaña nueva/.test(l)) ?? r.slice(0, 100));
check("R15 read_page tapa el client secret", !/shpss_FAKEtestNOTreal/.test(after) && /secreto oculto/.test(after), after.split("\n").find((l) => /Client secret/.test(l)) ?? "");
r = await tool("browser_find", { tabId, query: "Shopify" });
check("R16 find encuentra la tarjeta 42 de 50 (más allá de la poda)", /button \\?"Shopify\\?"/.test(r), r.replace(/\s+/g, " ").slice(150, 330));

// ── Selector de archivos interceptado (LinkedIn «Vídeo» abría el de macOS) ──
snap = await tool("browser_read_page", { tabId });
const subir = /button "Subir vídeo"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
r = await tool("browser_click", { tabId, target: subir });
const up = await tool("browser_file_upload", { tabId, paths: [join(FIX, "ronda.html")] });
const fname = await pg.evaluate(() => document.getElementById("estado-archivo").textContent);
check("R17 el clic intercepta el selector y file_upload sin target lo llena", /selector de archivos/.test(r) && /interceptado/.test(up) && fname === "ronda.html", `${fname} · ${r.split("\n").find((l) => /📎/.test(l)) ?? r.slice(0, 80)}`);

// ── Página de registro con pago y acuerdo (Shopify Partners) ──
r = await tool("browser_navigate", { tabId, url: `${BASE}/partners.html` });
check("R20 avisa del pago y del acuerdo al llegar", /pide un pago \(«[^»]*19 USD/.test(r) && /Acuerdo de Partners/.test(r) && /detente/.test(r), r.split("\n").find((l) => /pide un pago|aceptar/.test(l))?.slice(0, 160) ?? r.slice(-200));
const dist = /button "Elegir distribución"[^\n]*\[ref=(e\d+)\]/.exec(r)?.[1];
r = await tool("browser_click", { tabId, target: dist });
check("R21 el título del diálogo sale del aria-labelledby, no del id", /Apareció un diálogo: «¿Seleccionar distribución pública\?»/.test(r), r.split("\n").find((l) => /Apareció/.test(l)) ?? "");
await tool("browser_navigate", { tabId, url: `${BASE}/ronda.html` });

r = await tool("browser_status", {});
check("R18 status dice build y capacidades", /"build": "[0-9a-f]{8}"/.test(r) && /"dialogs"/.test(r), (/"build": "[^"]+"/.exec(r) ?? [""])[0]);

// ── Puente: se mata el host nativo de ESTE Chrome (descendiente de su proceso, nunca el de bliss) ──
const descendants = (root) => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const kids = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [, pid, ppid] of rows) if (kids.has(Number(ppid)) && !kids.has(Number(pid))) (kids.add(Number(pid)), (grew = true));
  }
  return rows.filter(([, pid, , cmd]) => kids.has(Number(pid)) && /ghosty-native-host/.test(cmd)).map(([, pid]) => Number(pid));
};
const hosts = descendants(b.process().pid);
hosts.forEach((pid) => process.kill(pid, "SIGKILL"));
// Lo real: el host muere (Chrome recargó la extensión) y la siguiente llamada llega después.
await new Promise((r) => setTimeout(r, 300));
const t1 = Date.now();
r = await tool("browser_read_page", { tabId });
check("R9 tras matar el host, la siguiente llamada reconecta sola", hosts.length > 0 && /Ronda YouTube/.test(r), `${hosts.length} host(s) · ${Date.now() - t1} ms · ${r.slice(0, 60)}`);

// Reinstalar encima (archivo nuevo): el host viejo sale solo y la extensión abre el nuevo.
const before2 = descendants(b.process().pid);
execFileSync("touch", [join(HOME, ".ghosty", "ghosty-native-host.mjs")]);
await new Promise((res) => setTimeout(res, 5000));
const after2 = descendants(b.process().pid);
r = await tool("browser_read_page", { tabId });
check("R19 host con archivo nuevo: el viejo sale y el puente sigue", before2.length > 0 && !after2.some((p) => before2.includes(p)) && /Ronda YouTube/.test(r), `${before2} → ${after2}`);

const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length}/${results.length} en verde`);
p.kill();
await b.close();
s1.close();
s2.close();
process.exit(bad.length ? 1 : 0);
