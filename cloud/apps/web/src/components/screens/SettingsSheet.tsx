import React from 'react';
import {
  Eye,
  FlaskConical,
  Link,
  Mic,
  Plus,
  Shield,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { GlassChip } from '@praxis/glass';
import type { Provider } from '@praxis/protocol';
import { usePraxisStore } from '../../state/store.js';
import { apiClient } from '../../lib/api.js';
import {
  Card,
  Field,
  hostLabel,
  NavRow,
  requireHttpUrl,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  useScreenTask,
} from './ScreenUI.js';

export function SettingsSheet({
  onOpenGlassLab,
}: {
  onOpenGlassLab?: () => void;
}) {
  const store = usePraxisStore();
  return (
    <ScreenBody>
      <Section title="Providers">
        {store.providers.length ? (
          <Card>
            {store.providers.map((provider) => (
              <NavRow
                key={provider.id}
                title={provider.name}
                detail={`${hostLabel(provider.baseUrl)} · ${provider.maskedKey || 'No API key'}`}
                value={
                  <span
                    className={`screen-badge${provider.maskedKey ? ' screen-badge--success' : ''}`}
                  >
                    {provider.id === 'scripted'
                      ? 'Demo'
                      : provider.maskedKey
                        ? 'Configured'
                        : 'Missing key'}
                  </span>
                }
                onClick={() => {
                  store.setEditingProviderId(provider.id);
                  store.setActiveSheet('provider-editor');
                }}
              />
            ))}
          </Card>
        ) : (
          <p className="screen-intro">
            You’re chatting with the built-in demo. Add a provider with your own
            API key, or a server on your network, to chat with a real model.
          </p>
        )}
        <ScreenButton
          tone="primary"
          onClick={() => {
            store.setEditingProviderId(null);
            store.setActiveSheet('provider-editor');
          }}
        >
          <Plus size={17} />
          Add provider
        </ScreenButton>
        <p className="screen-footnote">
          API keys are write-only. A saved key is never shown here.
        </p>
      </Section>
      <Section title="Tools">
        <Card>
          <NavRow
            icon={<Link size={18} />}
            title="Connectors"
            value={store.connectors.length || 'None'}
            onClick={() => store.setActiveSheet('connectors')}
          />
          <NavRow
            icon={<Sparkles size={18} />}
            title="Skills"
            value={store.skills.length || 'None'}
            onClick={() => store.setActiveSheet('skills')}
          />
        </Card>
      </Section>
      <Section title="Capabilities & Privacy">
        <Card>
          <NavRow
            icon={<Eye size={18} />}
            title="Image reading model"
            value={
              store.preferences?.vision.enabled &&
              store.preferences.vision.modelId
                ? store.preferences.vision.modelId
                : 'Off'
            }
            onClick={() => store.setActiveSheet('image-reader')}
          />
          <NavRow
            icon={<Mic size={18} />}
            title="Voice input"
            value={
              store.preferences?.voice.configured ? 'Configured' : 'Set up'
            }
            onClick={() => store.setActiveSheet('voice-settings')}
          />
          <NavRow
            icon={<Shield size={18} />}
            title="Data consents"
            value={store.consents.filter((consent) => consent.allowed).length}
            onClick={() => store.setActiveSheet('consents')}
          />
        </Card>
      </Section>
      <Section title="Appearance">
        <div className="screen-pill-row" role="group" aria-label="Appearance">
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <GlassChip
              key={mode}
              active={store.themeMode === mode}
              aria-pressed={store.themeMode === mode}
              onClick={() => store.setThemeMode(mode)}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </GlassChip>
          ))}
        </div>
      </Section>
      {onOpenGlassLab ? (
        <ScreenButton
          onClick={() => {
            store.setActiveSheet(null);
            onOpenGlassLab();
          }}
        >
          <FlaskConical size={17} />
          Open Liquid Glass Lab
        </ScreenButton>
      ) : null}
    </ScreenBody>
  );
}

const PRESETS: Array<{
  name: string;
  flavor: Provider['flavor'];
  baseUrl: string;
  defaultModel: string;
}> = [
  {
    name: 'Anthropic',
    flavor: 'anthropicMessages',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: '',
  },
  {
    name: 'OpenAI',
    flavor: 'openAIResponses',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
  },
  {
    name: 'Groq',
    flavor: 'openAIChat',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: '',
  },
  {
    name: 'OpenRouter',
    flavor: 'openAIChat',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
  },
  { name: 'Custom', flavor: 'openAIChat', baseUrl: '', defaultModel: '' },
];

