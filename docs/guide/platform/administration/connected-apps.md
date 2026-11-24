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

### Apps owned by a group

An app doesn't have to belong to one person. A group, such as a team, can own apps, so they stay when the person who made them leaves. Ask for a token for the group instead of a person, and name the person acting for it:

```
POST /oauth/token
grant_type=urn:builtbyfriends:params:oauth:grant-type:app-person
group=<the application's id for the group>
acting_person=<the application's id for the person>
```

Previews and publishes made with that token belong to the group, and each publish keeps the acting person. A person's id can't start with `group:`, and another application's group with the same id is a different group. Name a payer for a group's apps, such as the group's wallet, with `payer` or `projects.payer`.

Two more calls use the client's own credentials:

| Call             | Body                               | What it does                                                                                                                   |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `projects.owner` | `{ project, group, actingPerson }` | Moves one of the application's apps to a group, from a person or another group. It keeps its address, data, domains and payer. |
| `projects.list`  | `{ group }`                        | Lists the group's apps with their address and payer.                                                                           |

Send both to `POST /app-billing/<call>`. A preview can't move (`preview`). The person who had the app isn't added to its team, so removing them later leaves the app with the group.

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

### Custom domains and sign-in for an application's apps

An application can add custom domains to its people's apps and put an app behind sign-in. Both depend on the payer's plan: add `"customDomains": true` or `"protection": true` to a plan in the application's plan list. A payer on another plan gets `plan_required` with the `feature` it lacks. Custom domains also need the installation's `customDomains` capability, or the calls answer `CAPABILITY_UNAVAILABLE`.

