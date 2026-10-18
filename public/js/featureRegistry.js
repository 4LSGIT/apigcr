/* public/js/featureRegistry.js — the shell's launcher registry (ui-custom S1).
 *
 * PURE DATA. No DOM access, no functions, no side effects beyond the two
 * globals below. Loaded by a plain <script src> in index.html's <head>; the
 * renderer is the ycLauncher block right after that include. It turns these
 * two structures into the markup of four launcher surfaces, at parse time, in
 * the exact place that markup used to be written by hand:
 *
 *   home     #tabHome's .home-btn tiles and the .home-break row breaks between
 *            them, inside its .home-grid flex container (ui-custom S4a)
 *   sidebar  the Records / Actions / Settings sections of #appSidebar
 *            (Home, Open Files, the spacer, the version stamp and the collapse
 *            bar are shell chrome and stay in index.html)
 *   more     #tabMore's .big-button grid and its <br><br> row breaks
 *   admin    #tabAdmin's .big-button grid and its <br><br> row breaks
 *   homeIcons / moreIcons / adminIcons   (ui-custom S6c) the ICON ROW under
 *            each page's grid: small icon-only buttons (Casey's paw under
 *            More, All under Home), inside the page's .<page>-egg-row div.
 *            { item } entries only — no breaks, no labels, at most 12.
 *
 * The rendered markup is meant to be IDENTICAL to the hand-written markup it
 * replaced (Home's row breaks excepted: S4a made them .home-break sentinels
 * in a flex container, pixel-identical on screen) — every id, data-tab,
 * data-target, onclick and inline style — so
 * nothing that finds these elements (updateSidebarActive,
 * loadUserContext, ensureStrip, the hover-animation and panel listeners, the
 * mobile CSS) can tell the difference. Change an attribute here and you change
 * it in the page.
 *
 * ── window.FEATURE_REGISTRY ── one entry per launcher button, keyed by its
 * stable id. The id is the item's name everywhere from here on (ui_config's
 * firm registry_overrides — hidden / renames / locked —, each user's Home /
 * sidebar layout (S4a), entitlement denies): never rename one, and never
 * reuse a retired one. Retired: moreClioCode (2026-10-15 — Get Clio Code is the
 * firm tool `clio-code` now; ref/tools/clio-code.html); custom (2026-10-16 —
 * the per-user custom tab: every one became a launcher button, ui-custom
 * S5e). Grid items carry a surface prefix (more* / admin*); home/sidebar items
 * do not. Fields — all optional except label and icon:
 *
 *   label          visible text, PLAIN (the renderer escapes it)
 *   surfaceLabels  { <surface>: label } — per-surface label override
 *                  (Bills reads "Billing" on Home)
 *   title          tooltip. Sidebar items always carry one: this, else the
 *                  label (skinny mode shows it). Grid items: only when set.
 *                  Home tiles never carry one. An icon-row button always does
 *                  (this, else the label), and the same text is its
 *                  aria-label — the button shows no text.
 *   icon           Font Awesome solid slug, without "fa-" (fa-solid fa-<icon>)
 *   onclick        handler source, VERBATIM — rendered as the onclick
 *                  attribute (action items)
 *   target, group  panel items: data-target / data-exclusive-group. They have
 *                  NO onclick; the delegated [data-target] listener in
 *                  index.html opens the panel. Keep it that way.
 *   hoverAnim      data-hover-anim: Font Awesome animation class(es) played on
 *                  the icon while the pointer is over the button (the
 *                  hover-animation script in index.html)
 *   styleVars      the button's inline style, VERBATIM — the --fa-* custom
 *                  properties that tune the hover animation's speed/axis
 *   placeholder    true → data-placeholder: a grid square that opens nothing;
 *                  ensureStrip() leaves it out of the pill strip. Unused right
 *                  now; the mechanism is kept for the next gap in a grid.
 *   tab, tabAlso   sidebar: data-tab / data-tab-also, what
 *                  updateSidebarActive() matches to light the item. An item
 *                  that opens a dialog rather than a tab (New Client, Help &
 *                  Support) has NO tab, so it can never steal the highlight.
 *   domIds         { <surface>: element id } — ids other code looks up by
 *   badge          sidebar: { id, title } — the count pill, hidden until set
 *   defaultHidden  rendered with style="display:none" (Admin: loadUserContext
 *                  reveals it once the effective registry lists it)
 *   gate           (ui-custom S6c) what the item's SERVER routes enforce, so
 *                  the launcher never shows a tile that answers 403: 'su'
 *                  (lib/auth.superuser — the su role) or a lib/capabilities
 *                  name (requireAuth({ can })). Absent = open to every staff
 *                  user. The shell's ycLauncher.computeEffective applies it
 *                  with the user's roles by lib/capabilities' rule (su passes
 *                  everything); it follows the ITEM wherever a layout puts it.
 *                  Visibility only: the route keeps its own gate. Every Admin
 *                  tile's value is classified from its routes' middleware
 *                  (tests/launcherS6c.test.js pins the set).
 *
 * An item placed in NO default layout (myTasks, logout — ui-custom S6b) is
 * still a launcher item: the effective registry lists it in group "More
 * actions" (after the sidebar's sections, before More), and a user can place
 * it. Which ids may be unplaced is pinned by tests/featureRegistry.test.js.
 *
 * ── window.DEFAULT_LAYOUTS ── the shipped arrangement of each surface, in
 * order: { item: '<id>' } | { break: true } | { label: '<text>' }.
 *   break: a row break — a .home-break sentinel on Home (5px tall), <br><br>
 *          on the grids. Not in an icon row.
 *   label: a sidebar section heading.
 * One item may appear on several surfaces (Cases is on Home and the sidebar):
 * it is ONE registry entry; the surface differences (fa-2xl on tiles, data-tab
 * on the sidebar) are the renderer's rules, not duplicated data.
 * These are the BASE layouts the firm's default layout (ui_config firm
 * `layout`, ui-custom S6c: every surface here) and then a user's own Home /
 * sidebar / Home icon-row layout apply to, in that order
 * (ycLauncher.resolveLayout, S4a): an item added here also appears for a firm
 * or a user who has rearranged that surface, next to its neighbour here.
 * The firm's and the users' own PAGES (ui-custom S6c-5: items of kind
 * { type:'page' }) have no base here: their tiles and icon rows live in that
 * tier's `layout.pages[<id>]` and are drawn by ycLauncher.buildPages as
 * neutrals, never mounted.
 */
