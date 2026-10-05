// Proxy local que habla el protocolo del AI Gateway de Vercel hacia DeepSeek.
//
// libfx sólo sabe hablarle al Gateway (`/v4/ai/language-model`); la extensión reescribe su
// `fetch` hacia aquí. La llave de DeepSeek vive SÓLO en este proceso (env o el .env de gs);
// la extensión recibe un token corto (15 min) por POST /token, y sólo si el Origin es una
// la extensión fijada por `FX_EXT_ID` (el id sale de la `key` del manifest). Traducción portada de gs `app/lib/fx/gateway.server.ts`.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const PORT = Number(process.env.PORT ?? 8787);
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const TOKEN_TTL_MS = 15 * 60_000;
// Tope de gasto por proceso (USD): el POC no debe poder quemar la llave.
const BUDGET_USD = Number(process.env.FX_BUDGET_USD ?? 0.5);
// Única extensión que puede pedir tokens y leer /stats (id fijo por la `key` de ext/manifest.json).
const EXT_ID = process.env.FX_EXT_ID ?? "okgofgcccjajcokgpjmdlpgjpjoibpca";
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

// Lee una llave del env o de un .env local; nunca se imprime ni sale de este proceso.
function loadKey(name, file) {
  if (process.env[name]) return process.env[name];
  try {
    return new RegExp(`^${name}=["']?([^"'\\n]+)`, "m").exec(readFileSync(file, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}
const KEYS = {
  deepseek: loadKey("DEEPSEEK_API_KEY", `${homedir()}/ghosty-studio/.env`),
  anthropic: loadKey("ANTHROPIC_API_KEY", `${homedir()}/fixter2025/.env`),
};
if (!KEYS.deepseek && !KEYS.anthropic) {
  console.error("Falta DEEPSEEK_API_KEY o ANTHROPIC_API_KEY");
  process.exit(1);
}

// Precio en USD por millón de tokens (gs `model-pricing.ts`); `cacheWrite` sólo aplica a Anthropic.
const MODELS = {
  "anthropic/claude-sonnet-5-5": { provider: "anthropic", id: "claude-sonnet-5-5", context: 200_000, maxOut: 8_000, price: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  "deepseek/deepseek-flash": { provider: "deepseek", id: "deepseek-flash", context: 128_000, maxOut: 8_000, price: { in: 0.3, out: 1.2, cacheRead: 0.006, cacheWrite: 0.3 } },
};
const DEFAULT_MODEL = "deepseek/deepseek-flash";
const costOf = (model, u) => {
  const p = MODELS[model].price;
  return (u.input * p.in + u.cacheRead * p.cacheRead + (u.cacheWrite ?? 0) * p.cacheWrite + u.output * p.out) / 1e6;
};

const tokens = new Map();
let spentUsd = 0;
// Registro de cada paso del modelo (lo lee el e2e para el README).
const steps = [];

const partsOf = (c) => (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : []);

function toolOutputText(o) {
  if (!o) return "";
  if (o.type === "text" || o.type === "error-text") return String(o.value ?? "");
  if (o.type === "json" || o.type === "error-json") return JSON.stringify(o.value);
  if (o.type === "execution-denied") return `Denegado: ${o.reason ?? ""}`;
  if (o.type === "content" && Array.isArray(o.value)) return o.value.map((p) => (p.type === "text" ? p.text : `[${p.mediaType ?? p.type}]`)).join("\n");
  return JSON.stringify(o.value ?? "");
}

// Resultado de tool para Anthropic: con imágenes (captura de `computer`) va como bloques image.
function anthropicToolContent(o) {
  if (o?.type === "content" && Array.isArray(o.value) && o.value.some((p) => p.type !== "text")) {
    return o.value.flatMap((p) => {
      if (p.type === "text") return p.text ? [{ type: "text", text: p.text }] : [];
      const data = p.data ?? p.base64;
      const media = p.mediaType ?? p.mimeType;
      if (typeof data === "string" && /^image\//.test(media ?? "")) return [{ type: "image", source: { type: "base64", media_type: media, data } }];
      return [{ type: "text", text: `[${media ?? p.type}]` }];
    });
  }
  return toolOutputText(o) || "(vacío)";
}

function toChatCompletions(req, model) {
  const messages = [];
  for (const m of req.prompt ?? []) {
    const parts = partsOf(m.content);
    if (m.role === "system") messages.push({ role: "system", content: parts.map((p) => p.text ?? "").join("\n") });
    else if (m.role === "user") messages.push({ role: "user", content: parts.map((p) => (p.type === "text" ? p.text : `[adjunto ${p.mediaType ?? p.type} omitido]`)).join("\n") });
    else if (m.role === "assistant") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const calls = parts
        .filter((p) => p.type === "tool-call")
        .map((p) => ({ id: p.toolCallId, type: "function", function: { name: p.toolName, arguments: typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}) } }));
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === "tool") {
      for (const p of parts) if (p.type === "tool-result") messages.push({ role: "tool", tool_call_id: p.toolCallId, content: toolOutputText(p.output) });
    }
  }
  const tools = (req.tools ?? [])
    .filter((t) => t.type === "function")
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } } }));
  const tc = req.toolChoice;
  const toolChoice = !tc || !tools.length ? undefined : tc.type === "tool" ? { type: "function", function: { name: tc.toolName } } : tc.type;
  const spec = MODELS[model] ?? MODELS[DEFAULT_MODEL];
  return {
    model: spec.id,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    max_tokens: Math.min(req.maxOutputTokens ?? spec.maxOut, spec.maxOut),
    thinking: { type: "disabled" },
    stream: true,
    stream_options: { include_usage: true },
  };
}

