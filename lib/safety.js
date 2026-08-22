"use strict";

// Error messages and source labels can cross trust boundaries before they are
// printed or persisted. Keep them single-line, remove terminal controls and
// redact anything shaped like a Cribble bearer token.
const CRIBBLE_KEY_LIKE_PATTERN = /crib_ag_[0-9a-z]{8,}/gi;
const UNSAFE_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function safeText(value, { fallback = "", maxLength = 300 } = {}) {
  const cleaned = String(value ?? "")
    .replace(CRIBBLE_KEY_LIKE_PATTERN, "[REDACTED]")
    .replace(UNSAFE_TEXT_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  const result = cleaned || fallback;
  return result.slice(0, maxLength);
}

module.exports = { safeText };
