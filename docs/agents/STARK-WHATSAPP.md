# Stark — escopo WhatsApp/Ryze

Leia `docs/agents/CONTRATO-GRU44.md` e `docs/agents/AUDITORIA.md` antes de tocar no código.

## Escopo permitido

Trabalhar somente na branch `gru44/stark-whatsapp`, abrindo PR para `gru44/coordination`.

- Integração real da Ryze: CRUD de instância, conexão/QR, status e renovação.
- Configuração e atualização automática do webhook correto da aplicação.
- Recepção, autenticação, validação, log e persistência de eventos inbound.
- Idempotência de eventos, deduplicação de contatos/conversas/mensagens e reprocessamento seguro.
- Enfileiramento/Redis/worker necessário para entregar o evento ao pipeline existente.
- Envio outbound pela API da Ryze, com request-id, retry controlado e rastreabilidade.

## Restrições

- Não alterar lógica de IA, seleção de modelo ou credencial OmniRoute.
- Não reintroduzir WAHA, Telegram ou qualquer fallback de transporte.
- Não apagar dados de teste nem limpar a base como “correção”.
- Não mascarar erro 502/503; registrar causa e tornar o retry observável.
- Não declarar a tarefa concluída sem teste de usuário com segundo telefone e evidência dos IDs de evento/mensagem.
- Não commitar segredos ou chaves reais.

## Entrega obrigatória no PR

Descrever arquivos, rotas reais, contrato do payload Ryze, estratégia de retry/idempotência, testes executados e evidência de que o evento chegou ao worker. Se a correção depender de Neliel, parar no ponto de integração documentado.
