# GeoTracker API

Backend for the GeoTracker mobile app: Next.js route handlers on MongoDB Atlas.
It has no UI. It verifies logins, keeps one JWT session per user, manages
groups and invite codes, stores each device's status, and triggers devices to
upload fresh status by push.

## Run it

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev                  # http://localhost:3000
```

Without Atlas or Firebase set up yet:

```bash
npm run dev:memory   # in-memory MongoDB; data is not kept
npm run test:smoke   # end-to-end test of every rule below, on a throwaway DB
```

## Configuration

Set these in `.env.local` locally and as environment variables on Vercel.

| Variable                     | Required      | Default      | Purpose                                                                                           |
| ---------------------------- | ------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                | yes           | –            | Atlas connection string                                                                           |
| `MONGODB_DB`                 | no            | `geotracker` | Database name                                                                                     |
| `JWT_SECRET`                 | yes           | –            | Signs session tokens; 32+ random characters                                                       |
| `JWT_EXPIRES_DAYS`           | no            | `7`          | Token lifetime                                                                                    |
| `JWT_RENEW_GRACE_DAYS`       | no            | `30`         | How long after expiry a token can still be renewed                                                |
| `FIREBASE_SERVICE_ACCOUNT`   | for live push | –            | Service account JSON (one line or base64); lets an open app ask the other phones for fresh status |
| `STATIC_OTP`                 | no            | `1101`       | The login code every phone number accepts until an SMS provider is added                          |
| `INVITE_CODE_TTL_SECONDS`    | no            | `120`        | Invite code lifetime                                                                              |
| `GROUP_MAX_MEMBERS`          | no            | `6`          | Members per group, creator included                                                               |
| `LIVE_PUSH_INTERVAL_SECONDS` | no            | `30`         | Minimum gap between live status requests to one group                                             |

Atlas: allow connections from `0.0.0.0/0` under Network Access, because
Vercel functions have no fixed IP.

## Sessions

1. The app posts the phone number to `POST /api/auth/request-otp`, then the
   number and the code to `POST /api/auth/login`. The server checks the code,
   creates the user on first login, and returns its own JWT, valid 7 days.

   There is no SMS provider yet: nothing is sent and the code is the same
   fixed value (`STATIC_OTP`, default `1101`) for every number. Anyone who
   knows it can log in as any phone number, so this is for development and
   trusted testers only. Real codes go into `src/lib/otp.ts`; nothing else
   changes.

2. The token's ID is stored on the user. Every request is checked against the
   signature and that stored ID, so a login on another phone or a logout
   invalidates the old token at once.
3. A request with an expired token that is still the stored one succeeds and
   the response carries a replacement in the `x-auth-token` header. The app
   must store it and use it from then on.
4. A `401` means the token is missing, forged, replaced, signed out, or expired
   for longer than the grace period. The app must send the user to log in.

Send the token as `Authorization: Bearer <token>` on everything except the two
login calls.

## Endpoints

| Method and path                 | Body                         | Does                                              |
| ------------------------------- | ---------------------------- | ------------------------------------------------- |
| `POST /api/auth/request-otp`    | `{ phone }`                  | Ask for a login code; returns `codeLength`        |
| `POST /api/auth/login`          | `{ phone, otp }`             | Log in; returns `token`, `user`, group view       |
| `POST /api/auth/logout`         | –                            | End the session, stop pushes to this device       |
| `GET /api/me`                   | –                            | Called on app open; returns `user` and group view |
| `PATCH /api/me`                 | `{ name }`                   | Set display name                                  |
| `PUT /api/me/avatar`            | `{ contentType, base64 }`    | Set profile photo (about 150 KB max)              |
| `DELETE /api/me/avatar`         | –                            | Remove profile photo                              |
| `PUT /api/me/preferences`       | any of the preference fields | Update sharing preferences                        |
| `PUT /api/me/fcm-token`         | `{ token }`                  | Register the device for push                      |
| `POST /api/me/status`           | status fields                | Upload device status                              |
| `GET /api/group`                | –                            | Group and members' latest status                  |
| `POST /api/group/invite`        | –                            | Generate a 2-minute invite code                   |
| `POST /api/group/join`          | `{ code }`                   | Join a group by code                              |
| `DELETE /api/group/members/:id` | –                            | Remove a member; creator only                     |
| `POST /api/group/leave`         | –                            | Leave the group                                   |
| `POST /api/group/presence`      | `{ active }`                 | Foreground heartbeat; triggers live updates       |
| `GET /api/users/:id/avatar`     | –                            | A member's photo, for the same group only         |

Errors are `{ "error": { "code", "message" } }` with a matching HTTP status.

The group view returned by login, `GET /api/me`, `GET /api/group` and join is:

```jsonc
{
  "group": {
    // null when the user is in no group
    "id": "kq3ZtY0b1x_A", // random slug; groups have no name
    "memberCount": 3,
    "maxMembers": 6,
    "isCreator": true,
    "invite": { "code": "K7WQ2M", "expiresAt": "..." }, // creator only, while live
  },
  "canInvite": true, // show the "Generate invite code" button
  "members": [/* the caller first, then the rest by name */],
}
```

## Group rules

- Groups have no name. Each gets a random slug.
- Anyone who is not in someone else's group can generate a code. The first
  code creates a group with that user as creator.
- Only the creator can generate further codes. Other members get
  `403 NOT_GROUP_CREATOR`.
- A code lasts 2 minutes and can be used by several people in that time.
  Generating a new code replaces the old one.
- A group holds 6 members including the creator. The 7th gets `409 GROUP_FULL`.
- A user is in one group at a time (`409 ALREADY_IN_GROUP`). The exception is a
  creator who is still alone in their group: they may join another group, and
  the empty one is deleted.
- Only the creator can remove a member (`403 NOT_GROUP_CREATOR` otherwise).
  A removed member is in no group and can join or start another.
- Any member can leave. When the creator leaves, the group is deleted and
  every member is left in no group, because nobody else could invite or
  remove.

## Field mapping

### Device status: `POST /api/me/status`

Phones send only the fields that changed since their last upload; a field
left out keeps its stored value. When nothing changed they send
`{ "alive": true }`, which only records that the phone reported in
(`lastHeardAt`). What counts as a change is decided on the phone: any battery,
charging, ringer or screen change, or moving about 7 m (≈ 23 ft) or more.

| Collected on the phone                     | Request field        | Stored in `users`           | In each `members[]` row |
| ------------------------------------------ | -------------------- | --------------------------- | ----------------------- |
| Battery percent, 0–100                     | `battery`            | `status.battery`            | `battery`               |
| Plugged in and charging                    | `charging`           | `status.charging`           | `charging`              |
| Ringer mode: `silent`, `vibrate`, `normal` | `soundMode`          | `status.soundMode`          | `soundMode`             |
| Screen on                                  | `screenOn`           | `status.screenOn`           | `screenOn`              |
| GPS latitude                               | `location.latitude`  | `status.location.latitude`  | `location.latitude`     |
| GPS longitude                              | `location.longitude` | `status.location.longitude` | `location.longitude`    |
| GPS accuracy, metres                       | `location.accuracy`  | `status.location.accuracy`  | `location.accuracy`     |
| – (server clock)                           | –                    | `status.updatedAt`          | `statusUpdatedAt`       |
| – (server clock)                           | –                    | `status.location.updatedAt` | `location.updatedAt`    |

Each member row also has `id`, `name`, `avatarUrl`, `isSelf`, `isCreator`,
`active` and `lastSeenAt`. `active` (the green dot) means the phone's screen
was on at its last report and that report is under 5 minutes old.
`lastSeenAt` is when the phone last reported, changed or not. Phone numbers are
never sent to other members.

### Sharing preferences: `PUT /api/me/preferences`

| App control                  | Field                                                                                                          | Effect on what others see                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Share real time location     | `shareLocation`                                                                                                | `false` hides `location`                                                    |
| Real-Time Location Mode      | `locationMode` (`share`, `pause_30m`, `pause_1h`, `pause_2h`, `pause_5h`, `pause_12h`, `pause_1d`, `pause_7d`) | A pause hides `location` until `pauseUntil`, then sharing resumes by itself |
| Share Battery & Charge Stats | `shareBattery`                                                                                                 | `false` hides `battery` and `charging`                                      |
| Share Screen Active Status   | `shareScreen`                                                                                                  | `false` hides `screenOn`                                                    |
| Share Sound Profile          | `shareSound`                                                                                                   | `false` hides `soundMode`                                                   |

Hidden fields arrive as `null`. A member always sees their own row in full.

### Collections

`users`: `phone` (unique), `name`, `avatar`, `groupId`,
`session { jti, expiresAt, previousJti, previousValidUntil }`, `fcmToken`,
`preferences`, `status`, `lastActiveAt`, `createdAt`, `updatedAt`.

`groups`: `slug` (unique), `creatorId`, `memberIds[]`,
`invite { code, expiresAt }`, `lastLivePushAt`, `createdAt`.

Indexes are created automatically on first connection.

## How status stays fresh

The API never runs on its own: there is no cron job or background process.
Every change starts with a request from a phone, and the API only checks it,
stores it in MongoDB and answers. Phones keep the data fresh in three ways:

- **About once an hour, on each phone's own clock.** The app schedules a
  background job with Android's WorkManager when the user logs in. It wakes
  roughly every 60 minutes, counted from when it was first scheduled, reads
  the device status and calls `POST /api/me/status`. Times differ from phone
  to phone, and Android may shift a run by some minutes to save battery.
- **Every minute while the app is open**, the phone uploads its own status.
- **While someone is watching.** The open app calls
  `POST /api/group/presence` with `active: true` every 30 seconds. Inside
  that request the API sends a silent Firebase push,
  `{ type: "STATUS_REQUEST", reason: "live" }`, to the other members, at most
  once per `LIVE_PUSH_INTERVAL_SECONDS` per group. Their apps wake, upload
  their status, and the viewer's list refreshes. This needs
  `FIREBASE_SERVICE_ACCOUNT`; without it, the other phones are only as fresh
  as their last hourly upload.

## Deploy to Vercel

1. Import the folder as a Vercel project (Root Directory `geotracker-api`).
   The free Hobby plan is enough: nothing is scheduled.
2. Add the environment variables from the table above.
3. Deploy, then set the app's production API URL to the deployment URL.
