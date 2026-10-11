import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { config } from '@/lib/config';
import { getDb } from '@/lib/db';
import { sendStatusRequest } from '@/lib/firebase';
import { parseBody } from '@/lib/http';
import { presenceSchema } from '@/lib/schemas';

/**
 * Foreground heartbeat. While any member keeps sending `active: true`, the
 * rest of the group is pushed a status request at most once per interval, so
 * everyone's details stay fresh until the viewer closes the app.
 */
export const POST = authed(async (request, { user }) => {
  const { active } = await parseBody(request, presenceSchema);
  const { users, groups } = await getDb();
  const now = new Date();

  await users.updateOne(
    { _id: user._id },
    { $set: { lastActiveAt: active ? now : null } },
  );
  if (!active || !user.groupId) {
    return NextResponse.json({ ok: true, pushed: 0 });
  }

  // Claiming the interval in the filter keeps several open apps in one group
  // from multiplying the pushes.
  const cutoff = new Date(now.getTime() - config.livePushIntervalMs);
  const claim = await groups.findOneAndUpdate(
    {
      _id: user.groupId,
      $or: [{ lastLivePushAt: null }, { lastLivePushAt: { $lte: cutoff } }],
    },
    { $set: { lastLivePushAt: now } },
  );
  if (!claim) {
    return NextResponse.json({ ok: true, pushed: 0 });
  }

  const others = await users
    .find(
      {
        _id: { $in: claim.memberIds, $ne: user._id },
        fcmToken: { $ne: null },
      },
      { projection: { fcmToken: 1 } },
    )
    .toArray();
  const tokens = others.map(member => member.fcmToken as string);
  const result =
    tokens.length > 0
      ? await sendStatusRequest(tokens, 'live')
      : { sent: 0, failed: 0, skipped: false };
  return NextResponse.json({ ok: true, pushed: result.sent });
});
