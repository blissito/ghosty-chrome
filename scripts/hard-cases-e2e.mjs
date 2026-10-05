// Casos difíciles por la vía nativa (Chrome for Testing, HOME y perfil temporales):
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
// Dos orígenes: la página en 127.0.0.1:5196 y el iframe en localhost:5197.
const s1 = http.createServer(handler);
const s2 = http.createServer(handler);
await new Promise((r) => s1.listen(5196, "127.0.0.1", r));
await new Promise((r) => s2.listen(5197, "localhost", r));
const BASE = "http://127.0.0.1:5196";

const HOME = mkdtempSync(join(tmpdir(), "hard-home-"));
const profile = mkdtempSync(join(tmpdir(), "hard-prof-"));
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
const p = spawn("node", [MCP], { env: { ...env, GHOSTY_BROWSER_VIA: "native", GS_BROWSER_CLIENT: "Casos difíciles" }, stdio: ["pipe", "pipe", "inherit"] });
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

// ── Iframe de otro origen ──
const opened = await tool("browser_tabs", { action: "new", url: `${BASE}/dificil.html`, background: true });
const tabId = Number(/tabId["\s:]*(\d+)/.exec(opened)?.[1] ?? /Opened tabId (\d+)/.exec(opened)?.[1]);
await new Promise((r) => setTimeout(r, 800));
let snap = await tool("browser_read_page", { tabId });
const fBtn = /button "Guardar en marco"[^\n]*\[ref=(f\d+e\d+)\]/.exec(snap)?.[1];
const fInput = /textbox "Cupón"[^\n]*\[ref=(f\d+e\d+)\]/.exec(snap)?.[1];
check("H1 read_page incluye el iframe de otro origen con refs fNeM", !!fBtn && !!fInput, `${fBtn} ${fInput}`);
let r = fInput ? await tool("browser_type", { tabId, target: fInput, text: "AJOLOTE10" }) : "sin ref";
check("H2 escribir dentro del iframe", !!fInput && !/error/i.test(r), r.slice(0, 80));
r = fBtn ? await tool("browser_click", { tabId, target: fBtn }) : "sin ref";
const fState = await frameText("#em");
check("H3 clic dentro del iframe", fState === "guardado:AJOLOTE10", `${fState} · ${r.slice(0, 60)}`);

// ── Shadow DOM abierto ──
const sBtn = /button "Botón sombra"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
const sInput = /textbox "Nota en sombra"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
check("H4 read_page ve el Shadow DOM abierto", !!sBtn && !!sInput, `${sBtn} ${sInput}`);
r = sInput ? await tool("browser_type", { tabId, target: sInput, text: "sombra-ok" }) : "sin ref";
check("H5 escribir en un input dentro del shadow root", !/error/i.test(r), r.slice(0, 80));
r = sBtn ? await tool("browser_click", { tabId, target: sBtn }) : "sin ref";
const sState = await (await pageOf("dificil.html")).evaluate(() => document.getElementById("estado-sombra").textContent);
check("H6 clic en un botón dentro del shadow root", sState === "clic:sombra-ok", `${sState} · ${r.slice(0, 60)}`);

// ── App de puro canvas ──
r = await tool("browser_navigate", { tabId, url: `${BASE}/lienzo.html` });
check("H7 en una app de canvas, read_page manda a computer + captura", /canvas/i.test(r) && /computer/.test(r), r.split("\n").find((l) => /canvas/i.test(l)) ?? "");
r = await tool("browser_computer", { tabId, action: "screenshot" });
check("H8 computer screenshot en canvas", /\[image\]/.test(r), r.slice(0, 60));
r = await tool("browser_computer", { tabId, action: "left_click", coordinate: [200, 140] });
const title = await (await pageOf("lienzo.html")).evaluate(() => document.title);
check("H9 computer left_click sobre el botón pintado", /pulsado/.test(title), title);

// ── Captcha y 2FA ──
r = await tool("browser_navigate", { tabId, url: `${BASE}/captcha.html` });
check("H10 captcha: el agente recibe «avisa y espera, no lo resuelvas»", /captcha/i.test(r) && /no (lo )?(intentes|resuelvas)/i.test(r), r.split("\n").find((l) => /captcha/i.test(l)) ?? "");
const robot = /checkbox "No soy un robot"[^\n]*\[ref=(e\d+)\]/.exec(r)?.[1] ?? /checkbox "No soy un robot"[^\n]*\[ref=(e\d+)\]/.exec(await tool("browser_read_page", { tabId }))?.[1];
r = robot ? await tool("browser_click", { tabId, target: robot }) : "sin ref";
check("H11 la extensión no da clic en «No soy un robot»", /captcha/i.test(r) && /error|persona/i.test(r), r.slice(0, 100));
r = await tool("browser_navigate", { tabId, url: `${BASE}/dos-pasos.html` });
check("H12 2FA: el agente recibe «pídele el código a la persona»", /2FA|dos pasos|verificaci/i.test(r) && /persona/i.test(r), r.split("\n").find((l) => /2FA|dos pasos/i.test(l)) ?? "");

const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length}/${results.length} en verde`);
p.kill();
await b.close();
s1.close();
s2.close();
process.exit(bad.length ? 1 : 0);
