[English](README.md) · **Português (Brasil)**

# Distributed Wagering Processor

Processador de transações de carteira e apostas que mantém cada saldo exato mesmo quando a mesma operação chega
duas vezes, fora de ordem ou ao mesmo tempo, em várias instâncias. Desenvolvido para o desafio técnico de
backend da Jungle Gaming ([`docs/CHALLENGE.md`](docs/CHALLENGE.md)).

## Contexto

Provedores de jogos enviam operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` por HTTP e por uma fila SQS. A
entrega é **at-least-once** (pelo menos uma vez), então o sistema precisa continuar correto quando uma mensagem
chega:

- **duplicada**: um reenvio nunca pode debitar ou creditar duas vezes;
- **fora de ordem**: um `REFUND` pode chegar antes do `BET` que ele estorna;
- **concorrente**: duas apostas podem disputar o mesmo saldo;
- **distribuída entre instâncias**: três ou mais processos rodam ao mesmo tempo, e qualquer um pode cair entre
  um passo e outro.

O dinheiro precisa ser exato (sem ponto flutuante), toda mudança de saldo precisa ser auditável, e nenhum evento
pode sair antes de seus dados estarem confirmados no banco. A stack exigida é PostgreSQL, SQS e Docker, e mocks
não podem substituí-los nos testes.

## Ação

**Stack:** TypeScript 6 (strict) sobre Bun 1.4 · NestJS 12 · MikroORM 7 · PostgreSQL 17 · SQS (emulador
MiniStack) · Docker Compose · métricas Prometheus · OpenAPI / Swagger UI.

Como o design responde a cada risco:

| Risco                               | Resposta                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Gravação parcial                    | Uma transação SQL por operação: transação, lançamento no ledger, saldo, inbox e eventos do outbox são confirmados juntos ou nenhum deles |
| Duas apostas no mesmo saldo         | Lock de linha por carteira (`SELECT … FOR UPDATE`) com espera limitada. As outras carteiras nunca esperam (não há lock global)           |
| Duplicatas e reenvios               | Idempotência persistente (chave + hash do payload canônico, gravados com o resultado) e inbox do SQS na mesma transação                  |
| Referências fora de ordem           | `PENDING_REFERENCE` (HTTP 202), resolvida por um retry worker com backoff exponencial e número limitado de tentativas                    |
| Eventos perdidos ou publicados cedo | Transactional outbox e processos relay: publicação só depois do commit, pelo menos uma vez                                               |
| Bugs que escapam do código          | O próprio schema garante as invariantes: saldo nunca negativo, ledger encadeado e somente-inserção, saldo == ledger no commit            |
| Várias instâncias                   | Uma imagem, um papel por processo (`api`, `consumer`, `outbox-relay`, `retry-worker`). Toda a coordenação passa pelo PostgreSQL          |

O trabalho foi guiado por testes (commits red → green), com containers reais de PostgreSQL e SQS, e entregue em
fases por pull requests que só são mergeados com o CI verde. Detalhes:

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design, estratégia de concorrência, fluxos e trade-offs;
- 18 registros de decisão em [`docs/adr/`](docs/adr/);
- os diagramas em [`docs/diagrams/`](docs/diagrams/).

## Resultado

| Garantia                              | Evidência                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Nenhum débito ou crédito duplicado    | 50 apostas idênticas enviadas em paralelo a 3 processos de API → 1 × 201, 49 × 200, **um** débito                      |
| Saldo nunca negativo em disputas      | 100,00 e duas apostas simultâneas de 80,00 → uma `PROCESSED`, uma `INSUFFICIENT_FUNDS`, 20,00, um débito               |
| Correto com várias instâncias         | 3 APIs, 3 consumers, 2 relays e um retry worker como processos separados, derrubados e reiniciados durante o teste     |
| Queda depois do commit e antes do ack | A mensagem reentregue é reconhecida pelo inbox: nenhum segundo efeito                                                  |
| Nenhum evento antes do commit         | Uma operação desfeita não publica nada; os eventos de um relay que caiu são publicados por outro                       |
| Ledger auditável                      | Somente-inserção e sem lacunas por carteira; a reconciliação aponta qualquer divergência e nunca a corrige em silêncio |

Todo teste termina conferindo `wallet.balance == saldo reconstruído pelo ledger`. No último merge, **348 testes
unitários, 220 de integração/e2e e 10 de concorrência** passaram, no CI de cada pull request.

- **Entregue:** todo o escopo obrigatório. Isso inclui as entradas HTTP e SQS, o outbox relay e o retry worker,
  a suíte de concorrência, as métricas e os logs JSON, e a documentação interativa da API.
- **Não entregue:** o teste de carga e a integração com Keycloak, ambos opcionais (existe apenas o ponto de
  extensão de autenticação).
- **Onde conferir:** a auditoria de cada falha eliminatória está em [`docs/audit.md`](docs/audit.md), e cada
  requisito é ligado ao seu código e aos seus testes em [`docs/traceability.md`](docs/traceability.md).

## Pré-requisitos

- Docker com Docker Compose v2
- git

Nada mais é instalado na máquina. Bun, PostgreSQL e o emulador de SQS rodam todos em containers.

## Início rápido

```bash
# Gera a imagem e sobe o sistema inteiro em segundo plano
docker compose up -d --build

