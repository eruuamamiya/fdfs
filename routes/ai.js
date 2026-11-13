const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db, FieldValue } = require('../utils/firebase');
const { authMiddleware } = require('./auth');

const MARKUP_ADMIN = 1;    // harga bawaan (tanpa markup)
const MARKUP_USER = 1.05;  // harga bawaan + 5%

const BALANCE_URL = 'https://iwiw.nekoganz.my.id/balance';
const BALANCE_API_KEY = 'testing';

function getAdminId() {
  return process.env.ADMIN_USER_ID || '0ber5EnCFolLxN0uxM6s';
}

function getMarkup(isAdmin) {
  return isAdmin ? MARKUP_ADMIN : MARKUP_USER;
}

async function fetchAdminBalance() {
  const bRes = await axios.get(BALANCE_URL, {
    headers: { 'x-api-key': BALANCE_API_KEY }
  });
  return Number(bRes.data.balance || 0);
}

function loadModelsConfig() {
  const filePath = path.join(__dirname, '../config/models.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// 1. Katalog Model + Harga (per 1M token)
router.get('/models', authMiddleware, (req, res) => {
  const config = loadModelsConfig();
  const kurs = config.usdToIdr || 18000;
  const markup = getMarkup(req.user.id === getAdminId());

  const models = config.data.map(m => {
    const inputUsd1M = Number((m.inputPrice * markup).toFixed(4));
    const outputUsd1M = Number((m.outputPrice * markup).toFixed(4));
    const inputIdr1M = Math.round(inputUsd1M * kurs);
    const outputIdr1M = Math.round(outputUsd1M * kurs);

    return {
      id: m.modelId,
      name: m.name,
      provider: m.modelId.split('/')[0].toUpperCase(),
      description: m.description,
      capabilities: m.capabilities || [],
      contextWindow: m.contextWindow,
      inputUsd1M,
      outputUsd1M,
      inputIdr1M,
      outputIdr1M
    };
  });

  res.json({ success: true, models });
});

// 2. Ambil Daftar Semua Percakapan Milik User
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const snap = await db.collection('conversations')
      .where('userId', '==', req.user.id)
      .get();

    const list = [];
    snap.forEach(doc => {
      const data = doc.data();
      list.push({
        id: doc.id,
        title: data.title || 'Percakapan Baru',
        modelId: data.modelId || '',
        updatedAt: data.updatedAt || data.createdAt || ''
      });
    });

    list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    res.json({ success: true, conversations: list });
  } catch (err) {
    console.error('Load Conversations Error:', err);
    res.status(500).json({ error: 'Gagal memuat riwayat percakapan' });
  }
});

// 3. Ambil Detail & Seluruh Isi Obrolan dalam 1 Percakapan
router.get('/conversations/:id', authMiddleware, async (req, res) => {
  try {
    const docRef = db.collection('conversations').doc(req.params.id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ error: 'Percakapan tidak ditemukan' });
    }

    const data = docSnap.data();
    if (data.userId !== req.user.id) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    res.json({
      success: true,
      conversation: {
        id: docSnap.id,
        title: data.title,
        modelId: data.modelId,
        messages: data.messages || []
      }
    });
  } catch (err) {
    console.error('Get Conversation Detail Error:', err);
    res.status(500).json({ error: 'Gagal membuka isi percakapan' });
  }
});

