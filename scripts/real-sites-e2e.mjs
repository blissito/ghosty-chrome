// Banco en sitios REALES, sin acciones irreversibles, en Chrome for Testing con perfil y HOME temporales
// (SIN las sesiones de bliss: nunca su Chrome). Todo en pestañas de FONDO por la vía nativa:
//   - YouTube Studio, TikTok Studio, Facebook, Gmail, Google Calendar: abrir y leer (sin sesión cae al
//     login: se comprueba que la extensión lo detecta y avisa, y que no teclea nada);
//   - Amazon México (Mercado Libre tumba a Chrome for Testing 139): buscar, abrir un producto y pedir
//     «Comprar ahora» → la puerta lo frena (needs_confirmation) y NO se confirma.
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const ROOT = resolve(import.meta.dirname, "..");
const EXT = process.env.EXT ?? join(ROOT, "ext");
const MCP = process.env.MCP ?? join(homedir(), "ghosty-studio/packages/browser-mcp/bin/browser-mcp.mjs");
const CHROME = process.env.CHROME ?? join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const HOME = mkdtempSync(join(tmpdir(), "real-home-"));
const profile = mkdtempSync(join(tmpdir(), "real-prof-"));
const env = { ...process.env, HOME };
execFileSync("node", [MCP, "install-host", "--dir", join(profile, "NativeMessagingHosts")], { env, stdio: "ignore" });
if (process.env.HOSTERR) {
  const { writeFileSync: wf, readFileSync: rf } = await import("node:fs");
  const w = join(HOME, ".ghosty/ghosty-native-host");
  wf(w, rf(w, "utf8").replace('"$@"', '"$@" 2>>' + join(HOME, ".ghosty/host.err")));
}
const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", userDataDir: profile, env, defaultViewport: null, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--window-size=1280,900", "--lang=es-MX", "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"] });
const sw = await b.waitForTarget((t) => t.type() === "service_worker");
if (process.env.SWLOG) {
  const w = await sw.worker();
  w.on("console", (m) => console.log("SW console:", m.type(), m.text().slice(0, 200)));
  w.on("error", (e) => console.log("SW error:", e.message));
  b.on("targetdestroyed", (t) => t.type() === "service_worker" && console.log("SW DESTRUIDO", new Date().toISOString()));
  b.on("targetcreated", (t) => t.type() === "service_worker" && console.log("SW NUEVO", new Date().toISOString()));
}
const [home] = await b.pages();
await home.goto("https://example.com");
const panel = await b.newPage();
await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
await home.bringToFront();
for (let i = 0; !(await panel.evaluate(() => chrome.storage.session.get("relay"))).relay?.native; i++) {
  if (i > 60) throw new Error("sin host nativo");
  await new Promise((r) => setTimeout(r, 500));
}
const p = spawn("node", [MCP], { env: { ...env, GHOSTY_BROWSER_VIA: "native", GS_BROWSER_CLIENT: "Banco real" }, stdio: ["pipe", "pipe", "inherit"] });
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
const tool = async (name, args) => {
  const t0 = Date.now();
  const r = (await rpc("tools/call", { name, arguments: args })).result;
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join("\n"), ms: Date.now() - t0, isError: r.isError };
};
await rpc("initialize", {});
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` · ${String(detail).replace(/\s+/g, " ").slice(0, 140)}` : ""}`);
};
const activeUrl = () => home.url();

const SITES = process.env.ONLY_ML ? [] : [
  ["YouTube Studio", "https://studio.youtube.com/"],
  ["TikTok Studio", "https://www.tiktok.com/tiktokstudio/upload"],
  ["Facebook", "https://www.facebook.com/"],
  ["Gmail", "https://mail.google.com/mail/u/0/#inbox"],
  ["Google Calendar", "https://calendar.google.com/calendar/u/0/r"],
];
// Todas a la vez, cada una en su pestaña de fondo.
await Promise.all(
  SITES.map(async ([name, url]) => {
    const o = await tool("browser_tabs", { action: "new", url, background: true });
    const tabId = Number(/tabId["\s:]*(\d+)/.exec(o.text)?.[1] ?? /Opened tabId (\d+)/.exec(o.text)?.[1]);
    await tool("browser_wait_for", { tabId, time: 4 });
    const read = await tool("browser_read_page", { tabId });
    if (process.env.TRACE) console.log(name, read.text.slice(0, 1500));
    const text = await tool("browser_get_page_text", { tabId });
    // Sin sesión: login, o la portada pública del producto (Gmail sin sesión cae en workspace.google.com).
    const login = /iniciar sesi|sign in|log in|inicia sesi|accounts\.google|login|workspace\.google\.com/i.test(read.text + text.text);
    check(`R ${name}: se lee en pestaña de fondo (${read.ms} ms)`, !read.isError && /Page URL/.test(read.text), /Page URL: (\S+)/.exec(read.text)?.[1]);
    check(`R ${name}: sin sesión no hay datos de la persona (login o portada pública)`, login, /Page Title: ([^\n]+)/.exec(read.text)?.[1]);
  }),
);
check("R la pestaña visible no cambió", activeUrl().startsWith("https://example.com"), activeUrl());

// Tienda: buscar, abrir un producto y pedir «Comprar ahora» SIN confirmar. (Mercado Libre tumba a
// Chrome for Testing 139 en ~3 s con o sin la extensión —medido 4-oct—, así que aquí va Amazon México.)
const o = await tool("browser_tabs", { action: "new", url: "https://www.amazon.com.mx/s?k=termo+acero+inoxidable", background: true });
const ml = Number(/tabId["\s:]*(\d+)/.exec(o.text)?.[1] ?? /Opened tabId (\d+)/.exec(o.text)?.[1]);
await tool("browser_wait_for", { tabId: ml, time: 3 });
let snap = await tool("browser_read_page", { tabId: ml });
check(`R Amazon: resultados leídos en pestaña de fondo (${snap.ms} ms)`, /Page URL/.test(snap.text), /Page Title: ([^\n]+)/.exec(snap.text)?.[1]);
const dp = /\/url: (\/[^\s]*\/dp\/[A-Z0-9]{10}[^\s]*)/.exec(snap.text)?.[1];
if (dp) {
  await tool("browser_navigate", { tabId: ml, url: `https://www.amazon.com.mx${dp}` });
  const f = await tool("browser_find", { tabId: ml, query: "el botón Comprar ahora" });
  const ref = /"ref": "(e\d+)"/.exec(f.text)?.[1];
  const pg = async () => (await b.pages()).find((x) => /amazon\.com\.mx/.test(x.url()));
  const before = (await pg())?.url();
  const c = ref ? await tool("browser_click", { tabId: ml, target: ref }) : { text: `sin botón: ${f.text.slice(0, 200)}` };
  await new Promise((r) => setTimeout(r, 1500));
  const after = (await pg())?.url();
  check("R Amazon: «Comprar ahora» pide confirmación y no se ejecuta", /needs_confirmation/.test(c.text) && before === after, `${/"category": "([^"]+)"/.exec(c.text)?.[1] ?? c.text.slice(0, 120)}`);
} else check("R Amazon: encontrar un producto en los resultados", false, snap.text.slice(0, 300));

const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length}/${results.length} en verde`);
p.kill();
await b.close();
if (process.env.HOSTERR) {
  try { console.log("host.err:", readFileSync(join(HOME, ".ghosty/host.err"), "utf8").slice(-2000)); } catch { console.log("sin host.err"); }
}
if (process.env.GHOSTY_BROWSER_DEBUG) {
  try { console.log(readFileSync(join(HOME, ".ghosty/host.log"), "utf8")); } catch {}
}
process.exit(bad.length ? 1 : 0);
