/* public/js/versionGuard.js
 * ───────────────────────────────────────────────────────────────────────────────
 * STALE-TAB GUARD
 *
 * The problem
 * -----------
 * The YisraCase shell is a long-lived single page (and an installable PWA).
 * Nothing in the app ever reloads it. Even a JWT expiry doesn't: loginBlocking()
 * pops a SweetAlert, fetches a fresh token, and the page carries on running the
 * exact same JS it booted with. A tab left open for weeks therefore keeps running
 * code from hundreds of deploys ago, and happily writes against a schema and an
 * API that have moved on.
 *
 * Two tiers
 * ---------
 * SOFT — the default, every deploy.
 *   A small pill, bottom-right: "Update available — Reload". NON-DISMISSABLE:
 *   no ✕, no "Later". The only thing that removes it is a reload. Nothing is ever
 *   taken from the user — but they can't quietly decide to keep running last
 *   month's code either.
 *
 * HARD — opt-in per incident, via app_settings.min_client_build.
 *   A non-blocking banner with a live countdown, then the page reloads ITSELF.
 *   The banner is deliberately not a modal: a grace period only means something
 *   if you can use the app during it, and a dialog counting down for fifteen
 *   minutes is not a grace period, it's a fifteen-minute outage in which the Save
 *   button is unreachable.
 *
 * A force that can be blocked is not a force
 * ------------------------------------------
 * v1 of this file held the reload indefinitely whenever any YCForm reported
 * isDirty(). That was wrong, and it failed in production within a day.
 *
 * YCForm.isDirty() is `JSON.stringify(collect()) !== JSON.stringify(_original)` —
 * a whole-form string compare against a load-time snapshot. ANY field that
 * normalises itself after that snapshot (a select populated late, a date input
 * reformatting, an editor initialising) reports dirty forever, on a form nobody
 * touched. One such false positive and the forced reload never fires: the banner
 * just sits there saying "save your changes" to someone who has none.
 *
 * So the reload is now unconditional. Unsaved work delays it; it cannot prevent it:
 *
 *   grace (GRACE_MS, 15m)     countdown. Work normally. Save what you like.
 *   ↓ still dirty at T-0
 *   final (DIRTY_GRACE_MS, 2m) red banner NAMING the forms. Non-negotiable.
 *   ↓ still dirty at T-0
 *   preserve → reload         every dirty form's diff is written to localStorage
 *                             and offered back on the next boot. Nothing is
 *                             destroyed silently; nothing can block the reload.
 *
 * Saving at any point short-circuits straight to the reload.
 *
 * If the dirty flag was a false positive, the recovery snapshot is harmless noise
 * the user dismisses. If it was real, their typing is sitting in localStorage.
 * Either way the stale client is gone, which was the entire point.
 *
 * Reloads preserve the workspace
 * ------------------------------
 * We never call location.reload() blind. index.html exposes window.ycReloadUrl(),
 * which serialises the open case/contact files and the active view into a URL; we
 * location.replace() to that instead. An update costs the user a second, and the
 * address bar keeps the workspace, so a plain F5 restores it too.
 *
 * Why there is still no silent auto-reload in SOFT mode
 * ----------------------------------------------------
 * isDirty() only sees YCForms. A half-typed SMS in Communicate, a filled-in
 * search, an open picker — invisible to us, and all of it would vanish. A banner
 * the user acts on is honest; a silent reload that eats their message is not.
 *
 * Loop breaker
 * ------------
 * A bad floor value (or a rollback to below it) could cause reload → still stale
 * → reload, locking the firm out of the app. Two defences: never force a reload
 * into a build that is itself below the floor, and hard-stop after LOOP_MAX forced
 * reloads in LOOP_WINDOW_MS.
 *
 * Only ever runs in the top frame — reloading the shell reloads every iframe.
 *
 * Console
 * -------
 *   VersionGuard.diagnose()                → WHICH forms claim dirty, and which
 *                                            fields differ. Start here when the
 *                                            banner blames you for changes you
 *                                            didn't make.
 *   VersionGuard.info()                    → current state
 *   VersionGuard.simulate('soft'|'hard')   → fake a server update; no deploy, no DB
 *   VersionGuard.simulate(false)           → stop faking
 *   VersionGuard.graceMs = 20000           → shorten the countdown to watch it land
 *   VersionGuard.dirtyGraceMs = 10000      → ...and the final one
 *   VersionGuard.recovery()                → read back preserved unsaved work
 *   VersionGuard.reloadNow()               → skip to the end
 *   VersionGuard.isBusy = () => boolean    → add your own "not yet" test
 */
