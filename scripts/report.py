#!/usr/bin/env python3
"""Relatório visual de uma execução: junta summary.json (k6), a série temporal do
dashboard do k6 e stats.csv (docker) num único HTML sem dependência externa.

uso: scripts/report.py results/<run-id>   →  results/<run-id>/report.html
"""
import base64
import csv
import gzip
import html
import json
import re
import statistics
import sys
from pathlib import Path

SERIES = [  # ordem fixa: a cor segue o container, nunca a posição no CSV
    ("api", "#2a78d6", "#3987e5"),
    ("postgres", "#eb6834", "#d95926"),
    ("nginx", "#1baf7a", "#199e70"),
]

# ── leitura ──────────────────────────────────────────────────────────────────


def to_mib(v):
    v = v.strip()
    m = re.match(r"([\d.]+)\s*([A-Za-z]+)", v)
    if not m:
        return 0.0
    n, unit = float(m.group(1)), m.group(2).lower()
    return n * {"b": 1 / 1048576, "kib": 1 / 1024, "mib": 1, "gib": 1024,
                "kb": 1 / 1024, "mb": 1, "gb": 1024}.get(unit, 1)


def read_stats(path):
    rows = {name: [] for name, _, _ in SERIES}
    limits = {}
    t0 = None
    if not path.exists():
        return rows, limits
    for r in csv.DictReader(path.open()):
        short = next((n for n, _, _ in SERIES if f"-{n}-" in r["container"]), None)
        if not short:
            continue
        ts = int(r["timestamp"])
        t0 = ts if t0 is None else min(t0, ts)
        used, _, limit = r["mem_usage"].partition("/")
        limits[short] = to_mib(limit)
        rows[short].append((ts, float(r["cpu_perc"].rstrip("%")), to_mib(used)))
    for name in rows:
        rows[name] = [(t - t0, c, m) for t, c, m in sorted(rows[name])]
    return rows, limits


def read_summary(path):
    return json.loads(path.read_text()).get("metrics", {}) if path.exists() else {}


# ── série temporal, extraída do dashboard do k6 ──────────────────────────────
#
# O k6 embute no k6-report.html um <script id="data"> com todos os snapshots
# (gzip + base64, um evento JSON por linha). É a única fonte de série temporal que
# existe sem reprocessar gigabytes: o summary.json só tem o agregado da execução
# inteira, e é justamente a evolução que mostra onde a capacidade acaba.
#
# O formato não é documentado — os snapshots são vetores posicionais cujas colunas são
# os nomes de métrica em ordem alfabética. A lista *cresce* durante a execução (métricas
# customizadas só existem depois da primeira amostra), e cada evento `metric` reordena
# tudo, então a ordem precisa ser recalculada evento a evento em vez de uma vez no fim.
# Se o k6 mudar isso, a extração devolve vazio e o relatório omite estas seções.

TREND = {"avg": 0, "max": 1, "med": 2, "min": 3, "p90": 4, "p95": 5, "p99": 6}


def read_timeseries(path):
    if not path.exists():
        return []
    try:
        blob = re.search(r'<script id="data"[^>]*>(.*?)</script>',
                         path.read_text(encoding="utf-8", errors="replace"), re.S)
        if not blob:
            return []
        events = [json.loads(line) for line
                  in gzip.decompress(base64.b64decode(blob.group(1).strip())).decode().splitlines()]

        known, cols, rows = set(), [], []
        for e in events:
            if e.get("event") == "metric":
                known.update(e["data"])
                cols = sorted(known)
                continue
            if e.get("event") != "snapshot" or len(e["data"]) != len(cols):
                continue
            d = dict(zip(cols, e["data"]))
            if not d.get("time") or not d.get("vus"):
                continue
            dur = d.get("http_req_duration") or []
            rows.append({
                "t": d["time"][0] / 1000,
                "vus": d["vus"][0],
                "rps": (d.get("http_reqs") or [0, 0])[1],
                "iters": (d.get("iterations") or [0, 0])[1],
                "med": dur[TREND["med"]] if dur else None,
                "p95": dur[TREND["p95"]] if dur else None,
                "p99": dur[TREND["p99"]] if dur else None,
            })
        if not rows:
            return []
        t0 = rows[0]["t"]
        for r in rows:
            r["t"] -= t0
        return rows
    except Exception:  # formato mudou — o relatório vive sem isto
        return []


