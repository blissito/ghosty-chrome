#!/usr/bin/env node
// Host nativo `studio.ghosty.browser`: puente entre la extensión Ghosty (nativeMessaging, por
// stdio con prefijo de 4 bytes) y la terminal de esta Mac (socket Unix ~/.ghosty/browser.sock,
// JSON por líneas). Lo arranca Chrome cuando la extensión llama `connectNative` y muere con ella.
// `browser-mcp.mjs` lo prueba primero: si está, las tools no pasan por gs.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".ghosty");
const SOCK = process.env.GHOSTY_BROWSER_SOCK ?? join(DIR, "browser.sock");
mkdirSync(DIR, { recursive: true, mode: 0o700 });
// Seguridad: nada de puertos TCP. El socket vive en ~/.ghosty (0700), nace 0600 (umask) y cada
// conexión tiene que presentar el token de ~/.ghosty/browser.token (0600) en su primera línea:
// {"auth":"<token>"}. Otro usuario de la Mac no entra; un programa sin el token tampoco.
process.umask(0o077);
try {
  chmodSync(DIR, 0o700);
} catch {}
const TOKEN_FILE = process.env.GHOSTY_BROWSER_TOKEN_FILE ?? join(DIR, "browser.token");
function bridgeToken() {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) {
      chmodSync(TOKEN_FILE, 0o600);
      return t;
    }
  } catch {}
  const t = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
  return t;
}
const TOKEN = Buffer.from(bridgeToken());
// GHOSTY_BROWSER_DEBUG=1: bitácora en ~/.ghosty/host.log (para depurar el puente).
const dbg = (m) => {
  if (!process.env.GHOSTY_BROWSER_DEBUG) return;
  try {
    writeFileSync(join(DIR, "host.log"), `${new Date().toISOString()} ${m}\n`, { flag: "a", mode: 0o600 });
  } catch {}
};
const authOk = (raw) => {
  const got = Buffer.from(String(raw ?? ""));
  return got.length === TOKEN.length && timingSafeEqual(got, TOKEN);
};

// ── nativeMessaging: stdout = [len u32 LE][json] ──
function toExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}
let buf = Buffer.alloc(0);
const pending = new Map(); // id del host → { sock, id original de la terminal }
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
    buf = buf.subarray(4 + len);
    const p = pending.get(msg.id);
    // Un aviso de avance no cierra la petición: la respuesta final llega después.
    if (!msg.progress) pending.delete(msg.id);
    if (p && !p.sock.destroyed) p.sock.write(`${JSON.stringify({ ...msg, id: p.id })}\n`);
  }
});
process.stdin.on("end", () => shutdown());

// ── Socket local para la terminal (sólo el usuario: 0600) ──
if (existsSync(SOCK)) {
  try {
    unlinkSync(SOCK);
  } catch {}
}
let seq = 0;
const server = net.createServer((sock) => {
  let line = "";
  let authed = false;
  // Sin el token en 3 s, fuera.
  const authTimer = setTimeout(() => !authed && sock.destroy(), 3000);
  sock.on("data", (d) => {
    line += d;
    if (line.length > 8_000_000) return sock.destroy();
    let i;
    while ((i = line.indexOf("\n")) >= 0) {
      const raw = line.slice(0, i);
      line = line.slice(i + 1);
      let req;
      try {
        req = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!authed) {
        clearTimeout(authTimer);
        if (!authOk(req?.auth)) {
          sock.end(`${JSON.stringify({ id: req?.id ?? null, error: "puente local: token inválido (~/.ghosty/browser.token)" })}\n`);
          sock.destroy();
          return;
        }
        authed = true;
        sock.write(`${JSON.stringify({ auth: "ok" })}\n`);
        continue;
      }
      // El id lo pone el host: dos terminales no pueden pisarse.
      const id = `n${++seq}`;
      pending.set(id, { sock, id: req.id ?? id });
      toExtension({ ...req, id });
    }
  });
  sock.on("error", (e) => dbg(`socket error ${e.message}`));
  sock.on("close", () => dbg(`socket close authed=${authed} pending=${line.length}`));
});
// El inodo de NUESTRO socket: al salir sólo se borra si sigue siendo el nuestro. Si Chrome arranca un
// host nuevo antes de que muera el viejo, el viejo ya no le borra el socket al nuevo.
let sockIno = null;
server.listen(SOCK, () => {
  try {
    chmodSync(SOCK, 0o600);
    sockIno = statSync(SOCK).ino;
  } catch {}
  toExtension({ type: "hello", sock: SOCK });
});

function shutdown() {
  try {
    server.close();
    if (sockIno != null && statSync(SOCK).ino === sockIno) unlinkSync(SOCK);
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
