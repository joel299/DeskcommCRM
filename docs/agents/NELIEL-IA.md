# Neliel — escopo IA/OmniRoute

Leia `docs/agents/CONTRATO-GRU44.md` e `docs/agents/AUDITORIA.md` antes de tocar no código.

## Escopo permitido

Trabalhar somente na branch `gru44/neliel-ia`, abrindo PR para `gru44/coordination`.

- Dispatcher do agente após uma mensagem inbound persistida.
- Criação e atualização de `ai_agent_run`, etapas, tokens, trace e estados de retry.
- Cliente do OmniRoute e tratamento de timeout, erro e resposta inválida.
- Uso do modelo exato `antigravity/gemini-3.6-flash-high`.
- Uso da credencial OmniRoute correta, server-side, sem expor o segredo.
- Persistência e envio da resposta através da interface outbound já fornecida pelo fluxo Ryze, sem alterar o transporte.

## Restrições

- Não alterar criação de instância, QR, webhook, autenticação Ryze ou deduplicação de eventos, salvo contrato de interface documentado.
- Não usar chave da Ryze para o LLM.
- Não trocar o OmniRoute por OpenAI, Anthropic, Gemini direto, OpenRouter, WAHA ou gateway alternativo.
- Não considerar “agente ativo” suficiente: provar chamada OmniRoute, tokens, trace e resposta persistida.
- Não commitar chaves reais nem dados de produção.

## Entrega obrigatória no PR

Descrever o contrato de entrada, o modelo e credencial selecionados, o fluxo de retry, os testes unitários/integrados e a evidência de `ai_agent_run` completo. Stark deve conseguir integrar a mudança sem copiar código manualmente: PR e commits devem ser pequenos, explícitos e aplicáveis por merge/cherry-pick.
