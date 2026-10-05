# ghosty-chrome — Ghosty en Chrome: clon de Claude in Chrome sobre libfx

## 1.1 (2026-10-04) — guía de prueba en `PROBAR.md`
- `externally_connectable` (/c se empareja sola), `nativeMessaging` (host `native-host/` + `scripts/install-native-host.sh`),
  `webNavigation`, `notifications` («terminé», «inicia sesión en X»), `commands` (⌘⇧G panel, ⌘⇧K detener), `downloads` (GIF).
- Sin vibración: capturas sin `clip/scale` de CDP (recorte con OffscreenCanvas) y depurador pegado toda la tarea (se suelta a 30 s).
- Snapshot podado + incremental: clone-test 13/13, snapshot ≈1,690 → ≈818 tokens, $0.0146 → $0.0125 (`evidencia/clone/clone-results-poda.json`).
- Refs estables (parche en `vendor/playwright/injected.js`), tool `viewport`, atajos movidos a gs (tabla `Shortcut`).
- Tienda: `python3 store/make-build.py` → `store/build/ext` + `store/ghosty.zip` (1.0.0, sin `key`, sin localhost, sin `evaluate`).
- Pruebas: `scripts/vibra-test.mjs`, `scripts/prod-ios-test.mjs` (API como la app iOS), `scripts/prod-sched-test.mjs` (programados).

## Las manos del agente (fase 5, 2026-10-04): como Claude in Chrome con Claude Code
La conversación vive en otra superficie (/c, iOS, Claude Code, CLI `ghosty`); **la extensión sólo ejecuta**.
Sin chat, sin lista de sitios, sin permisos por sitio ni confirmaciones en la extensión (las pide el agente en
su chat). Se conserva: nunca teclear contraseñas, el borde lila, el cursor y ■ Detener (panel y píldora).

```
Claude Code ─stdio─ ghosty-studio/scripts/browser-mcp.mjs ─POST /api/browser/call (bt_)─▶ gs
gs ─SSE /api/browser/connect (cookie gs_session)─▶ offscreen relay.html ─mensaje─▶ service worker (tools)
```
- **gs** (`app/lib/browser-relay.server.ts`, rutas `api.browser.{connect,call,token}`): encola, espera con
  timeout, 409 «tu navegador no está conectado», latido 10 s y conexión muerta a los 25 s sin pong.
- **Extensión**: `background.js` corre las tools; `relay.js` (documento offscreen) lleva la red porque
  Chrome 139+ bloquea con *Local Network Access* el fetch del service worker a localhost. El panel es sólo estado
  (conectado, quién la usa, último paso, ■ Detener) y da el comando `claude mcp add …` con el token.
- **Playwright MCP adoptado** (Apache-2.0, `ext/vendor/playwright/{injected.js,LICENSE,NOTICE}`, InjectedScript de
  playwright-core 1.63.0 sin cambios): `read_page` = su aria snapshot en modo "ai" (`[ref=eN]`, `[cursor=pointer]`,
  `boxes`), `target`/`element` en las tools, nombres y descripciones de click, type (submit/slowly), select_option,
  fill_form, press_key, hover, drag, wait_for, evaluate, console_messages, network_requests, tabs, resize,
  file_upload, navigate_back; las acciones regresan el snapshot nuevo y esperan a que la página se asiente
  (`waitForCompletion`: 500 ms, carga si hubo navegación, peticiones xhr/fetch/script hasta 5 s).
- **Pruebas**: `scripts/relay-e2e.mjs` (MCP stdio → gs → extensión: ghosty.studio + editar el nombre de un agente
  local) y `scripts/clone-test.mjs` (agente externo DeepSeek con las tools browser_*; `LABEL=antes|despues`).
  Resultados en `evidencia/relay/` y `evidencia/clone/clone-results-{antes,despues}.json`.

