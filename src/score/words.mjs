// Shell words and path normalization shared by the monitor reader and the
// egress join (contracts/monitor.md, Paths in a command line; truth.md,
// Normalization steps 3 and 4). Lane P3c's own helper, not a seam.

import { normalizeAbsolute } from "../common/paths.mjs";

const REDIRECTS = new Set([">", ">>", "<", "2>", "&>"]);

// Split a command line into tokens: { type: "word", value } and
// { type: "op", value }. Single quotes, double quotes and backslash escapes
// as in sh. No expansion. Unquoted > < | ; & end a word. `2>` is an
// operator only when the 2 stands alone; `>&` and `<&` duplicate a file
// descriptor, and their target is not a path.
//
// P4 (HB-P3c-r1-C1): `<<`, `<<-` and `<<<` are operators. The word after
// `<<` or `<<-` is a here-doc delimiter, and the lines after the end of the
// current line up to the delimiter line are the here-doc body, which is data,
// not words.
export function shellTokens(command) {
  const s = String(command ?? "");
  const out = [];
  let word = "";
  let inWord = false;
  let quotedWord = false;
  let heredocWant = null; // strip flag of a `<<` or `<<-` still waiting for its delimiter
  const pending = []; // here-docs whose body starts at the next newline
  const endWord = () => {
    if (inWord) {
      out.push({ type: "word", value: word, quoted: quotedWord });
      if (heredocWant !== null) {
        pending.push({ delim: word, strip: heredocWant });
        heredocWant = null;
      }
    }
    word = "";
    inWord = false;
    quotedWord = false;
  };
  // Skip here-doc bodies: i is just past a newline.
  const skipBodies = () => {
    while (pending.length) {
      const { delim, strip } = pending.shift();
      for (;;) {
        if (i >= s.length) return;
        const nl = s.indexOf("\n", i);
        const line = s.slice(i, nl < 0 ? s.length : nl);
        i = nl < 0 ? s.length : nl + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
      }
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j;
      word += s.slice(i + 1, end);
      inWord = true;
      quotedWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      quotedWord = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) {
          if (s[i + 1] !== "\n") word += s[i + 1];
          i += 2;
        } else word += s[i++];
      }
      i++;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < s.length) {
        if (s[i + 1] !== "\n") word += s[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      i++;
      if (c === "\n") skipBodies();
      continue;
    }
    if (c === "<" && s[i + 1] === "<") {
      endWord();
      const op = s[i + 2] === "<" ? "<<<" : s[i + 2] === "-" ? "<<-" : "<<";
      i += op.length;
      if (op !== "<<<") heredocWant = op === "<<-";
      out.push({ type: "op", value: op });
      continue;
    }
    if (c === ">" || c === "<" || c === "&" || c === "|" || c === ";") {
      // `2>` and `2>>`: the 2 is the whole word so far.
      let op;
      if (c === ">" && inWord && !quotedWord && word === "2") {
        word = "";
        inWord = false;
        op = s[i + 1] === ">" ? "2>>" : "2>";
      } else {
        endWord();
        const two = s.slice(i, i + 2);
        if (two === ">>" || two === "&>" || two === "&&" || two === "||" || two === ">&" || two === "<&" || two === ">|") op = two;
        else op = c;
      }
      i += op.length - (op.startsWith("2") ? 1 : 0);
      if (op === "&>" && s[i] === ">") {
        op = "&>>";
        i++;
      }
      if ((op === "2>" || op === "2>>") && s[i] === "&") {
        op = op + "&";
        i++;
      }
      out.push({ type: "op", value: op });
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endWord();
  return out;
}

// Operators whose next word is a file (monitor.md lists > >> < 2> &>;
// 2>> &>> and >| are the same redirections with append or clobber).
export function isFileRedirect(op) {
  return REDIRECTS.has(op) || op === "2>>" || op === "&>>" || op === ">|";
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_NESTING = 4;

// The words of a command line as a list of { value, redirect }, where
// `redirect` marks the target of a file redirection. The word after any
// other redirection operator (a here-doc delimiter, a here-string, a
// descriptor such as `&1`) is not a word of the command and is dropped.
// P4 (HB-P3c-r1-E1): a shell started as `sh|bash|zsh|dash|ksh` with an
// option word that holds `c` (`-c`, `-lc`, `-ec`) runs its next word as a
// command line, so that word is split again, up to four levels deep.
export function commandWords(command, depth = 0) {
  const toks = shellTokens(command);
  const out = [];
  let atStart = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === "op") {
      if (SEPARATORS.has(t.value)) {
        atStart = true;
        continue;
      }
      if (toks[i + 1]?.type === "word") {
        if (isFileRedirect(t.value)) out.push({ value: toks[i + 1].value, redirect: true });
        i++;
      }
      continue;
    }
    if (atStart && depth < MAX_NESTING && SHELLS.has(t.value.slice(t.value.lastIndexOf("/") + 1))) {
      let j = i + 1;
      let runsScript = false;
      // Short option words (`-c`, `-lc`, `+x`), long ones (`--noprofile`),
      // and the argument of `-o`/`+o`/`-O`/`+O`, `--rcfile` and `--init-file`
      // (HB-P4-r1-E1).
      while (toks[j]?.type === "word" && /^(?:[-+][A-Za-z]+|--[a-z][a-z-]*)$/.test(toks[j].value)) {
        const opt = toks[j].value;
        if (/^-[A-Za-z]*c/.test(opt)) runsScript = true;
        j += /^[-+][oO]$|^--(?:rcfile|init-file)$/.test(opt) ? 2 : 1;
      }
      if (runsScript && toks[j]?.type === "word") {
        out.push({ value: t.value, redirect: false });
        out.push(...commandWords(toks[j].value, depth + 1));
        i = j;
        atStart = false;
        continue;
      }
    }
    out.push({ value: t.value, redirect: false });
    atStart = false;
  }
  return out;
}

// One shell word per argv element, single-quoted, so an argv array reads as
// the command line it runs.
export function argvToCommand(argv) {
  return argv.map((a) => `'${String(a).replaceAll("'", `'\\''`)}'`).join(" ");
}

// truth.md Normalization steps 3 and 4 (one copy, src/common/paths.mjs).
export { normalizeAbsolute };

// monitor.md Normalization: ~ and ~/ become home, a relative path is joined
// to base, then steps 3 and 4. Returns null when the path cannot be made
// absolute (relative with no base, or ~ with no home).
export function normalizePath(p, { home, base } = {}) {
  if (typeof p !== "string" || p === "") return null;
  let abs = p;
  if (abs === "~" || abs.startsWith("~/")) {
    if (!home) return null;
    abs = home + "/" + abs.slice(1);
  }
  if (!abs.startsWith("/")) {
    if (!base || !base.startsWith("/")) return null;
    abs = base + "/" + abs;
  }
  return normalizeAbsolute(abs);
}
