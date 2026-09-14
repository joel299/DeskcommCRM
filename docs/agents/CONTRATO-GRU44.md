# Contrato canônico GRU-44

Status: fonte da verdade operacional. Mudanças neste contrato só podem ocorrer por revisão explícita do auditor do GRU-44.

## Objetivo

Restaurar o fluxo completo de WhatsApp e IA sem quebrar o DeskcommCRM original. A implementação deve preservar as funcionalidades existentes e trocar somente as integrações definidas abaixo.

## Regras imutáveis

1. **Ryze é o único provedor de transporte WhatsApp** neste fluxo: criação de instância, QR, status, webhook, inbound, conversas, mensagens e outbound.
2. **OmniRoute é o único gateway LLM** do agente de IA. O modelo canônico é exatamente `antigravity/gemini-3.6-flash-high`.
3. A chave da Ryze é exclusiva para a API da Ryze. A credencial do OmniRoute é exclusiva do LLM. Nunca misturar tokens, nomes de variáveis ou headers.
4. WAHA não pode ser usado como rota ativa, fallback silencioso, default ou dependência indireta. Código legado pode existir apenas se estiver explicitamente fora do caminho de execução e coberto por teste.
5. O fluxo obrigatório é: Ryze webhook -> autenticação/verificação -> `webhook_events_log` -> deduplicação idempotente -> persistência de contato/conversa/mensagem -> fila/Redis -> worker de produção -> `ai_agent_run` -> OmniRoute -> persistência da resposta -> envio outbound pela Ryze.
6. Cada evento precisa de correlação, idempotência e observabilidade. Falha transitória deve ser reprocessável sem duplicar contato, conversa ou mensagem.
7. Segredos nunca entram em código, commits, logs, respostas HTTP ou screenshots. Testes usam variáveis de ambiente e valores sintéticos.
8. Nenhum agente deve apagar dados, alterar produção ou trocar o provedor de outro domínio sem aprovação explícita do auditor.

## Critérios de aceite

- Criar, consultar, conectar, obter/renovar QR, atualizar webhook, verificar status e excluir uma instância Ryze funcionam.
- Um inbound real de um segundo telefone aparece uma única vez no webhook log, conversa, contato e inbox.
- O worker consome o evento e cria `ai_agent_run` com etapas, tokens e trace não vazios.
- A chamada do agente usa OmniRoute com o modelo canônico acima e a credencial correta.
- Existe no máximo uma resposta outbound para cada mensagem inbound processada.
- Reentrega do mesmo evento é segura e não duplica dados nem respostas.
- O sistema registra causa, request-id/correlation-id e estado de retry para erros 4xx/5xx sem expor segredos.
- O GRU-44 permanece **In Progress** até todos os critérios passarem. Só o auditor pode recomendar Review/Done com evidência.

## Integração

Stark trabalha em `gru44/stark-whatsapp`. Neliel trabalha em `gru44/neliel-ia`. Cada agente abre PR para `gru44/coordination`; nada vai direto para `main`. O auditor revisa cada commit/PR, workflow, imagem implantada e evidência funcional antes da próxima rodada.
