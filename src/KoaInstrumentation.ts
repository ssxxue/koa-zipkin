import * as zipkin from "zipkin";
import * as url from "url";
import {Middleware as KoaMiddleware} from "koa";
import {MiddlewareNext, GatewayRequest, GatewayContext} from "sasdn";

export interface MiddlewareOptions {
    tracer: zipkin.Tracer;
    serviceName?: string;
    port?: number;
}

export class KoaInstrumentation {
    public static middleware(options: MiddlewareOptions): KoaMiddleware {
        const tracer = options.tracer;
        const serviceName = options.serviceName || "unknown";
        const port = options.port || 0;

        if (tracer === false) {
            return async (ctx: GatewayContext, next: MiddlewareNext) => {
                await next()
            };
        }

        return async (ctx: GatewayContext, next: MiddlewareNext) => {
            const req = ctx.request;
            const res = ctx.response;

            ctx.response.set('Access-Control-Allow-Origin', '*');
            ctx.response.set('Access-Control-Allow-Headers', [
                'Origin', 'Accept', 'X-Requested-With', 'X-B3-TraceId',
                'X-B3-ParentSpanId', 'X-B3-SpanId', 'X-B3-Sampled'
            ].join(', '));


            function readHeader(headerName: string) {
                const val = KoaInstrumentation._getHeaderValue(req, headerName);
                if (val != null) {
                    return new zipkin.option.Some(val);
                } else {
                    return zipkin.option.None;
                }
            }

            if (KoaInstrumentation._containsRequiredHeaders(req)) {
                const spanId = readHeader(zipkin.HttpHeaders.SpanId);
                spanId.ifPresent((sid: zipkin.spanId) => {
                    const childId = new zipkin.TraceId({
                        traceId: readHeader(zipkin.HttpHeaders.TraceId),
                        parentId: readHeader(zipkin.HttpHeaders.ParentSpanId),
                        spanId: sid,
                        sampled: readHeader(zipkin.HttpHeaders.Sampled).map(KoaInstrumentation._stringToBoolean),
                        flags: readHeader(zipkin.HttpHeaders.Flags).flatMap(KoaInstrumentation._stringToIntOption).getOrElse(0)
                    });
                    tracer.setId(childId);
                });
            } else {
                const rootId = tracer.createRootId();
                if (KoaInstrumentation._getHeaderValue(req, zipkin.HttpHeaders.Flags)) {
                    const rootIdWithFlags = new zipkin.TraceId({
                        traceId: rootId.traceId,
                        parentId: rootId.parentId,
                        spanId: rootId.spanId,
                        sampled: rootId.sampled,
                        flags: readHeader(zipkin.HttpHeaders.Flags)
                    });
                    tracer.setId(rootIdWithFlags);
                } else {
                    tracer.setId(rootId);
                }
            }

            const traceId = tracer.id;

            tracer.scoped(() => {
                tracer.setId(traceId);
                tracer.recordServiceName(serviceName);
                tracer.recordRpc(req.method.toUpperCase());
                tracer.recordBinary('http.url', KoaInstrumentation._formatRequestUrl(req));
                tracer.recordAnnotation(new zipkin.Annotation.ServerRecv());
                tracer.recordAnnotation(new zipkin.Annotation.LocalAddr({port}));

                if (traceId.flags !== 0 && traceId.flags != null) {
                    tracer.recordBinary(zipkin.HttpHeaders.Flags, traceId.flags.toString());
                }
            });

            ctx[zipkin.HttpHeaders.TraceId] = traceId;

            await next();

            tracer.scoped(() => {
                tracer.setId(traceId);
                tracer.recordBinary('http.status_code', res.status.toString());
                tracer.recordAnnotation(new zipkin.Annotation.ServerSend());
            });
        };
    }

    private static _getHeaderValue(req: GatewayRequest, headerName: string): string {
        return req.header[headerName.toLowerCase()];
    }

    private static _containsRequiredHeaders(req: GatewayRequest): boolean {
        return KoaInstrumentation._getHeaderValue(req, zipkin.HttpHeaders.TraceId) !== undefined
            && KoaInstrumentation._getHeaderValue(req, zipkin.HttpHeaders.SpanId) !== undefined;
    }

    private static _formatRequestUrl(req: GatewayRequest): string {
        const parsed = url.parse(req.originalUrl);
        return url.format({
            protocol: req.protocol,
            host: req.header['host'],
            pathname: parsed.pathname,
            search: parsed.search
        });
    }

    private static _stringToBoolean(str: string): boolean {
        return str === '1';
    }

    private static _stringToIntOption(str: string): any {
        try {
            return new zipkin.option.Some(parseInt(str));
        } catch (err) {
            return zipkin.option.None;
        }
    }
}