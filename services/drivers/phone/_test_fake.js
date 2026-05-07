/**
 * Test Fake Phone Driver — no-op
 *
 * For end-to-end harness verification of the v2 driver layer. Performs
 * NO HTTP calls and NO DB writes (specifically does NOT insert into
 * rc_messages_log). Logging is a real-driver concern, out of scope for
 * the harness.
 *
 * The leading underscore in the filename marks this as a test fixture,
 * not a production driver. See ./\_interface.md.
 */

module.exports = {
  id: '_test_fake',
  displayName: 'Test Fake (no-op)',
  configSchema: {},
  credentialTypeWhitelist: ['internal'],

  async sendSms(ctx, opts) {
    return {
      provider_message_id: 'fake-' + Date.now(),
      raw: {
        to: opts.to,
        message: opts.message,
        ts: new Date().toISOString(),
      },
    };
  },

  async sendMms(ctx, opts) {
    return {
      provider_message_id: 'fake-' + Date.now(),
      raw: {
        to: opts.to,
        text: opts.text,
        attachment_url: opts.attachment_url,
        ts: new Date().toISOString(),
      },
    };
  },
};