(function () {
  "use strict";

  // The shell owns this. An iframe reloading itself would fix nothing.
  if (window.top !== window.self) return;

  // ── Tunables ────────────────────────────────────────────────────────────────
  var GRACE_MS = 15 * 60 * 1000; // HARD: time to save / finish a thought
  var DIRTY_GRACE_MS = 2 * 60 * 1000; // final warning if STILL dirty at T-0
  var POLL_MS = 5 * 60 * 1000; // backstop poll for a visible-but-idle tab
  var RECHECK_MS = 30 * 1000; // min gap between *unforced* checks
  var HARD_MIN_MS = 5 * 1000; // min gap between ANY two checks (anti-spam)
  var CONFIRM_MS = 3 * 1000; // re-ask before acting (rides out a rollout)
  var NOTE_MS = 20 * 1000; // how often the pill re-checks its warning line

  var RECOVERY_KEY = "ycUnsavedRecovery";
  var RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

  // Z-INDEX — house convention, from #ycSystemAlertBar in index.html:
  //   shell chrome ≤ 100  <  system alert bar 999  <  SweetAlert2 1060
  // Ours sit in that band: above the header and sidebar, never over a SweetAlert
  // (the login prompt lives there).
  var Z_STACK = 999;
  var Z_BANNER = 1000; // also fixed top:0, and more urgent than a system alert

  // Loop breaker.
  var LOOP_KEY = "vgForcedReloads";
  var LOOP_WINDOW_MS = 5 * 60 * 1000;
  var LOOP_MAX = 2;

  var AMBER = "#b54708";
  var RED = "#c0392b";
  var BLUE = "#07ADEF";

  // ── State ───────────────────────────────────────────────────────────────────
  var bootBuild = null;
  var bootMtime = 0;
  var mode = null; // null | 'soft' | 'hard'
  var checking = false;
  var lastCheck = 0;
  var deadline = 0; // HARD: end of the grace period
  var finalDeadline = 0; // HARD: end of the final, non-negotiable countdown
  var pollTimer = null;
  var pendingTimer = null;
  var noteTimer = null;
  var hardTimer = null;

  var VG = {};
  window.VersionGuard = VG;

  // Public and writable — the countdowns read these, not the consts, so you can
  // shorten them from the console and watch a forced reload actually land.
  VG.graceMs = GRACE_MS;
  VG.dirtyGraceMs = DIRTY_GRACE_MS;

  function log() {
    try {
      console.info.apply(
        console,
        ["[versionGuard]"].concat([].slice.call(arguments))
      );
    } catch (_) {}
  }

  function num(v, fallback) {
    var n = Number(v);
    return n > 0 ? n : fallback;
  }

  // ── Server state ────────────────────────────────────────────────────────────
  function fetchVersion() {
    return fetch("/api/version", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  /**
   * 'hard' | 'soft' | null
   *
   * The floor-usability test matters: if the build currently being SERVED is
   * itself older than the floor (a bad Settings value, or a rollback to below
   * it), forcing a reload would land the user right back where they were — an
   * infinite reload loop. The floor is nonsense in that case: ignore it and fall
   * through to the soft pill.
   */
  function classify(v) {
    if (!bootBuild || !v || !v.build) return null;
    var floor = Number(v.minBuild || 0);
    var floorUsable = floor > 0 && v.mtime && v.mtime >= floor;
    if (floorUsable && bootMtime && bootMtime < floor) return "hard";
    if (v.build !== bootBuild) return "soft";
    return null;
  }

  // ── Loop breaker ────────────────────────────────────────────────────────────
  function recentForcedReloads() {
    try {
      var a = JSON.parse(sessionStorage.getItem(LOOP_KEY) || "[]");
      var cut = Date.now() - LOOP_WINDOW_MS;
      return a.filter(function (t) {
        return t > cut;
      });
    } catch (_) {
      return [];
    }
  }

  function noteForcedReload() {
    try {
      var a = recentForcedReloads();
      a.push(Date.now());
      sessionStorage.setItem(LOOP_KEY, JSON.stringify(a));
    } catch (_) {}
  }

  // ── Walking the shell's frames ──────────────────────────────────────────────
  // Frames nest a couple of levels (index.html → case.html → forms/*.html,
  // index.html → automationManager.html → automation/*.html). yc-forms sets
  // window.ycForm on its own frame and exposes isDirty() / getDiff() / collect().
  function collectFrames(win, out, depth) {
    if (depth > 4) return out;
    out.push(win);
    var kids;
    try {
      kids = win.frames;
    } catch (_) {
      return out;
    }
    for (var i = 0; i < kids.length; i++) {
      try {
        if (!kids[i].document) continue; // throws on cross-origin — not ours
        collectFrames(kids[i], out, depth + 1);
      } catch (_) {}
    }
    return out;
  }

  function frameLabel(w) {
    try {
      if (w.document && w.document.title) return w.document.title;
    } catch (_) {}
    try {
      return w.location.pathname.split("/").pop() || "form";
    } catch (_) {}
    return "form";
  }

  function framePath(w) {
    try {
      return w.location.pathname + w.location.search;
    } catch (_) {}
    return "";
  }

  /** Every frame with a YCForm, whether dirty or not. */
  function allForms() {
    var out = [];
    var frames = collectFrames(window, [], 0);
    for (var i = 0; i < frames.length; i++) {
      var f;
      try {
        f = frames[i].ycForm;
      } catch (_) {
        continue;
      }
      if (f && typeof f.isDirty === "function") out.push({ w: frames[i], f: f });
    }
    return out;
  }

  /** Cheap — isDirty() only. Safe to call at 1Hz. */
  function dirtyFormLabels() {
    var out = [];
    var forms = allForms();
    for (var i = 0; i < forms.length; i++) {
      try {
        if (forms[i].f.isDirty()) out.push(frameLabel(forms[i].w));
      } catch (_) {}
    }
    return out;
  }

  function hasUnsavedWork() {
    var forms = allForms();
    for (var i = 0; i < forms.length; i++) {
      try {
        if (forms[i].f.isDirty()) return true;
      } catch (_) {}
    }
    return false;
  }

  function listDirty() {
    var l = dirtyFormLabels();
    if (!l.length) return "this page";
    if (l.length === 1) return l[0];
    if (l.length === 2) return l[0] + " and " + l[1];
    return l.slice(0, -1).join(", ") + " and " + l[l.length - 1];
  }

  // NB: scoped to #tabOpenFiles on purpose. `.file-button` is also used INSIDE
  // case.html / contact.html for their own New Appointment / New Event buttons.
  function openFileCount() {
    try {
      return document.querySelectorAll("#tabOpenFiles .file-button").length;
    } catch (_) {
      return 0;
    }
  }

  function filesPreserved() {
    return typeof window.ycReloadUrl === "function";
  }

  function isBusy() {
    if (typeof VG.isBusy === "function") {
      try {
        if (VG.isBusy()) return true;
      } catch (_) {}
    }
    return hasUnsavedWork();
  }

  // ── Preserving unsaved work ─────────────────────────────────────────────────
  /**
   * Snapshot every dirty form to localStorage immediately before a forced reload.
   * This is what makes the force safe to make unconditional: we are not asking
   * permission to discard, we are refusing to discard at all.
   *
   * Stores getDiff() (field → [was, now]) and collect() (the whole form). Offered
   * back on the next boot; expires after RECOVERY_TTL_MS.
   *
   * @returns {number} forms preserved
   */
  function preserveUnsavedWork() {
    var out = [];
    var forms = allForms();
    for (var i = 0; i < forms.length; i++) {
      var w = forms[i].w;
      var f = forms[i].f;
      try {
        if (!f.isDirty()) continue;
      } catch (_) {
        continue;
      }
      var rec = { label: frameLabel(w), url: framePath(w) };
      try {
        rec.changed = typeof f.getDiff === "function" ? f.getDiff() : null;
      } catch (_) {
        rec.changed = null;
      }
      try {
        rec.all = typeof f.collect === "function" ? f.collect() : null;
      } catch (_) {
        rec.all = null;
      }
      out.push(rec);
    }
    if (!out.length) return 0;
    try {
      localStorage.setItem(
        RECOVERY_KEY,
        JSON.stringify({ at: Date.now(), forms: out })
      );
    } catch (err) {
      // Quota, private mode, whatever. We still reload — a stale client is the
      // bigger risk — but say so loudly rather than pretending we saved it.
      console.error("[versionGuard] COULD NOT preserve unsaved work:", err);
      return 0;
    }
    return out.length;
  }

  function readRecovery() {
    var raw = null;
    try {
      raw = localStorage.getItem(RECOVERY_KEY);
    } catch (_) {
      return null;
    }
    if (!raw) return null;
    var rec = null;
    try {
      rec = JSON.parse(raw);
    } catch (_) {
      clearRecovery();
      return null;
    }
    if (!rec || !rec.forms || !rec.forms.length) {
      clearRecovery();
      return null;
    }
    if (Date.now() - (rec.at || 0) > RECOVERY_TTL_MS) {
      clearRecovery();
      return null;
    }
    return rec;
  }

  function clearRecovery() {
    try {
      localStorage.removeItem(RECOVERY_KEY);
    } catch (_) {}
  }

  function formatRecovery(rec) {
    var lines = [];
    lines.push(
      "Unsaved changes preserved " + new Date(rec.at).toLocaleString() + "\n"
    );
    rec.forms.forEach(function (f) {
      lines.push("── " + f.label + "   " + (f.url || ""));
      var d = f.changed || {};
      var keys = Object.keys(d);
      if (!keys.length) {
        lines.push("   (no field-level diff was available)");
      } else {
        keys.forEach(function (k) {
          var pair = d[k] || [];
          lines.push("   " + k);
          lines.push("      was: " + JSON.stringify(pair[0]));
          lines.push("      now: " + JSON.stringify(pair[1]));
        });
      }
      lines.push("");
    });
    return lines.join("\n");
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ── Reload ──────────────────────────────────────────────────────────────────
  /**
   * Reload THROUGH the shell's workspace URL when one is on offer, so an update
   * does not close the user's open case/contact files.
   *
   * location.replace() rather than assign(): it navigates without pushing a
   * history entry (Back should not return to the pre-update page), and it leaves
   * the workspace in the address bar — so a later manual F5 restores the files
   * too. See currentOpenFilesUrl() / restoreOpenFiles() in index.html.
   *
   * Static assets are served no-cache + ETag and sw.js is a no-op passthrough, so
   * a same-URL navigation still revalidates everything. No cache-busting needed.
   */
  function doReload(forced) {
    if (forced) noteForcedReload();
    stopTimers();
    var url = null;
    try {
      if (filesPreserved()) url = window.ycReloadUrl();
    } catch (_) {
      url = null; // never let a serialisation bug block the reload
    }
    try {
      if (url) location.replace(url);
      else location.reload();
    } catch (_) {
      location.href = url || location.href;
    }
  }

  function stopTimers() {
    [pollTimer, noteTimer, hardTimer].forEach(function (t) {
      if (t) clearInterval(t);
    });
    if (pendingTimer) clearTimeout(pendingTimer);
    pollTimer = noteTimer = hardTimer = pendingTimer = null;
  }

  // ── The bottom-right stack (pill + recovery card share it) ──────────────────
  function stack() {
    var el = document.getElementById("vgStack");
    if (el) return el;
    if (!document.body) return null;
    el = document.createElement("div");
    el.id = "vgStack";
    el.style.cssText = [
      "position:fixed",
      "right:14px",
      "bottom:14px",
      "z-index:" + Z_STACK,
      "display:flex",
      "flex-direction:column",
      "gap:8px",
      "align-items:flex-end",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(el);
    return el;
  }

  function cardStyle(accent) {
    return [
      "pointer-events:auto",
      "max-width:300px",
      "background:var(--surface-bg,#fff)",
      "color:var(--text,#2c3e50)",
      "border:1px solid var(--border,#e1e4e8)",
      "border-left:4px solid " + accent,
      "border-radius:8px",
      "padding:9px 12px",
      "box-shadow:0 4px 18px rgba(0,0,0,.18)",
      "font:13px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      "display:flex",
      "align-items:center",
      "gap:10px",
    ].join(";");
  }

  // ── SOFT: the non-dismissable "update available" pill ───────────────────────
  /**
   * "may be lost", not "will be lost": isDirty() only sees YCForms. A half-typed
   * SMS in Communicate is invisible to us, so we must not promise it is safe.
   */
  function noteFor() {
    if (hasUnsavedWork())
      return { t: "Unsaved changes in " + listDirty() + ".", warn: true };
    var n = openFileCount();
    if (n && !filesPreserved())
      return {
        t:
          "Your " +
          n +
          " open file" +
          (n === 1 ? "" : "s") +
          " will close. Unsaved changes may be lost.",
        warn: true,
      };
    if (n)
      return {
        t: "Open files will be restored. Unsaved changes may be lost.",
        warn: false,
      };
    return { t: "Unsaved changes may be lost.", warn: false };
  }

  function updateSoftPill() {
    var el = document.getElementById("vgNote");
    if (!el) return;
    var note = noteFor();
    if (el.textContent === note.t) return;
    el.textContent = note.t;
    el.style.color = note.warn ? AMBER : "var(--text-muted,#6c757d)";
  }

  function showSoftPill() {
    if (document.getElementById("vgPill")) return updateSoftPill();
    var host = stack();
    if (!host) return;

    var pill = document.createElement("div");
    pill.id = "vgPill";
    pill.setAttribute("role", "status");
    pill.style.cssText = cardStyle(BLUE);
    pill.innerHTML =
      "<div>" +
      '<div style="font-weight:700;white-space:nowrap">' +
      '<i class="fa-solid fa-arrows-rotate" style="color:' +
      BLUE +
      ';margin-right:6px"></i>Update available</div>' +
      '<div id="vgNote" style="font-size:12px;margin-top:2px"></div>' +
      "</div>" +
      '<button id="vgReload" style="background:' +
      BLUE +
      ";color:#fff;border:0;border-radius:5px;font:inherit;font-weight:600;" +
      'cursor:pointer;padding:6px 12px;white-space:nowrap;margin-left:auto">Reload</button>';
    host.appendChild(pill);
    updateSoftPill();

    document.getElementById("vgReload").addEventListener("click", function () {
      if (
        hasUnsavedWork() &&
        !window.confirm(
          "Unsaved changes in " + listDirty() + ". Reload and lose them?"
        )
      )
        return;
      doReload(false);
    });
  }

  function removeSoftPill() {
    var el = document.getElementById("vgPill");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function goSoft(v) {
    if (mode === "hard") return;
    if (mode !== "soft") log("update available — was", bootBuild, "now", v.build);
    mode = "soft";
    showSoftPill();
    if (!noteTimer) noteTimer = setInterval(updateSoftPill, NOTE_MS);
    // Polling continues: a floor set later must still be able to escalate us.
  }

  // ── Recovery card (shown on the boot AFTER work was preserved) ──────────────
  function showRecoveryCard() {
    var rec = readRecovery();
    if (!rec || document.getElementById("vgRecover")) return;
    var host = stack();
    if (!host) return;

    var n = rec.forms.length;
    var card = document.createElement("div");
    card.id = "vgRecover";
    card.setAttribute("role", "status");
    card.style.cssText = cardStyle(AMBER);
    card.innerHTML =
      "<div>" +
      '<div style="font-weight:700"><i class="fa-solid fa-life-ring" style="color:' +
      AMBER +
      ';margin-right:6px"></i>Unsaved changes kept</div>' +
      '<div style="font-size:12px;margin-top:2px;color:var(--text-muted,#6c757d)">' +
      n +
      " form" +
      (n === 1 ? "" : "s") +
      " had unsaved edits when the app updated.</div>" +
      "</div>" +
      '<button id="vgRecoverView" style="background:' +
      AMBER +
      ";color:#fff;border:0;border-radius:5px;font:inherit;font-weight:600;" +
      'cursor:pointer;padding:6px 12px;white-space:nowrap;margin-left:auto">View</button>';
    host.appendChild(card);

    document
      .getElementById("vgRecoverView")
      .addEventListener("click", function () {
        var text = formatRecovery(rec);
        if (typeof Swal === "undefined") {
          console.log(text);
          window.alert(text);
          return;
        }
        Swal.fire({
          icon: "info",
          title: "Unsaved changes from before the update",
          html:
            '<p style="margin:0 0 8px;text-align:left;font-size:.9em;color:#6c757d">' +
            "These were <b>not</b> submitted — they're a copy of what was on screen. " +
            "Re-enter anything you still need." +
            "</p>" +
            '<pre style="text-align:left;max-height:45vh;overflow:auto;background:#f6f8fa;' +
            "border:1px solid #e1e4e8;border-radius:6px;padding:10px;font-size:12px;" +
            'white-space:pre-wrap;word-break:break-word">' +
            esc(text) +
            "</pre>",
          width: "42rem",
          confirmButtonText: "Copy",
          confirmButtonColor: BLUE,
          showDenyButton: true,
          denyButtonText: "Discard",
          showCancelButton: true,
          cancelButtonText: "Close",
        }).then(function (r) {
          if (r.isConfirmed) {
            try {
              navigator.clipboard.writeText(text);
            } catch (_) {}
          } else if (r.isDenied) {
            clearRecovery();
            var el = document.getElementById("vgRecover");
            if (el && el.parentNode) el.parentNode.removeChild(el);
          }
        });
      });
  }

  // ── HARD: countdown, then reload REGARDLESS ─────────────────────────────────
  function fmtLeft(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function showHardBanner() {
    if (document.getElementById("vgBanner") || !document.body) return;
    var bar = document.createElement("div");
    bar.id = "vgBanner";
    bar.setAttribute("role", "alert");
    bar.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:" + Z_BANNER,
      "background:" + AMBER,
      "color:#fff",
      "padding:9px 14px",
      "font:600 13.5px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      "display:flex",
      "gap:12px",
      "align-items:center",
      "justify-content:center",
      "flex-wrap:wrap",
      "text-align:center",
      "box-shadow:0 2px 8px rgba(0,0,0,.25)",
    ].join(";");
    bar.innerHTML =
      '<span id="vgBannerMsg"></span>' +
      '<button id="vgReloadNow" style="background:#fff;border:0;border-radius:5px;' +
      'padding:5px 12px;font:inherit;font-weight:700;cursor:pointer"></button>';
    document.body.appendChild(bar);

    document
      .getElementById("vgReloadNow")
      .addEventListener("click", function () {
        if (hasUnsavedWork()) {
          if (
            !window.confirm(
              "Unsaved changes in " +
                listDirty() +
                ".\n\nThey will be kept for recovery, but NOT submitted. Reload now?"
            )
          )
            return;
          preserveUnsavedWork();
        }
        doReload(true);
      });
  }

  function paintHardBanner(phase, ms, busy) {
    var bar = document.getElementById("vgBanner");
    var msg = document.getElementById("vgBannerMsg");
    var btn = document.getElementById("vgReloadNow");
    if (!bar || !msg || !btn) return;

    var isFinal = phase === "final";
    bar.style.background = isFinal ? RED : AMBER;
    btn.style.color = isFinal ? RED : AMBER;
    btn.textContent = "Reload now";

    if (isFinal) {
      msg.textContent =
        "\u26A0 Reloading in " +
        fmtLeft(ms) +
        " \u2014 unsaved changes in " +
        listDirty() +
        ". Save now. Anything unsaved will be kept for recovery, but not submitted.";
      return;
    }

    msg.textContent =
      "\u26A0 YisraCase has been updated. This page will reload in " +
      fmtLeft(ms) +
      (busy
        ? " \u2014 unsaved changes in " + listDirty() + "."
        : filesPreserved()
          ? ". Open files will be restored \u2014 save anything else."
          : " \u2014 save your work, open files will close.");
  }

  function tickHard() {
    var left = deadline - Date.now();
    if (left > 0) {
      paintHardBanner("grace", left, isBusy());
      return;
    }

    // Grace is up. Clean → go.
    if (!isBusy()) {
      doReload(true);
      return;
    }

    // Still dirty. Final, NON-NEGOTIABLE countdown — never an indefinite hold.
    // A single false-positive isDirty() would otherwise block the force forever,
    // which is exactly the bug this replaces.
    if (!finalDeadline) {
      finalDeadline = Date.now() + num(VG.dirtyGraceMs, DIRTY_GRACE_MS);
      log(
        "unsaved work at T-0 in [" +
          dirtyFormLabels().join(", ") +
          "] — final countdown, reloading regardless at",
        new Date(finalDeadline).toLocaleTimeString()
      );
    }
    var fleft = finalDeadline - Date.now();
    if (fleft > 0) {
      paintHardBanner("final", fleft, true);
      return;
    }

    // Time is up. Preserve, then go. Nothing is destroyed silently, and nothing
    // can stop the reload.
    var n = preserveUnsavedWork();
    if (n)
      log(
        "preserved",
        n,
        "unsaved form(s) — read back with VersionGuard.recovery()"
      );
    doReload(true);
  }

  function goHard(v) {
    if (mode === "hard") return;

    // Loop breaker — a forced reload that keeps re-forcing would lock the firm
    // out of the app entirely. Downgrade to the pill and shout in the console.
    if (recentForcedReloads().length >= LOOP_MAX) {
      console.error(
        "[versionGuard] SUPPRESSING forced reload — already forced " +
          recentForcedReloads().length +
          " times in the last few minutes. Check app_settings.min_client_build " +
          "against /api/version.mtime. Falling back to the update banner."
      );
      goSoft(v);
      return;
    }

    mode = "hard";
    stopTimers();
    removeSoftPill();
    finalDeadline = 0;
    deadline = Date.now() + num(VG.graceMs, GRACE_MS);
    log(
      "forced reload — boot mtime",
      bootMtime,
      "< floor",
      v.minBuild,
      "— reloading at",
      new Date(deadline).toLocaleTimeString()
    );

    showHardBanner();
    tickHard();
    hardTimer = setInterval(tickHard, 1000);
  }

  // ── Check ───────────────────────────────────────────────────────────────────
  function check(force) {
    if (mode === "hard" || checking) return;
    var now = Date.now();
    var since = now - lastCheck;

    // Unforced (background poll, window focus): cheap throttle. Safe to drop.
    if (!force && since < RECHECK_MS) return;

    // Forced (tab became visible, back online, bfcache restore, or a response
    // header we didn't recognise). NEVER drop one of these: if we're inside the
    // anti-spam floor, queue it for the moment the floor lifts.
    if (since < HARD_MIN_MS) {
      if (!pendingTimer) {
        pendingTimer = setTimeout(function () {
          pendingTimer = null;
          check(true);
        }, HARD_MIN_MS - since + 50);
      }
      return;
    }

    lastCheck = now;
    checking = true;

    fetchVersion()
      .then(function (v) {
        if (!bootBuild) {
          bootBuild = v.build;
          bootMtime = v.mtime || 0;
          log("booted on build", bootBuild, "(mtime " + bootMtime + ")");
          return null;
        }

        var c = classify(v);
        if (!c) return null;
        if (c === "soft" && mode === "soft") return null;

        // Confirm once. Two reads, 3s apart, must agree before we act — that
        // rides out a traffic-split rollout where two revisions are live.
        return new Promise(function (r) {
          setTimeout(r, CONFIRM_MS);
        })
          .then(fetchVersion)
          .then(function (v2) {
            var c2 = classify(v2);
            if (c2 === "hard") goHard(v2);
            else if (c2 === "soft") goSoft(v2);
            return null;
          });
      })
      .catch(function () {
        /* offline / blip — we'll try again on the next trigger */
      })
      .then(function () {
        checking = false;
      });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Called by apiSend() with the raw Response. Every server response carries
   * X-App-Build (and X-App-Min-Build when a floor is set), so an actively-used
   * stale tab is caught on its very next request at no extra network cost.
   *
   * The headers are only a TRIGGER. X-App-Min-Build comes off a 30s server-side
   * cache and can lag reality in either direction, so we never act on it — we go
   * ask /api/version, which is authoritative.
   */
  VG.noteResponse = function (res) {
    if (mode === "hard" || !bootBuild || !res || !res.headers) return;
    var b, m;
    try {
      b = res.headers.get("X-App-Build");
      m = res.headers.get("X-App-Min-Build");
    } catch (_) {
      return;
    }
    var floor = m ? Number(m) : 0;
    if (floor && bootMtime && bootMtime < floor) {
      check(true);
      return;
    }
    if (mode) return; // soft already showing; the header tells us nothing new
    if (!b || b === bootBuild) return;
    check(true);
  };

  VG.check = function () {
    check(true);
  };

  /**
   * WHICH forms claim to be dirty, and WHICH fields they think changed.
   *
   * Run this when the banner blames you for changes you didn't make. YCForm's
   * isDirty() is a whole-form JSON compare against a load-time snapshot, so a
   * field that normalises itself after load (a select populated late, a date
   * reformatting) shows up here with was/now values that look identical-ish —
   * that's your false positive, and it should be fixed in the form, not here.
   */
  VG.diagnose = function () {
    var forms = allForms();
    if (!forms.length) {
      log("no YCForms found in any frame");
      return [];
    }
    var rows = [];
    forms.forEach(function (x) {
      var dirty = false;
      try {
        dirty = x.f.isDirty();
      } catch (_) {}
      var diff = null;
      if (dirty) {
        try {
          diff = x.f.getDiff();
        } catch (_) {}
      }
      rows.push({
        form: frameLabel(x.w),
        url: framePath(x.w),
        dirty: dirty,
        changed: diff ? Object.keys(diff).join(", ") : "",
      });
      if (dirty && diff) {
        console.groupCollapsed(
          "%c" + frameLabel(x.w) + " %cclaims dirty — " + framePath(x.w),
          "font-weight:700",
          "font-weight:400;color:#888"
        );
        Object.keys(diff).forEach(function (k) {
          console.log(k, "\n  was:", diff[k][0], "\n  now:", diff[k][1]);
        });
        console.groupEnd();
      }
    });
    try {
      console.table(rows);
    } catch (_) {
      console.log(rows);
    }
    return rows;
  };

  VG.recovery = function () {
    var rec = readRecovery();
    if (!rec) {
      log("no preserved unsaved work");
      return null;
    }
    console.log(formatRecovery(rec));
    return rec;
  };

  VG.clearRecovery = clearRecovery;

  VG.reloadNow = function () {
    if (hasUnsavedWork()) preserveUnsavedWork();
    doReload(true);
  };

  /**
   * Simulate a server state — no deploy, no DB. Stubs /api/version only; every
   * other request still goes to the real server. A reload clears it.
   *
   *   VersionGuard.simulate('soft')  → "Update available" pill
   *   VersionGuard.simulate('hard')  → forced-reload countdown
   *   VersionGuard.simulate(false)   → put the real fetch back
   *
   * The UI appears ~3s later (two /api/version reads, CONFIRM_MS apart, have to
   * agree before we act).
   *
   * NOTE: two forced reloads inside five minutes trips the loop breaker and the
   * third is refused BY DESIGN. Testing repeatedly?
   *   sessionStorage.removeItem('vgForcedReloads')
   */
  VG.simulate = function (tier) {
    if (!VG._realFetch) VG._realFetch = window.fetch.bind(window);
    if (!tier) {
      window.fetch = VG._realFetch;
      log("simulation off — real /api/version restored");
      return;
    }
    var base = bootMtime || Date.now();
    window.fetch = function (url, opts) {
      if (String(url).indexOf("/api/version") === -1)
        return VG._realFetch(url, opts);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            build: "SIMULATED-" + tier,
            mtime: base + 1000, // a build newer than the one we booted on
            // A floor ABOVE our boot but AT OR BELOW the served build. Both halves
            // are required — see classify(). 0 = no floor = soft only.
            minBuild: tier === "hard" ? base + 1 : 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    };
    log("simulating a", tier, "update — expect the UI in ~3s");
    check(true);
  };

  VG.info = function () {
    return {
      bootBuild: bootBuild,
      bootMtime: bootMtime,
      mode: mode,
      reloadsIn: deadline ? Math.max(0, deadline - Date.now()) : null,
      finalReloadIn: finalDeadline
        ? Math.max(0, finalDeadline - Date.now())
        : null,
      dirtyForms: dirtyFormLabels(),
      filesPreserved: filesPreserved(),
      forcedReloadsRecently: recentForcedReloads().length,
      hasPreservedWork: !!readRecovery(),
    };
  };

  VG.start = function () {
    if (pollTimer) return; // already started
    showRecoveryCard(); // did a forced reload just save someone's typing?
    check(true); // establishes bootBuild

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
      check(true);
      updateSoftPill();
      if (mode === "hard") tickHard(); // background timers get throttled/frozen
    });
    window.addEventListener("focus", function () {
      check(false);
    });
    window.addEventListener("online", function () {
      check(true);
    });
    window.addEventListener("pageshow", function (e) {
      if (e.persisted) check(true); // bfcache restore — the JS is as old as ever
    });

    pollTimer = setInterval(function () {
      check(false);
    }, POLL_MS);
  };
})();