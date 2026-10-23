// Shared by the browser editor and the pure snippet parser. This is a lexer,
// never a shell: variables, globs, substitutions and metacharacters stay literal.
var T3McpCommand = (() => {
  'use strict';
  const lex = text => {
    const words = []; let word = '', quote = '', started = false;
    for (let at = 0; at < text.length; at++) {
      const c = text[at];
      if (quote === "'") { if (c === quote) quote = ''; else word += c; continue; }
      if (c === '\\') {
        if (++at >= text.length) throw new Error('Finish the escaped character at the end of the command.');
        const next = text[at];
        if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) word += '\\';
        if (next !== '\n') word += next;
        started = true; continue;
      }
      if (quote) { if (c === quote) quote = ''; else word += c; continue; }
      if (c === '"' || c === "'") { quote = c; started = true; }
      else if (/\s/.test(c)) { if (started) { words.push(word); word = ''; started = false; } }
      else { word += c; started = true; }
    }
    if (quote) throw new Error('Close the quote in the command.');
    if (started) words.push(word);
    return words;
  };
  const quote = arg => /^[A-Za-z0-9_./:@=+-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'";
  const line = argv => argv.map(quote).join(' ');
  const needsRows = argv => argv.some(arg => !arg || arg !== arg.trim() || /[\r\n]/.test(arg));
  const placeholder = value => /<[^>]+>|YOUR_|your-/i.test(value) || /^(xxx|\.\.\.|changeme|replace-me|todo)$/i.test(value);
  return { lex, quote, line, needsRows, placeholder };
})();
if (typeof module === 'object') module.exports = T3McpCommand;
