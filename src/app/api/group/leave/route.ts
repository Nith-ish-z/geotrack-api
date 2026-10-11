import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { leaveGroup, loadGroupView } from '@/lib/groups';

/** Leaves the group. If the creator leaves, the group ends for everyone. */
export const POST = authed(async (_request, { user }) => {
  await leaveGroup(user);
  return NextResponse.json(await loadGroupView({ ...user, groupId: null }));
});