window.FEATURE_REGISTRY = {

  // ── Home + sidebar ────────────────────────────────────────────────────
  cases: {
    label: 'Cases', icon: 'landmark',
    onclick: 'openCasesTab()', tab: 'tabCases',
  },
  contacts: {
    label: 'Contacts', icon: 'users',
    onclick: 'openContactsTab()', tab: 'tabContacts',
  },
  appts: {
    label: 'Appointments', icon: 'calendar-days',
    onclick: 'openApptsTab()', tab: 'tabAppts',
  },
  // Unified Events U9. ONE list over both tables — the appointment and the
  // hearing and the deadline, in one window, in one vocabulary. It sits
  // between the two lists it unifies rather than replacing them: this release
  // ships all three side by side so the new one can be checked against the
  // old two. Retiring them is U9b.
  calendar: {
    label: 'Calendar', icon: 'calendar-week',
    onclick: 'openCalendarTab()', tab: 'tabCalendar',
  },
  events: {
    label: 'Events', icon: 'flag',
    onclick: 'openEventsTab()', tab: 'tabEvents',
  },
  // The badge is the current user's overdue + due-today count —
  // tasksBadgeRefresh() in index.html.
  tasks: {
    label: 'Tasks', icon: 'list',
    onclick: "openMainTab('tabTasks')", tab: 'tabTasks',
    badge: { id: 'sbTasksBadge', title: 'Your overdue + due-today tasks' },
  },
  // Comms hub (mailbox arc S2): every mailbox and phone line you can read, in
  // one place. Shown to everyone, like every other tab: the hub's Email and
  // Phone tabs each say so when nothing is shared with you. (It used to wait
  // for GET /api/mail/mailboxes, so it popped in last and hid from phone-only
  // readers.) The badge is your INBOX unread over your boxes — commsBadgeSet
  // in index.html. Took Settings' place in the sidebar and on Home 2026-10-11
  // (Settings: More Features, or "Hi, <name>!").
  comms: {
    label: 'Comms', icon: 'comments',
    onclick: "openMainTab('tabComms')", tab: 'tabComms',
    domIds: { sidebar: 'sbComms', home: 'homeComms' },
    badge: { id: 'sbCommsBadge', title: 'Unread in the inboxes you can read' },
  },
  log: {
    label: 'Log', icon: 'box-archive',
    onclick: 'openLogsTab()', tab: 'tabLogs',
  },
  bills: {
    label: 'Bills', surfaceLabels: { home: 'Billing' }, icon: 'file-invoice-dollar',
    onclick: "openMainTab('tabBills')", tab: 'tabBills',
  },
  pipeline: {
    label: 'Pipeline Board', icon: 'table-columns',
    onclick: "openMainTab('tabPipeline')", tab: 'tabPipeline',
  },
  // A dialog, not a tab: no data-tab.
  newClient: {
    label: 'New Client', icon: 'user-plus',
    onclick: 'newContact()',
  },
  // Hidden until loadUserContext() shows it — to whoever the firm's
  // visible_to on this id admits (live: it and admin; su always), ui-custom
  // S6c, Fred's ruling 2026-10-16. No gate of its own: the Admin PAGE is
  // visibility; each Admin TILE carries the gate its routes enforce.
  admin: {
    label: 'Admin', icon: 'mug-hot',
    onclick: "openMainTab('tabAdmin')", tab: 'tabAdmin',
    domIds: { sidebar: 'sbAdmin' }, defaultHidden: true,
  },
  // data-tab-also: Settings lives in More Features now (its tile opens
  // tabSettings), so More Features is the item lit while you are there.
  moreFeatures: {
    label: 'More Features', icon: 'grip',
    onclick: "openMainTab('tabMore')", tab: 'tabMore', tabAlso: 'tabSettings',
  },
  // Help & Support. Deliberately has NO data-tab: it opens a dialog, it does
  // not navigate, so updateSidebarActive() must never give it the active
  // highlight and steal it from the view you are actually on. Being a
  // .sb-item is enough for the skinny-mode tooltip to pick it up.
  // Implementation: the reportIssue() block near the bottom of index.html.
  helpSupport: {
    label: 'Help & Support', icon: 'life-ring',
    onclick: 'reportIssue()',
  },
  // All (ui-custom S2; an item since S6c): every feature this user has,
  // searchable — #tabAll. GUARANTEED (Fred's ruling 2026-10-16): undeniable
  // like Settings and Help (entitlementService UNDENIABLE — no hide, deny or
  // visible_to), and the layout resolver keeps it in Home's icon row whatever
  // a firm or user layout says (the other small items may sit around it). The
  // sidebar's copy is an ordinary item a layout may remove; Ctrl-K lists it.
  all: {
    label: 'All', title: 'All features', icon: 'table-cells',
    onclick: "openMainTab('tabAll')", tab: 'tabAll',
    domIds: { sidebar: 'sbAll', homeIcons: 'homeAll' },
  },

  // ── More Features grid ────────────────────────────────────────────────
  moreManuals: {
    label: 'Manuals', icon: 'book', target: 'manualsDiv', group: 'more',
    hoverAnim: 'fa-flip', styleVars: '--fa-animation-duration:1.4s',
  },
  // Opens its own main tab (tabSettings) — not a panel.
  moreSettings: {
    label: 'Settings', icon: 'gear', onclick: "openMainTab('tabSettings')",
    hoverAnim: 'fa-spin', styleVars: '--fa-animation-duration:3s',
  },
  moreTheme: {
    label: 'Theme', icon: 'palette', target: 'themeCustomDiv', group: 'more',
    hoverAnim: 'fa-spin', styleVars: '--fa-animation-duration:2.4s',
  },
  moreFeatureRequests: {
    label: 'Feature Requests', icon: 'lightbulb', target: 'featureRequestsDiv', group: 'more',
    hoverAnim: 'fa-beat-fade', styleVars: '--fa-beat-fade-scale:1.15; --fa-animation-duration:1.1s',
  },
  // Simple Forms and Form Builder are two surfaces over the SAME
  // form_templates records — the simple one hands off to the full one for
  // tabs / repeaters / code. Its "Open in Form Builder" button clicks the
  // formBuilderDiv tile, so BOTH stay in the "more" exclusive group.
  moreSimpleForms: {
    label: 'Simple Forms', icon: 'wand-magic-sparkles', target: 'formSimpleDiv', group: 'more',
    hoverAnim: 'fa-bounce', styleVars: '--fa-animation-duration:1.3s',
  },
  moreFormBuilder: {
    label: 'Form Builder', icon: 'pen-to-square', target: 'formBuilderDiv', group: 'more',
    hoverAnim: 'fa-bounce', styleVars: '--fa-animation-duration:1.4s',
  },
  moreFormInbox: {
    label: 'Form Inbox', icon: 'inbox', target: 'formInboxDiv', group: 'more',
    hoverAnim: 'fa-bounce', styleVars: '--fa-animation-duration:1.5s',
  },
  morePortalManager: {
    label: 'Portal Manager', icon: 'door-open', target: 'portalManagerDiv', group: 'more',
    hoverAnim: 'fa-flip', styleVars: '--fa-animation-duration:1.6s',
  },
  moreSignatures: {
    label: 'Signatures', icon: 'file-signature', target: 'esignDashboardDiv', group: 'more',
    hoverAnim: 'fa-flip', styleVars: '--fa-animation-duration:1.6s; --fa-animation-direction:reverse',
  },
  moreAssetManager: {
    label: 'Asset Manager', icon: 'photo-film', target: 'assetManagerDiv', group: 'more',
    hoverAnim: 'fa-beat-fade', styleVars: '--fa-beat-fade-opacity:0.5; --fa-animation-duration:2s',
  },
  moreVideoManager: {
    label: 'Video Manager', icon: 'video', target: 'videoManagerDiv', group: 'more',
    hoverAnim: 'fa-beat', styleVars: '--fa-beat-scale:1.15; --fa-animation-duration:0.9s',
  },
  // Documents (S3): the registry over the firm's Dropbox estate, searchable
  // and linkable to cases. It took row 3's old data-placeholder square.
  moreDocuments: {
    label: 'Documents', icon: 'folder-open', target: 'documentsDiv', group: 'more',
    hoverAnim: 'fa-flip', styleVars: '--fa-animation-duration:1.8s',
  },
  // Label renamed "YisraCase Config" (CFG-1); the id follows the panel, not
  // the label.
  moreCaseConfig: {
    label: 'YisraCase Config', icon: 'sliders', target: 'caseConfigDiv', group: 'more',
    hoverAnim: 'fa-fade', styleVars: '--fa-animation-duration:1.4s',
  },
  moreChecklists: {
    label: 'Notes & Lists', icon: 'list-check', target: 'checklistsDiv', group: 'more',
    hoverAnim: 'fa-shake', styleVars: '--fa-animation-duration:0.8s',
  },
  moreAutomations: {
    label: 'Automations', icon: 'robot', target: 'automationsDiv', group: 'more',
    hoverAnim: 'fa-shake', styleVars: '--fa-animation-duration:1.2s',
  },
  moreViews: {
    label: 'Views', icon: 'table-list', target: 'viewsDiv', group: 'more',
    hoverAnim: 'fa-beat', styleVars: '--fa-beat-scale:1.12; --fa-animation-duration:1.2s',
  },
  moreAvailability: {
    label: 'Availability Manager', icon: 'calendar', target: 'availabilityDiv', group: 'more',
    hoverAnim: 'fa-fade', styleVars: '--fa-animation-duration:1.6s',
  },
  moreBooking: {
    label: 'Booking Manager', icon: 'calendar-week', target: 'bookingDiv', group: 'more',
    hoverAnim: 'fa-flip', styleVars: '--fa-animation-duration:2s; --fa-flip-y:0; --fa-flip-x:1',
  },
  moreCourtPreview: {
    label: 'Court Preview', icon: 'gavel', target: 'courtPreviewDiv', group: 'more',
    hoverAnim: 'fa-shake', styleVars: '--fa-animation-duration:0.6s',
  },
  moreCampaigns: {
    label: 'Campaigns', icon: 'envelopes-bulk', target: 'campaignsDiv', group: 'more',
    hoverAnim: 'fa-shake', styleVars: '--fa-animation-duration:0.9s',
  },
  moreRedirects: {
    label: 'Redirects Manager', icon: 'signs-post', target: 'redirectsDiv', group: 'more',
    hoverAnim: 'fa-spin', styleVars: '--fa-animation-duration:2.5s',
  },
  moreLandingPages: {
    label: 'Landing Pages', icon: 'sitemap', target: 'landingPagesDiv', group: 'more',
    hoverAnim: 'fa-bounce', styleVars: '--fa-animation-duration:1.4s',
  },
  moreReports: {
    label: 'Reports', icon: 'chart-column', target: 'reportsDiv', group: 'more',
    hoverAnim: 'fa-beat', styleVars: '--fa-beat-scale:1.12; --fa-animation-duration:1.3s',
  },

  // ── Admin grid ────────────────────────────────────────────────────────
  // gate: 'su' = every route the tile's page calls is superuserOnly /
  // superuserOnlyFor (lib/auth.superuser) or isSuperuser — classified route
  // by route in ui-custom S6c (the table is in local/ui-custom/S6c12_worker_report.md).
  // Etch is a static page with no API: no gate.
  adminReadonlyKeys: {
    label: 'Session Keys (SU)', icon: 'eye', target: 'readonlyKeysDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-fade', styleVars: '--fa-animation-duration:1.2s',
  },
  adminApiKeys: {
    label: 'API Keys (SU)', icon: 'key', target: 'apiKeysDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-flip', styleVars: '--fa-animation-duration:1.8s; --fa-flip-y:0; --fa-flip-x:1',
  },
  adminCtaLinks: {
    label: 'CTA Links (SU)', icon: 'hand-pointer', target: 'ctaLinksDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-beat', styleVars: '--fa-beat-scale:1.15; --fa-animation-duration:0.9s',
  },
  adminDbConsole: {
    label: 'DB Console (SU)', icon: 'database', target: 'dbConsoleDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-beat-fade', styleVars: '--fa-beat-fade-opacity:0.55; --fa-animation-duration:1.4s',
  },
  adminConnections: {
    label: 'Connections (SU)', icon: 'plug', target: 'connectionsDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-bounce', styleVars: '--fa-animation-duration:1.2s',
  },
  adminApiTester: {
    label: 'API Tester (SU)', icon: 'vial', target: 'apiTesterDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-shake', styleVars: '--fa-animation-duration:0.7s',
  },
  adminTools: {
    label: 'Tools (SU)', icon: 'screwdriver-wrench', target: 'toolsDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-beat', styleVars: '--fa-beat-scale:1.2; --fa-animation-duration:1.1s',
  },
  // A Swal hosting a page (etchSwal() in index.html), not a panel.
  adminEtch: {
    label: 'Etch', icon: 'pen-ruler', onclick: 'etchSwal()',
    hoverAnim: 'fa-shake', styleVars: '--fa-animation-duration:1.5s',
  },
  adminScratch: {
    label: 'Scratch (SU)', icon: 'box-archive', target: 'scratchBrowserDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-fade', styleVars: '--fa-animation-duration:1.6s',
  },
  adminUsers: {
    label: 'Users', icon: 'users-gear', target: 'usersDiv', group: 'admin',
    gate: 'users.impersonate',
    hoverAnim: 'fa-spin', styleVars: '--fa-animation-duration:3s',
  },
  adminSystemAlerts: {
    label: 'System Alerts (SU)', icon: 'triangle-exclamation', target: 'systemAlertsDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-beat', styleVars: '--fa-beat-scale:1.25; --fa-animation-duration:0.7s',
  },
  // NOT "(SU)" like its neighbours on purpose: reading what staff reported is
  // not meant to be a superuser act — though routes/api.issueReports.js gates
  // it SU-only today (access A2 retired the admin tier that once shared it),
  // hence gate 'su' until that route takes a capability.
  adminSupportInbox: {
    label: 'Support Inbox', icon: 'life-ring', target: 'issueReportsDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-spin', styleVars: '--fa-animation-duration:3s',
  },
  adminMailboxes: {
    label: 'Mailboxes (SU)', icon: 'envelope-open-text', target: 'mailboxesDiv', group: 'admin',
    gate: 'su',
    hoverAnim: 'fa-bounce', styleVars: '--fa-animation-duration:1.2s',
  },

  // ── In no default layout: "More actions" (ui-custom S6b) ─────────────────
  // Launcher items for things the shell already does from fixed chrome. They
  // sit in NO default layout, so no surface changes; computeEffective lists
  // them in their own group (All, the palette, the shortcut picker) and a
  // user can place them on Home or the sidebar (a neutral shortcut). With no
  // element to click, ycLauncher.exec runs them through a CLOSED dispatch
  // (NO_ELEMENT in index.html's ycLauncher block) — never this onclick
  // string, which is what a default surface would render if one ever placed
  // them. The header's My Tasks (overdue badge) and Log Out stay as they
  // are: fixed chrome. Casey left this set in S6c: More's paw IS its element
  // now (DEFAULT_LAYOUTS.moreIcons), rendered with the paw's exact markup.
  myTasks: {
    label: 'My Tasks', icon: 'list',
    onclick: "openTasksTab({assigned_to:user.user,status:'Incomplete',defer:'active'})",
  },
  logout: {
    label: 'Log out', icon: 'right-from-bracket',
    onclick: 'confirmLogout()',
  },
  // Casey the YisraCat (ui-custom S6b item; placed in More's icon row by
  // S6c). toggleMascot() is the old tile's handler: the first press summons,
  // a press while Casey is out opens the trick panel — the panel's ONLY
  // entry; the logo long-press only summons and dismisses.
  casey: {
    label: 'Casey', title: 'Casey the YisraCat', icon: 'paw',
    onclick: 'toggleMascot()',
  },
};

