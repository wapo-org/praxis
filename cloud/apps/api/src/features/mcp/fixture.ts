import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export async function fixtureServer() {
  const modern = new Map<string, StreamableHTTPServerTransport>();
  const legacy = new Map<string, SSEServerTransport>();
  const servers: Server[] = [];
  const calls: {
    path: string;
    method?: string;
    authorization?: string;
    header?: string;
    body?: Record<string, unknown>;
  }[] = [];
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  let base = '';
  let cimd = false;
  let protectedMode = false;

  const makeServer = () => {
    const server = new Server(
      { name: 'Fixture', version: '1' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    servers.push(server);

    server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
      tools: request.params?.cursor
        ? [
            {
              name: 'write',
              description: 'Modify fixture',
              inputSchema: { type: 'object' },
              annotations: { destructiveHint: true },
            },
          ]
        : [
            {
              name: 'echo',
              description: 'Echo input',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
              annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false,
              },
            },
            { name: 'ask', description: 'Ask user', inputSchema: { type: 'object' } },
            { name: 'ask_url', description: 'Ask through URL', inputSchema: { type: 'object' } },
          ],
      ...(request.params?.cursor ? {} : { nextCursor: 'tools-2' }),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name === 'ask' || request.params.name === 'ask_url') {
        const result = await server.elicitInput(
          request.params.name === 'ask'
            ? {
                mode: 'form',
                message: 'Choose a color',
                requestedSchema: {
                  type: 'object',
                  properties: { color: { type: 'string' } },
                  required: ['color'],
                },
              }
            : {
                mode: 'url',
                message: 'Sign in',
                elicitationId: 'e-url',
                url: `${base}/confirm`,
              },
          { relatedRequestId: extra.requestId },
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: String(request.params.arguments?.text ?? request.params.name),
          },
        ],
      };
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: 'file:///notes.md', name: 'Notes', mimeType: 'text/markdown' }],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: [{ uri: request.params.uri, text: '# Fixture' }],
    }));

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: 'review',
          description: 'Review code',
          arguments: [{ name: 'code', required: true }],
        },
      ],
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
      description: 'Review',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review ${request.params.arguments?.code ?? ''}`,
          },
        },
      ],
    }));

    return server;
  };

  const read = async (req: IncomingMessage) => {
    let text = '';
    for await (const chunk of req) {
      text += String(chunk);
    }
    return text;
  };

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, base);
      const path = url.pathname;
      const text = req.method === 'POST' ? await read(req) : '';
      const json = text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : undefined;

      calls.push({
        path,
        method: req.method,
        authorization: req.headers.authorization,
        header: String(req.headers['x-fixture'] ?? ''),
        body: json,
      });

      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        return respond(200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ['read'],
        });
      }

      if (path === '/.well-known/oauth-authorization-server') {
        return respond(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: cimd,
        });
      }

      if (path === '/register') {
        return respond(201, { ...json, client_id: 'fixture-client' });
      }

      if (path === '/authorize') {
        const code = randomUUID();
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge')!,
          redirect: url.searchParams.get('redirect_uri')!,
          client: url.searchParams.get('client_id')!,
        });
        const target = new URL(url.searchParams.get('redirect_uri')!);
        target.searchParams.set('state', url.searchParams.get('state')!);
        target.searchParams.set('code', code);
        target.searchParams.set('iss', base);
        res.writeHead(302, { Location: target.href });
        return res.end();
      }

      if (path === '/token') {
        const form = new URLSearchParams(text);
        const code = form.get('code')!;
        const record = codes.get(code);
        codes.delete(code);
        if (
          !record ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== record.challenge ||
          form.get('redirect_uri') !== record.redirect ||
          form.get('client_id') !== record.client ||
          form.get('resource') !== `${base}/mcp`
        ) {
          return respond(400, { error: 'invalid_grant' });
        }
        return respond(200, {
          access_token: 'fixture-access-token',
          token_type: 'Bearer',
          refresh_token: 'fixture-refresh',
          expires_in: 3600,
        });
      }

      if (path === '/redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
        return res.end();
      }

      if (
        protectedMode &&
        path === '/mcp' &&
        req.headers.authorization !== 'Bearer fixture-access-token'
      ) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }

      if (path === '/mcp') {
        if (req.method === 'GET' && !req.headers['mcp-session-id']) {
          return respond(405, {});
        }
        const id = req.headers['mcp-session-id'] as string | undefined;
        let transport = id ? modern.get(id) : undefined;
        if (!transport && json?.method === 'initialize') {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (session) => {
              modern.set(session, transport!);
            },
          });
          await makeServer().connect(transport);
        }
        if (!transport) {
          return respond(404, {});
        }
        return await transport.handleRequest(req, res, json);
      }

      if (path === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        legacy.set(transport.sessionId, transport);
        await makeServer().connect(transport);
        return;
      }

      if (path === '/messages' && req.method === 'POST') {
        const transport = legacy.get(url.searchParams.get('sessionId')!);
        if (!transport) {
          return respond(404, {});
        }
        return await transport.handlePostMessage(req, res, json);
      }

      return respond(404, {});
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') {
    throw new Error('No fixture address');
  }
  base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    calls,
    setCimd: (value: boolean) => {
      cimd = value;
    },
    protect: () => {
      protectedMode = true;
    },
    close: async () => {
      for (const server of servers) {
        await server.close();
      }
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
