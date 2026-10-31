export interface SyntheticModel {
  id: string;
  provider: string;
  name: string;
  tagline: string;
  speed: number;
  intelligence: number;
  vision: boolean;
  contextWindow: string;
}

const PROVIDERS = ['Anthropic', 'OpenAI', 'Google DeepMind', 'Groq', 'Mistral', 'Local Ollama'];
const MODEL_FAMILIES = [
  'Claude 3.7 Sonnet',
  'Claude 3.5 Haiku',
  'GPT-4.5 Orion',
  'o3-mini High',
  'Gemini 2.5 Pro',
  'Gemini 2.5 Flash',
  'Llama 3.3 70B SpecDec',
  'DeepSeek R1 Distill',
  'Mistral Large 2',
  'Qwen 2.5 Coder 32B',
];

export const SYNTHETIC_500_MODELS: SyntheticModel[] = Array.from({ length: 500 }, (_, i) => {
  const provider = PROVIDERS[i % PROVIDERS.length]!;
  const family = MODEL_FAMILIES[i % MODEL_FAMILIES.length]!;
  const speed = ((i * 3) % 5) + 1;
  const intelligence = ((i * 7) % 5) + 1;
  return {
    id: `model-${i + 1}`,
    provider,
    name: `${family} #${i + 1}`,
    tagline: `${provider} · ${i % 2 === 0 ? 'Low-latency reasoning' : 'Extended context synthesis'}`,
    speed,
    intelligence,
    vision: i % 3 !== 0,
    contextWindow: i % 4 === 0 ? '1M' : i % 2 === 0 ? '200k' : '128k',
  };
});

/**
 * Exact 5 multi-line recent note previews from IMG_7773.PNG – IMG_7774.PNG
 */