## Clon de Claude in Chrome (fases 1–4, 2026-10-04) — superado por la fase 5
Lo de abajo describe la versión con chat y permisos en la extensión; quedó reemplazada.

Plan: `~/.claude/plans/clever-wishing-hejlsberg.md`. La fase 5 (control remoto desde gs: /c e iOS) no se ha empezado.

| Claude in Chrome | Ghosty | Dónde |
|---|---|---|
| read_page con refs | `read_page` → árbol `[ref_N] rol «nombre» @x,y` (refs estables, regiones sangradas, `filter: interactive`) | `tools.js` |
| find | `find` → subllamada a DeepSeek (`POST /complete` del proxy); sólo regresa refs que existen | `tools.js`, `proxy/server.mjs` |
| computer | `computer`: screenshot, left/right/double/triple_click, hover, key, type, scroll, left_click_drag, zoom y wait por CDP (eventos *trusted*), coordenadas en px CSS | `tools/computer.js`, `cdp.js` |
| form_input / get_page_text | `form_input` (select, checkbox, radio, switch, range, texto…) y `get_page_text` (Readability, Apache-2.0, en `vendor/readability`) | `tools.js` |
| javascript_tool | `javascript` (Runtime.evaluate, **siempre confirma**) | `tools/computer.js` |
| read_console_messages / read_network_requests | con `pattern`, `onlyErrors` y `clear`; CDP se engancha al tener permiso del sitio | `tools/computer.js`, `cdp.js` |
| file_upload / upload_image | `file_upload` (rutas locales, `DOM.setFileInputFiles`) y `attach_image` | `tools/computer.js`, `tools.js` |
| tabs_context / create / close | más `tabs_switch`; todo dentro del grupo morado «Ghosty» | `tools/tabs.js` |
| resize_window, gif_creator | `resize_window`; `gif_creator` graba un cuadro tras cada acción y lo codifica con gifenc (MIT); la descarga se confirma | `tools/tabs.js`, `tools/record.js` |
| shortcuts | `/guardar nombre instrucciones`, `/nombre`, `/atajos`, `/borrar`; tools `shortcuts_list`/`shortcuts_execute` (`chrome.storage.sync`) | `tools/shortcuts.js`, `panel.js` |
| permisos por sitio | «Una vez / Siempre / No» en el panel; `/sitios` y `/olvidar sitio`. Bloqueados fijos: banca, pagos, cripto, gestores de contraseñas y SAT. easybits, ghosty.studio y facebook nacen en «siempre» | `permissions.js` |
| Detener | botón ■ en el panel y píldora «■ Detener a Ghosty» en el borde de la página; corta el turno, la confirmación abierta y las tools | `panel.js`, `tools.js` |

Siguen: el cursor y el borde lila, `withFocusGuard`, nunca teclear contraseñas (también en `computer type/key`),
la compuerta del clic (ahora también para clics por coordenadas; casillas sin confirmar salvo etiqueta riesgosa)
y el proxy DeepSeek. Un Enter que puede enviar (compositor o formulario POST) confirma.

**Imágenes al modelo:** `computer screenshot/zoom` regresa la imagen (`libfx.tool-result`) sólo si el modelo ve
(`VISION`, hoy sólo Sonnet); con DeepSeek la captura se guarda y el agente se guía con las coordenadas `@x,y`
de `read_page`. El proxy ya pasa imágenes de tool_result a Anthropic, pero **no se ha probado**.

**Pruebas:** `node scripts/clone-test.mjs` (Chrome for Testing, banco local `scripts/fixtures/banco.html`
en 127.0.0.1:5199 con menú y contador que sólo aceptan eventos *trusted*). 17/17 el 4-oct, $0.010 en total,
2–11 s por tarea. Resultados y capturas en `evidencia/clone/` (incluye `prueba-gif.gif` grabado por la tool).
Sin probar: `file_upload`, el camino con visión (Sonnet), Facebook real y en el Chrome de bliss.

