const test = require('node:test');
const assert = require('node:assert/strict');
const { handleCashfreeWebhookEvent } = require('../cashfree-webhook');

function deps(overrides = {}) {
  return {
    findLocalOrder: async () => 'local-123',
    markOrderPaid: async () => true,
    updatePaymentStatus: async () => {},
    logger: { error() {} },
    ...overrides
  };
}

test('maps a Cashfree order ID and confirms a successful payment', async () => {
  let foundId, markedId;
  const result = await handleCashfreeWebhookEvent(
    { data: { order: { order_id: 'cf-456' }, payment: { payment_status: 'SUCCESS' } } },
    deps({
      findLocalOrder: async id => { foundId = id; return 'local-123'; },
      markOrderPaid: async id => { markedId = id; return true; }
    })
  );
  assert.equal(foundId, 'cf-456');
  assert.equal(markedId, 'local-123');
  assert.deepEqual(result, { statusCode: 200, body: { ok: true } });
});

test('returns retryable 500 when the Cashfree order is unknown locally', async () => {
  const result = await handleCashfreeWebhookEvent(
    { data: { order: { order_id: 'missing-cf-order' }, payment: { payment_status: 'SUCCESS' } } },
    deps({ findLocalOrder: async () => null })
  );
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.error, 'Order not found');
});

test('returns retryable 500 when order confirmation throws', async () => {
  const result = await handleCashfreeWebhookEvent(
    { data: { order: { order_id: 'cf-456' }, payment: { payment_status: 'SUCCESS' } } },
    deps({ markOrderPaid: async () => { throw new Error('simulated transaction failure'); } })
  );
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.error, 'Order confirmation failed');
});

test('returns retryable 500 when markOrderPaid reports no local order', async () => {
  const result = await handleCashfreeWebhookEvent(
    { data: { order: { order_id: 'cf-456' }, payment: { payment_status: 'SUCCESS' } } },
    deps({ markOrderPaid: async () => false })
  );
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.error, 'Order not found');
});

test('updates PENDING status against the mapped local order', async () => {
  let update;
  const result = await handleCashfreeWebhookEvent(
    { data: { order: { order_id: 'cf-456' }, payment: { payment_status: 'PENDING' } } },
    deps({ updatePaymentStatus: async (id, status) => { update = [id, status]; } })
  );
  assert.deepEqual(update, ['local-123', 'pending']);
  assert.equal(result.statusCode, 200);
});

test('updates FAILED status against the mapped local order', async () => {
  let update;
  const result = await handleCashfreeWebhookEvent(
    { data: { order_id: 'cf-456', payment_status: 'FAILED' } },
    deps({ updatePaymentStatus: async (id, status) => { update = [id, status]; } })
  );
  assert.deepEqual(update, ['local-123', 'failed']);
  assert.equal(result.statusCode, 200);
});

test('acknowledges events without an order ID without touching dependencies', async () => {
  const result = await handleCashfreeWebhookEvent({ type: 'UNRELATED_EVENT' }, deps({
    findLocalOrder: async () => { throw new Error('should not run'); }
  }));
  assert.deepEqual(result, { statusCode: 200, body: { ok: true } });
});
