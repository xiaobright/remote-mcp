export interface TextEditResult {
  text: string;
  replacements: number;
  lineEndingsNormalized: boolean;
}

export interface TextEditOptions {
  replaceAll?: boolean;
  path?: string;
  /** Appended to mismatch errors, e.g. "call ssh_file_read and copy old_string verbatim". */
  hint?: string;
}

const MAX_DIAGNOSTIC_CHARS = 240;
const MAX_SIMILARITY_LINE_CHARS = 400;
const MAX_CLOSEST_CONTEXT_LINES = 4;
const MAX_REPORTED_MATCHES = 3;

function truncateForDisplay(text: string): string {
  return text.length > MAX_DIAGNOSTIC_CHARS
    ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}…(+${text.length - MAX_DIAGNOSTIC_CHARS} chars)`
    : text;
}

/** JSON-escape so invisible characters (tabs, trailing spaces, \r) become visible. */
function escapeText(text: string): string {
  return truncateForDisplay(JSON.stringify(text));
}

function isConsistentCrlf(text: string): boolean {
  if (!text.includes("\r\n")) {
    return false;
  }
  const lines = text.split("\n");
  return lines.slice(0, -1).every((line) => line.endsWith("\r"));
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = new Array(b.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a: string, b: string): number {
  const cappedA = a.slice(0, MAX_SIMILARITY_LINE_CHARS);
  const cappedB = b.slice(0, MAX_SIMILARITY_LINE_CHARS);
  const max = Math.max(cappedA.length, cappedB.length);
  if (max === 0) {
    return 1;
  }
  return 1 - levenshtein(cappedA, cappedB) / max;
}

function lineNumberOfIndex(text: string, index: number): number {
  let line = 1;
  const limit = Math.min(index, text.length);
  for (let position = 0; position < limit; position++) {
    if (text[position] === "\n") {
      line++;
    }
  }
  return line;
}

function allMatchLines(work: string, oldString: string): number[] {
  const lines: number[] = [];
  let index = work.indexOf(oldString);
  while (index >= 0 && lines.length < MAX_REPORTED_MATCHES) {
    lines.push(lineNumberOfIndex(work, index));
    index = work.indexOf(oldString, index + oldString.length);
  }
  return lines;
}

interface InsensitiveMatch {
  startLine: number;
  endLine: number;
  fileLines: string[];
}

/** Line-based match ignoring leading/trailing whitespace per line (catches tabs-vs-spaces, trailing spaces). */
function findWhitespaceInsensitiveMatch(fileLines: string[], oldLines: string[]): InsensitiveMatch | null {
  if (oldLines.length === 0 || oldLines.length > fileLines.length) {
    return null;
  }
  const trimmedOld = oldLines.map((line) => line.trim());
  if (trimmedOld.some((line) => line.length === 0)) {
    return null; // blank lines match too easily; leave this case to similarity
  }
  const matches: number[] = [];
  for (let start = 0; start <= fileLines.length - oldLines.length; start++) {
    let ok = true;
    for (let offset = 0; offset < oldLines.length; offset++) {
      if (fileLines[start + offset].trim() !== trimmedOld[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(start);
      if (matches.length > 1) {
        return null; // ambiguous; not useful for a "retry with this" message
      }
    }
  }
  if (matches.length !== 1) {
    return null;
  }
  const start = matches[0];
  return {
    startLine: start + 1,
    endLine: start + oldLines.length,
    fileLines: fileLines.slice(start, start + oldLines.length),
  };
}

interface ClosestRegion {
  startLine: number;
  endLine: number;
  fileLines: string[];
  score: number;
}

function findClosestRegion(fileLines: string[], oldLines: string[]): ClosestRegion | null {
  if (fileLines.length === 0) {
    return null;
  }
  const firstOld = oldLines[0].trim();
  const candidates: number[] = [];
  for (let start = 0; start < fileLines.length; start++) {
    if (similarity(fileLines[start], oldLines[0]) >= 0.3 || fileLines[start].trim() === firstOld) {
      candidates.push(start);
      if (candidates.length >= 200) {
        break;
      }
    }
  }
  if (candidates.length === 0) {
    // Fall back to a coarse scan so pathological cases still get a region.
    const step = Math.max(1, Math.floor(fileLines.length / 200));
    for (let start = 0; start < fileLines.length; start += step) {
      candidates.push(start);
    }
  }

  let best: ClosestRegion | null = null;
  for (const start of candidates) {
    const windowLength = Math.min(oldLines.length, fileLines.length - start);
    if (windowLength <= 0) {
      continue;
    }
    let total = 0;
    for (let offset = 0; offset < windowLength; offset++) {
      total += similarity(fileLines[start + offset], oldLines[offset]);
    }
    const score = total / windowLength;
    if (!best || score > best.score) {
      best = {
        startLine: start + 1,
        endLine: start + windowLength,
        fileLines: fileLines.slice(start, start + windowLength),
        score,
      };
    }
  }
  return best;
}

function formatNumberedLines(lines: string[], startLine: number): string {
  return lines
    .slice(0, MAX_CLOSEST_CONTEXT_LINES)
    .map((line, index) => `  ${startLine + index} | ${escapeText(line)}`)
    .join("\n");
}

function mismatchError(
  path: string,
  oldString: string,
  work: string,
  options: TextEditOptions,
): Error {
  const fileLines = work.split("\n");
  const oldLines = oldString.split("\n");
  const fixHint = options.hint
    ? ` ${options.hint}`
    : " To fix: read the file first and copy old_string verbatim from its output (tabs, trailing spaces and line endings matter), then retry.";

  // Trailing-newline slip: "foo\n" vs a file region "foo".
  const strippedEnd = oldString.replace(/\n+$/, "");
  const strippedStart = oldString.replace(/^\n+/, "");
  if (strippedEnd.length > 0 && work.includes(strippedEnd)) {
    return new Error(
      `Edit did not match ${path}: old_string is not found verbatim, but it matches after removing its trailing newline(s). Retry with old_string without the trailing "\\n".${fixHint}`,
    );
  }
  if (strippedStart.length > 0 && strippedStart !== strippedEnd && work.includes(strippedStart)) {
    return new Error(
      `Edit did not match ${path}: old_string is not found verbatim, but it matches after removing its leading newline(s). Retry with old_string without the leading "\\n".${fixHint}`,
    );
  }

  const insensitive = findWhitespaceInsensitiveMatch(fileLines, oldLines);
  if (insensitive) {
    return new Error(
      [
        `Edit did not match ${path} exactly: a match exists at lines ${insensitive.startLine}-${insensitive.endLine} but differs in leading/trailing whitespace (tabs vs spaces or trailing spaces).`,
        `Exact file text (escaped):`,
        formatNumberedLines(insensitive.fileLines, insensitive.startLine),
        `Copy these lines verbatim into old_string and retry.`,
      ].join("\n") + fixHint,
    );
  }

  const closest = findClosestRegion(fileLines, oldLines);
  const parts = [`Edit did not match ${path}: old_string not found in the file.`];
  if (closest) {
    parts.push(
      `Closest region in file (lines ${closest.startLine}-${closest.endLine}, similarity ${(closest.score * 100).toFixed(0)}%):`,
      formatNumberedLines(closest.fileLines, closest.startLine),
      `old_string (escaped): ${escapeText(oldString)}`,
    );
  } else {
    parts.push(`The file appears to be empty or binary; old_string (escaped): ${escapeText(oldString)}`);
  }
  return new Error(parts.join("\n") + fixHint);
}

export function applyTextEdit(
  original: string,
  oldString: string,
  newString: string,
  options: TextEditOptions = {},
): TextEditResult {
  const path = options.path ?? "file";
  if (oldString.length === 0) {
    throw new Error("old_string must not be empty.");
  }
  if (oldString === newString) {
    throw new Error("old_string and new_string are identical; refusing a no-op edit.");
  }

  const crlfFile = isConsistentCrlf(original);
  const normalizeCrlf = crlfFile && !oldString.includes("\r");
  const work = normalizeCrlf ? original.replace(/\r\n/g, "\n") : original;
  // Keep a CRLF file consistent when the replacement introduces LF lines.
  const effectiveNew = crlfFile && !normalizeCrlf && newString.includes("\n") && !newString.includes("\r")
    ? newString.replace(/\n/g, "\r\n")
    : newString;

  const first = work.indexOf(oldString);
  if (first < 0) {
    throw mismatchError(path, oldString, work, options);
  }

  let resultText: string;
  let replacements: number;

  if (options.replaceAll) {
    replacements = 0;
    resultText = "";
    let index = 0;
    while (index < work.length) {
      const foundAt = work.indexOf(oldString, index);
      if (foundAt < 0) {
        resultText += work.slice(index);
        break;
      }
      resultText += work.slice(index, foundAt) + effectiveNew;
      index = foundAt + oldString.length;
      replacements += 1;
    }
  } else {
    const second = work.indexOf(oldString, first + oldString.length);
    if (second >= 0) {
      const locations = allMatchLines(work, oldString)
        .map((line) => `line ${line}`)
        .join(", ");
      throw new Error(
        `Edit matched multiple locations in ${path} (${locations}). Pass replace_all=true to replace every occurrence, or add more surrounding lines to old_string so it matches exactly one.`,
      );
    }
    resultText = `${work.slice(0, first)}${effectiveNew}${work.slice(first + oldString.length)}`;
    replacements = 1;
  }

  return {
    text: normalizeCrlf ? resultText.replace(/\n/g, "\r\n") : resultText,
    replacements,
    lineEndingsNormalized: normalizeCrlf,
  };
}