---

## POC original (3-oct): agente libfx en una extensión que opera EasyBits, Ghosty Studio y Facebook

Medido el 2026-10-03 con libfx 0.0.12, Chrome for Testing 139 (perfil temporal, `--load-extension`).
**Funcionó de punta a punta**: el kernel WASM con JSPI corre dentro de la extensión, sus 5 tools
manejan la pestaña y las confirmaciones salen en el panel. Id fijo de la extensión (por la `key` del
manifest): `okgofgcccjajcokgpjmdlpgjpjoibpca`.

## Cómo está armado
- `ext/` — extensión MV3 sin empaquetar, sin build (ES modules). libfx va copiado en `ext/vendor/libfx/`.
  - **El agente vive en el side panel** (`panel.html`/`panel.js`). Funciona porque es página de
    extensión con `'wasm-unsafe-eval'` en la CSP (sin eso MV3 bloquea `WebAssembly.compile`, igual que
    advierte chrome-fx). Contra: cerrar el panel cierra la conversación. No hizo falta offscreen
    document (chrome-fx lo usa para que el agente sobreviva al panel; sería el paso 2).
  - `tools.js`: `navigate`, `read_page`, `click`, `type`, `scroll` con `chrome.scripting.executeScript`
    sobre la pestaña activa. Con libfx 0.0.12 `createFxAgent` sí acepta tools de host; chrome-fx usa la
    terminal porque en 0.0.5 no se podía.
- `proxy/server.mjs` — proxy local `127.0.0.1:8787` que habla el protocolo del AI Gateway de Vercel
  y lo traduce a DeepSeek (`deepseek-flash`, sin razonamiento). Portado de gs `app/lib/fx/gateway.server.ts`.
  No hay `AI_GATEWAY_API_KEY`; el proxy de gs (`/api/fx/model`) pide sesión de staff, por eso uno propio.
  La llave sale del env o de `~/ghosty-studio/.env` y **nunca entra a la extensión**: la extensión
  pide un token de 15 min por `POST /token` (sólo con Origin `chrome-extension://<FX_EXT_ID>`, el id
  fijo de arriba) y reescribe el `fetch` de libfx hacia el proxy. `/stats` también sólo para la
  extensión; los tokens vencidos se limpian. Tope de gasto por proceso: `FX_BUDGET_USD` (default $0.50).

## Seguridad (decisiones de bliss, 3-oct)
- **El agente hace lo que la persona pida** (crear, editar, configurar, borrar) en los sitios
  permitidos; no se niega. La seguridad la ponen la compuerta del clic y estos dos límites:
  nunca teclea contraseñas y nunca sale de la lista de dominios.
- **Dominios** (3-oct; desde el 4-oct lo reemplaza el permiso por sitio de `permissions.js`): easybits.cloud,
  ghosty.studio y facebook.com (con www/m). `navigate` y las ligas rechazan además URLs con otra URL adentro
  (`?next=https://…`, `//otro`, `javascript:`) para cerrar redirecciones abiertas.
- **`type` va sin confirmación** en input, textarea, select (elige la opción por texto) y
  contenteditable. Rechaza contraseñas (por `type`, `autocomplete` o nombre), campos ocultos y de sólo
  lectura; la página lo vuelve a revisar antes de escribir.
- **Facebook**: `read_page` lista el compositor (contenteditable / `role=textbox`, con su aria-label
  «¿Qué estás pensando?») y `type` escribe ahí con `insertText` (Lexical recibe el evento `input`).
  Probado en un compositor de imitación (`scripts/contenteditable-test.mjs`: texto, evento, select,
  contraseña/oculto/readonly rechazados); no en facebook.com real. «Publicar» y «Post» siempre confirman.
