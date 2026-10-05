// Prueba del camino Sonnet sin el navegador: libfx (Node) → proxy → Anthropic, con una tool de host.
import { createFxAgent } from "libfx";
const PROXY = "http://127.0.0.1:8787";
const ORIGIN = "chrome-extension://okgofgcccjajcokgpjmdlpgjpjoibpca";
const { token } = await (await fetch(`${PROXY}/token`, { method: "POST", headers: { origin: ORIGIN } })).json();
const calls = [];
const agent = await createFxAgent({
  apiKey: token,
  model: process.env.MODEL ?? "anthropic/claude-sonnet-5-5",
  instructions: "Responde en español, breve. Usa las tools cuando haga falta.",
  tools: [
    {
      name: "read_page",
      description: "Lee la página actual del navegador.",
      inputSchema: { type: "object", properties: { maxChars: { type: "number" } } },
      execute: async (input) => (calls.push({ name: "read_page", input }), { url: "https://www.ghosty.studio/planes", text: "Planes: Gratis $0/mes · Pro $299/mes · Power $1,499/mes · Max $1,799/mes" }),
    },
  ],
  fetch: (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("origin", ORIGIN);
    return fetch(`${PROXY}${new URL(url).pathname}`, { ...init, headers });
  },
});
const t0 = Date.now();
const turn = agent.prompt("Lee la página y dime el precio del plan Pro.");
let text = "";
let firstText = null;
for await (const ev of turn) if (ev.type === "text_delta") ((firstText ??= Date.now() - t0), (text += ev.delta));
const r = await turn.result;
console.log(JSON.stringify({ ms: Date.now() - t0, firstTextMs: firstText, calls, stop: r.stopReason, usage: r.usage, text }, null, 1));
await agent.close();
const stats = await (await fetch(`${PROXY}/stats`, { headers: { origin: ORIGIN } })).json();
console.log(stats.steps.slice(-3));
