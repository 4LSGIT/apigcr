/**
 * tests/contactUi.sync.test.js
 *
 * BOOTS public/contact.html for real, in jsdom, against a stub shell — with the
 * REAL public/js/yc-sync.js and public/scripts.js evaluated first, so the bus
 * under test is the shipped bus. (tests/pipelineBoardUi.sync.test.js is the
 * harness pattern; tests/ycSync.test.js is the "evaluate the real file"
 * philosophy.)
 *
 * WHY THIS FILE EXISTS
 *
 * Slice 2b adds ONE reserved field to the bus, `yc_refetch`, and the entire
 * B7 fix depends on this page answering it correctly. Three things can go
 * wrong, and all three are run-time-only:
 *
 *   · POLLUTION. `yc_refetch` is not a column. If the handler falls through to
 *     `Object.assign(entityData.contact, fields)` it lands in the page's
 *     single source of truth and then gets PUSHED INTO EVERY FORM as a field.
 *   · REDUNDANT WORK. The header spans and queueBusFormPush are both
 *     superseded by the refetch (which re-runs updateHeader and the same push
 *     loop, with the fresh aggregates the bus deliberately never carries).
 *     Doing them anyway paints twice, the first time from stale data.
 *   · §3.6 — THE LOOP. This is the first handler in the system that answers a
 *     bus message with a NETWORK CALL. If that call could itself be sniffed
 *     into an emit, the bus eats the browser. It cannot: the refetch is a GET
 *     and _sniff's method gate drops GET before any matcher runs. Cheap to
 *     assert, fatal to get wrong.
 *
 * ON LEXICAL SCOPE (load-bearing, read before editing)
 *
 * scripts.js and contact.html's inline blocks are separate <script> tags in the
 * browser, where top-level `const`/`let` share ONE global lexical environment.
 * An (indirect) `window.eval` does NOT reproduce that — per spec each eval gets
 * its own declarative environment, so `const E` from a scripts.js eval would be
 * invisible to a later contact.html eval. They are therefore concatenated into
 * a SINGLE eval, which is what actually matches browser semantics here.
 *
 *   npx jest tests/contactUi.sync.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/contact.html'), 'utf8');
const YCSYNC  = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const DOMS = [];
const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach(fn => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));

const CLIENT_ID = '1001';

function contactPayload(over = {}) {
  return {
    contact: {
      contact_id: 1001,
      contact_fname: 'Ann',
      contact_lname: 'Applebaum',
      contact_phone: '2485550001',
      contact_email: 'ann@example.com',
      ...over,
    },
    phones: [{ id: 1, phone: '2485550001', is_primary: 1 }],
    emails: [],
    addresses: [],
    cases: [],
    appts: [],
    log: [],
  };
}

/** jsdom has no layout, so document.hidden is the only visibility lever here. */
function setHidden(window, hidden) {
  Object.defineProperty(window.document, 'hidden', {
    configurable: true, get: () => hidden,
  });
}

/**
 * Boot contact.html in jsdom against a stub shell.
 *
 * @param {object}   o
 * @param {object[]} o.payloads  successive GET /api/contacts/:id bodies. The
 *   boot consumes the first; a refetch consumes the next (the last one repeats),
 *   which is how a test observes that the refetch actually re-read the server.
 */
