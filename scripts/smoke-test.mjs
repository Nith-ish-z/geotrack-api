// `npm run test:smoke` — end-to-end check of the API against an in-memory
// MongoDB: login, token rules, invites, the 6-member cap, status sharing.
//
// By default it boots its own server. To test one that is already running
// (Next allows only one dev server per folder), point it there instead:
//   SMOKE_BASE_URL=http://localhost:3000 SMOKE_MONGODB_URI=mongodb://... npm run test:smoke
// (plus SMOKE_MONGODB_DB if that server is not using the default database name)
// The target must use the dev settings from local-server.mjs.
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { MongoClient, ObjectId } from 'mongodb';
import { DEV_ENV, startLocalServer, waitUntilReady } from './local-server.mjs';

const server = process.env.SMOKE_BASE_URL
  ? {
      baseUrl: process.env.SMOKE_BASE_URL,
      mongoUri: process.env.SMOKE_MONGODB_URI,
      stop: async () => {},
    }
  : await startLocalServer({ port: 3199, stdio: 'ignore' });
// Fresh phone numbers every run, so a reused database can't collide.
const run = String(Date.now()).slice(-6);
const mongo = await new MongoClient(server.mongoUri).connect();
const db = mongo.db(process.env.SMOKE_MONGODB_DB || DEV_ENV.MONGODB_DB);
const users = db.collection('users');
const groups = db.collection('groups');

/** A logged-in test user that tracks token renewals like the app does. */
function client(phone) {
  const self = {
    phone,
    token: null,
    id: null,
    async call(method, path, body, token = self.token) {
      const response = await fetch(server.baseUrl + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const renewed = response.headers.get('x-auth-token');
      if (renewed && token === self.token) {
        self.token = renewed;
      }
      const isJson = response.headers
        .get('content-type')
        ?.includes('application/json');
      return {
        status: response.status,
        renewed,
        body: isJson ? await response.json() : await response.arrayBuffer(),
      };
    },
    async login(name) {
      const result = await self.call(
        'POST',
        '/api/auth/login',
        { phone, otp: OTP },
        null,
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
      self.token = result.body.token;
      self.id = result.body.user.id;
      if (name) {
        await self.call('PATCH', '/api/me', { name });
      }
      return result.body;
    },
  };
  return self;
}

const signToken = (sub, jti, expiresAt) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(DEV_ENV.JWT_SECRET));

/** The fixed login code; see src/lib/otp.ts. */
const OTP = '1101';

const tests = [];
const test = (name, run) => tests.push({ name, run });

const people = Array.from({ length: 8 }, (_, i) => client(`+1555${run}0${i}`));
const [admin, bob, cara, dan, eve, fay, gus, hal] = people;

test('login creates a user with an empty name and no group', async () => {
  const body = await admin.login();
  assert.equal(body.user.name, '');
  assert.equal(body.group, null);
  assert.equal(body.canInvite, true);
  assert.equal(body.members.length, 1);
  await admin.call('PATCH', '/api/me', { name: 'Admin' });
});

test('login needs the right code for the number', async () => {
  const asked = await bob.call(
    'POST',
    '/api/auth/request-otp',
    { phone: bob.phone },
    null,
  );
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.codeLength, 4);

  const login = otp =>
    bob.call('POST', '/api/auth/login', { phone: bob.phone, otp }, null);
  const wrong = await login('0000');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'INVALID_OTP');
  assert.equal((await login('11011')).status, 401);
  assert.equal((await login(undefined)).status, 400);
  assert.equal(
    await users.countDocuments({ phone: bob.phone }),
    0,
    'a failed login creates no user',
  );

  const badPhone = await bob.call(
    'POST',
    '/api/auth/request-otp',
    { phone: '12345' },
    null,
  );
  assert.equal(badPhone.status, 400);
});

test('requests without a valid token are rejected', async () => {
  assert.equal(
    (await admin.call('GET', '/api/me', undefined, null)).status,
    401,
  );
  const garbage = await admin.call('GET', '/api/me', undefined, 'not-a-jwt');
  assert.equal(garbage.body.error.code, 'INVALID_TOKEN');
  const forged = await signToken(
    admin.id,
    'made-up',
    new Date(Date.now() + 60_000),
  );
  assert.equal(
    (await admin.call('GET', '/api/me', undefined, forged)).status,
    401,
  );
});

