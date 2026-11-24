// Shell words and path normalization shared by the monitor reader and the
// egress join (contracts/monitor.md, Paths in a command line; truth.md,
// Normalization steps 3 and 4). Lane P3c's own helper, not a seam.

const REDIRECTS = new Set([">", ">>", "<", "2>", "&>"]);

// Split a command line into tokens: { type: "word", value } and
// { type: "op", value }. Single quotes, double quotes and backslash escapes
// as in sh. No expansion. Unquoted > < | ; & end a word. `2>` is an
// operator only when the 2 stands alone; `>&` and `<&` duplicate a file
// descriptor, and their target is not a path.
export function shellTokens(command) {
  const s = String(command ?? "");
  const out = [];
  let word = "";
  let inWord = false;
  let quotedWord = false;
  const endWord = () => {
    if (inWord) out.push({ type: "word", value: word, quoted: quotedWord });
    word = "";
    inWord = false;
    quotedWord = false;
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

// truth.md Normalization steps 3 and 4 on an absolute path: drop . and ..,
// collapse repeated /, drop a trailing / except for / itself.
export function normalizeAbsolute(p) {
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

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
