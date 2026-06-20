export type TransportKind = "wsl" | "ssh";
export interface RemoteTarget {
    transport: TransportKind;
    target?: string;
    distro?: string;
    ssh_options?: string[];
    timeout_ms?: number;
}
export interface RemoteRunResult {
    stdout: Buffer;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
}
export declare function runRemoteScript(target: RemoteTarget, script: string): Promise<RemoteRunResult>;
//# sourceMappingURL=transport.d.ts.map