# Pronto quando PostgreSQL e SQS respondem
curl http://localhost:3000/health/ready
```

Depois, abra **http://localhost:3000/docs** para explorar e testar a API no navegador (próxima seção).

`docker compose up` sobe apenas a aplicação; as suítes de teste rodam sob demanda (veja
[Desenvolvimento e testes](#desenvolvimento-e-testes)). Os serviços sobem nesta ordem:

| Serviço                                    | Papel                                                                  | Ciclo de vida     |
| ------------------------------------------ | ---------------------------------------------------------------------- | ----------------- |
| `postgres`, `ministack`                    | PostgreSQL 17 e o emulador de SQS                                      | Continuam rodando |
| `migrate`, `sqs-init`                      | Aplicam as migrations; criam as filas FIFO e a DLQ                     | Terminam com 0    |
| `api`                                      | API HTTP na porta 3000, Swagger UI, `/metrics`                         | Continua rodando  |
| `consumer`, `outbox-relay`, `retry-worker` | Consumer do SQS, publicação de eventos, retries de `PENDING_REFERENCE` | Continuam rodando |

Para subir só a API HTTP e suas dependências, use `docker compose up -d --build api`. Nesse caso o cenário
`202 PENDING_REFERENCE` abaixo fica pendente, porque nenhum retry worker está rodando.

## Documentação da API e testes interativos (Swagger / OpenAPI)

A API se documenta com OpenAPI 3, e o Swagger UI executa qualquer operação direto do navegador. Não é preciso
curl nem Postman.

| URL                                | Conteúdo                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| http://localhost:3000/docs         | Swagger UI: navegar, ler e executar cada endpoint                            |
| http://localhost:3000/openapi.json | O documento OpenAPI 3 (JSON), para Postman, Insomnia ou geradores de cliente |
| http://localhost:3000/openapi.yaml | O mesmo documento em YAML                                                    |

### O que ela mostra

- **Todos os endpoints**, agrupados em **Wallets**, **Wagering**, **Health** e **Observability**, cada um com um
  resumo e as regras de negócio que se aplicam.
- **Entradas:** corpos de requisição, parâmetros de rota e de query, com tipos e limites (tamanho máximo,
  formato UUID, tipos de aposta, tamanho de página). Também cobre os headers: `Idempotency-Key` (obrigatório nas
  submissões) e `X-Correlation-Id` (opcional).
- **Todos os status de resposta de cada endpoint**, com o schema do corpo:
  - **201:** processada;
  - **200:** replay idempotente;
  - **202:** aguardando referência;
  - **422:** rejeitada por regra de negócio, com `failureCode`;
  - **400, 404, 409:** Problem Details com um `code` estável;
  - **503:** tente novamente mais tarde.
- **Exemplos prontos para enviar:**
  - dois para `POST /wallets`;
  - um por tipo de aposta em `POST /wagering/transactions` (BET, WIN, LOSS, REFUND, ROLLBACK). Eles se
    encadeiam a partir do mesmo BET (`bet-1001`).
- **Um guia "teste em três passos"** no topo da página.

### Roteiro: teste os principais cenários no navegador

No Swagger UI, expanda uma operação e clique em **Execute**: o modo "Try it out" já vem ligado. Escolha um corpo
no menu **Examples**, edite-o e leia o status, o corpo e os headers logo abaixo. Os valores são os dos exemplos.

| #   | Operação                                                  | O que enviar                                                                                                                                               | Resultado esperado                                                                                                                                  |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /wallets`                                           | Exemplo _Wallet with 100.00 BRL_                                                                                                                           | **201** com o `id` da carteira (copie-o); saldo `100.00`, `version: 1`                                                                              |
| 2   | `POST /wagering/transactions`                             | Exemplo `bet`; cole o `id` da carteira em `walletId`; `Idempotency-Key: provider-a:bet-1001`                                                               | **201** `PROCESSED`, saldo `75.00`                                                                                                                  |
| 3   | idem                                                      | Execute de novo, sem alterar nada                                                                                                                          | **200** com o mesmo `transactionId` e `idempotentReplay: true`; o saldo não muda                                                                    |
| 4   | idem                                                      | Mesma chave, valor alterado para `30.00`                                                                                                                   | **409** `IDEMPOTENCY_CONFLICT`, motivo `PAYLOAD_MISMATCH`: nunca um replay                                                                          |
| 5   | idem                                                      | Exemplo `win`, chave `provider-a:win-1001`                                                                                                                 | **201**, saldo `115.00`                                                                                                                             |
| 6   | idem                                                      | Exemplo `rollback` (estorna o WIN), chave `provider-a:rollback-1001`                                                                                       | **201**, saldo `75.00`                                                                                                                              |
| 7   | idem                                                      | Exemplo `refund` com `externalTransactionId: refund-2002` e `referenceExternalTransactionId: bet-2002` (ainda não enviado), chave `provider-a:refund-2002` | **202** `PENDING_REFERENCE`: a referência ainda não chegou                                                                                          |
| 8   | idem                                                      | Exemplo `bet` com `externalTransactionId: bet-2002`, chave `provider-a:bet-2002`                                                                           | **201**, saldo `50.00`; o retry worker então resolve o REFUND                                                                                       |
| 9   | `GET /providers/.../transactions/{externalTransactionId}` | `provider-a` / `refund-2002`                                                                                                                               | `PROCESSED`, `resultingBalance` `75.00`                                                                                                             |
| 10  | `POST /wagering/transactions`                             | Exemplo `bet` com um id novo e valor `9999.00`                                                                                                             | **422** `REJECTED`, `failureCode: INSUFFICIENT_FUNDS`; saldo inalterado                                                                             |
| 11  | idem                                                      | Qualquer corpo sem o header `Idempotency-Key`                                                                                                              | **400** `IDEMPOTENCY_KEY_REQUIRED`                                                                                                                  |
| 12  | `GET /wallets/{walletId}/ledger`                          | O `id` da carteira                                                                                                                                         | Um lançamento por movimento de saldo: `CREDIT 100.00`, `DEBIT 75.00`, `CREDIT 115.00`, `DEBIT 75.00`, `DEBIT 50.00`, `CREDIT 75.00` (versões 1 a 6) |
| 13  | `POST /wallets/{walletId}/reconciliation`                 | O `id` da carteira                                                                                                                                         | **200**, `consistent: true`, diferença `0.00`, `checkedEntries: 6`                                                                                  |

