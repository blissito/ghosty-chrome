import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const src = readFileSync(process.env.HOME + "/ghosty-chrome/ext/tools.js", "utf8");
const fn = (name) => { const i = src.indexOf(`function ${name}(`); return src.slice(src.lastIndexOf("\n", i) + 1, src.indexOf("\n}\n", i) + 2); };
const b = await puppeteer.launch({ executablePath: process.env.HOME + "/.cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", headless: "new" });
const p = await b.newPage();
await p.setContent(`<div role="textbox" contenteditable="true" aria-label="¿Qué estás pensando?" id="c"><p><br></p></div>
<div id="out"></div><input type="password" name="pass" id="pw"><input type="hidden" id="h"><input readonly id="ro">
<select id="s"><option value="1">Público</option><option value="2">Amigos</option></select>
<div role="button" aria-label="Publicar" id="pub"></div><div role="button" aria-label="Post" id="post"></div>
<script>c.addEventListener("input",()=>out.textContent="input:"+c.textContent)</script>`);
const r = await p.evaluate(`(async () => { ${fn("pageRead")}; ${fn("pageInspect")}; ${fn("pageType")};
  const read = pageRead(500);
  const ce = await pageType("#c", "Hola desde Ghosty");
  return { read: read.elements.map(e => e.tag + ":" + e.label), ce, ceText: c.textContent, evt: out.textContent,
    pw: pageInspect({selector:"#pw"}).isPassword, h: pageInspect({selector:"#h"}).hidden, ro: pageInspect({selector:"#ro"}).readOnly,
    sel: [await pageType("#s","Amigos"), s.value], pub: pageInspect({text:"publicar"}).label, post: pageInspect({selector:"#post"}).label };
})()`);
console.log(JSON.stringify(r, null, 1));
await b.close();
