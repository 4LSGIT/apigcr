#!/usr/bin/env python3
"""
Assemble ref/templates/notice_of_bankruptcy_filing.json.

Not part of the repo — a one-shot authoring aid. The JSON it emits IS the
deliverable; re-run this only if the logo or the body changes.

WHY THE LOGO IS A data: URI AND NOT AN <img src> TO THE SETTING
  services/pdfRenderService.js aborts EVERY request that is not data:/about:
  and throws ESIGN_RENDER_EXTERNAL_REF listing the blocked urls. Template #4
  ("Preview Smoke Template - external url image") is the demonstration of that
  FAILURE, not a precedent for it working. services/esignInlineImageService.js
  exists precisely to turn an external image into a data URI at AUTHORING time
  so the render stays offline forever after — this script does by hand what
  that endpoint does from templateAdmin.
"""
import base64
import io
import json
import os
import urllib.request

from PIL import Image

LOGO_URL = "https://iili.io/Jy2nXHv.md.png"   # = app_settings['fe-firm_logo_url'], read live 2026-09-01
OUT = os.path.join(os.path.dirname(__file__),
                   "notice_of_bankruptcy_filing.json")


def logo_data_uri() -> str:
    """Fetch, trim transparent margin, downscale, quantize, base64."""
    raw = urllib.request.urlopen(LOGO_URL, timeout=20).read()
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    im = im.crop(im.getbbox())            # 500x350 -> 484x338 (transparent border)
    im.thumbnail((440, 440), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.FASTOCTREE)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    b = buf.getvalue()
    print(f"  logo: {len(raw)} raw -> {len(b)} png -> {len(base64.b64encode(b))} b64")
    return "data:image/png;base64," + base64.b64encode(b).decode("ascii")

BODY_TEMPLATE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
/* ──────────────────────────────────────────────────────────────────────────
   LAYOUT LIVES IN THE TEMPLATE.

   esignPrefillService hands back PIECES, never pre-joined blocks, because
   templateRenderService.interpolateTemplate HTML-ESCAPES every value: a
   '<br>' inside a value renders as literal '&lt;br&gt;'. So every value gets
   its own element here, and the two rules below collapse the ones that
   resolved to ''.

     .l   a line. Hidden when its <span> is empty, which takes the LABEL with
          it. The firm's own Jotform version printed "SSN / ITIN: xxx-xx-"
          with nothing after it whenever the SSN was missing — that orphan is
          the exact failure this rule exists to prevent.
     .blk a group with a DRIVING line (.drv). Hidden entirely when the driver
          is empty: no joint debtor means no joint-debtor block, and no
          appointed trustee means the trustee column AND its caption both go,
          rather than a heading over four blank lines.

   :empty matches an element with NO children INCLUDING TEXT NODES, so a
   single space inside a span defeats it. A placeholder must therefore sit
   flush against its span tags, with no whitespace on either side. Every one
   below does.

   (This comment deliberately does not SPELL a placeholder: extractPlaceholders
   is a plain regex over the whole body and does not know what a comment is,
   so a double-braced example in prose is an undeclared placeholder and the
   save 400s. Learned the hard way, 2026-09-01.)

   :has() has shipped in chromium since 105; this container is far newer.
   ────────────────────────────────────────────────────────────────────────── */
.l:has(> span:empty) { display: none; }
.blk:has(> .drv > span:empty) { display: none; }

/* ──────────────────────────────────────────────────────────────────────────
   ONE PAGE IS A REQUIREMENT, NOT A PREFERENCE (Fred, G4.1).

   Every size below is chosen against the WORST CASE — a joint Chapter 13
   with two debtors, two SSNs, a full trustee block and a two-line firm
   address — because that is the longest this document can get. Measured at
   Letter with pdfRenderService's 0.75in margins: 7.0in x 9.5in of content.

   If you make the type bigger or the leading looser, re-render the joint
   fixture and count the pages. A second page here is not a cosmetic problem:
   the closing disclaimer and the clerk's address would land alone on it.
   ────────────────────────────────────────────────────────────────────────── */
html, body { margin: 0; padding: 0; }

body {
  font-family: "Times New Roman", Times, serif;
  font-size: 10.5pt;
  line-height: 1.34;
  color: #111;
}

