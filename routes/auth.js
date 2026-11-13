const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../utils/firebase');

function generateRecoveryCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Middleware Verifikasi JWT
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token tidak ditemukan. Silakan login kembali.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesi berakhir. Silakan login kembali.' });
  }
}

// 1. Register Akun Baru
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Semua kolom wajib diisi' });
  }

  try {
    const existing = await db.collection('users').where('email', '==', email).get();
    if (!existing.empty) {
      return res.status(400).json({ error: 'Email sudah terdaftar' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const recoveryCode = generateRecoveryCode();

    const newUserRef = await db.collection('users').add({
      username,
      email,
      password: hashedPassword,
      recoveryCode,
      tokens: 0,
      createdAt: new Date().toISOString()
    });

    const token = jwt.sign(
      { id: newUserRef.id, email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      recoveryCode,
      user: { id: newUserRef.id, username, email, tokens: 0, recoveryCode }
    });
  } catch (err) {
    console.error('Register Error:', err);
    res.status(500).json({ error: 'Gagal mendaftarkan akun' });
  }
});

// 2. Login Akun
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email dan password wajib diisi' });
  }

  try {
    const snap = await db.collection('users').where('email', '==', email).get();
    if (snap.empty) {
      return res.status(401).json({ error: 'Email atau password salah' });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Email atau password salah' });
    }

    const token = jwt.sign(
      { id: userDoc.id, email: userData.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: userDoc.id,
        username: userData.username,
        email: userData.email,
        tokens: userData.tokens || 0
      }
    });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: 'Gagal login' });
  }
});

// 3. Cek Profil & Saldo User
//    - Admin: saldo + transaksi real-time dari https://iwiw.nekoganz.my.id/balance
//    - User biasa: saldo dari Firestore + riwayat transaksi milik sendiri
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.user.id);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User tidak ditemukan' });
    }

    const userData = userDoc.data();

    // Pastikan akun lama otomatis memiliki recoveryCode
    let recoveryCode = userData.recoveryCode;
    if (!recoveryCode) {
      recoveryCode = generateRecoveryCode();
      await userRef.update({ recoveryCode });
    }

    // ID admin HARUS diset lewat environment variable (ADMIN_USER_ID)
    const adminId = process.env.ADMIN_USER_ID;
    const isAdmin = !!adminId && req.user.id === adminId;

    let currentTokens = userData.tokens || 0;
    let recentTransactions = [];

    if (isAdmin) {
      try {
        const billingUrl = process.env.BILLING_API_URL || 'https://iwiw.nekoganz.my.id/balance';
        const billingKey = process.env.BILLING_API_KEY || 'testing';

        const billingRes = await axios.get(billingUrl, {
          headers: {
            'x-api-key': billingKey
          }
        });
        currentTokens = Number(billingRes.data.balance || 0);
        recentTransactions = billingRes.data.recentTransactions || [];
      } catch (billingErr) {
        console.error('Gagal mengambil billing admin:', billingErr.response?.data || billingErr.message);
      }
    } else {
      // Riwayat transaksi milik user ini saja (difilter berdasarkan userId dari token)
      try {
        const txSnap = await db.collection('transactions')
          .where('userId', '==', req.user.id)
          .orderBy('createdAt', 'desc')
          .limit(20)
          .get();

        recentTransactions = txSnap.docs.map(d => {
          const t = d.data();
          return {
            description: t.description || '-',
            createdAt: t.createdAt,
            type: t.type,
            amount: t.amount
          };
        });
      } catch (txErr) {
        console.error('Gagal mengambil riwayat transaksi user:', txErr.message);
      }
    }

    res.json({
      success: true,
      user: {
        id: req.user.id,
        username: userData.username,
        email: userData.email,
        recoveryCode,
        tokens: currentTokens,
        isAdmin,
        recentTransactions
      }
    });
  } catch (err) {
    console.error('Auth /me Error:', err);
    res.status(500).json({ error: 'Gagal memuat profil user' });
  }
});

// 4. Update Nama / Username Profil
router.put('/profile', authMiddleware, async (req, res) => {
  const newUsername = String(req.body.username || '').trim();
  if (!newUsername) {
    return res.status(400).json({ error: 'Nama tidak boleh kosong' });
  }
  if (newUsername.length < 2 || newUsername.length > 40) {
    return res.status(400).json({ error: 'Nama harus antara 2 sampai 40 karakter' });
  }

  try {
    await db.collection('users').doc(req.user.id).update({
      username: newUsername,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      username: newUsername
    });
  } catch (err) {
    console.error('Update Profile Error:', err);
    res.status(500).json({ error: 'Gagal memperbarui nama profil' });
  }
});

// 5. Generate Ulang Kode Pemulihan Password (dari Halaman Profil)
router.post('/regenerate-recovery-code', authMiddleware, async (req, res) => {
  try {
    const newCode = generateRecoveryCode();
    await db.collection('users').doc(req.user.id).update({
      recoveryCode: newCode,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      recoveryCode: newCode
    });
  } catch (err) {
    console.error('Regenerate Recovery Code Error:', err);
    res.status(500).json({ error: 'Gagal membuat ulang kode pemulihan' });
  }
});

// 6. Reset Password (Lupa Password menggunakan Email + Kode Pemulihan)
router.post('/reset-password', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const recoveryCode = String(req.body.recoveryCode || '').trim().toUpperCase();
  const newPassword = String(req.body.newPassword || '');

  if (!email || !recoveryCode || !newPassword) {
    return res.status(400).json({ error: 'Email, kode pemulihan, dan password baru wajib diisi' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  }

  try {
    const snap = await db.collection('users').where('email', '==', email).get();
    if (snap.empty) {
      return res.status(400).json({ error: 'Email atau kode pemulihan tidak cocok' });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    if (!userData.recoveryCode || userData.recoveryCode.toUpperCase() !== recoveryCode) {
      return res.status(400).json({ error: 'Email atau kode pemulihan tidak cocok' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const nextRecoveryCode = generateRecoveryCode();

    await userDoc.ref.update({
      password: hashedPassword,
      recoveryCode: nextRecoveryCode,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      newRecoveryCode: nextRecoveryCode,
      message: 'Password berhasil direset. Silakan masuk dengan password baru.'
    });
  } catch (err) {
    console.error('Reset Password Error:', err);
    res.status(500).json({ error: 'Gagal mereset password' });
  }
});

// Ekspor router langsung agar kompatibel dengan app.use('/api/auth', ...) sekaligus menyimpan authMiddleware
router.authMiddleware = authMiddleware;
module.exports = router;
