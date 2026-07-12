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
 *   A small pill, bottom-right: "Update available — Reload".
 *   NON-DISMISSABLE. No ✕, no "Later". The only thing that removes it is a
 *   reload. Nothing is ever taken from the user — but they cannot quietly decide
 *   to keep running last month's code either.
 *
 * HARD — opt-in, per incident. Set app_settings.min_client_build to a date.
 *   A non-blocking banner with a live countdown (GRACE_MS, default 15 minutes),
 *   then the page reloads itself. For when an old client is genuinely dangerous.
 *
 *   The banner is deliberately NOT a modal. A grace period only means something
 *   if the user can actually use the app during it — a blocking dialog counting
 *   down for fifteen minutes is not a grace period, it is a fifteen-minute
 *   outage in which they are locked out of the Save button.
 *
 * Reloads preserve the workspace
 * ------------------------------
 * We never call location.reload() blind. index.html exposes window.ycReloadUrl(),
 * which serialises the open case/contact files and the active view into a URL;
 * we location.replace() to that instead. So an update costs the user nothing but
 * a second, and the address bar keeps the workspace — meaning a plain F5 restores
 * it too. If that hook is absent we fall back to a plain reload and the pill says
 * so honestly ("Your 3 open files will close").
 *
 * Why there is still no silent auto-reload
 * ---------------------------------------
 * hasUnsavedWork() can only see YCForms. A half-typed SMS in Communicate, a
 * filled-in search, an open picker — none of that is visible to us, and all of it
 * would vanish without a trace. A banner the user acts on is honest; a silent
 * reload that eats their message is not.
 *
 * When we re-check
 * ----------------
 *   tab becomes visible (the big one — catches a tab idle for days), window
 *   focus, network back online, bfcache restore, a POLL_MS backstop, and free on
 *   any apiSend() response via X-App-Build / X-App-Min-Build.
 *
 * Loop breaker
 * ------------
 * A bad floor value (or a rollback to below it) could cause reload → still stale
 * → reload, locking the firm out of the app. Two defences: never force a reload
 * into a build that is itself below the floor, and hard-stop after LOOP_MAX
 * forced reloads in LOOP_WINDOW_MS.
 *
 * Only ever runs in the top frame — reloading the shell reloads every iframe.
 *
 * Console:
 *   VersionGuard.info()                    → current state
 *   VersionGuard.check()                   → force a check right now
 *   VersionGuard.isBusy = () => boolean    → add your own "don't force yet" test
 */
