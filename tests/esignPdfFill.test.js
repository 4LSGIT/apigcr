// tests/esignPdfFill.test.js
//
// Phase 2E, slice B1 — the `text` placement field class.
//
//   1. services/esign/placements.js     — validation rules for type:'text'
//   2. services/esign/zohoSignProvider  — text fields never reach the provider
//   3. services/esign/pdfFill.js        — values drawn into the page
//
// PDF verification follows tests/esignSend.test.js's approach exactly: no
// pdf-parse (its bundled 2018 pdf.js rejects synthetic PDFs and leaks state
// across calls — see that file's header); instead, inflate every content
// stream and look for pdf-lib's hex-string text operators.

const zlib = require('zlib');

const {
  validatePlacements,
  NEUTRAL_FIELD_TYPES,
  SIGNER_FIELD_TYPES,
  TEXT_KEY_RE,
} = require('../services/esign/placements');
const { neutralToZohoFields } = require('../services/esign/zohoSignProvider');
const { fillTextFields, winAnsiSafe, MIN_SIZE } = require('../services/esign/pdfFill');

// ─── synthetic PDF (copied from tests/esignSend.test.js — see its header) ───

function buildPdf(pageCount = 1) {
  const objs = [];
  const kids = [];
  for (let i = 0; i < pageCount; i++) kids.push(`${4 + i * 2} 0 R`);

  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  for (let i = 0; i < pageCount; i++) {
    const p = 4 + i * 2;
    const c = p + 1;
    const s = `BT /F1 12 Tf 72 700 Td (Body page ${i + 1}) Tj ET`;
    objs[p] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
              `/Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`;
    objs[c] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  }

  const n = objs.length;
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let i = 1; i < n; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

function inflateAllStreams(buf) {
  let text = '';
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start);
    if (e === -1) break;
    const raw = buf.subarray(start, e);
    try { text += zlib.inflateSync(raw).toString('latin1') + '\n'; }
    catch { text += raw.toString('latin1') + '\n'; }
    i = e + 9;
  }
  return text;
}

/** pdf-lib draws text as an uppercase-hex string operator. */
function drawnHex(value) {
  return Buffer.from(value, 'latin1').toString('hex').toUpperCase();
}

