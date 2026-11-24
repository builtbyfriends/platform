import type { DeployArtifact } from '@builtbyfriends/deploy-core';
import type { CompanyIdentity } from './identity-types.ts';
import type { JwtPayload } from './jwt.ts';

export type OAuthScope = 'profile' | 'deploy:approve' | 'preview:deploy';
export type OAuthRequestData = {
  kind: 'profile' | 'deployment' | 'preview' | 'connections';
  scopes?: Array<OAuthScope>;
  redirectUri: string;
  state: string;
  challenge: string;
  loginVerifier?: string;
  grantId?: string;
  slug?: string;
  checkpoint?: string;
  artifact?: DeployArtifact;
  artifactDigest?: string;
  workerModules?: Array<string>;
  projectId?: string;
  actingPerson?: string;
};
export type OAuthSession = Pick<JwtPayload, 'sub' | 'aud' | 'sid' | 'exp'> & {
  // Decision: Attested by Platform's Access middleware during consent, not by the client.
  companyIdentity?: CompanyIdentity;
  /**
   * Set on a grant that a trusted application asked for on behalf of one of its own people
   * (the app-person grant in routes/oauth.ts). There is no Platform login session behind it:
   * the application is the person's sign-in, so the human-session check does not apply.
   */
  appPerson?: true;
  actingPerson?: string;
};
