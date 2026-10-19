# Distributed Wagering Processor

Serviço financeiro distribuído para processamento de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores de jogos via **HTTP REST** e **AWS SQS FIFO**, garantindo **precisão monetária**, **idempotência persistente**, **controle de concorrência por carteira (`walletId`)**, **ledger imutável (append-only)** e **Transactional Outbox / Inbox**.

---

## 1. Stack Tecnológica

| Componente | Escolha Adotada |
|---|---|
| **Runtime / Package Manager / Test Runner** | **Bun 1.x** (`1.4.x`) |
| **Linguagem** | **TypeScript 5.x** (`strict: true`, `noUncheckedIndexedAccess`, `noImplicitAny`) |
| **Framework** | **NestJS 10** (Arquitetura Hexagonal / DDD com domínio puro) |
| **ORM & Migrations** | **MikroORM 6** (`EntitySchema` desacoplado do domínio + Migrations versionadas e reversíveis) |
| **Banco de Dados** | **PostgreSQL 16** (Constraints `CHECK`, `UNIQUE`, Partial Indexes e Trigger de Imutabilidade no Ledger) |
| **Mensageria** | **AWS SQS FIFO + DLQ** via **LocalStack 3.7** (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `integration-events.fifo`) |
| **Precisão Monetária** | **`decimal.js`** (`ROUND_HALF_EVEN`) + `NUMERIC(18, 2)` no PostgreSQL |

> As decisões arquiteturais detalhadas, diagramas de fluxo, estratégia de concorrência, mapeamento do `Money`, desenho de autenticação OIDC e resultados do teste de carga estão documentados em [**`ARCHITECTURE.md`**](./ARCHITECTURE.md).

---

## 2. Pré-requisitos e Setup Rápido

### Pré-requisitos
- **Bun 1.x** (`curl -fsSL https://bun.sh/install | bash`)
- **Docker** e **Docker Compose v2**

### Passo a Passo para Subir o Ambiente Local

1. **Instalar as dependências:**
   ```bash
   bun install
   ```

2. **Subir a infraestrutura (PostgreSQL 16 + LocalStack SQS):**
   ```bash
   docker compose up -d postgres localstack
   ```
   > **Nota:** Por padrão, o container do PostgreSQL expõe a porta **`5433`** no host (`localhost:5433 -> 5432`) para evitar conflito com instalações locais do PostgreSQL na porta `5432`. O LocalStack expõe a porta padrão **`4566`** e inicializa automaticamente as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `integration-events.fifo` via `docker/localstack/init-sqs.sh`.

3. **Executar as migrations versionadas:**
   ```bash
   bun run migration:up
   ```

4. **Iniciar a aplicação:**
   ```bash
   bun run start
   ```
   Ou para subir **toda a stack (incluindo a aplicação containerizada)** via Docker Compose:
   ```bash
   docker compose --profile full up -d --build
   ```

---

## 3. Comandos Disponíveis

| Comando | Descrição |
|---|---|
| `bun run start` | Inicia o servidor HTTP, o consumer SQS FIFO e os workers de Outbox e PendingReference |
| `bun run start:dev` | Inicia em modo watch para desenvolvimento |
| `bun run migration:up` | Aplica todas as migrations pendentes no PostgreSQL |
| `bun run migration:down` | Reverte a última migration aplicada (testando reversibilidade) |
| `bun run migration:status` | Lista migrations executadas e pendentes |
| `bun run typecheck` | Valida a tipagem em modo estrito (`tsc --noEmit`) |
| `bun test` | Executa todas as suítes de testes (Unidade + Integração + Concorrência) |
| `bun run test:unit` | Executa os testes unitários puros do domínio (`test/unit`) |
| `bun run test:integration` | Executa os testes de integração reais com PostgreSQL e LocalStack (`test/integration`) |
| `bun run test:concurrency` | Executa os testes de concorrência real com ≥ 3 instâncias simultâneas (`test/concurrency`) |
| `bun run test:load` | Executa o benchmark de carga e contenção gerando relatório JSON com `p50/p95/p99` e `outboxLag` |

---

## 4. Endpoints da API HTTP

### Health Checks & Observabilidade (Abertos)
- `GET /health/live` — Liveness probe do processo
- `GET /health/ready` — Readiness probe verificando conectividade real com PostgreSQL e AWS SQS
- `GET /metrics` — Snapshot estruturado de métricas (transações por status/kind/failureCode, duplicatas idempotentes, conflitos, retries, DLQ, lock conflicts, outbox lag e percentis de latência `p50/p95/p99`)

### Carteiras (`Wallets`)
- `POST /wallets` — Abre uma carteira (`version = 1`). Quando `initialBalance > 0.00`, gera atomicamente uma transação interna `OPENING` (`PROCESSED`), um lançamento `CREDIT` no ledger e eventos na transactional outbox.
- `GET /wallets/:walletId` — Consulta o saldo materializado e versão atual da carteira.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` — Lista os lançamentos imutáveis do ledger com paginação determinística baseada em cursor opaco (`base64url`).
- `POST /wallets/:walletId/reconciliation` — Reconcilia o `storedBalance` da carteira contra o `calculatedBalance` reconstruído a partir de todos os lançamentos do ledger.

### Transações de Apostas (`Wagering`)
- `POST /wagering/transactions` — Submete uma operação (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`). Exige o header `Idempotency-Key`.
- `GET /wagering/transactions/:transactionId` — Consulta uma transação pelo ID interno.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — Consulta uma transação pela chave composta do provedor.

