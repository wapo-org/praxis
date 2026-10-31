import { GlassDropdown } from '@praxis/glass';
import { CapabilitiesSchema, type Provider } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../../lib/api';
import { Plus, Trash2 } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { ProviderCapabilities } from './ProviderCapabilities';
import {
  Card,
  Field,
  requireHttpUrl,
  ScreenBody,
  ScreenButton,
  Section,
  ScreenMenu,
  TaskError,
  useScreenTask,
} from './ScreenUI';
const PRESETS: Array<{
  name: string;
  flavor: Provider['flavor'];
  baseUrl: string;
  defaultModel: string;
}> = [
  {
    name: 'Anthropic',
    flavor: 'anthropicMessages',
    baseUrl: 'https://api.anthropic.com/v1',
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
  const provider = store.providers.find((item) => item.id === store.editingProviderId);
  const [savedId, setSavedId] = React.useState<string | undefined>(provider?.id);
  const [preset, setPreset] = React.useState(provider ? '' : 'Anthropic');
  const [name, setName] = React.useState(provider?.name ?? 'Anthropic');
  const [flavor, setFlavor] = React.useState<Provider['flavor']>(
    provider?.flavor ?? 'anthropicMessages',
  );
  const [baseUrl, setBaseUrl] = React.useState(provider?.baseUrl ?? PRESETS[0]!.baseUrl);
  const [apiKey, setApiKey] = React.useState('');
  const [defaultModel, setDefaultModel] = React.useState(provider?.defaultModel ?? '');
  const [capabilities, setCapabilities] = React.useState(
    () => provider?.capabilities ?? CapabilitiesSchema.parse({}),
  );
  const [headers, setHeaders] = React.useState<Array<{ key: string; value: string }>>([]);
  const [headersEdited, setHeadersEdited] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const task = useScreenTask();
  const models = store.models.filter((model) => model.providerId === savedId);
  const persist = async () => {
    const extraHeaders: Record<string, string> = {};
    for (const header of headers) {
      if (!header.key.trim() && !header.value) continue;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.key.trim()) || /[\r\n]/.test(header.value))
        throw new Error('Enter a valid HTTP header name and a single-line value.');
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
      capabilities,
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
        id="provider-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            await persist();
            store.setActiveSheet('settings');
          });
        }}
      >
        <TaskError error={task.error} />
        <Section title="Connection">
          <Card>
            <div className="screen-row">
              <span style={{ flex: 1 }}>Preset</span>
              <ScreenMenu label="Provider preset" icon={preset || 'Saved provider'}>
                {PRESETS.map((item) => (
                  <GlassDropdown.Item
                    key={item.name}
                    selected={preset === item.name}
                    onSelect={() => {
                      setPreset(item.name);
                      setName(item.name);
                      setFlavor(item.flavor);
                      setBaseUrl(item.baseUrl);
                      setDefaultModel(item.defaultModel);
                    }}
                  >
                    {item.name}
                  </GlassDropdown.Item>
                ))}
              </ScreenMenu>
            </div>
          </Card>
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
            onChange={(event) => setFlavor(event.target.value as Provider['flavor'])}
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
        <Section
          title="Model"
          hint="Enter the model ID used by this provider. Test connection to refresh the available models."
        >
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
        </Section>
        <ProviderCapabilities value={capabilities} onChange={setCapabilities} />
        <Section
          title="Custom HTTP Headers"
          hint="Header values are write-only. Adding headers replaces the saved custom headers."
        >
          {provider?.headerNames?.length ? (
            <p className="screen-footnote">Saved header names: {provider.headerNames.join(', ')}</p>
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
                        i === index ? { ...row, value: event.target.value } : row,
                      ),
                    )
                  }
                />
              </Field>
              <ScreenButton
                aria-label={`Remove header ${index + 1}`}
                onClick={() => {
                  setHeadersEdited(true);
                  setHeaders((previous) => previous.filter((_, i) => i !== index));
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
              if (!result.ok) throw new Error(result.message || 'Could not verify this provider.');
              const refreshed = await store.refreshModelsForProvider(saved.id);
              setMessage(`Connection verified · ${refreshed.length} models refreshed.`);
            });
          }}
        >
          {task.busy ? 'Working…' : 'Test connection'}
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
