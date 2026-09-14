import { ArrowUpRight } from 'lucide-react';
import { agentKitUrl, changelogUrl } from '../shared/app-release';
import { appVersion } from './app-version';

/**
 * Build identity for the public footers: the version this deployment serves and where its release
 * notes live, plus the AgentKit brand credit. The version is absent outside a configured build, so it is omitted rather than
 * fabricated. The icons are decorative: each link's accessible name stays its own text.
 *
 * The version renders as one template-literal child so the server output is a single text node
 * (`v0.4.3`); passing the literal `v` and `{appVersion}` as two adjacent children makes React emit
 * `v<!-- -->0.4.3`, which defeats the build-time and served-HTML checks that look for the version text.
 */
export function ReleaseIdentity() {
  return <div className="release-identity">
    {appVersion && <span className="release-version">{`v${appVersion}`}</span>}
    <a className="release-changelog" href={changelogUrl} target="_blank" rel="noreferrer">Changelog <ArrowUpRight size={14} aria-hidden="true" /></a>
    <a className="release-agentkit" href={agentKitUrl} target="_blank" rel="noreferrer">AgentKit © <ArrowUpRight size={14} aria-hidden="true" /></a>
  </div>;
}