// 4. Hapus Percakapan
router.delete('/conversations/:id', authMiddleware, async (req, res) => {
  try {
    const docRef = db.collection('conversations').doc(req.params.id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (docSnap.data().userId !== req.user.id) return res.status(403).json({ error: 'Akses ditolak' });

    await docRef.delete();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete Conversation Error:', err);
    res.status(500).json({ error: 'Gagal menghapus percakapan' });
  }
});

// 5. Chat AI + Simpan Otomatis ke History Percakapan
router.post('/chat', authMiddleware, async (req, res) => {
  const { modelId, prompt, conversationId } = req.body;

  try {
    const userRef = db.collection('users').doc(req.user.id);
    const userSnap = await userRef.get();

    if (!userSnap.exists) return res.status(404).json({ error: 'User tidak ditemukan' });

    const isAdmin = req.user.id === getAdminId();
    const markup = getMarkup(isAdmin);

    let currentTokens = userSnap.data().tokens || 0;

    if (isAdmin) {
      try {
        currentTokens = await fetchAdminBalance();
      } catch (e) {
        console.error('Cek saldo admin gagal:', e.message);
      }
    }

    if (currentTokens <= 0) {
      return res.status(402).json({ error: 'Saldo habis (0). Silakan top-up terlebih dahulu.' });
    }

    const config = loadModelsConfig();
    const kurs = config.usdToIdr || 18000;
    const modelInfo = config.data.find(m => m.modelId === modelId);

    if (!modelInfo) {
      return res.status(400).json({ error: 'Model AI tidak valid' });
    }

    let convRef = conversationId
      ? db.collection('conversations').doc(conversationId)
      : db.collection('conversations').doc();

    let existingMessages = [];
    let isNewConversation = true;

    if (conversationId) {
      const convSnap = await convRef.get();
      if (convSnap.exists && convSnap.data().userId === req.user.id) {
        existingMessages = convSnap.data().messages || [];
        isNewConversation = false;
      }
    }

    const contextMessages = existingMessages.slice(-12).map(m => ({
      role: m.role === 'ai' ? 'assistant' : 'user',
      content: m.text
    }));
    contextMessages.push({ role: 'user', content: prompt });

    const apiRes = await axios.post(
      process.env.AI_API_URL,
      {
        model: modelInfo.modelId,
        messages: contextMessages
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.AI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const reply = apiRes.data.choices[0].message.content;
    const usage = apiRes.data.usage || { prompt_tokens: 200, completion_tokens: 300 };

    const inputCostIdr = (usage.prompt_tokens / 1_000_000) * (modelInfo.inputPrice * markup) * kurs;
    const outputCostIdr = (usage.completion_tokens / 1_000_000) * (modelInfo.outputPrice * markup) * kurs;
    const totalCharged = Number(Math.max(0.01, inputCostIdr + outputCostIdr).toFixed(2));

    let remainingTokens = 0;

    if (isAdmin) {
      try {
        remainingTokens = Number((await fetchAdminBalance()).toFixed(2));
      } catch (e) {
        remainingTokens = Math.max(0, Number((currentTokens - totalCharged).toFixed(2)));
      }
    } else {
      await userRef.update({
        tokens: FieldValue.increment(-totalCharged)
      });

      try {
        await db.collection('transactions').add({
          userId: req.user.id,
          type: 'debit',
          amount: totalCharged,
          description: `Chat ${modelInfo.name}`,
          createdAt: new Date().toISOString()
        });
      } catch (txErr) {
        console.error('Gagal mencatat transaksi debit:', txErr.message);
      }

      const updatedSnap = await userRef.get();
      const rawRemaining = updatedSnap.data().tokens || 0;
      remainingTokens = Math.max(0, Number(rawRemaining.toFixed(2)));

      if (rawRemaining < 0) {
        await userRef.update({ tokens: 0 });
      }
    }

    const nowIso = new Date().toISOString();
    const metaText = `${modelInfo.name} • In: ${usage.prompt_tokens} tok, Out: ${usage.completion_tokens} tok • Biaya: Rp ${totalCharged.toLocaleString('id-ID')}`;

    const newMessages = [
      ...existingMessages,
      { role: 'user', text: prompt, timestamp: nowIso },
      { role: 'ai', text: reply, meta: metaText, timestamp: nowIso }
    ];

    const autoTitle = prompt.length > 42 ? prompt.slice(0, 42) + '...' : prompt;

    if (isNewConversation) {
      await convRef.set({
        userId: req.user.id,
        title: autoTitle,
        modelId: modelInfo.modelId,
        messages: newMessages,
        createdAt: nowIso,
        updatedAt: nowIso
      });
    } else {
      await convRef.update({
        modelId: modelInfo.modelId,
        messages: newMessages,
        updatedAt: nowIso
      });
    }

    res.json({
      conversationId: convRef.id,
      conversationTitle: isNewConversation ? autoTitle : undefined,
      reply,
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        charged: totalCharged
      },
      remainingTokens
    });
  } catch (err) {
    console.error('AI Chat Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Gagal memproses AI. Saldo tidak dipotong.' });
  }
});

module.exports = router;
