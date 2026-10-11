import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { loadGroupView, removeMember } from '@/lib/groups';
import { ApiError } from '@/lib/http';

/** Removes a member from the group. Creator only. */
export const DELETE = authed<{ params: Promise<{ id: string }> }>(
  async (_request, { user }, context) => {
    const { id } = await context.params;
    if (!ObjectId.isValid(id)) {
      throw new ApiError(404, 'NOT_FOUND', 'That person is not in your group');
    }
    await removeMember(user, new ObjectId(id));
    return NextResponse.json(await loadGroupView(user));
  },
);
