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
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== CONFIGURAÇÕES ====================

// Mercado Pago
mercadopago.configure({
    access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
});
console.log('✅ Mercado Pago configurado com Access Token de PRODUÇÃO');

// PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.connect()
    .then(() => console.log('✅ PostgreSQL conectado com sucesso'))
    .catch(err => console.error('❌ Erro ao conectar PostgreSQL:', err));

// Resend Email
const resend = new Resend(process.env.RESEND_API_KEY);
console.log('✅ Email Resend configurado');

// ==================== DEFINIÇÃO DE PACOTES E CUPONS ====================

const PACKAGES = {
    package_5k: {
        id: 'package_5k',
        name: '5.000 Créditos',
        credits: 5000,
        price: 70000,
        pricePerLead: 0.14
    },
    package_10k: {
        id: 'package_10k',
        name: '10.000 Créditos',
        credits: 10000,
        price: 130000,
        pricePerLead: 0.13
    },
    package_20k: {
        id: 'package_20k',
        name: '20.000 Créditos',
        credits: 20000,
        price: 240000,
        pricePerLead: 0.12
    },
    package_50k: {
        id: 'package_50k',
        name: '50.000 Créditos',
        credits: 50000,
        price: 550000,
        pricePerLead: 0.11
    }
};

const COUPONS = {
    TESTE99: {
        code: 'TESTE99',
        discount: 99,
        type: 'percentage',
        active: true,
        description: 'Cupom de teste com 99% de desconto'
    },
    BEMVINDO10: {
        code: 'BEMVINDO10',
        discount: 10,
        type: 'percentage',
        active: true,
        description: 'Cupom de boas-vindas com 10% de desconto'
    }
};

function validateCoupon(code) {
    if (!code) return null;
    const coupon = COUPONS[code.toUpperCase()];
    return (coupon && coupon.active) ? coupon : null;
}

function calculateDiscount(price, coupon) {
    if (!coupon) return 0;
    if (coupon.type === 'percentage') {
        return Math.round((price * coupon.discount) / 100);
    }
    if (coupon.type === 'fixed') {
        return Math.min(coupon.discount, price);
    }
    return 0;
}

// ==================== MIDDLEWARES ====================

app.use(helmet());
app.use(morgan('dev'));
app.use(cors({
    origin: [
        'https://jkvzqvlk.gensparkspace.com',
        'http://localhost:3000',
        'http://localhost:5500'
    ],
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Token não fornecido' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-default');
        req.userId = decoded.userId;
        next();
    } catch (error) {
        console.error('❌ Erro na autenticação:', error);
        res.status(401).json({ error: 'Token inválido' });
    }
};

const adminMiddleware = async (req, res, next) => {
    try {
        const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
        
        if (userResult.rows.length === 0 || userResult.rows[0].role !== 'admin') {
            return res.status(403).json({ error: 'Acesso negado' });
        }
        
        next();
    } catch (error) {
        console.error('❌ Erro no middleware admin:', error);
        res.status(500).json({ error: 'Erro ao verificar permissões' });
    }
};

// ==================== FUNÇÕES AUXILIARES ====================

async function sendEmail(to, subject, html) {
    try {
        await resend.emails.send({
            from: 'Leads Para Todos <noreply@leadsparatodos.com>',
            to: [to],
            subject: subject,
            html: html
        });
        console.log('✅ Email enviado para:', to);
    } catch (error) {
        console.error('❌ Erro ao enviar email:', error);
    }
}

