import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const english = await readJson('src/locales/en/translation.json');
const chinese = await readJson('src/locales/zh-Hans/translation.json');
const englishKeys = Object.keys(english).sort();
const chineseKeys = Object.keys(chinese).sort();

if (JSON.stringify(englishKeys) !== JSON.stringify(chineseKeys)) {
  const englishSet = new Set(englishKeys);
  const chineseSet = new Set(chineseKeys);
  throw new Error(
    `Locale keys differ. Missing Chinese: ${englishKeys.filter((key) => !chineseSet.has(key)).join(', ')}; ` +
      `extra Chinese: ${chineseKeys.filter((key) => !englishSet.has(key)).join(', ')}`,
  );
}

const placeholders = (value) =>
  Array.from(value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g), (match) => match[1]).sort();

for (const key of englishKeys) {
  const expected = placeholders(english[key]);
  const actual = placeholders(chinese[key]);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`Interpolation placeholders differ for ${key}`);
  }
}

const allowedEnglish =
  /\b(?:AGPL|AI|API|Amazon|Anthropic|AWS|Azure|Base64|Bedrock|CAPTCHA|ChatGPT|CloudFront|Cohere|Cookie|Discord|ElevenLabs|EN|English|Firecrawl|GitHub|Google|ID|IDs|IP|Jina|JSON|JWKS|LibreChat|LocalAI|MCP|MIME|Mistral|OAuth|OCR|OIDC|On-Behalf-Of|OpenAI|PDF|QA|Regex|Responses|SearXNG|Serper|SSE|SSO|STT|Tavily|TLS|Token|Top K|Top P|TTL|TTS|Turnstile|URI|URL|Vertex|WebSocket|YAML|abc|i18n|ms|px)\b/g;
const allowedLiteralKeys = new Set([
  'com_auth_email_placeholder',
  'com_config_field_code',
  'com_config_field_labelCode',
  'com_config_field_placeholderCode',
  'com_config_field_descriptionCode',
  'com_config_field_searchPlaceholderCode',
  'com_config_field_selectPlaceholderCode',
  'com_config_field_file_ids_item',
  'com_config_field_agent_ids_item',
  'com_config_field_supportedIds_item',
  'com_config_field_excludedIds_item',
  'com_config_field_oidc',
  'com_config_mode_i18n',
  'com_kv_type_json',
  'com_kv_type_number',
  'com_kv_type_string',
  'com_language_en',
  'com_language_en_short',
]);
const mixedLanguage = [];

for (const [key, value] of Object.entries(chinese)) {
  if (allowedLiteralKeys.has(key)) continue;
  const visibleText = value
    .replace(/{{[^}]+}}/g, '')
    .replace(allowedEnglish, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[a-z0-9_.+-]+@[a-z0-9.-]+/gi, '')
    .replace(/librechat\.ya?ml/gi, '')
    .replace(/\.ya?ml/gi, '');
  if (/[A-Za-z]{2,}/.test(visibleText)) mixedLanguage.push(`${key}: ${value}`);
}

if (mixedLanguage.length > 0) {
  throw new Error(`Unexpected English text in Simplified Chinese locale:\n${mixedLanguage.join('\n')}`);
}

console.log(`Verified ${englishKeys.length} bilingual locale keys and interpolation placeholders.`);
