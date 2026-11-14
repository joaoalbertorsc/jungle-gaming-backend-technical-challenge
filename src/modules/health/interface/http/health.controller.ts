import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ReadinessChecker, type ReadinessReport } from '../../readiness';
import { livenessSchema, readinessSchema } from './health.openapi';

interface StatusSetter {
  status(code: number): unknown;
}

/** Health endpoints are intentionally unauthenticated (challenge §2, §9). */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessChecker) {}

  /** The process is alive; no dependency is checked. */
  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is up (no dependency checked)' })
  @ApiResponse({ status: 200, description: 'Alive', standardSchema: livenessSchema })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL and SQS are reachable: 200, otherwise 503 naming the failing dependency. */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL and SQS reachable' })
  @ApiResponse({ status: 200, description: 'Ready', standardSchema: readinessSchema })
  @ApiResponse({
    status: 503,
    description: 'Not ready; `checks` names the failing dependency',
    standardSchema: readinessSchema,
  })
  async ready(@Res({ passthrough: true }) response: StatusSetter): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
