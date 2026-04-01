require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mercadopago = require('mercadopago');
const crypto = require('crypto');

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

// ========================================
// FUNÇÃO DE ENVIO DE EMAIL (Resend)
// ========================================

async function sendEmail({ to, subject, html }) {
  try {
    // Se não tiver RESEND_API_KEY configurada, apenas loga
    if (!process.env.RESEND_API_KEY) {
      console.log('⚠️ RESEND_API_KEY não configurada - Email não enviado');
      console.log('📧 Email que seria enviado:', { to, subject });
      return { success: false, message: 'Email não configurado' };
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Leads para Todos <onboarding@resend.dev>',
        to: [to],
        subject: subject,
        html: html
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ Erro ao enviar email:', data);
      return { success: false, error: data };
    }

    console.log('✅ Email enviado:', to, subject);
    return { success: true, data };
  } catch (error) {
    console.error('❌ Erro ao enviar email:', error);
    return { success: false, error: error.message };
  }
}

// Templates de email
function getEmailTemplate(type, data) {
  const frontendUrl = process.env.FRONTEND_URL || 'https://jkvzqvlk.gensparkspace.com';
  
  const baseStyle = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
      <div style="background-color: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
  `;
  
  const baseFooter = `
      </div>
      <div style="text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px;">
        <p>Leads para Todos - Geração de Leads do Instagram</p>
        <p><a href="${frontendUrl}" style="color: #7c3aed;">Acessar Plataforma</a></p>
      </div>
    </div>
  `;

  const templates = {
    welcome: `
      ${baseStyle}
      <h1 style="color: #7c3aed; margin-bottom: 20px;">🎉 Bem-vindo ao Leads para Todos!</h1>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Olá <strong>${data.name || 'Cliente'}</strong>,
      </p>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Sua conta foi criada com sucesso! Agora você pode acessar nossa plataforma e começar a gerar leads qualificados do Instagram.
      </p>
      <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="color: #7c3aed; margin-top: 0;">📊 Seus Dados:</h3>
        <p style="margin: 5px 0;"><strong>Email:</strong> ${data.email || ''}</p>
        <p style="margin: 5px 0;"><strong>Créditos iniciais:</strong> 0</p>
      </div>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Para começar a usar, compre créditos e explore nossas 758 categorias de leads!
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${frontendUrl}/dashboard.html" 
           style="background-color: #7c3aed; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
          Acessar Dashboard
        </a>
      </div>
      ${baseFooter}
    `,
    
    payment_approved: `
      ${baseStyle}
      <h1 style="color: #10b981; margin-bottom: 20px;">✅ Pagamento Aprovado!</h1>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Olá <strong>${data.name || 'Cliente'}</strong>,
      </p>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Seu pagamento foi aprovado e seus créditos já foram adicionados à sua conta!
      </p>
      <div style="background-color: #d1fae5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
        <h3 style="color: #065f46; margin-top: 0;">💰 Detalhes da Compra:</h3>
        <p style="margin: 5px 0;"><strong>Pacote:</strong> ${data.package || 'Créditos'}</p>
        <p style="margin: 5px 0;"><strong>Créditos:</strong> ${(data.credits || 0).toLocaleString('pt-BR')}</p>
        <p style="margin: 5px 0;"><strong>Valor:</strong> R$ ${(data.amount || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
        <p style="margin: 5px 0;"><strong>ID da transação:</strong> ${data.transaction_id || ''}</p>
      </div>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Agora você pode começar a exportar leads qualificados do Instagram!
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${frontendUrl}/dashboard.html" 
           style="background-color: #7c3aed; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
          Usar Meus Créditos
        </a>
      </div>
      ${baseFooter}
    `,
    
    password_reset: `
      ${baseStyle}
      <h1 style="color: #7c3aed; margin-bottom: 20px;">🔐 Recuperação de Senha</h1>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Olá <strong>${data.name || 'Cliente'}</strong>,
      </p>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Recebemos uma solicitação para redefinir a senha da sua conta.
      </p>
      <p style="font-size: 16px; color: #374151; line-height: 1.6;">
        Clique no botão abaixo para criar uma nova senha:
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${frontendUrl}/reset-password.html?token=${data.token || ''}" 
           style="background-color: #7c3aed; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
          Redefinir Senha
        </a>
      </div>
      <div style="background-color: #fef3c7; padding: 15px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #f59e0b;">
        <p style="margin: 0; color: #92400e; font-size: 14px;">
          ⚠️ Este link expira em 30 minutos.<br>
          Se você não solicitou esta alteração, ignore este email.
        </p>
      </div>
      ${baseFooter}
    `
  };

  return templates[type] || '';
}

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

// ========================================
// ROTAS DE AUTENTICAÇÃO
// ========================================

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
    
    // Enviar email de boas-vindas
    sendEmail({
      to: user.email,
      subject: '🎉 Bem-vindo ao Leads para Todos!',
      html: getEmailTemplate('welcome', { name: user.name, email: user.email })
    });
    
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

// ========================================
// RECUPERAÇÃO DE SENHA
// ========================================

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    // Verificar se usuário existe
    const result = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      // Por segurança, não informar se email existe ou não
      return res.json({ message: 'Se o email existe, um link de recuperação foi enviado.' });
    }
    
    const user = result.rows[0];
    
    // Gerar token de reset (válido por 30 minutos)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetTokenExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos
    
    // Salvar token no banco
    await pool.query(
      `UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`,
      [resetTokenHash, resetTokenExpires, user.id]
    );
    
    // Enviar email
    await sendEmail({
      to: user.email,
      subject: '🔐 Recuperação de Senha - Leads para Todos',
      html: getEmailTemplate('password_reset', { name: user.name, token: resetToken })
    });
    
    res.json({ message: 'Se o email existe, um link de recuperação foi enviado.' });
  } catch (error) {
    console.error('Erro ao solicitar recuperação:', error);
    res.status(500).json({ error: 'Erro ao processar solicitação' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token e senha são obrigatórios' });
    }
    
    // Hash do token recebido
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    
    // Buscar usuário com token válido
    const result = await pool.query(
      `SELECT id, name, email FROM users 
       WHERE reset_token = $1 AND reset_token_expires > NOW()`,
      [resetTokenHash]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Token inválido ou expirado' });
    }
    
    const user = result.rows[0];
    
    // Hash da nova senha
    const password_hash = await bcrypt.hash(password, 10);
    
    // Atualizar senha e limpar token
    await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2`,
      [password_hash, user.id]
    );
    
    res.json({ message: 'Senha redefinida com sucesso!' });
  } catch (error) {
    console.error('Erro ao redefinir senha:', error);
    res.status(500).json({ error: 'Erro ao redefinir senha' });
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
      
      // Enviar email de confirmação
      sendEmail({
        to: user.email,
        subject: '✅ Pagamento Aprovado - Leads para Todos',
        html: getEmailTemplate('payment_approved', {
          name: user.name,
          package: pkg.name,
          credits: pkg.credits,
          amount: pkg.price,
          transaction_id: external_reference
        })
      });
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
    app.post('/api/payment/process-pix', authMiddleware, async (req, res) => {
    try {
        console.log('💳 [PIX-DEBUG] Iniciando pagamento PIX...');
        console.log('📦 [PIX-DEBUG] Body completo:', JSON.stringify(req.body, null, 2));
        console.log('👤 [PIX-DEBUG] User ID:', req.userId);
        
        const { package_id, amount, credits, coupon, discount } = req.body;
        
        console.log('🔍 [PIX-DEBUG] Dados extraídos:', {
            package_id,
            amount,
            credits,
            coupon,
            discount
        });

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
            
            // Buscar dados do usuário e enviar email
            const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [transaction.user_id]);
            if (userResult.rows.length > 0) {
              const user = userResult.rows[0];
              const pkg = PACKAGES[transaction.package_id] || { name: 'Créditos', credits: transaction.credits, price: transaction.amount };
              
              sendEmail({
                to: user.email,
                subject: '✅ Pagamento Aprovado - Leads para Todos',
                html: getEmailTemplate('payment_approved', {
                  name: user.name,
                  package: pkg.name,
                  credits: transaction.credits,
                  amount: transaction.amount,
                  transaction_id: external_reference
                })
              });
            }
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
    const usersCount = await pool.query('SELECT COUNT(*) as count FROM users');
    const transactionsCount = await pool.query('SELECT COUNT(*) as count FROM transactions');
    const totalSales = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = 'approved'`);
    const creditsCount = await pool.query(`SELECT COALESCE(SUM(credits), 0) as total FROM transactions WHERE status = 'approved'`);
    const salesByDay = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count, SUM(amount) as total
      FROM transactions
      WHERE status = 'approved' AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);
    const pendingTransactions = await pool.query(`SELECT COUNT(*) as count FROM transactions WHERE status = 'pending'`);

    res.json({
      users: { total: parseInt(usersCount.rows[0].count), active: parseInt(usersCount.rows[0].count) },
      transactions: { total: parseInt(transactionsCount.rows[0].count), pending: parseInt(pendingTransactions.rows[0].count) },
      sales: { total: parseFloat(totalSales.rows[0].total), credits: parseInt(creditsCount.rows[0].total) },
      salesByDay: salesByDay.rows
    });
  } catch (error) {
    console.error('❌ Erro ao buscar dashboard admin:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas', details: error.message });
  }
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;
    let query = `SELECT id, name, email, phone, credits_balance, role, status, created_at, last_login FROM users WHERE 1=1`;
    const params = [];
    if (search) {
      query += ` AND (name ILIKE $1 OR email ILIKE $1)`;
      params.push(`%${search}%`);
    }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const result = await pool.query(query, params);
    const countQuery = search ? `SELECT COUNT(*) FROM users WHERE name ILIKE $1 OR email ILIKE $1` : `SELECT COUNT(*) FROM users`;
    const countParams = search ? [`%${search}%`] : [];
    const countResult = await pool.query(countQuery, countParams);
    res.json({ users: result.rows, total: parseInt(countResult.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    console.error('❌ Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro ao listar usuários', details: error.message });
  }
});

app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { credits_balance, role, status } = req.body;
    const result = await pool.query(
      `UPDATE users SET credits_balance = $1, role = $2, status = $3, updated_at = NOW() WHERE id = $4 RETURNING id, name, email, credits_balance, role, status`,
      [credits_balance, role, status, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ user: result.rows[0], message: 'Usuário atualizado com sucesso!' });
  } catch (error) {
    console.error('❌ Erro ao editar usuário:', error);
    res.status(500).json({ error: 'Erro ao editar usuário', details: error.message });
  }
});

app.get('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userResult = await pool.query(`SELECT id, name, email, phone, credits_balance, role, status, created_at, last_login FROM users WHERE id = $1`, [id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    const transactionsResult = await pool.query(`SELECT id, external_reference, status, package_id, credits, amount, payment_method, created_at, approved_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]);
    res.json({ user: userResult.rows[0], transactions: transactionsResult.rows });
  } catch (error) {
    console.error('❌ Erro ao buscar detalhes do usuário:', error);
    res.status(500).json({ error: 'Erro ao buscar detalhes', details: error.message });
  }
});

