import { createHash } from "node:crypto";
import iconv from "iconv-lite";
import { dirnameScript, heredoc, randomSuffix, shellQuote } from "../shell.js";
import { type RemoteTarget, runRemoteScript } from "./transport.js";

export interface RemoteScriptRunnerResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  [key: string]: unknown;
}

export type RemoteScriptRunner = (script: string) => Promise<RemoteScriptRunnerResult>;
export type RemoteRunner = RemoteTarget | RemoteScriptRunner;

export interface RemoteTextOptions {
  maxBytes?: number;
  encoding?: string;
}

export interface RemoteTextDecodeResult {
  text: string;
  encoding: string;
  requestedEncoding: string;
  detectedEncoding: string;
  confidence: number;
  warning?: string;
  bytes: number;
  sha256: string;
}

const OCTAL_FALLBACK_LIMIT = 512 * 1024;
const AUTO_ENCODING = "auto";
const AUTO_MIN_CONFIDENCE = 0.5;

export interface RemoteFileInfo {
  path: string;
  exists: boolean;
  type?: string;
  size?: number;
  mode?: string;
  mtime?: number;
  [key: string]: unknown;
}

export interface RemoteListEntry {
  name: string;
  type: string;
  size?: number;
  mtime?: number;
  [key: string]: unknown;
}

