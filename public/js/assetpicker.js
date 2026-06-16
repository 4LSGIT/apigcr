// public/js/assetpicker.js
//
// AssetPicker — shared comms-facing "insert image / file" picker widget.
//
// A single plain global IIFE (NO module system). Exposes:
//     window.AssetPicker = { pick };
//     AssetPicker.pick(opts) -> Promise<string|null>   // resolves a URL, or null on cancel
//
// Depends ONLY on:
//   - global SweetAlert2 as `Swal`
//   - an apiSend(path, method, body) transport (JSON-based; see resolveApiSend)
//   - FontAwesome solid icon classes (fas fa-file-*) for non-image cells
//
// Backed by the asset-store API:
//   GET    /api/assets?q=&collection=&mime=&sort=&limit=&offset=   -> { assets, total, limit, offset }
//   POST   /api/assets   (base64 JSON)                              -> { success, url, ... , id }
//   DELETE /api/assets/:id                                          -> { success } | 404
//
// IMPORTANT — SweetAlert2 is single-instance: any Swal.fire()/Toast.fire() while
// the picker is open REPLACES (closes) it. So this widget NEVER fires a second
// Swal while the modal is open: deletes use a native confirm(), and all
// in-modal feedback (upload/url/delete) uses an inline message <div>. This keeps
// the picker open across errors and retries, as intended.
//
// pick(opts) options:
//   collection  (string|null)  default library filter + tag applied to uploads; null = no filter
//   accept      (string)       <input type=file accept> attr; default 'image/png,image/jpeg,image/gif,image/webp'
//   mimeFilter  (string|null)  passed to GET ?mime= to scope the grid (e.g. 'image/'); null = all
//   maxMB       (number)       client size cap; default 10
//   register    (bool)         default state of "Save to library" checkbox; default true
//   allowAll    (bool)         default true; with `collection`, shows a collection-vs-All toggle
//   title       (string)       Swal title; default 'Insert Image'
//   apiSend     (fn)           transport; default resolution chain in resolveApiSend()