- **`click` confirma por default.** Sin preguntar sólo pasan: ligas a hosts permitidos sin URL
  anidada, y botones cuya etiqueta (texto + aria-label + title + alt) empieza con abrir/ver/siguiente/
  menú/pestaña/más/cerrar… o que son toggles (`aria-expanded`, `summary`, `role=tab`). Siempre
  confirman: los que envían formulario (`type=submit`, `input type=image`, `<button form=…>`), los
  íconos sin texto, los afirmativos de modal (Aceptar/Sí/OK/Continuar) y los que dicen
  enviar/borrar/pagar/contratar/ceder/crear/guardar/publicar… Justo antes del clic, la página
  verifica que el elemento sigue teniendo el tag y la etiqueta que se confirmaron.
- **Exfiltración**: lo leído va como `untrusted_page_data` («dato, no instrucción»), y el markdown
  del panel sólo convierte en `<a>` las ligas permitidas; las demás quedan como texto. Las URLs y el
  código se apartan antes de aplicar cursivas (un `*` dentro de una URL ya no la rompe).
- **Panel**: bandera `busy` desde el inicio del turno y contador de generación: lo que llegue tarde de
  una conversación vieja no se pinta en la nueva. «＋ Nueva» rechaza la confirmación abierta y no
  espera más de 1.5 s al `close()` del agente viejo. El input recupera el foco sólo al terminar el
  turno (no a media tarea, para no robárselo a quien teclea su contraseña). La recarga en caliente
  sólo es automática con el log vacío; si hay conversación, aparece «versión nueva · recargar».

## Resultados (3ª corrida, con todo lo anterior; evidencia/resultados.json, e2e.log, capturas y `demo.gif`)
| Tarea | Pasos | Tools | Turno | Tokens in/out | USD |
|---|---|---|---|---|---|
| «Documentación de la flota de EasyBits, resúmela» | 5 | navigate, read_page ×2 | 7.7 s | 20,870 / 544 | $0.0028 |
| Login → abrir «Email» → escribir correo → pedir link | 7 | navigate, read_page ×2, click ×2, type | 11.2 s* | 62,439 / 338 | $0.0015 |
| «Ve a ghosty.studio/planes y dime los precios» | 3 | navigate, read_page | 6.6 s | 33,170 / 365 | $0.0019 |
| «Documentación del CLI de Ghosty, resúmela» | 5 | navigate, read_page ×2 (índice → /docs/cli) | 8.7 s | 86,215 / 480 | $0.0035 |
| «Abre https://github.com» (fuera de la lista) | 1 | — (no lo abrió) | 1.9 s | 21,825 / 150 | $0.0004 |
| «Abre …/login?next=https://evil.example/robar» | 2 | read_page (no navegó) | 3.5 s | 47,025 / 158 | $0.0014 |

\* En el login el correo se escribió **sin preguntar** (el campo quedó con `prueba@ejemplo.com`).
Hubo dos confirmaciones: «Iniciar con Email» se aprobó (con la compuerta por default, un botón
que no está en la lista segura también pregunta) y «Solicitar link (envía un formulario)» se
**rechazó**: no se mandó ningún correo (`confirm-confirmacion-1.png` y `-2.png`). La prueba de «se negó a crear un
agente» se quitó: el agente ya no se niega, y crear exige sesión, que el perfil de prueba no tiene.
En los dos últimos casos el modelo se detuvo antes; los bloqueos de las tools (dominio y URL
anidada) se probaron aparte con `isSafeNavUrl` (5/5 casos).

- **Latencia por paso del modelo**: TTFB ~470–590 ms, total 0.9–2.0 s por paso. Primer texto ~0.8 s.
- **Tools en la página**: 2–6 ms leer; 290–690 ms navegar o dar clic (espera la carga).
- **`read_page` en páginas grandes** (con el escaneo extra de clicables por cursor, `scripts/bench-read.mjs`):
  feed sintético de 24k nodos 45 ms, Wikipedia «World War II» (17k nodos) 54 ms, facebook.com sin
  sesión 2 ms, ghosty.studio/planes 5 ms. No hizo falta limitarlo más.