def find_plateaus(rows, min_samples=12):
    """Trechos em que os VUs ficam parados. É neles que a medida vale: durante a
    rampa a latência mistura dois níveis de carga e não representa nenhum dos dois."""
    groups, cur = [], []
    for r in rows:
        if cur and abs(r["vus"] - cur[0]["vus"]) <= max(2.0, 0.04 * cur[0]["vus"]):
            cur.append(r)
            continue
        if len(cur) >= min_samples:
            groups.append(cur)
        cur = [r]
    if len(cur) >= min_samples:
        groups.append(cur)

    out = []
    for g in groups:
        vus = statistics.median(r["vus"] for r in g)
        if vus < 5:
            continue
        lat = [r for r in g if r["p95"] is not None]
        if not lat:
            continue
        period = (g[-1]["t"] - g[0]["t"]) / max(1, len(g) - 1)
        out.append({
            "vus": vus,
            "seconds": len(g) * period,
            "rps": statistics.mean(r["rps"] for r in g),
            "med": statistics.median(r["med"] for r in lat),
            "p95": statistics.median(r["p95"] for r in lat),
            "p99": statistics.median(r["p99"] for r in lat),
        })
    return out


# ── formatação ───────────────────────────────────────────────────────────────


def num(v):
    return f"{v:,.0f}".replace(",", ".")


def ms(v):
    if v is None:
        return "–"
    return f"{v / 1000:.1f}s" if v >= 1000 else f"{v:.0f}ms"


def duration(seconds):
    seconds = int(seconds or 0)
    return f"{seconds // 60}min{seconds % 60:02d}s" if seconds >= 60 else f"{seconds}s"


# ── leitura em negócio ───────────────────────────────────────────────────────

# Acima disto a tela "trava" para quem está usando; é o mesmo valor do threshold de
# leitura em k6/profiles.js, para o relatório não contar uma história diferente do
# critério que faz a execução falhar.
LIMIT_MS = 800
COMFORT_MS = 200


def insights(m, plats, run_seconds):
    """Frases prontas, cada uma derivada de um número que está na página. Nada aqui
    é estimativa: quando o dado não existe, a frase não aparece."""
    out = []

    # Um patamar só não é curva de capacidade: é uma carga fixa. Dizer "aguentou N
    # simultâneos" a partir dele seria afirmar um limite que o teste não procurou.
    if len(plats) < 2:
        plats = []

    ok = [p for p in plats if p["p95"] <= COMFORT_MS]
    tight = [p for p in plats if COMFORT_MS < p["p95"] <= LIMIT_MS]
    broken = [p for p in plats if p["p95"] > LIMIT_MS]

    if ok:
        best = max(ok, key=lambda p: p["vus"])
        detail = f"p95 de {ms(best['p95'])} e {best['rps']:.0f} req/s sustentados por {duration(best['seconds'])}"
        if broken:
            worst = min(broken, key=lambda p: p["vus"])
            detail += f". Em {worst['vus']:.0f} simultâneos o p95 vai a {ms(worst['p95'])}"
        out.append(("Usuários simultâneos com folga", f"{best['vus']:.0f}", detail))
    if tight:
        edge = max(tight, key=lambda p: p["vus"])
        out.append(("Ainda dentro do limite", f"{edge['vus']:.0f} simultâneos",
                    f"p95 de {ms(edge['p95'])} — abaixo do teto de {LIMIT_MS}ms, mas já perceptível"))

    if plats:
        top = max(plats, key=lambda p: p["rps"])
        saturated = [p for p in plats if p["rps"] >= top["rps"] * 0.9]
        note = "vazão máxima medida"
        if len(saturated) > 1:
            first = min(saturated, key=lambda p: p["vus"])
            note = (f"a partir de {first['vus']:.0f} usuários simultâneos a vazão para de subir "
                    f"e só a latência cresce — é o teto da máquina")
        out.append(("Teto de vazão", f"{top['rps']:.0f} req/s", note))

    users = (m.get("users_created") or {}).get("count", 0)
    if users and run_seconds:
        per_min = users / run_seconds * 60
        onb = (m.get("onboarding_duration") or {}).get("p(95)")
        detail = f"{per_min:.0f} por minuto"
        if onb:
            detail += f", cada um levando até {ms(onb)} (cadastro + ativação + histórico)"
        out.append(("Cadastros completos", f"{num(users)} em {duration(run_seconds)}", detail))

    rel = (m.get("releases_created") or {}).get("count", 0)
    if rel:
        out.append(("Lançamentos gravados", num(rel),
                    f"{rel / run_seconds:.0f} por segundo em média" if run_seconds else ""))

    failed = m.get("http_req_failed") or {}
    rate = (failed.get("value") if failed.get("value") is not None else failed.get("rate")) or 0
    total = (m.get("http_reqs") or {}).get("count", 0)
    if total:
        n = round(rate * total)
        out.append(("Erros", "nenhum" if n == 0 else num(n),
                    f"nenhuma das {num(total)} requisições falhou — sob carga o sistema "
                    f"ficou lento, não quebrou" if n == 0
                    else f"de {num(total)} requisições ({rate * 100:.3f}%)"))
    return out


