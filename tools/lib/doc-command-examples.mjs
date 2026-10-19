import { parseCommandArguments } from '../../packages/cli/dist/command-registry.js';

/** @typedef {{text: string, offset: number, operator?: boolean, error?: string, forwarding?: boolean}} Token */

/** Consume an opaque expansion without evaluating any part of it.
 * @param {string} text @param {number} start */
function expansionEnd(text, start) {
  const simple = /^\$(?:[\w@*#?$!\d-]+|\{[^}]*\})/u.exec(text.slice(start));
  if (simple) return start + simple[0].length;
  if (text[start] === '`') return quotedEnd(text, start, '`');
  if (!text.startsWith('$(', start)) return start + 1;
  let depth = 1;
  let index = start + 2;
  while (index < text.length && depth) {
    const char = text.charAt(index);
    if (char === '\\') index += 2;
    else if (/["'`]/u.test(char)) index = quotedEnd(text, index, char);
    else {
      if (char === '(') depth++;
      if (char === ')') depth--;
      index++;
    }
  }
  return index;
}

/** @param {string} text @param {number} start @param {string} quote */
function quotedEnd(text, start, quote) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote) return index + 1;
    index += text[index] === '\\' && quote !== "'" ? 2 : 1;
  }
  return index;
}

/** @param {string} text @param {number} index @param {string} quote */
function escapedCharacter(text, index, quote) {
  const next = text[index + 1] ?? '';
  if (next === '\n') return '';
  if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) return `\\${next}`;
  return next;
}

/** @param {string} char @param {string} quote */
function wordBoundary(char, quote) {
  return !quote && /[\s;&|<>()]/u.test(char);
}

/** @param {string} char @param {string} quote */
function shellEscape(char, quote) {
  return char === '\\' && quote !== "'";
}