| Call               | Body                        | What it does                                                                                                                                                                         |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domains.add`      | `{ project, hostname }`     | Adds a custom domain. The answer has the `dns` record to set (a CNAME) and Cloudflare's ownership check.                                                                             |
| `domains.status`   | `{ project, domainId }`     | Checks the domain with Cloudflare and turns it on once its DNS and certificate are ready.                                                                                            |
| `domains.list`     | `{ project }`               | Lists the app's custom domains.                                                                                                                                                      |
| `domains.remove`   | `{ project, domainId }`     | Removes a custom domain. It works whatever the payer's plan is.                                                                                                                      |
| `projects.protect` | `{ project, emailDomains }` | Lets only people signed in with an address at those email domains (1 to 20) into the app, at its own address and its custom domains. `{ project, protected: false }` opens it again. |

Send them to `POST /app-billing/<call>`. `project` is an app's id or address name, and a preview can't take a domain or sign-in. Domain errors use the same codes as `bwf domains`, such as `HOSTNAME_IN_USE`. Sign-in needs Cloudflare Access set up for the installation (see [Zero Trust](./zero-trust.md)); without it, `projects.protect` answers `ZERO_TRUST_UNAVAILABLE`. A payer who moves to a plan without these features keeps the domains and sign-in already set.

## Sell plans to an application's people

An application can sell plans to its people through Platform's billing. Open **Admin → Connected apps** and fill in **Plans its people can buy** for the application. Each entry pairs a plan id from the [plan catalog](./plans.md) with the Stripe price that charges for it and the credits it includes each month, in millionths of a dollar:

```json
{ "starter": { "stripePriceId": "price_…", "creditMicros": 20000000 } }
```

An application with no plan list has nothing on sale. Its plan list answers an empty list, and checkout answers `no_plans`. Checkout answers `bad_plan` for a plan that isn't in the list, and Platform ignores a payment for one.

If you remove a plan from the list later, people who hold it keep their Stripe subscription, and Stripe keeps charging them. They get no credits, and only the plan's limits in the catalog hold their use, until you move them to a plan in the list or cancel the subscription in Stripe.

### Sell a plan by the seat

Add `"perSeat": true` to a plan to sell it by the seat. `creditMicros` is then what each seat brings a month:

```json
{ "team": { "stripePriceId": "price_…", "creditMicros": 20000000, "perSeat": true } }
```

Checkout takes `quantity` (1 to 500) for such a plan. Any other plan answers `not_per_seat` for a count above 1. A seat plan can be held by a wallet: send `payer` with the wallet's id and `person` with the person who pays. `payer` has to be an opened wallet (`not_a_wallet`), and only a seat plan can be bought for someone else (`payer_must_be_buyer`).

To change the count, send `POST /app-billing/billing.seats` with `{ payer, quantity }`. More seats are charged at once for the share of the period that's left, and the count changes once that's paid. If the card fails, the answer has `paymentNeeded: true` and the old count stays. Fewer seats take effect at once, with no refund for the days left, and the next bill is lower. `usage.status` answers `seats: { count, priceCents, nextBillCents, nextBillAt }` for a seat plan, and `null` otherwise. Platform doesn't know who holds a seat, so the application checks that before it lowers the count.

Each paid invoice puts each seat's credits in the payer's balance, until the end of the paid period. A seat added partway through brings the same share of a seat's credits as the share of the price Stripe charged, rounded down to the cent: with $20 of credits on a $30 seat, a seat added halfway through charges $15 and brings $10. A removed seat brings nothing and takes nothing back. A refund or dispute of a seat change takes back that change's credits only. A dispute also cancels the seat subscription and blocks the person who paid.

A plan billed yearly, such as a seat at $300 a year, still brings `creditMicros` once a month. When the yearly invoice is paid, Platform adds one grant for each month of the year, each starting on its monthly date and ending a month later, so credits left at the end of a month don't carry over. A seat added partway through the year brings its share of the current month and a full month for each month after. A removed seat keeps the months already paid for. A refund takes back the months still to come first, so a full refund in month 4 stops months 5 to 12. A dispute takes back the whole year. Platform doesn't refund the months not yet used by itself. To do that, refund the payment from the person's page in the operator view.

## Sell credits

People can also buy credits once, with or without a plan. Fill in **Credits people can buy once** for the application, with amounts in millionths of a dollar:

```json
{ "minMicros": 20000000, "stepMicros": 20000000, "lifeDays": 365 }
```

This sells $20, $40, $60 and so on, and each purchase lasts 365 days. Leave it empty to sell none. Bought credits go on the same balance as a plan's credits, and the credits that end soonest are spent first.

The application starts a purchase with `POST /app-billing/credits.checkout` and `{ buyer, amountMicros, returnUrl }`, then sends the person to the returned `url`. `buyer` is the application's id for the person who pays. An amount under the smallest one or off the step answers `bad_amount`. Credits are added once Stripe confirms the payment, for the amount before tax. A second purchase reuses the buyer's Stripe customer.

### Auto top-up

Auto top-up is off until the person turns it on. It needs a card saved for later charges, so first send them through a credits Checkout with `saveCard: true`. Then turn it on:

```json
{
  "payer": "<person id>",
  "thresholdMicros": 5000000,
  "amountMicros": 20000000,
  "monthlyLimitMicros": 60000000
}
```

Send it to `POST /app-billing/credits.autoTopUp`, or send `{ payer, enabled: false }` to turn it off. Without a saved card it answers `needs_saved_card`. When the balance drops under the threshold, Platform charges the saved card once for the amount. Auto top-up turns itself off when a charge would go past the monthly limit or the card is declined, and `usage.status` says why in `autoTopUp.offReason` (`monthly_limit`, `card_declined` or `authentication_required`). Hosted use is read once an hour, so a top-up caused by a hosted project can come up to an hour later.

In Stripe, send `payment_intent.succeeded` and `payment_intent.payment_failed` to the webhook as well as the Checkout events.

### Sell a block of credits by invoice {#credit-block-invoice}

A larger customer often buys credits up front under a contract and pays by bank transfer weeks later. Send them a Stripe invoice for the block from the person's page in the operator view (**Invoice a block of credits**), or from the CLI:

```sh
bwf platform person invoice <client-id> <payer-id> --dollars 10000 --expires 2027-11-30 --email ap@example.com --plan
bwf platform person invoice <client-id> <payer-id> --dollars 10000 --expires 2027-11-30 --email ap@example.com --yes
```

The payer can be a person or a wallet, such as the wallet of the team the contract is for. `--expires` is when the credits end. Set it to the contract's end date. The invoice goes to `--email` and can be paid by US bank transfer or card within `--days` (30 by default), in US dollars.

When the whole invoice is paid, the credits go on the payer's balance, once. A part payment by bank transfer waits in the customer's Stripe balance until the rest arrives. The grant's source is `invoice` and it names the invoice.

For a customer you trust, add `--early yes` to grant the credits when the invoice is sent. The grant shows as unpaid until the invoice is paid. If you void the invoice in Stripe, or mark it uncollectible, Platform takes back what's left of the grant, and what was already spent becomes owed, as with a card dispute.

In Stripe, send `invoice.paid`, `invoice.voided` and `invoice.marked_uncollectible` to the webhook. Turn on bank transfers under **Settings → Payments → Payment methods**.

### Wallets

A payer doesn't have to be a person. An application can keep credits for something people share, such as a team or a bot, by opening a wallet for it with `POST /app-billing/wallets.open` and `{ payer }`. The id is the application's own. A wallet has no plan, caps or starter credit, only its balance, so a new wallet reads as zero and out. `credits.starter`, `billing.checkout` and `billing.portal` answer `payer_is_wallet` for one.

These calls help an application run a shared wallet:

| Call             | Body                                                    | What it does                                                                                                                                                    |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payer.pick`     | `{ wallets: [{ payer, person, monthlyLimitMicros? }] }` | Answers the first of up to five wallets that has credits and where the person is under their limit, and why each other one was skipped. It doesn't call Stripe. |
| `usage.record`   | `by` added to a report                                  | Counts the cost against `by` on that wallet for the month. `usage.status` with `byPerson: true` lists the totals.                                               |
| `credits.move`   | `{ from, to, amountMicros, id }`                        | Moves a person's bought credits into a wallet, keeping their end date. Credits don't move out of a wallet.                                                      |
| `credits.close`  | `{ payer }`                                             | Closes a wallet. Unspent bought credits go back to the people who paid for them, and the rest lapse.                                                            |
| `projects.payer` | `{ project, payer }`                                    | Points one of the application's hosted projects at another payer without a new publish.                                                                         |

