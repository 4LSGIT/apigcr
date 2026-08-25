// public/js/videoInsert.js
//
// YisraVideo — video link picker for Quill / SMS composers.
//
// Loaded inline by host pages (campaign.html, communicate.html, sendingform.html).
// Each iframe loads its own copy. No parent-shell dependency.
//
// Usage (host pages):
//
//   const result = await YisraVideoInsert.openVideoPicker({
//     contactId: 42 | null,    // null = campaign template mode (leaves placeholder literal)
//                              // resolved to contacts.contact_token internally
//     context:   'email' | 'sms',
//     mmsCapable: true | false  // SMS only; consulted to offer MMS variants
//   });
//
// Result shape (or null on cancel):
//   { kind: 'html',     html: '<a href="..."><img ...></a>' }
//   { kind: 'sms-text', text: 'https://...' }
//   { kind: 'mms',      text: 'https://...', attachmentUrl: '...', mediaKind: 'poster' | 'gif' }
//
// Notes:
// - Placeholder syntax: when contactId is null, URLs contain {{contacts.contact_token}}
//   (matches resolverService schema). Caller is responsible for resolving at send time.
// - Snippet shape (email): wrapped `<a><img></a>` form. The EmailImage blot is
//   registered on each host page so the <img> attributes survive Quill's clipboard.
//   If round-trip stripping is observed, switch to the two-line fallback below.
// - Cache: video list is fetched once per iframe load. Refresh by reloading the
//   iframe (e.g. switch tabs and back, or reload the page).

