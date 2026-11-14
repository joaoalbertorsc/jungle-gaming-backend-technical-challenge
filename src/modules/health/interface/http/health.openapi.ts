import { z } from 'zod';

export const livenessSchema = z
  .object({ status: z.literal('ok') })
  .strict()
  .meta({ title: 'Liveness' });

const dependency = z.enum(['up', 'down']);

export const readinessSchema = z
  .object({
    status: z.enum(['ok', 'unavailable']),
    checks: z.object({ database: dependency, sqs: dependency }).strict(),
  })
  .strict()
  .meta({ title: 'Readiness' });
