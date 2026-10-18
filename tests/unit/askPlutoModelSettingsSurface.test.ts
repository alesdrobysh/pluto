import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Ask Pluto model settings surface', () => {
  it('exposes an optional fast chat model without replacing the analysis model', () => {
    const settings = readFileSync(
      'src/components/features/SettingsTab.tsx',
      'utf8',
    );

    expect(settings).toContain('ollama_fast_model');
    expect(settings).toContain('Quick chat override (optional)');
    expect(settings).toContain('Local model');
    expect(settings).toContain('OLLAMA_GENERAL_MODEL');
    expect(settings).toContain('Quick answers use your local model by default.');
  });
});
