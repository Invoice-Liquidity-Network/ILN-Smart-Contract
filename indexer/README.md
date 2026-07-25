# ILN Indexer

REST API indexer for the Invoice Liquidity Network smart contracts. Indexes Horizon events from a Stellar network and exposes them via HTTP.

## Local Development

### Prerequisites
- Node.js 20+
- npm 10+

### Setup

```bash
cd indexer
npm install
npm run dev
```

The indexer will start on `http://localhost:3000` and create a local SQLite database at `./data/indexer.db`.

### Running Tests

```bash
# Run tests
npm test

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

## Docker Deployment

### Building the Docker Image

The Dockerfile uses a multi-stage build to optimize image size:

```bash
docker build -t iln/indexer:latest .
```

Image size is optimized to be under 200MB through:
- Alpine Linux base image (lightweight)
- Multi-stage build (production deps only in runtime)
- npm prune to remove dev dependencies

### Using Docker Compose

To run the full stack including Stellar, indexer, and notifications:

```bash
docker compose up -d
```

This will:
- Start Stellar quickstart on port 8000
- Start the indexer on port 3000 with a local SQLite database
- Start the notifications service on port 3001 with PostgreSQL

Check health status:
```bash
docker compose logs -f indexer | grep "health\|error"
```

Stop all services:
```bash
docker compose down
```

### Environment Variables

- `PORT` - Server port (default: 3000)
- `HORIZON_URL` - Stellar Horizon URL (default: http://localhost:8000)
- `CONTRACT_ID` or `ILN_CONTRACT_ID` - ILN contract address used for Horizon event ingestion
- `DB_PATH` - SQLite database file path (default: ./data/indexer.db)
- `LOG_LEVEL` - Logging level (default: info)
- `API_KEYS` - Optional comma-separated list of `X-API-Key` values that bypass the public rate limit

### Health Check

The health endpoint is available at:
```
GET /health
```

Returns `{ status: 'ok' }` when the service is ready.

## API Endpoints

- `GET /invoices` - List all invoices (filter, sort, paginate)
- `GET /invoices/:id` - Single invoice with its event log
- `GET /stats` - Global statistics
- `GET /stats/history` - Daily stats time series
- `GET /reputation/:address` - Reputation score and history
- `GET /leaderboard` - Top contributors
- `GET /events` - Account activity feed
- `GET /health` - Health check

See the **[REST API Reference](../docs/api-reference.md)** for the complete
specification: query parameters, request/response schemas, error codes,
authentication, and a curl example for every endpoint.

## Production Considerations

- Use a managed Postgres or SQLite backup for the database
- Configure appropriate log retention
- Set up monitoring on the `/health` endpoint
- Use environment variables for all configuration
- Run with a proper process manager (systemd, PM2, Docker, etc.)
