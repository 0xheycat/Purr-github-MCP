export class SafeJsonHttpClient {
  #policy;
  #fetch;

  constructor(policy, fetchImpl = fetch) {
    if (!Number.isInteger(policy?.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 120_000) {
      throw new Error('outbound timeout policy is invalid');
    }
    if (
      !Number.isInteger(policy?.maxResponseBytes)
      || policy.maxResponseBytes < 1_024
      || policy.maxResponseBytes > 10_000_000
    ) {
      throw new Error('outbound response-size policy is invalid');
    }
    this.#policy = Object.freeze({ ...policy });
    this.#fetch = fetchImpl;
  }

  async requestJson(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.#policy.timeoutMs);
    const callerSignal = options.signal;
    const onAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onAbort();
    else callerSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      let response;
      try {
        response = await this.#fetch(options.url, {
          ...options.init,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        if (callerSignal?.aborted) throw new Error('outbound_cancelled', { cause: error });
        if (controller.signal.aborted) throw new Error('outbound_timeout', { cause: error });
        const message = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`;
        if (/redirect/i.test(message)) {
          throw new Error('outbound_redirect_rejected', { cause: error });
        }
        throw new Error('outbound_request_failed', { cause: error });
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      const accepted = options.acceptedContentTypes ?? ['application/json'];
      if (!accepted.includes(contentType)) throw new Error('outbound_content_type_rejected');
      const maximum = options.maxResponseBytes ?? this.#policy.maxResponseBytes;
      const reader = response.body?.getReader();
      const chunks = [];
      let total = 0;
      if (reader) {
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            total += result.value.length;
            if (total > maximum) {
              await reader.cancel();
              throw new Error('outbound_response_too_large');
            }
            chunks.push(result.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const body = Buffer.concat(chunks, total);
      if (!response.ok) throw new Error(`outbound_request_failed:${response.status}`);
      try {
        return JSON.parse(body.toString('utf8'));
      } catch (error) {
        throw new Error('outbound_invalid_json', { cause: error });
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }
}