def insight_cards(items):
    if not items:
        return ""
    return '<div class="cards">' + "".join(
        f'<div class="card"><span class="k">{html.escape(k)}</span>'
        f'<strong>{v}</strong><p>{d}</p></div>' for k, v, d in items) + "</div>"


def capacity_table(plats):
    if len(plats) < 2:
        return ""
    rows = []
    for p in plats:
        if p["p95"] > LIMIT_MS:
            state, cls = "saturado", "bad"
        elif p["p95"] > COMFORT_MS:
            state, cls = "no limite", "warn"
        else:
            state, cls = "folgado", "ok"
        rows.append(
            f"<tr><td><strong>{p['vus']:.0f}</strong></td><td>{p['rps']:.0f}</td>"
            f"<td>{ms(p['med'])}</td><td>{ms(p['p95'])}</td><td>{ms(p['p99'])}</td>"
            f"<td><span class='pill {cls}'>{state}</span></td></tr>")
    return ("<table><thead><tr><th>Usuários simultâneos</th><th>req/s</th><th>mediana</th>"
            "<th>p95</th><th>p99</th><th></th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table>")


# ── gráfico de linha (SVG inline) ────────────────────────────────────────────

W, H = 780, 220
PAD_L, PAD_R, PAD_T, PAD_B = 52, 86, 14, 26


def _frame(px, py, ymax, xmax, unit, fmt):
    out = [f'<svg viewBox="0 0 {W} {H}" class="chart" data-unit="{unit}" '
           f'data-xmax="{xmax}" data-pxl="{PAD_L}" data-pxr="{W - PAD_R}">']
    for i in range(5):
        y = ymax * i / 4
        out.append(f'<line class="grid" x1="{PAD_L}" x2="{W - PAD_R}" y1="{py(y):.1f}" y2="{py(y):.1f}"/>')
        out.append(f'<text class="tick" x="{PAD_L - 8}" y="{py(y) + 4:.1f}" text-anchor="end">{fmt.format(y)}</text>')
    for i in range(5):
        x = xmax * i / 4
        out.append(f'<text class="tick" x="{px(x):.1f}" y="{H - 8}" text-anchor="middle">{x / 60:.0f}min</text>')
    out.append(f'<line class="axis" x1="{PAD_L}" x2="{W - PAD_R}" y1="{py(0):.1f}" y2="{py(0):.1f}"/>')
    return out


def _figure(cid, out, payload):
    out.append(f'<g class="cross" hidden><line y1="{PAD_T}" y2="{H - PAD_B}"/></g>')
    out.append(f'<script type="application/json" class="data">{json.dumps(payload)}</script>')
    out.append("</svg>")
    return f'<figure class="fig" id="{cid}">' + "".join(out) + '<div class="tip" hidden></div></figure>'


