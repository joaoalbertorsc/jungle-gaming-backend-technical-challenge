import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from '@nestjs/common';
import { APPLICATION_LOGGER, type ApplicationLogger } from '../../application/ports';
import { correlationIdOf, type CorrelatedRequest } from './correlation-id';
import { problemFor } from './problem-mapping';

interface ProblemResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

/**
 * Global exception filter (the NestJS analogue of Spring's @ControllerAdvice, ADR-0009): every
 * error from every endpoint becomes an RFC 9457 Problem Details body with a stable `code`.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(@Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<
      CorrelatedRequest & { method?: string; originalUrl?: string }
    >();
    const response = http.getResponse<ProblemResponse>();
    const correlationId = correlationIdOf(request);
    const problem = problemFor(exception);

    if (problem.status >= 500) {
      this.logger.error('request failed', {
        correlationId,
        method: request.method,
        path: request.originalUrl,
        code: problem.code,
        error: exception instanceof Error ? exception.name : typeof exception,
        message: exception instanceof Error ? exception.message : undefined,
      });
    }

    response.status(problem.status);
    response.setHeader('content-type', 'application/problem+json; charset=utf-8');
    if (problem.retryAfterSeconds !== undefined) {
      response.setHeader('retry-after', String(problem.retryAfterSeconds));
    }
    response.send(
      JSON.stringify({
        type: `urn:wagering:problem:${problem.code}`,
        title: problem.title,
        status: problem.status,
        detail: problem.detail,
        code: problem.code,
        correlationId,
        instance: request.originalUrl,
        ...problem.extras,
      }),
    );
  }
}