async function boot({ payloads = [contactPayload()] } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: `https://app.4lsg.com/contact.html?clientID=${CLIENT_ID}`,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;

  // jsdom boots a document at visibilityState 'prerender', i.e.
  // document.hidden === true. A real foreground tab is 'visible'. Nothing in
  // THIS page reads document.hidden today, but the shell's tab subscribers do,
  // and the harness should not quietly model a background tab.
  setHidden(window, false);

  const calls = [];
  let payloadIx = 0;
  // The shell's transport, INCLUDING its sync-bus hook. The setTimeout is the
  // BroadcastChannel macrotask: in production the sniff runs in the SHELL's
  // realm and reaches this frame over BC, so it can never be synchronous with
  // the caller's own continuation. See pipelineBoardUi.sync.test.js's header.
  const apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    let data;
    if (/^\/api\/contacts\/\d+$/.test(url) && method === 'GET') {
      data = payloads[Math.min(payloadIx++, payloads.length - 1)];
    } else if (url === '/api/log') {
      data = { entries: [], total: 0 };
    } else if (url === '/api/contact-relations') {
      data = { relations: [] };
    } else {
      data = { status: 'success' };
    }
    window.setTimeout(() => {
      try { window.YC && window.YC._sniff(method, url, data); } catch (_) { /* noop */ }
    }, 0);
    return data;
  };

  // ── The shell, as contact.html sees it (window.parent). ──────────────────
  // jsdom's window.parent is non-configurable, but for a top-level window it IS
  // the window — so putting the shell's surface directly on `window` makes every
  // `P.x` lookup resolve exactly as it does in the real iframe (scripts.js does
  // `const P = window.parent`).
  window.apiSend  = apiSend;
  window.firmData = { users: [], phoneLines: [], emailFrom: [], settings: {},
                      currentUser: { user: 6 }, firmTimezone: 'America/Detroit' };
  window.limit    = 100;
  window.addFile  = () => {};

  // SweetAlert: scripts.js builds window.Toast from Swal.mixin at evaluation
  // time, so the stub has to exist before the eval and has to answer mixin().
  const toasts = [];
  window.Swal = {
    mixin: () => ({ fire: (o) => { toasts.push(o); } }),
    fire: async () => ({ isConfirmed: false }),
    close: () => {},
    showLoading: () => {},
    update: () => {},
    showValidationMessage: () => {},
    stopTimer: () => {},
    resumeTimer: () => {},
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  // Markup first (the inline blocks touch the DOM at top level), comments
  // stripped so a `<script>` MENTIONED in a comment can't split a block.
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML =
    noComments.replace(/<script[\s\S]*?<\/script>/g, '');

  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(inline.length).toBe(2);   // fence: a third block means this harness is stale

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

  // ONE eval — see the lexical-scope note in the header. The trailing
  // Object.assign is a test-only window onto bindings that stay `const`/`let`
  // in the shipped file; every assertion still runs against the real handlers.
  window.eval(
    [SCRIPTS, ...inline].join('\n;\n') +
    '\n;Object.assign(window, { __t: {' +
    '  entityData: () => window.entityData,' +
    '  header: () => ({ fname: E("fname").innerHTML,' +
    '                   lname: E("lname").innerHTML,' +
    '                   phone: E("phone").innerHTML }),' +
    '} });'
  );

  await tick(window, 50);
  return { window, calls, errors, toasts };
}

const contactGets = calls =>
  calls.filter(c => /^\/api\/contacts\/\d+$/.test(c.url) && c.method === 'GET');

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────

