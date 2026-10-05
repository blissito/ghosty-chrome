// `computer` (mouse y teclado por coordenadas, como computer use) y las de DevTools: JavaScript,
// consola, red y archivos. Todo por CDP (`cdp.js`): eventos *trusted*, iguales a los de una persona.
//
// Las coordenadas son píxeles CSS de la ventana: las de `[box=…]` en read_page con boxes:true y las de la
// captura de `computer screenshot` (que sale a 1 px de imagen = 1 px CSS).

const ACTIONS = ["screenshot", "left_click", "right_click", "double_click", "triple_click", "hover", "key", "type", "scroll", "left_click_drag", "zoom", "wait"];

export function computerTools({ confirmGate, host, cdp, exec, guardTab, cursor, frameState, waitForLoad, waitForCompletion, aimClick, resolveTarget, capture, checkAbort, timed, sleep, pageInspect, pageFocusInfo, asData }) {
  const pointOf = async (tabId, { coordinate, target, ref }) => {
    if (target ?? ref) {
      const info = await resolveTarget(tabId, { target: target ?? ref });
      const box = await exec(tabId, (sel) => {
        const el = document.querySelector(sel);
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, [info.selector]);
      return { point: box, info };
    }
    if (!Array.isArray(coordinate) || coordinate.length !== 2) throw new Error("Falta coordinate [x, y] (o target).");
    const point = { x: Number(coordinate[0]), y: Number(coordinate[1]) };
    return { point, info: null };
  };

  // Imagen al modelo si ve; si no, se guarda (attach_image la puede usar) y se le dice que use read_page.
  const imageResult = (shot, text) =>
    host.vision
      ? { type: "libfx.tool-result", text, images: [{ type: "image", data: shot.data, mimeType: shot.mimeType }] }
      : { ok: true, note: `${text}. El modelo actual no ve imágenes: la captura quedó guardada para attach_image; para saber qué hay en pantalla usa read_page (con boxes:true trae coordenadas).` };

  return [
    {
      name: "computer",
      description:
        "Mouse y teclado reales por coordenadas (píxeles CSS de la ventana; read_page con boxes:true da [box=x,y,w,h]). action: screenshot | left_click | right_click | double_click | triple_click | hover | key (text='Enter', 'ctrl+a', 'Tab Tab') | type (text, en el campo con foco) | scroll (coordinate, scroll_direction, scroll_amount) | left_click_drag (start_coordinate → coordinate) | zoom (region [x0,y0,x1,y1]) | wait (duration s). En vez de coordinate puedes pasar target (ref del snapshot).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ACTIONS },
          coordinate: { type: "array", items: { type: "number" } },
          start_coordinate: { type: "array", items: { type: "number" } },
          target: { type: "string", description: "Exact target element reference from the page snapshot, or a unique element selector" },
          text: { type: "string" },
          scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
          scroll_amount: { type: "number" },
          region: { type: "array", items: { type: "number" } },
          duration: { type: "number" },
        },
        required: ["action"],
      },
      execute: timed("computer", async (input, call) => {
        const { action } = input;
        const tabId = await guardTab(call);
        if (action === "screenshot") {
          void cursor(tabId, "pulse", { label: "mirando…" });
          const saved = await capture(tabId);
          const shot = { data: saved.dataUrl.split(",")[1], mimeType: "image/jpeg" };
          return imageResult(shot, `Captura ${saved.width}×${saved.height} (px CSS) de ${saved.url}`);
        }
        if (action === "zoom") {
          const [x0, y0, x1, y1] = (input.region ?? []).map(Number);
          if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return { error: "region debe ser [x0, y0, x1, y1]" };
          const w = x1 - x0;
          const h = y1 - y0;
          const shot = await cdp.screenshot(tabId, { clip: { x: x0, y: y0, w, h }, scale: Math.min(4, Math.max(1, 1280 / Math.max(w, h))), quality: 85 });
          return imageResult(shot, `Zoom de [${x0},${y0},${x1},${y1}] a ${shot.width}×${shot.height}`);
        }
        if (action === "wait") {
          await sleep(Math.min(10, Math.max(0, Number(input.duration) || 1)) * 1000);
          return { ok: true };
        }
        if (action === "key" || action === "type") {
          const text = String(input.text ?? "");
          if (!text) return { error: "Falta text." };
          const focus = await exec(tabId, pageFocusInfo, []);
          if (focus?.isPassword) return { error: "El foco está en un campo de contraseña: lo llena la persona. No lo intentes de otra forma." };
          if (action === "key" && /enter/i.test(text)) {
            const held = await confirmGate("computer", tabId, focus, focus?.formCtx || focus?.submitLabel ? "submit" : "key", call.input);
            if (held) return held;
          }
          if (action === "type") {
            await cursor(tabId, "pulse", { label: "escribiendo…" });
            // En trozos, para que se vea teclear y los editores procesen cada parte.
            for (let i = 0; i < text.length; i += 40) {
              checkAbort();
              await cdp.insertText(tabId, text.slice(i, i + 40));
            }
            return { ok: true, typed: text.length, into: focus?.label || focus?.tag || "(nada con foco)" };
          }
          await cursor(tabId, "pulse", { label: `tecla · ${text.slice(0, 20)}` });
          await waitForCompletion(tabId, () => cdp.pressKeys(tabId, text));
          return { ok: true, key: text, url: (await chrome.tabs.get(tabId)).url };
        }
        if (action === "scroll") {
          const { point } = input.coordinate || input.target || input.ref ? await pointOf(tabId, input) : { point: null };
          const vp = point ?? (await exec(tabId, () => ({ x: innerWidth / 2, y: innerHeight / 2 }), []));
          const n = Math.min(20, Math.max(1, Number(input.scroll_amount) || 3));
          const dir = input.scroll_direction ?? "down";
          const dx = dir === "left" ? -100 * n : dir === "right" ? 100 * n : 0;
          const dy = dir === "up" ? -100 * n : dir === "down" ? 100 * n : 0;
          void cursor(tabId, "move", { point: vp, label: "desplazando" });
          await cdp.wheel(tabId, vp.x, vp.y, dx, dy);
          await sleep(300);
          return { ok: true };
        }
        if (action === "left_click_drag") {
          if (!Array.isArray(input.start_coordinate)) return { error: "Falta start_coordinate." };
          const from = { x: Number(input.start_coordinate[0]), y: Number(input.start_coordinate[1]) };
          const { point: to } = await pointOf(tabId, input);
          await cursor(tabId, "move", { point: from, label: "arrastrando…", hold: true });
          await cdp.mouseDrag(tabId, from, to);
          await cursor(tabId, "move", { point: to, label: "soltado", ring: true });
          return { ok: true };
        }
        if (action === "hover") {
          const { point } = await pointOf(tabId, input);
          await cursor(tabId, "move", { point, label: "encima" });
          await cdp.mouseMove(tabId, point.x, point.y);
          await sleep(300);
          return { ok: true };
        }
        if (/click$/.test(action)) {
          const { point, info: byRef } = await pointOf(tabId, input);
          const info = byRef ?? (await exec(tabId, pageInspect, [{ point }]));
          if (!info?.found) return { error: `No hay nada en ${point.x},${point.y}.` };
          if (info.captcha) return { error: "Es un captcha: lo resuelve la persona, nunca tú. Avísale que lo complete y espera a que te diga." };
          if (action !== "right_click") {
            const held = await confirmGate("computer", tabId, info, "click", call.input);
            if (held) return held;
          }
          if (action !== "right_click") await aimClick(tabId, info, { point });
          else await cursor(tabId, "move", { point, label: "clic derecho", ring: true });
          const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
          await waitForCompletion(tabId, () => cdp.mouseClick(tabId, point.x, point.y, { button: action === "right_click" ? "right" : "left", clickCount }));
          void cursor(tabId, "frame", { state: frameState() });
          return { ok: true, clicked: info.label || info.tag, at: [Math.round(point.x), Math.round(point.y)], url: (await chrome.tabs.get(tabId)).url };
        }
        return { error: `action desconocida: ${action}` };
      }),
    },
    {
      name: "evaluate",
      description: "Evaluate JavaScript expression on page or element",
      inputSchema: {
        type: "object",
        properties: {
          element: { type: "string", description: "Human-readable element description used to obtain permission to interact with the element" },
          target: { type: "string", description: "Exact target element reference from the page snapshot, or a unique element selector" },
          function: { type: "string", description: "() => { /* code */ } or (element) => { /* code */ } when element is provided" },
        },
        required: ["function"],
      },
      execute: timed("evaluate", async ({ function: fn, code, target }, call) => {
        const tabId = await guardTab(call);
        const src = String(fn ?? code ?? "");
        void cursor(tabId, "pulse", { label: "javascript" });
        // Con target, el elemento se marca en el DOM y la función lo recibe en el mundo de la página.
        const sel = target ? (await resolveTarget(tabId, { target })).selector : null;
        const expr = `(async () => { const __v = (${src}); const __el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : "undefined"}; return typeof __v === "function" ? await __v(__el) : await __v; })()`;
        let r = await waitForCompletion(tabId, () => cdp.evaluate(tabId, expr));
        // Varias sentencias sueltas (no una expresión ni una función): se evalúan tal cual.
        if (!r.ok && /SyntaxError/.test(r.error ?? "")) r = await cdp.evaluate(tabId, src);
        const text = JSON.stringify(r.value ?? null);
        return asData({ ...r, value: text && text.length > 8000 ? `${text.slice(0, 8000)}…` : r.value });
      }),
    },
    {
      name: "console_messages",
      description: "Returns all console messages",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["error", "warning", "info", "debug"], description: 'Level of the console messages to return. Each level includes the messages of more severe levels. Defaults to "info".' },
          all: { type: "boolean", description: "Return all console messages since the beginning of the session, not just since the last navigation. Defaults to false." },
          pattern: { type: "string", description: "Regex para filtrar por texto o URL (extra de Ghosty)" },
        },
      },
      execute: timed("console_messages", async ({ level, all, pattern, onlyErrors }, call) => {
        const tabId = await guardTab(call);
        if (!cdp.isAttached(tabId)) {
          // Recién enganchado: se escuchan 2.5 s para atrapar lo que la página registre periódicamente.
          await cdp.attach(tabId);
          await sleep(2500);
        }
        const messages = cdp.consoleMessages(tabId, { level: onlyErrors ? "error" : level ?? "info", all: !!all, pattern, limit: 200 }) ?? [];
        if (!messages.length) return "No console messages (sólo se registran desde que Ghosty se enganchó a la pestaña; recarga con navigate si esperas algo de la carga).";
        return `<untrusted_page_data>\n${messages.map((m) => `[${m.level.toUpperCase()}] ${m.text.slice(0, 500)}${m.url ? ` @ ${m.url}` : ""}`).join("\n")}\n</untrusted_page_data>`;
      }),
    },
    {
      name: "network_requests",
      description: "Returns a numbered list of network requests since loading the page.",
      inputSchema: {
        type: "object",
        properties: {
          static: { type: "boolean", description: "Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false." },
          filter: { type: "string", description: 'Only return requests whose URL matches this regexp (e.g. "/api/.*user").' },
        },
      },
      execute: timed("network_requests", async ({ static: withStatic, filter, pattern }, call) => {
        const tabId = await guardTab(call);
        if (!cdp.isAttached(tabId)) {
          await cdp.attach(tabId);
          await sleep(2500);
        }
        const requests = cdp.networkRequests(tabId, { filter: filter ?? pattern, static: !!withStatic, limit: 200 }) ?? [];
        if (!requests.length) return "No network requests (sólo se registran desde que Ghosty se enganchó; recarga con navigate o repite la acción).";
        return requests.map((r, i) => `${i + 1}. [${r.method}] ${r.url.slice(0, 300)} => ${r.status ? `[${r.status}]` : r.failed ? `[FAILED ${r.failed}]` : "[pending]"}`).join("\n");
      }),
    },
    {
      name: "file_upload",
      description: "Upload one or multiple files (rutas locales) en un <input type=file>, sin abrir el selector. Pasa como target el ref del input de la sección «Subir archivos» de read_page (también lista los inputs OCULTOS que TikTok/YouTube esconden tras un botón). Sin target: llena el selector que acaba de abrir un clic (interceptado, la persona no lo ve) o, si no hubo, el primer input de la página. Para capturas usa attach_image.",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "The absolute paths to the files to upload. Can be single file or multiple files." },
          target: { type: "string", description: "Exact target element reference from the page snapshot, or a unique element selector" },
        },
        required: ["paths"],
      },
      execute: timed("file_upload", async ({ paths, target, ref, selector }, call) => {
        const tabId = await guardTab(call);
        const files = (paths ?? []).map(String).filter((p) => p.startsWith("/") || /^[A-Z]:\\/.test(p));
        if (!files.length) return { error: "paths debe traer rutas absolutas." };
        // El clic anterior abrió el selector (interceptado): se llena ése, sin buscar el input.
        if (!(target ?? ref ?? selector) && cdp.pendingChooser(tabId)) {
          try {
            await cdp.fillChooser(tabId, files);
          } catch (e) {
            return { error: `No pude poner el archivo (${e.message}).` };
          }
          return { ok: true, files, via: "selector interceptado" };
        }
        const sel = target ?? ref ? (await resolveTarget(tabId, { target: target ?? ref })).selector : selector ?? "input[type=file]";
        await cursor(tabId, "move", { selector: sel, label: "subiendo archivo…", ring: true });
        try {
          await cdp.setFileInputFiles(tabId, sel, files);
          if (cdp.pendingChooser(tabId)) await cdp.fillChooser(tabId, files).catch(() => {});
        } catch (e) {
          return { error: `No pude poner el archivo (${e.message}). Alternativa: attach_image con source 'url' o 'screenshot'.` };
        }
        return { ok: true, files };
      }),
    },
  ];
}
