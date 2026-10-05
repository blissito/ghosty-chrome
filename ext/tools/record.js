// Grabación de la tarea como GIF (el gif_creator de Claude in Chrome): con la grabación prendida,
// cada acción que cambia la página deja un cuadro (captura CDP, con el cursor y el borde de Ghosty).
// Al exportar se codifica aquí mismo con gifenc (MIT) y el GIF viaja como ARCHIVO en el resultado
// (`ghosty.file`): gs lo guarda en la conversación de /c y el MCP de la terminal lo escribe en disco.
import { GIFEncoder, applyPalette, quantize } from "../vendor/gifenc/gifenc.esm.js";

const MAX_WIDTH = 800;

export async function encodeGif(frames, { width = MAX_WIDTH, delayMs = 800, lastDelayMs = 2200 } = {}) {
  if (!frames.length) throw new Error("No hay cuadros grabados.");
  const gif = GIFEncoder();
  let canvas = null;
  let ctx = null;
  for (let i = 0; i < frames.length; i++) {
    const blob = await (await fetch(`data:image/jpeg;base64,${frames[i].data}`)).blob();
    const bmp = await createImageBitmap(blob);
    const w = Math.min(width, bmp.width);
    const h = Math.round((bmp.height * w) / bmp.width);
    if (!canvas) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, canvas.width, canvas.height, { palette, delay: i === frames.length - 1 ? lastDelayMs : delayMs });
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

// Ruta final de una descarga (espera a que termine, máx. 10 s).
async function downloadedPath(id) {
  for (let i = 0; i < 50; i++) {
    const [d] = await chrome.downloads.search({ id });
    if (d?.state === "complete") return d.filename;
    if (d?.state === "interrupted") return null;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function recordTools({ host, timed, guardTab, capture }) {
  const rec = host.recorder;
  return [
    {
      name: "gif_creator",
      description:
        "Graba lo que haces como GIF. action: start_recording (empieza; toma el primer cuadro), stop_recording (deja de grabar), export (arma el GIF, lo guarda en Descargas y lo entrega también como archivo; filename opcional), clear (borra los cuadros). Toma captura extra antes y después de las acciones clave para que se entienda.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start_recording", "stop_recording", "export", "clear"] },
          filename: { type: "string" },
          download: { type: "boolean", description: "Guardarlo en la carpeta de Descargas (default true)" },
        },
        required: ["action"],
      },
      execute: timed("gif_creator", async ({ action, filename, download }, call) => {
        if (action === "start_recording") {
          rec.on = true;
          const tabId = await guardTab(call);
          const shot = await capture(tabId).catch(() => null);
          if (shot) rec.frames.push({ data: shot.dataUrl.split(",")[1], at: Date.now(), label: "inicio" });
          host.onRecorder?.();
          return { ok: true, recording: true, frames: rec.frames.length };
        }
        if (action === "stop_recording") {
          // Último cuadro: cómo quedó.
          const tabId = await guardTab(call).catch(() => null);
          if (rec.on && tabId != null) {
            const shot = await capture(tabId).catch(() => null);
            if (shot) rec.frames.push({ data: shot.dataUrl.split(",")[1], at: Date.now(), label: "fin" });
          }
          rec.on = false;
          host.onRecorder?.();
          return { ok: true, recording: false, frames: rec.frames.length };
        }
        if (action === "clear") {
          rec.frames.length = 0;
          host.onRecorder?.();
          return { ok: true, frames: 0 };
        }
        if (action === "export") {
          if (!rec.frames.length) return { error: "No hay cuadros: usa start_recording antes de las acciones." };
          const blob = await encodeGif(rec.frames);
          const name = `${String(filename || `ghosty-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`).replace(/[^\w.-]+/g, "-").replace(/\.gif$/i, "")}.gif`;
          const data = await blobBase64(blob);
          // En Descargas, salvo que quien lo pide lo guarde aparte (/c lo deja en la conversación).
          let saved = null;
          if (download !== false) {
            const id = await chrome.downloads.download({ url: `data:image/gif;base64,${data}`, filename: name, saveAs: false, conflictAction: "uniquify" }).catch((e) => ({ error: e.message }));
            saved = typeof id === "number" ? await downloadedPath(id) : null;
          }
          return { type: "ghosty.file", name, mimeType: "image/gif", data, text: `GIF ${name}: ${rec.frames.length} cuadros, ${Math.round(blob.size / 1024)} KB${saved ? ` · guardado en ${saved}` : ""}` };
        }
        return { error: `action desconocida: ${action}` };
      }),
    },
  ];
}
