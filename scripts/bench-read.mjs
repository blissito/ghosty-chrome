import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const src = readFileSync(process.env.HOME + "/ghosty-chrome/ext/tools.js", "utf8");
const fn = (n) => src.slice(src.indexOf(`function ${n}(`), src.indexOf("\n}\n", src.indexOf(`function ${n}(`)) + 2);
const b = await puppeteer.launch({ executablePath: process.env.HOME + "/.cache/puppeteer/chrome/mac_arm-139.0.7258.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", headless: "new" });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 900 });
const run = async (label) => {
  const r = await p.evaluate(`(() => { ${fn("pageRead")}; const t=performance.now(); const x=pageRead(6000); return {ms: Math.round(performance.now()-t), n: x.elements.length, nodes: document.querySelectorAll("*").length}; })()`);
  console.log(label, r);
};
// Sintético tipo feed de Facebook: 400 posts × ~60 nodos, botones con role=button y spans con cursor.
await p.setContent(`<style>.c{cursor:pointer}</style><div id=f></div><script>
for(let i=0;i<400;i++){const d=document.createElement("div");d.innerHTML='<div><div><span>Autor '+i+'</span><span class=c>· 3 h</span></div>'+'<div>'+'<span>texto </span>'.repeat(30)+'</div><div role=button tabindex=0><span>Me gusta</span></div><div role=button tabindex=0><span>Comentar</span></div><a href="https://www.facebook.com/x'+i+'">ver</a>'+'<div><div><div><span>x</span></div></div></div>'.repeat(5)+'</div>';f.append(d)}</script>`);
await run("sintético 400 posts");
for (const url of ["https://www.facebook.com/", "https://en.wikipedia.org/wiki/World_War_II", "https://www.ghosty.studio/planes"]) {
  try { await p.goto(url, { waitUntil: "networkidle2", timeout: 30000 }); await run(url); } catch (e) { console.log(url, e.message); }
}
await b.close();
