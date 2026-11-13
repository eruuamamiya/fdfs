const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db, FieldValue } = require('../utils/firebase');
const { authMiddleware } = require('./auth');
const { logTransaction } = require('../utils/transactions');

const MARKUP_3_PERSEN = 1;

function loadModelsConfig() {
  const filePath = path.join(__dirname, '../config/models.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// 1. Katalog Model + Harga (per 1M token)
router.get('/models', authMiddleware, (req, res) => {
  const config = loadModelsConfig();
  const kurs = config.usdToIdr || 18000;

  const models = config.data.map(m => {
    const inputUsd1M = Number((m.inputPrice * MARKUP_3_PERSEN).toFixed(4));
    const outputUsd1M = Number((m.outputPrice * MARKUP_3_PERSEN).toFixed(4));
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

// 5. Chat AI + Lampiran File + Simpan Otomatis ke History Percakapan
router.post('/chat', authMiddleware, async (req, res) => {
  const { modelId, prompt, conversationId, attachment } = req.body;
  const cleanPrompt = String(prompt || '').trim();

  if (!cleanPrompt && !attachment) {
    return res.status(400).json({ error: 'Pesan atau lampiran file tidak boleh kosong.' });
  }

  try {
    const userRef = db.collection('users').doc(req.user.id);
    const userSnap = await userRef.get();

    if (!userSnap.exists) return res.status(404).json({ error: 'User tidak ditemukan' });

    // ID admin HARUS diset lewat environment variable (ADMIN_USER_ID), sama seperti di auth.js
    const adminId = process.env.ADMIN_USER_ID;
    const isAdmin = !!adminId && req.user.id === adminId;

    let currentTokens = userSnap.data().tokens || 0;

    if (isAdmin) {
      try {
        const billingUrl = process.env.BILLING_API_URL || 'https://iwiw.nekoganz.my.id/balance';
        const billingKey = process.env.BILLING_API_KEY || 'testing';
        const bRes = await axios.get(billingUrl, {
          headers: { 'x-api-key': billingKey }
        });
        currentTokens = Number(bRes.data.balance || 0);
      } catch (e) {
        console.error('Cek saldo billing gagal:', e.message);
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

    // Susun pesan user (teks biasa atau teks + file lampiran)
    let userMessageForApi;
    let savedUserText = cleanPrompt;

    if (attachment && attachment.name) {
      const fileLabel = `[Lampiran: ${attachment.name}]`;
      savedUserText = cleanPrompt ? `${fileLabel}\n${cleanPrompt}` : fileLabel;

      if (attachment.type === 'image' && attachment.dataUrl) {
        const textPart = cleanPrompt || 'Tolong analisis dan jelaskan isi gambar terlampir ini.';
        userMessageForApi = {
          role: 'user',
          content: [
            { type: 'text', text: textPart },
            { type: 'image_url', image_url: { url: attachment.dataUrl } }
          ]
        };
      } else if (attachment.type === 'text' && typeof attachment.content === 'string') {
        const truncatedContent = attachment.content.slice(0, 60000);
        const combinedText = `${cleanPrompt || 'Tolong analisis isi file berikut:'}\n\n--- Isi File: ${attachment.name} ---\n${truncatedContent}\n--- Akhir File ---`;
        userMessageForApi = {
          role: 'user',
          content: combinedText
        };
      } else {
        userMessageForApi = {
          role: 'user',
          content: `${savedUserText}\n(Catatan: file biner ${attachment.mimeType || 'dokumen'} dilampirkan oleh user)`
        };
      }
    } else {
      userMessageForApi = { role: 'user', content: cleanPrompt };
    }

    contextMessages.push(userMessageForApi);

    let apiRes;
    try {
      apiRes = await axios.post(
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
    } catch (firstErr) {
      // Fallback jika model yang dipilih tidak mendukung payload gambar multimodal
      if (attachment && attachment.type === 'image') {
        contextMessages[contextMessages.length - 1] = {
          role: 'user',
          content: `${cleanPrompt || 'Tolong bantu saya.'}\n(User melampirkan file gambar bernama "${attachment.name}", namun model ini hanya menerima input teks.)`
        };
        apiRes = await axios.post(
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
      } else {
        throw firstErr;
      }
    }

    const reply = apiRes.data.choices[0].message.content;
    const usage = apiRes.data.usage || { prompt_tokens: 200, completion_tokens: 300 };

    const inputCostIdr = (usage.prompt_tokens / 1_000_000) * (modelInfo.inputPrice * MARKUP_3_PERSEN) * kurs;
    const outputCostIdr = (usage.completion_tokens / 1_000_000) * (modelInfo.outputPrice * MARKUP_3_PERSEN) * kurs;
    const totalCharged = Number(Math.max(0.01, inputCostIdr + outputCostIdr).toFixed(2));

    let remainingTokens = 0;

    if (isAdmin) {
      try {
        const billingUrl = process.env.BILLING_API_URL || 'https://iwiw.nekoganz.my.id/balance';
        const billingKey = process.env.BILLING_API_KEY || 'testing';
        const afterRes = await axios.get(billingUrl, {
          headers: { 'x-api-key': billingKey }
        });
        remainingTokens = Number(Number(afterRes.data.balance || 0).toFixed(2));
      } catch (e) {
        remainingTokens = Math.max(0, Number((currentTokens - totalCharged).toFixed(2)));
      }
    } else {
      await userRef.update({
        tokens: FieldValue.increment(-totalCharged)
      });

      await logTransaction(
        req.user.id,
        'debit',
        totalCharged,
        `Chat ${modelInfo.name}`
      );

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
      {
        role: 'user',
        text: savedUserText,
        attachmentName: attachment ? attachment.name : null,
        timestamp: nowIso
      },
      { role: 'ai', text: reply, meta: metaText, timestamp: nowIso }
    ];

    const rawTitleSource = cleanPrompt || (attachment ? attachment.name : 'Percakapan Baru');
    const autoTitle = rawTitleSource.length > 42 ? rawTitleSource.slice(0, 42) + '...' : rawTitleSource;

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
