/**
 * Hooks pane — the "Generate" button by the slug box (public/automation/hooks.html).
 *
 * Generate APPENDS a random ending to whatever is typed (Fred, 2026-11-17:
 * type `quo-call-`, press it, get `quo-call-<10 random chars>`), adds a `-`
 * when the prefix has no trailing separator, fills an empty box with a bare
 * random slug, and re-rolls (never stacks) the ending on a second press.
 * The slug IS the inbound endpoint (/hooks/:slug), so the ending is a CSPRNG
 * draw (crypto.getRandomValues, not Math.random), unbiased, [a-z0-9] only.
 *
 * The generator block is lifted out of the pane's inline script (from its
 * leading comment to the next function) and run in a bare vm with only what
 * it calls supplied: `crypto`, `E` and `renderSlugPreview`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'public', 'automation', 'hooks.html'), 'utf8');

function generatorBlock() {
  const a = RAW.indexOf('  // The slug IS the inbound endpoint (/hooks/:slug)');
  const b = RAW.indexOf('  function hookCopyUrl(btn) {');
  if (a < 0 || b < 0 || b < a) throw new Error('generator block not found');
  const block = RAW.slice(a, b);
  expect(block).toMatch(/function randomSlugTail\(/);
  expect(block).toMatch(/function generateSlug\(/);
  return block;
}

function boot({ getRandomValues, value = '' } = {}) {
  const slugInput = { value };
  const els = { 'f-slug': slugInput };
  const ctx = {
    crypto: { getRandomValues: getRandomValues || ((buf) => nodeCrypto.webcrypto.getRandomValues(buf)) },
    Math: { random: () => { throw new Error('Math.random used'); } },
    E: (id) => els[id],
    previews: 0,
    renderSlugPreview() { ctx.previews++; },
    Uint8Array, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(generatorBlock() + '\nthis.randomSlugTail = randomSlugTail; this.generateSlug = generateSlug;', ctx);
  return { ctx, slugInput };
}

const TAIL = /^[a-z0-9]{10}$/;

describe('the Generate button by the slug box', () => {
  test('markup: a Generate button sits in the slug URL row before Copy, wired to window.hookGenerateSlug, which the pane exports; the input is capped at the column width', () => {
    const row = RAW.match(/<div class="hint slug-url-row">([\s\S]*?)<\/div>/)[1];
    expect(row).toMatch(/id="slug-gen-btn"/);
    expect(row).toMatch(/onclick="window\.hookGenerateSlug\(\)"/);
    expect(row.indexOf('slug-gen-btn')).toBeLessThan(row.indexOf('slug-copy-btn'));
    expect(RAW).toMatch(/window\.hookGenerateSlug\s*=\s*generateSlug;/);
    expect(RAW).toMatch(/<input id="f-slug"[^>]*maxlength="100"/);   // hooks.slug varchar(100)
    // Two fixed-width buttons in a phone-width Slug column widened the editor
    // body (375/414px, caught by a layout probe before landing): the row wraps.
    expect(RAW).toMatch(/\.fg \.hint\.slug-url-row \{[^}]*flex-wrap: wrap;/);
    expect(RAW).toMatch(/\.slug-url-row \.slug-url \{[^}]*flex: 1 1 \d+px;/);
  });

  test('randomSlugTail: 10 lowercase [a-z0-9] chars, fresh each call, from crypto.getRandomValues', () => {
    const { ctx } = boot();
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const s = ctx.randomSlugTail();
      expect(s).toMatch(TAIL);
      seen.add(s);
    }
    expect(seen.size).toBe(200);
  });

  test('randomSlugTail is unbiased: bytes ≥ 252 are rejected, not folded onto the first 4 chars', () => {
    // A buffer of 255s then one of 0s: a modulo-folding generator emits '3'
    // (255 % 36) for the 255s; the rejecting one skips them and emits only 'a'.
    let calls = 0;
    const { ctx } = boot({ getRandomValues: (buf) => { calls++; buf.fill(calls === 1 ? 255 : 0); return buf; } });
    expect(ctx.randomSlugTail()).toBe('a'.repeat(10));
    expect(calls).toBe(2);
  });

  test('empty box → a bare random slug; the URL preview is refreshed', () => {
    const { ctx, slugInput } = boot();
    ctx.generateSlug();
    expect(slugInput.value).toMatch(TAIL);
    expect(ctx.previews).toBe(1);
  });

  test('typed `quo-call-` → `quo-call-` + ending (a trailing separator is kept, not doubled)', () => {
    const { ctx, slugInput } = boot({ value: 'quo-call-' });
    ctx.generateSlug();
    expect(slugInput.value).toMatch(/^quo-call-[a-z0-9]{10}$/);
    const u = boot({ value: 'quo_call_' });
    u.ctx.generateSlug();
    expect(u.slugInput.value).toMatch(/^quo_call_[a-z0-9]{10}$/);
  });

  test('typed `quo-call` (no separator) → `quo-call-` + ending; surrounding whitespace is dropped', () => {
    const { ctx, slugInput } = boot({ value: '  quo-call ' });
    ctx.generateSlug();
    expect(slugInput.value).toMatch(/^quo-call-[a-z0-9]{10}$/);
  });

  test('pressing again re-rolls the ending on the same prefix instead of appending a second one', () => {
    const { ctx, slugInput } = boot({ value: 'quo-call-' });
    ctx.generateSlug();
    const first = slugInput.value;
    ctx.generateSlug();
    expect(slugInput.value).toMatch(/^quo-call-[a-z0-9]{10}$/);
    expect(slugInput.value).not.toBe(first);
    // ...but an edited value is a new prefix again.
    slugInput.value = slugInput.value + '-v2';
    ctx.generateSlug();
    expect(slugInput.value).toMatch(/^quo-call-[a-z0-9]{10}-v2-[a-z0-9]{10}$/);
  });
});
