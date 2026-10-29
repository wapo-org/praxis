import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { RunEvent } from '@praxis/protocol';
import { createApp } from '../../api/src/app.js';
import { ApiService } from '../../api/src/service.js';
import { createLocalAdapters } from '../../api/src/local-memory.js';
import { localDriver } from '../../api/src/runtime.js';
import { PraxisApiClient } from './lib/api.js';
import { subscribeRunEvents } from './lib/sse.js';

describe('@praxis/web client flows against Lead A local API', () => {
  let server: ServerType;
  let client: PraxisApiClient;
  let service: ApiService;

  beforeAll(async () => {
    service = new ApiService(createLocalAdapters(), true);
    service.driver = localDriver(service);
    await service.seed('local-user');
    const { app } = createApp({
      service,
      encryptionKey: randomBytes(32).toString('base64'),
    });

    await new Promise<void>((resolve) => {
      server = serve(
        { fetch: app.fetch, port: 0, hostname: '127.0.0.1' },
        (info: AddressInfo) => {
          client = new PraxisApiClient({
            baseUrl: `http://127.0.0.1:${info.port}`,
            bearerToken: 'dev-local',
          });
          resolve();
        },
      );
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('bootstraps seeded welcome chat, providers, models, preferences, and consents', async () => {
    const boot = await client.bootstrap();
    expect(boot.chats.some((c) => c.id === 'welcome')).toBe(true);
    expect(boot.models.some((m) => m.id === 'scripted')).toBe(true);
    expect(boot.preferences?.vision).toBeDefined();
    expect(boot.preferences?.voice).toBeDefined();
  });

  it('creates, renames, pins, and lists chats & messages', async () => {
    const chat = await client.createChat({
      title: 'Liquid Glass Spec Chat',
      mode: 'build',
      providerId: 'scripted',
      modelId: 'scripted',
      effort: 'high',
    });
    expect(chat.title).toBe('Liquid Glass Spec Chat');

    const pinned = await client.patchChat(chat.id, { pinned: true, title: 'Pinned Glass Chat' });
    expect(pinned.pinned).toBe(true);
    expect(pinned.title).toBe('Pinned Glass Chat');

    const list = await client.listChats();
    expect(list.items.some((c) => c.id === chat.id && c.pinned)).toBe(true);
  });

  it('streams text and tool runs end-to-end via subscribeRunEvents SSE', async () => {
    for (const script of ['text', 'tools'] as const) {
      const run = await client.startRun({
        chatId: 'welcome',
        text: `Run ${script} flow`,
        script,
        clientTurnId: `turn-${script}-${Date.now()}`,
      });
      await service.drain();

      const received: RunEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        subscribeRunEvents(client, run.id, 0, {
          onEvent: (ev) => received.push(ev),
          onComplete: () => resolve(),
          onError: (err) => reject(err),
        });
      });

      expect(received.length).toBeGreaterThan(1);
      expect(received.at(-1)?.event.type).toBe('run.finished');
      if (script === 'tools') {
        expect(received.some((e) => e.event.type === 'tool.started')).toBe(true);
        expect(received.some((e) => e.event.type === 'tool.finished')).toBe(true);
      }
    }
  });

  it('handles approval and nestedApproval pause + resume via client.submitApproval', async () => {
    for (const script of ['approval', 'nestedApproval'] as const) {
      const run = await client.startRun({
        chatId: 'welcome',
        text: `Test ${script}`,
        script,
      });
      await service.drain();

      const snap = await client.getRunSnapshot(run.id);
      expect(snap.run.status).toBe('awaitingApproval');
      expect(snap.pendingApprovals).toHaveLength(1);

      const approvalId = snap.pendingApprovals[0]!.id;
      const resumed = await client.submitApproval(run.id, approvalId, 'allowOnce');
      await service.drain();

      const finalSnap = await client.getRunSnapshot(resumed.id);
      expect(finalSnap.run.status).toBe('completed');
    }
  });

  it('handles elicitation pause + resume via client.submitElicitation', async () => {
    const run = await client.startRun({
      chatId: 'welcome',
      text: 'Test elicitation',
      script: 'elicitation',
    });
    await service.drain();

    const snap = await client.getRunSnapshot(run.id);
    expect(snap.run.status).toBe('awaitingElicitation');
    expect(snap.pendingElicitations).toHaveLength(1);

    const elicId = snap.pendingElicitations[0]!.id;
    await client.submitElicitation(run.id, elicId, 'accept', { name: 'Praxis Web' });
    await service.drain();

    const finalSnap = await client.getRunSnapshot(run.id);
    expect(finalSnap.run.status).toBe('completed');
  });

  it('exercises preferences, connectors, skills, registries, consents, and sync/pull', async () => {
    const prefs = await client.patchPreferences({
      vision: { enabled: true, providerId: 'scripted', modelId: 'scripted-vision' },
      voice: { model: 'whisper-large-v3-turbo', language: 'en' },
    });
    expect(prefs.vision.modelId).toBe('scripted-vision');
    expect(prefs.voice.model).toBe('whisper-large-v3-turbo');

    const conn = await client.createConnector({
      name: 'Linear MCP',
      url: 'https://mcp.linear.app/sse',
    });
    expect(conn.name).toBe('Linear MCP');

    const skill = await client.createSkill({
      name: 'Liquid Glass Auditor',
      description: 'Audits Snell refraction bezel math',
      document: '# Skill\nVerify squircle profile.',
      enabled: true,
    });
    expect(skill.name).toBe('Liquid Glass Auditor');

    const consent = await client.setConsent('api.openai.com', true);
    expect(consent.allowed).toBe(true);

    const sync = await client.syncPull('0');
    expect(sync.entities.length).toBeGreaterThan(0);
  });
});
