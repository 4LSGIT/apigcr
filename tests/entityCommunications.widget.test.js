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
