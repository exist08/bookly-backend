import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongo: MongoMemoryServer;
let app: Express;
let disconnect: () => Promise<void>;
const mails: string[] = [];

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongo.getUri('bookly-posts-test');
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  process.env.CLOUDINARY_API_KEY = '123';
  process.env.CLOUDINARY_API_SECRET = 'secret';
  const log = console.log;
  console.log = (...a: unknown[]) => (String(a[0]).startsWith('[mail]') ? mails.push(String(a[0])) : log(...a));
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

async function reader(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  const res = await request(app).post('/v1/auth/signup').send({ name, email, password: 'bookly123' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const token = res.body.tokens.accessToken as string;
  await request(app).patch('/v1/me').set('authorization', `Bearer ${token}`).send({ username: name.toLowerCase() }).expect(200);
  return { id: res.body.user.id as string, email, token, auth: { authorization: `Bearer ${token}` } };
}

const COVER = 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/v1/bookly/covers/x/y';

describe('posts, feed, votes, shelves', () => {
  let a: Awaited<ReturnType<typeof reader>>;
  let b: Awaited<ReturnType<typeof reader>>;
  let postId = '';

  test('needs a token', async () => {
    await request(app).get('/v1/feed').expect(401);
  });

  test('create a post', async () => {
    a = await reader('Aarav');
    b = await reader('Mira');
    const res = await request(app).post('/v1/posts').set(a.auth).send({ bookTitle: ' Middlemarch ', bookAuthor: 'George Eliot', review: 'Slow, then devastating.', coverUri: null });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.bookTitle, 'Middlemarch');
    assert.equal(res.body.author.id, a.id);
    assert.equal(res.body.author.email, 'aarav@example.com', 'own email visible to self');
    assert.equal(res.body.myVote, 0);
    assert.ok(res.body.coverPalette.bg.startsWith('#'));
    postId = res.body.id;
  });

  test('validation messages match the app copy', async () => {
    const res = await request(app).post('/v1/posts').set(a.auth).send({ bookTitle: '', review: 'x', coverUri: null });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.field, 'bookTitle');
    assert.equal(res.body.error.message, 'Add the book’s title.');
    const foreign = await request(app).post('/v1/posts').set(a.auth).send({ bookTitle: 'X', review: 'y', coverUri: 'https://evil.example/x.jpg' });
    assert.equal(foreign.status, 400);
    const own = await request(app).post('/v1/posts').set(a.auth).send({ bookTitle: 'Walden', review: 'Quiet.', coverUri: COVER });
    assert.equal(own.status, 201);
    assert.equal(own.body.coverUri, COVER);
  });

  test('feed is newest first, hides other readers’ emails, and pages', async () => {
    for (let i = 0; i < 11; i++) {
      await request(app).post('/v1/posts').set(b.auth).send({ bookTitle: `Book ${i}`, review: 'ok', coverUri: null }).expect(201);
    }
    const p1 = await request(app).get('/v1/feed').set(a.auth).expect(200);
    assert.equal(p1.body.items.length, 10);
    assert.equal(p1.body.items[0].bookTitle, 'Book 10');
    assert.equal(p1.body.items[0].author.email, '');
    assert.ok(p1.body.nextCursor);
    const p2 = await request(app).get('/v1/feed').query({ cursor: p1.body.nextCursor }).set(a.auth).expect(200);
    assert.equal(p2.body.items.length, 3);
    assert.equal(p2.body.nextCursor, null);
    const ids = new Set([...p1.body.items, ...p2.body.items].map((p: { id: string }) => p.id));
    assert.equal(ids.size, 13, 'no duplicates across pages');
  });

  test('votes are idempotent and switchable', async () => {
    const up = await request(app).put(`/v1/posts/${postId}/vote`).set(b.auth).send({ value: 1 }).expect(200);
    assert.deepEqual([up.body.upvotes, up.body.downvotes, up.body.myVote, up.body.score], [1, 0, 1, 1]);
    await request(app).put(`/v1/posts/${postId}/vote`).set(b.auth).send({ value: 1 }).expect(200);
    const down = await request(app).put(`/v1/posts/${postId}/vote`).set(b.auth).send({ value: -1 }).expect(200);
    assert.deepEqual([down.body.upvotes, down.body.downvotes, down.body.myVote], [0, 1, -1]);
    const clear = await request(app).put(`/v1/posts/${postId}/vote`).set(b.auth).send({ value: 0 }).expect(200);
    assert.deepEqual([clear.body.upvotes, clear.body.downvotes, clear.body.myVote], [0, 0, 0]);
    await request(app).put(`/v1/posts/${postId}/vote`).set(b.auth).send({ value: 1 }).expect(200);
    const seenByA = await request(app).get(`/v1/posts/${postId}`).set(a.auth).expect(200);
    assert.equal(seenByA.body.myVote, 0);
    assert.equal(seenByA.body.upvotes, 1);
    await request(app).put(`/v1/posts/${postId}/vote`).set(b.auth).send({ value: 2 }).expect(400);
  });

  test('only the author can edit or delete', async () => {
    await request(app).patch(`/v1/posts/${postId}`).set(b.auth).send({ bookTitle: 'Hacked', review: 'x', coverUri: null }).expect(403);
    const ok = await request(app).patch(`/v1/posts/${postId}`).set(a.auth).send({ bookTitle: 'Middlemarch', bookAuthor: '', review: 'Edited.', coverUri: null });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.review, 'Edited.');
    assert.equal(ok.body.bookAuthor, null);
    assert.equal(ok.body.upvotes, 1, 'votes survive an edit');
    await request(app).delete(`/v1/posts/${postId}`).set(b.auth).expect(403);
    await request(app).get('/v1/posts/not-an-id').set(a.auth).expect(404);
  });

  test('profile and shelf', async () => {
    const prof = await request(app).get(`/v1/users/${a.id}`).set(b.auth).expect(200);
    assert.equal(prof.body.user.username, 'aarav');
    assert.equal(prof.body.user.email, '');
    assert.deepEqual(prof.body.stats, { books: 2, upvotes: 1 });
    const shelf = await request(app).get(`/v1/users/${a.id}/posts`).set(b.auth).expect(200);
    assert.equal(shelf.body.items.length, 2);
    assert.ok(shelf.body.items.every((p: { authorId: string }) => p.authorId === a.id));
    await request(app).get('/v1/users/000000000000000000000000').set(a.auth).expect(404);
    // username-available still works and isn't shadowed by /:id
    const avail = await request(app).get('/v1/users/username-available').query({ username: 'aarav' }).expect(200);
    assert.equal(avail.body.available, false);
  });

  test('deleting a post removes its votes', async () => {
    await request(app).delete(`/v1/posts/${postId}`).set(a.auth).expect(204);
    await request(app).get(`/v1/posts/${postId}`).set(a.auth).expect(404);
  });

  test('deleting an account takes back its votes and removes its posts', async () => {
    const feed = await request(app).get('/v1/feed').set(a.auth).expect(200);
    const target = feed.body.items.find((p: { authorId: string }) => p.authorId === b.id).id as string;
    await request(app).put(`/v1/posts/${target}/vote`).set(a.auth).send({ value: 1 }).expect(200);
    await request(app).delete('/v1/me').set(a.auth).send({ password: 'bookly123' }).expect(204);
    const after = await request(app).get(`/v1/posts/${target}`).set(b.auth).expect(200);
    assert.equal(after.body.upvotes, 0, 'vote was taken back');
    const all = await request(app).get('/v1/feed').set(b.auth).expect(200);
    assert.ok(all.body.items.every((p: { authorId: string }) => p.authorId !== a.id), 'their posts are gone');
  });
});

describe('password reset', () => {
  test('forgot always answers 202; reset sets the password and signs out', async () => {
    const r = await reader('Ines');
    await request(app).post('/v1/auth/password/forgot').send({ email: 'nobody@example.com' }).expect(202);
    assert.equal(mails.length, 0, 'no email for unknown accounts');
    await request(app).post('/v1/auth/password/forgot').send({ email: 'INES@example.com' }).expect(202);
    const token = mails.at(-1)!.match(/token=([\w-]+)/)?.[1];
    assert.ok(token, 'link was "sent"');
    await request(app).post('/v1/auth/password/reset').send({ token, password: 'short' }).expect(400);
    await request(app).post('/v1/auth/password/reset').send({ token, password: 'newpass123' }).expect(204);
    await request(app).get('/v1/me').set(r.auth).expect(401);
    await request(app).post('/v1/auth/signin').send({ email: r.email, password: 'newpass123' }).expect(200);
    await request(app).post('/v1/auth/password/reset').send({ token, password: 'again12345' }).expect(400);
  });
});
