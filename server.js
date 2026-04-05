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
        price: 70000, // R$ 700,00 em centavos
        pricePerLead: 0.14
    },
    package_10k: {
        id: 'package_10k',
        name: '10.000 Créditos',
        credits: 10000,
        price: 130000, // R$ 1.300,00 em centavos
        pricePerLead: 0.13
    },
    package_20k: {
        id: 'package_20k',
        name: '20.000 Créditos',
        credits: 20000,
        price: 240000, // R$ 2.400,00 em centavos
        pricePerLead: 0.12
    },
    package_50k: {
        id: 'package_50k',
        name: '50.000 Créditos',
        credits: 50000,
        price: 550000, // R$ 5.500,00 em centavos
        pricePerLead: 0.11
    }
};

// Sistema de cupons
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

// Middleware de autenticação
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

// Middleware de admin
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

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Registro
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;

        // Validações
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
        }

        // Verificar se email já existe
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email já cadastrado' });
        }

        // Hash da senha
        const hashedPassword = await bcrypt.hash(password, 10);

        // Inserir usuário
        const result = await pool.query(
            `INSERT INTO users (name, email, password, phone, credits_balance, role, status) 
             VALUES ($1, $2, $3, $4, 0, 'user', 'active') 
             RETURNING id, name, email, phone, credits_balance, role, created_at`,
            [name, email.toLowerCase(), hashedPassword, phone || null]
        );

        const user = result.rows[0];

        // Gerar token
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET || 'secret-key-default',
            { expiresIn: '7d' }
        );

        console.log('✅ Novo usuário registrado:', user.email);

        res.status(201).json({
            message: 'Usuário criado com sucesso',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                credits_balance: user.credits_balance,
                role: user.role
            }
        });
    } catch (error) {
        console.error('❌ Erro ao registrar usuário:', error);
        res.status(500).json({ error: 'Erro ao criar conta' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
        }

        // Buscar usuário
        const result = await pool.query(
            'SELECT id, name, email, password, phone, credits_balance, role, status FROM users WHERE email = $1',
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        const user = result.rows[0];

        // Verificar status
        if (user.status !== 'active') {
            return res.status(403).json({ error: 'Conta inativa. Entre em contato com o suporte.' });
        }

        // Verificar senha
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        // Atualizar último login
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

        // Gerar token
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET || 'secret-key-default',
            { expiresIn: '7d' }
        );

        console.log('✅ Login bem-sucedido:', user.email);

        res.json({
            message: 'Login realizado com sucesso',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                credits_balance: user.credits_balance,
                role: user.role
            }
        });
    } catch (error) {
        console.error('❌ Erro ao fazer login:', error);
        res.status(500).json({ error: 'Erro ao fazer login' });
    }
});

// Perfil do usuário
app.get('/api/auth/profile', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, phone, credits_balance, role, status, created_at FROM users WHERE id = $1',
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

// Atualizar perfil
app.put('/api/auth/profile', authMiddleware, async (req, res) => {
    try {
        const { name, phone } = req.body;

        await pool.query(
            'UPDATE users SET name = $1, phone = $2, updated_at = NOW() WHERE id = $3',
            [name, phone, req.userId]
        );

        res.json({ message: 'Perfil atualizado com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao atualizar perfil:', error);
        res.status(500).json({ error: 'Erro ao atualizar perfil' });
    }
});

// Alterar senha
app.put('/api/auth/password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Senhas são obrigatórias' });
        }

        // Buscar senha atual
        const result = await pool.query('SELECT password FROM users WHERE id = $1', [req.userId]);
        const user = result.rows[0];

        // Verificar senha atual
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Senha atual incorreta' });
        }

        // Hash da nova senha
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Atualizar senha
        await pool.query(
            'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
            [hashedPassword, req.userId]
        );

        res.json({ message: 'Senha alterada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao alterar senha:', error);
        res.status(500).json({ error: 'Erro ao alterar senha' });
    }
});

// ==================== ROTAS DE PAGAMENTO ====================

// Listar pacotes
app.get('/api/payment/packages', (req, res) => {
    const packages = Object.values(PACKAGES).map(pkg => ({
        ...pkg,
        formattedPrice: `R$ ${(pkg.price / 100).toFixed(2).replace('.', ',')}`
    }));
    res.json({ packages });
});

