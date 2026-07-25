import { createYoga, createSchema } from 'graphql-yoga';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { typeDefs } from './schema.js';
import { createResolvers } from './resolvers.js';

/**
 * Attach the GraphQL endpoint to an Express app.
 *
 * - Endpoint: `POST /graphql` (queries and mutations)
 * - GraphiQL playground: `GET /graphql` in development mode
 *
 * @param app  - Express application instance
 * @param db   - SQLite database (same instance used by REST routes)
 * @param dev  - Enable the GraphiQL playground (default: NODE_ENV !== 'production')
 */
export function mountGraphQL(
  app: Express,
  db: Database.Database,
  dev = process.env['NODE_ENV'] !== 'production'
): void {
  const schema = createSchema({
    typeDefs,
    resolvers: createResolvers(db),
  });

  const yoga = createYoga({
    schema,
    graphiql: dev,
    logging: false,
  });

  app.use('/graphql', yoga);
}
