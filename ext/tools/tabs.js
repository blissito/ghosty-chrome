// Pestañas del agente: todas viven en un grupo «Ghosty» (morado) por ventana, como el grupo de
// Claude in Chrome. El agente sólo ve, cambia y cierra las pestañas de su grupo.

const GROUP_TITLE = "Ghosty";
// Mientras trabaja, el grupo lleva 👾 delante (como el ⌛ del grupo de Claude).
const GROUP_TITLE_BUSY = "👾 Ghosty";
const isGhostyTitle = (t) => t === GROUP_TITLE || t === GROUP_TITLE_BUSY;

export async function groupOf(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find((g) => isGhostyTitle(g.title))?.id ?? null;
}

/** Pone o quita el 👾 del título del grupo de la pestaña. Nunca falla. */
export async function markGroupBusy(tabId, busy) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groupId = await groupOf(tab.windowId);
    if (groupId != null) await chrome.tabGroups.update(groupId, { title: busy ? GROUP_TITLE_BUSY : GROUP_TITLE });
  } catch {}
}

/** Mete la pestaña al grupo «Ghosty» de su ventana (lo crea si no existe). */
export async function ensureInGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const existing = await groupOf(tab.windowId);
    if (tab.groupId !== -1 && tab.groupId === existing) return existing;
    if (existing != null) {
      await chrome.tabs.group({ groupId: existing, tabIds: [tabId] });
      return existing;
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "purple", collapsed: false });
    return groupId;
  } catch {
    return null;
  }
}

async function groupTabs(windowId) {
  const groupId = await groupOf(windowId);
  if (groupId == null) return [];
  return chrome.tabs.query({ groupId });
}

/**
 * Geometría de la pestaña, para pasar los `[box=x,y,w,h]` de read_page (px CSS del viewport) a
 * coordenadas de pantalla: el contenido empieza en x ≈ screenX + (outerWidth − innerWidth − ancho del
 * panel lateral si está abierto a la derecha) y en y ≈ screenY + (outerHeight − innerHeight). Lo usa
 * el notch de Mac.
 */
export async function viewportOf(tabId) {
  const [r] = await chrome.scripting
    .executeScript({ target: { tabId }, func: () => ({ screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY }) })
    .catch(() => []);
  const tab = await chrome.tabs.get(tabId);
  const ctxs = await chrome.runtime.getContexts?.({ contextTypes: ["SIDE_PANEL"] }).catch(() => []);
  return {
    tabId,
    url: tab.url,
    ...(r?.result ?? {}),
    sidePanelOpen: (ctxs ?? []).some((c) => c.windowId === tab.windowId || c.windowId === -1),
  };
}

export function tabTools({ host, timed, waitForLoad, sleep, targetOf }) {
  const currentWindow = async (call) => (await chrome.tabs.get(await targetOf(call))).windowId;
  const describe = async (call) => {
    const target = await targetOf(call);
    await ensureInGroup(target);
    const tabs = await groupTabs(await currentWindow(call));
    return tabs.map((t, i) => `- ${i}: tabId ${t.id}${t.id === target ? " (current)" : ""} [${t.title}](${t.url})`).join("\n") || "(sin pestañas)";
  };
  const openTab = async (windowId, { url, background, call, ref }) => {
    const abs = url ? new URL(/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(String(url)) ? `https://${url}` : String(url)).href : "about:blank";
    const tab = await chrome.tabs.create({ windowId, url: abs, active: !background });
    await ensureInGroup(tab.id);
    // Sin `background` pasa a ser la pestaña actual; con él, se usa por su tabId.
    if (!background) host.setTargetTab(tab.id);
    if (url) {
      await sleep(150);
      await waitForLoad(tab.id);
    }
    call.tab = tab.id;
    const t = await chrome.tabs.get(tab.id);
    return `Opened tabId ${tab.id}${background ? " (en segundo plano)" : ""}: [${t.title}](${t.url})\n\n### Open tabs\n${await describe({ tabId: tab.id })}`;
  };
  return [
    {
      name: "tabs",
      description:
        "List, create, close, or select a browser tab (sólo las del grupo «Ghosty»). `new` regresa el tabId de la pestaña nueva: pásalo como `tabId` a las demás tools para trabajar en ella sin estorbar a otro agente que use otra pestaña. Con `background: true` la abre sin cambiar la pestaña visible.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "new", "close", "select"], description: "Operation to perform" },
          index: { type: "number", description: "Tab index, used for close/select. If omitted for close, current tab is closed." },
          url: { type: "string", description: "URL to navigate to in the new tab, used for new." },
          background: { type: "boolean", description: "new: abrirla sin enfocarla (para trabajo en paralelo)." },
        },
        required: ["action"],
      },
      execute: timed("tabs", async ({ action, index, url, background, tabId }, call) => {
        // En `tabs`, `tabId` NOMBRA la pestaña a cerrar/seleccionar; la ventana sale de ella o de la actual.
        const ref = action === "new" ? { ...call, tabId: null } : call;
        // `new` no necesita «la pestaña actual» (pedirla abriría una en blanco): basta la ventana.
        if (action === "new") {
          const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
          return openTab(win?.id ?? (await currentWindow(ref)), { url, background, call, ref });
        }
        const windowId = await currentWindow(ref);
        const list = await groupTabs(windowId);
        const target = await targetOf(ref);
        if (action === "list") return `### Open tabs\n${await describe(ref)}\n\n### Viewport (pestaña actual)\n${JSON.stringify(await viewportOf(target))}`;
        const pick = tabId != null ? list.find((t) => t.id === Number(tabId)) : index == null ? list.find((t) => t.id === target) : list[Number(index)];
        if (!pick) return { error: `No hay esa pestaña en el grupo «Ghosty».\n${await describe(ref)}` };
        call.tab = pick.id;
        if (action === "select") {
          host.setTargetTab(pick.id);
          await chrome.tabs.update(pick.id, { active: true });
          return `### Open tabs\n${await describe({ tabId: pick.id })}`;
        }
        if (action === "close") {
          await chrome.tabs.remove(pick.id);
          if (pick.id === target) {
            const rest = await groupTabs(windowId);
            host.setTargetTab(rest[0]?.id ?? null);
            if (rest[0] && !background) await chrome.tabs.update(rest[0].id, { active: true });
          }
          return `Closed tabId ${pick.id}`;
        }
        return { error: `action desconocida: ${action}` };
      }),
    },
    {
      name: "viewport",
      description: "Geometría de la pestaña actual: screenX/screenY, outer/innerWidth/Height, devicePixelRatio, scroll y si el panel lateral está abierto. Sirve para convertir los [box=…] de read_page (px CSS del viewport) a coordenadas de pantalla.",
      inputSchema: { type: "object", properties: {} },
      execute: timed("viewport", async (_in, call) => viewportOf(await targetOf(call))),
    },
    {
      name: "resize",
      description: "Resize the browser window",
      inputSchema: { type: "object", properties: { width: { type: "number", description: "Width of the browser window" }, height: { type: "number", description: "Height of the browser window" } }, required: ["width", "height"] },
      execute: timed("resize", async ({ width, height }, call) => {
        const w = Math.max(320, Math.min(3840, Math.round(Number(width))));
        const h = Math.max(300, Math.min(2160, Math.round(Number(height))));
        const win = await chrome.windows.update(await currentWindow(call), { state: "normal", width: w, height: h });
        return { ok: true, width: win.width, height: win.height, note: "el panel lateral ocupa parte del ancho; el viewport de la página es menor" };
      }),
    },
  ];
}