const emailTemplates = {
    welcome: (name) => `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎉 Bem-vindo ao Leads Para Todos!</h1>
                </div>
                <div class="content">
                    <p>Olá ${name},</p>
                    <p>Sua conta foi criada com sucesso! Agora você tem acesso à melhor plataforma de geração de leads do Instagram.</p>
                    <p><strong>O que você pode fazer:</strong></p>
                    <ul>
                        <li>✅ Gerar leads qualificados por apenas R$ 0,14</li>
                        <li>✅ Filtrar por biografia, localização e mais</li>
                        <li>✅ Exportar dados em CSV ou Excel</li>
                        <li>✅ Suporte especializado</li>
                    </ul>
                    <p>Comece agora comprando seus primeiros créditos:</p>
                    <a href="https://jkvzqvlk.gensparkspace.com/checkout-bricks.html" class="button">Comprar Créditos</a>
                    <p>Atenciosamente,<br>Equipe Leads Para Todos</p>
                </div>
            </div>
        </body>
        </html>
    `,
    
    creditDebit: (name, amount, reason, oldBalance, newBalance) => `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                .info-box { background: white; padding: 20px; border-left: 4px solid #f5576c; margin: 20px 0; border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>💸 Débito de Créditos</h1>
                </div>
                <div class="content">
                    <p>Olá ${name},</p>
                    <p>Informamos que foi realizado um débito em sua conta:</p>
                    <div class="info-box">
                        <p><strong>Quantidade debitada:</strong> ${amount.toLocaleString('pt-BR')} créditos</p>
                        <p><strong>Motivo:</strong> ${reason}</p>
                        <p><strong>Saldo anterior:</strong> ${oldBalance.toLocaleString('pt-BR')} créditos</p>
                        <p><strong>Novo saldo:</strong> ${newBalance.toLocaleString('pt-BR')} créditos</p>
                        <p><strong>Data:</strong> ${new Date().toLocaleString('pt-BR')}</p>
                    </div>
                    <p>Para comprar mais créditos, acesse sua conta.</p>
                    <p>Atenciosamente,<br>Equipe Leads Para Todos</p>
                </div>
            </div>
        </body>
        </html>
    `
};

// ==================== ROTAS DE AUTENTICAÇÃO ====================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        console.log('📝 Tentativa de registro:', email);

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
        }

        const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'Email já cadastrado' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await pool.query(
            'INSERT INTO users (name, email, password, credits_balance, role, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, credits_balance, role',
            [name, email.toLowerCase(), hashedPassword, 0, 'user', 'active']
        );

        const user = result.rows[0];

        await sendEmail(
            email,
            'Bem-vindo ao Leads Para Todos!',
            emailTemplates.welcome(name)
        );

        console.log('✅ Usuário registrado com sucesso:', user.id);

        res.status(201).json({
            message: 'Usuário criado com sucesso',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits_balance: user.credits_balance,
                role: user.role
            }
        });
    } catch (error) {
        console.error('❌ Erro ao registrar usuário:', error);
        res.status(500).json({ error: 'Erro ao criar usuário' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        console.log('🔐 Tentativa de login:', email);

        if (!email || !password) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
        }

        const result = await pool.query(
            'SELECT id, name, email, password, credits_balance, role, status FROM users WHERE email = $1',
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        const user = result.rows[0];

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        if (user.status !== 'active') {
            return res.status(403).json({ error: 'Conta inativa' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET || 'secret-key-default',
            { expiresIn: '7d' }
        );

        console.log('✅ Login realizado com sucesso:', user.id);

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits_balance: user.credits_balance,
                role: user.role
            }
        });
    } catch (error) {
        console.error('❌ Erro no login:', error);
        res.status(500).json({ error: 'Erro ao fazer login' });
    }
});

app.get('/api/auth/profile', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, credits_balance, role, status, created_at FROM users WHERE id = $1',
            [req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        res.json({ user: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao buscar perfil:', error);
        res.status(500).json({ error: 'Erro ao buscar perfil' });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email.toLowerCase()]);
        
        if (result.rows.length === 0) {
            return res.json({ message: 'Se o email existir, um link será enviado' });
        }

        const user = result.rows[0];
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = new Date(Date.now() + 3600000);

        await pool.query(
            'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
            [resetToken, resetTokenExpiry, user.id]
        );

        const resetLink = `https://jkvzqvlk.gensparkspace.com/reset-password.html?token=${resetToken}`;

        await sendEmail(
            email,
            'Recuperação de Senha - Leads Para Todos',
            `<p>Olá ${user.name},</p><p>Clique no link abaixo para redefinir sua senha:</p><a href="${resetLink}">${resetLink}</a><p>Este link expira em 1 hora.</p>`
        );

        res.json({ message: 'Se o email existir, um link será enviado' });
    } catch (error) {
        console.error('❌ Erro ao solicitar reset:', error);
        res.status(500).json({ error: 'Erro ao solicitar recuperação' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        const result = await pool.query(
            'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Token inválido ou expirado' });
        }

        const userId = result.rows[0].id;
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await pool.query(
            'UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
            [hashedPassword, userId]
        );

        console.log('✅ Senha resetada com sucesso para usuário:', userId);

        res.json({ message: 'Senha alterada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao resetar senha:', error);
        res.status(500).json({ error: 'Erro ao resetar senha' });
    }
});

