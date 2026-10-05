// e2e de seguridad del lado de gs + la extensión, contra un gs LOCAL aislado (su propia base, puerto
// 5199) y Chrome for Testing con perfil temporal (nunca el Chrome de bliss). Cubre:
//   T. tokens: bt_ de 1 h, btr_ que se renueva, revocación («Cerrar sesión del navegador»), tokens viejos
//      de 30 días, CSRF del POST con cookie, sólo la extensión abre el SSE, versión mínima (426);
//   P. emparejamiento por externally_connectable: sólo con prueba de gs de ESA sesión, de un solo uso,
//      sólo desde los orígenes de Ghosty, y sin ejecutar tools por ese canal;
//   X. un bt_ de una cuenta no maneja el Chrome de otra; revocar corta.
// Arranque del gs de prueba (lo hace este script si no está):
//   DATABASE_URL=file:<scratch>/sec.db npx prisma migrate deploy && DATABASE_URL=… npx react-router dev --port 5199
import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac } from "node:crypto";

const ROOT = resolve(import.meta.dirname, "..");
const GS_DIR = join(homedir(), "ghosty-studio");
const GS = process.env.GS ?? "http://localhost:5199";
const DB = process.env.SEC_DB;
if (!DB) throw new Error("SEC_DB=<ruta a la base sqlite del gs de prueba>");
const SECRET = process.env.SESSION_SECRET ?? "dev-secret-change-me";
const CHROME = process.env.CHROME ?? join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const req = createRequire(join(GS_DIR, "package.json"));
process.env.DATABASE_URL = `file:${DB}`;
const { PrismaClient } = req("@prisma/client");
const { createCookie } = await import(req.resolve("react-router"));
const prisma = new PrismaClient();
const cookieJar = createCookie("gs_session", { httpOnly: true, sameSite: "lax", path: "/", secrets: [SECRET] });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` · ${detail}` : ""}`);
};

// Dos personas con sesión.
async function person(email) {
  const u = await prisma.user.upsert({ where: { email }, update: {}, create: { email } });
  const s = await prisma.session.create({ data: { userId: u.id, expiresAt: new Date(Date.now() + 86_400_000) } });
  const set = await cookieJar.serialize(s.id);
  return { id: u.id, email, cookie: set.split(";")[0], sid: s.id };
}
const A = await person(`sec-a-${Date.now()}@prueba.local`);
const B = await person(`sec-b-${Date.now()}@prueba.local`);
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const call = (headers, body = { tool: "read_page", input: {} }, method = "POST") => fetch(`${GS}/api/browser/call`, { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined }).then(j);
const sign = (payload) => createHmac("sha256", `browser:${SECRET}`).update(payload).digest("base64url");

// ── T. Tokens ──
const tok = await j(await fetch(`${GS}/api/browser/token`, { headers: { cookie: A.cookie } }));
const ttl = (tok.body?.expiresAt ?? 0) - Date.now();
check("T1 bt_ dura ≤ 1 h y el comando lleva un btr_ (no el bt_)", tok.status === 200 && ttl > 0 && ttl <= 3_600_000 && /^btr_/.test(tok.body?.refresh) && tok.body?.mcp.includes(tok.body.refresh) && !tok.body.mcp.includes(tok.body.token), `${Math.round(ttl / 60000)} min`);
let r = await call({ authorization: `Bearer ${tok.body.token}` });
check("T2 bt_ válido entra (409 = sin Chrome conectado, no 401)", r.status === 409, String(r.status));
r = await call({ authorization: `Bearer ${tok.body.refresh}` });
check("T3 el btr_ NO sirve para ejecutar tools", r.status === 401);
r = await call({ cookie: A.cookie });
check("T4 CSRF: POST con cookie y sin header propio → 401", r.status === 401);
r = await call({ cookie: A.cookie, "x-ghosty-browser": "1" });
check("T5 POST con cookie + header propio entra", r.status === 409);
const old = Buffer.from(JSON.stringify({ u: A.id, e: Date.now() + 29 * 86_400_000 })).toString("base64url");
r = await call({ authorization: `Bearer bt_${old}.${sign(old)}` });
check("T6 token viejo de 30 días (sin versión) ya no vale", r.status === 401);
const ren = await j(await fetch(`${GS}/api/browser/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh: tok.body.refresh }) }));
check("T7 btr_ → bt_ nuevo (renovación)", ren.status === 200 && /^bt_/.test(ren.body?.token));
r = await j(await fetch(`${GS}/api/browser/revoke`, { method: "POST", headers: { cookie: A.cookie, origin: "https://evil.example" } }));
check("T8 revocar desde otro sitio (CSRF) → 401", r.status === 401);
r = await j(await fetch(`${GS}/api/browser/revoke`, { method: "POST", headers: { cookie: A.cookie, "x-ghosty-browser": "1" } }));
check("T9 «Cerrar sesión del navegador» → ok", r.status === 200 && r.body?.ok);
r = await call({ authorization: `Bearer ${ren.body.token}` });
const rr = await j(await fetch(`${GS}/api/browser/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh: tok.body.refresh }) }));
check("T10 tras revocar: bt_ y btr_ anteriores → 401", r.status === 401 && rr.status === 401);
r = await j(await fetch(`${GS}/api/browser/connect`, { headers: { cookie: A.cookie } }));
check("T11 SSE sin header de la extensión → 403", r.status === 403);
r = await j(await fetch(`${GS}/api/browser/connect`, { headers: { cookie: A.cookie, "x-ghosty-ext": "1", "x-ghosty-ext-version": "1.4.0", origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }));
check("T12 SSE desde una extensión ajena → 403", r.status === 403);
r = await j(await fetch(`${GS}/api/browser/connect`, { headers: { cookie: A.cookie, "x-ghosty-ext": "1", "x-ghosty-ext-version": "1.2.0" } }));
check("T13 extensión vieja (sin protocolo) → 426 con descarga", r.status === 426 && /chrome/.test(r.body?.download ?? ""), r.body?.error?.slice(0, 60));
const tokA2 = await j(await fetch(`${GS}/api/browser/token`, { headers: { cookie: A.cookie } }));
r = await call({ authorization: `Bearer ${tokA2.body.token}` });
check("T14 el agente recibe «extensión vieja», no «no conectado»", r.status === 409 && /vieja/.test(r.body?.error ?? ""));
r = await j(await fetch(`${GS}/api/browser/connect`, { headers: { cookie: A.cookie, "x-ghosty-ext": "1", "x-ghosty-ext-version": "1.2.0", origin: "chrome-extension://okgofgcccjajcokgpjmdlpgjpjoibpca" } }));
check("T15 /api/browser/version da el protocolo mínimo", (await j(await fetch(`${GS}/api/browser/version`))).body?.minProtocol === 3);
{
  const ac = new AbortController();
  const res = await fetch(`${GS}/api/browser/connect`, { signal: ac.signal, headers: { cookie: A.cookie, "x-ghosty-ext": "1", "x-ghosty-ext-version": "1.0.0", "x-ghosty-ext-protocol": "3", origin: "chrome-extension://hdbaopibfnjadmhebocfjdebelgbgmkb" } });
  r = { status: res.status };
  ac.abort();
}
check("T16 la build de la tienda (1.0.0, protocolo 3) SÍ entra", r.status === 200, String(r.status));

// ── P/X. Extensión real contra este gs ──
// Copia de la extensión de desarrollo que apunta a :5199 en vez de :5180 (mismo código, mismo id).
const EXT = mkdtempSync(join(tmpdir(), "sec-ext-"));
cpSync(join(ROOT, "ext"), EXT, { recursive: true });
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
for (const f of walk(EXT).filter((f) => /\.(js|json|html)$/.test(f) && !f.includes("/vendor/"))) writeFileSync(f, readFileSync(f, "utf8").replaceAll("localhost:5180", "localhost:5199"));
const profile = mkdtempSync(join(tmpdir(), "sec-gs-prof-"));
const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", userDataDir: profile, defaultViewport: null, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--window-size=1200,850"] });
const sw = await b.waitForTarget((t) => t.type() === "service_worker");
const extId = new URL(sw.url()).host;
const [pg] = await b.pages();
await pg.setCookie({ name: "gs_session", value: decodeURIComponent(B.cookie.split("=")[1]), domain: "localhost", path: "/", httpOnly: true });
await pg.goto(`${GS}/api/browser/version`);
const send = (msg) => pg.evaluate((id, m) => new Promise((res) => {
  try {
    chrome.runtime.sendMessage(id, m, (x) => res(x ?? { noReply: true, err: String(chrome.runtime.lastError?.message ?? "") }));
  } catch (e) {
    res({ thrown: String(e) });
  }
  setTimeout(() => res({ timeout: true }), 5000);
}), extId, msg);
const panel = await b.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
const relayState = () => panel.evaluate(() => chrome.storage.session.get("relay").then((x) => x.relay));
await pg.bringToFront();

if (process.env.DEBUG) {
  console.log("panel fetch:", await panel.evaluate(async (gs) => { const r = await fetch(`${gs}/api/browser/connect`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-ghosty-ext": "1", "x-ghosty-ext-version": "1.4.0" }, body: JSON.stringify({ type: "pong" }) }); return `${r.status} ${await r.text()}`; }, GS));
  await new Promise((res) => setTimeout(res, 3000));
  console.log("relay:", JSON.stringify(await relayState()));
  console.log("sse:", await panel.evaluate(async (gs) => { const r = await fetch(`${gs}/api/browser/connect`, { credentials: "include", headers: { accept: "text/event-stream", "x-ghosty-ext": "1", "x-ghosty-ext-version": "1.4.0" } }); const rd = r.body.getReader(); const { value } = await rd.read(); rd.cancel(); return `${r.status} ${new TextDecoder().decode(value).slice(0, 120)}`; }, GS));
  const off = b.targets().find((t) => t.url().includes("relay.html"));
  console.log("offscreen:", off ? off.url() : "NO HAY");
  if (off) {
    const cdpS = await off.createCDPSession();
    const ev = await cdpS.send("Runtime.evaluate", { expression: "JSON.stringify({connecting, conn: !!conn, gs, inflight, quick})" });
    console.log("offscreen vars:", JSON.stringify(ev.result));
  }
}
r = await send({ type: "ghosty-pair" });
check("P1 ghosty-pair sin prueba: no se empareja", r?.paired === false, JSON.stringify(r).slice(0, 80));
const forged = Buffer.from(JSON.stringify({ u: B.id, e: Date.now() + 60_000, n: "x", k: "p" })).toString("base64url");
r = await send({ type: "ghosty-pair", proof: `bp_${forged}.AAAA` });
check("P2 prueba falsificada: no", r?.paired === false);
const proofA = (await j(await fetch(`${GS}/api/browser/call?ids=1`, { headers: { cookie: A.cookie } }))).body.pair;
r = await send({ type: "ghosty-pair", proof: proofA });
check("P3 prueba de OTRA sesión (persona A en el Chrome de B): no", r?.paired === false);
const ids = await pg.evaluate(() => fetch("/api/browser/call?ids=1", { credentials: "include" }).then((x) => x.json()));
r = await send({ type: "ghosty-pair", proof: ids.pair });
check("P4 prueba de esta sesión: se empareja", r?.paired === true);
r = await send({ type: "ghosty-pair", proof: ids.pair });
check("P5 la misma prueba no sirve dos veces", r?.paired === false);
r = await send({ type: "ghosty-tool", tool: "read_page", input: {} });
check("P6 externally_connectable ya no ejecuta tools", !r || r.noReply || r.timeout, JSON.stringify(r).slice(0, 60));
const other = await b.newPage();
await other.goto("https://example.com");
const fromOther = await other.evaluate((id) => typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage ? "expuesto" : "sin canal", extId);
check("P7 una página de otro origen no ve el canal de la extensión", fromOther === "sin canal");
await other.close();
for (let i = 0; (await relayState())?.status !== "connected"; i++) {
  if (i > 40) break;
  await new Promise((res) => setTimeout(res, 500));
}
const st = await relayState();
check("P8 la extensión 1.4.0 se conecta a gs con su sesión (B)", st?.status === "connected" && st?.email === B.email, `${st?.status} ${st?.email ?? ""} ${st?.reason ?? ""}`);

await pg.goto("https://example.com");
const tokB = await j(await fetch(`${GS}/api/browser/token`, { headers: { cookie: B.cookie } }));
r = await call({ authorization: `Bearer ${tokB.body.token}` }, { tool: "get_page_text", input: {} });
check("X1 bt_ de B maneja el Chrome de B", r.status === 200 && r.body?.ok, JSON.stringify(r.body).slice(0, 80));
// El MCP público con el btr_ del panel (camino remoto): lo cambia solo por un bt_.
const { execFileSync } = await import("node:child_process");
const mcpCall = (token) => {
  try {
    return execFileSync("node", [join(GS_DIR, "packages/browser-mcp/bin/browser-mcp.mjs"), "call", "get_page_text", "{}"], { env: { ...process.env, GS_URL: GS, GS_BROWSER_TOKEN: token, GHOSTY_BROWSER_VIA: "gs" }, encoding: "utf8", timeout: 60_000 });
  } catch (e) {
    return `ERR ${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
};
const viaMcp = mcpCall(tokB.body.refresh);
check("M1 @ghostystudio/browser-mcp con btr_: renueva y maneja el Chrome de B", /"tabId": \d+/.test(viaMcp), viaMcp.replace(/\s+/g, " ").slice(0, 60));
const tokA3 = await j(await fetch(`${GS}/api/browser/token`, { headers: { cookie: A.cookie } }));
r = await call({ authorization: `Bearer ${tokA3.body.token}` }, { tool: "get_page_text", input: {} });
check("X2 bt_ de A NO llega al Chrome de B", r.status === 409, `${r.status}`);
r = await j(await fetch(`${GS}/api/browser/revoke`, { method: "POST", headers: { cookie: B.cookie, "x-ghosty-browser": "1" } }));
await new Promise((res) => setTimeout(res, 300));
r = await call({ authorization: `Bearer ${tokB.body.token}` }, { tool: "get_page_text", input: {} });
check("X3 tras «Cerrar sesión del navegador» el bt_ de B ya no entra", r.status === 401);
const viaMcp2 = mcpCall(tokB.body.refresh);
check("M2 y el MCP con el btr_ revocado da un error claro", /caducó o se revocó/.test(viaMcp2), viaMcp2.replace(/\s+/g, " ").slice(0, 60));

// ── V. Copia vieja a mano: el panel dice «Actualiza» ──
{
  const OLD = mkdtempSync(join(tmpdir(), "sec-old-"));
  cpSync(EXT, OLD, { recursive: true });
  // Copia anterior: protocolo 2 (aunque su manifest diga una versión más alta).
  const bg = join(OLD, "background.js");
  writeFileSync(bg, readFileSync(bg, "utf8").replace("const GHOSTY_BROWSER_PROTOCOL = 3;", "const GHOSTY_BROWSER_PROTOCOL = 2;"));
  const C = await person(`sec-c-${Date.now()}@prueba.local`);
  const b2 = await puppeteer.launch({ executablePath: CHROME, headless: "new", userDataDir: mkdtempSync(join(tmpdir(), "sec-old-prof-")), defaultViewport: null, args: [`--disable-extensions-except=${OLD}`, `--load-extension=${OLD}`] });
  const sw2 = await b2.waitForTarget((t) => t.type() === "service_worker");
  const [p2] = await b2.pages();
  await p2.setCookie({ name: "gs_session", value: decodeURIComponent(C.cookie.split("=")[1]), domain: "localhost", path: "/", httpOnly: true });
  const pan = await b2.newPage();
  await pan.goto(`chrome-extension://${new URL(sw2.url()).host}/panel.html`);
  await pan.evaluate(() => chrome.runtime.sendMessage({ type: "fx-reconnect" }));
  let rs;
  for (let i = 0; i < 30; i++) {
    rs = await pan.evaluate(() => chrome.storage.session.get("relay").then((x) => x.relay));
    if (rs?.outdated) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  await new Promise((res) => setTimeout(res, 300));
  const banner = await pan.evaluate(() => ({ hidden: document.getElementById("update").hidden, text: document.getElementById("update").innerText, href: document.getElementById("update-link").href }));
  check("V1 copia de protocolo 2: el panel muestra «Actualiza: descarga…»", !banner.hidden && /Actualiza/.test(banner.text) && /chrome/.test(banner.href), banner.text.slice(0, 70));
  const tokC = await j(await fetch(`${GS}/api/browser/token`, { headers: { cookie: C.cookie } }));
  r = await call({ authorization: `Bearer ${tokC.body.token}` });
  check("V2 y gs le rechaza tools con mensaje claro", r.status === 409 && /vieja/.test(r.body?.error ?? ""));
  await b2.close();
}

const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length}/${results.length} en verde`);
await b.close();
await prisma.$disconnect();
process.exit(bad.length ? 1 : 0);