// ── Anthropic Messages API (nativa: tool_use / tool_result, streaming y caché de prompt) ──
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function toAnthropic(req, model) {
  const system = [];
  const messages = [];
  // Anthropic exige alternar user/assistant: los turnos seguidos del mismo rol se juntan.
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of req.prompt ?? []) {
    const parts = partsOf(m.content);
    if (m.role === "system") system.push(...parts.filter((p) => p.text).map((p) => ({ type: "text", text: p.text })));
    else if (m.role === "user") push("user", parts.map((p) => (p.type === "text" ? { type: "text", text: p.text ?? "" } : { type: "text", text: `[adjunto ${p.mediaType ?? p.type} omitido]` })).filter((b) => b.text));
    else if (m.role === "assistant") {
      push(
        "assistant",
        parts.flatMap((p) => {
          if (p.type === "text" && p.text) return [{ type: "text", text: p.text }];
          if (p.type === "tool-call") {
            let input = p.input ?? {};
            if (typeof input === "string") {
              try {
                input = JSON.parse(input || "{}");
              } catch {
                input = {};
              }
            }
            return [{ type: "tool_use", id: p.toolCallId, name: p.toolName, input }];
          }
          return [];
        }),
      );
    } else if (m.role === "tool") {
      push(
        "user",
        parts
          .filter((p) => p.type === "tool-result")
          .map((p) => ({ type: "tool_result", tool_use_id: p.toolCallId, content: anthropicToolContent(p.output), ...(String(p.output?.type ?? "").startsWith("error") ? { is_error: true } : {}) })),
      );
    }
  }
  const tools = (req.tools ?? []).filter((t) => t.type === "function").map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema ?? { type: "object", properties: {} } }));
  // Caché: el prefijo (tools + system) se marca una vez; el último mensaje también, para que cada
  // paso del loop lea del caché todo lo anterior.
  if (tools.length) tools.at(-1).cache_control = { type: "ephemeral" };
  if (system.length) system.at(-1).cache_control = { type: "ephemeral" };
  const lastBlock = messages.at(-1)?.content.at(-1);
  if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
  const tc = req.toolChoice;
  const toolChoice = !tc || !tools.length ? undefined : tc.type === "tool" ? { type: "tool", name: tc.toolName } : tc.type === "required" ? { type: "any" } : tc.type === "none" ? { type: "none" } : { type: "auto" };
  const spec = MODELS[model];
  return {
    model: spec.id,
    max_tokens: Math.min(req.maxOutputTokens ?? spec.maxOut, spec.maxOut),
    ...(system.length ? { system } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    stream: true,
  };
}