test('logging in again invalidates the earlier token', async () => {
  const oldToken = admin.token;
  await admin.login();
  assert.equal(
    (await admin.call('GET', '/api/me', undefined, oldToken)).status,
    401,
  );
  assert.equal((await admin.call('GET', '/api/me')).status, 200);
});

test('an expired current token is replaced on the next request', async () => {
  const jti = 'expired-current';
  await users.updateOne(
    { _id: new ObjectId(admin.id) },
    { $set: { 'session.jti': jti } },
  );
  const expired = await signToken(admin.id, jti, new Date(Date.now() - 60_000));
  admin.token = expired;
  const result = await admin.call('GET', '/api/me');
  assert.equal(result.status, 200);
  assert.ok(result.renewed, 'response carries a replacement token');
  assert.notEqual(admin.token, expired);
  // The new token works, and the old one still does briefly for requests
  // that were already in flight.
  assert.equal((await admin.call('GET', '/api/me')).status, 200);
  const late = await admin.call('GET', '/api/me', undefined, expired);
  assert.equal(late.status, 200);
  assert.equal(late.renewed, null);
});

test('a token expired past the grace period forces a new login', async () => {
  const jti = 'expired-long-ago';
  await users.updateOne(
    { _id: new ObjectId(admin.id) },
    { $set: { 'session.jti': jti } },
  );
  const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const stale = await signToken(admin.id, jti, longAgo);
  const result = await admin.call('GET', '/api/me', undefined, stale);
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'TOKEN_EXPIRED');
  await admin.login();
});

let code;
test('generating a code creates a group with the user as creator', async () => {
  const result = await admin.call('POST', '/api/group/invite');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  code = result.body.code;
  assert.match(code, /^[A-Z2-9]{6}$/);
  const ttl = new Date(result.body.expiresAt) - Date.now();
  assert.ok(ttl > 110_000 && ttl <= 120_000, `expires in 2 minutes (${ttl}ms)`);

  const view = (await admin.call('GET', '/api/group')).body;
  assert.equal(view.group.isCreator, true);
  assert.equal(view.group.invite.code, code);
  assert.match(view.group.id, /^[A-Za-z0-9_-]{12}$/);
});

test('a wrong code is rejected', async () => {
  await bob.login('Bob');
  const result = await bob.call('POST', '/api/group/join', { code: 'ZZZZZZ' });
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'INVALID_CODE');
});

test('several people can join on one code, typed in any case', async () => {
  const first = await bob.call('POST', '/api/group/join', {
    code: code.toLowerCase(),
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await cara.login('Cara');
  const second = await cara.call('POST', '/api/group/join', { code });
  assert.equal(second.status, 200);
  assert.equal(second.body.group.memberCount, 3);
  assert.equal(second.body.canInvite, false);
  assert.equal(second.body.group.invite, null, 'members never see the code');
});

test("a member of someone else's group cannot generate a code", async () => {
  const result = await bob.call('POST', '/api/group/invite');
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'NOT_GROUP_CREATOR');
});

test('a member cannot join a second group', async () => {
  await hal.login('Hal');
  const other = (await hal.call('POST', '/api/group/invite')).body.code;
  const result = await bob.call('POST', '/api/group/join', { code: other });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'ALREADY_IN_GROUP');
});

test('an expired code stops working and the creator can make another', async () => {
  await groups.updateOne(
    { 'invite.code': code },
    { $set: { 'invite.expiresAt': new Date(Date.now() - 1000) } },
  );
  await dan.login('Dan');
  const expired = await dan.call('POST', '/api/group/join', { code });
  assert.equal(expired.body.error.code, 'INVALID_CODE');

  const fresh = await admin.call('POST', '/api/group/invite');
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.code, code);
  code = fresh.body.code;
  assert.equal(
    (await dan.call('POST', '/api/group/join', { code })).status,
    200,
  );
});

test('someone alone in their own group can still join another', async () => {
  // Hal created a group above and nobody joined it.
  const result = await hal.call('POST', '/api/group/join', { code });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.group.isCreator, false);
  assert.equal(
    await groups.countDocuments({ creatorId: new ObjectId(hal.id) }),
    0,
    'the empty group is removed',
  );
});

