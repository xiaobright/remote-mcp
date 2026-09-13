export interface ToolFeatures {
    files: boolean;
    admin: boolean;
    fileApi: "split" | "unified";
}
export declare function toolFeatures(env?: NodeJS.ProcessEnv): ToolFeatures;
type Backend = "ssh" | "wsl";
type ToolRegistrar = {
    registerTool: (...args: any[]) => unknown;
};
export declare function registerHelpTool(server: ToolRegistrar, backend: Backend, features: ToolFeatures): void;
export {};
//# sourceMappingURL=toolSurface.d.ts.map