const ANTHROPIC_FINISH = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool-calls", max_tokens: "length", refusal: "content-filter", pause_turn: "other" };

// Traduce el SSE de Anthropic a partes del AI SDK.
async function pipeAnthropic(upstream, res, model, onUsage) {
  const send = (part) => res.write(`data: ${JSON.stringify(part)}\n\n`);
  const dec = new TextDecoder();
  let buf = "";
  let finish = "other";
  const blocks = new Map(); // index → {kind, id, name, args}
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  send({ type: "stream-start", warnings: [] });
  send({ type: "response-metadata", modelId: model });
  try {
    for await (const chunk of upstream.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let e;
        try {
          e = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (e.type === "message_start") {
          const u = e.message?.usage ?? {};
          usage.input = u.input_tokens ?? 0;
          usage.cacheRead = u.cache_read_input_tokens ?? 0;
          usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        } else if (e.type === "content_block_start") {
          const b = e.content_block;
          if (b.type === "text") {
            blocks.set(e.index, { kind: "text", id: `t${e.index}` });
            send({ type: "text-start", id: `t${e.index}` });
            if (b.text) send({ type: "text-delta", id: `t${e.index}`, delta: b.text });
          } else if (b.type === "tool_use") {
            blocks.set(e.index, { kind: "tool", id: b.id, name: b.name, args: "" });
            send({ type: "tool-input-start", id: b.id, toolName: b.name });
          }
        } else if (e.type === "content_block_delta") {
          const b = blocks.get(e.index);
          if (!b) continue;
          if (e.delta.type === "text_delta") send({ type: "text-delta", id: b.id, delta: e.delta.text });
          else if (e.delta.type === "input_json_delta") {
            b.args += e.delta.partial_json;
            send({ type: "tool-input-delta", id: b.id, delta: e.delta.partial_json });
          }
        } else if (e.type === "content_block_stop") {
          const b = blocks.get(e.index);
          if (b?.kind === "text") send({ type: "text-end", id: b.id });
          else if (b?.kind === "tool") {
            send({ type: "tool-input-end", id: b.id });
            send({ type: "tool-call", toolCallId: b.id, toolName: b.name, input: b.args || "{}" });
          }
        } else if (e.type === "message_delta") {
          if (e.delta?.stop_reason) finish = ANTHROPIC_FINISH[e.delta.stop_reason] ?? "other";
          if (e.usage?.output_tokens != null) usage.output = e.usage.output_tokens;
        } else if (e.type === "error") {
          throw new Error(e.error?.message ?? "error del proveedor");
        }
      }
    }
    const usd = costOf(model, usage);
    onUsage({ input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, usd });
    send({
      type: "finish",
      finishReason: { unified: finish, raw: finish },
      usage: { inputTokens: { total: usage.input + usage.cacheRead + usage.cacheWrite, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }, outputTokens: { total: usage.output } },
      providerMetadata: { gateway: { cost: usd.toFixed(6) } },
    });
  } catch (e) {
    send({ type: "error", error: { code: "provider_error", message: String(e.message).slice(0, 200) } });
    send({ type: "finish", finishReason: { unified: "error", raw: "provider_error" } });
  }
  res.end();
}

const FINISH = { stop: "stop", tool_calls: "tool-calls", length: "length", content_filter: "content-filter" };

