/**
 * The application version this build serves, injected from package.json at build time.
 *
 * `null` outside a configured build (bare `tsx`, unit tests), so a footer omits the version instead
 * of printing a fabricated one. `typeof` is deliberate: a bare read of an undeclared identifier
 * throws a ReferenceError, while `typeof` returns 'undefined'.
 *
 * This lives in the app layer rather than `src/shared` because `src/shared` is also compiled by the
 * CLI project, which never receives the `__APP_VERSION__` define.
 */
export const appVersion: string | null =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : null;