def line_chart(cid, stats, idx, unit, y_hint=None, fmt="{:.0f}"):
    xs = [p[0] for s in stats.values() for p in s]
    ys = [p[idx] for s in stats.values() for p in s]
    if not xs or not ys:
        return "<p class='muted'>sem amostras</p>"
    xmax = max(xs) or 1
    ymax = max(max(ys), y_hint or 0) * 1.12 or 1
    px = lambda x: PAD_L + (x / xmax) * (W - PAD_L - PAD_R)
    py = lambda y: H - PAD_B - (y / ymax) * (H - PAD_T - PAD_B)

    out = _frame(px, py, ymax, xmax, unit, fmt)
    payload = {}
    for name, _light, _dark in SERIES:
        pts = stats.get(name) or []
        if not pts:
            continue
        d = " ".join(f"{'M' if i == 0 else 'L'}{px(p[0]):.1f},{py(p[idx]):.1f}" for i, p in enumerate(pts))
        out.append(f'<path class="s-{name}" d="{d}" fill="none" stroke-width="2" '
                   f'stroke-linejoin="round" stroke-linecap="round"/>')
        out.append(f'<text class="lbl s-{name}-t" x="{px(pts[-1][0]) + 6:.1f}" '
                   f'y="{py(pts[-1][idx]) + 4:.1f}">{name}</text>')
        payload[name] = [[p[0], round(p[idx], 1)] for p in pts]
    return _figure(cid, out, payload)


def series_chart(cid, rows, fields, unit, fmt="{:.0f}", scale=1.0):
    """`fields` é [(chave, rótulo, classe css)] — todas na MESMA unidade, porque
    misturar duas escalas num eixo só é a maneira mais fácil de mentir num gráfico."""
    pts = {key: [(r["t"], r[key] * scale) for r in rows if r.get(key) is not None]
           for key, _, _ in fields}
    pts = {k: v for k, v in pts.items() if v}
    if not pts:
        return ""
    xmax = max(p[0] for v in pts.values() for p in v) or 1
    ymax = (max(p[1] for v in pts.values() for p in v) or 1) * 1.12
    px = lambda x: PAD_L + (x / xmax) * (W - PAD_L - PAD_R)
    py = lambda y: H - PAD_B - (min(y, ymax) / ymax) * (H - PAD_T - PAD_B)

    out = _frame(px, py, ymax, xmax, unit, fmt)
    payload = {}
    for key, label, cls in fields:
        v = pts.get(key)
        if not v:
            continue
        d = " ".join(f"{'M' if i == 0 else 'L'}{px(p[0]):.1f},{py(p[1]):.1f}" for i, p in enumerate(v))
        out.append(f'<path class="k-{cls}" d="{d}" fill="none" stroke-width="2" '
                   f'stroke-linejoin="round" stroke-linecap="round"/>')
        out.append(f'<text class="lbl k-{cls}-t" x="{px(v[-1][0]) + 6:.1f}" '
                   f'y="{py(v[-1][1]) + 4:.1f}">{label}</text>')
        payload[label] = [[p[0], round(p[1], 1)] for p in v]
    return _figure(cid, out, payload)


# ── tabelas ──────────────────────────────────────────────────────────────────

LAT_ROWS = [
    ("http_req_duration", "Todas as requisições"),
    ("http_req_duration{kind:read}", "Leituras"),
    ("http_req_duration{kind:write}", "Escritas"),
    ("http_req_duration{kind:auth}", "Login / cadastro"),
    ("dashboard_duration", "Dashboard (6 chamadas)"),
    ("onboarding_duration", "Onboarding completo"),
    ("iteration_duration", "Iteração"),
]


def latency_table(m):
    body = []
    for key, label in LAT_ROWS:
        d = m.get(key)
        if not d:
            continue
        body.append("<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            html.escape(label), ms(d.get("avg")), ms(d.get("med")),
            ms(d.get("p(90)")), ms(d.get("p(95)")), ms(d.get("max"))))
    return ("<table><thead><tr><th>Fluxo</th><th>média</th><th>mediana</th>"
            "<th>p90</th><th>p95</th><th>máx</th></tr></thead><tbody>"
            + "".join(body) + "</tbody></table>")


def threshold_table(m):
    body = []
    for name, d in sorted(m.items()):
        for expr, failed in (d.get("thresholds") or {}).items():
            ok = not failed  # no export legado, true = estourou
            body.append(
                "<tr><td><code>%s</code></td><td><code>%s</code></td>"
                "<td><span class='pill %s'>%s</span></td></tr>"
                % (html.escape(name), html.escape(expr),
                   "ok" if ok else "bad", "passou" if ok else "FALHOU"))
    return "<table><thead><tr><th>Métrica</th><th>Limite</th><th></th></tr></thead><tbody>" \
        + "".join(body) + "</tbody></table>"


