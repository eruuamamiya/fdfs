const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { db, FieldValue } = require('../utils/firebase');
const { authMiddleware } = require('./auth');

function generateDokuSignature(clientId, requestId, timestamp, requestTarget, bodyObj, secretKey) {
  const bodyString = JSON.stringify(bodyObj);
  const digest = crypto.createHash('sha256').update(bodyString, 'utf-8').digest('base64');

  const rawSignature =
    `Client-Id:${clientId}\n` +
    `Request-Id:${requestId}\n` +
    `Request-Timestamp:${timestamp}\n` +
    `Request-Target:${requestTarget}\n` +
    `Digest:${digest}`;

  const hmac = crypto.createHmac('sha256', secretKey).update(rawSignature).digest('base64');
  return `HMACSHA256=${hmac}`;
}

// 1. Membuat Halaman Pembayaran DOKU Checkout
router.post('/create-topup', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 5000) {
    return res.status(400).json({ error: 'Minimal top-up Rp 5.000' });
  }

  try {
    const userDoc = await db.collection('users').doc(req.user.id).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User tidak ditemukan' });
    const user = userDoc.data();

    const randomDigits = Math.floor(1000 + Math.random() * 9000);
    const invoiceNumber = `INV${Date.now()}${randomDigits}`;
    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString().slice(0, 19) + 'Z';
    const requestTarget = '/checkout/v1/payment';

    const cleanName = (user.username || 'Customer').replace(/[^a-zA-Z\s]/g, '').trim() || 'Customer';

    const payload = {
      order: {
        amount: Math.round(Number(amount)),
        invoice_number: invoiceNumber,
        currency: 'IDR',
        callback_url: `${process.env.BASE_URL}/dashboard.html`,
        callback_url_result: `${process.env.BASE_URL}/dashboard.html`,
        language: 'ID',
        auto_redirect: true
      },
      payment: {
        payment_due_date: 60
      },
      customer: {
        id: req.user.id,
        name: cleanName,
        email: user.email
      },
      additional_info: {
        override_notification_url: `${process.env.BASE_URL}/api/payment/webhook-doku`
      }
    };

    // Simpan order status PENDING ke Firestore
    await db.collection('orders').doc(invoiceNumber).set({
      orderId: invoiceNumber,
      userId: req.user.id,
      amount: Math.round(Number(amount)),
      status: 'PENDING',
      createdAt: timestamp
    });

    const signature = generateDokuSignature(
      process.env.DOKU_CLIENT_ID,
      requestId,
      timestamp,
      requestTarget,
      payload,
      process.env.DOKU_SECRET_KEY
    );

    const dokuRes = await axios.post(`${process.env.DOKU_API_URL}${requestTarget}`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': process.env.DOKU_CLIENT_ID,
        'Request-Id': requestId,
        'Request-Timestamp': timestamp,
        'Signature': signature
      }
    });

    res.json({
      success: true,
      orderId: invoiceNumber,
      checkoutUrl: dokuRes.data.response.payment.url
    });
  } catch (err) {
    console.error('DOKU Create Error:', err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error_messages?.join(', ') || 'Gagal membuat pembayaran DOKU'
    });
  }
});

// 2. WEBHOOK DOKU (Menerima notifikasi dari override_notification_url)
router.post('/webhook-doku', async (req, res) => {
  try {
    const clientId = req.headers['client-id'];
    const requestId = req.headers['request-id'];
    const timestamp = req.headers['request-timestamp'];
    const incomingSignature = req.headers['signature'];
    const webhookPath = '/api/payment/webhook-doku';

    const expectedSignature = generateDokuSignature(
      clientId,
      requestId,
      timestamp,
      webhookPath,
      req.body,
      process.env.DOKU_SECRET_KEY
    );

    if (incomingSignature !== expectedSignature) {
      console.warn('Signature Webhook DOKU tidak valid!');
      return res.status(401).json({ message: 'Invalid Signature' });
    }

    const invoiceNumber = req.body.order?.invoice_number;
    const status = req.body.transaction?.status;

    if (status === 'SUCCESS' && invoiceNumber) {
      const orderRef = db.collection('orders').doc(invoiceNumber);

      await db.runTransaction(async (t) => {
        const orderSnap = await t.get(orderRef);
        if (!orderSnap.exists) return;

        const orderData = orderSnap.data();
        if (orderData.status !== 'PENDING') return;

        const userRef = db.collection('users').doc(orderData.userId);
        const paidAt = new Date().toISOString();

        t.update(orderRef, {
          status: 'PAID',
          paidAt,
          channel: req.body.channel?.id || 'DOKU'
        });

        t.update(userRef, {
          tokens: FieldValue.increment(orderData.amount)
        });

        // Catat riwayat top-up (kredit) di dalam transaksi yang sama,
        // jadi dijamin hanya tercatat sekali meski webhook terkirim berulang.
        // ID dokumen = nomor invoice agar idempoten.
        t.set(db.collection('transactions').doc(invoiceNumber), {
          userId: orderData.userId,
          type: 'credit',
          amount: orderData.amount,
          description: 'Top-Up via DOKU',
          createdAt: paidAt
        });
      });

      console.log(`[DOKU PAID] ${invoiceNumber} -> Saldo token berhasil ditambahkan.`);
    }

    res.status(200).json({ message: 'Webhook received' });
  } catch (err) {
    console.error('Webhook DOKU Error:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

module.exports = router;