// ==================== ROTAS DE PAGAMENTO ====================

app.post('/api/payment/process-card', authMiddleware, async (req, res) => {
    try {
        console.log('💳 [CARTÃO] Recebendo pagamento via CARTÃO...');
        console.log('📦 [CARTÃO] Body completo:', JSON.stringify(req.body, null, 2));

        const { package_id, payment_data, coupon, discount, final_price } = req.body;

        const package_ = PACKAGES[package_id];
        if (!package_) {
            return res.status(400).json({ error: 'Pacote inválido' });
        }

        const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
        const user = userResult.rows[0];

        const payment = await mercadopago.payment.create({
            transaction_amount: final_price / 100,
            token: payment_data.token,
            description: package_.name,
            installments: payment_data.installments || 1,
            payment_method_id: payment_data.payment_method_id,
            payer: {
                email: user.email,
                identification: {
                    type: payment_data.identification?.type || 'CPF',
                    number: payment_data.identification?.number || ''
                }
            }
        });

        console.log('✅ [CARTÃO] Pagamento processado:', payment.body.status);

        if (payment.body.status === 'approved') {
            await pool.query(
                'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
                [package_.credits, req.userId]
            );

            await pool.query(
                `INSERT INTO credit_transactions (user_id, type, amount, description, reference_id)
                 VALUES ($1, 'credit', $2, $3, $4)`,
                [req.userId, package_.credits, `Compra de ${package_.name} via Cartão`, payment.body.id]
            );

            console.log('✅ Créditos adicionados:', package_.credits);
        }

        res.json({
            status: payment.body.status,
            payment_id: payment.body.id,
            credits_added: package_.credits
        });
    } catch (error) {
        console.error('❌ Erro ao processar cartão:', error);
        res.status(500).json({ error: 'Erro ao processar pagamento' });
    }
});

