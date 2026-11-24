---
description: 'Let users sign in to another app with their bwf account and approve deployments to their projects.'
---

# Connected apps

A connected app is a separate application registered as an OAuth client on your bwf installation. Users sign in on bwf and decide whether to connect it. The application operator may be different from the platform administrator.

## Register an application

Open **Admin → Connected apps**. Enter the app name, its operator, and each exact HTTPS callback URL on a separate line. Wildcards and callback query strings are not supported. Enable individual publish approvals if the app builds and deploys projects. Enable private previews to run checkpoints before publishing. Existing clients have an **Enable private previews** button; users must connect again to consent to that permission.

Save the returned client ID and secret on the app's server. bwf shows the secret once. The client secret authenticates that application; it does not grant access to users' accounts. Register a new client if you need replacement credentials, then disable the old one.

**Disable and revoke access** invalidates the client's grants, pending sign-ins, and publish approvals. Registration and disablement appear in the operator audit.

Local development permits exact HTTP callbacks on localhost when the platform's development authentication bypass is explicitly enabled. Production clients require HTTPS.

## Connect and disconnect

The app sends users to bwf's authorization page, where bwf displays its registered name, operator, callback origin, and requested permission. Sign-in permits reading the user's ID and username. It does not provide an account token or project management access.

Users can disconnect apps at `<platform API URL>/oauth/connections`. Access tokens last one hour; apps can renew them with a refresh token for up to 30 days after the user's original sign-in. Revoking that sign-in or suspending the account ends access sooner. The app must then ask the user to sign in again.

## Private previews

Sign-in can request `scope=profile preview:deploy` when the administrator has enabled it. After user consent, the app can build private previews without approval for each checkpoint. Production publishing still requires individual approval.

Use the granted bearer token to:

1. POST `{ workspace: externalWorkspaceId }` to `/oauth/previews`. The response contains a stable `project_id` and preview `url` for that client, owner and workspace.
2. POST `{ project_id, checkpoint, artifact: prepared.artifact }` to `/oauth/preview-deployment-requests`. Use its `access_token` and `approval_id` with the same asset upload and deployment protocol as publishing.
3. Once deployment finishes, POST to `/oauth/previews/:id/launch` and open the returned URL. Launch URLs expire after one minute and can be used once. Reload the preview's origin after opening it.

Each workspace has a separate preview origin and resources, with no production secrets. Previews support HTTP apps with isolated D1, KV, R2, AI and native Durable Objects. Authentication, external databases, email, schedules, queues and containers require production publishing. Viewing requires the current user grant; disconnecting or disabling the app denies subsequent requests. Preview writes must originate from that preview's own origin.

Account Access policies must allow requests to generated preview origins to reach bwf. A policy that blocks new Workers hostnames also blocks previews. bwf still requires a valid preview grant when the hostname is reachable.

Each owner can have ten preview workspaces. Each workspace permits sixty builds per hour and shares the owner's platform resource and usage limits. Inactive previews expire after seven days and bwf removes their resources. Opening the workspace through `/oauth/previews` renews that expiry. Disabling preview permission expires its previews.

## Approve a publish

The app builds first, then sends the user to bwf with the prepared artifact. bwf displays the project name, checkpoint label, resources, manifest, and artifact digest. The user must explicitly approve on bwf.

Approval permits one deployment to that user's chosen project. bwf creates a missing project during approval; existing projects require ownership. The app receives a credential valid for up to fifteen minutes, restricted to that artifact's asset uploads, deployment, and receipt. Retries use the same receipt.

Published code can use that project's existing secrets and resources. Review the app operator and deployment details before approving code for an existing project. Migrations and resource changes in the approved manifest take effect during deployment.

Disabling the app or disconnecting its grant stops authorization for subsequent actions and is checked again before a queued deployment publishes. Disconnecting does not remove an app that has already been published; manage that project through bwf.

## Build an OAuth client

Discover endpoints at `/.well-known/oauth-authorization-server` on the platform API origin. Use authorization code flow with `scope=profile`, a random `state`, and S256 PKCE. Authenticate token exchanges using HTTP Basic client authentication. Send access tokens as Bearer credentials to `/oauth/userinfo`; its response contains `sub`, `preferred_username`, and the consented `scope`.

The code exchange also returns a refresh token. To renew access:

1. POST `grant_type=refresh_token` and the `refresh_token` to `/oauth/token`, using client Basic authentication.
2. Save the returned access token and refresh token securely, replacing the old pair.

Send one refresh at a time per connection. Each refresh token works once; reusing it revokes the connection and requires the user to reconnect.

To request fewer permissions, pass a space-separated `scope`. Later refreshes cannot restore permissions you dropped. Publish tokens (`deploy:approve`) have no refresh token: each publish needs its own approval.

