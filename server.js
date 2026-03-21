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

// Middleware para admin
const adminMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    
    // Verificar se é admin
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [decoded.id]);
    if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
    }
    
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

// NOVO: Processar pagamento com cartão (Checkout Transparente/Bricks)
app.post('/api/payment/process-card', authMiddleware, async (req, res) => {
  try {
    const { package_id, payment_data } = req.body;

    console.log('💳 Recebendo pagamento:', package_id, payment_data);

    const pkg = PACKAGES[package_id];
    if (!pkg) {
      return res.status(400).json({ error: 'Pacote inválido' });
    }

    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = userResult.rows[0];
    const external_reference = `LP-${user.id}-${Date.now()}`;

    await pool.query(
      'INSERT INTO transactions (user_id, external_reference, status, package_id, credits, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [user.id, external_reference, 'pending', package_id, pkg.credits, pkg.price]
    );

    const payment = {
      transaction_amount: pkg.price,
      token: payment_data.token,
      description: `${pkg.name} - Leads para Todos`,
      installments: payment_data.installments,
      payment_method_id: payment_data.payment_method_id,
      issuer_id: payment_data.issuer_id,
      payer: {
        email: payment_data.payer.email,
        identification: {
          type: payment_data.payer.identification.type,
          number: payment_data.payer.identification.number
        }
      },
      external_reference: external_reference,
      notification_url: `https://leadsparatodos-backend-production.up.railway.app/api/payment/webhook`
    };

    console.log('🔧 Criando pagamento no Mercado Pago:', payment);

    const paymentResponse = await mercadopago.payment.create(payment);
    const paymentData = paymentResponse.body;

    console.log('✅ Pagamento criado:', paymentData.id, paymentData.status);

    if (paymentData.status === 'approved') {
      await pool.query('UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2', [pkg.credits, user.id]);
      await pool.query(
        `UPDATE transactions SET status = $1, payment_id = $2, payment_method = $3, approved_at = NOW(), updated_at = NOW() WHERE external_reference = $4`,
        ['approved', paymentData.id, paymentData.payment_method_id, external_reference]
      );
      console.log(`✅ Créditos adicionados: ${pkg.credits} para usuário ${user.id}`);
    } else {
      await pool.query(
        `UPDATE transactions SET status = $1, payment_id = $2, updated_at = NOW() WHERE external_reference = $3`,
        [paymentData.status, paymentData.id, external_reference]
      );
    }

    res.json({
      status: paymentData.status,
      status_detail: paymentData.status_detail,
      payment_id: paymentData.id,
      external_reference: external_reference,
      message: paymentData.status === 'approved' ? 'Pagamento aprovado!' : 'Pagamento processado'
    });

  } catch (error) {
    console.error('❌ Erro ao processar pagamento:', error);
    res.status(500).json({
      error: 'Erro ao processar pagamento',
      details: error.message,
      response: error.response?.body || null
    });
  }
});

// NOVO: Processar pagamento com Pix
app.post('/api/payment/process-pix', authMiddleware, async (req, res) => {
  try {
    const { package_id } = req.body;

    console.log('💰 Recebendo pagamento Pix:', package_id);

    const pkg = PACKAGES[package_id];
    if (!pkg) {
      return res.status(400).json({ error: 'Pacote inválido' });
    }

    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = userResult.rows[0];
    const external_reference = `LP-PIX-${user.id}-${Date.now()}`;

    await pool.query(
      'INSERT INTO transactions (user_id, external_reference, status, package_id, credits, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [user.id, external_reference, 'pending', package_id, pkg.credits, pkg.price]
    );

    const payment = {
      transaction_amount: pkg.price,
      description: `${pkg.name} - Leads para Todos`,
      payment_method_id: 'pix',
      payer: {
        email: user.email,
        first_name: user.name.split(' ')[0],
        last_name: user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0]
      },
      external_reference: external_reference,
      notification_url: `https://leadsparatodos-backend-production.up.railway.app/api/payment/webhook`
    };

    console.log('🔧 Criando pagamento Pix no Mercado Pago:', payment);

    const paymentResponse = await mercadopago.payment.create(payment);
    const paymentData = paymentResponse.body;

    console.log('✅ Pagamento Pix criado:', paymentData.id, paymentData.status);

    await pool.query(
      `UPDATE transactions SET payment_id = $1, status = $2, updated_at = NOW() WHERE external_reference = $3`,
      [paymentData.id, paymentData.status, external_reference]
    );

    res.json({
      payment_id: paymentData.id,
      status: paymentData.status,
      external_reference: external_reference,
      qr_code: paymentData.point_of_interaction.transaction_data.qr_code,
      qr_code_base64: paymentData.point_of_interaction.transaction_data.qr_code_base64,
      ticket_url: paymentData.point_of_interaction.transaction_data.ticket_url
    });

  } catch (error) {
    console.error('❌ Erro ao processar Pix:', error);
    res.status(500).json({
      error: 'Erro ao processar pagamento Pix',
      details: error.message,
      response: error.response?.body || null
    });
  }
});

