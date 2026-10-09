#!/usr/bin/env python3
"""Arma store/build/ext y store/ghosty.zip a partir de ext/ (desarrollo).

Cambios de la build de tienda:
- versión 1.0.0 (gs no mira la versión: exige el PROTOCOLO `GHOSTY_BROWSER_PROTOCOL`, que es el mismo), sin `key` (la tienda asigna su id), gs = https://www.ghosty.studio;
- sin localhost: ni en externally_connectable ni en el código;
- sin la tool `evaluate` ni `cdp.evaluate` («código remoto: No»), y el Playwright vendorizado con
  `evaluate`/`eval`/`extend` anulados.
Uso: python3 store/make-build.py
"""
import json, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "ext")
OUT = os.path.join(ROOT, "store", "build", "ext")
ZIP = os.path.join(ROOT, "store", "ghosty.zip")
PROD = "https://www.ghosty.studio"

def edit(rel, pairs):
    p = os.path.join(OUT, rel)
    s = open(p).read()
    for old, new in pairs:
        if old not in s:
            sys.exit(f"✗ {rel}: no encontré {old[:70]!r}")
        s = s.replace(old, new)
    open(p, "w").write(s)

shutil.rmtree(OUT, ignore_errors=True)
shutil.copytree(SRC, OUT, ignore=shutil.ignore_patterns(".DS_Store"))

m = json.load(open(os.path.join(OUT, "manifest.json")))
m["version"] = "1.0.1"
m["name"] = "Ghosty"
m.pop("key", None)
m["externally_connectable"]["matches"] = [x for x in m["externally_connectable"]["matches"] if "localhost" not in x]
m["host_permissions"] = ["<all_urls>"]
open(os.path.join(OUT, "manifest.json"), "w").write(json.dumps(m, indent=2, ensure_ascii=False) + "\n")

edit("background.js", [
    ('const DEFAULT_GS = "http://localhost:5180";', f'const DEFAULT_GS = "{PROD}";'),
    (' || /^http:\\/\\/localhost:5180\\/(c|app)(\\/|\\?|#|$)/.test(url ?? "")', ""),
    ('const PAGE_ORIGINS = ["https://www.ghosty.studio", "https://ghosty.studio", "http://localhost:5180"];', 'const PAGE_ORIGINS = ["https://www.ghosty.studio", "https://ghosty.studio"];'),
    ('const ALLOWED_GS = ["https://www.ghosty.studio", "http://localhost:5180"];', f'const ALLOWED_GS = ["{PROD}"];'),
])
edit("relay.js", [('let gs = "http://localhost:5180";', f'let gs = "{PROD}";')])
edit("panel.js", [
    ('relay?.gs ?? "http://localhost:5180"', f'relay?.gs ?? "{PROD}"'),
    ('["https://www.ghosty.studio", "http://localhost:5180"].includes(v)', f'["{PROD}"].includes(v)'),
])

# Sin `evaluate` (código que manda el agente).
p = os.path.join(OUT, "tools", "computer.js")
s = open(p).read()
a = s.index('    {\n      name: "evaluate",')
b = s.index('    {\n      name: "console_messages",')
open(p, "w").write(s[:a] + s[b:])
p = os.path.join(OUT, "cdp.js")
s = open(p).read()
a = s.index("export async function evaluate(tabId, expression) {")
b = s.index("/** Pone archivos LOCALES")
open(p, "w").write(s[:a] + s[b:])
edit("vendor/playwright/injected.js", [
    ("    let result = this.global.eval(expression);", '    throw new Error("evaluate deshabilitado en la build de la tienda");'),
    ("  eval(expression) {\n    return this.window.eval(expression);\n  }", '  eval(expression) {\n    throw new Error("eval deshabilitado en la build de la tienda");\n  }'),
    ("    const constrFunction = this.window.eval(`", '    throw new Error("extend deshabilitado en la build de la tienda");\n    const constrFunction = this.window.eval(`'),
    ("(sólo lo renueva si cambia el rol).", "(sólo lo renueva si cambia el rol). Build de tienda: `UtilityScript.evaluate`,\n// `InjectedScript.eval` y `InjectedScript.extend` lanzan error en vez de evaluar código."),
])

# Comprobaciones: sin localhost, sin evaluate expuesto, sintaxis.
leaks = subprocess.run(["grep", "-rln", "localhost", OUT], capture_output=True, text=True).stdout.split()
leaks = [l for l in leaks if "/vendor/" not in l]
if leaks:
    sys.exit(f"✗ localhost en: {leaks}")
if 'name: "evaluate"' in open(os.path.join(OUT, "tools", "computer.js")).read():
    sys.exit("✗ evaluate sigue en la build")
for dp, _, fs in os.walk(OUT):
    for f in fs:
        if f.endswith((".js", ".mjs")):
            r = subprocess.run(["node", "--check", os.path.join(dp, f)], capture_output=True, text=True)
            if r.returncode:
                sys.exit(f"✗ sintaxis {f}: {r.stderr[:200]}")

if os.path.exists(ZIP):
    os.remove(ZIP)
subprocess.run(["zip", "-qrX", ZIP, ".", "-x", "*.DS_Store"], cwd=OUT, check=True)
print(f"✓ {ZIP} · versión {m['version']} · permisos {', '.join(m['permissions'])}")
