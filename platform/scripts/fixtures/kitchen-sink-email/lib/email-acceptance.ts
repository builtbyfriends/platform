import { defineEmail, parseEmail, replyEmail } from '@builtbyfriends/bwf/email';
import { kv } from '@builtbyfriends/bwf/kv';

export function acceptEmail(route: string) {
  return defineEmail(async (message, _env, _ctx, info) => {
    const parsed = await parseEmail(message);
    const subject = parsed.subject ?? '(no subject)';
    await kv.put(
      `email-e2e:${subject}`,
      JSON.stringify({
        route,
        params: info?.params ?? {},
        from: message.from,
        to: message.to,
        subject,
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments.map(({ filename, mimeType }) => ({ filename, mimeType })),
      }),
      { ttl: 3600 },
    );
    if (subject.startsWith('REJECT ')) {
      message.setReject('Platform email acceptance reject');
      return;
    }
    if (subject.startsWith('REPLY ')) {
      await replyEmail(message, { text: `Platform email acceptance reply: ${subject}` });
    }
    if (subject.startsWith('FORWARD ')) {
      const destination = parsed.headers.find(({ key }) => key === 'x-platform-e2e-forward')?.value;
      if (!destination) {
        message.setReject('x-platform-e2e-forward is required for this test');
        return;
      }
      await message.forward(destination);
    }
  });
}
