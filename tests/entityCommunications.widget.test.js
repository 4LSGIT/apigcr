'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'entityCommunications.html'), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function boot(items = [], { type = 'contact', id = '42', contacts = [], responder = null, parentReady = true } = {}) {
  const apiSend = jest.fn(async (url, method, body) => {
    if (responder) {
      const answer = await responder(url, method, body);
      if (answer !== undefined) return answer;
    }
    if (/\/api\/cases\/[^/]+\/contacts$/.test(url)) return { contacts };
    return { items, next_offset: null, has_more: false };
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `https://example.test/entityCommunications.html?link_type=${type}&link_id=${id}`,
    beforeParse(window) {
      if (parentReady) window.apiSend = apiSend;
      window.firmData = { id: 1 };
      window.entityData = { contact: { contact_id: 42 } };
    },
  });
  return { dom, apiSend };
}

describe('entity communications widget', () => {
  test('boots with the waitForParent poll: no call until the host relays apiSend', async () => {
    const { dom, apiSend } = boot([], { parentReady: false });
    await settle();
    expect(apiSend).not.toHaveBeenCalled();
    expect(dom.window.document.getElementById('comms-error').hidden).toBe(true);
    dom.window.apiSend = apiSend;
    await new Promise(resolve => setTimeout(resolve, 150));
    await settle();
    expect(apiSend).toHaveBeenCalledWith('/api/contacts/42/communications', 'GET', expect.objectContaining({ offset: 0 }));
    dom.window.close();
  });

  test.each([
    ['ingested email: capitalised Message key', { Message: 'Body from the Message key', To: 'x', From: 'y' }, null, 'Body from the Message key'],
    ['composer email: body key', { body: 'Body from the body key', note: 'Logged without sending' }, null, 'Body from the body key'],
    ['no body in log_data: the log message', { To: 'x' }, 'Body from the log message', 'Body from the log message'],
  ])('a Logged-only row shows its body when expanded (%s)', async (_label, data, message, expected) => {
    const { dom } = boot([{
      key: 'log:9', id: 9, kind: 'email', direction: 'incoming', at: '2026-10-19T10:00:00Z', legacy: true,
      participant: 'sender@example.com', preview: '', log_id: 9,
      log: { type: 'email', from: 'sender@example.com', to: null, subject: 'Hello', message, data },
    }]);
    await settle(); await settle();
    const d = dom.window.document;
    expect(d.querySelector('.card .preview').textContent).toBe(expected);
    d.querySelector('.card-head').click();
    await settle(); await settle();
    expect(d.querySelector('.details .copy').textContent).toBe(expected);
    dom.window.close();
  });

  test('loads the scoped feed and renders API text as text, not markup', async () => {
    const { dom, apiSend } = boot([{
      id: 5, kind: 'sms', direction: 'incoming', at: '2026-10-19T10:00:00Z',
      participant: '<img src=x onerror=alert(1)>', preview: '<script>bad()</script>',
    }]);
    await settle();
    await settle();
    expect(apiSend).toHaveBeenCalledWith('/api/contacts/42/communications', 'GET', expect.objectContaining({ limit: 50 }));
    const card = dom.window.document.querySelector('.card.sms');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card.textContent).toContain('<script>bad()</script>');
    expect(card.querySelector('img, script')).toBeNull();
    dom.window.close();
  });

  test('a failed outbound text wears the Not delivered badge; the reason and provider code ride the tooltip (phone-delivery S3b)', async () => {
    const { dom } = boot([
      { id: 6, kind: 'sms', direction: 'outgoing', at: '2026-10-19T10:00:00Z', participant: '3135550001',
        preview: 'please call us', phone: { event_id: 6, line_number: '2485550100', body: 'please call us',
          delivery: { state: 'failed', reason: 'unreachable', code: 'SMS-CAR-411' } } },
      { id: 7, kind: 'sms', direction: 'outgoing', at: '2026-10-19T10:01:00Z', participant: '3135550001',
        preview: 'went through', phone: { event_id: 7, line_number: '2485550100', body: 'went through',
          delivery: { state: 'delivered', reason: null, code: null } } },
      { id: 8, kind: 'sms', direction: 'incoming', at: '2026-10-19T10:02:00Z', participant: '3135550001',
        preview: 'got it', phone: { event_id: 8, line_number: '2485550100', body: 'got it', delivery: null } },
    ]);
    await settle();
    await settle();
    const cards = [...dom.window.document.querySelectorAll('.card.sms')];
    expect(cards).toHaveLength(3);
    const badges = cards.map(c => c.querySelector('.badge.fail'));
    expect(badges[0]).not.toBeNull();
    expect(badges[0].textContent).toContain('Not delivered');
    expect(badges[0].title).toBe("Not delivered — this number can't receive texts (provider code SMS-CAR-411)");
    expect(badges[0].textContent).not.toContain('SMS-CAR-411');   // raw code: tooltip only
    expect(badges[1]).toBeNull();   // delivered → no badge
    expect(badges[2]).toBeNull();   // incoming / unstamped → no badge
    dom.window.close();
  });

  test('sends channel and direction filters and exposes the contact composer', async () => {
    const { dom, apiSend } = boot();
    await settle();
    const d = dom.window.document;
    d.getElementById('comms-kind').value = 'call';
    d.getElementById('comms-direction').value = 'outgoing';
    d.getElementById('comms-kind').dispatchEvent(new dom.window.Event('change'));
    await settle();
    expect(apiSend).toHaveBeenLastCalledWith('/api/contacts/42/communications', 'GET', expect.objectContaining({
      kind: 'call', direction: 'outgoing', offset: 0,
    }));
    expect(d.getElementById('comms-compose-toggle').hidden).toBe(false);
    d.getElementById('comms-compose-toggle').click();
    await settle();
    expect(d.getElementById('history-view').hidden).toBe(true);
    expect(d.getElementById('compose-view').hidden).toBe(false);
    expect(d.getElementById('legacy-compose').getAttribute('src')).toBe('/communicate.html');
    dom.window.close();
  });

  test('offers the two compound channel filters', async () => {
    const { dom } = boot();
    await settle();
    const values = [...dom.window.document.querySelectorAll('#comms-kind option')].map(x => x.value);
    expect(values).toEqual(expect.arrayContaining(['direct', 'phone']));
    dom.window.close();
  });

  test('case expansion is opt-in and case send/log requires a contact choice', async () => {
    const { dom, apiSend } = boot([], { type: 'case', id: 'C1', contacts: [
      { contact_id: 9, contact_name: 'Primary Client', relate_type: 'Primary' },
      { contact_id: 10, contact_name: 'Other Contact', relate_type: 'Other' },
    ] });
    await settle();
    const d = dom.window.document;
    expect(d.getElementById('include-contacts-wrap').hidden).toBe(false);
    expect(d.getElementById('include-contacts').checked).toBe(false);
    d.getElementById('include-contacts').checked = true;
    d.getElementById('include-contacts').dispatchEvent(new dom.window.Event('change'));
    await settle();
    expect(apiSend).toHaveBeenLastCalledWith('/api/cases/C1/communications', 'GET', expect.objectContaining({ include_contacts: 1 }));

    d.getElementById('comms-compose-toggle').click();
    await settle(); await settle();
    expect(apiSend).toHaveBeenCalledWith('/api/cases/C1/contacts', 'GET');
    expect([...d.getElementById('compose-contact').options].map(x => x.value)).toEqual(['9', '10']);
    expect(dom.window.communicationContext).toEqual({ case_id: 'C1' });
    expect(dom.window.entityData.contact.contact_id).toBe(9);
    dom.window.close();
  });

  test('expanded source email offers threaded reply, attachment download/filing, and contact case tagging', async () => {
    const item = {
      id: 5, kind: 'email', direction: 'incoming', at: '2026-10-19T10:00:00Z',
      participant: 'client@example.com', email: { id: 5, subject: 'Question', mailbox_id: 2 },
    };
    const { dom, apiSend } = boot([item], { responder: async (url, method) => {
      if (url === '/api/mail/messages/5' && method === 'GET') return { messages: [{
        id: 5, mailbox_id: 2, body_text: 'Hello', attachments: [
          { part: '2', filename: 'proof.pdf', mime: 'application/pdf', inline: false },
        ],
      }] };
      if (url === '/api/contacts/42/cases') return { cases: [{ case_id: 'C1', case_number: '24-1' }] };
      if (url === '/api/mail/messages/5/reply') return {
        mailbox_id: 2, to: [{ email: 'client@example.com', name: null }], cc: [], subject: 'Re: Question',
      };
      if (url === '/api/mail/send' && method === 'POST') return { status: 'success' };
      return undefined;
    } });
    await settle(); await settle();
    dom.window.document.querySelector('.card-head').click();
    await settle(); await settle(); await settle();
    const details = dom.window.document.querySelector('.details');
    expect(details.textContent).toContain('proof.pdf');
    expect(details.textContent).toContain('Add to Documents');
    const reply = [...details.querySelectorAll('button')].find(x => /Reply/.test(x.textContent));
    reply.click();
    await settle(); await settle();
    const textarea = details.querySelector('.reply-box textarea');
    textarea.value = 'Answer';
    [...details.querySelectorAll('.reply-box button')].find(x => x.textContent === 'Send').click();
    await settle();
    expect(apiSend).toHaveBeenCalledWith('/api/mail/send', 'POST', expect.objectContaining({
      mailbox_id: 2, in_reply_to_message_fk: 5, body_text: 'Answer',
    }));
    expect(details.textContent).toContain('Add case tag');
    dom.window.close();
  });
});