describe('contact.html boots', () => {
  test('loads the contact, paints the header, and subscribes to its own address', async () => {
    const { window, calls, errors } = await boot();
    expect(errors).toEqual([]);
    expect(contactGets(calls).length).toBe(1);
    expect(window.__t.header()).toEqual({
      fname: 'Ann', lname: 'Applebaum', phone: '248-555-0001',
    });
    expect(window.entityData.contact.contact_id).toBe(1001);
  });

  test('a normal scalar message merges and repaints — Slice 1 behaviour, unchanged', async () => {
    const { window, calls } = await boot();
    window.YC.emit(`contact:${CLIENT_ID}`, { contact_lname: { from: 'Applebaum', to: 'Baum' } }, 'test');
    await tick(window, 100);
    expect(window.entityData.contact.contact_lname).toBe('Baum');
    expect(window.__t.header().lname).toBe('Baum');
    // Merge-and-paint, NOT a refetch.
    expect(contactGets(calls).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// yc_refetch — the reserved field
// ─────────────────────────────────────────────────────────────

describe('yc_refetch handler', () => {
  test('answers with a REFETCH, and the fresh row lands in entityData', async () => {
    const { window, calls } = await boot({
      payloads: [
        contactPayload(),
        // What the donor looks like after its primary phone was transferred away:
        // the scalar mirror recomputed to null and the child row is gone.
        { ...contactPayload({ contact_phone: null }), phones: [] },
      ],
    });
    expect(contactGets(calls).length).toBe(1);

    window.YC.emit(`contact:${CLIENT_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 100);

    expect(contactGets(calls).length).toBe(2);
    expect(window.entityData.contact.contact_phone).toBe(null);
    expect(window.entityData.contact.phones).toEqual([]);
  });

  test('does NOT write yc_refetch into entityData.contact', async () => {
    // The pollution fence. `yc_refetch` is not a column; if it reaches
    // entityData it is then pushed into every YCForm as a field.
    const { window } = await boot();
    window.YC.emit(`contact:${CLIENT_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 100);
    expect('yc_refetch' in window.entityData.contact).toBe(false);
    expect(Object.keys(window.entityData.contact)).not.toContain('yc_refetch');
  });

  test('the REFETCH is what repaints the header — the latent scalar-mirror case', async () => {
    // `contacts.contact_phone` is a recomputed mirror of the primary child row,
    // so transferring away a PRIMARY phone changes a header span on the donor.
    // The handler paints nothing itself; refreshEntityData -> updateHeader does.
    const { window } = await boot({
      payloads: [
        contactPayload(),
        { ...contactPayload({ contact_phone: null }), phones: [] },
      ],
    });
    expect(window.__t.header().phone).toBe('248-555-0001');

    window.YC.emit(`contact:${CLIENT_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 100);

    expect(window.__t.header().phone).toBe('');
  });

  test('a message carrying yc_refetch ALONGSIDE real columns still only refetches', async () => {
    // Not a shape the sniff produces today (the donor entry carries yc_refetch
    // alone), but the handler must not half-merge if one ever appears: the
    // refetch strictly dominates whatever the message could have told us.
    const { window, calls } = await boot({
      payloads: [contactPayload(), contactPayload({ contact_lname: 'FromServer' })],
    });
    window.YC.emit(`contact:${CLIENT_ID}`,
                   { yc_refetch: 1, contact_lname: 'FromBus' }, 'test');
    await tick(window, 100);
    expect(contactGets(calls).length).toBe(2);
    expect(window.entityData.contact.contact_lname).toBe('FromServer');
    expect('yc_refetch' in window.entityData.contact).toBe(false);
  });

  test('§3.6 — THE REFETCH CANNOT LOOP: it is a GET, which the sniff drops', async () => {
    // One message in. The refetch is a GET; _sniff's method gate rejects GET
    // before any matcher runs, so no emit comes back out, so no second refetch.
    // If this ever fails the bus has become an infinite loop.
    const { window, calls } = await boot();
    window.YC.emit(`contact:${CLIENT_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 300);
    expect(contactGets(calls).length).toBe(2);          // boot + exactly one refetch
    expect(window.YC._log.map(m => m.addr)).toEqual([`contact:${CLIENT_ID}`]);
    // Nothing the refetch issued was a write.
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  test('the refetch goes through the push CHAIN, not around it', async () => {
    // window.ycRefreshEntity is the queued entry point; calling refreshEntityData
    // bare would race the form-saved path at YCForm.refresh's awaited onLoad.
    const { window } = await boot();
    const seen = [];
    window.ycRefreshEntity = (...a) => { seen.push(a); };
    window.YC.emit(`contact:${CLIENT_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 50);
    expect(seen.length).toBe(1);
  });

  test('a DIFFERENT contact\'s refetch message is ignored', async () => {
    const { window, calls } = await boot();
    window.YC.emit('contact:9999', { yc_refetch: 1 }, 'test');
    await tick(window, 100);
    expect(contactGets(calls).length).toBe(1);
  });

  test('a donor refetch arriving from ANOTHER WINDOW is honoured', async () => {
    // The cross-browser-tab case, which is the whole reason the transport is
    // BroadcastChannel: the transfer is saved in one window, the donor file is
    // open in another.
    const { window, calls } = await boot({
      payloads: [contactPayload(), { ...contactPayload({ contact_phone: null }), phones: [] }],
    });

    const other = new JSDOM('<!DOCTYPE html><html><body></body></html>',
                            { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    DOMS.push(other);
    TEARDOWNS.push(bcPolyfill.install(other.window));
    other.window.console.warn = () => {};
    other.window.eval(YCSYNC);

    // The writing shell's own sniff, off the real transfer response shape.
    other.window.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: {
        changes: { contact_phone: { from: null, to: '2485550001' } },
        transferred_from: [{ kind: 'phone', from_contact_id: Number(CLIENT_ID),
                             from_contact_name: 'Ann', phone: '2485550001' }],
      },
    });

    await tick(window, 100);
    expect(contactGets(calls).length).toBe(2);
    expect(window.__t.header().phone).toBe('');
  });
});