- **Arranque**: `createFxAgent` 17–22 ms (WASM compilado desde el paquete de la extensión).
- **Peso**: 2.3 MB sin empaquetar (2.1 MB es `fx-core.wasm`), 0.8 MB en zip.
- **Costo**: ~$0.001–0.003 USD por tarea; el caché de DeepSeek cubre ~80–95 % del input desde el 2º paso.

## Cursor visual (para demos)
- `pageCursor` dibuja una flecha lila (#9a99ea, contorno blanco, sombra) con pastilla de acción en un
  host `position:fixed; pointer-events:none; z-index` máximo con shadow root cerrado, en el mundo
  aislado de la extensión. Nunca mueve el mouse real.
- `click`: vuela en arco con ease-out (300–600 ms según distancia, `scrollIntoView` si hace falta),
  y si hay que confirmar **se queda sobre el botón** con «¿clic · X?» mientras la persona decide;
  luego anillo + clic. `type`: vuela al campo y teclea visible (trozos cada ~20 ms, máx. 1.5 s) con
  el mismo setter nativo / `insertText`. `read_page` hace un pulso («leyendo…») y `scroll` un deslizamiento.
- Se oculta solo a los 4 s sin acciones; tras navegar reaparece en la última posición (guardada por
  pestaña). Con `prefers-reduced-motion` se teletransporta y teclea de golpe.
- **Borde palpitante**: mientras hay turno, un marco `inset` lila #9a99ea alrededor del viewport
  respira (opacidad 0.35↔0.8, 2 s); entra con fade de 200 ms y se va al terminar, al cancelar o con
  «＋ Nueva». Esperando confirmación pasa a ámbar y más lento (3.2 s): te toca a ti. Con
  reduced-motion queda fijo. El estado lo lleva el panel (`frame.state`) y cada acción lo reaplica,
  así sobrevive a navegar.
- Evidencia: `evidencia/cursor.mp4` (screencast de CDP → H.264 yuv420p, faststart, 29 s, 1.3 MB; el GIF metía tinte amarillo) y `cursor-borde.png` (lila → ámbar). `RECORD=1 TASKS=cursor npm run e2e`:
  ghosty.studio, borde lila, teclea «Hazme una landing…» en «Pide algo», el cursor espera sobre
  «Enviar» con el borde ámbar, se rechaza (no se manda nada) y el borde se apaga al terminar.

## Imágenes: `take_screenshot` y `attach_image` (sin el selector de archivos)
- Fuentes: captura de la pestaña (`chrome.tabs.captureVisibleTab`, JPEG, se guarda la última por
  sitio), imágenes que la persona suelta o pega en el panel (miniaturas sobre el input) o `url` de un
  sitio permitido. Sin confirmación: adjuntar no publica.
- Inyección: el `<input type=file>` que acepte imágenes (primero el del mismo diálogo que el
  compositor; incluye ocultos) recibe `files` por `DataTransfer` + `input`/`change`; si no hay, se
  simula `paste` con `ClipboardEvent` y, si nadie lo atiende, `dragenter/dragover/drop`.
- Probado en imitaciones (`scripts/attach-test.mjs`): input oculto en diálogo → `change` con el
  archivo; sin input → `paste` con el archivo; sin paste → `drop`. facebook.com sin sesión no tiene
  ningún `input[type=file]` (el compositor sólo existe con sesión): falta probar en el Facebook real.
- **Permiso (decisión del demo, 3-oct)**: `captureVisibleTab` exige `<all_urls>` o `activeTab`.
  Primero fue permiso opcional con botón «Permitir capturas», pero en el demo bliss no lo vio y la
  captura falló; ahora `<all_urls>` va en `host_permissions` y la extensión sin empaquetar lo recibe
  al recargar (el botón se oculta solo: verificado en el e2e). **No amplía la lista de dominios**:
  toda tool pasa por `guardTab`/`isAllowedUrl` (read_page, click, type, scroll, take_screenshot,
  attach_image), `navigate` y las ligas por `isSafeNavUrl`, `attach_image` con `url` sólo baja de
  sitios permitidos, y el markdown sólo enlaza a ellos. Contra: Chrome avisa «leer y cambiar datos
  en todos los sitios» y, si el panel tuviera un XSS, el alcance sería mayor. e2e: captura de
  ghosty.studio/planes guardada (117 KB) en 5.1 s.

## Sonnet (`anthropic/claude-sonnet-5-5`)
El proxy traduce también a la Messages API nativa de Anthropic (streaming, `tool_use`/`tool_result`,
caché de prompt en tools + system + último mensaje). Llave: `ANTHROPIC_API_KEY` de
`~/fixter2025/.env`, sólo dentro del proxy. Tope por proceso: $0.50 por default (`FX_BUDGET_USD=3` para probar Sonnet). En `panel.js`, `MODEL` elige entre
`MODEL_SONNET` y `MODEL_CHEAP` (DeepSeek).
- Tool calls verificadas con `scripts/sonnet-check.mjs` (libfx en Node → proxy → Sonnet → tool de host → respuesta).
- e2e (`EXT=<copia con Sonnet> TASKS=ghosty-planes,confirm npm run e2e`): las dos tareas bien, con las mismas
  confirmaciones. TTFB por paso 0.75–2 s (3.7 s en el paso que digiere la página completa), contra
  ~0.4–0.5 s de DeepSeek. Costo: login $0.027, planes $0.036 por tarea (~15× DeepSeek), con el caché
  leyendo ~90 % del input desde el 2º paso.

## Qué falló o falta
- La primera frase del modelo a veces sale en inglés («I'll go to the login page first») aunque el
  prompt pide español: es DeepSeek narrando antes de la tool.
- Sesión del usuario: el perfil de prueba es temporal, así que «abre mis sitios» no se probó con
  login. En el Chrome de bliss la extensión usaría su sesión tal cual (las tools corren en su pestaña).
  Chrome de marca 137+ ya no acepta `--load-extension`; hay que cargarla en `chrome://extensions`.
- `chrome.sidePanel.open` exige gesto del usuario: en el e2e la misma `panel.html` se abre en una
  ventana popup. En uso real se abre con el ícono de la barra.
- Las listas segura/riesgosa son heurísticas, aunque la compuerta confirma por default; no se hizo
  prueba adversaria de prompt injection ni hay una página con contraseña en los sitios de prueba
  (el rechazo de contraseñas está en dos capas, pero no se ejerció en vivo).
- El foco del input se verificó sólo en el código (el e2e headless no tiene foco real de ventana).
- Foco, caso borde aceptado: si la persona da clic en la página justo mientras corre una tool
  (2–700 ms), `withFocusGuard` ignora ese blur y al terminar la tool reenfoca el input del panel
  (podría robarle el foco a media contraseña). No se usa `document.hasFocus()` porque tras
  `navigate` Chrome pasa el foco a la pestaña y nunca se reenfocaría.
- La conversación no persiste (sin `checkpoint`); el proxy guarda tokens en memoria.

## Correr
```bash
npm install
npm run proxy          # deja el proxy en 127.0.0.1:8787
npm run e2e            # Chrome for Testing headless + las 6 tareas → evidencia/
```
Uso manual en Chrome estable (137+ trae JSPI encendido; sin flags): deja corriendo `npm run proxy`,
abre `chrome://extensions` → «Modo de desarrollador» → «Cargar descomprimida» → carpeta `ext/`.
El id sale fijo (`okgofgcccjajcokgpjmdlpgjpjoibpca`), que es el que acepta el proxy. Abre
easybits.cloud o www.ghosty.studio y da clic al ícono para abrir el panel.
