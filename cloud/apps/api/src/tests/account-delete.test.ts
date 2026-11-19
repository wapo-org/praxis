import {expect, it} from 'vitest';
import {createApp} from '../app.js';
import {createLocalAdapters} from '../local-memory.js';
import {ApiService} from '../service.js';

it('limits local account deletion attempts when the eraser is unavailable', async () => {
  const {app} = createApp({service: new ApiService(createLocalAdapters(), true)});
  const dev = await app.request('/v1/auth/dev', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({type: 'auth.dev', userId: 'limited'}),
  });
  expect(dev.status).toBe(200);
  const {bearerToken} = await dev.json();
  const erase = () => app.request('/v1/account', {
    method: 'DELETE',
    headers: {authorization: `Bearer ${bearerToken}`},
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await erase()).status).toBe(503);
  }
  expect((await erase()).status).toBe(429);
});
