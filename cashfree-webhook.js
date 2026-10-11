async function handleCashfreeWebhookEvent(event, deps) {
  const cashfreeOrderId = event?.data?.order?.order_id || event?.data?.order_id || event?.order_id;
  const paymentStatus = event?.data?.payment?.payment_status || event?.data?.payment_status;
  if (!cashfreeOrderId) return { statusCode: 200, body: { ok: true } };

  try {
    const localOrderId = await deps.findLocalOrder(cashfreeOrderId);
    if (!localOrderId) {
      deps.logger?.error?.('Cashfree webhook references unknown order:', cashfreeOrderId);
      return { statusCode: 500, body: { error: 'Order not found' } };
    }

    if (paymentStatus === 'SUCCESS') {
      const marked = await deps.markOrderPaid(localOrderId);
      if (!marked) {
        deps.logger?.error?.('Webhook success references unknown local order:', cashfreeOrderId);
        return { statusCode: 500, body: { error: 'Order not found' } };
      }
    } else if (paymentStatus === 'PENDING' || paymentStatus === 'FAILED') {
      await deps.updatePaymentStatus(localOrderId, paymentStatus.toLowerCase());
    }

    return { statusCode: 200, body: { ok: true } };
  } catch (error) {
    deps.logger?.error?.('Cashfree webhook order confirmation failed:', error?.message || error);
    return { statusCode: 500, body: { error: 'Order confirmation failed' } };
  }
}

module.exports = { handleCashfreeWebhookEvent };