/* ── letterhead ───────────────────────────────────────────────────────── */
.head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.head .logo { width: 165px; flex: none; }
.head .logo img { width: 100%; display: block; }
.head h1 {
  margin: 0; text-align: right; font-size: 19pt; font-weight: bold;
  line-height: 1.12; letter-spacing: .01em; text-transform: uppercase;
}

/* ── court header (a LITERAL — this document is issued by the firm) ────── */
.court {
  text-align: center; margin: 14px 0 16px;
  font-size: 13pt; font-weight: bold; line-height: 1.25;
}

h2 { margin: 0 0 6px; font-size: 10.5pt; font-weight: bold; }

p { margin: 0 0 9px; }

/* ── debtors ──────────────────────────────────────────────────────────── */
.dbt + .dbt { margin-top: 8px; }
.nm { font-weight: bold; }

/* ── attorney | trustee ───────────────────────────────────────────────── */
.cols { display: flex; gap: 30px; margin: 14px 0; }
.cols > div { flex: 1 1 0; }
.cap { margin-bottom: 7px; }

.assign { margin: 0 0 10px; }

.disclaimer {
  margin-top: 14px; padding-top: 7px; border-top: 1px solid #ccc;
  font-size: 8pt; color: #444; line-height: 1.3;
}

/* PAGE BREAKS. Belt to the one-page braces above: if a future edit ever does
   overflow, these keep a block from being severed mid-way rather than letting
   a contact block a creditor writes to print half on each page. */
.cols, .cols > div, .dbt { break-inside: avoid; }
p { orphans: 2; widows: 2; }
</style>
</head>
<body>

<div class="head">
  <div class="logo"><img src="__LOGO__" alt=""></div>
  <h1>Notice of<br>Bankruptcy Filing</h1>
</div>

<div class="court">
  United States Bankruptcy Court<br>
  Eastern District of Michigan
</div>

<h2>Notice from {{firm_name}}</h2>

<p>Please take note that a bankruptcy case concerning the debtor(s) listed below
was filed under Chapter {{chapter}} of the United States Bankruptcy Code, on
{{file_date}}.</p>

<div class="dbt blk">
  <div class="l drv nm"><span>{{debtor1_name}}</span></div>
  <div class="l"><span>{{debtor1_street}}</span></div>
  <div class="l"><span>{{debtor1_csz}}</span></div>
  <div class="l">SSN / ITIN: <span>{{debtor1_ssn}}</span></div>
</div>

<div class="dbt blk">
  <div class="l drv nm"><span>{{debtor2_name}}</span></div>
  <div class="l"><span>{{debtor2_street}}</span></div>
  <div class="l"><span>{{debtor2_csz}}</span></div>
  <div class="l">SSN / ITIN: <span>{{debtor2_ssn}}</span></div>
</div>

<div class="cols">
  <div>
    <div class="cap">The case was filed by the debtor's attorney:</div>
    <div class="l nm"><span>{{attorney_name}}</span></div>
    <div class="l"><span>{{firm_name}}</span></div>
    <div class="l"><span>{{firm_addr1}}</span></div>
    <div class="l"><span>{{firm_addr2}}</span></div>
    <div class="l"><span>{{firm_phone}}</span></div>
  </div>

  <div class="blk">
    <div class="cap">The bankruptcy trustee is:</div>
    <div class="l drv nm"><span>{{trustee_name}}</span></div>
    <div class="l"><span>{{trustee_street}}</span></div>
    <div class="l"><span>{{trustee_csz}}</span></div>
    <div class="l"><span>{{trustee_phone}}</span></div>
  </div>
</div>

<p class="assign">The case was assigned case number {{docket}} to Judge {{judge}}.</p>

<p>In most instances, the filing of the bankruptcy case automatically stays
certain collection and other actions against the debtor and the debtor's
property. Under certain circumstances, the stay may be limited to 30 days or not
exist at all, although the debtor can request the court to extend or impose a
stay. If you attempt to collect a debt or take other action in violation of the
Bankruptcy Code, you may be penalized. Consult a lawyer to determine your rights
in this case.</p>

<p>If you would like to view the bankruptcy petition and other documents filed by
the debtor, they are available at http://www.mieb.uscourts.gov or at the
Bankruptcy Court Clerk's Office, 211 West Fort Street, Detroit, MI 48226.</p>

