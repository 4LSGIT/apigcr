/**
 * yc-forms.js — YisraCase Forms Utility Library
 *
 * Provides the YCForm class: init, populate, collect, validate, autosave,
 * save, draft recovery, repeaters, masks, dirty-checking, and view/edit toggle.
 *
 * Usage:
 *   <script src="/js/yc-forms.js"></script>
 *   <script>
 *     const form = new YCForm({ formKey: '...', linkType: '...', ... });
 *     form.init();
 *   </script>
 */

class YCForm {
  constructor(config) {
    this.config = Object.assign({
      formKey:       '',
      schemaVersion: 1,
      linkType:      '',
      linkId:        '',
      container:     '',
      dataMode:      'live',             // 'live' = always from entity table; 'snapshot' = from latest submission once one exists
      autosave:      false,
      autosaveMs:    3000,
      readonly:      true,
      external:      false,
      baseUrl:       '',
      fields:        {},
      repeaters:     {},
      validation:    {},
      endpoints:     {},
      apiMap:        {},
      onSubmit:      {},
      onLoad:        null,
      onSave:        null,
      onError:       null,
    }, config);

    this.el = document.querySelector(this.config.container);
    if (!this.el) {
      console.error(`[YCForm] Container not found: ${this.config.container}`);
      return;
    }

    // State
    this._original = {};           // Snapshot of data at load time (for dirty-checking)
    this._lastAutosaveJson = '';   // JSON string of last autosaved data
    this._autosaveTimer = null;
    this._draftData = null;        // Stored draft from server (for recovery)
    this._submittedData = null;    // Latest submitted row from server
    this._liveData = null;         // Data from the source entity table

    // DOM refs
    this._headerEl = document.querySelector('.yc-form-header');
    this._toggleInput = document.getElementById('toggleBtn');
    this._toggleLabel = document.getElementById('toggleLabel');
    this._warningEl = document.getElementById('warning');
    this._saveStatusEl = document.getElementById('saveStatus');
    this._saveBtnEl = document.getElementById('saveBtn');
    this._draftBannerEl = document.getElementById('draftBanner');
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  async init() {
    try {
      // 0. Show loading overlay
      this._showLoading(true);

      // 1. Set up toggle
      this._setupToggle();

      // 2. Set up masks
      this._setupMasks();

      // 3. Auto-inject textarea counters
      this._setupTextareaCounters();

      // 4. Set up repeater add/remove buttons
      this._setupRepeaters();

      // 5. Set up conditional logic
      this._setupConditionals();

      // 6. Apply initial readonly state
      this.setReadonly(this.config.readonly);

      // 7. Fetch live data from source table
      if (this.config.endpoints.load) {
        try {
          const loadResult = await this._api(
            this.config.endpoints.load.url,
            this.config.endpoints.load.method || 'GET'
          );
          // Extract nested entity data if a path is specified
          // e.g., GET /api/contacts/:id returns { contact: {...}, cases: [...] }
          //        path: 'contact' → extracts just the contact object
          const path = this.config.endpoints.load.path;
          if (path && loadResult[path]) {
            this._liveData = loadResult[path];
          } else {
            this._liveData = loadResult.data || loadResult;
          }
        } catch (err) {
          console.warn('[YCForm] Could not load live data:', err);
          this._liveData = null;
        }
      }

      // 8. Fetch latest draft + submission
      let latest = { submitted: null, draft: null };
      try {
        latest = await this._api(
          `/api/forms/latest?form_key=${encodeURIComponent(this.config.formKey)}&link_type=${encodeURIComponent(this.config.linkType)}&link_id=${encodeURIComponent(this.config.linkId)}`,
          'GET'
        );
      } catch (err) {
        console.warn('[YCForm] Could not fetch form submissions:', err);
      }
      this._submittedData = latest.submitted;
      this._draftData = latest.draft;

      // 9. Decide what data to populate
      const dataSource = this._resolveDataSource();

      // 10. Populate
      this.populate(dataSource);

      // 11. Show save status from latest submission
      this._showLastSaved();

      // 12. Start autosave listener if enabled
      if (this.config.autosave) {
        this._startAutosave();
      }

      // 13. Callback
      if (this.config.onLoad) {
        this.config.onLoad(dataSource);
      }

      // 14. Hide loading
      this._showLoading(false);

    } catch (err) {
      console.error('[YCForm] init error:', err);
      this._showLoading(false);
      if (this.config.onError) this.config.onError(err);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // DATA SOURCE RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════

  _resolveDataSource() {
    const draft = this._draftData;
    const submitted = this._submittedData;
    const live = this._mergeApiData(this._liveData);
    const submittedData = submitted ? (typeof submitted.data === 'string' ? JSON.parse(submitted.data) : submitted.data) : null;
    const isSnapshot = this.config.dataMode === 'snapshot';

    // Determine the "base" data (what we show if there's no draft to recover)
    let base;
    if (isSnapshot) {
      // Snapshot mode: once a submission exists, it IS the truth.
      // Only use live data as pre-fill when no submission exists yet.
      base = submittedData || live || {};
    } else {
      // Live mode: always start from the entity table.
      // Submissions are just history.
      base = live || {};
    }

    // Draft recovery check
    if (draft) {
      const draftTime = new Date(draft.updated_at).getTime();
      const submittedTime = submitted ? new Date(submitted.updated_at).getTime() : 0;

      if (draftTime > submittedTime) {
        // Draft is newer than latest submission (or no submission exists)
        this._showDraftBanner(draft, submitted);
      }
      // Either way, default to base data — user clicks "Restore" to load draft
    }

    return base;
  }

  /**
   * Apply apiMap to translate API field names to form field names.
   */
  _mergeApiData(apiData) {
    if (!apiData) return null;
    const mapped = {};
    const reverseMap = {};

    // Build reverse map: apiFieldName → formFieldName
    for (const [apiName, formName] of Object.entries(this.config.apiMap)) {
      reverseMap[apiName] = formName;
    }

    for (const [key, value] of Object.entries(apiData)) {
      const formName = reverseMap[key] || key;
      mapped[formName] = value;
    }
    return mapped;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // DRAFT BANNER
  // ═══════════════════════════════════════════════════════════════════════════

  _showDraftBanner(draft, submitted) {
    if (!this._draftBannerEl) return;

    const timestampEl = document.getElementById('draftTimestamp');
    const restoreBtn = document.getElementById('draftRestore');
    const discardBtn = document.getElementById('draftDiscard');
    const bannerText = this._draftBannerEl.querySelector('span');

    // Format timestamp
    const dt = new Date(draft.updated_at);
    if (timestampEl) timestampEl.textContent = dt.toLocaleString();

    // Schema version mismatch warning
    if (draft.schema_version !== this.config.schemaVersion) {
      let warningEl = this._draftBannerEl.querySelector('.yc-draft-warning');
      if (!warningEl) {
        warningEl = document.createElement('div');
        warningEl.className = 'yc-draft-warning';
        this._draftBannerEl.appendChild(warningEl);
      }
      warningEl.textContent = 'This draft was saved with an older version of this form.';
    }

    // Set appropriate banner text
    if (!submitted) {
      if (bannerText) bannerText.innerHTML = `You have an unsaved draft from <strong>${dt.toLocaleString()}</strong>`;
    }

    // Restore button
    if (restoreBtn) {
      restoreBtn.onclick = () => {
        const draftPayload = typeof draft.data === 'string' ? JSON.parse(draft.data) : draft.data;
        this.populate(draftPayload);
        this._draftBannerEl.style.display = 'none';
      };
    }

    // Discard button
    if (discardBtn) {
      discardBtn.onclick = async () => {
        try {
          await this._api(
            `/api/forms/draft?form_key=${encodeURIComponent(this.config.formKey)}&link_type=${encodeURIComponent(this.config.linkType)}&link_id=${encodeURIComponent(this.config.linkId)}`,
            'DELETE'
          );
        } catch (err) {
          console.warn('[YCForm] Draft discard failed:', err);
        }
        this._draftData = null;
        this._draftBannerEl.style.display = 'none';
      };
    }

    this._draftBannerEl.style.display = 'flex';
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // POPULATE
  // ═══════════════════════════════════════════════════════════════════════════

  populate(data) {
    if (!data || typeof data !== 'object') data = {};
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;

    // Populate regular fields
    for (const [fieldName, fieldConfig] of Object.entries(this.config.fields)) {
      const el = this.el.querySelector(fieldConfig.el);
      if (!el) continue;

      let value = parsed[fieldName];
      if (value === undefined || value === null) value = '';

      // Format value for display
      value = this._formatForDisplay(value, fieldConfig);

      if (fieldConfig.type === 'select') {
        el.value = value;
      } else if (fieldConfig.type === 'radio') {
        const radios = this.el.querySelectorAll(`input[name="${el.getAttribute('name')}"]`);
        radios.forEach(r => { r.checked = r.value === String(value); });
      } else if (fieldConfig.type === 'checkbox') {
        el.checked = !!value;
      } else {
        el.value = value;
      }
    }

    // Populate repeaters
    for (const [repKey, repConfig] of Object.entries(this.config.repeaters)) {
      const items = parsed[repKey];
      if (!Array.isArray(items)) continue;

      // Clear existing items
      const container = document.querySelector(repConfig.container);
      if (!container) continue;
      container.querySelectorAll('.yc-repeater-item').forEach(el => el.remove());

      // Add items
      items.forEach(itemData => {
        this._addRepeaterItemWithData(repKey, itemData);
      });
    }

    // Store snapshot for dirty-checking
    this._original = JSON.parse(JSON.stringify(this.collect()));
    this._lastAutosaveJson = JSON.stringify(this._original);

    // Clear dirty state
    this.el.classList.remove('yc-dirty');
    this.el.querySelectorAll('.yc-changed').forEach(el => el.classList.remove('yc-changed'));
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // COLLECT — gather all current field values
  // ═══════════════════════════════════════════════════════════════════════════

  collect() {
    const data = {};

    // Regular fields — ALL fields are collected, including hidden and readonly
    for (const [fieldName, fieldConfig] of Object.entries(this.config.fields)) {
      const el = this.el.querySelector(fieldConfig.el);
      if (!el) continue;

      if (fieldConfig.type === 'checkbox') {
        data[fieldName] = el.checked;
      } else if (fieldConfig.type === 'radio') {
        const checked = this.el.querySelector(`input[name="${el.getAttribute('name')}"]:checked`);
        data[fieldName] = checked ? checked.value : '';
      } else {
        let val = el.value;
        // Strip mask formatting for raw value
        val = this._stripMask(val, fieldConfig);
        data[fieldName] = val;
      }
    }

    // Repeaters
    for (const [repKey, repConfig] of Object.entries(this.config.repeaters)) {
      const container = document.querySelector(repConfig.container);
      if (!container) continue;

      const items = [];
      container.querySelectorAll('.yc-repeater-item').forEach(itemEl => {
        const item = {};
        for (const [fName, fConfig] of Object.entries(repConfig.fields)) {
          const input = itemEl.querySelector(`[name="${fName}"]`);
          if (input) {
            item[fName] = fConfig.type === 'checkbox' ? input.checked : input.value;
          }
        }
        items.push(item);
      });
      data[repKey] = items;
    }

    return data;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // DIRTY CHECKING & DIFF
  // ═══════════════════════════════════════════════════════════════════════════

  isDirty() {
    return JSON.stringify(this.collect()) !== JSON.stringify(this._original);
  }

  getDiff() {
    const current = this.collect();
    const diff = {};

    for (const key of Object.keys(current)) {
      const oldVal = this._original[key];
      const newVal = current[key];

      // Deep compare for arrays/objects (repeaters)
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        diff[key] = [oldVal === undefined ? null : oldVal, newVal];
      }
    }

    return diff;
  }

  /**
   * Build the PATCH payload: only changed fields, excluding readonly fields.
   * Uses reverse apiMap to convert form field names back to API column names.
   */
  _buildPatchPayload() {
    const diff = this.getDiff();
    const payload = {};

    // Build forward map: formFieldName → apiFieldName
    const forwardMap = {};
    for (const [apiName, formName] of Object.entries(this.config.apiMap)) {
      forwardMap[formName] = apiName;
    }

    for (const [fieldName, [_oldVal, newVal]] of Object.entries(diff)) {
      // Skip readonly fields
      const fieldConfig = this.config.fields[fieldName];
      if (fieldConfig && fieldConfig.readonly) continue;

      // Map back to API column name
      const apiName = forwardMap[fieldName] || fieldName;
      payload[apiName] = newVal;
    }

    return payload;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  validate() {
    let isValid = true;

    // Clear all errors first
    this.el.querySelectorAll('.yc-error').forEach(el => {
      el.classList.remove('visible');
      el.textContent = '';
    });

    for (const [fieldName, rules] of Object.entries(this.config.validation)) {
      const fieldConfig = this.config.fields[fieldName];
      if (!fieldConfig) continue;

      const el = this.el.querySelector(fieldConfig.el);
      if (!el) continue;

      const value = el.value.trim();
      const errorEl = el.parentElement.querySelector('.yc-error');
      let error = null;

      // Required
      if (rules.required && !value) {
        error = 'This field is required';
      }

      // Min length
      if (!error && rules.minLength && value.length > 0 && value.length < rules.minLength) {
        error = `Minimum ${rules.minLength} characters`;
      }

      // Max length
      if (!error && rules.maxLength && value.length > rules.maxLength) {
        error = `Maximum ${rules.maxLength} characters`;
      }

      // Email
      if (!error && rules.email && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        error = 'Enter a valid email address';
      }

      // Pattern
      if (!error && rules.pattern && value && !rules.pattern.test(value)) {
        error = rules.patternMessage || 'Invalid format';
      }

      // Mask validation
      if (!error && rules.mask && value) {
        const maskValid = this._validateMask(value, rules.mask);
        if (!maskValid) {
          error = `Invalid ${rules.mask} format`;
        }
      }

      // Custom
      if (!error && rules.custom) {
        const customResult = rules.custom(value, this.collect());
        if (customResult !== true) {
          error = customResult || 'Invalid value';
        }
      }

      if (error) {
        isValid = false;
        if (errorEl) {
          errorEl.textContent = error;
          errorEl.classList.add('visible');
        }
      }
    }

    return isValid;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // SAVE (explicit)
  // ═══════════════════════════════════════════════════════════════════════════

  async save() {
    // Guard against double-click
    if (this._saving) return;

    // 1. Validate
    if (!this.validate()) return;

    // 2. Check for changes
    const diff = this.getDiff();
    if (Object.keys(diff).length === 0) {
      this._toast('success', 'No changes to save');
      return;
    }

    this._saving = true;
    this._showLoading(true);

    try {
      this._showStatus('Saving...', true);

      // 3. PATCH to real table (if configured)
      if (this.config.onSubmit.patch) {
        const patchPayload = this._buildPatchPayload();
        if (Object.keys(patchPayload).length > 0) {
          await this._api(
            this.config.onSubmit.patch.url,
            this.config.onSubmit.patch.method || 'PATCH',
            patchPayload
          );
        }
      }

      // 4. Record submission in form_submissions (always)
      const submitResult = await this._api('/api/forms/submit', 'POST', {
        form_key:       this.config.formKey,
        link_type:      this.config.linkType,
        link_id:        this.config.linkId,
        schema_version: this.config.schemaVersion,
        data:           this.collect(),
      });

      // 5. Trigger workflow (if configured, fire-and-forget)
      if (this.config.onSubmit.workflow) {
        const wfConfig = this.config.onSubmit.workflow;
        const initData = Object.assign({}, wfConfig.initData || {}, {
          form_key:      this.config.formKey,
          link_type:     this.config.linkType,
          link_id:       this.config.linkId,
          submission_id: submitResult.id,
          data:          this.collect(),
        });
        this._api(`/workflows/${wfConfig.id}/start`, 'POST', initData).catch(err => {
          console.warn('[YCForm] Workflow trigger failed (non-blocking):', err);
        });
      }

      // 6. Log the diff
      try {
        await this._api('/api/log', 'POST', {
          type:      'form',
          link_type: this.config.linkType,
          link_id:   this.config.linkId,
          by:        0,
          data: JSON.stringify({
            form_key: this.config.formKey,
            action:   'form_submit',
            version:  submitResult.version,
            changes:  JSON.stringify(diff),
          }),
        });
      } catch (err) {
        console.warn('[YCForm] Audit log failed (non-blocking):', err);
      }

      // 7. Reset state
      this._original = JSON.parse(JSON.stringify(this.collect()));
      this._lastAutosaveJson = JSON.stringify(this._original);
      this.el.classList.remove('yc-dirty');
      this.el.querySelectorAll('.yc-changed').forEach(el => el.classList.remove('yc-changed'));

      // 8. Update status
      this._showStatus('Saved just now');

      // 9. Return to view mode
      this.setReadonly(true);

      // 10. Success toast
      this._toast('success', 'Saved successfully');

      // 11. Callback & parent notification
      if (this.config.onSave) this.config.onSave(submitResult);
      if (!this.config.external) {
        try {
          window.parent.postMessage({
            type: 'form-saved',
            form: this.config.formKey,
            linkType: this.config.linkType,
            linkId: this.config.linkId,
          }, '*');
        } catch (_) { /* no parent */ }
      }

    } catch (err) {
      console.error('[YCForm] Save error:', err);
      this._showStatus('Save failed!');
      this._toast('error', 'Save failed', err.message);
      if (this.config.onError) this.config.onError(err);
    } finally {
      this._saving = false;
      this._showLoading(false);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOSAVE
  // ═══════════════════════════════════════════════════════════════════════════

  _startAutosave() {
    // Listen for input/change events on the entire form
    this.el.addEventListener('input', () => this._onFieldChange());
    this.el.addEventListener('change', () => this._onFieldChange());
  }

  _onFieldChange() {
    // Update dirty state
    if (this.isDirty()) {
      this.el.classList.add('yc-dirty');
      this._markChangedFields();
    } else {
      this.el.classList.remove('yc-dirty');
      this.el.querySelectorAll('.yc-changed').forEach(el => el.classList.remove('yc-changed'));
    }

    // Reset autosave timer
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => this.autosaveTick(), this.config.autosaveMs);
  }

  _markChangedFields() {
    for (const [fieldName, fieldConfig] of Object.entries(this.config.fields)) {
      const el = this.el.querySelector(fieldConfig.el);
      if (!el) continue;

      const wrapper = el.closest('.yc-field');
      if (!wrapper) continue;

      let currentVal = fieldConfig.type === 'checkbox' ? el.checked : el.value;
      currentVal = this._stripMask(String(currentVal), fieldConfig);

      let origVal = this._original[fieldName];
      if (origVal === undefined || origVal === null) origVal = '';
      origVal = String(origVal);

      if (currentVal !== origVal) {
        wrapper.classList.add('yc-changed');
      } else {
        wrapper.classList.remove('yc-changed');
      }
    }
  }

  async autosaveTick() {
    if (!this.config.autosave) return;

    const currentJson = JSON.stringify(this.collect());
    if (currentJson === this._lastAutosaveJson) return; // No-op: nothing changed

    try {
      this._showStatus('Saving draft...', true);

      await this._api('/api/forms/draft', 'POST', {
        form_key:       this.config.formKey,
        link_type:      this.config.linkType,
        link_id:        this.config.linkId,
        schema_version: this.config.schemaVersion,
        data:           this.collect(),
      });

      this._lastAutosaveJson = currentJson;
      this._showStatus('Draft saved just now');
    } catch (err) {
      console.warn('[YCForm] Autosave failed:', err);
      this._showStatus('Draft save failed');
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // READONLY TOGGLE
  // ═══════════════════════════════════════════════════════════════════════════

  setReadonly(on) {
    if (on) {
      this.el.classList.add('yc-readonly');
      if (this._saveBtnEl) this._saveBtnEl.style.display = 'none';
      if (this._warningEl) this._warningEl.style.display = 'none';
      if (this._toggleInput) this._toggleInput.checked = false;
      if (this._toggleLabel) this._toggleLabel.textContent = 'View Mode';
    } else {
      this.el.classList.remove('yc-readonly');
      if (this._saveBtnEl) this._saveBtnEl.style.display = 'block';
      if (this._warningEl) this._warningEl.style.display = 'block';
      if (this._toggleInput) this._toggleInput.checked = true;
      if (this._toggleLabel) this._toggleLabel.textContent = 'Edit Mode';

      // Re-apply field-level locks
      for (const [fieldName, fieldConfig] of Object.entries(this.config.fields)) {
        if (!fieldConfig.readonly) continue;
        const el = this.el.querySelector(fieldConfig.el);
        if (!el) continue;
        const wrapper = el.closest('.yc-field');
        if (wrapper) wrapper.classList.add('yc-field-locked');
      }
    }
  }

  _setupToggle() {
    if (!this._toggleInput) return;

    this._toggleInput.addEventListener('change', () => {
      this.setReadonly(!this._toggleInput.checked);
    });

    // Save button
    if (this._saveBtnEl) {
      this._saveBtnEl.addEventListener('click', () => this.save());
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // REPEATERS
  // ═══════════════════════════════════════════════════════════════════════════

  _setupRepeaters() {
    // Bind "Add" buttons
    this.el.querySelectorAll('.yc-repeater-add').forEach(btn => {
      const repKey = btn.dataset.repeater;
      if (repKey) {
        btn.addEventListener('click', () => this.addRepeaterItem(repKey));
      }
    });
  }

  addRepeaterItem(repKey) {
    this._addRepeaterItemWithData(repKey, null);
    this._onFieldChange(); // trigger dirty check
  }

  _addRepeaterItemWithData(repKey, data) {
    const repConfig = this.config.repeaters[repKey];
    if (!repConfig) return;

    const container = document.querySelector(repConfig.container);
    const template = document.querySelector(repConfig.template);
    if (!container || !template) return;

    const clone = template.content.cloneNode(true);
    const itemEl = clone.querySelector('.yc-repeater-item') || clone.firstElementChild;

    // Populate with data if provided
    if (data) {
      for (const [fName, fConfig] of Object.entries(repConfig.fields)) {
        const input = itemEl.querySelector(`[name="${fName}"]`);
        if (input) {
          if (fConfig.type === 'checkbox') {
            input.checked = !!data[fName];
          } else {
            input.value = data[fName] || '';
          }
        }
      }
    }

    // Bind remove button
    const removeBtn = itemEl.querySelector('.yc-repeater-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        itemEl.remove();
        this._onFieldChange();
      });
    }

    // Insert before the "Add" button
    const addBtn = container.querySelector('.yc-repeater-add');
    if (addBtn) {
      container.insertBefore(clone, addBtn);
    } else {
      container.appendChild(clone);
    }
  }

  removeRepeaterItem(repKey, index) {
    const repConfig = this.config.repeaters[repKey];
    if (!repConfig) return;

    const container = document.querySelector(repConfig.container);
    if (!container) return;

    const items = container.querySelectorAll('.yc-repeater-item');
    if (items[index]) {
      items[index].remove();
      this._onFieldChange();
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // MASKS
  // ═══════════════════════════════════════════════════════════════════════════

  _setupMasks() {
    this.el.querySelectorAll('[data-yc-mask]').forEach(el => {
      const maskType = el.dataset.ycMask;
      this._applyMaskListeners(el, maskType);
    });

    // Also apply masks from validation config
    for (const [fieldName, rules] of Object.entries(this.config.validation)) {
      if (!rules.mask) continue;
      const fieldConfig = this.config.fields[fieldName];
      if (!fieldConfig) continue;
      const el = this.el.querySelector(fieldConfig.el);
      if (el && !el.dataset.ycMask) {
        el.dataset.ycMask = rules.mask;
        this._applyMaskListeners(el, rules.mask);
      }
    }
  }

  _applyMaskListeners(el, maskType) {
    el.addEventListener('blur', () => {
      el.value = this._formatMask(el.value, maskType);
    });
    // Format on input for currency
    if (maskType === 'currency') {
      el.addEventListener('input', () => {
        // Allow typing, format on blur
      });
    }
  }

  _formatMask(value, maskType) {
    if (!value) return '';
    const digits = value.replace(/\D/g, '');

    switch (maskType) {
      case 'phone':
        if (digits.length === 10) {
          return digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
        }
        return value;

      case 'ssn':
        if (digits.length === 9) {
          return digits.replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3');
        }
        return value;

      case 'zip':
        if (digits.length === 5) return digits;
        if (digits.length === 9) return digits.replace(/^(\d{5})(\d{4})$/, '$1-$2');
        return value;

      case 'ein':
        if (digits.length === 9) {
          return digits.replace(/^(\d{2})(\d{7})$/, '$1-$2');
        }
        return value;

      case 'currency': {
        const num = parseFloat(value.replace(/[^\d.-]/g, ''));
        if (isNaN(num)) return value;
        return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      default:
        return value;
    }
  }

  _stripMask(value, fieldConfig) {
    if (!fieldConfig) return value;
    const maskType = fieldConfig.mask || (this.config.validation[fieldConfig.el] || {}).mask;

    // Also check the element for data-yc-mask
    if (!maskType) {
      const el = this.el.querySelector(fieldConfig.el);
      if (el && el.dataset.ycMask) {
        return this._stripMaskByType(value, el.dataset.ycMask);
      }
      return value;
    }
    return this._stripMaskByType(value, maskType);
  }

  _stripMaskByType(value, maskType) {
    if (!value) return value;
    switch (maskType) {
      case 'phone':
      case 'ssn':
      case 'zip':
      case 'ein':
        return value.replace(/\D/g, '');
      case 'currency':
        return value.replace(/[^\d.-]/g, '');
      default:
        return value;
    }
  }

  _validateMask(value, maskType) {
    const digits = value.replace(/\D/g, '');
    switch (maskType) {
      case 'phone': return digits.length === 10;
      case 'ssn':   return digits.length === 9;
      case 'zip':   return digits.length === 5 || digits.length === 9;
      case 'ein':   return digits.length === 9;
      case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      default:      return true;
    }
  }

  _formatForDisplay(value, fieldConfig) {
    if (value === null || value === undefined) return '';

    // Date fields: normalize to YYYY-MM-DD for <input type="date">
    if (fieldConfig.type === 'date') {
      if (!value) return '';
      // Handle Date objects, ISO strings, and YYYY-MM-DD strings
      const str = (value instanceof Date) ? value.toISOString() : String(value);
      const dateOnly = str.split('T')[0]; // "1993-01-23"
      // Validate it's a real date
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly) && !isNaN(new Date(dateOnly))) {
        return dateOnly;
      }
      return '';
    }

    const v = String(value);

    // Check for mask
    const el = this.el.querySelector(fieldConfig.el);
    const maskType = (el && el.dataset.ycMask) || null;
    if (maskType) return this._formatMask(v, maskType);

    return v;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // TEXTAREA COUNTERS (auto-injected for textarea[maxlength])
  // ═══════════════════════════════════════════════════════════════════════════

  _setupTextareaCounters() {
    this.el.querySelectorAll('textarea[maxlength]').forEach(textarea => {
      const max = parseInt(textarea.getAttribute('maxlength'), 10);
      if (isNaN(max)) return;

      // Check if counter already exists
      if (textarea.parentElement.querySelector('.yc-char-counter')) return;

      const counter = document.createElement('small');
      counter.className = 'yc-char-counter';
      counter.textContent = `${textarea.value.length}/${max}`;
      textarea.parentElement.appendChild(counter);

      textarea.addEventListener('input', () => {
        counter.textContent = `${textarea.value.length}/${max}`;
      });
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // CONDITIONAL LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  _setupConditionals() {
    const conditionalEls = this.el.querySelectorAll('[data-yc-show-when]');
    if (conditionalEls.length === 0) return;

    // Evaluate on load
    this._evaluateConditionals();

    // Re-evaluate on change
    this.el.addEventListener('change', () => this._evaluateConditionals());
    this.el.addEventListener('input', () => this._evaluateConditionals());
  }

  _evaluateConditionals() {
    this.el.querySelectorAll('[data-yc-show-when]').forEach(el => {
      const watchField = el.dataset.ycShowWhen;
      const showValue = el.dataset.ycShowValue;
      const showValues = el.dataset.ycShowValues;

      // Find the watched field's current value
      const watchEl = this.el.querySelector(`[name="${watchField}"]`);
      if (!watchEl) return;

      let currentVal;
      if (watchEl.type === 'checkbox') {
        currentVal = watchEl.checked ? 'true' : 'false';
      } else if (watchEl.type === 'radio') {
        const checked = this.el.querySelector(`input[name="${watchField}"]:checked`);
        currentVal = checked ? checked.value : '';
      } else {
        currentVal = watchEl.value;
      }

      let show = false;

      if (showValues) {
        // Match any of comma-separated values
        const vals = showValues.split(',').map(v => v.trim());
        show = vals.includes(currentVal);
      } else if (showValue) {
        if (showValue === '*') {
          show = !!currentVal;
        } else if (showValue.startsWith('!')) {
          show = currentVal !== showValue.slice(1);
        } else {
          show = currentVal === showValue;
        }
      }

      el.style.display = show ? '' : 'none';
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // TABS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Call this from your form's HTML to set up tab switching:
   *   form.setupTabs('.yc-tab-bar', '.yc-tab-panel');
   */
  setupTabs(barSelector, panelSelector) {
    const bar = this.el.querySelector(barSelector) || document.querySelector(barSelector);
    if (!bar) return;

    const buttons = bar.querySelectorAll('button');
    const panels = this.el.querySelectorAll(panelSelector) || document.querySelectorAll(panelSelector);

    buttons.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        if (panels[i]) panels[i].classList.add('active');
      });
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS DISPLAY, LOADING & TOASTS
  // ═══════════════════════════════════════════════════════════════════════════

  _showStatus(text, showSpinner = false) {
    if (!this._saveStatusEl) return;
    if (showSpinner) {
      this._saveStatusEl.innerHTML = `<span class="spinner"></span> ${text}`;
    } else {
      this._saveStatusEl.textContent = text;
    }
  }

  _showLastSaved() {
    if (!this._submittedData) return;
    const { user_name, updated_at } = this._submittedData;
    const dt = new Date(updated_at);
    const timeStr = dt.toLocaleString();
    const name = user_name || 'Unknown';
    this._showStatus(`Last saved by ${name} at ${timeStr}`);
  }

  /**
   * Show/hide a loading overlay on the form.
   * Creates the overlay element on first call.
   */
  _showLoading(on) {
    if (!this._loadingEl) {
      this._loadingEl = document.createElement('div');
      this._loadingEl.className = 'yc-loading-overlay';
      this._loadingEl.innerHTML = '<div class="yc-loading-spinner"></div><div class="yc-loading-text">Loading...</div>';
      this.el.style.position = 'relative';
      this.el.appendChild(this._loadingEl);
    }
    this._loadingEl.style.display = on ? 'flex' : 'none';
  }

  /**
   * Show a brief toast notification inside the form.
   * Uses SweetAlert2 Toast if available, otherwise a built-in mini-toast.
   */
  _toast(icon, title, text = '') {
    // Try SweetAlert2 Toast (matches rest of app)
    if (typeof Swal !== 'undefined') {
      const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
      });
      Toast.fire({ icon, title, text: text || undefined });
      return;
    }

    // Fallback: built-in mini-toast
    let toastEl = document.querySelector('.yc-toast');
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'yc-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text ? `${title}: ${text}` : title;
    toastEl.className = `yc-toast yc-toast-${icon} visible`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toastEl.classList.remove('visible');
    }, 2500);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // API CLIENT
  // ═══════════════════════════════════════════════════════════════════════════

  async _api(url, method, body) {
    // Replace {linkId}, {linkType}, {formKey} placeholders
    url = url.replace(/\{linkId\}/g, this.config.linkId);
    url = url.replace(/\{linkType\}/g, this.config.linkType);
    url = url.replace(/\{formKey\}/g, this.config.formKey);

    if (this.config.external) {
      // External mode: direct fetch
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body && method !== 'GET') {
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(this.config.baseUrl + url, opts);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.message || `HTTP ${resp.status}`);
      }
      return resp.json();
    } else {
      // Internal mode: relay through parent iframe chain
      return window.parent.apiSend(url, method, body);
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL EXPORT
// ═══════════════════════════════════════════════════════════════════════════

window.YCForm = YCForm;