/**
 * lib/escapeLike.js
 *
 * Escape LIKE metacharacters so user/path input matches LITERALLY. Order
 * matters — escape the escape char first. This server's sql_mode does NOT
 * include NO_BACKSLASH_ESCAPES, so MySQL's default '\' escape is active and
 * no explicit ESCAPE clause is needed.
 *
 *   escapeLike('50%_off')  → '50\%\_off'   (then wrap: `%${escapeLike(q)}%`)
 */
function escapeLike(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/[%_]/g, '\\$&');
}

module.exports = { escapeLike };