def read_psql(path):
    """Saída de `psql -P pager=off` → (cabeçalhos, linhas). O dump cru era ilegível
    no relatório: números sem separador, alinhados por espaço, dentro de um <pre>."""
    if not path.exists():
        return [], []
    lines = path.read_text(errors="replace").splitlines()
    if len(lines) < 3 or "|" not in lines[0]:
        return [], []
    head = [c.strip() for c in lines[0].split("|")]
    rows = []
    for line in lines[2:]:
        if re.match(r"^\(\d+ (row|linha)", line.strip()) or not line.strip():
            break
        cells = [c.strip() for c in line.split("|", len(head) - 1)]
        if len(cells) == len(head):
            rows.append(cells)
    return head, rows


def volume_table(path):
    """Quantas linhas cada tabela ganhou. A barra existe porque o que se quer aqui é
    a proporção — qual tabela domina o banco —, e não o valor exato de cada uma."""
    head, rows = read_psql(path)
    if not rows:
        return ""
    parsed = []
    for r in rows:
        try:
            n = int(r[1])
        except (ValueError, IndexError):
            continue
        if n > 0:
            parsed.append((r[0], n))
    if not parsed:
        return ""
    top = max(n for _, n in parsed)
    body = "".join(
        f'<tr><td>{html.escape(name)}</td><td class="r">{num(n)}</td>'
        f'<td class="barcell"><span class="bar" style="width:{n / top * 100:.1f}%"></span></td></tr>'
        for name, n in parsed)
    return ('<table><thead><tr><th>Tabela</th><th class="r">Linhas</th>'
            f'<th>proporção</th></tr></thead><tbody>{body}</tbody></table>')


def query_table(path, limit=12):
    head, rows = read_psql(path)
    if not rows or len(head) < 5:
        return ""
    body = []
    for r in rows[:limit]:
        calls, total, mean, _rows, query = r[0], r[1], r[2], r[3], r[4]
        try:
            total = ms(float(total))
        except ValueError:
            pass
        body.append(f'<tr><td class="r">{num(float(calls))}</td><td class="r">{total}</td>'
                    f'<td class="r">{mean}ms</td><td><code>{html.escape(query[:110])}</code></td></tr>')
    return ('<table class="q"><thead><tr><th class="r">chamadas</th><th class="r">tempo total</th>'
            '<th class="r">por chamada</th><th>query</th></tr></thead><tbody>'
            + "".join(body) + "</tbody></table>")


def tiles(m, stats, limits, run_seconds):
    reqs = m.get("http_reqs", {})
    failed = m.get("http_req_failed", {})
    checks = m.get("checks", {}) or m.get("checks_total", {})
    dur = m.get("http_req_duration", {})
    peak_cpu = max((p[1] for s in stats.values() for p in s), default=0)
    api_mem = max((p[2] for p in stats.get("api", [])), default=0)
    api_lim = limits.get("api", 0)
    fail_rate = (failed.get("value") or failed.get("rate") or 0) * 100
    chk = checks.get("value", checks.get("passes"))
    chk = f"{chk * 100:.1f}%" if isinstance(chk, float) and chk <= 1 else "100%"
    t = [
        ("Duração", duration(run_seconds), "carga efetiva"),
        ("Requisições", num(reqs.get("count", 0)), f"{reqs.get('rate', 0):.0f}/s em média"),
        ("Falhas HTTP", f"{fail_rate:.2f}%", "meta &lt; 2%"),
        ("Checks", chk, "meta &gt; 98%"),
        ("p95 global", ms(dur.get("p(95)")), f"máx {ms(dur.get('max'))}"),
        ("Pico de CPU", f"{peak_cpu:.0f}%", "de 200% (2 cores)"),
        ("Pico de RSS da API", f"{api_mem / 1024:.2f}GiB", f"de {api_lim / 1024:.0f}GiB"),
    ]
    return "".join(
        f'<div class="tile"><span class="k">{k}</span><strong>{v}</strong><span class="s">{s}</span></div>'
        for k, v, s in t)


# ── página ───────────────────────────────────────────────────────────────────

