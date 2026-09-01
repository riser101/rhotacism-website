"""Generate the clinical Lisp Assessment Report PDF (WeasyPrint / HTML+CSS).

Extracted from cloud-functions/tsh-sales-automation/report.py when that service
was retired — same design, minus the treatment-timeline / practice-protocol /
next-steps sections: this PDF is attached to the HubSpot lead and shared with
the lead directly, so it carries assessment findings only, no pitch.

Purely factual and truthful: a no-lisp (GRI >= 85) result renders in the
"all clear" green treatment with a clinical impression instead of a red score.
"""
import base64
import hashlib
import html as _html
import os
import re
from pathlib import Path

from weasyprint import HTML

BASE = Path(__file__).resolve().parent


def _logo_uri():
    for name in ("logo.png", "shield-blue.png", "favicon.png"):
        p = BASE / "assets" / name
        if p.exists():
            b64 = base64.b64encode(p.read_bytes()).decode()
            return f"data:image/png;base64,{b64}"
    return ""


_LOGO = _logo_uri()

# --- palette (matches the product report) ---
_CSS = """
@page { size: A4; margin: 11mm 9mm 15mm 9mm; background:#F4F6F8;
  @bottom-center { content: "Lisp Speech Clinic  \\2022  topspeech.health/lispspeechclinic  \\2022  Confidential clinical report  \\2022  Page " counter(page) " of " counter(pages);
    font-family: 'Liberation Sans', sans-serif; font-size: 7.5pt; color: #718096; } }
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Liberation Sans','Inter',sans-serif; color:#333; line-height:1.55; font-size:9.2pt; }
.card { background:#fff; border-radius:12px; padding:22px 24px; margin-bottom:14px; border:1px solid #E2E8F0;
  box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
.report-header { border-top:4px solid #1A202C; }
.meta-row { display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:14px; border-bottom:1px solid #E2E8F0; margin-bottom:16px; }
.brand-wrap { display:flex; align-items:center; gap:12px; }
.brand-logo { height:38px; width:auto; display:block; }
.brand-sub { font-size:8pt; color:#718096; margin-top:4px; }
.rdate { text-align:right; font-size:9pt; color:#718096; }
.rdate b { display:block; color:#4A5568; font-size:8pt; text-transform:uppercase; letter-spacing:0.06em; }
h1 { font-size:20pt; font-weight:700; color:#1A202C; line-height:1.2; margin-bottom:4px; }
.subtitle { font-size:10pt; color:#718096; margin-bottom:14px; }
.patient-line { font-size:9.5pt; color:#4A5568; margin-bottom:16px; }
.patient-line b { color:#1A202C; }
.gri-strip { display:flex; gap:12px; }
.gri-box { background:#F7FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:12px 16px; flex:1.35; display:flex; gap:14px; align-items:center; }
.gri-num { font-size:26pt; font-weight:700; line-height:1; white-space:nowrap; }
.gri-num small { font-size:10pt; color:#718096; font-weight:400; white-space:nowrap; }
.gri-label { font-size:8.5pt; color:#4A5568; }
.gri-label b { display:block; font-size:9.5pt; color:#1A202C; }
.mini { background:#F7FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:12px 14px; flex:1; }
.mini b { display:block; font-size:14pt; color:#1A202C; line-height:1.15; }
.mini span { font-size:8pt; color:#718096; }
h2 { font-size:13pt; font-weight:700; color:#1A202C; border-left:4px solid #1A202C; padding-left:12px; margin-bottom:12px; }
.sec-head { display:flex; justify-content:space-between; align-items:baseline; margin:14px 0 8px 0; }
.sec-name { font-size:11pt; font-weight:700; color:#1A202C; }
.sec-sub { font-weight:400; font-size:8.5pt; color:#718096; margin-left:8px; }
.sec-avg { font-size:8.5pt; color:#4A5568; }
.sec-avg b { color:#1A202C; font-size:10.5pt; }
table { width:100%; border-collapse:collapse; font-size:8.2pt; }
thead th { background:#E07830; color:#fff; text-transform:uppercase; letter-spacing:0.05em; font-size:7.3pt;
  padding:6px 8px; text-align:left; font-weight:700; }
tbody td { padding:5px 8px; border-bottom:1px solid #E2E8F0; vertical-align:top; }
tbody tr:nth-child(even) td { background:#FAFBFC; }
td.w { font-weight:700; color:#1A202C; }
td.p { color:#718096; }
td.q { font-weight:700; color:#4A5568; }
td.obs { color:#2D3748; }
.chip { display:inline-block; font-size:7.3pt; font-weight:700; padding:1px 7px; border-radius:999px; white-space:nowrap; }
.spont { background:#F7FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:14px 16px; margin-top:6px; }
.spont p { font-size:9pt; color:#2D3748; margin-bottom:8px; }
.spont li { font-size:8.6pt; color:#4A5568; margin:4px 0 4px 16px; }
.avoid-break { page-break-inside:avoid; }
"""

