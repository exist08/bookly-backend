# Bookly API

Accounts, posts, feed, votes and shelves for the Bookly app and website. Node.js + Express 5, MongoDB (Mongoose), JWT.

## Run it

```sh
cp .env.example .env        # then set MONGODB_URI and JWT_ACCESS_SECRET
npm install
npm run dev                 # http://localhost:4000
```

`npm test` runs the account tests against a throwaway in-memory MongoDB
(`mongodb-memory-server` downloads a `mongod` binary the first time).

## How auth works

- **Access token**: a JWT (HS256, 15 min) sent as `Authorization: Bearer <token>`. It carries the
  user's `tokenVersion`, so changing the password, "sign out everywhere" and deleting the account
  invalidate every outstanding access token at once.
- **Refresh token**: an opaque random string (30 days), one per device. Only its SHA-256 hash is
  stored (`sessions` collection, auto-expired by a TTL index). Each refresh token works once; using
  an already-rotated one is treated as theft and signs the user out everywhere.
- Passwords are hashed with bcrypt (cost 12). Sign-in returns the same error for an unknown email
  and a wrong password, and takes the same time either way.
- Store both tokens in the Keychain / Keystore on the device (e.g. `react-native-keychain`), not MMKV.

## Endpoints

Errors always look like `{ "error": { "code": "email_taken", "message": "…", "field": "email" } }`.
Successful auth calls return `{ user, tokens: { accessToken, refreshToken, expiresIn } }`, where
`user` matches the app's `User` type.

| Method | Path | Auth | Body | Notes |
| --- | --- | --- | --- | --- |
| POST | `/v1/auth/signup` | – | `{ name, email, password }` | 201. New users have `profileComplete: false` |
| POST | `/v1/auth/signin` | – | `{ email, password }` | |
| POST | `/v1/auth/refresh` | – | `{ refreshToken }` | Rotates the refresh token |
| POST | `/v1/auth/signout` | – | `{ refreshToken }` | 204, this device only |
| POST | `/v1/auth/signout-all` | Bearer | – | 204, every device |
| POST | `/v1/auth/google` | – | `{ idToken }` | Verifies Google's ID token; 201 for a new account |
| GET | `/v1/users/username-available?username=` | – | – | `{ available }` |
| GET | `/v1/me` | Bearer | – | `{ user }` |
| PATCH | `/v1/me` | Bearer | `{ displayName?, username?, bio?, avatarUri? }` | Profile setup and Edit profile |
| POST | `/v1/me/password` | Bearer | `{ currentPassword, newPassword }` | Returns fresh tokens, signs out other devices |
| POST | `/v1/me/avatar` | Bearer | multipart, field `avatar` (JPG/PNG/WebP/HEIC ≤ 8 MB) | Uploads to Cloudinary (512 px, face crop) → `{ user }` |
| DELETE | `/v1/me/avatar` | Bearer | – | Removes the photo → `{ user }` |
| POST | `/v1/uploads/signature` | Bearer | `{ kind: "cover" }` | Signed params for direct-to-Cloudinary cover uploads |
| DELETE | `/v1/me` | Bearer | `{ password }` or `{ confirm: "DELETE" }` (Google-only accounts) | 204 |
| POST | `/v1/auth/password/forgot` | – | `{ email }` | 202 always; emails a 1-hour reset link to `APP_URL/reset?token=…` |
| POST | `/v1/auth/password/reset` | – | `{ token, password }` | 204; signs out every device |
| GET | `/v1/feed?cursor=` | Bearer | – | `{ items: PostView[], nextCursor }`, newest first, 10 per page |
| POST | `/v1/posts` | Bearer | `{ bookTitle, bookAuthor?, review, coverUri, coverPalette? }` | 201 `PostView`. `coverUri` must come from `/v1/uploads/cover` (or `null`) |
| GET | `/v1/posts/:id` | Bearer | – | `PostView` |
| PATCH | `/v1/posts/:id` | Bearer | same as create | Author only; a replaced cover is deleted from Cloudinary |
| DELETE | `/v1/posts/:id` | Bearer | – | 204; author only; removes its votes and cover |
| PUT | `/v1/posts/:id/vote` | Bearer | `{ value: 1 \| 0 \| -1 }` | `PostView`; idempotent, 0 clears |
| GET | `/v1/users/:id` | Bearer | – | `{ user, stats: { books, upvotes } }` |
| GET | `/v1/users/:id/posts?cursor=` | Bearer | – | A reader's shelf, 30 per page |
| POST | `/v1/uploads/cover` | Bearer | multipart, field `cover` | 201 `{ url }` (Cloudinary, max 1200 px) |
| GET | `/health` | – | – | |

Sign-up and sign-in are rate-limited to 20 attempts per IP per 15 minutes. Behind a proxy, set
`TRUST_PROXY=1` so the limit sees the real client IP.

## Postman

Import `postman/Bookly.postman_collection.json` (and optionally `postman/Bookly.local.postman_environment.json`).
Run **Auth → Sign up** first, or run the whole collection with the Collection Runner: sign-up uses a fresh
email each run, and the scripts store the access/refresh tokens in collection variables for the other requests.
The last request, **Delete account**, deletes that test account.

## Google sign-in (not enabled yet)

The code is written and commented out so it can be switched on once Google Sign-In is set up in the app:

1. `npm install google-auth-library`
2. Set `GOOGLE_CLIENT_IDS` in `.env` (iOS, Android and web client IDs, comma-separated).
3. Uncomment `src/modules/auth/google.ts` and the import + `/google` route in `src/modules/auth/auth.routes.ts`.

It verifies the ID token against Google, requires a verified email, matches on the Google account id,
links an existing email/password account with the same email, and otherwise creates a new account.

## Not here yet

Password reset by email (needs an email provider), posts, votes and image uploads. `DELETE /v1/me`
has a TODO for cascading posts once they move to this API.

## Cloudinary (photo uploads)

Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` in `.env`
(Cloudinary Console → Settings → API Keys). Without them the server still runs; upload endpoints return 503.

- **Avatars** go through the API (`POST /v1/me/avatar`): one image per user at `bookly/avatars/<userId>`,
  overwritten on each upload, deleted with the account. Served with `f_auto,q_auto`.
- **Book covers** upload straight from the app with a signature from `POST /v1/uploads/signature`
  into `bookly/covers/<userId>/`. The API secret never leaves the server.

## Posts, votes and privacy

- `PostView` matches the app's type: the post, its `author` and the viewer's `myVote` (-1/0/1), plus `score`.
- Vote counts are stored on the post and updated with `$inc` when a vote changes, so feeds stay one query.
- Other readers' `email` is always `""` in responses; you only see your own.
- Deleting an account takes its votes back off other posts, deletes its posts (and the votes on them),
  sessions, avatar and every cover under `bookly/covers/<userId>/`.
- Paging uses a cursor over `(createdAt, _id)`, so new posts never shift or duplicate pages.

## Password reset email

Set `RESEND_API_KEY` (https://resend.com) and `MAIL_FROM` to send real emails. Without a key the reset
link is printed to the server log instead. `APP_URL` is the website the link points to.