Buying for, topping up or moving credits into a payer other than yourself is off until you add `"buyForOthers": true` to the application's credit sales. A card dispute blocks the person who paid, and the wallet keeps working once a later purchase settles what it owes.

You can also limit what one buyer pays for, and what one payer takes in from purchases and moves, in a UTC day:

```json
{
  "minMicros": 20000000,
  "stepMicros": 20000000,
  "lifeDays": 365,
  "buyForOthers": true,
  "buyerDailyMicros": 500000000,
  "walletDailyMicros": 1000000000
}
```

Past a limit, Checkout and moves answer `daily_cap` with what's left today, and auto top-up turns off with `daily_cap`. A Checkout that was already paid is still added. An application can also send `holdHours` with a Checkout. The credits then show as `pendingMicros` and can't be spent until the hold ends.

## Billing events

Platform can tell an application when something changes for a person who pays, so the application doesn't have to ask at the right moment. Under **Admin → Connected apps**, fill in the application's **Address for billing events** with an HTTPS URL. The first time you save an address, Platform shows a signing secret once. Save it on the application's server. Tick **Make a new signing secret** to replace it.

Platform sends each event as a `POST` with a JSON body:

```json
{
  "id": "evt_…",
  "type": "credits.low",
  "person": "<the application's id for the payer>",
  "occurredAt": "2026-11-22T18:00:00.000Z",
  "data": { "balanceMicros": 1500000 }
}
```

