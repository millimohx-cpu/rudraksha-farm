# Rudraksha Farm — Cashfree Integration

This build connects the existing checkout to Cashfree hosted Checkout.

## Server environment
Copy `.env.example` to `.env` and set:

- `CASHFREE_ENV=sandbox` for testing, or `production` for live payments.
- `CASHFREE_APP_ID=...`
- `CASHFREE_SECRET_KEY=...`
- `PUBLIC_BASE_URL=https://your-real-domain.com`

**Never put the Secret Key in frontend JavaScript, screenshots, GitHub, or chat.**

## Flow
1. Customer submits the Rudraksha Farm checkout form.
2. Server validates the cart against the server product/price data.
3. Server creates the Cashfree order and receives a `payment_session_id`.
4. Browser opens Cashfree Checkout.
5. Cashfree returns the customer to the website.
6. Server checks `/pg/orders/{order_id}/payments` before treating the payment as paid.
7. Cashfree webhook is signature-verified and can update the local order asynchronously.

Cashfree's current web integration uses a backend Create Order API plus its JS SDK and payment session ID.

## Dashboard webhook
After the site has a public HTTPS URL, configure the Cashfree webhook/notify URL as:

`https://YOUR-DOMAIN.com/api/payments/cashfree/webhook`

Enable the payment events needed for successful/failed/pending payment updates.

## Important
- Sandbox credentials must be used with `CASHFREE_ENV=sandbox`.
- Production credentials must be used with `CASHFREE_ENV=production`.
- Do not switch to production until the sandbox flow has been tested end-to-end.
- The current site uses the server's product prices; browser-submitted prices are not trusted.
