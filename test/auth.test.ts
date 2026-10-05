import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongo: MongoMemoryServer;
let app: Express;
let disconnect: () => Promise<void>;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongo.getUri('bookly-test');
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  const db = await import('../src/db.js');
  const { createApp } = await import('../src/app.js');
  await db.connectDb(process.env.MONGODB_URI);
  disconnect = db.disconnectDb;
  app = createApp();
});

after(async () => {
  await disconnect?.();
  await mongo?.stop();
});

const signup = (body: object) => request(app).post('/v1/auth/signup').send(body);

describe('account creation & auth', () => {
  let access = '';
  let refresh = '';

  test('sign up creates an account without a username', async () => {
    const res = await signup({ name: 'Aarav Mehta', email: 'Aarav@Example.com', password: 'bookly123' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'aarav@example.com');
    assert.equal(res.body.user.profileComplete, false);
    assert.equal(res.body.user.provider, 'password');
    assert.ok(!('passwordHash' in res.body.user));
    access = res.body.tokens.accessToken;
    refresh = res.body.tokens.refreshToken;
  });

  test('duplicate email is rejected on the email field', async () => {
    const res = await signup({ name: 'X', email: 'aarav@example.com', password: 'bookly123' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.field, 'email');
  });

  test('validation errors point at the field', async () => {
    const res = await signup({ name: 'Y', email: 'y@example.com', password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.field, 'password');
    assert.equal(res.body.error.message, 'Use at least 8 characters.');
  });

  test('GET /me needs a token and returns the account', async () => {
    assert.equal((await request(app).get('/v1/me')).status, 401);
    const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${access}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.displayName, 'Aarav Mehta');
  });

  test('username check + profile setup completes the profile', async () => {
    const free = await request(app).get('/v1/users/username-available').query({ username: 'aarav.reads' });
    assert.equal(free.body.available, true);
    const res = await request(app)
      .patch('/v1/me')
      .set('Authorization', `Bearer ${access}`)
      .send({ username: 'Aarav.Reads', bio: 'Classics, slowly.' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'aarav.reads');
    assert.equal(res.body.user.profileComplete, true);
    const taken = await request(app).get('/v1/users/username-available').query({ username: 'aarav.reads' });
    assert.equal(taken.body.available, false);
  });

  test('a second account cannot take the same username', async () => {
    const other = await signup({ name: 'Mira', email: 'mira@example.com', password: 'bookly123' });
    const res = await request(app)
      .patch('/v1/me')
      .set('Authorization', `Bearer ${other.body.tokens.accessToken}`)
      .send({ username: 'aarav.reads' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.field, 'username');
  });

  test('sign in: wrong password and unknown email look the same', async () => {
    const wrong = await request(app).post('/v1/auth/signin').send({ email: 'aarav@example.com', password: 'nope-nope' });
    const unknown = await request(app).post('/v1/auth/signin').send({ email: 'ghost@example.com', password: 'nope-nope' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error.message, unknown.body.error.message);
    const ok = await request(app).post('/v1/auth/signin').send({ email: 'AARAV@example.com', password: 'bookly123' });
    assert.equal(ok.status, 200);
  });

  test('refresh rotates the token and detects reuse', async () => {
    const first = await request(app).post('/v1/auth/refresh').send({ refreshToken: refresh });
    assert.equal(first.status, 200);
    const next = first.body.tokens.refreshToken;
    assert.notEqual(next, refresh);
    // Reusing the old token revokes everything, including the new one.
    const reuse = await request(app).post('/v1/auth/refresh').send({ refreshToken: refresh });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.error.code, 'refresh_token_reused');
    const afterReuse = await request(app).post('/v1/auth/refresh').send({ refreshToken: next });
    assert.equal(afterReuse.status, 401);
  });

  test('changing password kills old access tokens', async () => {
    const signin = await request(app).post('/v1/auth/signin').send({ email: 'aarav@example.com', password: 'bookly123' });
    const oldAccess = signin.body.tokens.accessToken;
    const res = await request(app)
      .post('/v1/me/password')
      .set('Authorization', `Bearer ${oldAccess}`)
      .send({ currentPassword: 'bookly123', newPassword: 'longreads2026' });
    assert.equal(res.status, 200);
    assert.equal((await request(app).get('/v1/me').set('Authorization', `Bearer ${oldAccess}`)).status, 401);
    access = res.body.tokens.accessToken;
  });

  test('sign out revokes the refresh token', async () => {
    const s = await request(app).post('/v1/auth/signin').send({ email: 'aarav@example.com', password: 'longreads2026' });
    const rt = s.body.tokens.refreshToken;
    assert.equal((await request(app).post('/v1/auth/signout').send({ refreshToken: rt })).status, 204);
    assert.equal((await request(app).post('/v1/auth/refresh').send({ refreshToken: rt })).status, 401);
  });

  test('delete account requires the password, then removes everything', async () => {
    const bad = await request(app).delete('/v1/me').set('Authorization', `Bearer ${access}`).send({ password: 'wrong' });
    assert.equal(bad.status, 400);
    const ok = await request(app).delete('/v1/me').set('Authorization', `Bearer ${access}`).send({ password: 'longreads2026' });
    assert.equal(ok.status, 204);
    assert.equal((await request(app).get('/v1/me').set('Authorization', `Bearer ${access}`)).status, 401);
    const again = await request(app).post('/v1/auth/signin').send({ email: 'aarav@example.com', password: 'longreads2026' });
    assert.equal(again.status, 401);
    // The username is free again.
    const free = await request(app).get('/v1/users/username-available').query({ username: 'aarav.reads' });
    assert.equal(free.body.available, true);
  });

  test('google route is not enabled yet', async () => {
    const res = await request(app).post('/v1/auth/google').send({ idToken: 'x' });
    assert.equal(res.status, 404);
  });
});
