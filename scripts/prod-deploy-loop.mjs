// Durante un deploy real de gs: la extensión (ext/ desarrollo) conectada a prod con la cuenta del
// revisor, y un bucle de read_page cada 2 s que registra fallos y latencias mientras cambia la caja.
import puppeteer from "puppeteer-core";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const GS = "https://www.ghosty.studio";
const sess = JSON.parse(readFileSync(process.env.SESS, "utf8"));
const LOG = process.env.LOG;
const H = { authorization: `Bearer ${sess.token}`, "content-type": "application/json" };
const b = await puppeteer.launch({ executablePath: join(homedir(), ".cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), headless: "new", userDataDir: mkdtempSync(join(tmpdir(), "dl-")), args: [`--disable-extensions-except=${ROOT}/ext`, `--load-extension=${ROOT}/ext`] });
await b.waitForTarget((t) => t.type() === "service_worker");
const [p] = await b.pages();
await p.setCookie({ name: "gs_session", value: sess.cookie, domain: "www.ghosty.studio", path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
await p.goto(`${GS}/c`, { waitUntil: "networkidle2" });
const p2 = await b.newPage();
await p2.goto("https://example.com");
for (let i = 0; !(await (await fetch(`${GS}/api/browser/call`, { headers: H })).json()).connected; i++) { if (i > 80) throw new Error("no conectó"); await new Promise((r) => setTimeout(r, 500)); }
appendFileSync(LOG, `${new Date().toISOString()} conectada\n`);
const end = Date.now() + Number(process.env.MS ?? 900000);
while (Date.now() < end) {
  const t0 = Date.now();
  const j = await (await fetch(`${GS}/api/browser/call`, { method: "POST", headers: H, body: JSON.stringify({ tool: "read_page", input: {}, client: "deploy-loop" }) })).json().catch((e) => ({ ok: false, error: e.message }));
  appendFileSync(LOG, `${new Date().toISOString()} ${j.ok ? "ok" : "FALLA"} ${Date.now() - t0}ms ${j.ok ? "" : String(j.error).slice(0, 100)}\n`);
  await new Promise((r) => setTimeout(r, 2000));
}
await b.close();
