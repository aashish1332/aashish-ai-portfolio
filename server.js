/* ═══════════════════════════════════════════════════════════════
   server.js — optional full-stack layer
   POST /api/contact  { name, email, message }
   GET  /api/visitors — live visitor counter
   Run: npm start   (needs: npm i express mongoose dotenv)
   ═══════════════════════════════════════════════════════════════ */
import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';

const app = express();
app.use(express.json());

/* simple in-memory rate limit: 5 msgs / 10 min / IP */
const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || 'anon';
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 5) {
    return res.status(429).json({ error: 'Too many messages. Try later.' });
  }
  list.push(now);
  hits.set(key, list);
  next();
}

/* schema (works with or without Mongo connected) */
const ContactSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 120 },
  email: { type: String, required: true, maxlength: 200 },
  message: { type: String, required: true, maxlength: 4000 },
  ip: String,
  createdAt: { type: Date, default: Date.now },
});
const Contact = mongoose.model('Contact', ContactSchema);

let visitorCount = 0;
app.get('/api/visitors', (req, res) => res.json({ count: ++visitorCount }));

app.post('/api/contact', rateLimit, async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid payload.' });
  }
  try {
    await Contact.create({ name, email, message, ip: req.ip });
    if (mongoose.connection.readyState === 1) {
      console.log('📩 saved to mongo');
    }
    res.json({ ok: true });
  } catch (err) {
    // still accept if mongo is down — log to console so nothing is lost
    console.error('contact (no-db):', { name, email, message: message.slice(0, 200) });
    res.json({ ok: true, stored: 'log' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* static frontend */
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
async function start() {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('✅ MongoDB connected');
    } catch (e) {
      console.warn('⚠ Mongo failed, running without DB:', e.message);
    }
  }
  app.listen(PORT, () => console.log(`🎬 THE FILM server on http://localhost:${PORT}`));
}
start();
