export interface ILNConfig {
    network: "testnet" | "mainnet";
    rpcUrl: string;
    defaultProfile?: string;
    pin?: string;
}
export interface ProfileData {
    name: string;
    publicKey: string;
    secretKey?: string;
}
export declare const DEFAULTS: ILNConfig;
/** Resolve the ILN home directory (injectable for tests). */
export declare function getIlnDir(baseDir?: string): string;
export declare function loadConfig(baseDir?: string): ILNConfig;
export declare function saveConfig(config: ILNConfig, baseDir?: string): void;
export declare function resetConfig(baseDir?: string): void;
export declare function getConfigValue(key: keyof ILNConfig, baseDir?: string): string | undefined;
export declare function setConfigValue(key: string, value: string, baseDir?: string): void;
export declare function profilePath(name: string, baseDir?: string): string;
export declare function saveProfile(profile: ProfileData, baseDir?: string, pin?: string): void;
export declare function loadProfile(name: string, baseDir?: string, pin?: string): ProfileData;
export declare function listProfiles(baseDir?: string): ProfileData[];
export declare function resolveProfile(profileFlag?: string, baseDir?: string, pin?: string): ProfileData | null;
//# sourceMappingURL=config.d.ts.map