import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKitUrl, changelogUrl, repositoryUrl } from '../src/shared/app-release';
import { appVersion } from '../src/app/app-version';

// The public footers read the version this build was compiled with, and nothing else may supply it.
// This suite runs through tsx with no build define, so the version must stay absent: a fabricated
// fallback such as '0.0.0' would render `v0.0.0` in every footer instead of omitting it.
test('the release identity reports the release notes and never invents a version', () => {
  assert.equal(appVersion, null);
  assert.equal(repositoryUrl, 'https://github.com/bestagentkits/design-studio-ai');
  assert.equal(changelogUrl, `${repositoryUrl}/releases`);
  assert.equal(agentKitUrl, 'https://agentkit.best');
});