/** @param {string} char @param {string} quote @param {boolean} literal */
function shellExpansion(char, quote, literal) {
  return !literal && /[$`]/u.test(char) && quote !== "'";
}

/** @param {string} text @param {number} start @param {boolean} [literal] */
function readWord(text, start, literal = false) {
  let index = start;
  let value = '';
  let quote = '';
  let forwarding = false;
  while (index < text.length) {
    const char = text.charAt(index);
    if (wordBoundary(char, quote)) break;
    if (char === quote) quote = '';
    else if (!quote && /["']/u.test(char)) quote = char;
    else if (shellEscape(char, quote)) {
      value += escapedCharacter(text, index, quote);
      index++;
    } else if (shellExpansion(char, quote, literal)) {
      forwarding ||= forwardingExpansion(text, index);
      value += 'PXV_DYNAMIC';
      index = expansionEnd(text, index) - 1;
    } else value += char;
    index++;
  }
  return {
    token: { text: value, offset: start, forwarding, ...quoteError(quote) },
    end: index,
  };
}

/** @param {string} text @param {number} index */
function forwardingExpansion(text, index) {
  return /^\$(?:[@*]|\{[@*]\})/u.test(text.slice(index));
}

/** @param {string} quote */
function quoteError(quote) {
  return quote ? { error: 'Unterminated shell quote' } : {};
}

/** Skip literal heredoc bodies, including tab-stripping <<- delimiters.
 * @param {string} text @param {number} start @param {string[]} delimiters */
function skipHereDocuments(text, start, delimiters) {
  let index = start;
  for (const delimiter of delimiters) {
    while (index < text.length) {
      const end = text.indexOf('\n', index);
      const next = end < 0 ? text.length : end + 1;
      const line = text.slice(index, end < 0 ? text.length : end).replace(/^\t+/u, '');
      index = next;
      if (line === delimiter) break;
    }
  }
  return index;
}

/** @param {string} text @returns {Token[]} */
function shellTokens(text) {
  const tokens = [];
  const heredocs = [];
  let index = 0;
  let expectDelimiter = false;
  while (index < text.length) {
    const char = text.charAt(index);
    if (text.startsWith('\\\n', index)) index += 2;
    else if (char === '\n') {
      tokens.push({ text: '\n', offset: index++, operator: true });
      index = skipHereDocuments(text, index, heredocs.splice(0));
    } else if (/\s/u.test(char)) index++;
    else if (char === '#') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
    } else {
      const operator = /^(?:\d*(?:<<<|<<-?|>>|<>|>&|<&|>|<)|&&|\|\||[;&|()])/u.exec(text.slice(index));
      if (operator) {
        tokens.push({ text: operator[0], offset: index, operator: true });
        expectDelimiter = /^\d*<<-?$/u.test(operator[0]);
        index += operator[0].length;
      } else {
        const word = readWord(text, index, expectDelimiter);
        tokens.push(word.token);
        if (expectDelimiter) heredocs.push(word.token.text);
        expectDelimiter = false;
        index = word.end;
      }
    }
  }
  return tokens;
}

/** @param {Token[]} tokens */
function commandWords(tokens) {
  /** @type {Token[]} */
  const words = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.operator) {
      if (/<<-?$/u.test(token.text)) return [];
      index++; // A redirection operand belongs to the shell, never to argv.
    } else words.push(token);
  }
  while (/^[A-Za-z_]\w*=/u.test(words[0]?.text ?? '')) words.shift();
  return words;
}

/** @param {Token | undefined} token */
function tokenText(token) {
  return token?.text ?? '';
}

/** Only concrete command launchers are recognized; wrappers remain opaque.
 * @param {Token[]} words */
function launcherLength(words) {
  const first = tokenText(words[0]);
  const second = tokenText(words[1]);
  if (first.includes('PXV_DYNAMIC')) return 0;
  if (first === 'pxv') return 1;
  if (second.includes('PXV_DYNAMIC')) return 0;
  if (first === 'pnpm' && second === 'pxv') return 2;
  if (/^(?:.*\/)?node$/u.test(first) && /^(?:.*\/)?packages\/cli\/dist\/main\.js$/u.test(second)) return 2;
  return 0;
}

/** @param {string} file @param {string} source @param {number} offset @param {string} message */
function diagnostic(file, source, offset, message) {
  const prefix = source.slice(0, offset);
  const line = prefix.split('\n').length;
  const column = offset - prefix.lastIndexOf('\n');
  return `${file}:${line}:${column}: ${message}`;
}

/** @param {Token[]} tokens @param {string} file @param {string} source @param {number} base */
function validateExample(tokens, file, source, base) {
  const words = commandWords(tokens);
  const launcher = launcherLength(words);
  if (!launcher) return [];
  const args = words.slice(launcher);
  if (args.some((word) => word.forwarding)) return [];
  const malformed = args.find((word) => word.error);
  try {
    if (malformed) throw new Error(malformed.error);
    parseCommandArguments(args.map((word) => word.text));
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const location = malformed ?? flagLocation(args, message) ?? words[0];
    return [diagnostic(file, source, base + (location?.offset ?? 0), message)];
  }
}

/** @param {Token[]} args @param {string} message */
function flagLocation(args, message) {
  const flag = /--[\w-]+/u.exec(message)?.[0];
  return args.find((word) => flag && word.text.split('=')[0] === flag);
}

/** @param {string} body @param {string} file @param {string} source @param {number} base */
function checkShell(body, file, source, base) {
  const errors = [];
  let segment = [];
  for (const token of shellTokens(body)) {
    if (token.operator && /^(?:\n|;|&|&&|\|\||\||\(|\))$/u.test(token.text)) {
      errors.push(...validateExample(segment, file, source, base));
      segment = [];
    } else segment.push(token);
  }
  errors.push(...validateExample(segment, file, source, base));
  return errors;
}

/** Statically check shell fences. Nothing is expanded, sourced, spawned or executed.
 * @param {string} source @param {string} file @returns {string[]} */
export function checkCommandExamples(source, file) {
  const errors = [];
  const lines = source.split(/(?<=\n)/u);
  let offset = 0;
  let fence = '';
  let base = 0;
  let body = '';
  let shell = false;
  let consoleFence = false;
  for (const line of lines) {
    const opening = fenceOpening(line);
    if (!fence && opening) {
      fence = opening.fence;
      const language = opening.language;
      shell = /^(?:sh|bash|shell|console)(?:\s|$)/u.test(language);
      consoleFence = language === 'console';
      base = offset + line.length;
    } else if (closesFence(fence, line)) {
      if (shell) errors.push(...checkShell(body, file, source, base));
      fence = '';
      body = '';
    } else if (fence) body += stripPrompt(line, consoleFence);
    offset += line.length;
  }
  if (fence && shell) errors.push(...checkShell(body, file, source, base));
  return errors;
}

/** @param {string} line */
function fenceOpening(line) {
  const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)/u.exec(line);
  if (!match) return undefined;
  return { fence: match[1] ?? '', language: (match[2] ?? '').trim() };
}

/** @param {string} fence @param {string} line */
function closesFence(fence, line) {
  return fence !== '' && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`, 'u').test(line);
}

/** Replace prompts with spaces so original source offsets remain intact.
 * @param {string} line @param {boolean} consoleFence */
function stripPrompt(line, consoleFence) {
  const pattern = consoleFence ? /^(\s*)(?:\$ |# |[\w.-]+@[^\s]+[#$] |> )/u : /^(\s*)(?:\$ |> )/u;
  return line.replace(pattern, (prompt) => ' '.repeat(prompt.length));
}
