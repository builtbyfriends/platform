/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import type { getAppPerson, listAppPeople } from '../../../operator/app-people.ts';
import { AdminCard } from './AdminCard.tsx';
import { FormTextInput } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';

type People = Awaited<ReturnType<typeof listAppPeople>>;
type Person = Awaited<ReturnType<typeof getAppPerson>>;

const dollars = (micros: number | null) =>
  micros === null ? '-' : `$${(micros / 1e6).toFixed(micros % 10_000 === 0 ? 2 : 6)}`;

const personPath = (clientId: string, person: string) =>
  `/admin/connected-apps/${encodeURIComponent(clientId)}/people/${encodeURIComponent(person)}`;

export function AppPeoplePage({
  result,
  search,
  platformName,
  username,
}: {
  result: People;
  search: string;
  platformName: string;
  username?: string;
}) {
  const base = `/admin/connected-apps/${encodeURIComponent(result.client.id)}/people`;
  return (
    <Layout title={`${result.client.name} people`} platformName={platformName} username={username}>
      <h1>{result.client.name}: people</h1>
      <PageStack maxWidth={960}>
        <form method="get" action={base}>
          <FormTextInput label="Search by person id" name="search" initialValue={search} />
          <Button type="submit" label="Search" />
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Person</TableHeaderCell>
              <TableHeaderCell>Plan</TableHeaderCell>
              <TableHeaderCell>Subscription</TableHeaderCell>
              <TableHeaderCell>Balance</TableHeaderCell>
              <TableHeaderCell>Used this month</TableHeaderCell>
              <TableHeaderCell>Blocked</TableHeaderCell>
              <TableHeaderCell>Apps paused</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.people.map((person) => (
              <TableRow key={person.person}>
                <TableCell>
                  <a href={personPath(result.client.id, person.person)}>{person.person}</a>
                </TableCell>
                <TableCell>{person.plan}</TableCell>
                <TableCell>{person.subscriptionStatus ?? '-'}</TableCell>
                <TableCell>{dollars(person.balanceMicros)}</TableCell>
                <TableCell>{dollars(person.usedMicros)}</TableCell>
                <TableCell>{person.blocked ? (person.blocked.reason ?? 'yes') : '-'}</TableCell>
                <TableCell>{person.creditsPause?.reason ?? '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p>
          Page {result.page} of {result.totalPages}, {result.total} people.{' '}
          {result.page > 1 && (
            <a href={`${base}?search=${encodeURIComponent(search)}&page=${result.page - 1}`}>
              Previous
            </a>
          )}{' '}
          {result.page < result.totalPages && (
            <a href={`${base}?search=${encodeURIComponent(search)}&page=${result.page + 1}`}>
              Next
            </a>
          )}
        </p>
      </PageStack>
    </Layout>
  );
}

export type PersonPreview = {
  kind: 'grants' | 'invoices' | 'refunds' | 'unblock';
  fields: Record<string, string>;
  lines: Array<[string, string]>;
};

export function AppPersonPage({
  result,
  previewed,
  notice,
  error,
  platformName,
  username,
}: {
  result: Person;
  previewed?: PersonPreview;
  notice?: string;
  error?: string;
  platformName: string;
  username?: string;
}) {
  const base = personPath(result.client.id, result.person);
  const used = result.daily.filter((day) => day.costMicros > 0);
  return (
    <Layout title={result.person} platformName={platformName} username={username}>
      <h1>
        {result.client.name}: <code>{result.person}</code>
      </h1>
      <PageStack maxWidth={960}>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {previewed && (
          <AdminCard title="Check and confirm" description="Nothing has changed yet.">
            <dl>
              {previewed.lines.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <form method="post" action={`${base}/${previewed.kind}`}>
              {Object.entries(previewed.fields).map(([name, value]) => (
                <input key={name} type="hidden" name={name} defaultValue={value} />
              ))}
              <Button type="submit" label="Confirm" />
            </form>
          </AdminCard>
        )}
        <AdminCard title="Plan and balance">
          <dl>
            <dt>Plan</dt>
            <dd>{result.plan}</dd>
            <dt>Subscription</dt>
            <dd>{result.subscriptionStatus ?? 'none'}</dd>
            <dt>Balance</dt>
            <dd>{dollars(result.balanceMicros)}</dd>
            <dt>Owed</dt>
            <dd>{dollars(result.owedMicros)}</dd>
            <dt>Used this month</dt>
            <dd>{dollars(result.usedMicros)}</dd>
            <dt>Auto top-up</dt>
            <dd>
              {result.autoTopUp
                ? result.autoTopUp.enabled
                  ? 'on'
                  : `off${result.autoTopUp.offReason ? ` (${result.autoTopUp.offReason})` : ''}`
                : 'never set up'}
            </dd>
            <dt>Hosted apps paused for credits</dt>
            <dd>
              {result.creditsPause
                ? `${result.creditsPause.projects} of ${result.creditsPause.of} (${result.creditsPause.reason})`
                : 'none'}
            </dd>
            <dt>Blocked</dt>
            <dd>
              {result.blocked
                ? `${result.blocked.reason ?? 'yes'} since ${result.blocked.at}`
                : 'no'}
            </dd>
          </dl>
          {result.blocked && (
            <form method="post" action={`${base}/unblock/preview`}>
              <Button type="submit" label="Clear the block" />
            </form>
          )}
        </AdminCard>
        <AdminCard
          title="Give credits"
          description="Stored as a 'given' grant with you as the giver."
        >
          <SectionStack as="form" method="post" action={`${base}/grants/preview`}>
            <FormTextInput label="Dollars" name="dollars" required placeholder="5" />
            <FormTextInput label="Ends on (optional)" name="expires" placeholder="2027-01-31" />
            <FormTextInput label="Note" name="note" placeholder="Why" />
            <Button type="submit" label="Preview" />
          </SectionStack>
        </AdminCard>
        <AdminCard
          title="Invoice a block of credits"
          description="Sends a Stripe invoice payable by bank transfer or card. The credits come when it's paid, or now if you grant early, and a voided invoice takes early credits back."
        >
          <SectionStack as="form" method="post" action={`${base}/invoices/preview`}>
            <FormTextInput label="Dollars" name="dollars" required placeholder="10000" />
            <FormTextInput
              label="Ends on (the contract's end)"
              name="expires"
              required
              placeholder="2027-11-30"
            />
            <FormTextInput
              label="Billing email"
              name="email"
              required
              placeholder="ap@example.com"
            />
            <FormTextInput label="Days to pay" name="days" placeholder="30" />
            <FormTextInput label="Grant before payment (yes or no)" name="early" placeholder="no" />
            <FormTextInput label="Note" name="note" placeholder="Order form reference" />
            <Button type="submit" label="Preview" />
          </SectionStack>
        </AdminCard>
        <AdminCard title="Grants">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Source</TableHeaderCell>
                <TableHeaderCell>Amount</TableHeaderCell>
                <TableHeaderCell>Left</TableHeaderCell>
                <TableHeaderCell>Refunded</TableHeaderCell>
                <TableHeaderCell>Ends</TableHeaderCell>
                <TableHeaderCell>Note</TableHeaderCell>
                <TableHeaderCell>Refund</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.grants.map((grant) => (
                <TableRow key={grant.id}>
                  <TableCell>
                    {grant.source}
                    {grant.invoice ? ` ${grant.invoice}` : ''}
                    {grant.unpaid ? ' (unpaid)' : ''}
                    {grant.voidReason ? ` (ended: ${grant.voidReason})` : ''}
                  </TableCell>
                  <TableCell>{dollars(grant.amountMicros)}</TableCell>
                  <TableCell>{dollars(grant.remainingMicros)}</TableCell>
                  <TableCell>{dollars(grant.refundedMicros)}</TableCell>
                  <TableCell>{grant.expiresAt ?? 'never'}</TableCell>
                  <TableCell>
                    {[grant.giver, grant.note].filter(Boolean).join(': ') || '-'}
                  </TableCell>
                  <TableCell>
                    {grant.paymentIntent && !grant.voidedAt ? (
                      <form method="post" action={`${base}/refunds/preview`}>
                        <input type="hidden" name="grant" defaultValue={grant.id} />
                        <FormTextInput
                          label="Dollars (empty: the unspent share)"
                          name="dollars"
                          placeholder=""
                        />
                        <Button type="submit" label="Preview refund" size="sm" />
                      </form>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AdminCard>
        <AdminCard title="Hosted apps they pay for">
          {result.projects.length === 0 ? (
            <p>None.</p>
          ) : (
            <ul>
              {result.projects.map((project) => (
                <li key={project.id}>
                  <a href={`/admin/projects/${encodeURIComponent(project.id)}`}>{project.slug}</a>{' '}
                  (built for <code>{project.person}</code>)
                </li>
              ))}
            </ul>
          )}
        </AdminCard>
        <AdminCard title="Use this month by day">
          {used.length === 0 ? (
            <p>No use this month.</p>
          ) : (
            <ul>
              {used.map((day) => (
                <li key={day.day}>
                  {day.day}: {dollars(day.costMicros)}
                </li>
              ))}
            </ul>
          )}
        </AdminCard>
      </PageStack>
    </Layout>
  );
}
