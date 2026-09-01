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
                   "apigcr-main/ref/templates/notice_of_bankruptcy_filing.json")


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
          it — "SSN / ITIN:" with nothing after it is worse than no line.
     .blk a group with a DRIVING line (.drv). Hidden entirely when the driver
          is empty: no joint debtor means no joint-debtor block at all, not a
          block of four blank labels.

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

html, body { margin: 0; padding: 0; }

body {
  font-family: "Times New Roman", Times, serif;
  font-size: 11.5pt;
  line-height: 1.42;
  color: #111;
}

/* ── letterhead ───────────────────────────────────────────────────────── */
.head { display: flex; align-items: flex-start; justify-content: space-between; }
.head .logo { width: 190px; }
.head .logo img { width: 100%; display: block; }
.head .firm { text-align: right; font-size: 10pt; line-height: 1.35; }
.head .firm .nm { font-weight: bold; font-size: 11.5pt; }

.rule { border-bottom: 2px solid #17365d; margin: 10px 0 16px; }

/* ── court header (a LITERAL — this document is issued by the firm) ────── */
.court { text-align: center; margin-bottom: 18px; }
.court .c1 { font-variant: small-caps; font-size: 13pt; letter-spacing: .02em; }
.court .c2 { font-size: 11.5pt; }
.title {
  text-align: center; font-weight: bold; font-size: 14pt;
  letter-spacing: .04em; text-transform: uppercase; margin: 18px 0 14px;
}

/* ── caption: debtors left, case data right ───────────────────────────── */
.caption { display: flex; gap: 26px; margin-bottom: 18px; }
.caption > div { flex: 1 1 0; }
.box { border: 1px solid #999; padding: 9px 11px; }
.box h3 {
  margin: 0 0 6px; font-size: 8.5pt; font-weight: bold;
  text-transform: uppercase; letter-spacing: .07em; color: #555;
}
.nm { font-weight: bold; }
.blk + .blk { margin-top: 9px; padding-top: 8px; border-top: 1px dotted #bbb; }
.lbl { color: #555; }

p { margin: 0 0 10px; text-align: justify; }
h4 {
  margin: 16px 0 5px; font-size: 11pt;
  text-transform: uppercase; letter-spacing: .05em;
}

/* ── who to contact ───────────────────────────────────────────────────── */
.contacts { display: flex; gap: 26px; margin-top: 18px; }
.contacts > div { flex: 1 1 0; }

/* PAGE BREAKS. Found by rendering, not by reading: without these the
   trustee/attorney row split across the page boundary on a sparse notice --
   the box's top border printed at the foot of page 1 and its address lines
   continued, borderless, at the head of page 2. A contact block a creditor is
   supposed to write to must not be cut in half. Applied to the whole row so
   the two boxes travel together, and to each box so neither is ever severed.
   orphans/widows keep a single stranded line off a page of its own. */
.caption, .contacts, .box { break-inside: avoid; }
p { orphans: 2; widows: 2; }

.disclaimer {
  margin-top: 20px; padding-top: 8px; border-top: 1px solid #ccc;
  font-size: 8.5pt; color: #444; text-align: left;
}
</style>
</head>
<body>

<div class="head">
  <div class="logo"><img src="__LOGO__" alt=""></div>
  <div class="firm">
    <div class="l nm"><span>{{firm_name}}</span></div>
    <div class="l"><span>{{firm_addr1}}</span></div>
    <div class="l"><span>{{firm_addr2}}</span></div>
    <div class="l"><span>{{firm_phone}}</span></div>
  </div>
</div>

<div class="rule"></div>

<div class="court">
  <div class="c1">United States Bankruptcy Court</div>
  <div class="c2">Eastern District of Michigan</div>
</div>

<div class="title">Notice of Bankruptcy Filing</div>

<div class="caption">
  <div class="box">
    <h3>Debtor(s)</h3>

    <div class="blk">
      <div class="l drv nm"><span>{{debtor1_name}}</span></div>
      <div class="l"><span>{{debtor1_street}}</span></div>
      <div class="l"><span>{{debtor1_csz}}</span></div>
      <div class="l"><span class="lbl">SSN / ITIN:</span> <span>{{debtor1_ssn}}</span></div>
    </div>

    <div class="blk">
      <div class="l drv nm"><span>{{debtor2_name}}</span></div>
      <div class="l"><span>{{debtor2_street}}</span></div>
      <div class="l"><span>{{debtor2_csz}}</span></div>
      <div class="l"><span class="lbl">SSN / ITIN:</span> <span>{{debtor2_ssn}}</span></div>
    </div>
  </div>

  <div class="box">
    <h3>Case Information</h3>
    <div class="l"><span class="lbl">Chapter:</span> <span>{{chapter}}</span></div>
    <div class="l"><span class="lbl">Case number:</span> <span>{{docket}}</span></div>
    <div class="l"><span class="lbl">Date filed:</span> <span>{{file_date}}</span></div>
    <div class="l"><span class="lbl">Judge:</span> <span>{{judge}}</span></div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════════════
     PROSE BELOW IS A DRAFT AND MUST BE REPLACED BEFORE THIS TEMPLATE IS
     USED IN ANGER.

     G4 specified "the standard automatic-stay / clerk's-office / creditor
     paragraphs from the firm version, verbatim" and pointed at an attached
     Jotform PDF. NO PDF WAS ATTACHED to the task, so there was nothing to
     copy. What follows is descriptive, firm-voice prose written to hold the
     right shape and exercise every placeholder — it is NOT the firm's
     approved wording and has had no legal review.

     ACTION: paste the firm version's paragraphs over the four <p> blocks
     below, keeping the double-braced placeholders wherever the firm text
     names the same values, and re-save the template. Nothing else in this
     file needs to change.
     ══════════════════════════════════════════════════════════════════════ -->

<h4>Notice</h4>

<p>A petition for relief under Chapter {{chapter}} of the United States Bankruptcy
Code was filed on {{file_date}} in the United States Bankruptcy Court for the
Eastern District of Michigan on behalf of the debtor or debtors named above. The
case is docketed as {{docket}} and is assigned to the Honorable {{judge}}.</p>

<p><strong>The automatic stay is in effect.</strong> The filing of the petition
operates as a stay under 11 U.S.C. &sect; 362. Without an order of the Bankruptcy
Court, creditors and other parties may not begin or continue any action to
collect a debt that arose before the filing date, enforce a judgment, repossess
or foreclose on property, garnish wages or bank accounts, or otherwise attempt
to collect such a debt. Please direct any communication concerning a
pre-petition debt to this office rather than to the debtor or debtors.</p>

<p><strong>The Clerk's office holds the official record.</strong> The docket in
this case, including the petition, the schedules, and every order entered, is
maintained by the Clerk of the United States Bankruptcy Court for the Eastern
District of Michigan. Case information is available from the Clerk's office and
through PACER at pacer.uscourts.gov.</p>

<p><strong>Creditors.</strong> Please update your records to reflect this filing.
Notices from the Court &mdash; including the notice of the meeting of creditors
and any deadline for filing a proof of claim &mdash; are sent separately by the
Clerk's office and are not enclosed with this letter. Questions about this case
may be directed to counsel for the debtor or debtors at the address below.</p>

<div class="contacts">
  <div class="box blk">
    <h3>Trustee</h3>
    <div class="l drv nm"><span>{{trustee_name}}</span></div>
    <div class="l"><span>{{trustee_street}}</span></div>
    <div class="l"><span>{{trustee_csz}}</span></div>
    <div class="l"><span>{{trustee_phone}}</span></div>
  </div>

  <div class="box">
    <h3>Attorney for the Debtor(s)</h3>
    <div class="l nm"><span>{{attorney_name}}</span></div>
    <div class="l"><span>{{firm_name}}</span></div>
    <div class="l"><span>{{firm_addr1}}</span></div>
    <div class="l"><span>{{firm_addr2}}</span></div>
    <div class="l"><span>{{firm_phone}}</span></div>
  </div>
</div>

<div class="disclaimer">This notice is issued by counsel for the debtor or
debtors as a courtesy. It is not an official notice of the United States
Bankruptcy Court, it does not bear the seal of the Court, and it is not legal
advice to any creditor or other recipient.</div>

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
    # REQUIRED ON PURPOSE — the deliberate data-entry pressure. A notice with no
    # debtor address is not a notice; on_missing:'task' turns the gap into a
    # staff task naming the key instead of a silently incomplete document.
    entry("debtor1_street", "Debtor street",            "debtor1.address_street", required=True),
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
