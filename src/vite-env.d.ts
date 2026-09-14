/// <reference types="vite/client" />

/**
 * Application version injected at build time from package.json by vite.config.ts and by
 * scripts/build-public-docs.mjs. Absent (undefined at runtime) in unbundled consumers such as
 * `tsx` scripts and unit tests, which must degrade instead of failing.
 */
declare const __APP_VERSION__: string;
