export interface PatchOperation {
  kind: "add" | "update";
  path: string;
  hunks?: PatchHunk[];
  lines?: string[];
}

export interface PatchHunk {
  lines: PatchLine[];
}

export interface PatchLine {
  op: "context" | "add" | "remove";
  text: string;
}

export interface AppliedPatch {
  text: string;
  added: number;
  removed: number;
}

function parseFilePath(line: string, prefix: string): string {
  const path = line.slice(prefix.length).trim();
  if (!path) {
    throw new Error(`Missing path in patch line: ${line}`);
  }
  return path;
}

export function parsePatch(input: string): PatchOperation[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const operations: PatchOperation[] = [];
  let index = 0;

  if (lines[index] === "*** Begin Patch") {
    index++;
  }

  while (index < lines.length) {
    const line = lines[index];
    if (!line || line === "*** End Patch") {
      index++;
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      throw new Error("Delete File patches are intentionally not supported by remote_file_apply_patch.");
    }

    if (line.startsWith("*** Add File:")) {
      const path = parseFilePath(line, "*** Add File:");
      index++;
      const addLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const current = lines[index];
        if (!current.startsWith("+")) {
          throw new Error(`Add File lines must start with '+': ${current}`);
        }
        addLines.push(current.slice(1));
        index++;
      }
      operations.push({ kind: "add", path, lines: addLines });
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const path = parseFilePath(line, "*** Update File:");
      index++;
      const hunks: PatchHunk[] = [];
      let current: PatchLine[] = [];

      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const currentLine = lines[index];
        if (currentLine.startsWith("@@")) {
          if (current.length > 0) {
            hunks.push({ lines: current });
            current = [];
          }
          index++;
          continue;
        }
        if (currentLine === "*** End of File") {
          index++;
          continue;
        }
        const marker = currentLine[0];
        if (marker === " ") {
          current.push({ op: "context", text: currentLine.slice(1) });
        } else if (marker === "+") {
          current.push({ op: "add", text: currentLine.slice(1) });
        } else if (marker === "-") {
          current.push({ op: "remove", text: currentLine.slice(1) });
        } else if (currentLine.length === 0) {
          throw new Error("Empty patch lines must include a leading patch marker.");
        } else {
          throw new Error(`Unsupported patch line: ${currentLine}`);
        }
        index++;
      }
      if (current.length > 0) {
        hunks.push({ lines: current });
      }
      if (hunks.length === 0) {
        throw new Error(`Update File patch has no hunks: ${path}`);
      }
      operations.push({ kind: "update", path, hunks });
      continue;
    }

    throw new Error(`Unsupported patch directive: ${line}`);
  }

  if (operations.length === 0) {
    throw new Error("Patch contains no supported file operations.");
  }
  return operations;
}

function splitText(text: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return { lines: [], trailingNewline: false };
  }
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body.length ? body.split("\n") : [], trailingNewline };
}

function joinText(lines: string[], trailingNewline: boolean): string {
  const body = lines.join("\n");
  return trailingNewline && (body.length > 0 || lines.length === 0) ? `${body}\n` : body;
}

function findSubsequence(haystack: string[], needle: string[], fromIndex: number): number {
  if (needle.length === 0) {
    return fromIndex;
  }

  for (let index = fromIndex; index <= haystack.length - needle.length; index++) {
    let matched = true;
    for (let inner = 0; inner < needle.length; inner++) {
      if (haystack[index + inner] !== needle[inner]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }
  return -1;
}

export function applyUpdatePatch(original: string, hunks: PatchHunk[], path: string): AppliedPatch {
  const split = splitText(original);
  let lines = split.lines;
  let searchIndex = 0;
  let added = 0;
  let removed = 0;

  for (const hunk of hunks) {
    const oldLines = hunk.lines
      .filter((line) => line.op === "context" || line.op === "remove")
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.op === "context" || line.op === "add")
      .map((line) => line.text);

    const foundAt = findSubsequence(lines, oldLines, searchIndex);
    if (foundAt < 0) {
      throw new Error(`Patch hunk did not match ${path}. First old line: ${oldLines[0] ?? "(empty insertion)"}`);
    }

    lines = [
      ...lines.slice(0, foundAt),
      ...newLines,
      ...lines.slice(foundAt + oldLines.length),
    ];
    searchIndex = foundAt + newLines.length;
    added += hunk.lines.filter((line) => line.op === "add").length;
    removed += hunk.lines.filter((line) => line.op === "remove").length;
  }

  return {
    text: joinText(lines, split.trailingNewline),
    added,
    removed,
  };
}

export function textForAddedFile(lines: string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