(function () {
  'use strict';

  var STYLE_ID = 'assetpicker-styles';
  var LIMIT    = 24;
  var ACCENT   = '#07ADEF';

  // ── Private HTML escaper (do NOT rely on any host-page helper) ──
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Resolve the apiSend transport ──
  // Documented chain first; the trailing window.parent.apiSend covers the real
  // comms-iframe deployment (pages alias `const P = window.parent` and expose
  // apiSend on the parent window). All wrapped — cross-origin parent access throws.
  function resolveApiSend(opts) {
    if (opts && typeof opts.apiSend === 'function') return opts.apiSend;
    try { if (window.P && typeof window.P.apiSend === 'function') return window.P.apiSend; } catch (_) {}
    try { if (window.parent && window.parent.P && typeof window.parent.P.apiSend === 'function') return window.parent.P.apiSend; } catch (_) {}
    try { if (typeof window.apiSend === 'function') return window.apiSend; } catch (_) {}
    try { if (window.parent && typeof window.parent.apiSend === 'function') return window.parent.apiSend; } catch (_) {}
    return null;
  }

  // ── FontAwesome solid class for a non-image mime ──
  function iconClassForMime(mime) {
    var m = String(mime || '').toLowerCase();
    if (m.indexOf('pdf') !== -1) return 'fa-file-pdf';
    if (m.indexOf('word') !== -1 || m.indexOf('msword') !== -1 || m.indexOf('wordprocessingml') !== -1) return 'fa-file-word';
    if (m.indexOf('excel') !== -1 || m.indexOf('spreadsheet') !== -1 || m === 'text/csv') return 'fa-file-excel';
    return 'fa-file';
  }

  // ── Inject scoped styles once ──
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.ap-controls{display:flex;gap:8px;align-items:center;margin-bottom:10px;}' +
      '.ap-text{box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;}' +
      '.ap-search{flex:1;min-width:0;}' +
      '.ap-select{flex:0 0 auto;width:auto;max-width:45%;}' +
      '.ap-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;max-height:400px;overflow-y:auto;padding:4px;}' +
      '.ap-cell{position:relative;border:2px solid transparent;border-radius:6px;cursor:pointer;transition:border-color .15s;background:#fff;}' +
      '.ap-cell:hover{border-color:' + ACCENT + ';}' +
      '.ap-thumb{width:100%;height:90px;object-fit:cover;border-radius:4px;display:block;background:#f4f4f4;}' +
      '.ap-fileicon{width:100%;height:90px;display:flex;align-items:center;justify-content:center;background:#f4f4f4;border-radius:4px;}' +
      '.ap-fileicon i{font-size:30px;color:#777;}' +
      '.ap-label{font-size:10px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 4px;}' +
      '.ap-del{position:absolute;top:2px;right:2px;background:rgba(220,53,69,.85);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:20px;padding:0;}' +
      '.ap-del:hover{background:rgba(220,53,69,1);}' +
      '.ap-state{grid-column:1/-1;text-align:center;color:#999;font-size:13px;padding:24px 8px;}' +
      '.ap-footer{display:flex;align-items:center;justify-content:space-between;margin-top:8px;font-size:12px;color:#666;min-height:20px;}' +
      '.ap-more{background:none;border:1px solid ' + ACCENT + ';color:' + ACCENT + ';border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer;}' +
      '.ap-more:hover{background:' + ACCENT + ';color:#fff;}' +
      '.ap-msg{margin-top:8px;font-size:12px;border-radius:4px;padding:6px 8px;display:none;text-align:left;}' +
      '.ap-msg.error{background:#fdecea;color:#b71c1c;}' +
      '.ap-msg.success{background:#e8f5e9;color:#1b5e20;}' +
      '.ap-msg.info{background:#e3f2fd;color:#0d47a1;}' +
      '.ap-up{margin-top:10px;border:1px solid #eee;border-radius:6px;}' +
      '.ap-up>summary{cursor:pointer;padding:8px 10px;font-size:13px;font-weight:600;color:#444;list-style:none;}' +
      '.ap-up>summary::-webkit-details-marker{display:none;}' +
      '.ap-up>summary::before{content:"\\25B8\\00A0";color:#999;}' +
      '.ap-up[open]>summary::before{content:"\\25BE\\00A0";}' +
      '.ap-up-body{padding:0 10px 10px;display:flex;flex-direction:column;gap:8px;}' +
      '.ap-up-body input[type=text],.ap-up-body input[type=file]{font-size:13px;}' +
      '.ap-check{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;color:#444;}' +
      '.ap-btn{background:' + ACCENT + ';color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer;white-space:nowrap;}' +
      '.ap-btn:hover{filter:brightness(.95);}' +
      '.ap-btn:disabled{opacity:.6;cursor:default;}' +
      '.ap-divider{border:none;border-top:1px solid #eee;margin:10px 0 0;}' +
      '.ap-url{display:flex;gap:8px;margin-top:10px;align-items:center;}' +
      '.ap-url input{flex:1;min-width:0;}';
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── File helpers ──
  function readImageDims(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || null;
        var h = img.naturalHeight || null;
        URL.revokeObjectURL(url);
        resolve({ w: w, h: h });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('decode failed'));
      };
      img.src = url;
    });
  }

  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(new Error('read failed')); };
      r.readAsDataURL(file);
    });
  }

  // ── The picker ──
  function pick(opts) {
    opts = opts || {};

    var apiSend       = resolveApiSend(opts);
    var accept        = opts.accept || 'image/png,image/jpeg,image/gif,image/webp';
    var maxMB         = Number.isFinite(Number(opts.maxMB)) ? Number(opts.maxMB) : 10;
    var titleText     = opts.title || 'Insert Image';
    var registerDef   = (opts.register === undefined) ? true : !!opts.register;
    var allowAll      = (opts.allowAll === undefined) ? true : !!opts.allowAll;
    var collection    = (opts.collection === undefined || opts.collection === '') ? null : opts.collection;
    var mimeFilter    = (opts.mimeFilter === undefined || opts.mimeFilter === '') ? null : opts.mimeFilter;
    var hasSelect     = !!(allowAll && collection);

    return new Promise(function (resolve) {
      if (typeof Swal === 'undefined' || !Swal || typeof Swal.fire !== 'function') {
        console.error('[AssetPicker] SweetAlert2 (Swal) is not available.');
        resolve(null);
        return;
      }
      if (typeof apiSend !== 'function') {
        Swal.fire({ icon: 'error', title: 'Picker unavailable', text: 'No API transport (apiSend) was found.' })
          .then(function () { resolve(null); });
        return;
      }

      ensureStyles();

      // ── State ──
      var settled        = false;
      var offset         = 0;
      var loadedCount    = 0;
      var total          = 0;
      var q              = '';
      var currentColl    = hasSelect ? collection : (collection || ''); // '' => unfiltered
      var debTimer       = null;
      var msgTimer       = null;

      // Element refs (filled in didOpen)
      var grid, countEl, moreBtn, msgEl, searchEl, selectEl,
          fileEl, titleEl, tagsEl, registerEl, uploadBtn, urlEl, urlBtn;

      // ── Build the modal shell ──
      var selectHtml = hasSelect
        ? ('<select class="ap-text ap-select" id="ap-collection">' +
             '<option value="' + esc(collection) + '" selected>' + esc(collection) + '</option>' +
             '<option value="">All collections</option>' +
           '</select>')
        : '';

      var html =
        '<div class="ap-controls">' +
          selectHtml +
          '<input type="text" class="ap-text ap-search" id="ap-search" placeholder="Search\u2026" autocomplete="off">' +
        '</div>' +
        '<div class="ap-grid" id="ap-grid"></div>' +
        '<div class="ap-footer">' +
          '<span id="ap-count"></span>' +
          '<button type="button" class="ap-more" id="ap-more" style="display:none;">Load more</button>' +
        '</div>' +
        '<div class="ap-msg" id="ap-msg"></div>' +
        '<details class="ap-up" id="ap-up">' +
          '<summary>Upload a file</summary>' +
          '<div class="ap-up-body">' +
            '<input type="file" id="ap-file" accept="' + esc(accept) + '">' +
            '<input type="text" class="ap-text" id="ap-title" placeholder="Title (optional)" autocomplete="off">' +
            '<input type="text" class="ap-text" id="ap-tags" placeholder="comma,separated tags (optional)" autocomplete="off">' +
            '<label class="ap-check"><input type="checkbox" id="ap-register"' + (registerDef ? ' checked' : '') + '> Save to library for reuse</label>' +
            '<div><button type="button" class="ap-btn" id="ap-upload">Upload</button></div>' +
          '</div>' +
        '</details>' +
        '<hr class="ap-divider">' +
        '<div class="ap-url">' +
          '<input type="text" class="ap-text" id="ap-url" placeholder="Or paste an image URL (https://\u2026)" autocomplete="off">' +
          '<button type="button" class="ap-btn" id="ap-url-btn">Use URL</button>' +
        '</div>';

      // ── Resolve helpers ──
      function resolveOnce(val) {
        if (settled) return;
        settled = true;
        resolve(val);
        try { Swal.close(); } catch (_) {}
      }

      function setMsg(text, type) {
        if (!msgEl) return;
        if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
        if (!text) {
          msgEl.style.display = 'none';
          msgEl.textContent = '';
          msgEl.className = 'ap-msg';
          return;
        }
        msgEl.textContent = text;
        msgEl.className = 'ap-msg ' + (type || 'info');
        msgEl.style.display = 'block';
        if (type === 'success' || type === 'info') {
          msgTimer = setTimeout(function () {
            if (!msgEl) return;
            msgEl.style.display = 'none';
            msgEl.textContent = '';
          }, 2600);
        }
      }

      var imageNoun = (mimeFilter && mimeFilter.toLowerCase().indexOf('image/') === 0) ? 'images' : 'assets';

      function showLoading() {
        if (grid) grid.innerHTML = '<div class="ap-state">Loading\u2026</div>';
      }
      function showEmpty() {
        if (!grid) return;
        var msg = q ? ('No ' + imageNoun + ' found') : ('No ' + imageNoun + ' in library yet');
        grid.innerHTML = '<div class="ap-state">' + esc(msg) + '</div>';
      }
      function updateFooter() {
        if (countEl) countEl.textContent = total > 0 ? ('Showing ' + loadedCount + ' of ' + total) : '';
        if (moreBtn) moreBtn.style.display = (loadedCount < total) ? '' : 'none';
      }

      // ── Build one grid cell ──
      function makeCell(asset) {
        var cell = document.createElement('div');
        cell.className = 'ap-cell';
        cell.setAttribute('data-id', String(asset.id));

        var isImg = String(asset.mime || '').toLowerCase().indexOf('image/') === 0;
        if (isImg) {
          var img = document.createElement('img');
          img.className = 'ap-thumb';
          img.loading = 'lazy';
          img.alt = asset.original_name || asset.filename || '';
          img.src = asset.url; // property assignment — inherently safe
          cell.appendChild(img);
        } else {
          var box = document.createElement('div');
          box.className = 'ap-fileicon';
          var i = document.createElement('i');
          i.className = 'fas ' + iconClassForMime(asset.mime);
          box.appendChild(i);
          cell.appendChild(box);
        }

        var labelText = asset.title || asset.original_name || asset.filename || '(untitled)';
        var label = document.createElement('div');
        label.className = 'ap-label';
        label.textContent = labelText;
        label.title = labelText;
        cell.appendChild(label);

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'ap-del';
        del.innerHTML = '&times;';
        del.title = 'Remove from library';
        del.addEventListener('click', function (e) {
          e.stopPropagation(); // do not select the cell
          onDelete(asset.id, cell);
        });
        cell.appendChild(del);

        cell.addEventListener('click', function () { resolveOnce(asset.url); });
        return cell;
      }

      // ── Query the asset list ──
      function runQuery(reset) {
        if (reset) {
          offset = 0;
          loadedCount = 0;
          showLoading();
        }
        var params = [];
        if (q) params.push('q=' + encodeURIComponent(q));
        if (currentColl) params.push('collection=' + encodeURIComponent(currentColl));
        if (mimeFilter) params.push('mime=' + encodeURIComponent(mimeFilter));
        params.push('sort=newest');
        params.push('limit=' + LIMIT);
        params.push('offset=' + offset);
        var path = '/api/assets?' + params.join('&');

        Promise.resolve()
          .then(function () { return apiSend(path, 'GET'); })
          .then(function (data) {
            var assets = (data && Array.isArray(data.assets)) ? data.assets : [];
            total = Number(data && data.total) || 0;

            if (reset) grid.innerHTML = '';

            if (reset && total === 0) {
              showEmpty();
              updateFooter();
              return;
            }
            var frag = document.createDocumentFragment();
            for (var k = 0; k < assets.length; k++) frag.appendChild(makeCell(assets[k]));
            grid.appendChild(frag);
            loadedCount += assets.length;
            updateFooter();
          })
          .catch(function (e) {
            if (reset) {
              grid.innerHTML = '<div class="ap-state">Couldn\u2019t load ' + esc(imageNoun) + '.</div>';
            } else {
              offset = Math.max(0, offset - LIMIT); // let the user retry the same page
            }
            setMsg('Failed to load: ' + (e && e.message ? e.message : 'error'), 'error');
          });
      }

      // ── Delete (native confirm — Swal.fire would close the picker) ──
      function onDelete(id, cell) {
        var ok = window.confirm('Remove this from the library?\nThe file stays hosted but is hidden from the picker.');
        if (!ok) return;
        Promise.resolve()
          .then(function () { return apiSend('/api/assets/' + encodeURIComponent(id), 'DELETE'); })
          .then(function () {
            if (cell && cell.parentNode) cell.parentNode.removeChild(cell);
            total = Math.max(0, total - 1);
            loadedCount = Math.max(0, loadedCount - 1);
            updateFooter();
            if (total === 0) showEmpty();
            setMsg('Removed from library.', 'success');
          })
          .catch(function (e) {
            setMsg('Failed to remove: ' + (e && e.message ? e.message : 'error'), 'error');
          });
      }

      // ── Upload (base64 JSON via POST /api/assets) ──
      function onUpload() {
        setMsg('', null);
        var file = fileEl && fileEl.files && fileEl.files[0];
        if (!file) { setMsg('Choose a file first.', 'error'); return; }
        if (file.size > maxMB * 1024 * 1024) {
          setMsg('File must be under ' + maxMB + ' MB.', 'error');
          return;
        }
        if (uploadBtn) uploadBtn.disabled = true;
        setMsg('Uploading\u2026', 'info');

        var isImg = String(file.type || '').toLowerCase().indexOf('image/') === 0;
        var dimsP = isImg ? readImageDims(file).catch(function () { return null; }) : Promise.resolve(null);

        dimsP.then(function (dims) {
          return readBase64(file).then(function (base64) {
            var selVal = selectEl ? selectEl.value : '';
            var uploadCollection = (selVal || collection) || null;
            var titleVal = titleEl ? (titleEl.value || '').trim() : '';
            var tagsVal  = tagsEl ? (tagsEl.value || '').trim() : '';
            var body = {
              image:       base64,
              filename:    file.name,
              contentType: file.type || 'application/octet-stream',
              collection:  uploadCollection,
              title:       titleVal || undefined,
              tags:        tagsVal || undefined,
              register:    !!(registerEl && registerEl.checked),
              width:       dims ? dims.w : null,
              height:      dims ? dims.h : null
            };
            return apiSend('/api/assets', 'POST', body);
          });
        })
        .then(function (res) {
          if (res && res.url) {
            resolveOnce(res.url);
          } else {
            setMsg('Upload succeeded but no URL was returned.', 'error');
            if (uploadBtn) uploadBtn.disabled = false;
          }
        })
        .catch(function (e) {
          setMsg('Upload failed: ' + (e && e.message ? e.message : 'error'), 'error');
          if (uploadBtn) uploadBtn.disabled = false;
        });
      }

      // ── Use a pasted URL ──
      function onUseUrl() {
        var u = urlEl ? (urlEl.value || '').trim() : '';
        if (!u) { setMsg('Enter a URL first.', 'error'); return; }
        resolveOnce(u);
      }

      // ── Fire the modal ──
      Swal.fire({
        title: titleText,
        html: html,
        width: 640,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: 'Cancel',
        // No confirm button is shown; this no-op guard neutralizes SweetAlert2's
        // "Enter triggers confirm" behavior (which would otherwise close the picker)
        // without the deprecated `allowEnterKey`. Our own Enter handlers below do the work.
        preConfirm: function () { return false; },
        focusConfirm: false,
        didOpen: function () {
          var p = Swal.getPopup();
          grid       = p.querySelector('#ap-grid');
          countEl    = p.querySelector('#ap-count');
          moreBtn    = p.querySelector('#ap-more');
          msgEl      = p.querySelector('#ap-msg');
          searchEl   = p.querySelector('#ap-search');
          selectEl   = p.querySelector('#ap-collection');
          fileEl     = p.querySelector('#ap-file');
          titleEl    = p.querySelector('#ap-title');
          tagsEl     = p.querySelector('#ap-tags');
          registerEl = p.querySelector('#ap-register');
          uploadBtn  = p.querySelector('#ap-upload');
          urlEl      = p.querySelector('#ap-url');
          urlBtn     = p.querySelector('#ap-url-btn');

          // Search (debounced)
          if (searchEl) {
            searchEl.addEventListener('input', function () {
              q = searchEl.value.trim();
              if (debTimer) clearTimeout(debTimer);
              debTimer = setTimeout(function () { runQuery(true); }, 250);
            });
            searchEl.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (debTimer) clearTimeout(debTimer);
                runQuery(true);
              }
            });
          }

          // Collection toggle
          if (selectEl) {
            selectEl.addEventListener('change', function () {
              currentColl = selectEl.value; // '' => unfiltered
              runQuery(true);
            });
          }

          // Load more
          if (moreBtn) {
            moreBtn.addEventListener('click', function () {
              offset += LIMIT;
              runQuery(false);
            });
          }

          // Upload
          if (uploadBtn) uploadBtn.addEventListener('click', onUpload);

          // URL
          if (urlBtn) urlBtn.addEventListener('click', onUseUrl);
          if (urlEl) {
            urlEl.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onUseUrl(); }
            });
          }

          // Initial load
          runQuery(true);
        },
        willClose: function () {
          if (debTimer) { clearTimeout(debTimer); debTimer = null; }
          if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
          if (!settled) { settled = true; resolve(null); }
        }
      });
    });
  }

  window.AssetPicker = { pick: pick };
})();