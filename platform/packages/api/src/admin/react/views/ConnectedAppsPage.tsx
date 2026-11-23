/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { AdminCard } from './AdminCard.tsx';
import { FormTextInput, FormTextArea, FormCheckbox } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';

export function ConnectedAppsPage({
  platformName,
  username,
  clients,
  meterPrices,
  meterUnits,
  graceDays,
  credentials,
  eventsSecret,
  error,
}: {
  platformName: string;
  username?: string;
  clients: Array<{
    id: string;
    name: string;
    operator: string;
    enabled: boolean;
    redirect_uris: Array<string>;
    scopes: Array<string>;
    plans?: Record<string, { stripePriceId: string; creditMicros: number }> | null;
    starter_credit_micros?: number | null;
    credit_purchase?: { minMicros: number; stepMicros: number; lifeDays: number } | null;
    events_url?: string | null;
    events_secret_set?: boolean;
    low_balance_micros?: number;
  }>;
  meterPrices?: Record<string, number>;
  meterUnits?: Record<string, number>;
  graceDays?: number;
  credentials?: { clientId: string; clientSecret: string };
  eventsSecret?: { clientId: string; secret: string };
  error?: string;
}) {
  return (
    <Layout title="Connected apps" platformName={platformName} username={username}>
      <h1>Connected apps</h1>
      <PageStack maxWidth={800}>
        {error && <p role="alert">{error}</p>}
        {credentials && (
          <AdminCard
            title="App credentials"
            description="Save the client secret on the app’s server. It is shown once."
          >
            <dl>
              <dt>Client ID</dt>
              <dd>
                <code>{credentials.clientId}</code>
              </dd>
              <dt>Client secret</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>
                <code>{credentials.clientSecret}</code>
              </dd>
            </dl>
          </AdminCard>
        )}
        {eventsSecret && (
          <AdminCard
            title="Billing events signing secret"
            description="Save it on the app’s server to check each event’s signature. It is shown once."
          >
            <dl>
              <dt>Client ID</dt>
              <dd>
                <code>{eventsSecret.clientId}</code>
              </dd>
              <dt>Signing secret</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>
                <code>{eventsSecret.secret}</code>
              </dd>
            </dl>
          </AdminCard>
        )}
        <AdminCard title="Register application">
          <SectionStack as="form" method="post" action="/admin/connected-apps">
            <FormTextInput label="App name" name="name" required maxLength={80} />
            <FormTextInput label="Operator" name="operator" required maxLength={160} />
            <FormTextArea
              label="Redirect URLs"
              name="redirectUris"
              required
              placeholder="https://build.example.com/auth/callback"
            />
            <FormCheckbox
              label="Allow users to approve individual publishes"
              name="publish"
              submitValue="true"
            />
            <FormCheckbox
              label="Allow private previews with isolated resources"
              name="preview"
              submitValue="true"
            />
            <Button type="submit" label="Register" />
          </SectionStack>
        </AdminCard>
        {meterPrices && (
          <AdminCard
            title="Usage prices"
            description="What each meter costs a connected app’s people, in dollars. Each price buys the number of units listed."
          >
            <SectionStack as="form" method="post" action="/admin/connected-apps/usage-prices">
              <p>
                <code>{JSON.stringify(meterUnits)}</code>
              </p>
              <FormTextArea
                label="Prices (JSON)"
                name="prices"
                required
                initialValue={JSON.stringify(meterPrices, null, 2)}
              />
              <Button type="submit" label="Save prices" />
            </SectionStack>
          </AdminCard>
        )}
        {graceDays !== undefined && (
          <AdminCard
            title="Grace days at zero"
            description="When a payer’s balance reaches zero, their hosted apps keep answering at a lower request rate for this many days, then pause until credits return. A paused app’s data is kept."
          >
            <SectionStack as="form" method="post" action="/admin/connected-apps/grace-days">
              <FormTextInput label="Days" name="days" required initialValue={String(graceDays)} />
              <Button type="submit" label="Save grace days" />
            </SectionStack>
          </AdminCard>
        )}
        {clients.map((client) => (
          <AdminCard key={client.id} title={client.name} description={client.operator}>
            <p>
              <code>{client.id}</code>
            </p>
            <p>{client.redirect_uris.join(', ')}</p>
            <p>{client.enabled ? 'Enabled' : 'Disabled'}</p>
            <p>
              <a href={`/admin/connected-apps/${encodeURIComponent(client.id)}/people`}>People</a>
            </p>
            {client.enabled && (
              <form method="post" action={`/admin/connected-apps/${client.id}/preview-permission`}>
                <input
                  type="hidden"
                  name="enabled"
                  defaultValue={client.scopes.includes('preview:deploy') ? 'false' : 'true'}
                />
                <Button
                  type="submit"
                  label={
                    client.scopes.includes('preview:deploy')
                      ? 'Disable private previews'
                      : 'Enable private previews'
                  }
                />
              </form>
            )}
            {client.enabled && (
              <SectionStack
                as="form"
                method="post"
                action={`/admin/connected-apps/${client.id}/plans`}
              >
                <FormTextArea
                  label="Plans its people can buy (JSON). Empty puts nothing on sale."
                  name="plans"
                  placeholder='{ "plan-id": { "stripePriceId": "price_…", "creditMicros": 0 } }'
                  initialValue={client.plans ? JSON.stringify(client.plans, null, 2) : ''}
                />
                <FormTextInput
                  label="Starter credit in micros, given once to each person the app names. Empty gives none."
                  name="starterCreditMicros"
                  placeholder="2000000"
                  initialValue={
                    client.starter_credit_micros ? String(client.starter_credit_micros) : ''
                  }
                />
                <FormTextInput
                  label="Credits people can buy once (JSON): the smallest amount and the step in micros, and how many days they last. Empty sells none."
                  name="creditPurchase"
                  placeholder='{ "minMicros": 20000000, "stepMicros": 20000000, "lifeDays": 365 }'
                  initialValue={
                    client.credit_purchase ? JSON.stringify(client.credit_purchase) : ''
                  }
                />
                <Button type="submit" label="Save plans" />
              </SectionStack>
            )}
            {client.enabled && (
              <SectionStack
                as="form"
                method="post"
                action={`/admin/connected-apps/${client.id}/events`}
              >
                <FormTextInput
                  label="Address for billing events (HTTPS). Empty sends none."
                  name="eventsUrl"
                  placeholder="https://app.example.com/billing-events"
                  initialValue={client.events_url ?? ''}
                />
                <FormTextInput
                  label="A balance under this many micros is low. 0 sends no low-balance event."
                  name="lowBalanceMicros"
                  placeholder="2000000"
                  initialValue={String(client.low_balance_micros ?? 2_000_000)}
                />
                {client.events_secret_set && (
                  <FormCheckbox
                    label="Make a new signing secret"
                    name="newSecret"
                    submitValue="true"
                  />
                )}
                <Button type="submit" label="Save billing events" />
              </SectionStack>
            )}
            {client.enabled && (
              <form
                method="post"
                action={`/admin/connected-apps/${client.id}/disable`}
                data-confirm="Disable this app and revoke all of its access?"
              >
                <Button type="submit" label="Disable and revoke access" />
              </form>
            )}
          </AdminCard>
        ))}
      </PageStack>
    </Layout>
  );
}
