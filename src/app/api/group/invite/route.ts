import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { config } from '@/lib/config';
import { createInvite } from '@/lib/groups';

/** Generates a short-lived invite code, creating the group on first use. */
export const POST = authed(async (_request, { user }) => {
  const invite = await createInvite(user);
  return NextResponse.json({
    code: invite.code,
    expiresAt: invite.expiresAt,
    ttlSeconds: config.inviteTtlMs / 1000,
  });
});
