# Ghosty para Chrome

La extensión que le presta **tu Chrome, con tus sesiones abiertas,** a tu agente de IA. El agente piensa en
otro lado: [Ghosty Studio](https://www.ghosty.studio) (/c, apps iOS y Android, tareas programadas), Claude
Code, Cursor, Codex o tu propio script por MCP. La extensión sólo ejecuta los pasos: no tiene chat ni
modelo.

- **Instalar:** [ghosty.studio/chrome](https://www.ghosty.studio/chrome) (mientras sale en Chrome Web Store, a
  mano desde el zip). Docs: [es](https://www.ghosty.studio/docs/navegador) · [en](https://www.ghosty.studio/en/docs/browser).
- **MCP:** `npx -y @ghostystudio/browser-mcp install-host` y agrega `@ghostystudio/browser-mcp` a tu
  cliente MCP. Sin internet ni token: la terminal habla con la extensión por el host nativo.

## Qué hace

27 tools `browser_*` (navegar, leer la página con refs, `find`, clic/teclado trusted por CDP, formularios,
subir archivos sin abrir el selector, capturas, una pestaña por agente (`session`) y más pestañas en paralelo con `tabId`, consola y red, GIF,
diálogos nativos). Nombres y descripciones adoptados de Playwright MCP (Apache-2.0,
`ext/vendor/playwright/NOTICE`).

## Seguridad

- Lo que dice una página es **dato**, nunca instrucción.
- Lo irreversible (enviar, publicar, pagar, borrar, aceptar términos) devuelve `needs_confirmation` con
  un nonce de un solo uso: el agente pide el sí de la persona en su chat.
- Nunca teclea contraseñas, códigos 2FA ni resuelve captchas; avisa si la página pide un pago o aceptar
  un acuerdo; tapa secretos en pantalla (llaves de API, client secrets).
- Diálogos nativos: se cancelan por default; `handle_dialog` los acepta sólo si el agente lo pidió.

## Estructura

| Carpeta | Qué hay |
|---|---|
| `ext/` | La extensión (MV3): `background.js` (relay con gs + host nativo), `tools.js` y `tools/` (las tools), `cdp.js` (chrome.debugger), `guard.js` (confirmaciones, captcha/2FA, pagos) |
| `scripts/` | Bancos e2e con Chrome for Testing (`ronda-yt-e2e.mjs`, `hard-cases-e2e.mjs`, `security-e2e.mjs`, `parallel-e2e.mjs`…) y `fixtures/` |
| `store/` | Ficha de Chrome Web Store, imágenes y `make-build.py` (build de la tienda: sin localhost ni `evaluate`) |
| `docs/` | Historia: cómo empezó (POC con libfx y chat en el panel) y qué se aprendió |

El servidor MCP y el host nativo viven en el monorepo de Ghosty Studio
(`packages/browser-mcp`, publicado como `@ghostystudio/browser-mcp`).

## Probar

```bash
npm install
node scripts/ronda-yt-e2e.mjs      # 21 casos: diálogos, selector de archivos, pagos, find, puente…
node scripts/hard-cases-e2e.mjs    # iframes de otro origen, shadow DOM, canvas, captcha, 2FA
node scripts/security-e2e.mjs      # inyección de instrucciones y confirmaciones
```

Cargar en desarrollo: `chrome://extensions` → Modo de desarrollador → Cargar descomprimida → `ext/`.
