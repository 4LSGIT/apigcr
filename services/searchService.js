/**
 * Search Service
 * services/searchService.js
 *
 * Smart search across contacts and cases with tiered priority matching.
 *
 * Tier 1: Exact ID matches (contact_id, case_id)
 * Tier 2: Exact reference matches (phone, case_number, case_number_full)
 * Tier 3: Name LIKE search (contacts by name, cases by linked contact name)
 *
 * For limit=1: returns best match (stops at first tier with a hit)
 * For limit>1: runs all applicable tiers, deduplicates, caps at limit
 */

/**
 * @param {object} db
 * @param {object} opts
 * @param {string}  opts.q       — search term (required)
 * @param {string}  [opts.type='all']  — 'contact', 'case', or 'all'
 * @param {number}  [opts.limit=1]     — max results (1 = best match)
 * @returns {{ results: Array<{ name, type, id, detail }> }}
 */
async function search(db, { q, type = 'all', limit = 1 } = {}) {
  if (!q || !q.trim()) return { results: [] };

  const term = q.trim();
  const wantContacts = type === 'all' || type === 'contact';
  const wantCases    = type === 'all' || type === 'case';
  const cap = Math.min(Math.max(1, parseInt(limit) || 1), 50);
  const single = cap === 1;

  // ── Classify input ──
  const digits = term.replace(/\D/g, '');
  const isAllDigits = digits.length > 0 && digits === term;
  const isPhone = digits.length === 10
    || (digits.length === 11 && digits.startsWith('1'));
  const phone10 = isPhone
    ? (digits.length === 11 ? digits.slice(1) : digits)
    : null;
  const isShortNumber = isAllDigits && digits.length <= 6;
  // case_id: 6-8 alphanumeric, no spaces, has at least one letter
  const looksLikeCaseId = /^[A-Za-z0-9]{6,8}$/.test(term) && /[A-Za-z]/.test(term);
  // case_number: "25-12345" or case_number_full: "2:25-bk-12345"
  const looksLikeCaseRef = /\d{2}-/.test(term) || term.includes(':');

  const results = [];
  const seen = new Set(); // "type:id" dedup key

  function addContact(row) {
    const key = `contact:${row.contact_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      name: row.contact_name,
      type: 'contact',
      id: row.contact_id,
      detail: formatPhone(row.contact_phone)
    });
  }

  function addCase(row) {
    const key = `case:${row.case_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      name: row.case_display || row.case_number_full || row.case_number || row.case_id,
      type: 'case',
      id: row.case_id,
      detail: '' // enriched later
    });
  }

  function done() {
    return single && results.length >= cap;
  }

  // ══════════════════════════════════════════════════════════════
  // Tier 1: Exact ID matches
  // ══════════════════════════════════════════════════════════════

  // Contact by ID
  if (wantContacts && isShortNumber && !done()) {
    const [rows] = await db.query(
      `SELECT contact_name, contact_id, contact_phone
       FROM contacts WHERE contact_id = ? LIMIT 1`,
      [digits]
    );
    rows.forEach(addContact);
  }

  // Case by case_id (simple lookup — no JOINs)
  if (wantCases && looksLikeCaseId && !done()) {
    const [rows] = await db.query(
      `SELECT case_id,
              COALESCE(case_number_full, case_number, case_id) AS case_display
       FROM cases WHERE case_id = ? LIMIT 1`,
      [term]
    );
    rows.forEach(addCase);
  }

  if (done()) return finish(db, results, cap);

  // ══════════════════════════════════════════════════════════════
  // Tier 2: Exact reference matches
  // ══════════════════════════════════════════════════════════════

  // Contact by phone
  if (wantContacts && phone10 && !done()) {
    const [rows] = await db.query(
      `SELECT contact_name, contact_id, contact_phone
       FROM contacts WHERE contact_phone = ? LIMIT ?`,
      [phone10, cap]
    );
    rows.forEach(addContact);
  }

  // Case by case_number or case_number_full (simple lookup — no JOINs)
  if (wantCases && looksLikeCaseRef && !done()) {
    const [rows] = await db.query(
      `SELECT case_id,
              COALESCE(case_number_full, case_number, case_id) AS case_display
       FROM cases
       WHERE case_number = ? OR case_number_full = ?
       LIMIT ?`,
      [term, term, cap]
    );
    rows.forEach(addCase);
  }

  // Also try case_id for short numbers (e.g. someone types a numeric case_id)
  if (wantCases && isShortNumber && !done()) {
    const [rows] = await db.query(
      `SELECT case_id,
              COALESCE(case_number_full, case_number, case_id) AS case_display
       FROM cases WHERE case_id = ? LIMIT 1`,
      [term]
    );
    rows.forEach(addCase);
  }

  if (done()) return finish(db, results, cap);

  // ══════════════════════════════════════════════════════════════
  // Tier 3: Name / fuzzy search
  // ══════════════════════════════════════════════════════════════

  // Build LIKE pattern: "john smith" → "%john%smith%"
  const nameParts = term.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  const likePattern = nameParts.length ? `%${nameParts.join('%')}%` : null;

  // Contact by name
  if (wantContacts && likePattern && !done()) {
    const remaining = cap - results.length;
    const [rows] = await db.query(
      `SELECT contact_name, contact_id, contact_phone
       FROM contacts
       WHERE contact_name LIKE ?
       ORDER BY contact_lname, contact_fname
       LIMIT ?`,
      [likePattern, remaining]
    );
    rows.forEach(addContact);
  }

  // Case by linked contact name (simple JOIN to case_relate + contacts)
  if (wantCases && likePattern && !done()) {
    const remaining = cap - results.length;
    const queryParams = [likePattern];

    // Also try phone match on linked contacts
    let phoneCond = '';
    if (phone10) {
      phoneCond = 'OR co.contact_phone = ?';
      queryParams.push(phone10);
    }

    queryParams.push(remaining);

    const [rows] = await db.query(
      `SELECT DISTINCT c.case_id,
              COALESCE(c.case_number_full, c.case_number, c.case_id) AS case_display
       FROM cases c
       JOIN case_relate cr ON c.case_id = cr.case_relate_case_id
       JOIN contacts co ON cr.case_relate_client_id = co.contact_id
       WHERE co.contact_name LIKE ? ${phoneCond}
       ORDER BY co.contact_lname, co.contact_fname
       LIMIT ?`,
      queryParams
    );
    rows.forEach(addCase);
  }

  return finish(db, results, cap);
}