// Criar preferência de pagamento (Mercado Pago)
app.post('/api/payment/checkout', authMiddleware, async (req, res) => {
    try {
        const { packageId, couponCode } = req.body;

        const package_ = PACKAGES[packageId];
        if (!package_) {
            return res.status(400).json({ error: 'Pacote inválido' });
        }

        // Validar cupom
        const coupon = validateCoupon(couponCode);
        const discount = calculateDiscount(package_.price, coupon);
        const finalPrice = package_.price - discount;

        // Buscar dados do usuário
        const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
        const user = userResult.rows[0];

        // Criar preferência no Mercado Pago
        const preference = {
            items: [
                {
                    title: package_.name,
                    quantity: 1,
                    unit_price: finalPrice / 100,
                    currency_id: 'BRL'
                }
            ],
            payer: {
                name: user.name,
                email: user.email
            },
            back_urls: {
                success: 'https://jkvzqvlk.gensparkspace.com/dashboard.html?payment=success',
                failure: 'https://jkvzqvlk.gensparkspace.com/dashboard.html?payment=failure',
                pending: 'https://jkvzqvlk.gensparkspace.com/dashboard.html?payment=pending'
            },
            auto_return: 'approved',
            external_reference: `${req.userId}|${packageId}|${couponCode || ''}`,
            notification_url: `${process.env.BACKEND_URL}/api/payment/webhook`
        };

        const response = await mercadopago.preferences.create(preference);

        // Salvar pedido no banco
        await pool.query(
            `INSERT INTO orders (user_id, package_id, credits_amount, price_original, discount_amount, price_paid, coupon_code, mp_preference_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
            [req.userId, packageId, package_.credits, package_.price, discount, finalPrice, couponCode, response.body.id]
        );

        console.log('✅ Preferência criada:', response.body.id);

        res.json({
            preferenceId: response.body.id,
            initPoint: response.body.init_point
        });
    } catch (error) {
        console.error('❌ Erro ao criar checkout:', error);
        res.status(500).json({ error: 'Erro ao criar checkout' });
    }
});

// Webhook do Mercado Pago
app.post('/api/payment/webhook', async (req, res) => {
    try {
        const { type, data } = req.body;

        console.log('📩 Webhook recebido:', type, data);

        if (type === 'payment') {
            const paymentId = data.id;

            // Buscar detalhes do pagamento
            const payment = await mercadopago.payment.findById(paymentId);
            const status = payment.body.status;
            const externalReference = payment.body.external_reference;

            console.log('💳 Status do pagamento:', status);
            console.log('🔗 Referência externa:', externalReference);

            if (status === 'approved') {
                // Parse external_reference: userId|packageId|couponCode
                const [userId, packageId] = externalReference.split('|');

                const package_ = PACKAGES[packageId];
                if (!package_) {
                    console.error('❌ Pacote inválido:', packageId);
                    return res.sendStatus(400);
                }

                // Adicionar créditos ao usuário
                await pool.query(
                    'UPDATE users SET credits_balance = credits_balance + $1, updated_at = NOW() WHERE id = $2',
                    [package_.credits, userId]
                );

                // Atualizar status do pedido
                await pool.query(
                    'UPDATE orders SET status = $1, mp_payment_id = $2, updated_at = NOW() WHERE user_id = $3 AND package_id = $4 AND status = $5',
                    ['completed', paymentId, userId, packageId, 'pending']
                );

                // Registrar transação
                await pool.query(
                    `INSERT INTO credit_transactions (user_id, type, amount, description, reference_id)
                     VALUES ($1, 'credit', $2, $3, $4)`,
                    [userId, package_.credits, `Compra de ${package_.name}`, paymentId]
                );

                console.log('✅ Créditos adicionados ao usuário:', userId, package_.credits);
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        res.sendStatus(500);
    }
});

// Listar pedidos do usuário
app.get('/api/payment/orders', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
            [req.userId]
        );

        res.json({ orders: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar pedidos:', error);
        res.status(500).json({ error: 'Erro ao buscar pedidos' });
    }
});

// Listar transações do usuário
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

// Solicitar leads (sistema simplificado)
app.post('/api/leads-requests/simple', authMiddleware, async (req, res) => {
    try {
        const { credits_requested, filters, whatsapp_message } = req.body;

        // Validações
        if (!credits_requested || credits_requested < 1000) {
            return res.status(400).json({ error: 'Quantidade mínima: 1.000 créditos' });
        }

        // Verificar saldo do usuário
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

        // Inserir solicitação
        await pool.query(
            `INSERT INTO leads_requests (user_id, credits_requested, filters, whatsapp_message, status)
             VALUES ($1, $2, $3, $4, 'pending')`,
            [req.userId, credits_requested, JSON.stringify(filters), whatsapp_message]
        );

        console.log('✅ Solicitação de leads criada:', req.userId, credits_requested);

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

// Estatísticas do usuário
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

// Dashboard admin
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

        // Vendas por dia (últimos 30 dias)
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

// Listar usuários (admin)
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

// Obter detalhes de um usuário (admin)
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

// Atualizar usuário (admin) - INCLUINDO CRÉDITOS
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

// Listar transações (admin)
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

// Exportar transações (admin) - placeholder
app.get('/api/admin/export/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    res.json({ message: 'Exportação em desenvolvimento' });
});

// Exportar usuários (admin) - placeholder
app.get('/api/admin/export/users', authMiddleware, adminMiddleware, async (req, res) => {
    res.json({ message: 'Exportação em desenvolvimento' });
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