CSS = """
:root{--surface:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
--grid:#e1e0d9;--axis:#c3c2b7;--good:#0ca30c;--bad:#d03b3b;--warn:#b06a00;
--api:#2a78d6;--postgres:#eb6834;--nginx:#1baf7a;--border:#e1e0d9;
--vus:#4a3aa7;--rps:#1baf7a;--med:#6da7ec;--p95:#2a78d6;--p99:#104281;--barfill:#9ec5f4}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--surface:#1a1a19;--plane:#0d0d0d;
--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--api:#3987e5;--postgres:#d95926;--nginx:#199e70;
--border:#2c2c2a;--warn:#eda100;--vus:#9085e9;--rps:#199e70;--med:#1c5cab;--p95:#3987e5;--p99:#86b6ef;
--barfill:#1c5cab}}
:root[data-theme=dark]{--surface:#1a1a19;--plane:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;
--axis:#383835;--api:#3987e5;--postgres:#d95926;--nginx:#199e70;--border:#2c2c2a;--warn:#eda100;
--vus:#9085e9;--rps:#199e70;--med:#1c5cab;--p95:#3987e5;--p99:#86b6ef;--barfill:#1c5cab}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:900px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:36px 0 10px;letter-spacing:.02em;text-transform:uppercase;color:var(--ink2)}
.sub{color:var(--muted);margin:0 0 24px;font-size:13px}
.note{color:var(--muted);font-size:12.5px;margin:8px 2px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:10px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.card .k{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);display:block}
.card strong{font-size:26px;font-variant-numeric:tabular-nums;font-weight:600;display:block;margin:2px 0 4px;line-height:1.15}
.card p{margin:0;font-size:12.5px;color:var(--ink2);line-height:1.45}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.tile strong{font-size:22px;font-variant-numeric:tabular-nums;font-weight:600}
.tile .s{font-size:12px;color:var(--muted)}
.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:500}
th,td{padding:8px 12px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
td.r,th.r{text-align:right}
tr:last-child td{border-bottom:none}
table.q td:last-child{width:55%}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink2)}
.barcell{width:34%}
.bar{display:block;height:8px;border-radius:4px;background:var(--barfill);min-width:2px}
.pill{font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;white-space:nowrap}
.pill.ok{color:var(--good);border:1px solid var(--good)}
.pill.warn{color:var(--warn);border:1px solid var(--warn)}
.pill.bad{color:var(--bad);border:1px solid var(--bad)}
.fig{margin:0;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 4px;position:relative;overflow-x:auto}
.chart{width:100%;height:auto;display:block;min-width:600px}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}
.tick{fill:var(--muted);font-size:10px}
.lbl{font-size:11px;font-weight:600}
.s-api{stroke:var(--api)}.s-postgres{stroke:var(--postgres)}.s-nginx{stroke:var(--nginx)}
.s-api-t{fill:var(--api)}.s-postgres-t{fill:var(--postgres)}.s-nginx-t{fill:var(--nginx)}
.k-vus{stroke:var(--vus)}.k-rps{stroke:var(--rps)}.k-med{stroke:var(--med)}.k-p95{stroke:var(--p95)}.k-p99{stroke:var(--p99)}
.k-vus-t{fill:var(--vus)}.k-rps-t{fill:var(--rps)}.k-med-t{fill:var(--med)}.k-p95-t{fill:var(--p95)}.k-p99-t{fill:var(--p99)}
.cross line{stroke:var(--axis);stroke-width:1;stroke-dasharray:3 3}
.tip{position:absolute;pointer-events:none;background:var(--surface);border:1px solid var(--border);
border-radius:8px;padding:6px 9px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.12);white-space:nowrap}
.tip b{font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.muted{color:var(--muted)}
"""

