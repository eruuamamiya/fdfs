const { db } = require('./firebase');

/**
 * Catat satu transaksi ke collection "transactions".
 *
 * @param {string} userId       ID dokumen user di collection "users"
 * @param {'credit'|'debit'} type  credit = saldo bertambah (top-up), debit = saldo berkurang (pemakaian)
 * @param {number} amount       Nominal dalam Rupiah (angka positif)
 * @param {string} description  Keterangan singkat, mis. "Top-Up via DOKU" / "Chat GPT-4o"
 */
async function logTransaction(userId, type, amount, description) {
  try {
    await db.collection('transactions').add({
      userId,
      type,
      amount: Number(amount) || 0,
      description: description || '-',
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    // Gagal mencatat riwayat tidak boleh menggagalkan top-up / chat
    console.error('Gagal mencatat transaksi:', err.message);
  }
}

module.exports = { logTransaction };