app.post('/api/payment/process-pix', authMiddleware, async (req, res) => {
    try {
        console.log('📱 [PIX] Recebendo pagamento via PIX...');

        const { package_id, coupon, discount, final_price } = req.body;

        const package_ = PACKAGES[package_id];
        if (!package_) {
            return res.status(400).json({ error: 'Pacote inválido' });
        }

        const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
        const user = userResult.rows[0];

        const payment = await mercadopago.payment.create({
            transaction_amount: final_price / 100,
            description: package_.name,
            payment_method_id: 'pix',
            payer: {
                email: user.email,
                first_name: user.name.split(' ')[0],
                last_name: user.name.split(' ').slice(1).join(' ')
            }
        });

        console.log('✅ [PIX] Pagamento criado:', payment.body.id);

        await pool.query(
            `INSERT INTO orders (user_id, package_id, credits_amount, price_paid, mp_payment_id, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [req.userId, package_id, package_.credits, final_price, payment.body.id]
        );

        res.json({
            qr_code: payment.body.point_of_interaction.transaction_data.qr_code,
            qr_code_base64: payment.body.point_of_interaction.transaction_data.qr_code_base64,
            payment_id: payment.body.id
        });
    } catch (error) {
        console.error('❌ Erro ao processar PIX:', error);
        res.status(500).json({ error: 'Erro ao processar pagamento' });
    }
});

app.post('/api/payment/webhook', async (req, res) => {
    try {
        const { type, data } = req.body;

        console.log('📩 Webhook recebido:', type);

        if (type === 'payment') {
            const payment = await mercadopago.payment.findById(data.id);
            const status = payment.body.status;

            console.log('💳 Status:', status);

            if (status === 'approved') {
                const order = await pool.query(
                    'SELECT user_id, package_id, credits_amount FROM orders WHERE mp_payment_id = $1 AND status = $2',
                    [data.id, 'pending']
                );

                if (order.rows.length > 0) {
                    const { user_id, credits_amount } = order.rows[0];

                    await pool.query(
                        'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
                        [credits_amount, user_id]
                    );

                    await pool.query(
                        'UPDATE orders SET status = $1 WHERE mp_payment_id = $2',
                        ['completed', data.id]
                    );

                    await pool.query(
                        `INSERT INTO credit_transactions (user_id, type, amount, description, reference_id)
                         VALUES ($1, 'credit', $2, $3, $4)`,
                        [user_id, credits_amount, 'Compra via PIX', data.id]
                    );

                    console.log('✅ Créditos adicionados via webhook:', credits_amount);
                }
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        res.sendStatus(500);
    }
});

app.get('/api/payment/transactions', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, type, amount, description, created_at, reference_id
             FROM credit_transactions
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [req.userId]
        );

        res.json({ transactions: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar transações:', error);
        res.status(500).json({ error: 'Erro ao buscar transações' });
    }
});

// ==================== ROTAS DE LEADS ====================

app.post('/api/leads-requests/simple', authMiddleware, async (req, res) => {
    try {
        const { credits_requested, filters, whatsapp_message } = req.body;

        if (!credits_requested || credits_requested < 1000) {
            return res.status(400).json({ error: 'Quantidade mínima: 1.000 créditos' });
        }

        const userResult = await pool.query('SELECT credits_balance FROM users WHERE id = $1', [req.userId]);
        const currentBalance = parseInt(userResult.rows[0].credits_balance);

        if (currentBalance < credits_requested) {
            return res.status(400).json({
                error: 'Saldo insuficiente',
                requested: credits_requested,
                available: currentBalance,
                missing: credits_requested - currentBalance
            });
        }

        await pool.query(
            `INSERT INTO leads_requests (user_id, credits_requested, filters, whatsapp_message, status)
             VALUES ($1, $2, $3, $4, 'pending')`,
            [req.userId, credits_requested, JSON.stringify(filters), whatsapp_message]
        );

        console.log('✅ Solicitação criada:', req.userId, credits_requested);

        res.json({
            message: 'Solicitação enviada com sucesso',
            credits_requested,
            whatsapp_url: `https://wa.me/5511975207500?text=${encodeURIComponent(whatsapp_message)}`
        });
    } catch (error) {
        console.error('❌ Erro ao criar solicitação:', error);
        res.status(500).json({ error: 'Erro ao criar solicitação' });
    }
});

app.get('/api/leads/stats', authMiddleware, async (req, res) => {
    try {
        const statsResult = await pool.query(
            `SELECT 
                (SELECT COUNT(*) FROM leads_requests WHERE user_id = $1) as total_requests,
                (SELECT COALESCE(SUM(credits_requested), 0) FROM leads_requests WHERE user_id = $1) as total_credits_requested,
                (SELECT credits_balance FROM users WHERE id = $1) as credits_balance
            `,
            [req.userId]
        );

        const stats = statsResult.rows[0];

        res.json({
            totalRequests: parseInt(stats.total_requests),
            totalCreditsRequested: parseInt(stats.total_credits_requested),
            creditsBalance: parseInt(stats.credits_balance)
        });
    } catch (error) {
        console.error('❌ Erro ao buscar estatísticas:', error);
        res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
});

// ==================== ROTAS ADMIN ====================

app.get('/api/admin/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        const transactionsCount = await pool.query(
            "SELECT COUNT(*) FROM credit_transactions WHERE type = 'credit'"
        );
        const creditsCount = await pool.query(
            "SELECT COALESCE(SUM(amount), 0) as total FROM credit_transactions WHERE type = 'credit'"
        );
        const revenue = await pool.query(
            "SELECT COALESCE(SUM(amount * 0.14), 0) as total FROM credit_transactions WHERE type = 'credit'"
        );

        const salesByDay = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                COALESCE(SUM(amount * 0.14), 0) as revenue,
                COUNT(*) as transactions
            FROM credit_transactions
            WHERE type = 'credit' AND created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);

        res.json({
            totalUsers: parseInt(usersCount.rows[0].count),
            totalTransactions: parseInt(transactionsCount.rows[0].count),
            totalCreditsSold: parseInt(creditsCount.rows[0].total || 0),
            totalSales: parseFloat(revenue.rows[0].total || 0),
            salesByDay: salesByDay.rows
        });
    } catch (error) {
        console.error('❌ Erro ao buscar dashboard admin:', error);
        res.status(500).json({ error: 'Erro ao buscar dados do dashboard' });
    }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { search = '' } = req.query;
        
        let query = 'SELECT id, name, email, phone, credits_balance, role, status, created_at FROM users';
        let params = [];
        
        if (search) {
            query += ' WHERE name ILIKE $1 OR email ILIKE $1';
            params.push(`%${search}%`);
        }
        
        query += ' ORDER BY created_at DESC';
        
        const result = await pool.query(query, params);
        res.json({ users: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar usuários:', error);
        res.status(500).json({ error: 'Erro ao buscar usuários' });
    }
});

