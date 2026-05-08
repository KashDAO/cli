/**
 * Production-shaped Fastify webhook receiver for Kash events.
 *
 * Verifies the `X-Kash-Signature` header against the raw request body
 * using the SDK's `verifySignature` helper (Stripe-compatible
 * algorithm: `t=<unix-ms>,v1=<hex-hmac-sha256>`).
 *
 * Run:
 *
 *   pnpm add fastify @kashdao/sdk
 *   KASH_WEBHOOK_SECRET=whsec_… node webhook-receiver.ts
 *
 * Then point your webhook URL at `http://<this-host>:3000/webhooks/kash`
 * and trigger an event (e.g. `kash webhooks redeliver <eventId>`).
 *
 * **Critical**: the body MUST be the *exact bytes* the server signed.
 * If your framework parses JSON before this handler, re-serialising
 * the parsed object won't produce the same bytes. We use Fastify's
 * `addContentTypeParser` to keep the raw buffer intact.
 *
 * Patterns this example demonstrates:
 *
 *   1. **Typed config validation at the boundary** — the secret is
 *      pulled from the environment via Zod, so a misconfigured
 *      deployment fails on boot rather than on the first request.
 *   2. **Structured logging** — Fastify's pino logger is used for
 *      every log line; no `console.*` in handler code.
 *   3. **Typed event payloads** — incoming events are validated
 *      against a Zod schema before dispatch. Unknown event types
 *      ack-and-skip (forward-compat) instead of erroring.
 *   4. **Defence in depth** — signature verification is the first
 *      thing the handler does; the parsed body is never trusted
 *      before the bytes have been authenticated.
 */

import { KashClient } from '@kashdao/sdk';
import Fastify from 'fastify';
import { z } from 'zod';

// ── Boot-time configuration validation ───────────────────────────
// Zod at the process boundary is the project standard (see CLAUDE.md
// "ALWAYS use Zod schemas for configuration validation"). Failing
// here gives a clear deploy-time error.
const ConfigSchema = z.object({
  KASH_WEBHOOK_SECRET: z.string().startsWith('whsec_').min(16, 'webhook secret looks too short'),
  PORT: z
    .string()
    .default('3000')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().positive()),
  HOST: z.string().default('0.0.0.0'),
});
const config = ConfigSchema.parse(process.env);

// ── Shared resources ──────────────────────────────────────────────
const kash = new KashClient({}); // verifySignature doesn't need an apiKey

// Pino logs request/response bodies at debug level — including the
// authenticated webhook payload, which we don't want spilling into
// log aggregation. Configure redaction up front rather than relying
// on operators remembering to set `--log-level=info` in production.
const fastify = Fastify({
  logger: {
    redact: {
      paths: [
        'req.headers["x-kash-signature"]',
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.body',
        'res.body',
      ],
      remove: true,
    },
  },
});

// Capture raw body so signature verification has the exact bytes.
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body);
});

// ── Event-payload schema ──────────────────────────────────────────
// Only the discriminator (`type`) and a generic `data` envelope are
// validated here — payload shapes vary by event type and are
// validated in the per-type handlers. Run `kash schema --json` to
// fetch every event payload schema at deploy time and codegen the
// per-type validators.
const EventSchema = z.object({
  type: z.string(),
  data: z.unknown(),
});

// ── Webhook route ─────────────────────────────────────────────────
fastify.post('/webhooks/kash', async (request, reply) => {
  const signature = request.headers['x-kash-signature'];
  if (typeof signature !== 'string') {
    request.log.warn('webhook delivery missing X-Kash-Signature header');
    return reply.code(400).send({ error: 'missing X-Kash-Signature header' });
  }

  // Defence-in-depth: confirm the parser landed the body as a string
  // before we trust it. Fastify v4+ allows multiple parsers; if a
  // higher-priority `application/json` parser is registered elsewhere
  // it could replace the raw-string body with a parsed object.
  if (typeof request.body !== 'string') {
    request.log.warn({ bodyType: typeof request.body }, 'webhook body parser returned non-string');
    return reply.code(400).send({ error: 'webhook body must be raw JSON string' });
  }
  const rawBody = request.body;
  const result = await kash.webhooks.verifySignature(
    rawBody,
    signature,
    config.KASH_WEBHOOK_SECRET
  );

  if (!result.valid) {
    request.log.warn({ reason: result.reason }, 'webhook signature rejected');
    return reply.code(400).send({ error: 'invalid signature', reason: result.reason });
  }

  // Bytes are authenticated — now we can parse safely.
  const parsed = EventSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) {
    request.log.warn({ issues: parsed.error.issues }, 'webhook payload failed schema');
    return reply.code(400).send({ error: 'invalid payload' });
  }
  const event = parsed.data;
  request.log.info({ type: event.type }, 'webhook event verified');

  switch (event.type) {
    case 'trade.completed':
      // Hand off to your domain logic. Keep the handler fast — Kash
      // retries on non-2xx, so do the work async and ack quickly.
      break;
    case 'trade.failed':
      // Alert routing, refund flow, etc.
      break;
    default:
      // Forward-compatible: unknown types are not an error.
      // Log them for observability and ack so Kash stops retrying.
      request.log.info({ type: event.type }, 'webhook event ignored (unknown type)');
      break;
  }

  return { ok: true };
});

// ── Boot ──────────────────────────────────────────────────────────
fastify.listen({ port: config.PORT, host: config.HOST }).catch((err: unknown) => {
  fastify.log.error({ err }, 'fastify failed to listen');
  // Process supervisors (systemd, k8s, pm2) restart on non-zero exit;
  // we surface the failure here and let them handle the lifecycle.
  process.exit(1);
});
