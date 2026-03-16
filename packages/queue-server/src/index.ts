import Fastify from 'fastify';
import { initSchema } from './schema.js';
import { registerRoutes } from './routes.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  const e = err as Error & { statusCode?: number };
  reply.code(e.statusCode ?? 500).send({
    error: e.name ?? 'InternalServerError',
    message: e.message,
  });
});

await initSchema();
await registerRoutes(app);
await app.listen({ port: PORT, host: '0.0.0.0' });