`X-Correlation-Id` é opcional. Quando fica vazio, a API gera um e o devolve nos headers da resposta. O mesmo id
aparece nos logs e nos eventos daquela requisição.

Dica: o ícone de lâmpada no topo do Swagger UI alterna entre os temas claro e escuro. Por padrão, a página segue
o tema do sistema.

### Como a documentação se mantém correta

- **Entradas não são escritas duas vezes.** Corpos, parâmetros de rota e de query vêm dos mesmos schemas Zod que
  validam as requisições. Assim a documentação não aceita o que a API recusa, nem o contrário.
- **Respostas são conferidas contra a realidade.** Os schemas de resposta ficam ao lado de cada controller
  (`*.openapi.ts`). A suíte e2e [`test/e2e/openapi.e2e.spec.ts`](test/e2e/openapi.e2e.spec.ts) valida respostas
  reais com eles (201, 200, 202, 422, 400, 404, 409 e os health checks). Ela também confere que o documento lista
  exatamente os endpoints servidos, com todos os status e sem parâmetros duplicados. Uma resposta que mude sem a
  documentação correspondente quebra o CI.
- **Feita com** `@nestjs/swagger`, configurada em
  [`src/shared/interface/http/openapi.ts`](src/shared/interface/http/openapi.ts).
- **Sem autenticação.** `/docs` e `/openapi.*` são abertos, como os health checks; a autenticação foi adiada
  (ADR-0014).

### Com curl

Os mesmos primeiros passos pelo terminal:

```bash
# Cria uma carteira com 100.00 BRL e guarda o id dela
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Aposta 25.00 nela (troque WALLET_ID); repita a mesma chamada para ver o replay idempotente
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
       "walletId":"WALLET_ID","roundId":"r-1","gameId":"g-1","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

Referência dos endpoints em Markdown, com códigos de status e de erro: [`docs/API.md`](docs/API.md) (em inglês).

## Desenvolvimento e testes

Todas as ferramentas rodam no container `workspace`, com o código-fonte montado como volume.

```bash
# Primeira execução após clonar: instala as dependências (grava node_modules na pasta do projeto)
docker compose run --rm workspace bun install --frozen-lockfile

