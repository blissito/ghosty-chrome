# Probar Ghosty 1.1 en blissmo

**0. Recargar.** En `chrome://extensions`, ↻ en «Ghosty (POC)» (carga `~/ghosty-chrome/ext`). Debe decir 1.1.0.

| # | Qué hacer | Qué debes ver |
|---|---|---|
| 1 | **Emparejamiento**: abre www.ghosty.studio/c con tu sesión iniciada (o localhost:5180/c para local). | En 2–3 s el panel (⌘⇧G) dice «Conectado · tu correo», sin copiar ningún token. Al pasar de local a prod, la extensión se cambia sola al gs de la pestaña. |
| 2 | **Atajos de teclado**: ⌘⇧G abre el panel. Mientras el agente trabaja, ⌘⇧K. | El panel se abre. Con ⌘⇧K el borde se apaga, el último paso dice «detenido» y el agente recibe «la persona detuvo a Ghosty». |
| 3 | **Captura como imagen**: en /c, «abre ghosty.studio/planes, toma una captura y dime qué ves». | Describe la página por lo que ve, no sólo por el texto. Funciona con agentes claude-worker; en ghosty-lite (MiniGhosty) sólo le llega el texto. |
| 4 | **Atajo desde /c**: «guarda esto como atajo /precios: abre ghosty.studio/planes y dime el precio de Pro». Después escribe `/precios`. | Contesta «guardado /precios». Con `/precios` abre la página y dice el precio. «¿qué atajos tengo?» los lista. |
| 5 | **Tarea programada**: «en 2 minutos abre ghosty.studio/planes y dime el precio de Pro». Prueba también cerrando Chrome antes de que llegue la hora. | Con Chrome abierto, a los 2 min el borde lila trabaja solo y la respuesta aparece en el hilo. Con Chrome cerrado, llega un push «… necesita tu Chrome». |
| 6 | **GIF como archivo**: «grábame lo que hagas: abre ghosty.studio/planes, baja y regresa; exporta el GIF». | El GIF queda como archivo del hilo en /c y no en Descargas. Desde la terminal sí va a ~/Downloads. |
| 7 | **Notificaciones**: pide una tarea larga y cámbiate a otra pestaña. Luego pide «abre github.com/login». | «Ghosty terminó» al acabar; clic en el aviso y regresas a la pestaña. En el login: «Ghosty necesita que inicies sesión en github.com». |
| 8 | **Terminal sin gs (native messaging)**: `~/ghosty-chrome/scripts/install-native-host.sh`, recarga la extensión ↻ y en Claude Code usa `ghosty-browser` (`browser_status`). | El panel muestra «Terminal: conectada en esta Mac» y `browser_status` dice `localBridge: true`. Las tools ya no pasan por gs (≈1 ms extensión, en vez de ~200 ms del relay). |
| 9 | **Sin vibración**: graba un GIF con varios clics. | La página no brinca. La barra «depurando» aparece una vez por tarea y se va a los 30 s o con Detener. |

Si algo falla: en el panel, «Último paso» trae el error; ese renglón y la hora me sirven.