### Tabela de Status HTTP e Semântica de Retorno

| Situação | HTTP Status | `status` / `errorCode` | Comportamento Recomendado ao Provedor |
|---|---|---|---|
| Carteira criada com sucesso | `201 Created` | — | Confirmado |
| Transação aplicada (`PROCESSED`) ou replay idempotente de `PROCESSED` | `200 OK` | `status: "PROCESSED"` | Confirmado (`idempotentReplay: true/false`) |
| Referência fora de ordem (`REFUND`/`ROLLBACK` antes da `BET`) | `202 Accepted` | `status: "PENDING_REFERENCE"` | Aceito; será processado assincronamente pelo worker |
| Payload inválido (moeda inválida, >2 casas decimais, valor negativo, falta `Idempotency-Key`, `OPENING` externo) | `400 Bad Request` | `INVALID_MONEY` / `INVALID_PAYLOAD` / `MISSING_IDEMPOTENCY_KEY` | Corrigir payload; não reenviar igual |
| Recurso não encontrado (`walletId` ou `transactionId` inexistente) | `404 Not Found` | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | Verificar identificador |
| Conflito de idempotência (mesma key com payload diferente) ou carteira duplicada (`playerId + currency`) | `409 Conflict` | `IDEMPOTENCY_CONFLICT` / `WALLET_ALREADY_EXISTS` | Erro de integração; não reenviar |
| Rejeição por regra de negócio (saldo insuficiente, reversão deixaria saldo negativo, referência já revertida, valor divergente) | `422 Unprocessable Entity` | `status: "REJECTED"` + `failureCode` explícito | Terminal e auditável; não reenviar |
| Falha transitória de infraestrutura (banco ou broker indisponível / timeout de lock) | `503 Service Unavailable` | `TRANSIENT_INFRASTRUCTURE_ERROR` | Reenviar com backoff exponencial e mesma `Idempotency-Key` |

### Exemplos Práticos (cURL)

```bash
# 1. Criar uma carteira com saldo inicial de 100.00 BRL
curl -s -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId": "player-01", "initialBalance": {"amount": "100.00", "currency": "BRL"}}'

# 2. Submeter uma aposta (BET) de 30.00 BRL (substitua <WALLET_ID> pelo id retornado acima)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: idem-bet-001" \
  -d '{
    "providerId": "jungle-slots",
    "externalTransactionId": "bet-001",
    "playerId": "player-01",
    "walletId": "<WALLET_ID>",
    "roundId": "round-01",
    "gameId": "fortune-tiger",
    "kind": "BET",
    "money": {"amount": "30.00", "currency": "BRL"}
  }'

# 3. Consultar o extrato imutável (ledger) e reconciliar a carteira
curl -s http://localhost:3000/wallets/<WALLET_ID>/ledger
curl -s -X POST http://localhost:3000/wallets/<WALLET_ID>/reconciliation
```

---

## 5. Estrutura do Projeto

```text
├── docker/localstack/init-sqs.sh     # Provisionamento automático das filas FIFO e RedrivePolicy (DLQ)
├── docker-compose.yml                # Orquestração PostgreSQL 16 + LocalStack 3.7 + App
├── Dockerfile                        # Imagem Bun 1.x para produção
├── mikro-orm.config.ts               # Configuração do MikroORM e Migrator
├── ARCHITECTURE.md                   # Decisões arquiteturais, trade-offs e resultados do teste de carga
├── src/
│   ├── domain/                       # Domínio puro TypeScript (zero dependências de NestJS/MikroORM)
│   │   ├── shared/                   # Money (decimal.js), DomainErrors, Canonical SHA-256 Hash
│   │   ├── wallet/                   # Wallet (Aggregate Root) e WalletLedgerEntry (imutável)
│   │   ├── wagering/                 # WagerTransaction (State Machine) e Enums/FailureCodes
│   │   └── messaging/                # InboxMessage, OutboxMessage e IntegrationEvents
│   ├── application/                  # Casos de Uso transacionais e Portas (Interfaces)
│   │   ├── ports/                    # ProviderIdentityPort e EventPublisherPort
│   │   └── use-cases/                # CreateWallet, SubmitWagerTransaction, Reconcile, Outbox, PendingRef
│   ├── infrastructure/               # Adaptadores técnicos
│   │   ├── persistence/              # EntitySchemas, Mappers (.rehydrate), Migrations e CLI
│   │   ├── messaging/                # SqsWagerConsumer (graceful shutdown), SqsEventPublisher, Workers
│   │   ├── observability/            # StructuredLoggerService (JSON) e MetricsService
│   │   └── auth/                     # ConfigurableProviderIdentityAdapter
│   └── presentation/                 # Camada HTTP (Controllers, ProviderAuthGuard, DomainExceptionFilter)
└── test/
    ├── unit/                         # Testes de unidade do modelo de domínio
    ├── integration/                  # Testes de integração real (Postgres + LocalStack)
    ├── concurrency/                  # Testes de paralelismo real (3 instâncias, 50x race, crash recovery)
    └── load/                         # Script bun run test:load
```
