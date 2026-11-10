import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { test } from 'node:test';
import { createAdminRouter } from '../src/routes/admin.routes.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/config/auth.js';

if ([...(process.env.JWT_ACCESS_SECRET ?? '')].length < 32) {
  process.env.JWT_ACCESS_SECRET = 'balancevault-admin-http-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
}
if (!/^(?:[a-f0-9]{2}){32,}$/i.test(process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY ?? '')) {
  process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY = 'ab'.repeat(32);
}

const failureCases = [
  ['signature invalid', '42501', 'Actor assertion signature is invalid', 'actor_assertion_signature_invalid', 403],
  ['context mismatch', '42501', 'Actor assertion payload does not match', 'actor_assertion_context_mismatch', 403],
  ['expired assertion', '42501', 'Expired actor assertion', 'actor_assertion_expired', 403],
  ['replayed assertion', '42501', 'Actor assertion has already been used', 'actor_assertion_replay', 403],
  ['malformed assertion', '42501', 'Invalid actor assertion', 'actor_assertion_invalid', 403],
  ['inactive or non-admin actor', '42501', 'Active administrator required', 'active_administrator_check_failed', 403],
  ['database permission denial', '42501', 'permission denied for function create_privileged_user_invitation_asserted', 'database_authorization_failure', 403],
  ['unprovisioned verifier', '55000', 'Actor assertion verifier is not provisioned', 'actor_assertion_verifier_unavailable', 503],
  ['unclassified authorization error', '42501', 'sensitive database detail must not be logged', 'database_authorization_failure', 403],
];

async function submitInvitation(code, message) {
  const userId = '10000000-0000-4000-8000-000000000001';
  const cause = new Error(message);
  cause.originalCode = code;
  cause.detail = 'private-detail-sentinel';
  const prisma = {
    user: {
      async findUnique() {
        return { id: userId, role: 'ADMIN', isActive: true, tokenVersion: 0 };
      },
    },
    async $queryRaw() {
      throw { meta: { driverAdapterError: { cause } } };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter(prisma));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const accessToken = jwt.sign({ ver: 0 }, process.env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: '15m',
  });
  let logged;
  const originalWarn = console.warn;
  console.warn = (...args) => { logged = args; };
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Sensitive Request Name',
        email: 'sensitive-request-email@example.test',
        role: 'AUDITOR',
      }),
    });
    return { status: response.status, body: await response.json(), logged };
  } finally {
    console.warn = originalWarn;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

for (const [label, code, message, category, status] of failureCases) {
  test(`admin invitation safely classifies ${label}`, async () => {
    const result = await submitInvitation(code, message);
    assert.equal(result.status, status);
    assert.deepEqual(result.body, status === 503
      ? { error: 'Invitation service is temporarily unavailable' }
      : { error: 'Administrator authorization is required' });
    assert.equal(result.logged?.[0], 'Admin invitation rejected by PostgreSQL');
    assert.equal(result.logged?.[1]?.category, category);
    assert.deepEqual(Object.keys(result.logged?.[1] ?? {}).sort(), ['category', 'requestId']);
    assert.doesNotMatch(JSON.stringify(result.logged), /sensitive-request|private-detail|password|hash|token|secret|signature is invalid/i);
  });
}
