# GRU-44 — ambiente multiagente

O repositório único é a fonte de verdade. Não criar um segundo repositório para Neliel: isso fragmentaria contratos, histórico e auditoria.

Branches:

- `gru44/coordination`: contrato, guard e integração auditada.
- `gru44/stark-whatsapp`: transporte WhatsApp/Ryze.
- `gru44/neliel-ia`: agente de IA/OmniRoute.
- `gru44/auditoria`: materiais auxiliares de auditoria, quando necessários.

Fluxo: ler contrato -> trabalhar na branch própria -> abrir PR para coordination -> workflow/CI -> auditoria -> integração -> nova auditoria. Nenhum agente trabalha diretamente em main.
