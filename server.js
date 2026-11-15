require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve /icon.png dari folder di luar public
app.get('/icon.png', (req, res) => {
  const candidates = [
    path.join(__dirname, 'src', 'icon.png'),
    path.join(__dirname, 'icon', 'icon.png'),
    path.join(__dirname, 'src', 'icon', 'icon.png')
  ];

  const iconFile = candidates.find(filePath => fs.existsSync(filePath));
  if (iconFile) {
    return res.sendFile(iconFile);
  }
  res.status(404).send('Icon tidak ditemukan');
});

// Routes
const authRoutes = require('./routes/auth');
const aiRoutes = require('./routes/ai');
const paymentRoutes = require('./routes/payment');

app.use('/api/auth', authRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/payment', paymentRoutes);

// Tangani error body parser (misal file terlalu besar) agar tetap membalas JSON
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Ukuran file dan konteks terlalu besar (maksimal 15 MB).'
    });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Format JSON tidak valid.' });
  }
  next(err);
});

// Fallback halaman utama
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server EruuBot berjalan di http://localhost:${PORT}`);
});
