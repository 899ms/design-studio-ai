/**
 * Public release locations for this workspace.
 *
 * Plain constants only: everything under `src/shared` is also compiled by the CLI TypeScript
 * project (`packages/cli/tsconfig.json`), which has no Vite ambient declarations. Build-injected
 * values such as `__APP_VERSION__` therefore belong to the app layer, not here.
 */

/** Canonical public source repository for this workspace. */
export const repositoryUrl = 'https://github.com/bestagentkits/design-studio-ai';

/** Release notes for every shipped version; the public footers' changelog destination. */
export const changelogUrl = `${repositoryUrl}/releases`;
