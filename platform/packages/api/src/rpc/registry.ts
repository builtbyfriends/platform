import { defineRegistry } from '@builtbyfriends/realtime';
import { checkout as billingCheckout } from './procedures/billing.ts';
import {
  list as credentialsList,
  remove as credentialsRemove,
  set as credentialsSet,
} from './procedures/credentials.ts';
import {
  getUrl as databaseGetUrl,
  provision as databaseProvision,
  setUrl as databaseSetUrl,
} from './procedures/database.ts';
import {
  preflight as deployPreflight,
  uploadUrls as deployUploadUrls,
  workerUploadUrls as deployWorkerUploadUrls,
} from './procedures/deploy.ts';
import { events as deploymentsEvents, list as deploymentsList } from './procedures/deployments.ts';
import {
  add as domainsAdd,
  list as domainsList,
  remove as domainsRemove,
  status as domainsStatus,
} from './procedures/domains.ts';
import { finalize as finalizeFinalize } from './procedures/finalize.ts';
import { get as meGet } from './procedures/me.ts';
import {
  choices as projectsChoices,
  create as projectsCreate,
  get as projectsGet,
  list as projectsList,
  resolve as projectsResolve,
  resources as projectsResources,
} from './procedures/projects.ts';
import {
  list as secretsList,
  remove as secretsRemove,
  set as secretsSet,
} from './procedures/secrets.ts';
import {
  invite as teamInvite,
  leave as teamLeave,
  listInvitations as teamListInvitations,
  listMembers as teamListMembers,
  myInvitations as teamMyInvitations,
  removeMember as teamRemoveMember,
  resend as teamResend,
  respond as teamRespond,
  revoke as teamRevoke,
  setRole as teamSetRole,
} from './procedures/team.ts';
import {
  create as tokensCreate,
  list as tokensList,
  renew as tokensRenew,
  revoke as tokensRevoke,
} from './procedures/tokens.ts';
import { account as usageAccount, project as usageProject } from './procedures/usage.ts';

/** Every platform procedure. The API Worker serves it at `/rpc`; clients import only its type. */
export const registry = defineRegistry([
  billingCheckout,
  meGet,
  projectsCreate,
  projectsList,
  projectsChoices,
  projectsResolve,
  projectsGet,
  projectsResources,
  finalizeFinalize,
  deployPreflight,
  deployUploadUrls,
  deployWorkerUploadUrls,
  deploymentsList,
  deploymentsEvents,
  databaseProvision,
  databaseSetUrl,
  databaseGetUrl,
  domainsAdd,
  domainsList,
  domainsStatus,
  domainsRemove,
  secretsList,
  credentialsSet,
  credentialsList,
  credentialsRemove,
  secretsSet,
  secretsRemove,
  teamListMembers,
  teamListInvitations,
  teamInvite,
  teamResend,
  teamRevoke,
  teamSetRole,
  teamRemoveMember,
  teamLeave,
  teamMyInvitations,
  teamRespond,
  tokensList,
  tokensCreate,
  tokensRenew,
  tokensRevoke,
  usageAccount,
  usageProject,
]);

export type PlatformRegistry = typeof registry;
