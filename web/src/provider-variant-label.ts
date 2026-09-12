import { getUiLanguage, translateFor, type UiLanguage } from './ui-language';

// Display-only corrections; endpoint IDs and credential handling stay with the server catalog.
const labelOverrides: Record<string, string> = {
  'xiaomi-anthropic-cn': 'Anthropic 兼容 API',
  'hunyuan-token-plan-cn': 'Token Plan',
  'hunyuan-token-plan-enterprise-cn': 'Token Plan 企业版',
  'hunyuan-coding-plan-cn': 'Coding Plan',
};

export function providerVariantLabel(preset: { id: string; variant_label?: string; label: string }, language: UiLanguage = getUiLanguage()): string {
  // Regional variants can require different provider credentials.
  const label = labelOverrides[preset.id] ?? (preset.variant_label || preset.label);
  return translateFor(language, label);
}
