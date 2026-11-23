import { defineHandler } from '@builtbyfriends/bwf';
import { sendEmail } from '@builtbyfriends/bwf/email';
import type { SendEmailOptions } from '@builtbyfriends/bwf/email';
import { env } from '@builtbyfriends/bwf/env';
import { kv } from '@builtbyfriends/bwf/kv';

export const POST = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-platform-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<SendEmailOptions>();
  return c.json(await sendEmail(body));
});

export const GET = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-platform-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const subject = c.req.query('subject');
  if (!subject || subject.length > 180) {
    return c.json({ error: 'subject must contain 1–180 characters' }, 400);
  }
  return c.json(await kv.get(`email-e2e:${subject}`));
});
