// Prueba de pageAttach en imitaciones del compositor de Facebook: (1) input de archivo oculto en el
// diálogo, (2) sin input, con manejador de paste, (3) sin input ni paste, con drop. Y cuenta los
// <input type=file> de facebook.com sin sesión.
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../ext/tools.js", import.meta.url), "utf8");
const fn = (n) => { const i = src.indexOf(`function ${n}(`); const start = src.lastIndexOf("\n", i) + 1; return src.slice(start, src.indexOf("\n}\n", i) + 2); };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const b = await puppeteer.launch({ executablePath: process.env.HOME + "/.cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", headless: "new" });
const p = await b.newPage();
const attach = (target) => p.evaluate(`(async () => { ${fn("pageAttach")}; return await pageAttach(${JSON.stringify(PNG)}, "captura.png", ${JSON.stringify(target)}); })()`);
const composer = `<div role="textbox" contenteditable="true" id="c" aria-label="¿Qué estás pensando?"></div><div id="out"></div>`;

await p.setContent(`<div role="dialog">${composer}<input type="file" accept="image/*,video/*" multiple style="display:none" id="f"></div>
<script>f.addEventListener("change",()=>out.textContent="change:"+f.files[0].name+":"+f.files[0].type+":"+f.files[0].size)</script>`);
console.log("1 input oculto:", await attach("#c"), await p.$eval("#out", (e) => e.textContent));

await p.setContent(`${composer}<script>c.addEventListener("paste",e=>{const f=e.clipboardData.files[0];if(f){e.preventDefault();out.textContent="paste:"+f.name+":"+f.size}})</script>`);
console.log("2 paste:", await attach("#c"), await p.$eval("#out", (e) => e.textContent));

await p.setContent(`${composer}<script>c.addEventListener("drop",e=>{e.preventDefault();out.textContent="drop:"+e.dataTransfer.files[0].name})</script>`);
console.log("3 drop:", await attach("#c"), await p.$eval("#out", (e) => e.textContent));

await p.goto("https://www.facebook.com/", { waitUntil: "networkidle2" });
console.log("facebook.com sin sesión:", await p.evaluate(() => ({ fileInputs: [...document.querySelectorAll("input[type=file]")].map((i) => i.accept || "*"), title: document.title })));
await b.close();