// NOVO: Processar pagamento com Boleto
app.post('/api/payment/process-boleto', authMiddleware, async (req, res) => {
  try {
    const { package_id } = req.body;

    console.log('📄 Recebendo pagamento Boleto:', package_id);

    const pkg = PACKAGES[package_id];
    if (!pkg) {
      return res.status(400).json({ error: 'Pacote inválido' });
    }

    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = userResult.rows[0];
    const external_reference = `LP-BOLETO-${user.id}-${Date.now()}`;

    await pool.query(
      'INSERT INTO transactions (user_id, external_reference, status, package_id, credits, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [user.id, external_reference, 'pending', package_id, pkg.credits, pkg.price]
    );

    // Data de vencimento: 3 dias úteis
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 3);

    const payment = {
      transaction_amount: pkg.price,
      description: `${pkg.name} - Leads para Todos`,
      payment_method_id: 'bolbradesco',
      payer: {
        email: user.email,
        first_name: user.name.split(' ')[0],
        last_name: user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0]
      },
      external_reference: external_reference,
      notification_url: `https://leadsparatodos-backend-production.up.railway.app/api/payment/webhook`,
      date_of_expiration: expirationDate.toISOString()
    };

    console.log('🔧 Criando boleto no Mercado Pago:', payment);

    const paymentResponse = await mercadopago.payment.create(payment);
    const paymentData = paymentResponse.body;

    console.log('✅ Boleto criado:', paymentData.id, paymentData.status);

    await pool.query(
      `UPDATE transactions SET payment_id = $1, status = $2, updated_at = NOW() WHERE external_reference = $3`,
      [paymentData.id, paymentData.status, external_reference]
    );

    res.json({
      payment_id: paymentData.id,
      status: paymentData.status,
      external_reference: external_reference,
      external_resource_url: paymentData.transaction_details.external_resource_url,
      date_of_expiration: paymentData.date_of_expiration
    });

  } catch (error) {
    console.error('❌ Erro ao processar Boleto:', error);
    res.status(500).json({
      error: 'Erro ao processar boleto',
      details: error.message,
      response: error.response?.body || null
    });
  }
});