# Tudo o que o CI verifica: guarda contra testes focados, formatação, lint, typecheck e todas as suítes
docker compose run --rm workspace bun run verify

# Suítes individuais
docker compose run --rm workspace bun run test:unit
docker compose run --rm workspace bun run test:unit:coverage
docker compose run --rm workspace bun run test:integration
docker compose run --rm workspace bun run test:e2e
docker compose run --rm workspace bun run test:concurrency
```

As suítes de integração e e2e rodam contra containers reais de PostgreSQL e MiniStack, que o `workspace` sobe
automaticamente. Sem a infraestrutura, elas falham; nunca são puladas. Cada arquivo de teste roda no seu próprio
banco descartável (`test_*`), clonado de um template já migrado (`wagering_template`). A suíte de concorrência
sobe cada papel como um processo separado do sistema operacional (`bun src/main.ts`) e os derruba e reinicia no
meio do teste (§13). Rode `docker compose down --volumes` para zerar tudo.

## Observabilidade

- `GET /metrics` na API, e em `METRICS_PORT` (9464) nos processos worker, no formato Prometheus.
- `GET /health/live` e `GET /health/ready`.
- Os logs são linhas JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, nunca
  valores monetários.
- Catálogo de métricas, campos de log e exemplos de alerta: [`docs/observability.md`](docs/observability.md)
  (em inglês).

## Comandos úteis

| Comando                                                    | Finalidade                                             |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `docker compose run --rm migrate`                          | Aplica as migrations pendentes                         |
| `docker compose run --rm workspace bun run migration:down` | Reverte a última migration (banco de teste)            |
| `docker compose run --rm sqs-init`                         | (Re)cria as filas                                      |
| `docker compose logs -f api`                               | Acompanha os logs da API                               |
| `docker compose up -d --scale consumer=3 consumer`         | Sobe três instâncias do consumer do SQS                |
| `docker compose up -d outbox-relay`                        | Publica os eventos do outbox em `wagering-events.fifo` |
| `docker compose up -d retry-worker`                        | Reprocessa transações `PENDING_REFERENCE` (ADR-0012)   |
| `docker compose down --volumes`                            | Para tudo e apaga os volumes de dados                  |

## Portas no host

| Serviço         | Padrão | Variável para alterar |
| --------------- | ------ | --------------------- |
| API             | 3000   | `API_HOST_PORT`       |
| PostgreSQL      | 55432  | `POSTGRES_HOST_PORT`  |
| MiniStack (SQS) | 4566   | `SQS_HOST_PORT`       |

Copie `.env.example` para `.env` para alterá-las. As credenciais em `compose.yml` são valores de teste, apenas
para uso local.

## Integração contínua

O GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) roda em cada pull request e em cada push
para o `main`:

1. Qualidade: guarda contra testes focados, formatação, lint, typecheck
2. Testes unitários com cobertura mínima de 90% por arquivo
3. Testes de integração e e2e no mesmo workspace do Compose, incluindo a verificação da documentação OpenAPI
4. Suíte de concorrência: cada papel como um processo separado, com quedas e reinícios
5. Build da imagem de produção

## Mapa da documentação

A documentação detalhada está em inglês.

| Documento                                        | Leia para                                                  |
| ------------------------------------------------ | ---------------------------------------------------------- |
| [`docs/CHALLENGE.md`](docs/CHALLENGE.md)         | O enunciado original (em português)                        |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)             | Design, decisões, concorrência, fluxos e limitações        |
| [`docs/adr/`](docs/adr/)                         | Uma decisão por registro: contexto, decisão, consequências |
| [`docs/diagrams/`](docs/diagrams/)               | Topologia, módulos, modelo de dados, estados e cada fluxo  |
| [`docs/API.md`](docs/API.md)                     | Referência HTTP (também ao vivo em `/docs`)                |
| [`docs/observability.md`](docs/observability.md) | Catálogo de métricas, campos de log, alertas               |
| [`docs/traceability.md`](docs/traceability.md)   | Requisito → código → teste                                 |
| [`docs/audit.md`](docs/audit.md)                 | Falhas eliminatórias conferidas e o que não foi entregue   |
| [`docs/PLAN.md`](docs/PLAN.md)                   | Fases da entrega                                           |
