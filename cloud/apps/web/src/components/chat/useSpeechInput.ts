import React from 'react';

/**
 * Voice input on the Web Speech API (`SpeechRecognition`, `webkitSpeechRecognition` in Chrome and Safari).
 * Interim words stream into the composer while you speak; finished phrases stay. Browsers without the API
 * (Firefox today) get no mic at all: `supported` is false and the composer hides the button.
 */

interface RecognitionAlternative { transcript: string }
interface RecognitionResult { readonly isFinal: boolean; readonly length: number; [index: number]: RecognitionAlternative }
interface RecognitionResultList { readonly length: number; [index: number]: RecognitionResult }
export interface SpeechRecognitionEventLike { resultIndex: number; results: RecognitionResultList }
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => SpeechRecognitionLike;

export function speechRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Plain words for every error the API reports. `aborted` is our own stop and says nothing. */
export function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow it in your browser’s site settings to use voice input.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'no-speech':
      return 'Didn’t catch that. Try again.';
    case 'network':
      return 'Voice input needs an internet connection.';
    case 'language-not-supported':
      return 'Voice input doesn’t support this language.';
    case 'aborted':
      return '';
    default:
      return 'Voice input stopped unexpectedly.';
  }
}

/** Joins what was typed before listening with what was heard, with one space between. */
export function joinSpoken(base: string, heard: string): string {
  const spoken = heard.replace(/\s+/g, ' ').trim();
  if (!spoken) return base;
  if (!base) return spoken;
  return /\s$/.test(base) ? `${base}${spoken}` : `${base} ${spoken}`;
}

export function useSpeechInput({
  text,
  onText,
  onError,
  lang,
}: {
  text: string;
  onText: (next: string) => void;
  onError: (message: string) => void;
  lang?: string;
}) {
  const [supported] = React.useState(() => speechRecognitionCtor() !== null);
  const [listening, setListening] = React.useState(false);
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null);
  const textRef = React.useRef(text);
  textRef.current = text;
  const callbacks = React.useRef({ onText, onError });
  callbacks.current = { onText, onError };

  const stop = React.useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = React.useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor || recognitionRef.current) return;
    const recognition = new Ctor();
    recognition.lang = lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
    recognition.continuous = true;
    recognition.interimResults = true;
    const base = textRef.current;
    recognition.onresult = (event) => {
      let heard = '';
      for (let i = 0; i < event.results.length; i++) heard += `${event.results[i]?.[0]?.transcript ?? ''} `;
      callbacks.current.onText(joinSpoken(base, heard));
    };
    recognition.onerror = (event) => {
      const message = speechErrorMessage(event.error);
      if (message) callbacks.current.onError(message);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    callbacks.current.onError('');
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      callbacks.current.onError(speechErrorMessage('unknown'));
    }
  }, [lang]);

  React.useEffect(() => () => recognitionRef.current?.abort(), []);

  return { supported, listening, start, stop, toggle: listening ? stop : start };
}