(function (global) {
  'use strict';

  // ── Module-private state ───────────────────────────────────────────────────

  let videosCache = null;        // null = not yet fetched; [] = fetched empty
  let videosCachePromise = null; // de-dupe concurrent first-fetches

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function getSwal() {
    // Each host page either loads its own SweetAlert2 (communicate, sendingform)
    // or aliases the parent's (campaign). window.Swal is the right reference
    // in all three cases.
    return window.Swal || (window.parent && window.parent.Swal);
  }

  function getApiSend() {
    // Parent shell (a.html / index.html) exposes apiSend on window.
    return window.parent && window.parent.apiSend;
  }

  // ── Popup theming ──────────────────────────────────────────────────────────
  // SweetAlert2 paints .swal2-popup white with #545454 text in both modes, and
  // no consumer page overrides it (only the shell does, for its own document).
  // The dialog markup below is tokenised, so without this the widget would be
  // themed content on an unthemed white card. Scoped via customClass so it
  // themes THIS module's dialogs only.
  var STYLE_ID = 'yvi-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent =
      '.yvi-popup{background:var(--surface);color:var(--text);}' +
      '.yvi-popup .swal2-title{color:var(--text);}' +
      '.yvi-popup .swal2-html-container{color:var(--text);}';
    document.head.appendChild(el);
  }
  var YVI_POPUP = { popup: 'yvi-popup' };

  // Public host for /v/ landing links (2026-08-17 origin-separation slice).
  // Staff run this UI on app.4lsg.com, but the links it mints go to CLIENTS,
  // and the public video surface now lives on the landing host. Hard-coded —
  // same pattern as the booking/manage link defaults in scripts.js and
  // campaign.html. (Replaced the old getOrigin() parent-origin helper, which
  // would mint app-host links forever from the staff shell.)
  var PUBLIC_VIDEO_ORIGIN = 'https://4lsg.com';

  /**
   * Fetch + cache the published-videos list. Returns array of video objects
   * (or [] on failure — error toast already shown).
   */
  async function loadVideos() {
    if (videosCache !== null) return videosCache;
    if (videosCachePromise) return videosCachePromise;

    videosCachePromise = (async () => {
      const apiSend = getApiSend();
      try {
        let res;
        if (apiSend) {
          res = await apiSend('/api/videos?published=1', 'GET');
        } else {
          // Fallback — shouldn't happen in current host pages
          const r = await fetch('/api/videos?published=1');
          res = await r.json();
        }
        const list = (res && res.videos) || [];
        // Safety net: filter to published only, in case the ?published=1 filter
        // is ignored by the backend.
        videosCache = list.filter(v => v && v.is_published);
      } catch (err) {
        console.error('[videoInsert] Failed to load videos:', err);
        videosCache = [];
      } finally {
        videosCachePromise = null;
      }
      return videosCache;
    })();

    return videosCachePromise;
  }

  /**
   * Build the full landing-page URL for a video.
   *
   * 2026-08-17: emits ?ct=<contact_token>, replacing ?c=<contact_id>. The raw
   * id was forgeable (anyone could walk 1,2,3…) so it never was a credential;
   * only the token can satisfy a contact_only video. The landing route still
   * ACCEPTS ?c= for attribution so links already in inboxes keep working, but
   * nothing mints it any more.
   *
   * @param {string} slug
   * @param {string|null} contactToken
   *   When falsy/null: produces ...?ct={{contacts.contact_token}} — the
   *     campaign-template form, substituted per recipient by resolverService.
   *   Otherwise: produces ...?ct=<token> (already substituted).
   */
  function buildUrl(slug, contactToken) {
    const base = PUBLIC_VIDEO_ORIGIN + '/v/' + encodeURIComponent(slug);
    const c = (contactToken === null || contactToken === undefined || contactToken === '')
      ? '{{contacts.contact_token}}'
      : String(contactToken);
    return base + '?ct=' + c;
  }

  /**
   * contact_id → contact_token, via the mint-or-return endpoint booking
   * already uses. Cached per contact for the life of the page.
   *
   * Returns null on failure, which degrades to the anonymous form of the link
   * rather than blocking the insert — losing attribution on one send is a far
   * better outcome than refusing to send.
   */
  const tokenCache = new Map();
  async function resolveContactToken(contactId) {
    if (contactId === null || contactId === undefined || contactId === '') return null;
    const key = String(contactId);
    if (tokenCache.has(key)) return tokenCache.get(key);
    let token = null;
    try {
      const P = window.parent && window.parent.apiSend ? window.parent : window;
      const resp = await P.apiSend('/api/contacts/' + encodeURIComponent(key) + '/booking-link', 'POST', {});
      token = (resp && resp.token) || null;
    } catch (err) {
      console.warn('[videoInsert] contact_token lookup failed; sending anonymous link', err);
    }
    tokenCache.set(key, token);
    return token;
  }

  // ── Snippet builders ───────────────────────────────────────────────────────

  /**
   * Email snippet: wrapped <a><img></a>. Single line.
   *
   * Fallback two-line variant (if <a> stripping is observed in some host):
   *   <p><img src="..." alt="..." width="600" style="..."></p>
   *   <p><a href="...">▶ <title></a></p>
   */
  function buildEmailImageSnippet(url, imgUrl, title) {
    return '<a href="' + esc(url) + '">'
         +   '<img src="' + esc(imgUrl) + '" alt="' + esc(title) + '" width="600"'
         +       ' style="display:block; max-width:100%; height:auto; border:0; outline:none;">'
         + '</a>';
  }

  function buildEmailTextLinkSnippet(url, title) {
    return '<p><a href="' + esc(url) + '">▶ ' + esc(title) + '</a></p>';
  }

  // ── UI: stage 1 — video selection ──────────────────────────────────────────

  /**
   * Show the video-list modal. Resolves to the selected video object, or null
   * on cancel.
   */
  async function pickVideo(Swal, videos) {
    if (!videos.length) {
      ensureStyles();
      await Swal.fire({
        customClass: YVI_POPUP,
        icon:  'info',
        title: 'No published videos',
        html:  'Add some in <strong>More → Video Manager</strong>, then try again.',
        confirmButtonText: 'OK',
      });
      return null;
    }

    const renderRow = (v) => {
      const thumb = v.gcs_poster_url
        ? '<img src="' + esc(v.gcs_poster_url) + '" alt=""'
          + ' style="width:60px;height:34px;object-fit:cover;border-radius:3px;background:var(--surface-2);flex-shrink:0;">'
        : '<div style="width:60px;height:34px;display:flex;align-items:center;justify-content:center;'
          + 'background:var(--surface-2);border-radius:3px;color:var(--text-muted);flex-shrink:0;font-size:18px;">▶</div>';
      return '<div class="yvi-row" data-video-id="' + esc(v.id) + '"'
        + ' style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);'
        + 'border-radius:4px;margin-bottom:6px;cursor:pointer;background:var(--surface);color:var(--text);">'
        + thumb
        + '<div style="flex:1;min-width:0;text-align:left;overflow:hidden;">'
        +   '<div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
        +     esc(v.title || '(untitled)')
        +   '</div>'
        +   '<div style="font-size:12px;color:var(--text-muted);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">/v/'
        +     esc(v.slug || '')
        +   '</div>'
        + '</div>'
        + '</div>';
    };

    let selectedVideo = null;
    let debounceTimer = null;

    ensureStyles();
    const result = await Swal.fire({
      customClass: YVI_POPUP,
      title: 'Insert Video Link',
      html:
        '<div style="text-align:left;">'
        +   '<input type="text" id="yvi-search" placeholder="Search by title or slug…"'
        +     ' style="width:100%;padding:8px 10px;border:1px solid var(--border-strong);border-radius:4px;font-size:14px;margin-bottom:10px;'
        +     'background:var(--surface);color:var(--text);">'
        +   '<div id="yvi-list" style="max-height:340px;overflow-y:auto;text-align:left;padding-right:4px;">'
        +     videos.map(renderRow).join('')
        +   '</div>'
        + '</div>',
      width: 540,
      showCancelButton: true,
      showConfirmButton: false,
      cancelButtonText: 'Cancel',
      focusCancel: false,
      didOpen: () => {
        const popup    = Swal.getPopup();
        const searchEl = popup.querySelector('#yvi-search');
        const listEl   = popup.querySelector('#yvi-list');

        const filterAndRender = (q) => {
          const qq = q.trim().toLowerCase();
          const filtered = !qq ? videos : videos.filter(v =>
            ((v.title || '').toLowerCase().includes(qq))
            || ((v.slug || '').toLowerCase().includes(qq))
          );
          if (!filtered.length) {
            listEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">No matches.</div>';
          } else {
            listEl.innerHTML = filtered.map(renderRow).join('');
          }
          attachRowHandlers();
        };

        const attachRowHandlers = () => {
          listEl.querySelectorAll('.yvi-row').forEach(row => {
            row.addEventListener('mouseenter', () => { row.style.background = 'var(--hover)'; });
            row.addEventListener('mouseleave', () => { row.style.background = 'var(--surface)'; });
            row.addEventListener('click', () => {
              const id = row.getAttribute('data-video-id');
              selectedVideo = videos.find(x => String(x.id) === String(id)) || null;
              Swal.close();
            });
          });
        };

        attachRowHandlers();
        searchEl.addEventListener('input', (e) => {
          clearTimeout(debounceTimer);
          const val = e.target.value;
          debounceTimer = setTimeout(() => filterAndRender(val), 250);
        });

        // Focus search box for fast keyboard entry
        setTimeout(() => searchEl.focus(), 50);
      },
    });

    // result.dismiss is set on cancel / backdrop click; selectedVideo is set on row click
    if (selectedVideo) return selectedVideo;
    return null;
  }

  // ── UI: stage 2 — insertion variant ────────────────────────────────────────

  /**
   * Build the list of variants applicable for this video + context + mmsCapable.
   * Returns an array of { key, label, hint } objects.
   */
  function buildVariants(video, context, mmsCapable) {
    const hasPoster = !!video.gcs_poster_url;
    const hasGif    = !!video.gcs_gif_url;
    const variants  = [];

    if (context === 'email') {
      if (hasPoster) variants.push({ key: 'email-poster', label: 'Insert poster + link', hint: 'Image with the video URL' });
      if (hasGif)    variants.push({ key: 'email-gif',    label: 'Insert GIF + link',    hint: 'Animated preview with the video URL' });
      variants.push({ key: 'email-text', label: 'Insert text-only link', hint: 'Just an inline link' });
    } else { // sms
      if (mmsCapable && hasPoster) variants.push({ key: 'mms-poster', label: 'MMS + poster', hint: 'URL in body, poster as attachment' });
      if (mmsCapable && hasGif)    variants.push({ key: 'mms-gif',    label: 'MMS + GIF',    hint: 'URL in body, GIF as attachment' });
      variants.push({ key: 'sms-plain', label: mmsCapable ? 'Plain SMS (URL only)' : 'Insert URL', hint: '' });
    }

    return variants;
  }

  /**
   * Show the variant-pick modal. If only one variant is offered, auto-selects.
   * Returns the variant key, or null on cancel.
   */
  async function pickVariant(Swal, video, variants) {
    if (variants.length === 1) return variants[0].key;

    let chosen = null;
    const html =
      '<div style="text-align:left;">'
      +   '<div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">Selected: <strong>' + esc(video.title || '(untitled)') + '</strong></div>'
      +   variants.map(v =>
            '<button type="button" class="yvi-variant-btn" data-key="' + esc(v.key) + '"'
            + ' style="display:block;width:100%;padding:10px 12px;margin-bottom:6px;text-align:left;'
            + 'background:var(--surface);color:var(--text);border:1px solid var(--border-strong);border-radius:4px;cursor:pointer;font-size:14px;">'
            +   '<div style="font-weight:600;color:var(--text);">' + esc(v.label) + '</div>'
            +   (v.hint ? '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + esc(v.hint) + '</div>' : '')
            + '</button>'
          ).join('')
      + '</div>';

    ensureStyles();
    await Swal.fire({
      customClass: YVI_POPUP,
      title: 'Choose insertion style',
      html,
      width: 480,
      showCancelButton: true,
      showConfirmButton: false,
      cancelButtonText: 'Cancel',
      didOpen: () => {
        const popup = Swal.getPopup();
        popup.querySelectorAll('.yvi-variant-btn').forEach(btn => {
          btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--hover)'; btn.style.borderColor = 'var(--accent)'; });
          btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--surface)'; btn.style.borderColor = 'var(--border-strong)'; });
          btn.addEventListener('click', () => {
            chosen = btn.getAttribute('data-key');
            Swal.close();
          });
        });
      },
    });

    return chosen;
  }

  // ── Result builders ────────────────────────────────────────────────────────

  function buildResult(variantKey, video, contactToken) {
    const url = buildUrl(video.slug, contactToken);
    const title = video.title || 'Watch the video';

    switch (variantKey) {
      case 'email-poster':
        return { kind: 'html', html: buildEmailImageSnippet(url, video.gcs_poster_url, title) };
      case 'email-gif':
        return { kind: 'html', html: buildEmailImageSnippet(url, video.gcs_gif_url, title) };
      case 'email-text':
        return { kind: 'html', html: buildEmailTextLinkSnippet(url, title) };
      case 'sms-plain':
        return { kind: 'sms-text', text: url };
      case 'mms-poster':
        return { kind: 'mms', text: url, attachmentUrl: video.gcs_poster_url, mediaKind: 'poster' };
      case 'mms-gif':
        return { kind: 'mms', text: url, attachmentUrl: video.gcs_gif_url, mediaKind: 'gif' };
      default:
        return null;
    }
  }

  // ── Public entry point ─────────────────────────────────────────────────────

  async function openVideoPicker(opts) {
    const Swal = getSwal();
    if (!Swal) {
      console.error('[videoInsert] No Swal available on window or window.parent');
      alert('Video picker unavailable: SweetAlert2 not loaded.');
      return null;
    }

    const ctx        = opts && opts.context;
    const contactId  = (opts && opts.contactId !== undefined) ? opts.contactId : null;
    const mmsCapable = !!(opts && opts.mmsCapable);

    if (ctx !== 'email' && ctx !== 'sms') {
      console.error('[videoInsert] Invalid context:', ctx);
      return null;
    }

    // Stage 0 — fetch list (with a tiny loading state if it's the first load)
    let videos;
    if (videosCache === null) {
      ensureStyles();
      Swal.fire({ customClass: YVI_POPUP, title: 'Loading videos…', didOpen: () => Swal.showLoading(), allowOutsideClick: false });
      videos = await loadVideos();
      Swal.close();
    } else {
      videos = videosCache;
    }

    // Stage 1 — pick video
    const video = await pickVideo(Swal, videos);
    if (!video) return null;

    // Stage 2 — pick variant
    const variants = buildVariants(video, ctx, mmsCapable);
    const variantKey = await pickVariant(Swal, video, variants);
    if (!variantKey) return null;

    // Stage 3 — resolve the contact's token (no-op in campaign-template mode,
    // where contactId is null and the placeholder stays literal).
    const contactToken = await resolveContactToken(contactId);

    return buildResult(variantKey, video, contactToken);
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  global.YisraVideoInsert = { openVideoPicker };

})(window);