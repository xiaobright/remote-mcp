import { type ZodRawShape } from "zod";
import { type RemoteScriptRunner } from "./remoteOps.js";
interface RemoteFileToolServer {
    registerTool: (...args: any[]) => void;
}
export type RemoteFileToolHandler = (params: Record<string, unknown>) => Promise<any>;
export interface RegisterRemoteFileToolsOptions {
    server: RemoteFileToolServer;
    prefix: string;
    titlePrefix: string;
    targetDescription: string;
    targetFields?: ZodRawShape;
    makeRunner: (params: Record<string, unknown>) => RemoteScriptRunner;
}
export declare function registerRemoteFileTools(options: RegisterRemoteFileToolsOptions): Record<string, RemoteFileToolHandler>;
export declare function registerUnifiedRemoteFileTools(options: RegisterRemoteFileToolsOptions): Record<string, RemoteFileToolHandler>;
export {};
//# sourceMappingURL=fileTools.d.ts.map