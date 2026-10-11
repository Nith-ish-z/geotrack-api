import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { loadGroupView } from '@/lib/groups';

/** The group and its members' latest status; polled while the app is open. */
export const GET = authed(async (_request, { user }) => {
  return NextResponse.json(await loadGroupView(user));
});
