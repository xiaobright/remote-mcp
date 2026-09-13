import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPositiveIntEnv } from "./env.js";
const DEFAULT_OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "work", "command-output");
export function outputResponse(text, result) {
    const { stdout: _stdout, stderr: _stderr, ...metadata } = result;
    return {
        content: [{ type: "text", text }],
        structuredContent: metadata,
    };
}
function tail(text, limit) {
    let start = Math.max(0, text.length - limit);
    // Do not start inside a UTF-16 surrogate pair.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]))
        start += 1;
    return text.slice(start);
}
/** Bound model-visible sync output without losing the full command result. */
export function commandOutputResponse(result, format, options = {}) {
    const limit = Math.max(2, options.limit ?? readPositiveIntEnv("REMOTE_MCP_OUTPUT_LIMIT_CHARS", 8192));
    const stdoutTruncated = result.stdout.length > limit;
    const stderrTruncated = result.stderr.length > limit;
    const notes = [];
    let fullOutput;
    let outputWarning;
    if (stdoutTruncated || stderrTruncated) {
        const dir = join(resolve(options.outputDir ?? process.env.REMOTE_MCP_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR), randomUUID());
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const paths = { stdout: join(dir, "stdout.log"), stderr: join(dir, "stderr.log") };
            writeFileSync(paths.stdout, result.stdout, { encoding: "utf8", mode: 0o600 });
            writeFileSync(paths.stderr, result.stderr, { encoding: "utf8", mode: 0o600 });
            fullOutput = paths;
            notes.push(`Output truncated to ${limit} characters per stream. Full output on the MCP host:\nstdout: ${paths.stdout}\nstderr: ${paths.stderr}`);
        }
        catch (error) {
            // Never turn an executed command into a retryable tool failure just because logging failed.
            outputWarning = `Output truncated; full-output save failed: ${error instanceof Error ? error.message : String(error)}. Do not rerun side effects just to recover output.`;
            notes.push(outputWarning);
        }
    }
    const visible = { ...result, stdout: tail(result.stdout, limit), stderr: tail(result.stderr, limit) };
    return outputResponse([format(visible), ...notes].join("\n"), {
        ...visible,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        stdoutTruncated,
        stderrTruncated,
        ...(fullOutput ? { fullOutput } : {}),
        ...(outputWarning ? { outputWarning } : {}),
    });
}
//# sourceMappingURL=output.js.map