function textField(over = {}) {
  return { page: 1, x: 100, y: 700, w: 200, h: 18, type: 'text', key: 'debtor_name', ...over };
}
function sigField(over = {}) {
  return { page: 1, x: 72, y: 120, w: 180, h: 24, type: 'signature', signer: 1, ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

describe('placements — text field class', () => {
  test('constants: text is neutral but not a signer type', () => {
    expect(NEUTRAL_FIELD_TYPES).toEqual([
      'signature', 'initial', 'date', 'text',
      'input_text', 'checkbox', 'dropdown', 'radio',
    ]);
    expect(SIGNER_FIELD_TYPES).toEqual([
      'signature', 'initial', 'date',
      'input_text', 'checkbox', 'dropdown', 'radio',
    ]);
    expect(SIGNER_FIELD_TYPES).not.toContain('text');
  });

  test('valid text field passes; does not join the signer set', () => {
    const out = validatePlacements({ fields: [textField(), sigField({ signer: 2 })] });
    expect(out.count).toBe(2);
    expect(out.signers).toEqual([2]); // text field contributed nothing
  });

  test('text field without a key throws ESIGN_INVALID_INPUT', () => {
    for (const key of [undefined, null, '', 42, 'has spaces', 'x'.repeat(65)]) {
      expect(() => validatePlacements({ fields: [textField({ key })] }))
        .toThrow(expect.objectContaining({ code: 'ESIGN_INVALID_INPUT' }));
    }
  });

  test('key charset matches TEXT_KEY_RE', () => {
    expect(TEXT_KEY_RE.test('debtor1.name')).toBe(true);
    expect(TEXT_KEY_RE.test('fee_total-2')).toBe(true);
    expect(TEXT_KEY_RE.test('bad key')).toBe(false);
    expect(TEXT_KEY_RE.test('{{expr}}')).toBe(false);
  });

  test('text field carrying a signer throws — filled locally, no signer exists', () => {
    expect(() => validatePlacements({ fields: [textField({ signer: 1 })] }))
      .toThrow(/cannot carry a signer/);
  });

  test('font_size must be a positive number when present', () => {
    expect(() => validatePlacements({ fields: [textField({ font_size: 0 })] })).toThrow();
    expect(() => validatePlacements({ fields: [textField({ font_size: 'big' })] })).toThrow();
    expect(validatePlacements({ fields: [textField({ font_size: 9 })] }).count).toBe(1);
  });

  test('signer fields are unchanged by the extension', () => {
    const out = validatePlacements({ fields: [sigField(), sigField({ type: 'initial', signer: 2 })] });
    expect(out).toEqual({ count: 2, signers: [1, 2] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PROVIDER FILTER
// ─────────────────────────────────────────────────────────────────────────────

describe('neutralToZohoFields — text fields never reach the provider', () => {
  test('text fields are excluded from bySigner and count', () => {
    const { bySigner, count } = neutralToZohoFields({
      fields: [textField(), sigField(), textField({ key: 'fee_total', y: 650 })],
    });
    expect(count).toBe(1);
    expect(Object.keys(bySigner)).toEqual(['1']);
    expect(bySigner[1]).toHaveLength(1);
    expect(bySigner[1][0].field_type_name).toBe('Signature');
  });

  test('an all-text placement transmits nothing', () => {
    const { bySigner, count } = neutralToZohoFields({ fields: [textField()] });
    expect(count).toBe(0);
    expect(bySigner).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. FILL
// ─────────────────────────────────────────────────────────────────────────────

describe('fillTextFields', () => {
  test('draws values into their pages; original body preserved', async () => {
    const src = buildPdf(2);
    const placements = {
      fields: [
        textField({ key: 'debtor_name', page: 1 }),
        textField({ key: 'fee_total', page: 2, y: 600 }),
        sigField(), // signer field — not this module's business
      ],
    };
    const { buffer, filled, skipped } = await fillTextFields(src, placements, {
      debtor_name: 'John Q. Debtor',
      fee_total:   '$1,500.00',
    });

    expect(filled).toBe(2);
    expect(skipped).toEqual([]);
    expect(buffer).not.toBe(src);

    const streams = inflateAllStreams(buffer);
    expect(streams).toContain(drawnHex('John Q. Debtor'));
    expect(streams).toContain(drawnHex('$1,500.00'));
    expect(streams).toContain('Body page 1'); // original content intact
    expect(streams).toContain('Body page 2');
  });

  test('no text fields → the ORIGINAL buffer back, untouched', async () => {
    const src = buildPdf(1);
    const { buffer, filled } = await fillTextFields(src, { fields: [sigField()] }, {});
    expect(filled).toBe(0);
    expect(buffer).toBe(src); // identity, not a re-save
  });

  test('missing/empty values are skipped and reported; others still fill', async () => {
    const src = buildPdf(1);
    const { buffer, filled, skipped } = await fillTextFields(
      src,
      { fields: [textField({ key: 'a' }), textField({ key: 'b', y: 650 })] },
      { a: 'present', b: '' }
    );
    expect(filled).toBe(1);
    expect(skipped).toEqual(['b']);
    expect(inflateAllStreams(buffer)).toContain(drawnHex('present'));
  });

  test('all values missing → original buffer, all keys reported', async () => {
    const src = buildPdf(1);
    const { buffer, filled, skipped } = await fillTextFields(
      src, { fields: [textField({ key: 'a' })] }, {}
    );
    expect(filled).toBe(0);
    expect(skipped).toEqual(['a']);
    expect(buffer).toBe(src);
  });

  test('field placed past the last page throws loud, not draws wrong', async () => {
    const src = buildPdf(1);
    await expect(
      fillTextFields(src, { fields: [textField({ page: 3 })] }, { debtor_name: 'x' })
    ).rejects.toMatchObject({ code: 'ESIGN_INVALID_INPUT' });
  });

  test('non-PDF input throws ESIGN_BAD_PDF', async () => {
    await expect(
      fillTextFields(Buffer.from('not a pdf'), { fields: [textField()] }, { debtor_name: 'x' })
    ).rejects.toMatchObject({ code: 'ESIGN_BAD_PDF' });
  });

  test('shrink-to-fit floors at MIN_SIZE and still draws (overflow, not truncation)', async () => {
    const src = buildPdf(1);
    const long = 'An Extremely Long Debtor Name That Cannot Possibly Fit In Forty Points';
    const { buffer, filled } = await fillTextFields(
      src, { fields: [textField({ key: 'n', w: 40 })] }, { n: long }
    );
    expect(filled).toBe(1);
    expect(inflateAllStreams(buffer)).toContain(drawnHex(long)); // whole string drawn
    expect(MIN_SIZE).toBeGreaterThan(0);
  });

  test('winAnsiSafe replaces unencodable chars instead of crashing the send', async () => {
    expect(winAnsiSafe('fiancé — “ok” …')).toBe('fiancé — “ok” …'); // WinAnsi extras survive
    expect(winAnsiSafe('日本語')).toBe('???');

    const src = buildPdf(1);
    const { filled } = await fillTextFields(
      src, { fields: [textField({ key: 'n' })] }, { n: 'José — “señor” 日本' }
    );
    expect(filled).toBe(1); // did not throw
  });
});
