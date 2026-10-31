import React from 'react';
import { FileText, Globe, Link, Mic, Paperclip, Wrench } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import {
  Card,
  ScreenBody,
  ScreenButton,
  ScreenHeader,
  Section,
  SheetDialog,
  TaskError,
  Toggle,
  useScreenTask,
} from './ScreenUI.js';

export function ConsentSheet() {
  const store = usePraxisStore();
  const prompt = store.pendingConsentPrompt;
  if (!prompt) return null;
  const cancel = () => {
    prompt.onCancel?.();
    store.setPendingConsentPrompt(null);
  };
  const voice = prompt.purpose === 'voice';
  const items = voice
    ? [
        {
          icon: <Mic size={17} />,
          title: 'Voice recordings',
          detail: 'The audio you recorded, to turn into text.',
        },
      ]
    : prompt.purpose === 'vision'
      ? [
          {
            icon: <Paperclip size={17} />,
            title: 'Images',
            detail: 'The images you ask this model to read.',
          },
          {
            icon: <FileText size={17} />,
            title: 'Questions about the image',
            detail: 'The context needed to describe and understand your image.',
          },
        ]
      : prompt.purpose === 'connector'
        ? [
            {
              icon: <Wrench size={17} />,
              title: 'Tool requests',
              detail: 'The tool names and arguments sent to this connector.',
            },
            {
              icon: <Link size={17} />,
              title: 'Connector data',
              detail:
                'Results returned by this connector may be shared with your chat provider.',
            },
          ]
        : [
            {
              icon: <FileText size={17} />,
              title: 'Your messages',
              detail: 'This chat’s messages so far, and each new one.',
            },
            {
              icon: <Paperclip size={17} />,
              title: 'Attachments',
              detail: 'Photos and files you add to the chat.',
            },
            {
              icon: <Wrench size={17} />,
              title: 'Tool results',
              detail:
                'What the agent’s tools return, like web pages or code output.',
            },
            {
              icon: <Link size={17} />,
              title: 'Connector data',
              detail:
                'What the connectors enabled for this chat return to the agent.',
            },
          ];
  return (
    <SheetDialog label="AI data sharing" onDismiss={cancel} consent>
      <ScreenHeader title="AI data sharing" />
      <ScreenBody>
        <h2
          className="screen-consent-heading"
          id="consentTitle"
          data-testid="consentTitle"
        >
          {voice
            ? 'Share this recording for transcription?'
            : prompt.purpose === 'vision'
              ? 'Share images with this model?'
              : prompt.purpose === 'connector'
                ? 'Share data with this connector?'
                : 'Share this chat with this provider?'}
        </h2>
        <div>
          <span className="screen-badge">
            <Globe size={13} aria-hidden="true" />
            {prompt.host}
          </span>
        </div>
        <p className="screen-intro">{prompt.description}</p>
        <Section title="What’s sent">
          <Card>
            {items.map((item) => (
              <div
                className="screen-row"
                key={item.title}
                style={{ alignItems: 'flex-start' }}
              >
                <span className="screen-row-icon">{item.icon}</span>
                <span className="screen-row-copy">
                  <strong>{item.title}</strong>
                  <span className="screen-detail">{item.detail}</span>
                </span>
              </div>
            ))}
          </Card>
        </Section>
        <p className="screen-footnote">
          The service’s own terms and privacy policy apply to what it receives.
          You can withdraw permission in Settings → Data consents. Praxis then
          asks again before sending.
        </p>
        <ScreenButton tone="primary" onClick={prompt.onAllow}>
          Allow
        </ScreenButton>
        <ScreenButton onClick={cancel}>Cancel</ScreenButton>
      </ScreenBody>
    </SheetDialog>
  );
}

export function ConsentsScreen() {
  const { consents, grantConsent } = usePraxisStore();
  const task = useScreenTask();
  return (
    <ScreenBody>
      <p className="screen-intro">
        Praxis asks before it first sends data to a service. Withdraw permission
        here to be asked again before sending.
      </p>
      <TaskError error={task.error} />
      <Section title="Data consents">
        {consents.length ? (
          <Card>
            {consents.map((consent) => (
              <Toggle
                key={consent.host}
                label={consent.host}
                detail={
                  consent.allowed
                    ? 'Allowed to receive data'
                    : 'Permission withdrawn'
                }
                checked={consent.allowed}
                disabled={task.busy}
                onChange={(allowed) => {
                  void task.run(() => grantConsent(consent.host, allowed));
                }}
              />
            ))}
          </Card>
        ) : (
          <p className="screen-empty">
            No services have been granted permission yet.
          </p>
        )}
      </Section>
    </ScreenBody>
  );
}
