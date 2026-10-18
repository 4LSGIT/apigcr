'use strict';

const svc = require('../services/assistantAttachmentService');
const documents = require('../services/documentService');
const sources = require('../services/documentSourceService');

describe('YisrAI attachments and model modes', () => {
  test('maps only the two product-level modes to server-owned model ids', () => {
    expect(svc.modelForMode()).toBe('claude-opus-5');
    expect(svc.modelForMode('faster_speed')).toBe('claude-sonnet-4-6');
    expect(() => svc.modelForMode('claude-opus-5')).toThrow(/model mode/i);
  });

  test('temporary files are converted to guarded AI blocks and digest-bound claims', async () => {
    const made = await svc.preparePlan({}, { temporary: [{
      name: 'notice.pdf', media_type: 'application/pdf', data_base64: Buffer.from('pdf bytes').toString('base64'),
    }] });
    expect(made.blocks[0]).toMatchObject({ type: 'document', media_type: 'application/pdf' });
    expect(made.claims[0]).toMatchObject({ kind: 'temporary', name: 'notice.pdf', size: 9, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(svc.prepareExecution({}, made.claims, [{
      name: 'notice.pdf', media_type: 'application/pdf', data_base64: Buffer.from('changed').toString('base64'),
    }])).rejects.toMatchObject({ status: 400 });
  });

  test('existing documents are loaded by stable registry id and version-bound', async () => {
    const get = jest.spyOn(documents, 'getById').mockResolvedValue({
      id: 12, source: 'dropbox', external_id: 'id:file', name: 'order.pdf', title: 'Court order',
      ext: 'pdf', size: 4, status: 'active', rev: 'r1', content_hash: 'h1',
    });
    const provider = { download: jest.fn().mockResolvedValue({ buffer: Buffer.from('data') }) };
    const source = jest.spyOn(sources, 'get').mockReturnValue(provider);
    try {
      const made = await svc.preparePlan({}, { documentIds: [12] });
      expect(made.claims[0]).toMatchObject({ kind: 'document', id: 12, rev: 'r1', content_hash: 'h1' });
      expect(provider.download).toHaveBeenCalledWith({}, 'id:file');
      await expect(svc.prepareExecution({}, [{ ...made.claims[0], rev: 'old' }], [])).rejects.toMatchObject({ status: 409 });
    } finally { get.mockRestore(); source.mockRestore(); }
  });

  test('rejects unsupported file types and aggregate over-budget input', async () => {
    await expect(svc.preparePlan({}, { temporary: [{ name: 'x.txt', media_type: 'text/plain', data_base64: 'eA==' }] }))
      .rejects.toMatchObject({ status: 400 });
    const tooLarge = Buffer.alloc(svc.MAX_TOTAL_BYTES + 1).toString('base64');
    await expect(svc.preparePlan({}, { temporary: [{ name: 'x.pdf', media_type: 'application/pdf', data_base64: tooLarge }] }))
      .rejects.toMatchObject({ status: 413 });
  });
});