_RED, _GREEN = "#C53030", "#2F855A"


def esc(x):
    return _html.escape(str(x if x is not None else ""))


def _chip(j):
    ok = str(j).lower() == "accurate"
    c, bg = (_GREEN, "#F0FFF4") if ok else (_RED, "#FFF5F5")
    return f'<span class="chip" style="color:{c};background:{bg};border:1px solid {c}33">{esc(j)}</span>'


def _avg(rows, key="quality"):
    vals = [r.get(key) for r in rows if isinstance(r.get(key), (int, float))]
    return round(sum(vals) / len(vals)) if vals else None


def _dominant_patterns(categories):
    counts, total = {}, 0
    for c in categories or []:
        for r in c.get("rows", []):
            j = r.get("judgment")
            if not j:
                continue
            total += 1
            if j.lower() != "accurate":
                counts[j] = counts.get(j, 0) + 1
    return sorted(counts.items(), key=lambda x: -x[1]), total


def _word_table(rows):
    head = "".join(f"<th>{h}</th>" for h in ["Word", "Position", "Judgment", "Quality", "Observation"])
    body = ""
    for r in rows:
        body += (f'<tr><td class="w">{esc(r.get("word"))}</td><td class="p">{esc(r.get("position"))}</td>'
                 f'<td>{_chip(r.get("judgment"))}</td><td class="q">{esc(r.get("quality"))}</td>'
                 f'<td class="obs">{esc(r.get("observation"))}</td></tr>')
    return f'<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'


def _sent_table(rows):
    head = "".join(f"<th>{h}</th>" for h in ["Sentence", "Judgment", "Quality", "Notes"])
    body = ""
    for r in rows:
        body += (f'<tr><td class="w" style="width:34%">{esc(r.get("sentence"))}</td>'
                 f'<td>{_chip(r.get("judgment"))}</td><td class="q">{esc(r.get("quality"))}</td>'
                 f'<td class="obs">{esc(r.get("mistakes"))}</td></tr>')
    return f'<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'


def _sec_head(title, count_label, avg):
    right = f'<div class="sec-avg">Section score <b>{avg}</b>/100</div>' if avg is not None else ""
    return (f'<div class="sec-head"><div class="sec-name">{esc(title)}'
            f'<span class="sec-sub">{esc(count_label)}</span></div>{right}</div>')


_AGE_BAND = {"adult": "Adult", "senior": "Senior (55+)", "teen": "Teen (13–17)",
             "child": "Child (≤12)", "minor": "Minor"}


def _fmt_date(date_str):
    if not date_str:
        return ""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(date_str))
    if not m:
        return str(date_str)[:10]
    months = ["January", "February", "March", "April", "May", "June", "July",
              "August", "September", "October", "November", "December"]
    y, mo, d = m.groups()
    return f"{int(d)} {months[int(mo) - 1]} {y}"


def _split(categories):
    core = ext = sents = spont = None
    for c in categories or []:
        t, typ = (c.get("title") or "").lower(), c.get("type")
        if typ == "sentences":
            sents = c
        elif typ == "spontaneous":
            spont = c
        elif "extended" in t:
            ext = c
        elif core is None:
            core = c
    return core, ext, sents, spont


