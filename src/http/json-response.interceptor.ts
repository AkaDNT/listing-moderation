import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { stringifyJson } from './json-codec';

interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
}

@Injectable()
export class JsonResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<HttpResponse>();
    return next.handle().pipe(map((value: unknown) => {
      if (response.statusCode === 204 || value === undefined) return undefined;
      const output = stringifyJson(value);
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      return output;
    }));
  }
}