(function () {
  "use strict";

  // The shell owns this. An iframe reloading itself would fix nothing.
  if (window.top !== window.self) return;

  // ── Tunables ────────────────────────────────────────────────────────────────
  var GRACE_MS = 15 * 60 * 1000; // HARD: time to save / finish a thought
  var POLL_MS = 5 * 60 * 1000; // backstop poll for a visible-but-idle tab
  var RECHECK_MS = 30 * 1000; // min gap between *unforced* checks
  var HARD_MIN_MS = 5 * 1000; // min gap between ANY two checks (anti-spam)
  var CONFIRM_MS = 3 * 1000; // re-ask before acting (rides out a rollout)
  var NOTE_MS = 20 * 1000; // how often the pill re-checks its warning line

  // What happens if the grace period expires and there is STILL unsaved work.
  // null  → hold. Keep the banner up and reload the moment they save. We do not
  //         destroy a half-typed intake form to win an argument about staleness.
  // <ms>  → give up and reload anyway that long after the deadline.
  var FORCE_AFTER_MS = null;

  // Z-INDEX — house convention, from #ycSystemAlertBar in index.html:
  //   shell chrome ≤ 100  <  system alert bar 999  <  SweetAlert2 1060
  // Both of ours sit in that band: above the header and sidebar, but NEVER over a
  // SweetAlert (the login prompt lives there).
  var Z_PILL = 999;
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
  var deadline = 0; // HARD: wall-clock ms when the reload lands
  var overdueSince = 0; // HARD: when the deadline passed with work still unsaved
  var pollTimer = null;
  var pendingTimer = null; // a forced check deferred past the anti-spam floor
  var noteTimer = null; // keeps the pill's warning line accurate
  var hardTimer = null; // 1Hz countdown tick

  var VG = {};
  window.VersionGuard = VG;

  function log() {
    try {
      console.info.apply(
        console,
        ["[versionGuard]"].concat([].slice.call(arguments))
      );
    } catch (_) {}
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
   * Note the floor-usability test. If the build currently being SERVED is itself
   * older than the floor (a bad Settings value, or a rollback to below it), then
   * forcing a reload would land the user right back where they were — an infinite
   * reload loop. The floor is nonsense in that case: ignore it, fall through to
   * the soft pill.
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

  // ── Inspecting the shell ────────────────────────────────────────────────────
  // Frames nest a couple of levels (index.html → case.html → forms/*.html,
  // index.html → automationManager.html → automation/*.html). yc-forms sets
  // window.ycForm on its own frame and exposes isDirty().
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

  function hasUnsavedWork() {
    var frames = collectFrames(window, [], 0);
    for (var i = 0; i < frames.length; i++) {
      try {
        var f = frames[i].ycForm;
        if (f && typeof f.isDirty === "function" && f.isDirty()) return true;
      } catch (_) {}
    }
    return false;
  }

  // NB: scoped to #tabOpenFiles on purpose. `.file-button` is also used INSIDE
  // case.html / contact.html for their own New Appointment / New Event buttons —
  // those live in iframes, but the scope keeps this honest regardless.
  function openFileCount() {
    try {
      return document.querySelectorAll("#tabOpenFiles .file-button").length;
    } catch (_) {
      return 0;
    }
  }

  // Does the shell offer a workspace-preserving reload URL? (index.html does.)
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

  // ── Reload ──────────────────────────────────────────────────────────────────
  /**
   * Reload THROUGH the shell's workspace URL when one is on offer, so an update
   * does not close the user's open case/contact files.
   *
   * location.replace() rather than assign(): it navigates without pushing a
   * history entry (Back should not take you to the pre-update page), and it
   * leaves the workspace in the address bar — so a later manual F5 restores the
   * files too. See currentOpenFilesUrl() / restoreOpenFiles() in index.html.
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
    } catch (err) {
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
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (noteTimer) {
      clearInterval(noteTimer);
      noteTimer = null;
    }
    if (hardTimer) {
      clearInterval(hardTimer);
      hardTimer = null;
    }
  }

  // ── SOFT: the non-dismissable "update available" pill ───────────────────────
  //
  // No ✕. No "Later". It appears on the first deploy past this tab's build and
  // the only thing that removes it is a reload. A dismissable nag gets dismissed,
  // and then someone is on a five-week-old page with no signal at all.

  /**
   * The honest one-liner about what a reload costs.
   *
   * "may be lost" rather than "will be lost" on purpose: hasUnsavedWork() only
   * sees YCForms. A half-typed SMS in Communicate, a filled-in search, an open
   * picker — we cannot see any of it, so we must not promise it is safe. Better a
   * mild caveat they can act on than a confident lie.
   *
   * @returns {{t:string, warn:boolean}}
   */
  function noteFor() {
    if (hasUnsavedWork())
      return { t: "You have unsaved changes — save first.", warn: true };

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
    el.style.display = "block";
    el.style.color = note.warn ? AMBER : "var(--text-muted,#6c757d)";
  }

  function showSoftPill() {
    if (document.getElementById("vgPill")) return updateSoftPill();
    if (!document.body) return;

    var pill = document.createElement("div");
    pill.id = "vgPill";
    pill.setAttribute("role", "status");
    pill.style.cssText = [
      "position:fixed",
      "right:14px",
      "bottom:14px",
      "z-index:" + Z_PILL,
      "max-width:280px",
      "background:var(--surface-bg,#fff)",
      "color:var(--text,#2c3e50)",
      "border:1px solid var(--border,#e1e4e8)",
      "border-left:4px solid " + BLUE,
      "border-radius:8px",
      "padding:9px 12px",
      "box-shadow:0 4px 18px rgba(0,0,0,.18)",
      "font:13px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      "display:flex",
      "align-items:center",
      "gap:10px",
    ].join(";");

    pill.innerHTML =
      "<div>" +
      '<div style="font-weight:700;white-space:nowrap">' +
      '<i class="fa-solid fa-arrows-rotate" style="color:' +
      BLUE +
      ';margin-right:6px"></i>' +
      "Update available</div>" +
      '<div id="vgNote" style="font-size:12px;margin-top:2px"></div>' +
      "</div>" +
      '<button id="vgReload" style="background:' +
      BLUE +
      ";color:#fff;border:0;border-radius:5px;font:inherit;font-weight:600;" +
      'cursor:pointer;padding:6px 12px;white-space:nowrap;margin-left:auto">Reload</button>';

    document.body.appendChild(pill);
    updateSoftPill();

    document.getElementById("vgReload").addEventListener("click", function () {
      if (
        hasUnsavedWork() &&
        !window.confirm("You have unsaved changes. Reload and lose them?")
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
    // Keep the warning line honest as they open/close files and edit forms.
    if (!noteTimer) noteTimer = setInterval(updateSoftPill, NOTE_MS);
    // Polling continues: a floor set later must still be able to escalate us.
  }

  // ── HARD: non-blocking countdown, then reload ───────────────────────────────
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
        if (
          hasUnsavedWork() &&
          !window.confirm("You have unsaved changes. Reload and lose them?")
        )
          return;
        doReload(true);
      });
  }

  function paintHardBanner(leftMs, busy) {
    var bar = document.getElementById("vgBanner");
    var msg = document.getElementById("vgBannerMsg");
    var btn = document.getElementById("vgReloadNow");
    if (!bar || !msg || !btn) return;

    var overdue = leftMs <= 0;
    bar.style.background = overdue ? RED : AMBER;
    btn.style.color = overdue ? RED : AMBER;

    if (overdue) {
      // Only reachable with unsaved work — a clean tab reloads on the tick.
      msg.textContent =
        "\u26A0 YisraCase must reload, but you still have unsaved changes. " +
        "Save them and this page will reload itself.";
      btn.textContent = "Discard & reload";
      return;
    }

    msg.textContent =
      "\u26A0 YisraCase has been updated. This page will reload in " +
      fmtLeft(leftMs) +
      (busy
        ? " \u2014 you have unsaved changes."
        : filesPreserved()
          ? ". Open files will be restored \u2014 save anything else."
          : " \u2014 save your work, open files will close.");
    btn.textContent = "Reload now";
  }

  function tickHard() {
    var left = deadline - Date.now();
    var busy = isBusy();

    if (left > 0) {
      paintHardBanner(left, busy);
      return;
    }

    if (!busy) {
      doReload(true);
      return;
    }

    // The grace period expired and there is STILL unsaved work. Hold. We are not
    // destroying someone's half-typed intake form to win an argument about
    // staleness — the banner stays up and we reload the instant they save.
    // FORCE_AFTER_MS is the escape hatch if you want a hard cap.
    if (!overdueSince) overdueSince = Date.now();
    if (FORCE_AFTER_MS && Date.now() - overdueSince >= FORCE_AFTER_MS) {
      log("unsaved work held the reload past the cap — forcing anyway");
      doReload(true);
      return;
    }
    paintHardBanner(0, true);
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
    deadline = Date.now() + GRACE_MS;
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

    // Unforced (background poll, window focus): cheap throttle. Safe to drop —
    // the next poll comes round soon enough.
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
        // First successful call establishes what "current" means for this tab.
        if (!bootBuild) {
          bootBuild = v.build;
          bootMtime = v.mtime || 0;
          log("booted on build", bootBuild, "(mtime " + bootMtime + ")");
          return null;
        }

        var c = classify(v);
        if (!c) return null;
        if (c === "soft" && mode === "soft") return null; // pill already up

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
   * cache and can lag reality in either direction, so we never act on it — we
   * just go ask /api/version, which is authoritative. Worst case a stale header
   * costs one wasted round-trip (and check() throttles even that).
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

    // A floor beats everything — check it even when the soft pill is already up.
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

  VG.info = function () {
    return {
      bootBuild: bootBuild,
      bootMtime: bootMtime,
      mode: mode,
      reloadsIn: deadline ? Math.max(0, deadline - Date.now()) : null,
      filesPreserved: filesPreserved(),
      forcedReloadsRecently: recentForcedReloads().length,
    };
  };

  VG.start = function () {
    if (pollTimer) return; // already started
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