def build_report(name, date_str, gri, categories, result_md, out_path,
                 age_group=None, uid=None):
    core, ext, sents, spont = _split(categories)
    ranked, total = _dominant_patterns(categories)
    has_lisp = gri is not None and gri < 85 and bool(ranked)

    gri_color = _RED if has_lisp else _GREEN
    if has_lisp:
        top = " + ".join(j.lower() for j, _ in ranked[:2])
        pattern_txt = f'Consistent {("mixed " if len(ranked) > 1 else "")}<b style="display:inline">{esc(top)}</b> lisp pattern on /s/ and /z/'
    else:
        pattern_txt = 'No significant lisp pattern detected &mdash; <b style="display:inline">clear, accurate</b> /s/ and /z/ production'

    # counts line
    parts = []
    if core:
        parts.append(f"{len(core['rows'])} words")
    if ext:
        parts.append(f"{len(ext['rows'])} extended words")
    if sents:
        parts.append(f"{len(sents['rows'])} sentences")
    counts = ", ".join(parts) + " &amp; spontaneous sample analyzed"
    band = _AGE_BAND.get((age_group or "").lower(), (age_group or "").title() or "Adult")
    rid = f"{str(date_str)[:10]}_{hashlib.md5(str(uid or name).encode()).hexdigest()[:12]}"

    # mini score chips
    minis = ""
    if core is not None:
        minis += f'<div class="mini"><b>{_avg(core["rows"])}</b><span>Core /s/ &amp; /z/ &middot; {len(core["rows"])} words</span></div>'
    if sents is not None:
        minis += f'<div class="mini"><b>{_avg(sents["rows"])}</b><span>Connected speech &middot; {len(sents["rows"])} sentences</span></div>'
    if ext is not None:
        minis += f'<div class="mini"><b>{_avg(ext["rows"])}</b><span>Extended sibilants &middot; sh, ch, j</span></div>'

    logo = f'<img class="brand-logo" src="{_LOGO}"/>' if _LOGO else ""

    body = [f"""
<div class="card report-header">
  <div class="meta-row">
    <div class="brand-wrap">
      <div>{logo}
        <div class="brand-sub">Clinical protocol by board-certified speech-language pathologists</div></div>
    </div>
    <div class="rdate"><b>Assessment date</b>{esc(_fmt_date(date_str))}<br/><span style="font-size:7.5pt">Report ID {esc(rid)}</span></div>
  </div>
  <h1>Lisp Assessment Report</h1>
  <div class="subtitle">Voice pattern analysis of /s/, /z/ and extended sibilant production</div>
  <div class="patient-line">Patient: <b>{esc(name)}</b> &nbsp;&bull;&nbsp; {esc(band)} &nbsp;&bull;&nbsp; {counts}</div>
  <div class="gri-strip">
    <div class="gri-box">
      <div class="gri-num" style="color:{gri_color}">{esc(gri)}<small>/100</small></div>
      <div class="gri-label"><b>Overall GRI score</b>{pattern_txt}</div>
    </div>
    {minis}
  </div>
</div>"""]

    body.append('<div class="card"><h2>Voice Pattern Analysis</h2>')
    if core:
        body.append(_sec_head(core.get("title", "Core /s/ & /z/"), f"{len(core['rows'])} words", _avg(core["rows"])))
        body.append(_word_table(core["rows"]))
    body.append("</div>")

    if ext:
        body.append('<div class="card avoid-break">')
        body.append(_sec_head(ext.get("title", "Extended sibilants"), f"{len(ext['rows'])} words", _avg(ext["rows"])))
        body.append(_word_table(ext["rows"]) + "</div>")

    if sents:
        body.append('<div class="card avoid-break">')
        body.append(_sec_head(sents.get("title", "Connected speech"), f"{len(sents['rows'])} sentences", _avg(sents["rows"])))
        body.append(_sent_table(sents["rows"]) + "</div>")

    spont_text = _spontaneous(result_md)
    if spont_text:
        body.append(f'<div class="card avoid-break"><div class="sec-head"><div class="sec-name">Spontaneous sample'
                    f'<span class="sec-sub">qualitative</span></div></div>'
                    f'<div class="spont"><p>{esc(spont_text)}</p></div></div>')

    # The lead-facing PDF ends with the findings. (The retired tsh version
    # appended a treatment timeline, practice protocol and next-steps pitch
    # here — deliberately removed.) A clean no-lisp result still gets its
    # factual clinical impression.
    if not has_lisp:
        body.append("""
<div class="card avoid-break"><h2>Clinical Impression</h2>
  <div class="spont"><p>Sibilant production is within typical limits. No consistent lisp pattern was
  detected across single words, connected speech, or the spontaneous sample. No corrective speech
  program is clinically indicated at this time. Should specific concerns arise, a follow-up screening
  is available.</p></div></div>""")

    html = f"<!DOCTYPE html><html><head><meta charset='utf-8'><style>{_CSS}</style></head><body>{''.join(body)}</body></html>"
    if os.environ.get("REPORT_DEBUG_HTML"):
        Path(str(out_path) + ".html").write_text(html)
    HTML(string=html, base_url=str(BASE)).write_pdf(str(out_path))
    return out_path


def _spontaneous(result_md):
    if not result_md:
        return None
    m = re.search(r"##\s*Spontaneous[^\n]*\n+(.+?)(?:\n##|\Z)", result_md, re.S | re.I)
    if not m:
        return None
    txt = re.sub(r"\s+", " ", re.sub(r"[|#*`>-]", " ", m.group(1))).strip()
    return txt or None
