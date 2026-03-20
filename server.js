require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mercadopago = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 10000;

mercadopago.configure({
    access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
});
console.log('💳 Mercado Pago configurado');

const dbConfig = {
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
  ssl: { rejectUnauthorized: false }
};

const pool = new Pool(dbConfig);

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erro ao conectar ao PostgreSQL:', err.stack);
  } else {
    console.log('✅ Conectado ao PostgreSQL');
    release();
  }
});

app.use(helmet());
app.use(morgan('combined'));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      success: true,
      timestamp: result.rows[0].now,
      message: 'Conexão com banco de dados OK!'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, phone, credits_balance, role, status) 
       VALUES ($1, $2, $3, $4, 0, $5, $6) 
       RETURNING id, name, email, phone, credits_balance, role`,
      [name, email, password_hash, phone || null, 'user', 'active']
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ user, token, message: 'Usuário criado com sucesso!' });
  } catch (error) {
    console.error('Erro no registro:', error);
    res.status(500).json({ error: 'Erro ao criar usuário', details: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    delete user.password_hash;
    res.json({ user, token, message: 'Login realizado com sucesso!' });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro ao fazer login', details: error.message });
  }
});

app.get('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, credits_balance, role, status, created_at 
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({ error: 'Erro ao buscar perfil', details: error.message });
  }
});

const PACKAGES = {
  basico: { id: 'basico', name: '5.000 Créditos', credits: 5000, price: 700, discount: 0 },
  popular: { id: 'popular', name: '10.000 Créditos', credits: 10000, price: 1300, discount: 7 },
  melhor: { id: 'melhor', name: '20.000 Créditos', credits: 20000, price: 2400, discount: 14 },
  empresarial: { id: 'empresarial', name: '50.000 Créditos', credits: 50000, price: 5500, discount: 21 }
};

app.post('/api/payment/create-preference', authMiddleware, async (req, res) => {
  try {
    const { package_id } = req.body;
    const pkg = PACKAGES[package_id];
    if (!pkg) {
      return res.status(400).json({ error: 'Pacote inválido' });
    }
    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    const user = userResult.rows[0];
    const finalPrice = pkg.price;
    const external_reference = `LP-${user.id}-${Date.now()}`;
    await pool.query(
      'INSERT INTO transactions (user_id, external_reference, status, package_id, credits, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [user.id, external_reference, 'pending', package_id, pkg.credits, finalPrice]
    );
    const preference = {
      items: [{
        id: package_id,
        title: pkg.name,
        description: `${pkg.credits.toLocaleString('pt-BR')} créditos para exportar leads`,
        quantity: 1,
        unit_price: finalPrice,
        currency_id: 'BRL',
        picture_url: `${process.env.FRONTEND_URL}/images/logo.png`
      }],
      external_reference: external_reference,
      back_urls: {
        success: `${process.env.FRONTEND_URL}/dashboard.html?payment=success`,
        failure: `${process.env.FRONTEND_URL}/dashboard.html?payment=failure`,
        pending: `${process.env.FRONTEND_URL}/dashboard.html?payment=pending`
      },
      auto_return: 'approved',
      notification_url: `https://leadsparatodos-backend-production.up.railway.app/api/payment/webhook`,
      statement_descriptor: 'LEADSPARATODOS',
      expires: false,
      binary_mode: false
    };
    console.log('🔧 Criando preferência:', preference);
    const response = await mercadopago.preferences.create(preference);
    await pool.query(
      'UPDATE transactions SET preference_id = $1 WHERE external_reference = $2',
      [response.body.id, external_reference]
    );
    console.log('✅ Preferência criada:', response.body.id);
    console.log('🔗 Init point:', response.body.init_point);
    res.json({
      preference_id: response.body.id,
      init_point: response.body.init_point,
      sandbox_init_point: response.body.sandbox_init_point,
      external_reference: external_reference
    });
  } catch (error) {
    console.error('❌ Erro ao criar preferência:', error);
    res.status(500).json({
      error: 'Erro ao criar pagamento',
      details: error.message,
      response: error.response?.body || null
    });
  }
});

app.post('/api/payment/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('📬 Webhook recebido:', type, data);
    res.sendStatus(200);
    if (type === 'payment') {
      const payment_id = data.id;
      const payment = await mercadopago.payment.findById(payment_id);
      const paymentData = payment.body;
      console.log('💳 Pagamento:', paymentData.status, paymentData.external_reference);
      if (paymentData.status === 'approved') {
        const external_reference = paymentData.external_reference;
        const transResult = await pool.query('SELECT * FROM transactions WHERE external_reference = $1', [external_reference]);
        if (transResult.rows.length > 0) {
          const transaction = transResult.rows[0];
          if (transaction.status !== 'approved') {
            await pool.query('UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2', [transaction.credits, transaction.user_id]);
            await pool.query(
              `UPDATE transactions SET status = $1, payment_id = $2, payment_method = $3, payment_type = $4, payer_email = $5, approved_at = NOW(), updated_at = NOW() WHERE id = $6`,
              ['approved', payment_id, paymentData.payment_method_id, paymentData.payment_type_id, paymentData.payer.email, transaction.id]
            );
            console.log(`✅ Créditos adicionados: ${transaction.credits} para usuário ${transaction.user_id}`);
          } else {
            console.log('⚠️ Transação já foi processada anteriormente');
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Erro no webhook:', error);
  }
});

app.get('/api/payment/status/:reference', authMiddleware, async (req, res) => {
  try {
    const { reference } = req.params;
    const result = await pool.query('SELECT * FROM transactions WHERE external_reference = $1 AND user_id = $2', [reference, req.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transação não encontrada' });
    }
    res.json({ transaction: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao consultar status:', error);
    res.status(500).json({ error: 'Erro ao consultar status', details: error.message });
  }
});

app.get('/api/payment/transactions', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, external_reference, status, package_id, credits, amount, payment_method, created_at, approved_at 
       FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json({ transactions: result.rows });
  } catch (error) {
    console.error('❌ Erro ao buscar transações:', error);
    res.status(500).json({ error: 'Erro ao buscar transações', details: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada', path: req.path, method: req.method });
});

app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({
    error: 'Erro interno do servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'não configurado'}`);
  console.log(`💳 Mercado Pago: ${process.env.MERCADOPAGO_ACCESS_TOKEN ? 'Configurado' : 'NÃO configurado'}`);
});
