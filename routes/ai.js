const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db, FieldValue } = require('../utils/firebase');
const { authMiddleware } = require('./auth');
const { logTransaction } = require('../utils/transactions');

const MARKUP_3_PERSEN = 1;
const MAX_FILES_PER_MESSAGE = 10;
const MAX_SINGLE_FILE_CHARS = 60000;
const MAX_TOTAL_FILES_CHARS = 120000;

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

function parseSkillMarkdown(rawContent, fallbackName) {
  const text = String(rawContent || '').replace(/\r\n/g, '\n');
  let name = fallbackName;
  let description = 'Custom AI skill';
  let body = text.trim();

  if (text.startsWith('---\n')) {
    const endIdx = text.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const frontmatter = text.slice(4, endIdx);
      body = text.slice(endIdx + 5).trim();

      frontmatter.split('\n').forEach(line => {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim().toLowerCase();
          let val = line.slice(colonIdx + 1).trim();
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1);
          }
          if (key === 'name' && val) name = val;
          if (key === 'description' && val) description = val;
        }
      });
    }
  }

  return { name, description, instructions: body };
}

// Memindai struktur folder skills/<namaskills>/SKILL.md
function loadAvailableSkills() {
  const skillsDir = path.join(__dirname, '../skills');
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillFilePath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFilePath)) continue;

    const raw = fs.readFileSync(skillFilePath, 'utf-8');
    const parsed = parseSkillMarkdown(raw, entry.name);
    if (parsed.instructions) {
      skills.push({
        id: entry.name,
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions
      });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

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

router.get('/skills', authMiddleware, (req, res) => {
  try {
    const skills = loadAvailableSkills().map(s => ({
      id: s.id,
      name: s.name,
      description: s.description
    }));
    res.json({ success: true, skills });
  } catch (err) {
    console.error('Load Skills Error:', err);
    res.status(500).json({ error: 'Gagal memuat daftar skills' });
  }
});

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

router.post('/chat', authMiddleware, async (req, res) => {
  const { modelId, prompt, conversationId, attachment, attachments, skillIds, stream } = req.body;
  const cleanPrompt = String(prompt || '').trim();
  const isStreaming = stream === true;

  // Normalisasi lampiran (mendukung array multi-file maupun single attachment)
  const rawAttachments = Array.isArray(attachments)
    ? attachments
    : attachment
    ? [attachment]
    : [];

  if (!cleanPrompt && rawAttachments.length === 0) {
    return res.status(400).json({ error: 'Pesan atau lampiran file tidak boleh kosong.' });
  }

  if (rawAttachments.length > MAX_FILES_PER_MESSAGE) {
    return res.status(400).json({
      error: `Maksimal ${MAX_FILES_PER_MESSAGE} file codingan yang dapat dilampirkan dalam satu pesan.`
    });
  }

  const validAttachments = [];
  for (const item of rawAttachments) {
    if (
      !item ||
      !item.name ||
      item.type === 'image' ||
      item.type === 'video' ||
      !isAllowedCodeFile(item.name, item.mimeType)
    ) {
      return res.status(400).json({
        error: 'Hanya file codingan yang dapat diupload (foto, video, dan file non-coding tidak diperbolehkan).'
      });
    }

    if (item.type !== 'text' || typeof item.content !== 'string') {
      return res.status(400).json({
        error: `Format lampiran "${item.name}" tidak valid. Hanya file codingan berbasis teks yang didukung.`
      });
    }

    validAttachments.push({
      name: path.basename(String(item.name)),
      content: item.content
    });
  }

  const userRef = db.collection('users').doc(req.user.id);
  const adminId = process.env.ADMIN_USER_ID;
  const isAdmin = !!adminId && req.user.id === adminId;

  let preCharge = 0;
  let preChargeDeducted = false;
  let finalSettled = false;
  let initialUserTokens = 0;
  let keepAliveTimer = null;

  const clearKeepAlive = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };

  const sendSse = (payload) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  try {
    const config = loadModelsConfig();
    const kurs = config.usdToIdr || 18000;
    const modelInfo = config.data.find(m => m.modelId === modelId);

    if (!modelInfo) {
      return res.status(400).json({ error: 'Model AI tidak valid' });
    }

    const requestedSkillIds = Array.isArray(skillIds)
      ? [...new Set(skillIds.map(id => String(id || '').trim()).filter(Boolean))]
      : [];

    const allSkills = requestedSkillIds.length > 0 ? loadAvailableSkills() : [];
    const activeSkills = requestedSkillIds
      .map(id => allSkills.find(s => s.id === id))
      .filter(Boolean);

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

    const baseFilePrompt =
      'Jika pengguna meminta untuk membuatkan atau mengirimkan file (misalnya file codingan, teks, JSON, HTML, CSS, SQL, Markdown, dll.), sertakan seluruh isi file tersebut di dalam blok kode markdown dengan format ```bahasa:namafile.ekstensi (contoh: ```javascript:index.js atau ```python:app.py atau ```txt:catatan.txt) agar sistem dapat menampilkan tombol unduh file secara otomatis.';

    let combinedSystemPrompt = baseFilePrompt;
    let skillPromptBlock = '';

    if (activeSkills.length > 0) {
      skillPromptBlock = activeSkills
        .map(s => `=== ACTIVE SKILL: ${s.name} ===\n${s.instructions}\n=== END SKILL: ${s.name} ===`)
        .join('\n\n');

      combinedSystemPrompt += `\n\nIkuti seluruh aturan dan instruksi dari ${activeSkills.length} skill aktif berikut secara bersamaan dan ketat:\n\n${skillPromptBlock}`;
    }

    const systemFileInstruction = {
      role: 'system',
      content: combinedSystemPrompt
    };

    const historyMessages = existingMessages.slice(-12).map(m => ({
      role: m.role === 'ai' ? 'assistant' : 'user',
      content: m.text
    }));

    const contextMessages = [systemFileInstruction, ...historyMessages];

    // Susun pesan user (teks biasa atau teks + multi-file codingan lampiran)
    let userMessageForApi;
    let savedUserText = cleanPrompt;

    if (validAttachments.length > 0) {
      const fileLabels = validAttachments.map(f => `[Lampiran: ${f.name}]`).join('\n');
      savedUserText = cleanPrompt ? `${fileLabels}\n${cleanPrompt}` : fileLabels;

      let remainingCharsBudget = MAX_TOTAL_FILES_CHARS;
      const formattedFileBlocks = validAttachments.map((file, idx) => {
        const allowedChars = Math.max(0, Math.min(MAX_SINGLE_FILE_CHARS, remainingCharsBudget));
        const sliced = file.content.slice(0, allowedChars);
        remainingCharsBudget -= sliced.length;

        const headerLabel = validAttachments.length > 1
          ? `File ${idx + 1}: ${file.name}`
          : `Isi File: ${file.name}`;
        const footerLabel = validAttachments.length > 1
          ? `Akhir File ${idx + 1}`
          : 'Akhir File';

        return `--- ${headerLabel} ---\n${sliced}\n--- ${footerLabel} ---`;
      });

      const defaultPromptText = validAttachments.length > 1
        ? `Tolong analisis ${validAttachments.length} file codingan berikut beserta keterkaitan antar-filenya:`
        : 'Tolong analisis isi file codingan berikut:';

      const combinedText = `${cleanPrompt || defaultPromptText}\n\n${formattedFileBlocks.join('\n\n')}`;
      userMessageForApi = {
        role: 'user',
        content: combinedText
      };
    } else {
      userMessageForApi = { role: 'user', content: cleanPrompt };
    }

    contextMessages.push(userMessageForApi);

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

    const fallbackUserMessage = skillPromptBlock
      ? {
          role: 'user',
          content: `Ikuti seluruh instruksi skill berikut:\n\n${skillPromptBlock}\n\n---\n\n${userMessageForApi.content}`
        }
      : userMessageForApi;

    const fallbackMessages = [...historyMessages, fallbackUserMessage];

    let reply = '';
    let usage = { prompt_tokens: estimatedInputTokens, completion_tokens: 0 };

    if (isStreaming) {
      // Mulai SSE setelah validasi dan preCharge saldo berhasil
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      // Jaga koneksi Cloudflare Tunnel tetap aktif (hindari idle timeout 100 detik / Error 524)
      res.on('close', clearKeepAlive);
      keepAliveTimer = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(': ping\n\n');
        }
      }, 15000);

      let upstreamStreamRes;
      try {
        upstreamStreamRes = await axios.post(
          process.env.AI_API_URL,
          {
            model: modelInfo.modelId,
            messages: contextMessages,
            stream: true,
            stream_options: { include_usage: true }
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.AI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            responseType: 'stream'
          }
        );
      } catch (streamInitErr) {
        if (streamInitErr.response?.status === 400) {
          // Fallback jika provider menolak stream_options atau role 'system'
          upstreamStreamRes = await axios.post(
            process.env.AI_API_URL,
            {
              model: modelInfo.modelId,
              messages: fallbackMessages,
              stream: true
            },
            {
              headers: {
                'Authorization': `Bearer ${process.env.AI_API_KEY}`,
                'Content-Type': 'application/json'
              },
              responseType: 'stream'
            }
          );
        } else {
          throw streamInitErr;
        }
      }

      let streamUsage = null;

      await new Promise((resolve, reject) => {
        let sseBuffer = '';

        upstreamStreamRes.data.on('data', (chunk) => {
          sseBuffer += chunk.toString('utf-8');
          const lines = sseBuffer.split(/\r?\n/);
          sseBuffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith('data:')) continue;

            const dataStr = line.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.error) {
                reject(new Error(parsed.error.message || 'Upstream AI stream error'));
                return;
              }
              if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number') {
                streamUsage = parsed.usage;
              }
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                reply += delta;
                sendSse({ type: 'chunk', content: delta });
              }
            } catch (_) {
              // Abaikan potongan JSON non-kritikal
            }
          }
        });

        upstreamStreamRes.data.on('end', () => {
          if (sseBuffer.trim().startsWith('data:')) {
            const tailStr = sseBuffer.trim().slice(5).trim();
            if (tailStr && tailStr !== '[DONE]') {
              try {
                const parsedTail = JSON.parse(tailStr);
                if (parsedTail.usage && typeof parsedTail.usage.prompt_tokens === 'number') {
                  streamUsage = parsedTail.usage;
                }
                const tailDelta = parsedTail.choices?.[0]?.delta?.content;
                if (typeof tailDelta === 'string' && tailDelta.length > 0) {
                  reply += tailDelta;
                  sendSse({ type: 'chunk', content: tailDelta });
                }
              } catch (_) {}
            }
          }
          resolve();
        });

        upstreamStreamRes.data.on('error', reject);
      });

      if (!reply) {
        throw new Error('Respons stream kosong dari model AI.');
      }

      usage = {
        prompt_tokens:
          streamUsage && typeof streamUsage.prompt_tokens === 'number'
            ? streamUsage.prompt_tokens
            : estimatedInputTokens,
        completion_tokens:
          streamUsage && typeof streamUsage.completion_tokens === 'number'
            ? streamUsage.completion_tokens
            : Math.max(1, Math.ceil(reply.length / 4))
      };
    } else {
      // Mode non-streaming standar
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
        if (apiErr.response?.status === 400) {
          apiRes = await axios.post(
            process.env.AI_API_URL,
            {
              model: modelInfo.modelId,
              messages: fallbackMessages
            },
            {
              headers: {
                'Authorization': `Bearer ${process.env.AI_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
        } else {
          throw apiErr;
        }
      }

      reply = apiRes.data.choices[0].message.content;
      usage = apiRes.data.usage || { prompt_tokens: 200, completion_tokens: 300 };
    }

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
      if (initialUserTokens < totalCharged) {
        await userRef.update({ tokens: FieldValue.increment(preCharge) });
        finalSettled = true;

        const lowBalancePayload = {
          error: 'Saldo tidak mencukupi untuk mendapatkan respon AI. Silakan top-up terlebih dahulu.',
          remainingTokens: Math.max(0, Number(initialUserTokens.toFixed(2)))
        };

        if (isStreaming) {
          clearKeepAlive();
          sendSse({ type: 'error', ...lowBalancePayload });
          return res.end();
        }
        return res.status(402).json(lowBalancePayload);
      }

      const diffCharge = Number((totalCharged - preCharge).toFixed(2));
      if (diffCharge !== 0) {
        await userRef.update({ tokens: FieldValue.increment(-diffCharge) });
      }

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
      finalSettled = true;
    }

    const nowIso = new Date().toISOString();
    const activeSkillNames = activeSkills.map(s => s.name);
    const attachmentNames = validAttachments.map(f => f.name);
    const skillMetaPrefix = activeSkillNames.length > 0 ? `Skill: ${activeSkillNames.join(', ')} • ` : '';
    const metaText = `${skillMetaPrefix}${modelInfo.name} • In: ${usage.prompt_tokens} tok, Out: ${usage.completion_tokens} tok • Biaya: Rp ${totalCharged.toLocaleString('id-ID')}`;

    const newMessages = [
      ...existingMessages,
      {
        role: 'user',
        text: savedUserText,
        attachmentName: attachmentNames[0] || null,
        attachmentNames,
        skillNames: activeSkillNames,
        timestamp: nowIso
      },
      { role: 'ai', text: reply, meta: metaText, timestamp: nowIso }
    ];

    const rawTitleSource = cleanPrompt || (attachmentNames.length > 0 ? attachmentNames.join(', ') : 'Percakapan Baru');
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

    const finalPayload = {
      conversationId: convRef.id,
      conversationTitle: isNewConversation ? autoTitle : undefined,
      reply,
      meta: metaText,
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        charged: totalCharged
      },
      remainingTokens
    };

    if (isStreaming) {
      clearKeepAlive();
      sendSse({ type: 'done', ...finalPayload });
      return res.end();
    }

    res.json(finalPayload);
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

    if (res.headersSent) {
      clearKeepAlive();
      sendSse({ type: 'error', error: 'Gagal memproses AI. Saldo tidak dipotong.' });
      return res.end();
    }

    res.status(500).json({ error: 'Gagal memproses AI. Saldo tidak dipotong.' });
  } finally {
    clearKeepAlive();
  }
});

module.exports = router;
