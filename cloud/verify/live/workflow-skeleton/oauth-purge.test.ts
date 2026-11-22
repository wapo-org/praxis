import {describe, expect, it} from 'vitest';
import {oauthEmailRow, oauthRowsFor, seedOAuthEmail} from './oauth-purge.js';

describe('oauth-purge helpers', () => {
  it('normalises the seeded email the way createOAuthUser does', () => {
    const email = seedOAuthEmail('20261119t120000-abc123');
    expect(oauthEmailRow('u1', email)).toEqual({userId: 'u1', email: 'live-pra125-20261119t120000-abc123@oauth.invalid'});
  });

  it('rejects run ids that would change the address shape', () => {
    expect(() => seedOAuthEmail('Bad Id')).toThrow();
  });

  it('counts rows by owner or email and treats unparseable rows as leftovers', () => {
    const rows = [
      {userId: 'u1', email: 'a@x'},
      {userId: 'u2', email: 'seed@x'},
      {userId: 'u3', email: 'b@x'},
      {email: 'broken'},
    ];
    expect(oauthRowsFor(rows, 'u1', 'seed@x')).toBe(3);
    expect(oauthRowsFor([{userId: 'u3', email: 'b@x'}], 'u1', 'seed@x')).toBe(0);
  });
});