test('a group holds at most 6 members including the creator', async () => {
  await eve.login('Eve');
  assert.equal(
    (await eve.call('POST', '/api/group/join', { code })).status,
    200,
  );
  await fay.login('Fay');
  const seventh = await fay.call('POST', '/api/group/join', { code });
  assert.equal(seventh.status, 409);
  assert.equal(seventh.body.error.code, 'GROUP_FULL');
  const more = await admin.call('POST', '/api/group/invite');
  assert.equal(more.body.error.code, 'GROUP_FULL');
});

test('racing joins cannot overfill a group', async () => {
  await gus.login('Gus');
  const gusCode = (await gus.call('POST', '/api/group/invite')).body.code;
  const crowd = Array.from({ length: 9 }, (_, i) => client(`+1555${run}1${i}`));
  await Promise.all(crowd.map((person, i) => person.login(`Racer ${i}`)));
  const results = await Promise.all(
    crowd.map(person =>
      person.call('POST', '/api/group/join', { code: gusCode }),
    ),
  );
  assert.equal(results.filter(r => r.status === 200).length, 5);
  assert.equal(results.filter(r => r.status === 409).length, 4);
  const group = await groups.findOne({ creatorId: new ObjectId(gus.id) });
  assert.equal(group.memberIds.length, 6);
});

test('status uploads are shared with the group, own row first', async () => {
  const upload = await bob.call('POST', '/api/me/status', {
    battery: 84,
    charging: true,
    soundMode: 'silent',
    screenOn: false,
    location: { latitude: 37.7815, longitude: -122.4232, accuracy: 12 },
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));

  const view = (await admin.call('GET', '/api/group')).body;
  assert.equal(view.members.length, 6);
  assert.equal(view.members[0].isSelf, true);
  assert.equal(view.members[0].isCreator, true);
  assert.equal(view.members.filter(m => m.isCreator).length, 1);
  const row = view.members.find(m => m.id === bob.id);
  assert.equal(row.battery, 84);
  assert.equal(row.charging, true);
  assert.equal(row.soundMode, 'silent');
  assert.equal(row.screenOn, false);
  assert.equal(row.location.latitude, 37.7815);
  assert.equal(
    JSON.stringify(view).includes(bob.phone),
    false,
    'phones stay private',
  );
});

test('a partial upload keeps the fields it did not send', async () => {
  await bob.call('POST', '/api/me/status', { battery: 80 });
  const row = (await admin.call('GET', '/api/group')).body.members.find(
    m => m.id === bob.id,
  );
  assert.equal(row.battery, 80);
  assert.equal(row.soundMode, 'silent');
  assert.equal(row.location.longitude, -122.4232);
});

test('invalid status values are rejected', async () => {
  const result = await bob.call('POST', '/api/me/status', { battery: 140 });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_REQUEST');
});

test('sharing preferences hide fields from others but not from yourself', async () => {
  const saved = await bob.call('PUT', '/api/me/preferences', {
    shareBattery: false,
    shareSound: false,
    locationMode: 'pause_1h',
  });
  assert.equal(saved.body.user.preferences.locationMode, 'pause_1h');
  assert.ok(saved.body.user.preferences.pauseUntil);

  const seenByAdmin = (await admin.call('GET', '/api/group')).body.members.find(
    m => m.id === bob.id,
  );
  assert.equal(seenByAdmin.battery, null);
  assert.equal(seenByAdmin.charging, null);
  assert.equal(seenByAdmin.soundMode, null);
  assert.equal(seenByAdmin.location, null);
  assert.equal(seenByAdmin.screenOn, false, 'screen state is still shared');

  const own = (await bob.call('GET', '/api/group')).body.members[0];
  assert.equal(own.battery, 80);
  assert.ok(own.location);
});

test('a pause that has run out goes back to sharing', async () => {
  await users.updateOne(
    { _id: new ObjectId(bob.id) },
    { $set: { 'preferences.pauseUntil': new Date(Date.now() - 1000) } },
  );
  const me = (await bob.call('GET', '/api/me')).body;
  assert.equal(me.user.preferences.locationMode, 'share');
  const row = (await admin.call('GET', '/api/group')).body.members.find(
    m => m.id === bob.id,
  );
  assert.ok(row.location);
});

