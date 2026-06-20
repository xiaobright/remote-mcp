export declare function shellQuote(value: string): string;
export declare function randomSuffix(): string;
export declare function heredoc(tag: string, body: string): string;
export declare function joinRemotePath(root: string | undefined, path: string): string;
export declare function dirnameScript(pathVar: string, outVar: string): string;
export declare function validateShell(shell: string): string;
export declare function validateEnvName(name: string): string;
export declare function buildEnvPreamble(env?: Record<string, string>): string;
export declare function buildWorkdirPreamble(workdir?: string): string;
//# sourceMappingURL=shell.d.ts.map