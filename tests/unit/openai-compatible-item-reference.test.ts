import { describe, expect, it } from 'vitest';
import { normalizarMensagensOpenAiCompat } from '@/lib/agent-engine/edge/llm/run-model-call';

describe('normalizarMensagensOpenAiCompat', () => {
  it('remove item_reference e preserva partes suportadas', () => {
    const result = normalizarMensagensOpenAiCompat([
      { role: 'assistant', content: [
        { type: 'text', text: 'resposta' },
        { type: 'item_reference', id: 'ref_123' },
        { type: 'file', data: 'arquivo' },
      ] },
    ] as never);
    expect(result).toEqual([{ role: 'assistant', content: [
      { type: 'text', text: 'resposta' },
      { type: 'file', data: 'arquivo' },
    ] }]);
  });

  it('preserva conteúdo textual', () => {
    const message = { role: 'user' as const, content: 'oi' };
    expect(normalizarMensagensOpenAiCompat([message])).toEqual([message]);
  });
});
