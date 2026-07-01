/// <reference types="vite-plugin-pwa/info" />
declare module "virtual:pwa-info" {
  export const pwaInfo: import("vite-plugin-pwa/info").PwaInfo | undefined;
}