JS = """
const KEY={api:'--api',postgres:'--postgres',nginx:'--nginx'};
document.querySelectorAll('.fig').forEach(fig=>{
  const svg=fig.querySelector('svg'), tip=fig.querySelector('.tip');
  const data=JSON.parse(svg.querySelector('script.data').textContent);
  const cross=svg.querySelector('.cross'), line=cross.querySelector('line');
  const unit=svg.dataset.unit, xmax=+svg.dataset.xmax, pxl=+svg.dataset.pxl, pxr=+svg.dataset.pxr;
  const names=Object.keys(data);
  const paths=[...svg.querySelectorAll('path')];
  svg.addEventListener('pointermove',e=>{
    const r=svg.getBoundingClientRect(), vx=(e.clientX-r.left)/r.width*svg.viewBox.baseVal.width;
    if(vx<pxl||vx>pxr){cross.hidden=true;tip.hidden=true;return}
    const t=(vx-pxl)/(pxr-pxl)*xmax;
    line.setAttribute('x1',vx);line.setAttribute('x2',vx);cross.hidden=false;
    const rows=names.map((n,i)=>{
      const pts=data[n]; let best=pts[0];
      for(const p of pts) if(Math.abs(p[0]-t)<Math.abs(best[0]-t)) best=p;
      const stroke=paths[i]?getComputedStyle(paths[i]).stroke:'currentColor';
      return `<div><span class="dot" style="background:${stroke}"></span>${n} <b>${best[1]}${unit}</b></div>`;
    }).join('');
    tip.innerHTML=`<div class="muted">${(t/60).toFixed(1)} min</div>${rows}`;
    tip.hidden=false;
    const left=e.clientX-r.left+14;
    tip.style.left=Math.min(left,r.width-tip.offsetWidth-8)+'px';
    tip.style.top=Math.max(8,e.clientY-r.top-tip.offsetHeight-10)+'px';
  });
  svg.addEventListener('pointerleave',()=>{cross.hidden=true;tip.hidden=true});
});
"""


def main():
    run = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    metrics = read_summary(run / "summary.json")
    stats, limits = read_stats(run / "stats.csv")
    if not metrics and not any(stats.values()):
        sys.exit(f"nada para relatar em {run}")

    rows = read_timeseries(run / "k6-report.html")
    plats = find_plateaus(rows)
    reqs = metrics.get("http_reqs") or {}
    run_seconds = (reqs.get("count", 0) / reqs["rate"]) if reqs.get("rate") else (
        rows[-1]["t"] if rows else 0)

    cards = insight_cards(insights(metrics, plats, run_seconds))
    cap = capacity_table(plats)
    cap_block = f"""<h2>Curva de capacidade</h2>{cap}
<p class="note">Cada linha é um patamar de carga estável — a rampa entre eles é
descartada, porque lá a latência mistura dois níveis e não representa nenhum. Um VU é
um usuário <em>ativo</em>, agindo a cada 0,5–2,5s; gente real passa muito mais tempo
parada, então cada VU vale por vários usuários logados.</p>""" if cap else ""

    lat_chart = series_chart("lat", rows, [
        ("med", "mediana", "med"), ("p95", "p95", "p95"), ("p99", "p99", "p99")], "ms")
    vus_chart = series_chart("vus", rows, [("vus", "usuários", "vus")], "")
    rps_chart = series_chart("rps", rows, [("rps", "req/s", "rps")], "/s")

    curves = ""
    if rows:
        curves = f"""<h2>Usuários simultâneos ao longo do tempo</h2>{vus_chart}
<h2>Vazão · requisições por segundo</h2>{rps_chart}
<h2>Latência ao longo do tempo · ms</h2>{lat_chart}
<p class="note">Vazão e latência em gráficos separados de propósito: são unidades
diferentes, e sobrepô-las num eixo só distorceria as duas.</p>"""

    volume = volume_table(run / "pg-table-sizes.txt")
    queries = query_table(run / "pg-top-queries.txt")

    page = f"""<title>Carga · {html.escape(run.name)}</title>
<style>{CSS}</style>
<main>
<h1>Teste de carga · {html.escape(run.name)}</h1>
<p class="sub">API + Postgres 18 + nginx disputando 2 cores, como na VM de produção.</p>

{f'<h2>O que este teste diz</h2>{cards}' if cards else ''}

<h2>Números da execução</h2>
<div class="tiles">{tiles(metrics, stats, limits, run_seconds)}</div>

{cap_block}

<h2>Limites (thresholds)</h2>
{threshold_table(metrics)}

<h2>Latência por fluxo</h2>
{latency_table(metrics)}

{curves}

<h2>CPU dos containers · % de 200% (2 cores)</h2>
{line_chart('cpu', stats, 1, '%', y_hint=200)}

<h2>Memória residente · MiB</h2>
{line_chart('mem', stats, 2, 'MiB')}

{f'<h2>Queries mais caras (tempo total no banco)</h2><div class="wrap">{queries}</div>' if queries else ''}
{f'<h2>Volume no banco</h2>{volume}' if volume else ''}
</main>
<script>{JS}</script>
"""
    out = run / "report.html"
    out.write_text(page, encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
