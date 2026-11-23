import { type } from 'arktype';
import { billedAccountPlanLimits } from '../../app-payer.ts';
import { member, procedure } from '../procedure.ts';

export const get = procedure('me.get')
  .use(member)
  .noAuthz({ reason: 'Every signed in user may read their own account' })
  .noInput()
  .output(
    type({
      id: 'string',
      login: 'string',
      email: 'string | null',
      provider: 'string',
      plan: 'string',
      role: 'string',
      billing_cycle_start: 'string',
      // Decision: The plan catalog is operator-defined, so its shape isn't fixed here.
      limits: 'object',
    }),
  )
  .noErrors({ reason: 'Reading your own account has no expected failure' })
  .noMcp({ reason: 'No agent needs account details yet' })
  .cli({ command: 'whoami', description: 'Show the signed in account' })
  .handler(async ({ ctx: { user, db } }) => ({
    id: user.id,
    login: user.login,
    email: user.email,
    provider: user.provider,
    plan: user.plan,
    role: user.role,
    billing_cycle_start: user.billing_cycle_start,
    limits: await billedAccountPlanLimits(db, user),
  }));