function requireSuccess(action: string, result: { exitCode: number; stderr: string; timedOut?: boolean }): void {
  if (result.timedOut) {
    throw new Error(`${action} timed out`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed with exit ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`);
  }
}

export function sha256Text(text: string, encoding?: string): string {
  return sha256Bytes(encodeRemoteText(text, encoding));
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeEncoding(encoding?: string, fallback = AUTO_ENCODING): string {
  const normalized = (encoding?.trim() || fallback).toLowerCase().replace(/_/g, "-");
  return normalized === "utf8" ? "utf-8" : normalized;
}

function utf8DecodeStrict(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function stripBom(bytes: Buffer, encoding: string): Buffer {
  if (encoding === "utf-8" && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  if (encoding === "utf16-le" && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2);
  }
  if (encoding === "utf16-be" && bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2);
  }
  return bytes;
}

function textQuality(text: string): { controlRatio: number; cjkCount: number; replacements: number } {
  let controls = 0;
  let cjkCount = 0;
  let replacements = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0xfffd) {
      replacements += 1;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      controls += 1;
    }
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      cjkCount += 1;
    }
  }
  return {
    controlRatio: text.length ? controls / text.length : 0,
    cjkCount,
    replacements,
  };
}

function confidenceForDecodedText(text: string, base: number): number {
  const quality = textQuality(text);
  if (quality.replacements > 0) {
    return Math.min(base, 0.2);
  }
  if (quality.controlRatio > 0.05) {
    return Math.min(base, 0.35);
  }
  if (quality.cjkCount > 0) {
    return base;
  }
  return Math.min(base, 0.45);
}

export function detectRemoteTextEncoding(bytes: Buffer): Omit<RemoteTextDecodeResult, "bytes" | "sha256"> {
  if (bytes.length === 0) {
    return {
      text: "",
      encoding: "utf-8",
      requestedEncoding: AUTO_ENCODING,
      detectedEncoding: "utf-8",
      confidence: 1,
    };
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: stripBom(bytes, "utf-8").toString("utf8"),
      encoding: "utf-8",
      requestedEncoding: AUTO_ENCODING,
      detectedEncoding: "utf-8",
      confidence: 1,
    };
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = iconv.decode(stripBom(bytes, "utf16-le"), "utf16-le");
    return {
      text,
      encoding: "utf16-le",
      requestedEncoding: AUTO_ENCODING,
      detectedEncoding: "utf16-le",
      confidence: 1,
    };
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = iconv.decode(stripBom(bytes, "utf16-be"), "utf16-be");
    return {
      text,
      encoding: "utf16-be",
      requestedEncoding: AUTO_ENCODING,
      detectedEncoding: "utf16-be",
      confidence: 1,
    };
  }

  const strictUtf8 = utf8DecodeStrict(bytes);
  if (strictUtf8 !== null) {
    const quality = textQuality(strictUtf8);
    const confidence = quality.controlRatio > 0.05 ? 0.35 : 0.95;
    return {
      text: strictUtf8,
      encoding: "utf-8",
      requestedEncoding: AUTO_ENCODING,
      detectedEncoding: "utf-8",
      confidence,
      warning: confidence < AUTO_MIN_CONFIDENCE ? "UTF-8 is valid but contains many control characters." : undefined,
    };
  }

  const candidates = ["gbk", "gb18030", "big5"]
    .filter((candidate) => iconv.encodingExists(candidate))
    .map((candidate) => {
      const text = iconv.decode(bytes, candidate);
      return {
        text,
        encoding: candidate,
        requestedEncoding: AUTO_ENCODING,
        detectedEncoding: candidate,
        confidence: confidenceForDecodedText(text, candidate === "gbk" ? 0.8 : 0.7),
      };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const best = candidates[0];
  if (best) {
    return {
      ...best,
      warning: best.confidence < AUTO_MIN_CONFIDENCE ? "Encoding detection confidence is low." : undefined,
    };
  }

  const text = iconv.decode(bytes, "latin1");
  return {
    text,
    encoding: "latin1",
    requestedEncoding: AUTO_ENCODING,
    detectedEncoding: "latin1",
    confidence: 0.2,
    warning: "Fell back to latin1 with low confidence.",
  };
}

export function decodeRemoteTextResult(bytes: Buffer, encoding?: string): RemoteTextDecodeResult {
  const requestedEncoding = normalizeEncoding(encoding);
  const sha256 = sha256Bytes(bytes);
  if (requestedEncoding === AUTO_ENCODING) {
    const detected = detectRemoteTextEncoding(bytes);
    if (detected.confidence < AUTO_MIN_CONFIDENCE) {
      throw new Error(`Could not confidently detect text encoding (best=${detected.detectedEncoding}, confidence=${detected.confidence}). Pass encoding explicitly, e.g. "utf-8", "gbk", or "gb18030".`);
    }
    return {
      ...detected,
      requestedEncoding,
      bytes: bytes.length,
      sha256,
    };
  }

  if (!iconv.encodingExists(requestedEncoding)) {
    throw new Error(`Unsupported text encoding: ${encoding}`);
  }
  return {
    text: iconv.decode(stripBom(bytes, requestedEncoding), requestedEncoding),
    encoding: requestedEncoding,
    requestedEncoding,
    detectedEncoding: requestedEncoding,
    confidence: 1,
    bytes: bytes.length,
    sha256,
  };
}

export function decodeRemoteText(bytes: Buffer, encoding?: string): string {
  return decodeRemoteTextResult(bytes, encoding).text;
}

export function encodeRemoteText(text: string, encoding?: string): Buffer {
  const normalized = normalizeEncoding(encoding, "utf-8");
  const concrete = normalized === AUTO_ENCODING ? "utf-8" : normalized;
  if (concrete === "utf-8") {
    return Buffer.from(text, "utf8");
  }
  if (!iconv.encodingExists(concrete)) {
    throw new Error(`Unsupported text encoding: ${encoding}`);
  }
  return iconv.encode(text, concrete);
}

function parseTextOptions(
  maxBytesOrOptions?: number | RemoteTextOptions,
  encoding?: string,
): Required<RemoteTextOptions> {
  if (typeof maxBytesOrOptions === "number") {
    return {
      maxBytes: Math.max(1, Math.floor(maxBytesOrOptions)),
      encoding: normalizeEncoding(encoding),
    };
  }

  return {
    maxBytes: Math.max(1, Math.floor(maxBytesOrOptions?.maxBytes ?? 5 * 1024 * 1024)),
    encoding: normalizeEncoding(maxBytesOrOptions?.encoding ?? encoding),
  };
}

function octalWriteFallback(bytes: Buffer, destination: string): string {
  if (bytes.length > OCTAL_FALLBACK_LIMIT) {
    return `printf 'remote_write: base64 command is required for files larger than ${OCTAL_FALLBACK_LIMIT} bytes\\n' >&2
exit 77`;
  }

  if (bytes.length === 0) {
    return `: > "${destination}"`;
  }

  const lines = [`: > "${destination}"`];
  const chunkSize = 4096;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    let escaped = "";
    for (const byte of chunk) {
      escaped += `\\${byte.toString(8).padStart(3, "0")}`;
    }
    lines.push(`printf '%b' '${escaped}' >> "${destination}"`);
  }
  return lines.join("\n");
}

async function runWith(runner: RemoteRunner, script: string): Promise<RemoteScriptRunnerResult> {
  if (typeof runner === "function") {
    return runner(script);
  }
  const result = await runRemoteScript(runner, script);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}

export async function readFileBytes(
  target: RemoteRunner,
  path: string,
  maxBytesOrOptions?: number | RemoteTextOptions,
): Promise<Buffer> {
  const options = parseTextOptions(maxBytesOrOptions);
  const script = `set -eu
path=${shellQuote(path)}
max_bytes=${options.maxBytes}
if [ ! -e "$path" ]; then
  printf 'remote_read: not found: %s\\n' "$path" >&2
  exit 66
fi
if [ -d "$path" ]; then
  printf 'remote_read: is a directory: %s\\n' "$path" >&2
  exit 67
fi
size=$(wc -c < "$path" 2>/dev/null | tr -d ' ' || printf 0)
if [ "$size" -gt "$max_bytes" ]; then
  printf 'remote_read: file exceeds max_bytes: %s > %s\\n' "$size" "$max_bytes" >&2
  exit 78
fi
cat "$path"
`;
  const result = await runWith(target, script);
  requireSuccess("read", result);
  if (result.stdout.length > options.maxBytes) {
    throw new Error(`read exceeded max_bytes (${result.stdout.length} > ${options.maxBytes})`);
  }
  return result.stdout;
}

export async function readTextFile(
  target: RemoteRunner,
  path: string,
  maxBytesOrOptions?: number | RemoteTextOptions,
  encoding?: string,
): Promise<string> {
  return (await readTextFileDecoded(target, path, maxBytesOrOptions, encoding)).text;
}

export async function readTextFileDecoded(
  target: RemoteRunner,
  path: string,
  maxBytesOrOptions?: number | RemoteTextOptions,
  encoding?: string,
): Promise<RemoteTextDecodeResult> {
  const options = parseTextOptions(maxBytesOrOptions, encoding);
  const bytes = await readFileBytes(target, path, options);
  return decodeRemoteTextResult(bytes, options.encoding);
}

export async function writeTextFile(target: RemoteRunner, options: {
  path: string;
  content: string;
  createParents?: boolean;
  overwrite?: boolean;
  expectedSha256?: string;
  mode?: string;
  encoding?: string;
}): Promise<{ bytes: number; sha256: string }> {
  const suffix = randomSuffix();
  const content = encodeRemoteText(options.content, options.encoding);
  const payload = content.toString("base64");
  const tag = `REMOTE_MCP_BASE64_${suffix}`;
  const fallback = octalWriteFallback(content, "$tmp");
  const overwrite = options.overwrite ?? true;
  const createParents = options.createParents ?? true;
  const expectedSha = options.expectedSha256 ?? "";
  const mode = options.mode ?? "";

  const script = `set -eu
path=${shellQuote(options.path)}
${dirnameScript("path", "dir")}
base=\${path##*/}
tmp="$dir/.$base.remote-mcp.${suffix}.tmp"
if [ ${createParents ? "1" : "0"} -eq 1 ]; then
  mkdir -p "$dir"
fi
if [ ${overwrite ? "0" : "1"} -eq 1 ] && [ -e "$path" ]; then
  printf 'remote_write: refusing to overwrite existing path: %s\\n' "$path" >&2
  exit 73
fi
expected=${shellQuote(expectedSha)}
existing_mode=
if [ -n "$expected" ]; then
  if [ ! -e "$path" ]; then
    printf 'remote_write: expected existing file for sha256 check: %s\\n' "$path" >&2
    exit 74
  fi
  if ! command -v sha256sum >/dev/null 2>&1; then
    printf 'remote_write: sha256sum is required for expected_sha256 checks\\n' >&2
    exit 75
  fi
  set -- $(sha256sum "$path")
  if [ "$1" != "$expected" ]; then
    printf 'remote_write: sha256 mismatch for %s\\nexpected: %s\\nactual:   %s\\n' "$path" "$expected" "$1" >&2
    exit 76
  fi
fi
if [ -e "$path" ] && command -v stat >/dev/null 2>&1; then
  existing_mode=$(stat -c '%a' "$path" 2>/dev/null || true)
fi
trap 'rm -f "$tmp"' EXIT HUP INT TERM
if command -v base64 >/dev/null 2>&1; then
  if ! base64 -d > "$tmp" ${heredoc(tag, payload)}
  then
    base64 --decode > "$tmp" ${heredoc(tag, payload)}
  fi
else
  ${fallback}
fi
requested_mode=${shellQuote(mode)}
if [ -n "$requested_mode" ]; then
  chmod "$requested_mode" "$tmp"
elif [ -n "$existing_mode" ]; then
  chmod "$existing_mode" "$tmp"
fi
mv -f "$tmp" "$path"
trap - EXIT
`;
  const result = await runWith(target, script);
  requireSuccess("write", result);
  return { bytes: content.length, sha256: sha256Bytes(content) };
}

export async function statPath(target: RemoteRunner, path: string): Promise<RemoteFileInfo> {
  const script = `set -eu
path=${shellQuote(path)}
if [ ! -e "$path" ] && [ ! -L "$path" ]; then
  printf 'exists\\tfalse\\n'
  exit 0
fi
if [ -d "$path" ]; then type=directory
elif [ -L "$path" ]; then type=symlink
elif [ -f "$path" ]; then type=file
else type=other
fi
size=$(wc -c < "$path" 2>/dev/null | tr -d ' ' || true)
mode=$(stat -c '%a' "$path" 2>/dev/null || true)
mtime=$(stat -c '%Y' "$path" 2>/dev/null || true)
printf 'exists\\ttrue\\n'
printf 'type\\t%s\\n' "$type"
printf 'size\\t%s\\n' "$size"
printf 'mode\\t%s\\n' "$mode"
printf 'mtime\\t%s\\n' "$mtime"
`;
  const result = await runWith(target, script);
  requireSuccess("stat", result);
  const info: RemoteFileInfo = { path, exists: false };
  for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const [key, value = ""] = line.split("\t");
    if (key === "exists") {
      info.exists = value === "true";
    } else if (key === "type") {
      info.type = value;
    } else if (key === "size" && value) {
      info.size = Number(value);
    } else if (key === "mode") {
      info.mode = value;
    } else if (key === "mtime" && value) {
      info.mtime = Number(value);
    }
  }
  return info;
}

export async function listDir(target: RemoteRunner, path: string): Promise<RemoteListEntry[]> {
  const script = `set -eu
path=${shellQuote(path)}
if [ ! -d "$path" ]; then
  printf 'remote_list: not a directory: %s\\n' "$path" >&2
  exit 68
fi
for p in "$path"/* "$path"/.[!.]* "$path"/..?*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  name=\${p##*/}
  if [ -d "$p" ]; then type=directory
  elif [ -L "$p" ]; then type=symlink
  elif [ -f "$p" ]; then type=file
  else type=other
  fi
  size=$(wc -c < "$p" 2>/dev/null | tr -d ' ' || true)
  mtime=$(stat -c '%Y' "$p" 2>/dev/null || true)
  printf '%s\\0%s\\0%s\\0%s\\0' "$name" "$type" "$size" "$mtime"
done
`;
  const result = await runWith(target, script);
  requireSuccess("list", result);
  const fields = result.stdout.toString("utf8").split("\0");
  const entries: RemoteListEntry[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [name, type, size, mtime] = fields.slice(index, index + 4);
    if (!name) {
      continue;
    }
    entries.push({
      name,
      type,
      size: size ? Number(size) : undefined,
      mtime: mtime ? Number(mtime) : undefined,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export async function searchText(target: RemoteRunner, options: {
  path: string;
  pattern: string;
  fixed?: boolean;
  maxResults?: number;
  encoding?: string;
}): Promise<string> {
  const fixedFlag = options.fixed ?? true ? "F" : "";
  const maxResults = options.maxResults ?? 100;
  const script = `set -eu
path=${shellQuote(options.path)}
pattern=${shellQuote(options.pattern)}
if [ ! -e "$path" ]; then
  printf 'remote_search: not found: %s\\n' "$path" >&2
  exit 69
fi
if command -v grep >/dev/null 2>&1; then
  grep -RIn${fixedFlag} "$pattern" "$path" 2>/dev/null | head -n ${Math.max(1, Math.floor(maxResults))} || true
else
  printf 'remote_search: grep command is required on the remote host\\n' >&2
  exit 70
fi
`;
  const result = await runWith(target, script);
  requireSuccess("search", result);
  return decodeRemoteText(result.stdout, options.encoding);
}
