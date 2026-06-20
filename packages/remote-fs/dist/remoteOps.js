import { createHash } from "node:crypto";
import { dirnameScript, heredoc, randomSuffix, shellQuote } from "./shell.js";
import { runRemoteScript } from "./transport.js";
function requireSuccess(action, result) {
    if (result.timedOut) {
        throw new Error(`${action} timed out`);
    }
    if (result.exitCode !== 0) {
        throw new Error(`${action} failed with exit ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`);
    }
}
export function sha256Text(text) {
    return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
export async function readTextFile(target, path, maxBytes = 5 * 1024 * 1024) {
    const script = `set -eu
path=${shellQuote(path)}
max_bytes=${Math.max(1, Math.floor(maxBytes))}
if [ ! -e "$path" ]; then
  printf 'remote_file_read: not found: %s\\n' "$path" >&2
  exit 66
fi
if [ -d "$path" ]; then
  printf 'remote_file_read: is a directory: %s\\n' "$path" >&2
  exit 67
fi
size=$(wc -c < "$path" 2>/dev/null | tr -d ' ' || printf 0)
if [ "$size" -gt "$max_bytes" ]; then
  printf 'remote_file_read: file exceeds max_bytes: %s > %s\\n' "$size" "$max_bytes" >&2
  exit 78
fi
cat "$path"
`;
    const result = await runRemoteScript(target, script);
    requireSuccess("read", result);
    if (result.stdout.length > maxBytes) {
        throw new Error(`read exceeded max_bytes (${result.stdout.length} > ${maxBytes})`);
    }
    return result.stdout.toString("utf8");
}
export async function writeTextFile(target, options) {
    const suffix = randomSuffix();
    const content = Buffer.from(options.content, "utf8");
    const payload = content.toString("base64");
    const tag = `REMOTE_MCP_BASE64_${suffix}`;
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
  printf 'remote_file_write: refusing to overwrite existing path: %s\\n' "$path" >&2
  exit 73
fi
expected=${shellQuote(expectedSha)}
existing_mode=
if [ -n "$expected" ]; then
  if [ ! -e "$path" ]; then
    printf 'remote_file_write: expected existing file for sha256 check: %s\\n' "$path" >&2
    exit 74
  fi
  if ! command -v sha256sum >/dev/null 2>&1; then
    printf 'remote_file_write: sha256sum is required for expected_sha256 checks\\n' >&2
    exit 75
  fi
  set -- $(sha256sum "$path")
  if [ "$1" != "$expected" ]; then
    printf 'remote_file_write: sha256 mismatch for %s\\nexpected: %s\\nactual:   %s\\n' "$path" "$expected" "$1" >&2
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
  printf 'remote_file_write: base64 command is required on the remote host\\n' >&2
  exit 77
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
    const result = await runRemoteScript(target, script);
    requireSuccess("write", result);
    return { bytes: content.length, sha256: sha256Text(options.content) };
}
export async function statPath(target, path) {
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
    const result = await runRemoteScript(target, script);
    requireSuccess("stat", result);
    const info = { path, exists: false };
    for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
        if (!line) {
            continue;
        }
        const [key, value = ""] = line.split("\t");
        if (key === "exists") {
            info.exists = value === "true";
        }
        else if (key === "type") {
            info.type = value;
        }
        else if (key === "size" && value) {
            info.size = Number(value);
        }
        else if (key === "mode") {
            info.mode = value;
        }
        else if (key === "mtime" && value) {
            info.mtime = Number(value);
        }
    }
    return info;
}
export async function listDir(target, path) {
    const script = `set -eu
path=${shellQuote(path)}
if [ ! -d "$path" ]; then
  printf 'remote_file_list: not a directory: %s\\n' "$path" >&2
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
    const result = await runRemoteScript(target, script);
    requireSuccess("list", result);
    const fields = result.stdout.toString("utf8").split("\0");
    const entries = [];
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
export async function searchText(target, options) {
    const fixedFlag = options.fixed ?? true ? "F" : "";
    const maxResults = options.maxResults ?? 100;
    const script = `set -eu
path=${shellQuote(options.path)}
pattern=${shellQuote(options.pattern)}
if [ ! -e "$path" ]; then
  printf 'remote_file_search: not found: %s\\n' "$path" >&2
  exit 69
fi
if command -v grep >/dev/null 2>&1; then
  grep -RIn${fixedFlag} "$pattern" "$path" 2>/dev/null | head -n ${Math.max(1, Math.floor(maxResults))} || true
else
  printf 'remote_file_search: grep command is required on the remote host\\n' >&2
  exit 70
fi
`;
    const result = await runRemoteScript(target, script);
    requireSuccess("search", result);
    return result.stdout.toString("utf8");
}
//# sourceMappingURL=remoteOps.js.map