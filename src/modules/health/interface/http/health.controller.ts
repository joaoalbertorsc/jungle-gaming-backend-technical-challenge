import { Controller, Get } from '@nestjs/common';

/**
 * Health endpoints are intentionally unauthenticated (challenge §2, §9).
 * `/health/ready` (PostgreSQL + SQS reachability) lands with the infrastructure adapters.
 */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
