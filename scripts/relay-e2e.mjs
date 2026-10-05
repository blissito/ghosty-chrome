// Prueba de punta a punta de la fase 5: MCP stdio (como Claude Code) → gs local → extensión en
// Chrome for Testing → página. Navega a ghosty.studio, lee, y edita el nombre de un agente local.
// Uso: GS_COOKIE=… GS_BROWSER_TOKEN=bt_… AGENT_ID=… node scripts/relay-e2e.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "evidencia", "relay");
mkdirSync(OUT, { recursive: true });
const GS = process.env.GS_URL ?? "http://localhost:5180";
const AGENT = process.env.AGENT_ID;
const NEW_NAME = process.env.NEW_NAME ?? "Ghosty Pruebas · editado desde Claude Code";
const CHROME = process.env.CHROME ?? join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

// ── MCP stdio ──
const mcp = spawn("node", [join(homedir(), "ghosty-studio/scripts/browser-mcp.mjs")], { env: { ...process.env, GS_URL: GS, GS_BROWSER_CLIENT: "Claude Code (e2e)" }, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map();
let nextId = 1;
createInterface({ input: mcp.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
});
const rpc = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    waiting.set(id, res);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const steps = [];
async function tool(name, args = {}) {
  const t0 = performance.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const ms = Math.round(performance.now() - t0);
  const res = r.result;
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const images = res.content.filter((c) => c.type === "image");
  steps.push({ tool: name, ms, isError: !!res.isError, images: images.length, preview: text.replace(/\s+/g, " ").slice(0, 140), text: text.slice(0, 6000) });
  console.log(`${res.isError ? "✗" : "✓"} ${name} ${ms} ms${images.length ? ` +${images.length} img` : ""} — ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  return { text, images, isError: res.isError };
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
// Antes de abrir Chrome: debe decir que el navegador no está conectado.
await tool("browser_navigate", { url: "https://www.ghosty.studio" });

// ── Chrome con la extensión y la sesión de gs ──
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : "new",
  userDataDir: mkdtempSync(join(tmpdir(), "fx-relay-")),
  defaultViewport: null,
  args: [`--disable-extensions-except=${join(ROOT, "ext")}`, `--load-extension=${join(ROOT, "ext")}`, "--no-first-run", "--window-size=1280,860", ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(" ") : [])],
});
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extId = new URL(sw.url()).host;
const [page] = await browser.pages();
await page.setCookie({ name: "gs_session", value: process.env.GS_COOKIE, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" });
await page.goto("https://example.com");
// Abrir el panel (como ventana) despierta al SW y lo reconecta ya con la cookie.
const panel = await browser.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await page.bringToFront();
const tc = Date.now();
for (;;) {
  const s = await (await fetch(`${GS}/api/browser/call`, { headers: { authorization: `Bearer ${process.env.GS_BROWSER_TOKEN}` } })).json();
  if (s.connected && s.tools.length) break;
  if (Date.now() - tc > 40_000) {
    console.log("panel:", await panel.evaluate(() => document.querySelector("main").innerText));
    console.log("relay:", JSON.stringify(await panel.evaluate(() => chrome.storage.session.get("relay"))));
    throw new Error("la extensión no se conectó");
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`extensión conectada en ${Date.now() - tc} ms`);

const list = await rpc("tools/list", {});
console.log(`tools/list: ${list.result.tools.length} tools (${list.result.tools.map((t) => t.name).slice(0, 6).join(", ")}…)`);

await tool("browser_status");
await tool("browser_navigate", { url: "https://www.ghosty.studio" });
await tool("browser_read_page");
await tool("browser_get_page_text", { maxChars: 1500 });
const shot = await tool("browser_computer", { action: "screenshot" });
if (shot.images[0]) writeFileSync(join(OUT, "ghosty-home.jpg"), Buffer.from(shot.images[0].data, "base64"));

// Editar el nombre de un agente local: clic en el título → escribir → Guardar.
await tool("browser_navigate", { url: `${GS}/app/fleet/${AGENT}` });
const found = await tool("browser_find", { query: "el título con el nombre del agente (clic para cambiar el nombre)" });
const refOf = (t) => /"ref": ?"((?:f\d+)?e\d+)"/.exec(t)?.[1];
const clicked = await tool("browser_click", { element: "nombre del agente", target: refOf(found.text) });
// El clic ya trae el snapshot nuevo (como Playwright MCP): ahí sale el campo del nombre.
const inputRef = /textbox "Nombre del agente"[^\n]*\[ref=((?:f\d+)?e\d+)\]/.exec(clicked.text)?.[1];
await tool("browser_type", { element: "campo del nombre", target: inputRef, text: NEW_NAME });
const save = await tool("browser_find", { query: "botón Guardar del formulario de la ficha del agente" });
await tool("browser_click", { element: "Guardar", target: refOf(save.text) });
await tool("browser_console_messages", { level: "error" });
await tool("browser_network_requests", { filter: "agents" });

const status = await (await fetch(`${GS}/api/browser/call`, { headers: { authorization: `Bearer ${process.env.GS_BROWSER_TOKEN}` } })).json();
await panel.bringToFront();
await panel.screenshot({ path: join(OUT, "panel.png") });
await page.bringToFront();
await page.screenshot({ path: join(OUT, "ficha.png") });
writeFileSync(join(OUT, "steps.json"), JSON.stringify({ steps, lastStep: status.lastStep }, null, 2));
await browser.close();
await new Promise((r) => setTimeout(r, 1500));
// Con Chrome cerrado: otra vez «no conectado».
await tool("browser_read_page", {});
mcp.kill();
const timed = steps.filter((s) => !s.isError && s.tool !== "browser_status");
console.log(`\nmediana ${timed.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(timed.length / 2)]} ms por tool`);
