"""Build demo/index.html — the design demo — from index.html.

The demo is fully separate from the real app: its own localStorage keys, no server
(no Supabase, no login), no service worker, and it starts filled with sample data.
Run from the repository root:  python3 tools/build_demo.py
"""
import re, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "index.html").read_text()
theme = (root / "tools" / "demo-theme.css").read_text()

def rep(s, old, new, count=1):
    assert old in s, "not found: " + old[:70]
    return s.replace(old, new, count)

head, script = src.split("<script>\n(function(){", 1)
script = "<script>\n(function(){" + script

# separate storage: every "qalta-..." localStorage key gets a "qalta-demo-" prefix
script = script.replace('"qalta-', '"qalta-demo-')
# no server, no service worker
head = rep(head, '<script src="config.js"></script>\n<script src="vendor/supabase.js"></script>', '<script>window.QALTA_CONFIG = {};</script>')
script = rep(script, 'if ("serviceWorker" in navigator', 'if (false && "serviceWorker" in navigator')
# assets live one folder up
for a in ['href="manifest.webmanifest"', 'href="icons/icon.svg"', 'href="icons/apple-touch-icon.png"']:
    head = rep(head, a, a.replace('href="', 'href="../'))
head = rep(head, "<title>Қалта</title>", "<title>Қалта · демо</title>")
# first launch: start with the sample data, saved in the demo's own storage
script = rep(script, 'if (!hasCloud()) { mode = "local"; render(); return; }',
  'if (!hasCloud()) { mode = "local"; if (!allTx().length) { const d = demoState(); S.settings = d.settings; S.months = d.months; bump(); saveLocal(); } render(); return; }')
# ribbon above every page
script = rep(script, '$("#main").innerHTML = `${banner}<div class="topbar">',
  '$("#main").innerHTML = `<div class="demo-ribbon"><span>${({kk: "Жаңа дизайн · демо. Деректер бөлек, мысал ретінде.", ru: "Новый дизайн · демо. Данные отдельные, для примера.", en: "New design · demo. Separate sample data."})[LANG] || ""}</span><a href="../">${({kk: "← Қазіргі нұсқа", ru: "← Текущая версия", en: "← Current version"})[LANG] || ""}</a></div>${banner}<div class="topbar">')
# the new look: fonts, a generated guilloche rosette, then the theme after the base styles so it wins
import math, urllib.parse
def rosette():
    paths = []
    for k, (R, r, d, op) in enumerate([(100, 37, 58, .22), (92, 23, 46, .16), (78, 29, 34, .13), (60, 17, 30, .12)]):
        pts = []
        steps = 900
        for i in range(steps + 1):
            t = 2 * math.pi * 18 * i / steps
            x = (R - r) * math.cos(t) + d * math.cos((R - r) / r * t)
            y = (R - r) * math.sin(t) - d * math.sin((R - r) / r * t)
            pts.append(f"{150 + x * 1.0:.1f},{150 + y * 1.0:.1f}")
        paths.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#fff" stroke-opacity="{op}" stroke-width=".6"/>')
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' + "".join(paths) + "</svg>"
    return "url(\"data:image/svg+xml," + urllib.parse.quote(svg) + "\")"
fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=Literata:opsz,wght@7..72,600;7..72,700;7..72,800&family=JetBrains+Mono:wght@500;600&display=swap">'
head = re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com/css2[^"]*">', fonts, head, count=1)
head = rep(head, "</style>", ":root{--guilloche:" + rosette() + "}\n" + theme + "\n</style>")

out = root / "demo" / "index.html"
out.parent.mkdir(exist_ok=True)
out.write_text(head + script)
print("wrote", out)
