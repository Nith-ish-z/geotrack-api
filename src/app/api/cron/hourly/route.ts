import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { getDb } from '@/lib/db';
import { sendStatusRequest } from '@/lib/firebase';
import { ApiError, route } from '@/lib/http';

function isAuthorized(header: string | null): boolean {
  const expected = Buffer.from(`Bearer ${config.cronSecret}`);
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Hourly trigger, scheduled in vercel.json for minute 0 of every hour. Asks
 * every grouped member's device to upload its current status. Vercel Cron
 * sends CRON_SECRET as a bearer token.
 */
export const GET = route(async request => {
  if (!isAuthorized(request.headers.get('authorization'))) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid cron secret');
  }

  const { users } = await getDb();
  const devices = await users
    .find(
      { groupId: { $ne: null }, fcmToken: { $ne: null } },
      { projection: { fcmToken: 1 } },
    )
    .toArray();
  const tokens = devices.map(device => device.fcmToken as string);
  const result =
    tokens.length > 0
      ? await sendStatusRequest(tokens, 'hourly')
      : { sent: 0, failed: 0, skipped: false };

  return NextResponse.json({ devices: tokens.length, ...result });
});
