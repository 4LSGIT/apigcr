'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'entityCommunications.html'), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function boot(items = [], { type = 'contact', id = '42', contacts = [], responder = null } = {}) {
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
      window.apiSend = apiSend;
      window.firmData = { id: 1 };
      window.entityData = { contact: { contact_id: 42 } };
    },
  });
  return { dom, apiSend };
}

describe('entity communications widget', () => {
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
