// The one error class a tool throws for an expected refusal; index.js turns it
// into an ok:false envelope with its code. Separate file: index.js requires
// every tool, so a tool cannot require index.js for it.
'use strict';

class ToolError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || null;
  }
}

module.exports = { ToolError };