// Checkout Pro (mantido para compatibilidade)
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
    const response = await mercadopago.preferences.create(preference);
    await pool.query('UPDATE transactions SET preference_id = $1 WHERE external_reference = $2', [response.body.id, external_reference]);
    console.log('✅ Preferência criada:', response.body.id);
    res.json({
      preference_id: response.body.id,
      init_point: response.body.init_point,
      sandbox_init_point: response.body.sandbox_init_point,
      external_reference: external_reference
    });
  } catch (error) {
    console.error('❌ Erro ao criar preferência:', error);
    res.status(500).json({ error: 'Erro ao criar pagamento', details: error.message, response: error.response?.body || null });
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

// ========================================
// ROTAS DE ADMIN
// ========================================

// Dashboard do Admin - Estatísticas gerais
app.get('/api/admin/dashboard', adminMiddleware, async (req, res) => {
  try {
    // Total de usuários
    const usersCount = await pool.query('SELECT COUNT(*) as count FROM users');
    
    // Total de transações
    const transactionsCount = await pool.query('SELECT COUNT(*) as count FROM transactions');
    
    // Total de vendas (aprovadas)
    const totalSales = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total 
      FROM transactions 
      WHERE status = 'approved'
    `);
    
    // Créditos vendidos
    const creditsCount = await pool.query(`
      SELECT COALESCE(SUM(credits), 0) as total 
      FROM transactions 
      WHERE status = 'approved'
    `);
    
    // Vendas dos últimos 7 dias
    const salesByDay = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count,
        SUM(amount) as total
      FROM transactions
      WHERE status = 'approved' AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);
    
    // Transações pendentes
    const pendingTransactions = await pool.query(`
      SELECT COUNT(*) as count 
      FROM transactions 
      WHERE status = 'pending'
    `);

    res.json({
      users: {
        total: parseInt(usersCount.rows[0].count),
        active: parseInt(usersCount.rows[0].count)
      },
      transactions: {
        total: parseInt(transactionsCount.rows[0].count),
        pending: parseInt(pendingTransactions.rows[0].count)
      },
      sales: {
        total: parseFloat(totalSales.rows[0].total),
        credits: parseInt(creditsCount.rows[0].total)
      },
      salesByDay: salesByDay.rows
    });
  } catch (error) {
    console.error('❌ Erro ao buscar dashboard admin:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas', details: error.message });
  }
});

// Listar todos os usuários
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT id, name, email, phone, credits_balance, role, status, created_at, last_login
      FROM users
      WHERE 1=1
    `;
    
    const params = [];
    
    if (search) {
      query += ` AND (name ILIKE $1 OR email ILIKE $1)`;
      params.push(`%${search}%`);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    // Total de usuários
    const countQuery = search 
      ? `SELECT COUNT(*) FROM users WHERE name ILIKE $1 OR email ILIKE $1`
      : `SELECT COUNT(*) FROM users`;
    const countParams = search ? [`%${search}%`] : [];
    const countResult = await pool.query(countQuery, countParams);
    
    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('❌ Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro ao listar usuários', details: error.message });
  }
});

// Editar usuário (créditos, role, status)
app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { credits_balance, role, status } = req.body;
    
    const updates = [];
    const params = [];
    let paramIndex = 1;
    
    if (credits_balance !== undefined) {
      updates.push(`credits_balance = $${paramIndex}`);
      params.push(credits_balance);
      paramIndex++;
    }
    
    if (role !== undefined) {
      updates.push(`role = $${paramIndex}`);
      params.push(role);
      paramIndex++;
    }
    
    if (status !== undefined) {
      updates.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }
    
    params.push(id);
    const query = `
      UPDATE users 
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIndex}
      RETURNING id, name, email, credits_balance, role, status
    `;
    
    const result = await pool.query(query, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    res.json({ user: result.rows[0], message: 'Usuário atualizado com sucesso!' });
  } catch (error) {
    console.error('❌ Erro ao editar usuário:', error);
    res.status(500).json({ error: 'Erro ao editar usuário', details: error.message });
  }
});

// Listar todas as transações
app.get('/api/admin/transactions', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, status = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT 
        t.id, t.external_reference, t.payment_id, t.status, t.package_id, 
        t.credits, t.amount, t.payment_method, t.created_at, t.approved_at,
        u.name as user_name, u.email as user_email
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (status) {
      query += ` AND t.status = $1`;
      params.push(status);
    }
    
    query += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    // Total
    const countQuery = status 
      ? `SELECT COUNT(*) FROM transactions WHERE status = $1`
      : `SELECT COUNT(*) FROM transactions`;
    const countParams = status ? [status] : [];
    const countResult = await pool.query(countQuery, countParams);
    
    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('❌ Erro ao listar transações:', error);
    res.status(500).json({ error: 'Erro ao listar transações', details: error.message });
  }
});

// Ver detalhes de um usuário específico
app.get('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Dados do usuário
    const userResult = await pool.query(`
      SELECT id, name, email, phone, credits_balance, role, status, created_at, last_login
      FROM users WHERE id = $1
    `, [id]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Transações do usuário
    const transactionsResult = await pool.query(`
      SELECT id, external_reference, status, package_id, credits, amount, payment_method, created_at, approved_at
      FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [id]);
    
    res.json({
      user: userResult.rows[0],
      transactions: transactionsResult.rows
    });
  } catch (error) {
    console.error('❌ Erro ao buscar usuário:', error);
    res.status(500).json({ error: 'Erro ao buscar usuário', details: error.message });
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
