# File transfer redirect correction — 2026-11-25

Native acceptance found that the initial file-transfer API rejected both transfers before reaching storage. Its service-binding fetch used `redirect: 'error'`, which Node accepts but the Workers runtime rejects. The initial health and access checks did not exercise an authenticated transfer.

Both transfer requests now use `redirect: 'manual'`. Existing non-success response handling rejects a redirect without following it. A redirected upload remains an unknown outcome, with no automatic retry; a redirected download returns unavailable.

The 43 transfer and 52 existing runtime integration tests pass, including both methods' redirect mode and redirected-response handling. API typecheck, scoped lint and diff checks pass. A local workerd service-binding probe reproduced the exact rejection for `error` and returned the original bytes with `manual`.

This correction changes API code only. Its deployment must preserve the current 63 bindings and settings and match the verified baseline version `7165bed6-9282-4e15-8a8b-243bf30056fc`, deployment `36985f43-909c-4de8-87ee-934747b3acd8`. Prepared local scripts and evidence use `.local/file-transfers-redirect/`, leaving the initial deployment receipt intact. This document records checks, not deployment or customer acceptance.