app.get('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const result = await pool.query(
            'SELECT id, name, email, phone, credits_balance, role, status, created_at FROM users WHERE id = $1',
            [userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }
        
        res.json({ user: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao buscar usuário:', error);
        res.status(500).json({ error: 'Erro ao buscar detalhes do usuário' });
    }
});

app.put('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const { credits_balance, role, status } = req.body;
        
        const updates = [];
        const values = [];
        let paramCount = 1;
        
        if (credits_balance !== undefined) {
            updates.push(`credits_balance = $${paramCount}`);
            values.push(credits_balance);
            paramCount++;
        }
        
        if (role !== undefined) {
            updates.push(`role = $${paramCount}`);
            values.push(role);
            paramCount++;
        }
        
        if (status !== undefined) {
            updates.push(`status = $${paramCount}`);
            values.push(status);
            paramCount++;
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ error: 'Nenhum campo para atualizar' });
        }
        
        values.push(userId);
        
        await pool.query(
            `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount}`,
            values
        );
        
        res.json({ message: 'Usuário atualizado com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao atualizar usuário:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário' });
    }
});

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { status = '' } = req.query;
        
        let query = `
            SELECT ct.id, ct.type, ct.amount, ct.description, ct.created_at,
                   u.name as user_name, u.email as user_email
            FROM credit_transactions ct
            JOIN users u ON ct.user_id = u.id
        `;
        
        const params = [];
        
        if (status) {
            query += ' WHERE ct.type = $1';
            params.push(status);
        }
        
        query += ' ORDER BY ct.created_at DESC LIMIT 100';
        
        const result = await pool.query(query, params);
        res.json({ transactions: result.rows });
    } catch (error) {
        console.error('❌ Erro ao listar transações:', error);
        res.status(500).json({ error: 'Erro ao listar transações' });
    }
});

app.get('/api/admin/export/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    res.json({ message: 'Exportação em desenvolvimento' });
});

app.get('/api/admin/export/users', authMiddleware, adminMiddleware, async (req, res) => {
    res.json({ message: 'Exportação em desenvolvimento' });
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ==================== INICIAR SERVIDOR ====================

app.listen(PORT, () => {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║     🚀 LEADS PARA TODOS - BACKEND INICIADO          ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║     📡 Porta: ${PORT}                                    ║`);
    console.log(`║     🌍 Ambiente: ${process.env.NODE_ENV || 'development'}                      ║`);
    console.log(`║     🎯 Frontend: https://jkvzqvlk.gensparkspace.com  ║`);
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║     💳 Mercado Pago: ${process.env.MERCADOPAGO_ACCESS_TOKEN ? '✅ Configurado' : '❌ Não configurado'}           ║`);
    console.log(`║     📧 Resend API: ${process.env.RESEND_API_KEY ? '✅ Configurado' : '❌ Não configurado'}             ║`);
    console.log('╚═══════════════════════════════════════════════════════╝\n');
});
