import type { FastifyInstance } from 'fastify';
import type {
  EnqueueInput,
  BatchEnqueueInput,
  ClaimInput,
  CompleteInput,
  FailInput,
} from '@shardworks/shared-types';
import type { ListFilters } from './tasks.js';
import {
  enqueue,
  getTask,
  listTasks,
  batchEnqueue,
  claim,
  complete,
  fail,
  subtree,
  ready,
  getDepResults,
} from './tasks.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {

  // POST /tasks — enqueue a single task
  app.post<{ Body: EnqueueInput }>('/tasks', async (req, reply) => {
    const task = await enqueue(req.body);
    return reply.code(201).send(task);
  });

  // POST /tasks/batch — enqueue a graph of tasks atomically
  app.post<{ Body: BatchEnqueueInput }>('/tasks/batch', async (req, reply) => {
    const tasks = await batchEnqueue(req.body);
    return reply.code(201).send(tasks);
  });

  // POST /tasks/claim — claim the next eligible task
  app.post<{ Body: ClaimInput }>('/tasks/claim', async (req, reply) => {
    const result = await claim(req.body.agent_id);
    return reply.send(result);
  });

  // GET /tasks/ready — all currently claimable tasks
  app.get('/tasks/ready', async (_req, reply) => {
    const tasks = await ready();
    return reply.send(tasks);
  });

  // GET /tasks — list tasks with optional filters
  app.get<{
    Querystring: { status?: string; parent_id?: string; created_by?: string };
  }>('/tasks', async (req, reply) => {
    const filters: ListFilters = {};
    if (req.query.status) filters.status = req.query.status as ListFilters['status'];
    if (req.query.parent_id !== undefined) filters.parent_id = req.query.parent_id;
    if (req.query.created_by) filters.created_by = req.query.created_by;
    const tasks = await listTasks(filters);
    return reply.send(tasks);
  });

  // GET /tasks/:id — get a single task
  app.get<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    const task = await getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: 'not_found', message: `Task ${req.params.id} not found` });
    return reply.send(task);
  });

  // GET /tasks/:id/subtree — all descendants + rollup
  app.get<{ Params: { id: string } }>('/tasks/:id/subtree', async (req, reply) => {
    const result = await subtree(req.params.id);
    return reply.send(result);
  });

  // GET /tasks/:id/dep-results — result_payloads of all dependencies
  app.get<{ Params: { id: string } }>('/tasks/:id/dep-results', async (req, reply) => {
    const task = await getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: 'not_found', message: `Task ${req.params.id} not found` });
    const results = await getDepResults(req.params.id);
    return reply.send(results);
  });

  // POST /tasks/:id/complete — mark a task complete
  app.post<{ Params: { id: string }; Body: CompleteInput }>('/tasks/:id/complete', async (req, reply) => {
    const task = await complete(req.params.id, req.body.agent_id, req.body.result_payload);
    return reply.send(task);
  });

  // POST /tasks/:id/fail — mark a task failed
  app.post<{ Params: { id: string }; Body: FailInput }>('/tasks/:id/fail', async (req, reply) => {
    const task = await fail(req.params.id, req.body.agent_id, req.body.reason);
    return reply.send(task);
  });
}
