// tests/campaignDesigner.browser.test.js
//
/**
 * YisraMail C3b — the Designer editor mode in a REAL browser.
 *
 * ── GATED ON PUPPETEER_EXECUTABLE_PATH — SKIPPED OTHERWISE ──────────────────
 * Same opt-in as tests/pdfRenderIntegration.test.js (the CI "Chromium lane"
 * skips): set the env var to a working chromium / chrome-headless-shell.
 * Needs network (the pinned GrapesJS + MJML + Quill + SweetAlert from
 * jsdelivr). On Fred's machine run it through local/heavy-gate.sh's browser
 * slot, never beside another browser run:
 *
 *   PUPPETEER_EXECUTABLE_PATH=~/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell \
 *     npx jest tests/campaignDesigner.browser.test.js
 *
 * The browser runs in a CHILD node process (tests/helpers/campaignDesignerSmoke.js
 * — puppeteer-core is ESM-only, see the pdf test's header); it prints one JSON
 * verdict line with a named boolean per check, asserted below.
 *
 * What it pins (spec: the C3 spike findings, cited by item):
 *   - lazy load: a plain compose fetches no designer library; picking Designer
 *     injects the pinned files with their SRI hashes ("Conditions" 5)
 *   - the canvas CSP, by BEHAVIOUR: a script / handler inserted into the
 *     canvas does not run while the same script in an ordinary frame does, and
 *     stored payloads loaded as project data do not run (Q4 Mitigation A,
 *     "Conditions" 1)
 *   - the footer: marker-only in the template, the export and the saved
 *     payload; its preview shows in the canvas and is never serialized; the Q5
 *     "Blocked" list and all six "Not blocked" closures
 *   - RTE ended before save (Q1 risk); merge tags through the text toolbar, the
 *     compose list and the link trait (Q3); paste as plain text — synthetic AND
 *     the real clipboard; images through the AssetPicker; a 400's rule + detail
 *     shown; Preview / Create carry the compiled body + design_id, never a
 *     signature
 *   - the REAL save validator (C3a's lib/emailDesignRules.js; C3B_VALIDATOR may
 *     point at another copy) accepts the starter, the saved payload, and an
 *     export after EVERY text-toolbar action — a missing validator fails
 * Native drag of a block from the panel is NOT automatable in headless Chrome
 * (no dragstart from mouse input, CDP drag interception included) — a hand
 * check at landing.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const exe = process.env.PUPPETEER_EXECUTABLE_PATH;
const maybe = exe ? describe : describe.skip;

const EXPECTED = [
  'lazy_plain_compose_loads_no_designer_libs',
  'designer_option_present',
  'lazy_designer_loads_pinned_libs_with_sri',
  'signature_disabled_in_designer',
  'blocks_allowlist_only',
  'canvas_control_script_runs',
  'canvas_inserted_script_and_handler_do_not_run',
  'canvas_stored_payloads_do_not_run',
  'canvas_same_origin_script_src_does_not_run',
  'starter_footer_is_marker_only',
  'footer_preview_shows_in_canvas',
  'footer_preview_never_serialized_export',
  'export_matches_server_slot_shape',
  'design_json_has_no_refused_keys',
  'validator_accepts_starter',
  'q5_delete_keys_refused_on_footer',
  'q5_footer_text_not_editable',
  'q5_toolbar_commands_refused_on_footer',
  'q5_style_manager_empty_on_footer',
  'q5_1_mjml_import_removed',
  'q5_2_undo_cannot_pass_the_load',
  'q5_3_canvas_clear_refused',
  'q5_4_footer_pinned_last',
  'q5_5_footer_toolbar_select_parent_only',
  'q5_6_footer_has_no_traits',
  'merge_tags_single_source',
  'merge_tag_rte_toolbar_reaches_export',
  'merge_tag_compose_list_reaches_export',
  'rte_toolbar_actions_exactly',
  'rte_every_action_passes_validator',
  'merge_tag_link_trait_reaches_export',
  'merge_tag_trait_refuses_tag_at_url_start',
  'rte_ended_before_save',
  'rte_ended_by_export_without_blur',
  'save_payload_shape',
  'save_payload_marker_only_no_preview',
  'validator_accepts_saved_payload',
  'save_roundtrip_identical_html',
  'reopened_footer_relocked_history_clear',
  'reopened_design_reads_clean',
  'rejection_surfaced_with_rule_and_detail',
  'paste_synthetic_reduced_to_plain_text',
  'paste_real_clipboard_reduced_to_plain_text',
  'image_dblclick_uses_assetpicker',
  'picker_styles_follow_the_popup_document',
  'image_picker_reopens_after_dismissal',
  'file_drop_on_canvas_refused',
  'preview_renders_designer_body_sandboxed',
  'create_sends_compiled_body_and_design_id',
  'create_designer_body_never_gets_signature',
  'no_console_errors_or_page_errors',
].sort();

maybe('campaign.html Designer mode — real browser (subprocess)', () => {
  let verdict;

  beforeAll(() => {
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'campaignDesignerSmoke.js')], {
        env: process.env, encoding: 'utf8', timeout: 280000, maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      stdout = String(err.stdout || '');   // a failed check exits 1 and still prints the verdict
      if (!stdout.trim()) throw new Error(`campaignDesignerSmoke died: ${err.stderr || err.message}`);
    }
    verdict = JSON.parse(stdout.trim().split('\n').pop());
  }, 300000);

  test('the run completed without a harness error', () => {
    expect(verdict.errors).toEqual([]);
  });

  test('every named check ran', () => {
    expect(Object.keys(verdict.checks).sort()).toEqual(EXPECTED);
  });

  test('every check passed', () => {
    const failed = Object.entries(verdict.checks).filter(([, v]) => v !== true).map(([k]) => k);
    expect({ failed, info: failed.length ? verdict.info : undefined }).toEqual({ failed: [], info: undefined });
  });
});