app.get('/api/admin/transactions', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, status = '' } = req.query;
    const offset = (page - 1) * limit;
    let query = `SELECT t.id, t.external_reference, t.status, t.package_id, t.credits, t.amount, t.payment_method, t.created_at, t.approved_at, u.name as user_name, u.email as user_email FROM transactions t LEFT JOIN users u ON t.user_id = u.id WHERE 1=1`;
    const params = [];
    if (status) {
      query += ` AND t.status = $1`;
      params.push(status);
    }
    query += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const result = await pool.query(query, params);
    const countQuery = status ? `SELECT COUNT(*) FROM transactions WHERE status = $1` : `SELECT COUNT(*) FROM transactions`;
    const countParams = status ? [status] : [];
    const countResult = await pool.query(countQuery, countParams);
    res.json({ transactions: result.rows, total: parseInt(countResult.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    console.error('❌ Erro ao listar transações:', error);
    res.status(500).json({ error: 'Erro ao listar transações', details: error.message });
  }
});

app.get('/api/admin/export/transactions', adminMiddleware, async (req, res) => {
  try {
    const { format = 'csv', status = '' } = req.query;
    let query = `SELECT t.id, t.external_reference, t.status, t.package_id, t.credits, t.amount, t.payment_method, t.payment_type, t.payer_email, t.created_at, t.approved_at, u.name as user_name, u.email as user_email, u.phone as user_phone FROM transactions t LEFT JOIN users u ON t.user_id = u.id WHERE 1=1`;
    const params = [];
    if (status) {
      query += ` AND t.status = $1`;
      params.push(status);
    }
    query += ` ORDER BY t.created_at DESC`;
    const result = await pool.query(query, params);
    if (format === 'csv') {
      let csv = 'ID,Referência,Status,Pacote,Créditos,Valor (R$),Método,Email Pagador,Nome Cliente,Email Cliente,Telefone,Criado Em,Aprovado Em\n';
      result.rows.forEach(row => {
        csv += `${row.id},"${row.external_reference}","${row.status}","${row.package_id}",${row.credits},${row.amount},"${row.payment_method || ''}","${row.payer_email || ''}","${row.user_name}","${row.user_email}","${row.user_phone || ''}","${row.created_at}","${row.approved_at || ''}"\n`;
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transacoes-${Date.now()}.csv"`);
      res.send(csv);
    } else {
      res.json({ transactions: result.rows, total: result.rows.length, exported_at: new Date().toISOString() });
    }
  } catch (error) {
    console.error('❌ Erro ao exportar transações:', error);
    res.status(500).json({ error: 'Erro ao exportar', details: error.message });
  }
});

app.get('/api/admin/export/users', adminMiddleware, async (req, res) => {
  try {
    const { format = 'csv' } = req.query;
    const result = await pool.query(`SELECT id, name, email, phone, credits_balance, role, status, created_at, last_login FROM users ORDER BY created_at DESC`);
    if (format === 'csv') {
      let csv = 'ID,Nome,Email,Telefone,Créditos,Role,Status,Criado Em,Último Login\n';
      result.rows.forEach(row => {
        csv += `${row.id},"${row.name}","${row.email}","${row.phone || ''}",${row.credits_balance},"${row.role}","${row.status}","${row.created_at}","${row.last_login || ''}"\n`;
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="usuarios-${Date.now()}.csv"`);
      res.send(csv);
    } else {
      res.json({ users: result.rows, total: result.rows.length, exported_at: new Date().toISOString() });
    }
  } catch (error) {
    console.error('❌ Erro ao exportar usuários:', error);
    res.status(500).json({ error: 'Erro ao exportar', details: error.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((err, req, res, next) => { console.error('Erro:', err); res.status(500).json({ error: 'Erro interno do servidor' }); });

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log(`💳 Mercado Pago: ${process.env.MERCADOPAGO_ACCESS_TOKEN ? 'Configurado' : 'NÃO configurado'}`);
  console.log(`📧 Email (Resend): ${process.env.RESEND_API_KEY ? 'Configurado' : 'NÃO configurado - emails apenas em log'}`);
});