// Traduce el SSE de chat completions a partes del AI SDK y lo escribe en `res`.
async function pipeGateway(upstream, res, model, onUsage) {
  const send = (part) => res.write(`data: ${JSON.stringify(part)}\n\n`);
  const dec = new TextDecoder();
  let buf = "";
  let textOpen = false;
  let finish = "other";
  const calls = new Map();
  const usage = { input: 0, output: 0, cacheRead: 0 };
  send({ type: "stream-start", warnings: [] });
  send({ type: "response-metadata", modelId: model });
  try {
    for await (const chunk of upstream.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:") || line === "data: [DONE]") continue;
        let j;
        try {
          j = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        const ch = j.choices?.[0];
        const d = ch?.delta;
        if (d?.content) {
          if (!textOpen) send({ type: "text-start", id: "t0" });
          textOpen = true;
          send({ type: "text-delta", id: "t0", delta: d.content });
        }
        for (const tc of d?.tool_calls ?? []) {
          const call = calls.get(tc.index) ?? { id: "", name: "", args: "", started: false };
          calls.set(tc.index, call);
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (!call.started && call.id && call.name) {
            call.started = true;
            send({ type: "tool-input-start", id: call.id, toolName: call.name });
            if (call.args) send({ type: "tool-input-delta", id: call.id, delta: call.args });
          }
          if (tc.function?.arguments) {
            call.args += tc.function.arguments;
            if (call.started) send({ type: "tool-input-delta", id: call.id, delta: tc.function.arguments });
          }
        }
        if (ch?.finish_reason) finish = FINISH[ch.finish_reason] ?? "other";
        if (j.usage) {
          usage.input = j.usage.prompt_tokens ?? 0;
          usage.output = j.usage.completion_tokens ?? 0;
          usage.cacheRead = j.usage.prompt_cache_hit_tokens ?? 0;
        }
      }
    }
    if (textOpen) send({ type: "text-end", id: "t0" });
    for (const call of calls.values()) {
      if (!call.started) send({ type: "tool-input-start", id: call.id, toolName: call.name });
      send({ type: "tool-input-end", id: call.id });
      send({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.args || "{}" });
    }
    const usd = costOf(model, { input: usage.input - usage.cacheRead, cacheRead: usage.cacheRead, output: usage.output });
    onUsage({ ...usage, usd });
    send({
      type: "finish",
      finishReason: { unified: finish, raw: finish },
      usage: { inputTokens: { total: usage.input, cacheRead: usage.cacheRead }, outputTokens: { total: usage.output } },
      providerMetadata: { gateway: { cost: usd.toFixed(6) } },
    });
  } catch (e) {
    send({ type: "error", error: { code: "provider_error", message: String(e.message).slice(0, 200) } });
    send({ type: "finish", finishReason: { unified: "error", raw: "provider_error" } });
  }
  res.end();
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 2_000_000) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