test('presence marks a member active and inactive', async () => {
  const on = await cara.call('POST', '/api/group/presence', { active: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const find = async () =>
    (await admin.call('GET', '/api/group')).body.members.find(
      m => m.id === cara.id,
    );
  assert.equal((await find()).active, true);
  await cara.call('POST', '/api/group/presence', { active: false });
  assert.equal((await find()).active, false);
});

test('avatars are served to the group only', async () => {
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const saved = await bob.call('PUT', '/api/me/avatar', {
    contentType: 'image/png',
    base64: pixel,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const url = saved.body.user.avatarUrl;
  assert.equal((await admin.call('GET', url)).status, 200);
  assert.equal((await gus.call('GET', url)).status, 404);
  await bob.call('DELETE', '/api/me/avatar');
  assert.equal((await admin.call('GET', url)).status, 404);
});

test('the hourly trigger requires the cron secret', async () => {
  const path = '/api/cron/hourly';
  assert.equal((await admin.call('GET', path, undefined, null)).status, 401);
  assert.equal((await admin.call('GET', path, undefined, 'wrong')).status, 401);

  await bob.call('PUT', '/api/me/fcm-token', { token: 'fake-device-token' });
  const ok = await admin.call('GET', path, undefined, DEV_ENV.CRON_SECRET);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.devices >= 1);
  // Firebase isn't configured in this test run, so nothing is actually sent.
  assert.equal(ok.body.skipped, true);
});

test('only the creator can remove a member', async () => {
  const byMember = await bob.call('DELETE', `/api/group/members/${cara.id}`);
  assert.equal(byMember.status, 403);
  assert.equal(byMember.body.error.code, 'NOT_GROUP_CREATOR');

  const byCreator = await admin.call('DELETE', `/api/group/members/${dan.id}`);
  assert.equal(byCreator.status, 200, JSON.stringify(byCreator.body));
  assert.equal(byCreator.body.group.memberCount, 5);
  assert.equal(
    byCreator.body.members.some(m => m.id === dan.id),
    false,
  );

  const removed = (await dan.call('GET', '/api/group')).body;
  assert.equal(removed.group, null);
  assert.equal(removed.canInvite, true, 'a removed member is free again');
});

test('the creator cannot remove themselves or a non-member', async () => {
  const self = await admin.call('DELETE', `/api/group/members/${admin.id}`);
  assert.equal(self.status, 400);
  const gone = await admin.call('DELETE', `/api/group/members/${dan.id}`);
  assert.equal(gone.status, 404);
  const outsider = await admin.call('DELETE', `/api/group/members/${gus.id}`);
  assert.equal(outsider.status, 404);
});

test('a member can leave and then join again', async () => {
  const left = await eve.call('POST', '/api/group/leave');
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.group, null);
  assert.equal(
    (await admin.call('GET', '/api/group')).body.group.memberCount,
    4,
  );

  const again = await eve.call('POST', '/api/group/leave');
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'NOT_IN_GROUP');

  const fresh = (await admin.call('POST', '/api/group/invite')).body.code;
  const back = await eve.call('POST', '/api/group/join', { code: fresh });
  assert.equal(back.status, 200);
  assert.equal(back.body.group.memberCount, 5);
});

test('the group ends for everyone when its creator leaves', async () => {
  const group = await groups.findOne({ creatorId: new ObjectId(gus.id) });
  assert.equal(group.memberIds.length, 6);
  const left = await gus.call('POST', '/api/group/leave');
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(await groups.countDocuments({ _id: group._id }), 0);
  assert.equal(await users.countDocuments({ groupId: group._id }), 0);
});

test('logout ends the session', async () => {
  const token = cara.token;
  assert.equal((await cara.call('POST', '/api/auth/logout')).status, 200);
  assert.equal(
    (await cara.call('GET', '/api/me', undefined, token)).status,
    401,
  );
});

let failed = 0;
try {
  await waitUntilReady(server.baseUrl);
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`  ok    ${name}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${error.message}`);
    }
  }
} finally {
  await mongo.close();
  await server.stop();
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
