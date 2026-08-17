'use strict';

/**
 * Nano Cloud Backend — cryptographic / transaction proxy tier
 * Binds: process.env.PORT || 3000
 * Roles:
 *   1. OpenRouter LLM proxy (API key never leaves this process)
 *   2. Supabase service-role writes (anon key stays on client for RLS reads)
 *   3. Health + metrics endpoints for the GitHub Pages frontend
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://dominiccalandro1991-byte.github.io,http://localhost:5173,http://localhost:4173'
).split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Supabase (service role — server only)
// ---------------------------------------------------------------------------
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(express.json({ limit: '1mb' }));

app.use(cors({
  origin(origin, cb) {
    // Allow non-browser clients (health checks, curl) with no Origin
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
      return cb(null, true);
    }
    // Also allow any *.github.io under the same user for preview deploys
    try {
      const u = new URL(origin);
      if (u.hostname.endsWith('.github.io') && u.hostname.includes('dominiccalandro1991-byte')) {
        return cb(null, true);
      }
    } catch (_) { /* ignore */ }
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});
app.use('/api/', limiter);

// ---------------------------------------------------------------------------
// 1. Health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'nano-cloud-backend',
    ts: new Date().toISOString(),
    supabase: Boolean(supabase),
    openrouter: Boolean(OPENROUTER_API_KEY),
  });
});

app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'nano-cloud-backend',
    endpoints: ['/health', '/api/metrics', '/api/llm', '/api/sessions'],
  });
});

// ---------------------------------------------------------------------------
// 2. Metrics (matches existing frontend fire-and-forget contract)
// ---------------------------------------------------------------------------
app.post('/api/metrics', async (req, res) => {
  const body = req.body || {};
  const row = {
    k: Number(body.k) || null,
    m: Number(body.m) || null,
    payload_bytes: Number(body.bytes ?? body.payload_bytes) || null,
    latency_ms: Number(body.latencyMs ?? body.latency_ms) || null,
    throughput_mbps: Number(body.throughputMBps ?? body.throughput_mbps) || null,
    source: body.source || 'codec-ui',
    created_at: new Date().toISOString(),
  };

  if (!supabase) {
    // Soft-accept so free-tier cold starts never break the UI
    return res.status(202).json({ accepted: true, persisted: false, reason: 'supabase_unconfigured' });
  }

  try {
    const { error } = await supabase.from('codec_metrics').insert(row);
    if (error) {
      // Fallback table name used by the original frontend direct-REST path
      const { error: err2 } = await supabase.from('codec_sessions').insert({
        k: row.k,
        m: row.m,
        payload_bytes: row.payload_bytes,
        latency_ms: row.latency_ms,
      });
      if (err2) {
        console.error('[metrics]', error.message, err2.message);
        return res.status(502).json({ error: 'persist_failed', detail: err2.message });
      }
    }
    return res.status(201).json({ accepted: true, persisted: true });
  } catch (err) {
    console.error('[metrics]', err);
    return res.status(500).json({ error: 'internal', detail: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// 3. Codec session ledger (service-role write)
// ---------------------------------------------------------------------------
app.post('/api/sessions', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'supabase_unconfigured' });
  }
  const b = req.body || {};
  const row = {
    k: Number(b.k),
    m: Number(b.m),
    payload_bytes: Number(b.payload_bytes ?? b.bytes) || 0,
    latency_ms: Number(b.latency_ms ?? b.latencyMs) || null,
    meta: b.meta || null,
  };
  if (!Number.isFinite(row.k) || !Number.isFinite(row.m)) {
    return res.status(400).json({ error: 'k_and_m_required' });
  }
  try {
    const { data, error } = await supabase.from('codec_sessions').insert(row).select('id').single();
    if (error) return res.status(502).json({ error: 'persist_failed', detail: error.message });
    return res.status(201).json({ id: data.id });
  } catch (err) {
    return res.status(500).json({ error: 'internal', detail: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// 4. OpenRouter LLM proxy — API key never exposed to the browser
// ---------------------------------------------------------------------------
app.post('/api/llm', async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'openrouter_unconfigured' });
  }

  const {
    model = 'openai/gpt-4o-mini',
    messages,
    temperature = 0.2,
    max_tokens = 1024,
    stream = false,
  } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages_required' });
  }

  // Hard cap to prevent abuse
  if (messages.length > 40) {
    return res.status(400).json({ error: 'messages_too_long' });
  }

  try {
    const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dominiccalandro1991-byte.github.io/snca-codec/',
        'X-Title': 'Nano Cloud Codec',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: Math.min(Number(max_tokens) || 1024, 4096),
        stream: Boolean(stream),
      }),
    });

    const contentType = upstream.headers.get('content-type') || '';
    if (stream && contentType.includes('text/event-stream')) {
      res.status(upstream.status);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (upstream.body) {
        const reader = upstream.body.getReader
          ? upstream.body.getReader()
          : null;
        if (reader) {
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
          return res.end();
        }
        // Node fetch ReadableStream polyfill path
        for await (const chunk of upstream.body) {
          res.write(chunk);
        }
        return res.end();
      }
      return res.end();
    }

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    return res.status(upstream.status).json(payload);
  } catch (err) {
    console.error('[llm]', err);
    return res.status(502).json({ error: 'upstream_failed', detail: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err && String(err.message || '').startsWith('CORS')) {
    return res.status(403).json({ error: 'cors_denied', detail: err.message });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'listen',
    port: PORT,
    env: NODE_ENV,
    supabase: Boolean(supabase),
    openrouter: Boolean(OPENROUTER_API_KEY),
    origins: ALLOWED_ORIGINS,
  }));
});
