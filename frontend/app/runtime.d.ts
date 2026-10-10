declare const __LINGXI_VERSION__: string;
declare module '*.css';
declare module "virtual:lingxi-runtime" {
  import type { ProfileSession } from "../../src/shared/contracts";
  export function installRuntime(): Promise<{
    render(): void;
    refresh(): Promise<unknown>;
    getUser(): ProfileSession["user"];
  }>;
}
declare module "virtual:lingxi-standalone" {
  export function installStandalone(): void;
}
