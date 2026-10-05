# Ficha de Chrome Web Store: Ghosty

## Datos básicos
- **Nombre:** Ghosty (sin «(POC)»; quitarlo del manifest antes de empaquetar)
- **Categoría:** Productividad → Herramientas
- **Idiomas:** español (principal), inglés
- **Visibilidad inicial:** **No listada** (sólo quien tenga la liga). Pública cuando pase la revisión.
- **Imágenes:** `icon-128.png` (en `ext/icons/`), `promo-440x280.png` y `marquee-1400x560.png` (aquí). Faltan de 1 a 5 capturas de 1280×800, que se toman tras probar el relay.

## Descripción corta (máx. 132 caracteres)
- es: `Conecta tu Chrome con tu agente de Ghosty Studio: navega, llena formularios y opera sitios con tu sesión, desde el chat o la app.`
- en: `Connect Chrome to your Ghosty Studio agent: it browses, fills forms and operates sites with your session, from chat or the app.`

## Descripción larga (es)
Ghosty le presta tu navegador a tu agente de Ghosty Studio. Tú le hablas desde el chat (ghosty.studio/c), la app de iPhone o la terminal, y él lo hace en tu Chrome: abre pestañas, lee la página, da clic, escribe, llena formularios, sube archivos y toma capturas, con las sesiones que ya tienes abiertas.

- Ves todo lo que hace: borde lila y un cursor que señala cada paso.
- Lo detienes cuando quieras con ■ Detener.
- Trabaja sólo en las pestañas de su grupo «Ghosty».
- Nunca escribe contraseñas.

Requiere una cuenta de Ghosty Studio.

## Propósito único (Single purpose)
Permitir que el agente de Ghosty Studio de la persona opere su propio navegador (navegar, leer y actuar en páginas) cuando ella se lo pide desde Ghosty Studio.

## Justificación de permisos
| Permiso | Para qué |
|---|---|
| `debugger` | Enviar clics y teclas reales (CDP Input) que las apps modernas (React, menús, canvas) sí reciben; leer la consola y la red cuando la persona pide depurar su sitio; subir archivos a un `<input type=file>`. Se adjunta sólo a pestañas del grupo Ghosty mientras hay una tarea. |
| `scripting` | Leer la estructura de la página (árbol de accesibilidad) y pintar el borde y el cursor que muestran lo que hace el agente. |
| `tabs`, `tabGroups` | Abrir, listar y cerrar las pestañas del agente y agruparlas en «Ghosty» para que no toque las demás. |
| `sidePanel` | Panel de estado: conectado, último paso y botón Detener. |
| `storage` | Guardar preferencias y atajos de la persona. |
| `downloads` | Guardar la grabación (GIF) de una tarea cuando la persona la pide. |
| `alarms` | Mantener viva la conexión con Ghosty Studio (service worker de MV3). **Si no se usa al publicar, quitarlo.** |
| Hosts `<all_urls>` | El agente trabaja en el sitio que la persona le indique, que puede ser cualquiera; las capturas (`captureVisibleTab`) también lo exigen. |

## Código remoto (Remote code)
**No.** Todo el código, incluido el WASM, va dentro del paquete. La tool `javascript` ejecuta expresiones en la página mediante la Debugger API, que es una de las dos excepciones que permite la política de MV3 ([mv3-requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)). Para no regalar un pretexto de rechazo, decidir antes de publicar si se deja fuera de la versión de la tienda.

## Uso de datos (Privacy practices)
Casillas a marcar (lo que de verdad se procesa):
- **Contenido del sitio web**: sí. El texto y la estructura de las páginas que el agente opera se mandan al modelo para decidir el siguiente paso.
- **Actividad web**: sí, sólo las URLs de las pestañas del grupo Ghosty durante una tarea.
- **Información de autenticación**: no. Nunca lee ni escribe contraseñas.
- **Datos personales, de salud o financieros, y ubicación**: no.

Certificaciones:
- No se venden datos a terceros.
- No se usan para fines ajenos al propósito único.
- No se usan para crédito ni préstamos.

**URL de la política de privacidad:** `https://www.ghosty.studio/privacidad#extension`. Hay que agregarle a `app/routes/privacidad.tsx` la sección de abajo; hoy no menciona la extensión.

### Sección para la política de privacidad (borrador)
> **Extensión de Chrome «Ghosty».** Cuando le pides a tu agente que use tu navegador, la extensión envía a Ghosty Studio el texto, la estructura y, si hace falta, capturas de las pestañas del grupo «Ghosty». Se usan sólo para que el modelo de lenguaje decida y ejecute el siguiente paso, y se guardan en tu conversación igual que cualquier otro mensaje. La extensión no lee ni escribe contraseñas, no toca pestañas fuera de su grupo y no vende ni comparte tus datos con terceros fuera de los proveedores de modelos de lenguaje que procesan la tarea. Puedes desconectarla o desinstalarla cuando quieras.

## Cuenta de desarrollador (lo hace bliss)
1. Entrar a https://chrome.google.com/webstore/devconsole con la cuenta de Google de la empresa, no la personal, para no amarrar la extensión a una persona.
2. Aceptar el acuerdo y pagar la cuota única de **US$5**.
3. Verificar el correo de contacto y el editor («Ghosty Studio»). Verificar el dominio ghosty.studio en Search Console da el sello «Editor verificado».
4. Opcional: crear un grupo de Google `ghosty-extension-testers` para la distribución a testers.

## Antes de subir el .zip
- [ ] Manifest: nombre «Ghosty», versión `1.0.0`. Quitar `key` (la tienda asigna su propio id) y `http://127.0.0.1:8787/*`.
- [ ] La URL de gs es la de producción, no localhost.
- [ ] Quitar el proxy local y los textos de POC.
- [ ] `zip -r ghosty.zip ext -x '*.DS_Store'`.
- [ ] Capturas 1280×800 del panel y del borde trabajando.
- [ ] Sección de la extensión publicada en `/privacidad`.
