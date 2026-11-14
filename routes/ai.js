const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db, FieldValue } = require('../utils/firebase');
const { authMiddleware } = require('./auth');
const { logTransaction } = require('../utils/transactions');

const MARKUP_3_PERSEN = 1;

const ALLOWED_CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.json', '.xml', '.yaml', '.yml', '.sql', '.php', '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.cs',
  '.go', '.rs', '.rb', '.swift', '.kt', '.kts', '.dart',
  '.lua', '.r', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.vue', '.svelte', '.astro', '.env', '.toml', '.ini', '.cfg', '.conf',
  '.gradle', '.md', '.txt'
]);

function isAllowedCodeFile(fileName, mimeType = '') {
  const lowerMime = String(mimeType || '').toLowerCase();
  if (
    lowerMime.startsWith('image/') ||
    lowerMime.startsWith('video/') ||
    lowerMime.startsWith('audio/')
  ) {
    return false;
  }

  const baseName = path.basename(String(fileName || '')).toLowerCase();
  if (!baseName) return false;
  if (baseName === 'dockerfile' || baseName === 'makefile') return true;

  const ext = path.extname(baseName);
  return ALLOWED_CODE_EXTENSIONS.has(ext);
}

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

  if (attachment) {
    if (
      attachment.type === 'image' ||
      attachment.type === 'video' ||
      !isAllowedCodeFile(attachment.name, attachment.mimeType)
    ) {
      return res.status(400).json({
        error: 'Hanya file codingan yang dapat diupload (foto dan video tidak diperbolehkan).'
      });
    }
  }

  const userRef = db.collection('users').doc(req.user.id);
  const adminId = process.env.ADMIN_USER_ID;
  const isAdmin = !!adminId && req.user.id === adminId;

  let preCharge = 0;
  let preChargeDeducted = false;
  let finalSettled = false;
  let initialUserTokens = 0;

  try {
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

    const systemFileInstruction = {
      role: 'system',
      content:
        'Jika pengguna meminta untuk membuatkan atau mengirimkan file (misalnya file codingan, teks, JSON, HTML, CSS, SQL, Markdown, dll.), sertakan seluruh isi file tersebut di dalam blok kode markdown dengan format ```bahasa:namafile.ekstensi (contoh: ```javascript:index.js atau ```python:app.py atau ```txt:catatan.txt) agar sistem dapat menampilkan tombol unduh file secara otomatis.'
    };

    const historyMessages = existingMessages.slice(-12).map(m => ({
      role: m.role === 'ai' ? 'assistant' : 'user',
      content: m.text
    }));

    const contextMessages = [systemFileInstruction, ...historyMessages];

    // Susun pesan user (teks biasa atau teks + file codingan lampiran)
    let userMessageForApi;
    let savedUserText = cleanPrompt;

    if (attachment && attachment.name) {
      const fileLabel = `[Lampiran: ${attachment.name}]`; savedUserText = cleanPrompt ? `${fileLabel}\n${cleanPrompt}` : fileLabel;  if (attachment.type === 'text' && typeof attachment.content === 'string') { const truncatedContent = attachment.content.slice(0, 60000); const combinedText = `${cleanPrompt || 'Tolong analisis isi file codingan berikut:'}\n\n--- Isi File: ${attachment.name} ---\n${truncatedContent}\n--- Akhir File ---`;
        userMessageForApi = {
          role: 'user',
          content: combinedText
        };
      } else {
        return res.status(400).json({
          error: 'Format lampiran tidak valid. Hanya file codingan berbasis teks yang didukung.'
        });
      }
    } else {
      userMessageForApi = { role: 'user', content: cleanPrompt };
    }

    contextMessages.push(userMessageForApi);

    // Estimasi biaya awal & potong saldo SEGERA setelah user mengirim pesan
    const totalContextChars = contextMessages.reduce(
      (sum, msg) => sum + String(msg.content || '').length,
      0
    );
    const estimatedInputTokens = Math.max(1, Math.ceil(totalContextChars / 4));
    const estimatedInputCostIdr =
      (estimatedInputTokens / 1_000_000) * (modelInfo.inputPrice * MARKUP_3_PERSEN) * kurs;
    preCharge = Number(Math.max(0.01, estimatedInputCostIdr).toFixed(2));

    let currentTokens = 0;

    if (isAdmin) {
      const userSnap = await userRef.get();
      if (!userSnap.exists) return res.status(404).json({ error: 'User tidak ditemukan' });

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

      if (currentTokens <= 0 || currentTokens < preCharge) {
        return res.status(402).json({
          error: 'Saldo tidak mencukupi. Silakan top-up terlebih dahulu.'
        });
      }
    } else {
      try {
        await db.runTransaction(async (t) => {
          const snap = await t.get(userRef);
          if (!snap.exists) {
            throw new Error('USER_NOT_FOUND');
          }

          const latestTokens = Number(snap.data().tokens || 0);
          initialUserTokens = latestTokens;

          if (latestTokens <= 0 || latestTokens < preCharge) {
            throw new Error('INSUFFICIENT_BALANCE');
          }

          const afterPreCharge = Number((latestTokens - preCharge).toFixed(2));
          t.update(userRef, { tokens: afterPreCharge });
        });

        preChargeDeducted = true;
        currentTokens = initialUserTokens;
      } catch (txErr) {
        if (txErr.message === 'USER_NOT_FOUND') {
          return res.status(404).json({ error: 'User tidak ditemukan' });
        }
        if (txErr.message === 'INSUFFICIENT_BALANCE') {
          return res.status(402).json({
            error: 'Saldo tidak mencukupi untuk mengirim pesan ini. Silakan top-up terlebih dahulu.',
            remainingTokens: Math.max(0, Number(initialUserTokens.toFixed(2)))
          });
        }
        throw txErr;
      }
    }

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
    } catch (apiErr) {
      // Fallback jika ada model tertentu yang menolak role 'system'
      if (apiErr.response?.status === 400) {
        const fallbackMessages = [...historyMessages, userMessageForApi];
        apiRes = await axios.post(
          process.env.AI_API_URL,
          {
            model: modelInfo.modelId,
            messages: fallbackMessages
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' } } ); } else { throw apiErr; } }  const reply = apiRes.data.choices[0].message.content; const usage = apiRes.data.usage \vert{}\vert{} { prompt_tokens: 200, completion_tokens: 300 };  const inputCostIdr = (usage.prompt_tokens / 1_000_000) * (modelInfo.inputPrice * MARKUP_3_PERSEN) * kurs; const outputCostIdr = (usage.completion_tokens / 1_000_000) * (modelInfo.outputPrice * MARKUP_3_PERSEN) * kurs; const totalCharged = Number(Math.max(0.01, inputCostIdr + outputCostIdr).toFixed(2));  let remainingTokens = 0;  if (isAdmin) { try { const billingUrl = process.env.BILLING_API_URL \vert{}\vert{} 'https://iwiw.nekoganz.my.id/balance'; const billingKey = process.env.BILLING_API_KEY \vert{}\vert{} 'testing'; const afterRes = await axios.get(billingUrl, { headers: { 'x-api-key': billingKey } }); remainingTokens = Number(Number(afterRes.data.balance \vert{}\vert{} 0).toFixed(2)); } catch (e) { remainingTokens = Math.max(0, Number((currentTokens - totalCharged).toFixed(2))); } } else { // Jika setelah dihitung saldo awal user kurang dari total biaya respon AI, batalkan & jangan kirim respon AI if (initialUserTokens < totalCharged) { await userRef.update({ tokens: FieldValue.increment(preCharge) }); finalSettled = true;  return res.status(402).json({ error: 'Saldo tidak mencukupi untuk mendapatkan respon AI. Silakan top-up terlebih dahulu.', remainingTokens: Math.max(0, Number(initialUserTokens.toFixed(2))) }); }  const diffCharge = Number((totalCharged - preCharge).toFixed(2)); if (diffCharge !== 0) { await userRef.update({ tokens: FieldValue.increment(-diffCharge) }); }  await logTransaction( req.user.id, 'debit', totalCharged, `Chat ${modelInfo.name}`
      );

      const updatedSnap = await userRef.get();
      const rawRemaining = updatedSnap.data().tokens || 0;
      remainingTokens = Math.max(0, Number(rawRemaining.toFixed(2)));

      if (rawRemaining < 0) {
        await userRef.update({ tokens: 0 });
      }
      finalSettled = true;
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
    if (preChargeDeducted && !finalSettled && !isAdmin) {
      try {
        await userRef.update({
          tokens: FieldValue.increment(preCharge)
        });
      } catch (refundErr) {
        console.error('Gagal refund saldo pre-charge:', refundErr.message);
      }
    }

    console.error('AI Chat Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Gagal memproses AI. Saldo tidak dipotong.' });
  }
});

module.exports = router;