For publishing, package the built app with [`prepareDeployArtifact`](/reference/api/deploy). POST to `/oauth/deployment-requests` using the profile token:

```ts
{
  redirect_uri: registeredCallback,
  state: publishState,
  code_challenge: publishChallenge,
  code_challenge_method: 'S256',
  slug: projectSlug,
  checkpoint: checkpointLabel,
  artifact: prepared.artifact
}
```

Redirect the browser to the returned `authorization_url`. Exchange its code with the publish verifier and the same registered callback. The response includes `project_id`, `approval_id`, and a `deploy:approve` access token. This publish flow is a bwf extension; requesting that scope in an ordinary sign-in does not authorize deployment.

Use the token to request URLs from the `deploy.uploadUrls` procedure (`POST /rpc/deploy.uploadUrls`), upload the declared assets, and send the artifact to `deploy.finalize` (`POST /rpc/deploy.finalize`) as `{ projectId, body, idempotencyKey }`. Set `idempotencyKey` to `approval_id`. Deployment uses bwf's managed deployment protocol and requires the platform deployment Queue. The credential cannot read secrets, mint project tokens, delete projects, or deploy different bytes.

Revoke a connection with `POST /oauth/revoke`, authenticated as the client, using either its access token or its refresh token. bwf does not issue an OpenID Connect ID token.

If the API is protected by Cloudflare Access, the application operator must also configure a service identity permitted by that Access application's policy. Server OAuth endpoints and approved deployment requests still validate their own client, grant, and project authority; browser consent requires the user's company identity.

## Act for an application's own people

Some applications are the front door to a Platform: their people build and publish from the application and don't have a Platform login. To let a registered client act for its own people, add its client id to the API Worker's `PLATFORM_APP_PERSON_CLIENTS` variable (comma separated). Unlisted clients get `unauthorized_client`.

The client asks for a token as itself, with `client_secret_basic`, and names the person with its own id for them:

```
POST /oauth/token
grant_type=urn:builtbyfriends:params:oauth:grant-type:app-person
person=<the application's id for the person>
```

Platform finds or makes a user for that person (provider `app:<client id>`) and returns an access token for one hour, with the client's `profile` and `preview:deploy` permissions. There's no refresh token: ask again when it runs out. Each token is its own grant, so two parts of the application can work for one person at the same time.

A publish still needs the person's approval, but the application asks for it in its own interface. Make the publish request as usual with the token, then, once the person approves, send the same token request with `publish_request` set to the returned `request_id`. The answer is the publish credential that the browser approval gives (`project_id`, `approval_id` and a `deploy:approve` token). Platform takes this request as the person's approval, so only list a client you trust to ask its people first.

### Read an app's resources and activity

A connected application can build a read-only operations view with its client credentials. It checks its own people's project permissions before each call. Platform checks that the project belongs to this connected application, then checks resource identity again after reading data.

Send these calls to `POST /app-billing/<call>`. Include `owner: { person }` or `owner: { group }` from the application's authorized project record. Platform checks the current owner before and after reading, so a transfer can't leave the old project view with access. Responses put the result in `data`.

| Call                 | Body                                                                | Result                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects.resources` | `{ project, owner }`                                                | Actual resource IDs, binding names, kinds and browse modes. Provider IDs, credentials and resource metadata are omitted.                      |
| `resources.inspect`  | `{ project, owner, resourceId, prefix?, cursor?, table?, offset? }` | File metadata, database tables or a page of table rows. Select an actual resource ID from the inventory; a binding name alone isn't accepted. |
| `projects.activity`  | `{ project, owner, cursor? }`                                       | Recent invocation logs and exceptions for the active deployment, newest first. These are app events, not an individual resource's health.     |

File browsing reads up to 50 object names, sizes and modification times per page. A `cursor` continues the listing. It doesn't download, upload or delete content. Database browsing lists up to 200 tables; selecting `table` returns up to 50 rows and `nextOffset`. Previews stop at offset 10,000 and 100 columns. Text cells are shortened to 1,000 characters, binary values display as `[binary]`, and credential-named columns display as `[redacted]`. The API constructs read queries; it doesn't accept SQL. Live table changes can shift rows between pages.

Storage reads use the API's private `PLATFORM_PROXY` binding. Without it, reads return `kind: "unavailable"` with a reason. An empty supported page remains a successful page. Other resource kinds can appear in the inventory but don't yet have a data browser.

Activity reads the current deployment's last hour with up to 50 invocations per page. Messages can arrive after a request finishes. With minimal runtime logging, `partial: true` indicates that URLs and message bodies weren't collected. URL query strings and fragments are omitted. Failed reads return `available: false`; local development doesn't substitute sample logs. These calls don't retry jobs, change data or deploy code.
