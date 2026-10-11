import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { joinGroup, loadGroupView } from '@/lib/groups';
import { parseBody } from '@/lib/http';
import { joinSchema } from '@/lib/schemas';

/** Joins the group that issued the given invite code. */
export const POST = authed(async (request, { user }) => {
  const { code } = await parseBody(request, joinSchema);
  const group = await joinGroup(user, code);
  return NextResponse.json(
    await loadGroupView({ ...user, groupId: group._id }),
  );
});
