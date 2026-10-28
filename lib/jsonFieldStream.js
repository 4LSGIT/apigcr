// lib/jsonFieldStream.js
//
// Incremental extractor for ONE top-level string field of a JSON object that
// arrives in pieces (Ask Casey's answer stream: the model writes
// {"answer": "...", "citations": [...], ...} and the pane should see the
// answer prose while the rest is still being generated).
//
// push(chunk) feeds raw model text; onText(decoded) receives only the
// characters INSIDE the named field's string value, escapes decoded, as soon
// as they are unambiguous. Contract:
//   - nothing is emitted until the field's value string opens;
//   - only a key of the ROOT object counts (an "answer" inside action_draft or
//     an array is ignored), in any field order;
//   - the first occurrence only (a duplicate key is the parse's business:
//     JSON.parse keeps the last, and the caller replaces streamed text with
//     the parsed value whenever they differ);
//   - a non-string value (null, number, object) emits nothing;
//   - text before the root '{' (a ```json fence, stray prose) is skipped, as
//     aiService's stripJsonFences does;
//   - escapes split across chunks are held until complete; a 😀
//     surrogate pair is emitted as one unit; a lone or invalid escape emits
//     U+FFFD rather than throwing (the text is cosmetic — the authoritative
//     answer is always the parsed JSON);
//   - after the root object closes, everything is ignored.
// It never throws on malformed input and never buffers more than one escape.

'use strict';

const SIMPLE_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function createFieldExtractor({ field = 'answer', onText } = {}) {
  if (typeof onText !== 'function') throw new TypeError('createFieldExtractor: onText is required');
  let state;
  const reset = () => {
    state = {
      started: false,   // root '{' seen
      ended: false,     // root closed
      stack: [],        // container chars: '{' | '['
      expectKey: false, // in an object, the next string is a key
      inString: false,
      stringRole: null, // 'key' | 'value' | 'emit'
      keyBuf: '',
      lastKey: null,
      esc: null,        // pending escape text after the backslash, e.g. 'u00'
      highSurrogate: null,
      emitted: false,   // the field has been emitted (first occurrence only)
      out: '',
    };
  };
  reset();

  const append = (s) => {
    if (state.stringRole === 'emit') state.out += s;
    else if (state.stringRole === 'key') state.keyBuf += s;
  };
  const appendChar = (s) => {
    if (state.highSurrogate != null) {
      // A high surrogate not followed by its low half.
      append('\uFFFD');
      state.highSurrogate = null;
    }
    append(s);
  };
  const flush = () => {
    if (state.out) {
      const text = state.out;
      state.out = '';
      try { onText(text); } catch (_) { /* cosmetic only */ }
    }
  };

  function closeString() {
    if (state.highSurrogate != null) { append('\uFFFD'); state.highSurrogate = null; }
    if (state.stringRole === 'key') {
      state.lastKey = state.keyBuf;
      state.keyBuf = '';
    } else if (state.stringRole === 'emit') {
      state.emitted = true;
    }
    state.inString = false;
    state.stringRole = null;
  }

  function pushChar(c) {
    if (state.ended) return;
    if (!state.started) {
      if (c === '{') { state.started = true; state.stack.push('{'); state.expectKey = true; }
      return;
    }
    if (state.inString) {
      if (state.esc != null) {
        state.esc += c;
        if (state.esc[0] === 'u') {
          if (!/^u[0-9a-fA-F]*$/.test(state.esc)) { appendChar('\uFFFD'); state.esc = null; return; }
          if (state.esc.length < 5) return;
          const code = parseInt(state.esc.slice(1), 16);
          state.esc = null;
          if (code >= 0xD800 && code <= 0xDBFF) {
            if (state.highSurrogate != null) append('\uFFFD');
            state.highSurrogate = code;
          } else if (code >= 0xDC00 && code <= 0xDFFF) {
            if (state.highSurrogate != null) {
              append(String.fromCharCode(state.highSurrogate, code));
              state.highSurrogate = null;
            } else append('\uFFFD');
          } else appendChar(String.fromCharCode(code));
          return;
        }
        const simple = SIMPLE_ESCAPES[state.esc];
        state.esc = null;
        appendChar(simple != null ? simple : '\uFFFD');
        return;
      }
      if (c === '\\') { state.esc = ''; return; }
      if (c === '"') { closeString(); return; }
      appendChar(c);
      return;
    }
    const depth = state.stack.length;
    const top = state.stack[depth - 1];
    if (c === '"') {
      state.inString = true;
      if (top === '{' && state.expectKey) {
        state.stringRole = depth === 1 ? 'key' : null;
      } else {
        state.stringRole = depth === 1 && top === '{' && !state.emitted && state.lastKey === field ? 'emit' : null;
      }
      return;
    }
    if (c === '{' || c === '[') {
      state.stack.push(c);
      state.expectKey = c === '{';
      return;
    }
    if (c === '}' || c === ']') {
      state.stack.pop();
      state.expectKey = false;
      if (!state.stack.length) state.ended = true;
      return;
    }
    if (c === ':') { if (top === '{') state.expectKey = false; return; }
    if (c === ',') {
      if (top === '{') { state.expectKey = true; if (depth === 1) state.lastKey = null; }
      return;
    }
    // Whitespace and non-string scalars (true, 12, null) need no tracking.
  }

  return {
    push(chunk) {
      const s = String(chunk == null ? '' : chunk);
      for (const c of s) pushChar(c);
      flush();
    },
    // A new attempt (aiService's JSON retry) starts the text over.
    reset,
  };
}

module.exports = { createFieldExtractor };