function authOk(req) {
  const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const exp = t && tokens.get(t);
  return !!exp && exp > Date.now();
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin ?? "";
  const fromExtension = origin === EXT_ORIGIN;
  const cors = fromExtension ? { "access-control-allow-origin": origin, "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "authorization, content-type", "access-control-allow-methods": "GET, POST" } : {};
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { "cache-control": "no-store", ...cors, ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return reply(204, "");
  const path = new URL(req.url, "http://x").pathname;

  // Pasos registrados (los lee el e2e desde la página del panel).
  if (path === "/stats") return fromExtension ? reply(200, { spentUsd, steps }, { "content-type": "application/json" }) : reply(403, "sólo la extensión");

  if (path === "/token" && req.method === "POST") {
    if (!fromExtension) return reply(403, "sólo la extensión");
    // Limpia los vencidos para que el mapa no crezca sin fin.
    const now = Date.now();
    for (const [t, exp] of tokens) if (exp <= now) tokens.delete(t);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    tokens.set(token, expiresAt);
    return reply(200, { token, expiresAt }, { "content-type": "application/json" });
  }
  if (!authOk(req)) return reply(401, "token inválido");

  if (path.endsWith("/coding-agent/v1/models")) {
    return reply(200, { data: Object.entries(MODELS).map(([id, m]) => ({ id, type: "language", tags: ["tool-use"], context_window: m.context, max_tokens: m.maxOut })) }, { "content-type": "application/json" });
  }
  // Subllamada barata y sin streaming (la tool `find` de la extensión): siempre DeepSeek.
  if (path === "/complete" && req.method === "POST") {
    if (spentUsd >= BUDGET_USD) return reply(429, `tope de $${BUDGET_USD} alcanzado`);
    if (!KEYS.deepseek) return reply(503, "sin llave de DeepSeek");
    let q;
    try {
      q = JSON.parse(await readBody(req));
    } catch {
      return reply(400, "json inválido");
    }
    const model = "deepseek/deepseek-flash";
    const t0 = Date.now();
    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEYS.deepseek}` },
      body: JSON.stringify({ model: MODELS[model].id, messages: [{ role: "system", content: String(q.system ?? "").slice(0, 4000) }, { role: "user", content: String(q.user ?? "").slice(0, 60_000) }], max_tokens: 600, thinking: { type: "disabled" }, response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => ({ ok: false, status: 502, text: async () => e.message }));
    if (!r.ok) return reply(502, `proveedor ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const u = j.usage ?? {};
    const cacheRead = u.prompt_cache_hit_tokens ?? 0;
    const usage = { input: (u.prompt_tokens ?? 0) - cacheRead, cacheRead, output: u.completion_tokens ?? 0 };
    const usd = costOf(model, usage);
    spentUsd += usd;
    steps.push({ model, kind: "complete", ttfbMs: Date.now() - t0, totalMs: Date.now() - t0, in: usage.input, out: usage.output, cache: cacheRead, usd });
    console.log(`[fx-proxy] complete ${Date.now() - t0}ms in=${usage.input} out=${usage.output} $${usd.toFixed(5)}`);
    return reply(200, { text: j.choices?.[0]?.message?.content ?? "", usd }, { "content-type": "application/json" });
  }

  if (req.method !== "POST" || !/\/v[34]\/ai\/language-model$/.test(path)) return reply(404, "Not found");
  if (spentUsd >= BUDGET_USD) return reply(429, `tope de $${BUDGET_USD} alcanzado`);

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return reply(400, "json inválido");
  }
  const model = req.headers["ai-language-model-id"] ?? DEFAULT_MODEL;
  const spec = MODELS[model];
  if (!spec) return reply(400, `modelo no disponible: ${model}`);
  const key = KEYS[spec.provider];
  if (!key) return reply(503, `sin llave para ${spec.provider}`);
  const anthropic = spec.provider === "anthropic";

  const t0 = Date.now();
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  let upstream;
  try {
    upstream = await fetch(anthropic ? ANTHROPIC_URL : DEEPSEEK_URL, {
      method: "POST",
      headers: anthropic
        ? { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(anthropic ? toAnthropic(body, model) : toChatCompletions(body, model)),
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(120_000)]),
    });
  } catch (e) {
    return reply(502, `proveedor: ${e.message}`);
  }
  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 300);
    return reply(upstream.status >= 500 ? 502 : upstream.status, `proveedor ${upstream.status}: ${detail}`);
  }
  const ttfb = Date.now() - t0;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", ...cors });
  await (anthropic ? pipeAnthropic : pipeGateway)(upstream, res, model, (u) => {
    spentUsd += u.usd;
    const step = { model, ttfbMs: ttfb, totalMs: Date.now() - t0, in: u.input, out: u.output, cache: u.cacheRead, cacheWrite: u.cacheWrite ?? 0, usd: u.usd };
    steps.push(step);
    console.log(`[fx-proxy] paso ${model} ttfb=${ttfb}ms total=${step.totalMs}ms in=${u.input} out=${u.output} cache=${u.cacheRead} $${u.usd.toFixed(5)}`);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[fx-proxy] http://127.0.0.1:${PORT} (tope $${BUDGET_USD}, extensión ${EXT_ID})`));
