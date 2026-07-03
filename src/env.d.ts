// `virtual:pwa-info` is the ambient module that the @vite-pwa/astro
// integration depends on. Its declaration lives in the plugin's
// `info.d.ts` and uses an ambient `declare module "virtual:pwa-info"`
// block, which can only be pulled into the project via a
// `/// <reference types="..." />` — there is no `import`-only equivalent
// that registers an ambient `declare module` block.
/// <reference types="vite-plugin-pwa/info" />

declare module "virtual:pwa-info" {
  // Inline `import()` type — necessary because the @typescript-eslint
  // `consistent-type-imports` rule forbids it; we use it here and
  // suppress the rule for this single, unavoidable case.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  export const pwaInfo: import("vite-plugin-pwa/info").PwaInfo | undefined;
}
