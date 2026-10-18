'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/assistant.html'), 'utf8');
const route = fs.readFileSync(path.join(ROOT, 'routes/api.assistant.js'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

describe('Ask YisrAI UI wiring', () => {
  test('its inline script parses as JavaScript', () => {
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1]).filter((s) => s.trim());
    expect(scripts.length).toBe(1);
    expect(() => new Function(scripts[0])).not.toThrow(); // eslint-disable-line no-new-func
  });

  test('renders model/data strings only through the HTML escaper', () => {
    expect(html).toContain('${esc(m.text)}');
    expect(html).toContain('${esc(s.label)}');
    expect(html).toContain('${esc(action.label)}');
    expect(html).toContain('${esc(JSON.stringify(s.row, null, 2))}');
  });

  test('uses exact structured follow-up queries and shell-native record links', () => {
    expect(html).toContain('data-follow="${esc(s.query)}"');
    expect(html).toContain("P.addFile(label || id, 'case', String(id))");
    expect(html).toContain("P.addFile(label || id, 'client', String(id))");
    expect(html).toContain('P.showAppt(id)');
    expect(html).toContain('P.showEvent(id)');
    expect(html).toContain('P.showTask(id)');
  });

  test('shows the wand-writing animation during planning and execution', () => {
    expect(html).toContain('<h1><i class="fa-solid fa-wand-magic-sparkles"></i> Ask YisrAI</h1>');
    expect(html).toContain('class="thinking-wand"');
    expect(html).toContain('@keyframes wandWrite');
    expect(html).toContain("type: 'thinking'");
    expect(html).toContain('Searching firm records and writing your answer…');
  });

  test('runs read plans automatically and retries one safe planner repair', () => {
    expect(html).toContain('r = await executeAutomatically(r.ticket, attachmentRequest.temporary)');
    expect(html).toContain("if (r.outcome !== 'plan') return r");
    expect(html).not.toContain('Approve & run');
    expect(html).toContain('Read-only searches run automatically');
  });

  test('record actions are visible without expanding the evidence row', () => {
    expect(html).toContain('<b>Open records</b>');
    expect(html).toContain('entities: r.entities || []');
    const actionPos = html.indexOf('class="source-actions"');
    const detailPos = html.indexOf('<details><summary>View evidence row');
    expect(actionPos).toBeGreaterThan(-1);
    expect(detailPos).toBeGreaterThan(actionPos);
  });

  test('the API exposes plan and execute as separate staff-only posts', () => {
    expect(route).toMatch(/router\.post\('\/api\/assistant\/plan', jwtOrApiKey, staffOnly/);
    expect(route).toMatch(/router\.post\('\/api\/assistant\/execute', jwtOrApiKey, staffOnly/);
  });

  test('a one-shot ask URL only prefills the textarea and is scrubbed by the shell', () => {
    expect(shell).toContain("open[0] === 'tabMore' && open[1] === 'moreAssistant'");
    expect(shell).toContain("raw.length <= 2000");
    expect(shell).toContain("u.searchParams.delete('ask')");
    expect(shell).toContain('window.ycTakeAssistantDraft = function ()');
    expect(html).toContain("P.ycTakeAssistantDraft()");
    expect(html).toContain('input.value = String(draft).slice(0, 2000)');
    expect(html).not.toMatch(/if \(draft\).*ask\(\)/);
  });

  test('recent chats are user-backed and long chats get a gentle new-chat prompt', () => {
    expect(route).toMatch(/router\.get\('\/api\/assistant\/chats', jwtOrApiKey, staffOnly/);
    expect(route).toMatch(/router\.delete\('\/api\/assistant\/chats\/:id/);
    expect(html).toContain('Recent chats');
    expect(html).toContain("history.filter((m) => m.role === 'user').length < 4");
    expect(html).toContain('keep each chat about one person, matter, or task');
  });

  test('offers product-level model modes and transient or existing attachments', () => {
    expect(html).toContain('<option value="better_quality">Better quality</option>');
    expect(html).toContain('<option value="faster_speed">Faster speed</option>');
    expect(html).not.toContain('>Best quality<');
    expect(html).toContain('id="fileInput"');
    expect(html).toContain('YisraCase document');
    expect(html).toContain('temporary_attachments: attachmentRequest.temporary');
    expect(html).toContain('document_ids: attachmentRequest.documentIds');
    expect(html).toContain('Save to case');
    expect(html).toContain("'/api/documents/upload-link'");
    expect(html).toContain("'/api/documents/upload-commit'");
  });
});