| Type                   | When                                                   | `data`                                                                                   |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `credits.low`          | The balance went under the low mark                    | `balanceMicros`                                                                          |
| `credits.out`          | The balance reached zero                               | `balanceMicros`, `pausesAt` (when the payer's hosted apps pause)                         |
| `credits.restored`     | The balance went back above zero                       | `balanceMicros`                                                                          |
| `apps.paused`          | Hosted apps the payer pays for were paused             | `projects` (project ids)                                                                 |
| `apps.resumed`         | Paused hosted apps answer again                        | `projects` (project ids)                                                                 |
| `credits.bought`       | Credits were bought at Checkout or by auto top-up      | `amountMicros`, `buyer`, `expiresAt`, `autoTopUp`                                        |
| `credits.moved`        | Credits were moved into the wallet                     | `from`, `amountMicros`, `id`                                                             |
| `app.payer_changed`    | A hosted project got a new payer                       | `projectId`, `from`                                                                      |
| `payment.failed`       | A subscription renewal or an auto top-up charge failed | `for` (`subscription` or `auto_top_up`), and for auto top-up `amountMicros` and `reason` |
| `subscription.started` | A plan was bought                                      | `plan`                                                                                   |
| `subscription.ended`   | The subscription ended                                 | none                                                                                     |

Amounts are in millionths of a dollar. Low and out are sent once each time the balance crosses the line. The low mark is $2 unless you set **A balance under this many micros is low**; 0 sends no low event. Hosted use is read once an hour, so an event caused by a hosted project can come up to an hour late.

Answer with any 2xx status. Platform tries a failed delivery again, waiting longer each time, for about a day and a half, and then stops. The same event keeps its `id`, so use it to skip one you've already handled. `usage.status` always has the same facts (`credits.outSince`, `credits.lowSince`, `autoTopUp`, `subscriptionStatus`), so read it to catch up after your address was down.

Each request carries a `Billing-Signature` header in the form `t=<unix seconds>,v1=<hex>`, where the hex is the HMAC-SHA256 of `<t>.<body>` with the signing secret. Check it against the raw body and refuse an old timestamp:

```ts
async function verify(body: string, header: string, secret: string): Promise<boolean> {
  const parts = new Map(header.split(',').map((part) => part.split('=') as [string, string]));
  const t = parts.get('t') ?? '';
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const hex = parts.get('v1') ?? '';
  const signature = new Uint8Array(hex.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? []);
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`${t}.${body}`));
}
```

## Charge for use

Platform counts what an application reports for its people (AI and sandbox time) and what the hosted projects they pay for use. Once an hour it reads each project's use from Cloudflare's analytics for today and yesterday and stores it under the project's payer. If one reading fails, Platform keeps the numbers it stored before for that reading and stores the others.

Set the price of each meter under **Admin → Connected apps → Usage prices**. Each price is in dollars for the meter's unit. The defaults are Cloudflare's own list prices, so at the defaults Platform charges about what Cloudflare charges you. To charge twice your cost, double each price. For AI prices and how the installation pays for AI, see [Paying for AI](./ai-billing.md).

### Hosted costs

| Cloudflare cost                       | Meter                  | Unit                 | Default price | State                                                       |
| ------------------------------------- | ---------------------- | -------------------- | ------------- | ----------------------------------------------------------- |
| Worker requests                       | `hostedRequests`       | 1 million requests   | $0.30         | Counted                                                     |
| Worker CPU time                       | `hostedCpuMs`          | 1 million ms         | $0.02         | Counted                                                     |
| AI through the gateway                | `hostedAiNeurons`      | 1 neuron             | $0.000011     | Counted                                                     |
| Sandbox time                          | `hostedSandboxSeconds` | 1 hour               | $0.10         | Counted                                                     |
| D1 storage                            | `hostedD1ByteDays`     | 1 GB-month           | $0.75         | Counted                                                     |
| D1 rows written                       | `hostedD1RowsWritten`  | 1 million rows       | $1.00         | Counted                                                     |
| D1 rows read                          | `hostedD1RowsRead`     | 1 million rows       | $0.001        | Counted                                                     |
| R2 storage                            | `hostedR2ByteDays`     | 1 GB-month           | $0.015        | Counted                                                     |
| R2 Class A operations (writes, lists) | `hostedR2ClassAOps`    | 1 million operations | $4.50         | Counted                                                     |
| R2 Class B operations (reads)         | `hostedR2ClassBOps`    | 1 million operations | $0.36         | Counted                                                     |
| KV storage                            | `hostedKvByteDays`     | 1 GB-month           | $0.50         | Counted                                                     |
| KV writes, deletes and lists          | `hostedKvWrites`       | 1 million operations | $5.00         | Counted                                                     |
| KV reads                              | `hostedKvReads`        | 1 million operations | $0.50         | Counted                                                     |
| Queue operations                      | `hostedQueueOps`       | 1 million operations | $0.40         | Counted                                                     |
| Bandwidth                             | `hostedBandwidthBytes` | 1 GB                 | $0            | Absorbed: Cloudflare doesn't charge for Worker or R2 egress |
| R2 deletes                            | none                   |                      |               | Absorbed: Cloudflare doesn't charge for them                |
| Workers Logs                          | none                   |                      |               | Absorbed. See below                                         |
| Durable Objects                       | none                   |                      |               | Absorbed. See below                                         |
| Containers                            | none                   |                      |               | Not counted yet                                             |
| Platform's own log rows               | none                   |                      |               | Absorbed: Workers Analytics Engine isn't billed at present  |

Platform charges from the first unit. It doesn't pass on the amounts Cloudflare includes with your plan each month, so those stay with you.

**Workers Logs.** Each hosted request writes at least one invocation log event, and Cloudflare charges $0.60 for each million events past the 20 million a month that Workers Paid includes. That's more than the default request price. Cloudflare moves Workers Logs to new Observability pricing on 2026-12-01. To keep this cost at zero, use [minimal runtime logs](/guide/platform/installation/setup#runtime-logs): they turn Workers Logs off for hosted projects, and Platform's own log rows still record each request. Otherwise, add the log cost to the request price.

**Durable Objects.** Requests to an object usually come through the app's own requests, which the plan's monthly request limit holds. Duration, alarms and WebSocket messages aren't held or counted yet.

Not confirmed: whether a request that goes through Platform's dispatch Worker and then the app's Worker bills as one request or two. If it bills as two, set the request price to at least $0.60 to cover your cost.

### Example: a busy app

One month of a busy hosted app, at the default prices:

| Use                      | Amount  | Cost       |
| ------------------------ | ------- | ---------- |
| Requests                 | 10 M    | $3.00      |
| CPU time                 | 50 M ms | $1.00      |
| D1 rows written          | 1 M     | $1.00      |
| D1 rows read             | 100 M   | $0.10      |
| D1 storage               | 2 GB    | $1.50      |
| R2 Class A operations    | 1 M     | $4.50      |
| R2 Class B operations    | 10 M    | $3.60      |
| R2 storage               | 10 GB   | $0.15      |
| KV writes                | 1 M     | $5.00      |
| KV reads                 | 10 M    | $5.00      |
| Queue operations         | 1 M     | $0.40      |
| **Charged to the payer** |         | **$25.25** |

Cloudflare charges you the same $25.25 for this use, less what your plan includes. With Workers Logs on, the app's 10 million invocation events can add up to $6.00 more, so turn them off or add them to the request price as shown above. At twice each default price, the payer pays $50.50.

## When a payer runs out of credits

When a payer's balance reaches zero, AI and sandbox time in the hosted apps they pay for stop at once. Each app keeps answering requests at a lower rate, 120 requests a minute, for the grace days. After that the app is paused: a visitor sees a page that says the app is paused, and its cron jobs and queues stop. Its data is kept.

The grace days are 3 unless you change them under **Admin → Connected apps → Grace days at zero**. When the payer gets credits again, their apps answer normally within a few minutes. An app you took down yourself stays down until you restore it.

A payer with no credits is held to their plan's monthly limits on hosted requests, AI and sandbox time instead. Platform adds up the use of every hosted app they pay for, whoever owns it, and checks it once an hour. Past the request limit, those apps are paused until the next month or until the payer buys a plan. Past the AI or sandbox limit, only AI or sandbox time stops. Apps under the same owner with another payer keep running.
