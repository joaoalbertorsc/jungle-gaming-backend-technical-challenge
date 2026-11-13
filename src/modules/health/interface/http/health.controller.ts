import { Controller, Get, Res } from '@nestjs/common';
import { ReadinessChecker, type ReadinessReport } from '../../readiness';

interface StatusSetter {
  status(code: number): unknown;
}

/** Health endpoints are intentionally unauthenticated (challenge §2, §9). */
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessChecker) {}

  /** The process is alive; no dependency is checked. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL and SQS are reachable: 200, otherwise 503 naming the failing dependency. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusSetter): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