window.DEFAULT_LAYOUTS = {

  // Home: three tiles per row; break = a .home-break sentinel (a 5px row gap).
  // The breaks make the rows: the Home grid itself wraps only at the screen
  // edge (ui-custom S6b), so a user's layout may put more on a row.
  home: [
    { item: 'cases' }, { item: 'contacts' }, { item: 'appts' },
    { break: true },
    { item: 'bills' }, { item: 'pipeline' }, { item: 'events' },
    { break: true },
    { item: 'tasks' }, { item: 'newClient' }, { item: 'log' },
    { break: true },
    // Comms took Settings' Home slot with its sidebar one (2026-10-11);
    // always shown, like the sidebar item. Calendar took the retired custom
    // tab's slot (ui-custom S5e, 2026-10-16).
    { item: 'calendar' }, { item: 'moreFeatures' }, { item: 'comms' },
  ],

  sidebar: [
    { label: 'Records' },
    { item: 'cases' }, { item: 'contacts' }, { item: 'appts' },
    { item: 'calendar' }, { item: 'events' }, { item: 'tasks' },
    { item: 'comms' }, { item: 'log' }, { item: 'bills' },
    { label: 'Actions' },
    { item: 'pipeline' }, { item: 'newClient' },
    { label: 'Settings' },
    { item: 'admin' }, { item: 'moreFeatures' }, { item: 'helpSupport' },
    // All, the last item (S2's fixed #sbAll until S6c; an ordinary, removable
    // item since — Home's icon row and Ctrl-K are the guarantee).
    { item: 'all' },
  ],

  // Home's icon row (ui-custom S6c): the small buttons under the Home grid.
  // All is GUARANTEED here — the resolver puts it back whatever a layout says.
  homeIcons: [
    { item: 'all' },
  ],

  // More Features.
  //
  // Layout rule: 4 buttons per row. Keep new buttons inside the row they
  // belong to rather than appending to the end. Row 5 has three: Get Clio
  // Code left the grid for the firm row (ui-custom S3.3b, 2026-10-15) — it is
  // now a firm tool, and firm items render in a row of their own after this
  // grid. The next tile fills that gap or waits for S4's layouts; ask first.
  //
  // Row 5's fourth tile was the cat before that, a toy holding the slot
  // square until Settings took a row-1 place (2026-10-11). Casey is still
  // summoned by long-pressing the header logo. (placeholder / data-placeholder, which ensureStrip()
  // skips so a tile that opens nothing never reaches the pill strip, is
  // unused; keep the mechanism for the next gap in the grid.)
  //
  // Rows went 3-wide to 4-wide with the Theme tile. One theme per row no
  // longer divides evenly across 22 features, so a row is now a task rather
  // than a subsystem: what the client fills in, what you keep, how a case is
  // shaped, when things happen, and what goes out. The help row leads because
  // it is the row you want when you do not know where to look.
  more: [
    // Where you get help, and how the app works for you: how it works, your
    // settings and your theme, and what you want next. Settings opens its own
    // main tab (tabSettings) — it is not a panel here; the sidebar's More
    // Features item stays lit while you are on it (data-tab-also).
    { item: 'moreManuals' }, { item: 'moreSettings' }, { item: 'moreTheme' }, { item: 'moreFeatureRequests' },
    { break: true },
    // What the client fills in: the form, what comes back from it, and the
    // door they walk through to get to it. Simple Forms and Form Builder are
    // two surfaces over the SAME form_templates records — the simple one hands
    // off to the full one for tabs / repeaters / code.
    { item: 'moreSimpleForms' }, { item: 'moreFormBuilder' }, { item: 'moreFormInbox' }, { item: 'morePortalManager' },
    { break: true },
    // The file you keep: get it signed, then the files everything else pulls
    // from. Signatures sits here rather than with the forms row above because
    // this row is "the file you keep", not "the thing the client fills in".
    // Documents replaced this row's data-placeholder rather than starting a
    // seventh row — the placeholders existed for exactly this.
    { item: 'moreSignatures' }, { item: 'moreAssetManager' }, { item: 'moreVideoManager' }, { item: 'moreDocuments' },
    { break: true },
    // How a case is shaped: its fields, the steps on it, what runs on it by
    // itself, and the saved views you read it back through.
    { item: 'moreCaseConfig' }, { item: 'moreChecklists' }, { item: 'moreAutomations' }, { item: 'moreViews' },
    { break: true },
    // When things happen: what can be booked, when, and the court email as it
    // will go out. Three tiles since Get Clio Code left for the firm row
    // (ui-custom S3.3b); S4's layouts settle the gap.
    { item: 'moreAvailability' }, { item: 'moreBooking' }, { item: 'moreCourtPreview' },
    { break: true },
    // What goes out, and what comes back as numbers: the message, the page it
    // lands on, the links that get there, and the reporting over all of it.
    // Reports is the loosest fit on the grid — it reads everything, not just
    // outreach — but it belongs with "look at the result" more than with any
    // other row here.
    { item: 'moreCampaigns' }, { item: 'moreRedirects' }, { item: 'moreLandingPages' }, { item: 'moreReports' },
  ],

  // More's icon row: Casey's paw (its markup, byte for byte, is the item's).
  moreIcons: [
    { item: 'casey' },
  ],

  // Admin.
  //
  // Layout rule: 3 buttons per row, and every row full. 12 tiles = four full
  // rows, grouped by what the row is for. Keep new buttons inside the row they
  // belong to rather than appending to the end; every row is full, so the
  // next tile starts a fifth row — see the same note on the More Features
  // grid above. Row 5 (comms admin: mailboxes, 2026-10-08) is that row, short
  // by design until the comms hub's phone/phonebook admin tiles join it
  // (ref/MAILBOX_SYSTEM_DESIGN.md §5). The hub itself piloted here and moved
  // to the sidebar (tabComms) on 2026-10-11.
  admin: [
    // Who gets in: the two key registries, and CTA links — the bearer grants
    // (/c/<token>) you mint to let a recipient run one pre-authorized plan.
    { item: 'adminReadonlyKeys' }, { item: 'adminApiKeys' }, { item: 'adminCtaLinks' },
    { break: true },
    // Reading and poking the live system: the rows, the outbound credentials,
    // and the endpoints that serve them.
    { item: 'adminDbConsole' }, { item: 'adminConnections' }, { item: 'adminApiTester' },
    { break: true },
    // Things you run rather than read, plus the cross-session notes.
    { item: 'adminTools' }, { item: 'adminEtch' }, { item: 'adminScratch' },
    { break: true },
    // Who is using it and what they are telling you: accounts, the alerts the
    // system raises on its own, and the ones staff raise by hand.
    { item: 'adminUsers' }, { item: 'adminSystemAlerts' }, { item: 'adminSupportInbox' },
    { break: true },
    // Comms admin: mailboxes and who may read / send / manage each one. The
    // hub where granted staff read them is the sidebar's Comms tab.
    { item: 'adminMailboxes' },
  ],

  // Admin's icon row: empty by default (the row's div takes no space while it
  // holds nothing — the :empty rule in index.html); the firm's layout may
  // place small items here.
  adminIcons: [],
};