export function ProviderEditor() {
  const store = usePraxisStore();
  const provider = store.providers.find(
    (item) => item.id === store.editingProviderId,
  );
  const [savedId, setSavedId] = React.useState<string | undefined>(
    provider?.id,
  );
  const [preset, setPreset] = React.useState(provider ? '' : 'Anthropic');
  const [name, setName] = React.useState(provider?.name ?? 'Anthropic');
  const [flavor, setFlavor] = React.useState<Provider['flavor']>(
    provider?.flavor ?? 'anthropicMessages',
  );
  const [baseUrl, setBaseUrl] = React.useState(
    provider?.baseUrl ?? PRESETS[0]!.baseUrl,
  );
  const [apiKey, setApiKey] = React.useState('');
  const [defaultModel, setDefaultModel] = React.useState(
    provider?.defaultModel ?? '',
  );
  const [headers, setHeaders] = React.useState<
    Array<{ key: string; value: string }>
  >([]);
  const [headersEdited, setHeadersEdited] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const task = useScreenTask();
  const models = store.models.filter((model) => model.providerId === savedId);
  const persist = async () => {
    const extraHeaders: Record<string, string> = {};
    for (const header of headers) {
      if (!header.key.trim() && !header.value) continue;
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.key.trim()) ||
        /[\r\n]/.test(header.value)
      )
        throw new Error(
          'Enter a valid HTTP header name and a single-line value.',
        );
      if (
        Object.keys(extraHeaders).some(
          (key) => key.toLowerCase() === header.key.trim().toLowerCase(),
        )
      )
        throw new Error('Each HTTP header name must be unique.');
      extraHeaders[header.key.trim()] = header.value;
    }
    const saved = await store.saveProvider({
      id: savedId,
      name: name.trim(),
      flavor,
      baseUrl: requireHttpUrl(baseUrl),
      defaultModel: defaultModel.trim(),
      ...(apiKey ? { apiKey } : {}),
      ...(headersEdited ? { extraHeaders } : {}),
    });
    setSavedId(saved.id);
    setApiKey('');
    return saved;
  };
  return (
    <ScreenBody>
      <form
        className="screen-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            await persist();
            store.setActiveSheet('settings');
          });
        }}
      >
        <TaskError error={task.error} />
        <Section title="Provider preset">
          <div className="screen-pill-row">
            {PRESETS.map((item) => (
              <GlassChip
                key={item.name}
                active={preset === item.name}
                aria-pressed={preset === item.name}
                onClick={() => {
                  setPreset(item.name);
                  setName(item.name);
                  setFlavor(item.flavor);
                  setBaseUrl(item.baseUrl);
                  setDefaultModel(item.defaultModel);
                }}
              >
                {item.name}
              </GlassChip>
            ))}
          </div>
        </Section>
        <Field label="Name">
          <input
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Flavor">
          <select
            value={flavor}
            onChange={(event) =>
              setFlavor(event.target.value as Provider['flavor'])
            }
          >
            <option value="anthropicMessages">Anthropic Messages</option>
            <option value="openAIChat">OpenAI Chat Completions</option>
            <option value="openAIResponses">OpenAI Responses</option>
          </select>
        </Field>
        <Field label="Base URL">
          <input
            type="url"
            required
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field
          label="API Key"
          hint={
            savedId
              ? 'Leave blank to keep the saved key.'
              : 'Optional for local servers that do not require a key.'
          }
        >
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={provider?.maskedKey || 'API key'}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Default Model">
          <input
            value={defaultModel}
            onChange={(event) => setDefaultModel(event.target.value)}
            placeholder="Model ID"
            list="provider-model-options"
          />
          <datalist id="provider-model-options">
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </datalist>
        </Field>
        <Section
          title="Custom HTTP Headers"
          hint="Header values are write-only. Adding headers replaces the saved custom headers."
        >
          {provider?.headerNames?.length ? (
            <p className="screen-footnote">
              Saved header names: {provider.headerNames.join(', ')}
            </p>
          ) : null}
          {headers.map((header, index) => (
            <div className="screen-header-fields" key={index}>
              <Field label={`Header ${index + 1} name`}>
                <input
                  value={header.key}
                  placeholder="X-Custom-Header"
                  onChange={(event) =>
                    setHeaders((previous) =>
                      previous.map((row, i) =>
                        i === index ? { ...row, key: event.target.value } : row,
                      ),
                    )
                  }
                />
              </Field>
              <Field label={`Header ${index + 1} value`}>
                <input
                  type="password"
                  value={header.value}
                  placeholder="Value"
                  autoComplete="new-password"
                  onChange={(event) =>
                    setHeaders((previous) =>
                      previous.map((row, i) =>
                        i === index
                          ? { ...row, value: event.target.value }
                          : row,
                      ),
                    )
                  }
                />
              </Field>
              <ScreenButton
                aria-label={`Remove header ${index + 1}`}
                onClick={() => {
                  setHeadersEdited(true);
                  setHeaders((previous) =>
                    previous.filter((_, i) => i !== index),
                  );
                }}
              >
                <Trash2 size={15} />
              </ScreenButton>
            </div>
          ))}
          <ScreenButton
            onClick={() => {
              setHeadersEdited(true);
              setHeaders((previous) => [...previous, { key: '', value: '' }]);
            }}
          >
            <Plus size={15} />
            Add header
          </ScreenButton>
          {provider?.headerNames?.length && !headersEdited ? (
            <ScreenButton
              tone="destructive"
              onClick={() => {
                setHeaders([]);
                setHeadersEdited(true);
              }}
            >
              Clear saved headers
            </ScreenButton>
          ) : null}
        </Section>
        <ScreenButton
          disabled={task.busy || !name.trim() || !baseUrl.trim()}
          onClick={() => {
            void task.run(async () => {
              setMessage('');
              const saved = await persist();
              const result = await apiClient.testProvider(saved.id);
              if (!result.ok)
                throw new Error(
                  result.message || 'Could not verify this provider.',
                );
              const refreshed = await store.refreshModelsForProvider(saved.id);
              setMessage(
                `Connection verified · ${refreshed.length} models refreshed.`,
              );
            });
          }}
        >
          {task.busy ? 'Working…' : 'Verify & Refresh Models'}
        </ScreenButton>
        {message ? (
          <p className="screen-success" role="status">
            {message}
          </p>
        ) : null}
        <ScreenButton
          type="submit"
          tone="primary"
          disabled={task.busy || !name.trim() || !baseUrl.trim()}
        >
          Save provider
        </ScreenButton>
        {savedId ? (
          <ScreenButton
            tone="destructive"
            disabled={task.busy}
            onClick={() => {
              void task.run(async () => {
                await store.removeProvider(savedId);
                store.setActiveSheet('settings');
              });
            }}
          >
            <Trash2 size={16} />
            Delete provider
          </ScreenButton>
        ) : null}
      </form>
    </ScreenBody>
  );
}
