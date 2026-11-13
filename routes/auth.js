const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { db } = require('../utils/firebase');

const BALANCE_URL = 'https://iwiw.nekoganz.my.id/balance';
const BALANCE_API_KEY = 'testing';

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
    const newUserRef = await db.collection('users').add({
      username,
      email,
      password: hashedPassword,
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
      user: { id: newUserRef.id, username, email, tokens: 0 }
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

// 3. Cek Profil & Saldo User (Admin ambil balance real-time dari API balance)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User tidak ditemukan' });
    }

    const userData = userDoc.data();
    const adminId = process.env.ADMIN_USER_ID || '0ber5EnCFolLxN0uxM6s';
    const isAdmin = req.user.id === adminId;

    let currentTokens = userData.tokens || 0;
    let recentTransactions = [];

    if (isAdmin) {
      try {
        const billingRes = await axios.get(BALANCE_URL, {
          headers: {
            'x-api-key': BALANCE_API_KEY
          }
        });
        currentTokens = Number(billingRes.data.balance || 0);
        recentTransactions = billingRes.data.recentTransactions || [];
      } catch (balanceErr) {
        console.error('Gagal mengambil balance admin:', balanceErr.response?.data || balanceErr.message);
      }
    }

    res.json({
      success: true,
      user: {
        id: req.user.id,
        username: userData.username,
        email: userData.email,
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

// Ekspor router langsung agar kompatibel dengan app.use('/api/auth', ...) sekaligus menyimpan authMiddleware
router.authMiddleware = authMiddleware;
module.exports = router;