<p>You may be a creditor of the debtor. If so, you will receive an additional
notice from the court setting forth important deadlines.</p>

<div class="disclaimer">This notice is provided by {{firm_name}} as a courtesy.
It is not an official notice of the United States Bankruptcy Court, it does not
bear the seal of the Court, and it is not legal advice to any creditor or other
recipient.</div>

</body>
</html>
"""


def entry(key, label, resolver, required=False, typ="text"):
    # The exact shape validateTemplateInput normalizes to. `default` is spelled
    # explicitly rather than omitted so the file reads the same as the stored row.
    return {
        "key": key,
        "label": label,
        "type": typ,
        "resolver": resolver,
        "default": None,
        "required": required,
    }


SCHEMA = [
    entry("chapter",        "Chapter",                  "case.chapter",           required=True),
    entry("file_date",      "Date filed",               "case.file_date",         required=True, typ="date"),
    entry("docket",         "Case number",              "case.docket",            required=True),
    entry("judge",          "Judge",                    "case.judge",             required=True),

    entry("debtor1_name",   "Debtor name",              "debtor1.name",           required=True),
    # OPTIONAL, reversed 2026-09-01 (G4.2). It was required as deliberate
    # data-entry pressure; the cost of that turned out to be the wrong thing to
    # pay. This notice exists to tell the client the automatic stay is in
    # effect so they can put it in front of a creditor — withholding it over a
    # blank street line means more days of collection calls, and the client
    # already knows their own address. The line is on the page for the
    # CREDITOR's benefit.
    #
    # The blank collapses cleanly (the .l:has() rule), so the document is still
    # correct, and the workflow's pre-check still raises a staff task naming the
    # gap. Data pressure without holding the stay notice hostage.
    entry("debtor1_street", "Debtor street",            "debtor1.address_street"),
    entry("debtor1_csz",    "Debtor city/state/zip",    "debtor1.address_csz"),
    entry("debtor1_ssn",    "Debtor SSN (masked)",      "debtor1.ssn_masked"),

    entry("debtor2_name",   "Joint debtor name",        "debtor2.name"),
    entry("debtor2_street", "Joint debtor street",      "debtor2.address_street"),
    entry("debtor2_csz",    "Joint debtor city/state/zip", "debtor2.address_csz"),
    entry("debtor2_ssn",    "Joint debtor SSN (masked)", "debtor2.ssn_masked"),

    entry("attorney_name",  "Attorney name",            "attorney.name"),
    entry("firm_name",      "Firm name",                "firm.name"),
    entry("firm_addr1",     "Firm address line 1",      "firm.address_line1"),
    entry("firm_addr2",     "Firm address line 2",      "firm.address_line2"),
    entry("firm_phone",     "Firm phone",               "firm.phone"),

    entry("trustee_name",   "Trustee name",             "trustee.name"),
    entry("trustee_street", "Trustee street",           "trustee.address_street"),
    entry("trustee_csz",    "Trustee city/state/zip",   "trustee.address_csz"),
    entry("trustee_phone",  "Trustee phone",            "trustee.phone"),
]

payload = {
    "name": "Notice of Bankruptcy Filing",
    # esignSendService.KINDS is the static product list and legalKinds() is the
    # UNION of it with the kinds carried by ACTIVE templates, so a template may
    # define a new kind with no code change. This is a generate-only document,
    # so none of the four retainer/schedules kinds fit.
    "kind": "notice_of_filing",
    "template_type": "html",
    # 'generate' and NOT 'both': documentGenerateService accepts generate|both
    # and esignSendService refuses generate. Nobody signs a notice, and a
    # template visible in the signature picker is a template somebody will
    # eventually send for signature by accident.
    "purpose": "generate",
    "file_subfolder": "Generated Documents",
    "body": None,          # filled below
    "prefill_schema": SCHEMA,
}

print("building notice_of_bankruptcy_filing.json")
payload["body"] = BODY_TEMPLATE.replace("__LOGO__", logo_data_uri())

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2, ensure_ascii=False)
    fh.write("\n")

print(f"  wrote {OUT} ({os.path.getsize(OUT)} bytes)")