/**
 * Enrich case results with primary contact names, then return.
 * Enrichment failures are non-fatal — results still work without detail.
 */
async function finish(db, results, cap) {
  const capped = results.slice(0, cap);

  // Collect case IDs that need enrichment
  const caseIds = capped
    .filter(r => r.type === 'case' && !r.detail)
    .map(r => r.id);

  if (caseIds.length > 0) {
    try {
      const [contacts] = await db.query(
        `SELECT cr.case_relate_case_id AS case_id, co.contact_name
         FROM case_relate cr
         JOIN contacts co ON cr.case_relate_client_id = co.contact_id
         WHERE cr.case_relate_case_id IN (${caseIds.map(() => '?').join(',')})
         ORDER BY cr.case_relate_case_id, co.contact_lname
         LIMIT ?`,
        [...caseIds, caseIds.length * 3]
      );

      // Map: case_id → first contact name found
      const nameMap = {};
      for (const row of contacts) {
        if (!nameMap[row.case_id]) nameMap[row.case_id] = row.contact_name;
      }

      // Apply to results
      for (const r of capped) {
        if (r.type === 'case' && nameMap[r.id]) {
          r.detail = nameMap[r.id];
        }
      }
    } catch (err) {
      // Non-fatal — results still work without the contact name detail
      console.error('Search enrichment failed:', err.message);
    }
  }

  return { results: capped };
}


/**
 * Format 10-digit phone as "313-555-1234"
 */
function formatPhone(phone) {
  if (!phone || phone.length !== 10) return phone || '';
  return `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`;
}

module.exports = { search };