// ── Comms archive on call cards (entity-comms UI slice) ────────────────────
describe('entity communications call archive', () => {
  const call = (over = {}, phoneOver = {}) => ({
    id: 12, kind: 'call', direction: 'outgoing', at: '2026-10-23T22:14:00Z',
    participant: '3132130895', preview: 'Call connected · 70s', call_status: 'Call connected',
    duration_s: 70, line_id: 3,
    phone: { event_id: 12, line_id: 3, line_number: '2485592400', body: null, duration_s: 70, status: 'Call connected', missed: false, delivery: null, ...phoneOver },
    ...over,
  });

  test('a call with no subject is labelled a phone call with its length — never "Email"', async () => {
    const { dom } = boot([call()]);
    await settle(); await settle();
    const subject = dom.window.document.querySelector('.card.call .subject');
    expect(subject.textContent).toBe('Phone call · 1:10');
    expect(subject.textContent).not.toContain('Email');
    dom.window.close();
  });

  test('a missed incoming call says so, and a legacy call log is still a phone call', async () => {
    const { dom } = boot([
      call({ id: 13, direction: 'incoming', duration_s: null }, { duration_s: null, status: 'no-answer', missed: true }),
      { key: 'log:14', id: 14, kind: 'call', direction: 'outgoing', at: '2026-10-19T10:00:00Z', legacy: true,
        participant: '3135550001', preview: '', log_id: 14, log: { type: 'call', from: null, to: '3135550001', subject: null, message: 'left word', data: {} } },
    ]);
    await settle(); await settle();
    const subjects = [...dom.window.document.querySelectorAll('.card.call .subject')].map(x => x.textContent);
    expect(subjects).toContain('Missed call');
    expect(subjects).toContain('Phone call');
    dom.window.close();
  });

  test('an archived call previews its AI summary, and expanding offers summary + label, Listen and Transcript', async () => {
    const item = call({ archive: {
      media_id: 7815, has_audio: true, has_transcript: true,
      summary_text: 'Stuart called the client about the hearing.', summary_model: 'claude-haiku-5-5', restricted: false, extra: [],
    } });
    const minted = [];
    const { dom } = boot([item], { responder: async (url) => {
      if (url.startsWith('/api/comms-archive/media/7815/url')) { minted.push(url); return { url: 'https://storage.googleapis.com/x/y?sig=1', mime: 'audio/mpeg', inline: true, expires_in: 300 }; }
      if (url === '/api/comms-archive/media/7815/transcript') return {
        label: 'AI transcript — may contain mistakes',
        segments: [{ s: 'A', a: 0, b: 3, t: '<b>Hello</b> this is Stuart' }, { s: 'B', a: 3.2, b: 6, t: 'Hi.' }],
      };
      return undefined;
    } });
    await settle(); await settle();
    const d = dom.window.document;
    const preview = d.querySelector('.card.call .preview');
    expect(preview.textContent).toBe('AI summary: Stuart called the client about the hearing.');  // R8: the collapsed row says it is AI
    expect(preview.title).toBe('AI-generated — check the recording before relying on it');
    d.querySelector('.card-head').click();
    await settle(); await settle();
    const details = d.querySelector('.details');
    expect(details.querySelector('.summary').textContent).toContain('Stuart called the client about the hearing.');
    expect(details.querySelector('.summary .ai-note').textContent).toContain('AI-generated');
    const listen = [...details.querySelectorAll('button')].find(x => /Listen/.test(x.textContent));
    const tx = [...details.querySelectorAll('button')].find(x => /Transcript/.test(x.textContent));
    expect(listen).toBeTruthy();
    expect(tx).toBeTruthy();
    listen.click();
    await settle(); await settle();
    expect(minted.length).toBe(1);
    const audio = details.querySelector('.media-slot audio');
    expect(audio).not.toBeNull();
    expect(audio.getAttribute('src')).toBe('https://storage.googleapis.com/x/y?sig=1');
    tx.click();
    await settle(); await settle();
    const block = details.querySelector('.tx-block');
    expect(block).not.toBeNull();
    expect(block.querySelector('.ai-note').textContent).toBe('AI transcript — may contain mistakes');
    expect(block.textContent).toContain('<b>Hello</b> this is Stuart');  // vendor text stays text
    expect(block.querySelector('b')).toBeNull();
    expect(block.textContent).toContain('Speaker A');
    tx.click();
    await settle();
    expect(details.querySelector('.tx-block')).toBeNull();
    dom.window.close();
  });

  test('a signed URL off storage.googleapis.com is refused: the audio never gets a src', async () => {
    const item = call({ archive: { media_id: 7815, has_audio: true, has_transcript: false, restricted: false, extra: [] } });
    const { dom } = boot([item], { responder: async (url) => {
      if (url.startsWith('/api/comms-archive/media/7815/url')) return { url: 'https://evil.example/x.mp3' };
      return undefined;
    } });
    await settle(); await settle();
    const d = dom.window.document;
    d.querySelector('.card-head').click();
    await settle(); await settle();
    const listen = [...d.querySelectorAll('.details button')].find(x => /Listen/.test(x.textContent));
    listen.click();
    await settle(); await settle();
    expect(d.querySelector('.media-slot audio')).toBeNull();
    const slot = d.querySelector('.media-slot');
    expect(slot.hidden).toBe(false);
    expect(slot.textContent).toContain('Unexpected archive link');   // the error is visible, not a tooltip
    dom.window.close();
  });

  test('a failed mint shows a visible note and the next click mints again', async () => {
    const item = call({ archive: { media_id: 7815, has_audio: true, has_transcript: false, restricted: false, extra: [] } });
    let mints = 0;
    const { dom } = boot([item], { responder: async (url) => {
      if (url.startsWith('/api/comms-archive/media/7815/url')) {
        mints++;
        if (mints === 1 || mints === 3) throw new Error('mint refused');
        return { url: `https://storage.googleapis.com/x/y?sig=${mints}` };
      }
      return undefined;
    } });
    await settle(); await settle();
    const d = dom.window.document;
    d.querySelector('.card-head').click();
    await settle(); await settle();
    const listen = [...d.querySelectorAll('.details button')].find(x => /Listen/.test(x.textContent));
    listen.click();
    await settle(); await settle();
    expect(mints).toBe(1);
    expect(d.querySelector('.media-slot .archive-err').textContent).toContain('mint refused');
    listen.click();
    await settle(); await settle();
    expect(mints).toBe(2);   // no src stuck: the retry minted afresh
    const audio = d.querySelector('.media-slot audio');
    expect(audio.getAttribute('src')).toBe('https://storage.googleapis.com/x/y?sig=2');
    expect(d.querySelector('.media-slot .archive-err')).toBeNull();  // the success cleared the note

    // The URL expires mid-life and the renew is refused (S1): the dead src is
    // cleared — the NEXT click mints again instead of re-attaching a dead player.
    audio.dispatchEvent(new dom.window.Event('error'));
    await settle(); await settle();
    expect(mints).toBe(3);                                  // the renew was attempted (and refused)
    expect(audio.getAttribute('src')).toBeNull();           // and the dead src did not stick
    expect(d.querySelector('.media-slot .archive-err').textContent).toContain('press Listen');
    listen.click();
    await settle(); await settle();
    expect(mints).toBe(4);
    expect(audio.getAttribute('src')).toBe('https://storage.googleapis.com/x/y?sig=4');
    dom.window.close();
  });

  test('a second failure after a successful renew clears the dead src, and playback clears a stale note', async () => {
    const item = call({ archive: { media_id: 7815, has_audio: true, has_transcript: false, restricted: false, extra: [] } });
    let mints = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { dom } = boot([item], { responder: async (url) => {
      if (url.startsWith('/api/comms-archive/media/7815/url')) {
        mints++;
        if (mints === 2) await gate;   // a renew still in flight
        return { url: `https://storage.googleapis.com/x/y?sig=${mints}` };
      }
      return undefined;
    } });
    await settle(); await settle();
    const d = dom.window.document;
    d.querySelector('.card-head').click();
    await settle(); await settle();
    const listen = [...d.querySelectorAll('.details button')].find(x => /Listen/.test(x.textContent));
    listen.click();
    await settle(); await settle();
    const audio = d.querySelector('.media-slot audio');
    expect(audio.getAttribute('src')).toBe('https://storage.googleapis.com/x/y?sig=1');

    audio.dispatchEvent(new dom.window.Event('error'));   // expiry → renew starts (held open)
    await settle();
    audio.dispatchEvent(new dom.window.Event('error'));   // second failure while renewed
    await settle(); await settle();
    expect(audio.getAttribute('src')).toBeNull();         // the dead src never sticks
    const note = d.querySelector('.media-slot .archive-err');
    expect(note.textContent).toContain('press Listen');

    release();                                            // the in-flight renew wins after all
    await settle(); await settle();
    expect(audio.getAttribute('src')).toBe('https://storage.googleapis.com/x/y?sig=2');
    expect(d.querySelector('.media-slot .archive-err')).not.toBeNull();  // the note is stale now…
    audio.dispatchEvent(new dom.window.Event('playing'));
    expect(d.querySelector('.media-slot .archive-err')).toBeNull();      // …and playback clears it
    dom.window.close();
  });

  test('transcript-status notes use the Comms→Phone wording for every state', async () => {
    const mk = (id, mediaId, transcript_status) => call({ id, archive: { media_id: mediaId, has_audio: true, has_transcript: false, transcript_status, restricted: false, extra: [] } });
    const { dom } = boot([
      mk(21, 801, { state: 'in_progress', reason: null }),
      mk(22, 802, { state: 'failed', reason: null }),
      mk(23, 803, { state: 'skipped', reason: 'over_cap' }),
      mk(24, 804, { state: 'skipped', reason: null }),
    ]);
    await settle(); await settle();
    const d = dom.window.document;
    for (const head of d.querySelectorAll('.card-head')) head.click();
    await settle(); await settle();
    const notes = [...d.querySelectorAll('.details .archive-note')].map(x => x.textContent);
    expect(notes).toContain('Transcript in progress — check back soon');
    expect(notes).toContain('Transcription failed');
    expect(notes).toContain('Not transcribed — too long');
    expect(notes).toContain('Not transcribed');
    dom.window.close();
  });

  test('a transcript answer without a label still gets the R8 label; a failed fetch is a visible error; double-click fetches once', async () => {
    const item = call({ archive: { media_id: 7815, has_audio: false, has_transcript: true, restricted: false, extra: [] } });
    let calls = 0;
    const { dom } = boot([item], { responder: async (url) => {
      if (url === '/api/comms-archive/media/7815/transcript') {
        calls++;
        if (calls === 1) throw new Error('No transcript for this item yet');
        return { segments: [{ s: 'A', a: 0, b: 2, t: 'Hello.' }] };   // no label field
      }
      return undefined;
    } });
    await settle(); await settle();
    const d = dom.window.document;
    d.querySelector('.card-head').click();
    await settle(); await settle();
    const tx = [...d.querySelectorAll('.details button')].find(x => /Transcript/.test(x.textContent));
    tx.click();
    await settle(); await settle();
    expect(calls).toBe(1);
    expect(d.querySelector('.details .archive-err').textContent).toContain('No transcript for this item yet');
    tx.click(); tx.click();   // the second synchronous click lands on a disabled button
    await settle(); await settle();
    expect(calls).toBe(2);
    expect(d.querySelector('.details .archive-err')).toBeNull();      // the success cleared the error
    expect(d.querySelector('.details .tx-block .ai-note').textContent)
      .toBe('AI-generated — check the recording before relying on it');
    dom.window.close();
  });

  test('a recording transcript and a voicemail transcript open independently on one call', async () => {
    const item = call({
      archive: { media_id: 7815, has_audio: false, has_transcript: true, restricted: false, extra: [] },
      voicemail: { media_id: 901, provider: 'quo', has_audio: false, has_transcript: true, restricted: false },
    });
    const { dom } = boot([item], { responder: async (url) => {
      if (url === '/api/comms-archive/media/7815/transcript') return { segments: [{ s: 'A', a: 0, b: 2, t: 'recording words' }] };
      if (url === '/api/comms-archive/media/901/transcript') return { segments: [{ s: 'A', a: 0, b: 2, t: 'voicemail words' }] };
      return undefined;
    } });
    await settle(); await settle();
    const d = dom.window.document;
    d.querySelector('.card-head').click();
    await settle(); await settle();
    const buttons = [...d.querySelectorAll('.details button')].filter(x => /Transcript/.test(x.textContent));
    expect(buttons).toHaveLength(2);
    buttons[0].click(); await settle(); await settle();
    buttons[1].click(); await settle(); await settle();
    const blocks = [...d.querySelectorAll('.details .tx-block')].map(x => x.textContent);
    expect(blocks).toHaveLength(2);
    expect(blocks.some(t => t.includes('recording words'))).toBe(true);
    expect(blocks.some(t => t.includes('voicemail words'))).toBe(true);
    buttons[0].click(); await settle();   // closing one leaves the other
    const left = [...d.querySelectorAll('.details .tx-block')].map(x => x.textContent);
    expect(left).toHaveLength(1);
    expect(left[0]).toContain('voicemail words');
    dom.window.close();
  });

  test('a voicemail on a missed call: labelled on the card, its row and summary in the details, transcript-status note shown', async () => {
    const item = call({
      id: 15, direction: 'incoming', duration_s: null,
      archive: { media_id: 900, has_audio: true, has_transcript: false, transcript_status: { state: 'skipped', reason: 'short', est_s: 12 }, restricted: false, extra: [] },
      voicemail: { media_id: 901, provider: 'quo', has_audio: true, has_transcript: true, summary_text: 'Left a message about documents.', restricted: false },
    }, { duration_s: null, status: 'no-answer', missed: true });
    const { dom } = boot([item]);
    await settle(); await settle();
    const d = dom.window.document;
    expect(d.querySelector('.card.call .subject').textContent).toBe('Missed call · voicemail');
    d.querySelector('.card-head').click();
    await settle(); await settle();
    const details = d.querySelector('.details');
    expect(details.querySelector('.vm-chip').textContent).toContain('Voicemail');
    expect(details.textContent).toContain('Left a message about documents.');
    expect(details.textContent).toContain('Not transcribed — too short (about 12 s)');
    expect(details.querySelector('.summary .ai-note')).not.toBeNull();
    dom.window.close();
  });

  test('the Status meta row is a call thing — an expanded text does not grow one', async () => {
    const { dom } = boot([
      { id: 31, kind: 'sms', direction: 'incoming', at: '2026-10-19T10:00:00Z', participant: '3135550001',
        preview: 'got it', phone: { event_id: 31, line_number: '2485550100', body: 'got it', status: 'delivered', delivery: null } },
      call({ id: 32 }),
    ]);
    await settle(); await settle();
    const d = dom.window.document;
    for (const head of d.querySelectorAll('.card-head')) head.click();
    await settle(); await settle();
    const metaOf = (sel) => d.querySelector(`${sel} .details .meta`).textContent;
    expect(metaOf('.card.sms')).not.toContain('Status:');
    expect(metaOf('.card.call')).toContain('Status: Call connected');
    dom.window.close();
  });

  test('a purged recording is a tombstone, not buttons', async () => {
    const item = call({ archive: { media_id: 7815, purged: { at: '2026-10-20T10:00:00Z', by: 'Stuart', reason: 'client ask' } } });
    const { dom } = boot([item]);
    await settle(); await settle();
    const d = dom.window.document;
    d.querySelector('.card-head').click();
    await settle(); await settle();
    const details = d.querySelector('.details');
    expect(details.querySelector('.tombstone').textContent).toContain('Recording purged');
    expect(details.querySelector('.tombstone').textContent).toContain('client ask');
    expect([...details.querySelectorAll('button')].find(x => /Listen/.test(x.textContent))).toBeUndefined();
    dom.window.close();
  });

  test('the toolbar keeps Refresh and Send / log together in their own group beside Search', async () => {
    const { dom } = boot();
    await settle();
    const d = dom.window.document;
    const actions = d.querySelector('.topbar .bar-actions');
    expect(actions).not.toBeNull();
    expect(actions.querySelector('#comms-refresh')).not.toBeNull();
    expect(actions.querySelector('#comms-compose-toggle')).not.toBeNull();
    expect(d.querySelector('.toolbar #comms-compose-toggle')).toBeNull();
    dom.window.close();
  });
});
