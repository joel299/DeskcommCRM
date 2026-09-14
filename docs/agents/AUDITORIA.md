# Protocolo do auditor GRU-44

Este arquivo define o processo de auditoria antes e depois de cada rodada. Leia primeiro o `CONTRATO-GRU44.md`.

## Fonte obrigatória de evidência

A Linear/GRU é contexto de requisitos e histórico, não prova técnica suficiente. Toda auditoria deve ser fundamentada no GitHub oficial e no sistema publicado:

- consultar branches, SHA atual, PR, base/head, diff e comentários de revisão;
- consultar cada workflow associado ao SHA, seus jobs, passos, conclusão e logs do job falho;
- conferir arquivos e rotas reais no commit auditado;
- comparar o SHA auditado com a imagem, serviço e réplica efetivamente implantados;
- distinguir `queued`, `in_progress`, `success` e `failure`; workflow pendente não é aprovação;
- registrar URLs/IDs técnicos, timestamps e status sanitizados;
- nunca tratar screenshot, relato do agente ou status visual como substituto de logs e código.

## Antes de qualquer desenvolvimento

- Ler a issue GRU-44 e os comentários mais recentes.
- Conferir o estado do repositório, branch, commit, workflow e PRs no GitHub.
- Confirmar se branches e required status checks estão protegidos; se não estiverem, registrar o risco.
- Mapear o caminho real do código para Ryze, webhook, fila/Redis, worker, agente, OmniRoute e outbound.
- Comparar o comportamento de `gru44/coordination` com o baseline original e com a imagem/serviço atualmente implantado.
- Registrar blockers e critérios verificáveis; não aceitar “corrigido” sem teste reproduzível.

## Após cada rodada

- Revisar o diff e os arquivos alterados no PR, incluindo comentários de revisão automatizada e humana.
- Confirmar que não houve alteração fora do escopo do agente.
- Executar os testes e verificar os workflows do GitHub até conclusão; registrar falha e log, não apenas o selo geral.
- Confirmar a cadeia ponta a ponta com dados sintéticos: webhook recebido, persistido, enfileirado, consumido, `ai_agent_run` criado, OmniRoute chamado e resposta enviada pela Ryze.
- Conferir idempotência/retry, ausência de duplicação e ausência de segredos em logs.
- Comparar SHA da imagem/serviço com o commit auditado; código no GitHub sem implantação comprovada não é considerado corrigido.
- Publicar relatório objetivo: evidência, falha restante, próximo passo e status do GRU-44.
- Manter GRU-44 em **In Progress** enquanto qualquer critério falhar. Não mover para Review apenas por mudança de código.

## Limites

O auditor não altera produção durante a auditoria, não apaga dados e não aprova mudanças sem evidência. Correções devem voltar para o fluxo de PR/branch e ser auditadas novamente.
