// lib/internal_functions/video.js
//
/**
 * YisraVideo functions.
 *
 * CTA: DENIED (services/ctaService.js CTA_FN_DENYLIST). A public link has no
 * use for a read, and this one returns a client's watch history.
 */
const fns = {};

/**
 * video_watch_status
 * Has this contact watched this video? For a workflow to branch on. Workflow
 * only: a sequence runs a function but can't read what it returns, so a guard
 * built on this would look right and stop nothing. An unknown video throws: a
 * typo must fail the step, not read as "they didn't watch".
 *
 * The slug is tried first, because a slug can be all digits: "341" as a slug
 * must never answer for video id 341.
 *
 * Excluded views and automated opens don't count. Views from before an
 * analytics reset do: the reset is about the dashboard, and they still watched.
 * A ?c= view counts too, since older views can't be told apart. The worst a
 * typed link can do here is skip a reminder.
 */
fns.video_watch_status = async (params, db) => {
  const { contact_id, video } = params;
  const contactId = Number(contact_id);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    throw new Error('video_watch_status requires a numeric contact_id');
  }
  if (video === undefined || video === null || video === '') {
    throw new Error('video_watch_status requires video (an id or a slug)');
  }

  const videoService = require('../../services/videoService'); // lazy require (convention)
  const found = await videoService.getVideoBySlug(db, String(video), { mustBePublished: false })
    || (/^\d+$/.test(String(video)) ? await videoService.getVideoById(db, Number(video)) : null);
  if (!found) throw new Error(`video_watch_status: no video "${video}"`);

  const output = await videoService.getWatchStatus(db, { contactId, videoId: found.id });
  return { success: true, output: { video_id: found.id, video_slug: found.slug, ...output } };
};
fns.video_watch_status.__meta = {
  category: 'video',
  workflowOnly: true,   // a sequence can't read the result
  description:
    'Has this contact watched this video? Returns opened, played, completed and clicked (booleans), ' +
    'best_completion_pct, last_played_at and last_completed_at. Completed means at least 90% really ' +
    'played. Excluded views and automated opens do not count. An unknown video fails the step.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'video', type: 'string', required: true, placeholderAllowed: true,
      description: 'Video id or slug', example: 'reminder-send-documents' },
  ],
  example: { contact_id: '{{contactId}}', video: 'reminder-send-documents' },
};

module.exports = fns;
