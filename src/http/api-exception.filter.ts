import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';
import { ServerResponse } from 'node:http';
import { ApiError, errorEnvelope, writeJsonResponse } from './errors';

@Catch()
@Injectable()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ServerResponse>();
    if (exception instanceof ApiError) {
      writeJsonResponse(response, exception.status, errorEnvelope(exception.code, exception.message));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = codeForStatus(status);
      const message = status >= 500 ? 'Internal server error' : exceptionMessage(exception.getResponse());
      writeJsonResponse(response, status, errorEnvelope(code, message));
      return;
    }

    writeJsonResponse(response, 500, errorEnvelope('internal_error', 'Internal server error'));
  }
}

function exceptionMessage(value: string | object): string {
  if (typeof value === 'string') return value;
  const message = (value as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && message.every(item => typeof item === 'string')) return message.join('; ');
  return 'Request failed';
}

function codeForStatus(status: number): string {
  if (status === 400) return 'invalid_request';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'validation_error';
  return status >= 500 ? 'internal_error' : 'http_error';
}
