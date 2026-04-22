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
// ==================== CORS ====================
const allowedOrigins = [
    'https://leadsparatodos.com',              
    'https://www.leadsparatodos.com',          
    'https://jkvzqvlk.gensparkspace.com',
    'http://localhost:3000',
    'http://localhost:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'A política de CORS deste site não permite acesso da origem especificada.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],        // ← ADICIONAR ESTA LINHA
    allowedHeaders: ['Content-Type', 'Authorization']                      // ← ADICIONAR ESTA LINHA
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

// ==================== FUNÇÃO DE ENVIO DE EMAIL ====================

async function sendEmail(to, subject, htmlContent) {
    try {
        if (!process.env.RESEND_API_KEY) {
            console.log('⚠️ Resend API Key não configurada');
            return { success: false, error: 'API Key não configurada' };
        }

        const data = await resend.emails.send({
            from: 'Leads Para Todos <noreply@leadsparatodos.com>',
            to: [to],
            subject: subject,
            html: htmlContent
        });

        console.log('✅ Email enviado com sucesso para:', to);
        return { success: true, data };
    } catch (error) {
        console.error('❌ Erro ao enviar email:', error);
        return { success: false, error: error.message };
    }
}

// Templates de email
const emailTemplates = {
    welcome: (name) => `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"></head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #1e40af;">Bem-vindo ao Leads Para Todos!</h2>
                <p>Olá <strong>${name}</strong>,</p>
                <p>Sua conta foi criada com sucesso! Agora você pode começar a gerar leads de qualidade para seu negócio.</p>
                <p>Acesse sua conta em: <a href="https://jkvzqvlk.gensparkspace.com/dashboard.html">Dashboard</a></p>
                <p>Se precisar de ajuda, estamos à disposição.</p>
                <p>Atenciosamente,<br>Equipe Leads Para Todos</p>
            </div>
        </body>
        </html>
    `,
    paymentApproved: (name, credits, package_name) => `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"></head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #10b981;">✅ Pagamento Aprovado!</h2>
                <p>Olá <strong>${name}</strong>,</p>
                <p>Seu pagamento foi aprovado com sucesso!</p>
                <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>Pacote:</strong> ${package_name}</p>
                    <p><strong>Créditos adicionados:</strong> ${credits.toLocaleString('pt-BR')}</p>
                </div>
                <p>Os créditos já estão disponíveis em sua conta!</p>
                <p><a href="https://jkvzqvlk.gensparkspace.com/dashboard.html" style="background: #1e40af; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Acessar Dashboard</a></p>
                <p>Atenciosamente,<br>Equipe Leads Para Todos</p>
            </div>
        </body>
        </html>
    `,
    resetPassword: (name, resetUrl) => `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"></head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #1e40af;">Recuperação de Senha</h2>
                <p>Olá <strong>${name}</strong>,</p>
                <p>Recebemos uma solicitação para redefinir sua senha.</p>
                <p>Clique no botão abaixo para criar uma nova senha:</p>
                <p><a href="${resetUrl}" style="background: #1e40af; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Redefinir Senha</a></p>
                <p>Este link é válido por 1 hora.</p>
                <p>Se você não solicitou esta alteração, ignore este email.</p>
                <p>Atenciosamente,<br>Equipe Leads Para Todos</p>
            </div>
        </body>
        </html>
    `
};

// ==================== ROTAS DE SAÚDE ====================

// ENDPOINT TEMPORÁRIO PARA CORRIGIR BANCO DE DADOS
app.get('/api/admin/fix-database-columns', async (req, res) => {
    try {
        console.log('🔧 Iniciando correção do banco de dados...');
        
        // Verificar se as colunas já existem
        const checkColumns = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'transactions' 
            AND column_name IN ('coupon_code', 'discount_amount')
        `);
        
        const existingColumns = checkColumns.rows.map(row => row.column_name);
        
        let results = {
            coupon_code: existingColumns.includes('coupon_code') ? 'já existe' : 'criada',
            discount_amount: existingColumns.includes('discount_amount') ? 'já existe' : 'criada'
        };
        
        // Adicionar coluna coupon_code se não existir
        if (!existingColumns.includes('coupon_code')) {
            await pool.query('ALTER TABLE transactions ADD COLUMN coupon_code VARCHAR(50)');
            console.log('✅ Coluna coupon_code adicionada');
        }
        
        // Adicionar coluna discount_amount se não existir
        if (!existingColumns.includes('discount_amount')) {
            await pool.query('ALTER TABLE transactions ADD COLUMN discount_amount INTEGER DEFAULT 0');
            console.log('✅ Coluna discount_amount adicionada');
        }
        
        // Verificar estrutura final
        const finalStructure = await pool.query(`
            SELECT column_name, data_type, character_maximum_length 
            FROM information_schema.columns 
            WHERE table_name = 'transactions' 
            ORDER BY ordinal_position
        `);
        
        console.log('✅ Banco de dados corrigido com sucesso!');
        
        res.json({
            success: true,
            message: 'Banco de dados corrigido com sucesso!',
            results: results,
            table_structure: finalStructure.rows
        });
    } catch (error) {
        console.error('❌ Erro ao corrigir banco de dados:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.stack
        });
    }
});

// ENDPOINT PARA CRIAR TABELA DE SOLICITAÇÕES DE LEADS
app.get('/api/admin/setup-leads-requests', async (req, res) => {
    try {
        console.log('🔧 Criando tabela leads_requests...');
        
        // Verificar se a tabela já existe
        const tableExists = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'leads_requests'
            );
        `);
        
        if (tableExists.rows[0].exists) {
            return res.json({
                success: true,
                message: 'Tabela leads_requests já existe',
                status: 'already_exists'
            });
        }
        
        // Criar tabela leads_requests
        await pool.query(`
            CREATE TABLE leads_requests (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                credits_requested INTEGER NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                filters JSONB,
                whatsapp_message TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                confirmed_at TIMESTAMP,
                cancelled_at TIMESTAMP,
                expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
                admin_notes TEXT
            );
        `);
        
        console.log('✅ Tabela leads_requests criada');
        
        // Adicionar coluna credits_reserved na tabela users
        const checkUserColumn = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'credits_reserved'
        `);
        
        if (checkUserColumn.rows.length === 0) {
            await pool.query(`
                ALTER TABLE users ADD COLUMN credits_reserved INTEGER DEFAULT 0;
            `);
            console.log('✅ Coluna credits_reserved adicionada na tabela users');
        }
        
        // Criar índices
        await pool.query(`
            CREATE INDEX idx_leads_requests_user_id ON leads_requests(user_id);
            CREATE INDEX idx_leads_requests_status ON leads_requests(status);
            CREATE INDEX idx_leads_requests_expires_at ON leads_requests(expires_at);
        `);
        
        console.log('✅ Índices criados');
        
        res.json({
            success: true,
            message: 'Tabela leads_requests criada com sucesso!',
            status: 'created'
        });
    } catch (error) {
        console.error('❌ Erro ao criar tabela:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.stack
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ 
            success: true, 
            message: 'Conexão com banco de dados OK',
            timestamp: result.rows[0].now 
        });
    } catch (error) {
        console.error('❌ Erro ao testar DB:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Erro ao conectar com banco de dados' 
        });
    }
});

// ENDPOINT TEMPORÁRIO PARA VERIFICAR CRÉDITOS
app.get('/api/admin/check-credits/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const result = await pool.query(
            'SELECT id, name, email, credits_balance, created_at, updated_at FROM users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Usuário não encontrado' });
        }
        
        res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Erro ao verificar créditos:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Registro
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;

        console.log('📝 Tentativa de registro:', { name, email });

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
        }

        // Verificar se usuário já existe
        const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'Email já cadastrado' });
        }

        // Hash da senha
        const password_hash = await bcrypt.hash(password, 10);

        // Inserir usuário
        const result = await pool.query(
            'INSERT INTO users (name, email, phone, password_hash, credits_balance, role, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, credits_balance, role',
            [name, email, password_hash, 0, 'user', 'active']
        );

        const user = result.rows[0];

        // Enviar email de boas-vindas
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
        console.error('❌ Erro no registro:', error);
        res.status(500).json({ error: 'Erro ao registrar usuário' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        console.log('🔐 Tentativa de login:', email);

        if (!email || !password) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
        }

        // Buscar usuário
        const result = await pool.query(
            'SELECT id, name, email, password_hash, credits_balance, role, status FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        const user = result.rows[0];

        // Verificar senha
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        // Verificar status da conta
        if (user.status !== 'active') {
            return res.status(403).json({ error: 'Conta inativa' });
        }

        // Gerar token JWT
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

// Perfil do usuário
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

// Atualizar perfil do usuário
app.put('/api/auth/profile', authMiddleware, async (req, res) => {
    try {
        const { name, phone } = req.body;

        console.log('📝 Atualizando perfil do usuário:', req.userId);

        if (!name) {
            return res.status(400).json({ error: 'Nome é obrigatório' });
        }

        await pool.query(
            'UPDATE users SET name = $1, phone = $2 WHERE id = $3',
            [name, phone || null, req.userId]
        );

        console.log('✅ Perfil atualizado com sucesso');

        res.json({ message: 'Perfil atualizado com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao atualizar perfil:', error);
        res.status(500).json({ error: 'Erro ao atualizar perfil' });
    }
});

// Alterar senha do usuário logado
app.put('/api/auth/password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        console.log('🔐 Solicitação de alteração de senha para usuário:', req.userId);

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres' });
        }

        // Buscar usuário com senha hash
        const result = await pool.query(
            'SELECT id, password_hash FROM users WHERE id = $1',
            [req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const user = result.rows[0];

        // Verificar senha atual
        const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
        
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Senha atual incorreta' });
        }

        // Hash da nova senha
        const newPasswordHash = await bcrypt.hash(newPassword, 10);

        // Atualizar senha
        await pool.query(
            'UPDATE users SET password_hash = $1 WHERE id = $2',
            [newPasswordHash, req.userId]
        );

        console.log('✅ Senha alterada com sucesso para usuário:', req.userId);

        res.json({ message: 'Senha alterada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao alterar senha:', error);
        res.status(500).json({ error: 'Erro ao alterar senha' });
    }
});

// Esqueci minha senha
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        console.log('🔑 Solicitação de recuperação de senha:', email);

        const result = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Email não encontrado' });
        }

        const user = result.rows[0];
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hora

        await pool.query(
            'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
            [resetToken, resetTokenExpiry, user.id]
        );

        const resetUrl = `https://leadsparatodos.com/reset-password.html?token=${resetToken}`;

        await sendEmail(
            email,
            'Recuperação de Senha - Leads Para Todos',
            emailTemplates.resetPassword(user.name, resetUrl)
        );

        console.log('✅ Email de recuperação enviado para:', email);

        res.json({ message: 'Email de recuperação enviado com sucesso' });
    } catch (error) {
        console.error('❌ Erro na recuperação de senha:', error);
        res.status(500).json({ error: 'Erro ao processar recuperação de senha' });
    }
});

// Resetar senha
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        console.log('🔄 Tentativa de reset de senha');

        const result = await pool.query(
            'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Token inválido ou expirado' });
        }

        const userId = result.rows[0].id;
        const password_hash = await bcrypt.hash(newPassword, 10);

        await pool.query(
            'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
            [password_hash, userId]
        );

        console.log('✅ Senha resetada com sucesso para usuário:', userId);

        res.json({ message: 'Senha alterada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao resetar senha:', error);
        res.status(500).json({ error: 'Erro ao resetar senha' });
    }
});

// ==================== ROTAS DE HISTÓRICO DE DÉBITOS ====================

// Buscar histórico de débitos do usuário
app.get('/api/user/debit-history', authMiddleware, async (req, res) => {
    try {
        console.log('📊 Buscando histórico de débitos para usuário:', req.userId);

        const result = await pool.query(`
            SELECT 
                id,
                amount,
                description,
                created_at
            FROM credit_transactions
            WHERE user_id = $1 AND type = 'debit'
            ORDER BY created_at DESC
            LIMIT 50
        `, [req.userId]);

        // Calcular total debitado
        const totalResult = await pool.query(`
            SELECT COALESCE(SUM(amount), 0) as total
            FROM credit_transactions
            WHERE user_id = $1 AND type = 'debit'
        `, [req.userId]);

        const totalDebited = parseInt(totalResult.rows[0].total);

        console.log(`✅ Histórico recuperado: ${result.rows.length} débitos, total: ${totalDebited}`);

        res.json({
            success: true,
            debits: result.rows,
            total_debited: totalDebited
        });
    } catch (error) {
        console.error('❌ Erro ao buscar débitos:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro ao buscar histórico de débitos' 
        });
    }
});

// ==================== 🆕 ROTAS DE HISTÓRICO DE BUSCAS (NOVO) ====================

// Salvar busca no banco de dados
app.post('/api/leads/save-search', authMiddleware, async (req, res) => {
    try {
        const { filters, leads_found } = req.body;

        console.log('💾 Salvando busca para usuário:', req.userId);

        if (!filters) {
            return res.status(400).json({ error: 'Filtros são obrigatórios' });
        }

        const result = await pool.query(`
            INSERT INTO search_history (user_id, filters, leads_found)
            VALUES ($1, $2, $3)
            RETURNING id, created_at
        `, [req.userId, JSON.stringify(filters), leads_found || 0]);

        const search = result.rows[0];

        console.log('✅ Busca salva com sucesso:', search.id);

        res.json({
            success: true,
            search_id: search.id,
            created_at: search.created_at
        });
    } catch (error) {
        console.error('❌ Erro ao salvar busca:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro ao salvar busca' 
        });
    }
});

// Listar histórico de buscas do usuário
app.get('/api/leads/search-history', authMiddleware, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;

        console.log(`📚 Buscando histórico (últimas ${limit} buscas) para usuário:`, req.userId);

        const result = await pool.query(`
            SELECT 
                id,
                filters,
                leads_found,
                created_at
            FROM search_history
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2
        `, [req.userId, limit]);

        console.log(`✅ ${result.rows.length} buscas encontradas`);

        res.json({
            success: true,
            searches: result.rows
        });
    } catch (error) {
        console.error('❌ Erro ao buscar histórico:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro ao buscar histórico de buscas' 
        });
    }
});

// Obter estatísticas de buscas do usuário
app.get('/api/leads/stats', authMiddleware, async (req, res) => {
    try {
        console.log('📊 Buscando estatísticas para usuário:', req.userId);

        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_searches,
                COALESCE(SUM(leads_found), 0) as total_leads
            FROM search_history
            WHERE user_id = $1
        `, [req.userId]);

        const stats = {
            buscas: parseInt(result.rows[0].total_searches),
            totalLeads: parseInt(result.rows[0].total_leads)
        };

        console.log('✅ Estatísticas:', stats);

        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        console.error('❌ Erro ao buscar estatísticas:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro ao buscar estatísticas',
            stats: { buscas: 0, totalLeads: 0 } // Fallback
        });
    }
});

// ==================== ROTAS DE PAGAMENTO ====================

// Processar pagamento com CARTÃO
app.post('/api/payment/process-card', authMiddleware, async (req, res) => {
    try {
        console.log('💳 [CARTÃO] Recebendo pagamento via CARTÃO...');
        console.log('📦 [CARTÃO] Body completo:', JSON.stringify(req.body, null, 2));

        const { package_id, payment_data, coupon, discount, final_price } = req.body;

        // Validar dados obrigatórios
        if (!package_id || !payment_data) {
            console.log('❌ [CARTÃO] Dados obrigatórios faltando');
            return res.status(400).json({ error: 'Dados de pagamento incompletos' });
        }

        // Buscar pacote ou criar pacote personalizado
        let selectedPackage;
        
        if (package_id === 'personalizado' || package_id === 'package_custom') {
            // Pacote personalizado
            const { credits, amount } = req.body;
            if (!credits || credits < 1000) {
                return res.status(400).json({ error: 'Quantidade mínima de créditos é 1.000' });
            }
            
            // O amount do frontend já vem em centavos
            let priceInCents = amount || (credits * 14);
            
            // Se o amount veio como número decimal (reais), converter para centavos
            if (amount && amount < 100 && credits >= 1000) {
                priceInCents = Math.round(amount * 100);
            }
            
            selectedPackage = {
                id: 'package_custom',
                name: `${credits.toLocaleString('pt-BR')} Créditos (Personalizado)`,
                credits: credits,
                price: priceInCents // Preço em centavos
            };
            console.log('✅ [CARTÃO] Pacote PERSONALIZADO criado:', selectedPackage);
        } else {
            // Pacote fixo
            selectedPackage = PACKAGES[package_id];
            if (!selectedPackage) {
                console.log('❌ [CARTÃO] Pacote não encontrado:', package_id);
                return res.status(400).json({ error: 'Pacote inválido' });
            }
            console.log('✅ [CARTÃO] Pacote FIXO encontrado:', selectedPackage);
        }

        // Buscar dados do usuário
        const userResult = await pool.query(
            'SELECT id, name, email FROM users WHERE id = $1',
            [req.userId]
        );

        if (userResult.rows.length === 0) {
            console.log('❌ [CARTÃO] Usuário não encontrado:', req.userId);
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const user = userResult.rows[0];
        console.log('✅ [CARTÃO] Usuário encontrado:', user);

        // Aplicar cupom se fornecido
        let finalPrice = selectedPackage.price;
        let discountAmount = 0;
        let appliedCoupon = null;

        if (coupon) {
            appliedCoupon = validateCoupon(coupon);
            if (appliedCoupon) {
                discountAmount = calculateDiscount(selectedPackage.price, appliedCoupon);
                finalPrice = selectedPackage.price - discountAmount;
                console.log(`✅ [CARTÃO] Cupom aplicado: ${coupon} - ${appliedCoupon.discount}%`);
                console.log(`💰 [CARTÃO] Preço original: R$ ${(selectedPackage.price / 100).toFixed(2)}`);
                console.log(`💰 [CARTÃO] Desconto: R$ ${(discountAmount / 100).toFixed(2)}`);
                console.log(`💰 [CARTÃO] Preço final: R$ ${(finalPrice / 100).toFixed(2)}`);
            }
        }

        // Criar registro de transação
        const transactionResult = await pool.query(
            `INSERT INTO transactions 
            (user_id, package_id, amount, status, payment_method, credits, coupon_code, discount_amount) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
            RETURNING id`,
            [
                user.id,
                selectedPackage.id,
                finalPrice,
                'pending',
                'credit_card',
                selectedPackage.credits,
                appliedCoupon?.code || null,
                discountAmount
            ]
        );

        const transactionId = transactionResult.rows[0].id;
        console.log('✅ [CARTÃO] Transação criada:', transactionId);

        // Preparar payload para Mercado Pago
        const paymentPayload = {
            transaction_amount: finalPrice / 100, // Converter centavos para reais
            token: payment_data.token,
            description: selectedPackage.name,
            installments: payment_data.installments || 1,
            payment_method_id: payment_data.payment_method_id,
            payer: {
                email: user.email,
                identification: {
                    type: payment_data.payer?.identification?.type || 'CPF',
                    number: payment_data.payer?.identification?.number || '00000000000'
                }
            },
            notification_url: `${process.env.BACKEND_URL}/api/webhook/mercadopago`,
            external_reference: transactionId.toString()
        };

        console.log('🚀 [CARTÃO] Enviando pagamento para Mercado Pago...');
        console.log('📤 [CARTÃO] Payload:', JSON.stringify(paymentPayload, null, 2));

        // Criar pagamento no Mercado Pago
        const payment = await mercadopago.payment.create(paymentPayload);

        console.log('📥 [CARTÃO] Resposta Mercado Pago:', JSON.stringify(payment.body, null, 2));

        // Atualizar transação com payment_id
        await pool.query(
            'UPDATE transactions SET payment_id = $1, status = $2 WHERE id = $3',
            [payment.body.id, payment.body.status, transactionId]
        );

        // Se pagamento aprovado, adicionar créditos
        if (payment.body.status === 'approved') {
            console.log('✅ [CARTÃO] Pagamento APROVADO! Adicionando créditos...');
            
            await pool.query(
                'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
                [selectedPackage.credits, user.id]
            );

            await pool.query(
                'UPDATE transactions SET status = $1 WHERE id = $2',
                ['approved', transactionId]
            );

            // Enviar email de confirmação
            await sendEmail(
                user.email,
                'Pagamento Aprovado - Leads Para Todos',
                emailTemplates.paymentApproved(user.name, selectedPackage.credits, selectedPackage.name)
            );

            console.log(`✅ [CARTÃO] Créditos adicionados! Novo saldo: ${selectedPackage.credits}`);
        }

        res.json({
            success: true,
            status: payment.body.status,
            payment_id: payment.body.id,
            transaction_id: transactionId
        });

    } catch (error) {
        console.error('❌ [CARTÃO] Erro ao processar pagamento:', error);
        res.status(500).json({ 
            error: 'Erro ao processar pagamento',
            details: error.message 
        });
    }
});

// Processar pagamento com PIX
app.post('/api/payment/process-pix', authMiddleware, async (req, res) => {
    try {
        console.log('💳 [PIX] Recebendo pagamento via PIX...');
        console.log('📦 [PIX] Body completo:', JSON.stringify(req.body, null, 2));

        const { package_id, amount, credits, coupon, discount } = req.body;

        // Validar dados obrigatórios
        if (!package_id) {
            console.log('❌ [PIX] package_id não fornecido');
            return res.status(400).json({ error: 'Pacote não especificado' });
        }

        // Buscar pacote ou criar pacote personalizado
        let selectedPackage;
        
        if (package_id === 'personalizado' || package_id === 'package_custom') {
            // Pacote personalizado
            if (!credits || credits < 1000) {
                return res.status(400).json({ error: 'Quantidade mínima de créditos é 1.000' });
            }
            
            // O amount do frontend já vem em centavos
            let priceInCents = amount || (credits * 14);
            
            // Se o amount veio como número decimal (reais), converter para centavos
            if (amount && amount < 100 && credits >= 1000) {
                priceInCents = Math.round(amount * 100);
            }
            
            selectedPackage = {
                id: 'package_custom',
                name: `${credits.toLocaleString('pt-BR')} Créditos (Personalizado)`,
                credits: credits,
                price: priceInCents // Preço em centavos
            };
            console.log('✅ [PIX] Pacote PERSONALIZADO criado:', selectedPackage);
        } else {
            // Pacote fixo
            selectedPackage = PACKAGES[package_id];
            if (!selectedPackage) {
                console.log('❌ [PIX] Pacote não encontrado:', package_id);
                console.log('📋 [PIX] Pacotes disponíveis:', Object.keys(PACKAGES));
                return res.status(400).json({ error: 'Pacote inválido' });
            }
            console.log('✅ [PIX] Pacote FIXO encontrado:', selectedPackage);
        }

        // Buscar dados do usuário
        const userResult = await pool.query(
            'SELECT id, name, email FROM users WHERE id = $1',
            [req.userId]
        );

        if (userResult.rows.length === 0) {
            console.log('❌ [PIX] Usuário não encontrado:', req.userId);
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const user = userResult.rows[0];
        console.log('✅ [PIX] Usuário encontrado:', { id: user.id, name: user.name, email: user.email });

        // Aplicar cupom se fornecido
        let finalPrice = selectedPackage.price;
        let discountAmount = 0;
        let appliedCoupon = null;

        if (coupon) {
            appliedCoupon = validateCoupon(coupon);
            if (appliedCoupon) {
                discountAmount = calculateDiscount(selectedPackage.price, appliedCoupon);
                finalPrice = selectedPackage.price - discountAmount;
                console.log(`✅ [PIX] Cupom aplicado: ${coupon} - ${appliedCoupon.discount}%`);
                console.log(`💰 [PIX] Preço original: R$ ${(selectedPackage.price / 100).toFixed(2)}`);
                console.log(`💰 [PIX] Desconto: R$ ${(discountAmount / 100).toFixed(2)}`);
                console.log(`💰 [PIX] Preço final: R$ ${(finalPrice / 100).toFixed(2)}`);
            }
        }

        // Criar registro de transação
        const transactionResult = await pool.query(
            `INSERT INTO transactions 
            (user_id, package_id, amount, status, payment_method, credits, coupon_code, discount_amount) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
            RETURNING id`,
            [
                user.id,
                selectedPackage.id,
                finalPrice,
                'pending',
                'pix',
                selectedPackage.credits,
                appliedCoupon?.code || null,
                discountAmount
            ]
        );

        const transactionId = transactionResult.rows[0].id;
        console.log('✅ [PIX] Transação criada:', transactionId);

        // Preparar payload para Mercado Pago PIX
        const pixPayload = {
            transaction_amount: finalPrice / 100, // Converter centavos para reais
            description: selectedPackage.name,
            payment_method_id: 'pix',
            payer: {
                email: user.email,
                first_name: user.name.split(' ')[0],
                last_name: user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0]
            },
            notification_url: `${process.env.BACKEND_URL}/api/webhook/mercadopago`,
            external_reference: transactionId.toString()
        };

        console.log('🚀 [PIX] Enviando pagamento PIX para Mercado Pago...');
        console.log('📤 [PIX] Payload:', JSON.stringify(pixPayload, null, 2));

        // Criar pagamento PIX no Mercado Pago
        const payment = await mercadopago.payment.create(pixPayload);

        console.log('📥 [PIX] Resposta Mercado Pago:', JSON.stringify(payment.body, null, 2));

        // Atualizar transação com payment_id
        await pool.query(
            'UPDATE transactions SET payment_id = $1, status = $2 WHERE id = $3',
            [payment.body.id, payment.body.status, transactionId]
        );

        // Extrair dados do QR Code
        const qrCodeData = payment.body.point_of_interaction?.transaction_data;
        
        if (!qrCodeData || !qrCodeData.qr_code_base64) {
            console.error('❌ [PIX] QR Code não gerado pelo Mercado Pago');
            return res.status(500).json({ error: 'Erro ao gerar QR Code' });
        }

        console.log('✅ [PIX] QR Code gerado com sucesso');
        console.log('🔍 [PIX] QR Code Base64 length:', qrCodeData.qr_code_base64?.length);
        console.log('🔍 [PIX] QR Code Text length:', qrCodeData.qr_code?.length);

        res.json({
            success: true,
            payment_id: payment.body.id,
            transaction_id: transactionId,
            qr_code_base64: qrCodeData.qr_code_base64,
            qr_code: qrCodeData.qr_code,
            qr_code_text: qrCodeData.qr_code,
            amount: finalPrice / 100
        });

    } catch (error) {
        console.error('❌ [PIX] Erro ao processar pagamento:', error);
        res.status(500).json({ 
            error: 'Erro ao processar pagamento PIX',
            details: error.message 
        });
    }
});

// Webhook do Mercado Pago
app.post('/api/webhook/mercadopago', async (req, res) => {
    try {
        console.log('🔔 [WEBHOOK] Notificação recebida do Mercado Pago');
        console.log('📦 [WEBHOOK] Body:', JSON.stringify(req.body, null, 2));

        const { type, data } = req.body;

        // Responder imediatamente ao Mercado Pago
        res.sendStatus(200);

        if (type === 'payment') {
            const paymentId = data.id;
            console.log('💳 [WEBHOOK] Processando pagamento:', paymentId);

            // Buscar informações do pagamento no Mercado Pago
            const payment = await mercadopago.payment.get(paymentId);
            console.log('📥 [WEBHOOK] Status do pagamento:', payment.body.status);

            if (payment.body.status === 'approved') {
                console.log('✅ [WEBHOOK] Pagamento APROVADO! Adicionando créditos...');

                const externalReference = payment.body.external_reference;

                // Buscar transação
                const transactionResult = await pool.query(
                    'SELECT t.id, t.user_id, t.credits, t.status, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.id = $1',
                    [externalReference]
                );

                if (transactionResult.rows.length === 0) {
                    console.error('❌ [WEBHOOK] Transação não encontrada:', externalReference);
                    return;
                }

                const transaction = transactionResult.rows[0];

                // Verificar se já foi processado
                if (transaction.status === 'approved') {
                    console.log('⚠️ [WEBHOOK] Pagamento já processado anteriormente');
                    return;
                }

                // Adicionar créditos
                await pool.query(
                    'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
                    [transaction.credits, transaction.user_id]
                );

                // Atualizar status da transação
                await pool.query(
                    'UPDATE transactions SET status = $1 WHERE id = $2',
                    ['approved', transaction.id]
                );

                // Enviar email de confirmação
                await sendEmail(
                    transaction.email,
                    'Pagamento Aprovado - Leads Para Todos',
                    emailTemplates.paymentApproved(
                        transaction.name,
                        transaction.credits,
                        `${transaction.credits.toLocaleString('pt-BR')} Créditos`
                    )
                );

                console.log(`✅ [WEBHOOK] Créditos adicionados! Usuário: ${transaction.user_id}, Créditos: ${transaction.credits}`);
            }
        }
    } catch (error) {
        console.error('❌ [WEBHOOK] Erro ao processar webhook:', error);
    }
});

// Verificar status de pagamento
app.get('/api/payment/status/:payment_id', authMiddleware, async (req, res) => {
    try {
        const { payment_id } = req.params;

        const payment = await mercadopago.payment.get(payment_id);

        res.json({
            status: payment.body.status,
            status_detail: payment.body.status_detail
        });
    } catch (error) {
        console.error('❌ Erro ao verificar status do pagamento:', error);
        res.status(500).json({ error: 'Erro ao verificar status do pagamento' });
    }
});

// Listar transações do usuário
app.get('/api/transactions', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, package_id, amount, status, payment_method, credits, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
            [req.userId]
        );

        res.json({ transactions: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar transações:', error);
        res.status(500).json({ error: 'Erro ao buscar transações' });
    }
});

// ==================== ROTAS DE SOLICITAÇÕES DE LEADS ====================

// Criar solicitação de leads (reservar créditos)
app.post('/api/leads-requests', authMiddleware, async (req, res) => {
    try {
        const { credits_requested, filters, whatsapp_message } = req.body;
        
        console.log('📝 [LEADS-REQUEST] Nova solicitação:', { userId: req.userId, credits: credits_requested });
        
        // Validar créditos solicitados
        if (!credits_requested || credits_requested < 1000) {
            return res.status(400).json({ error: 'Quantidade mínima é 1.000 créditos' });
        }
        
        // Buscar dados do usuário
        const userResult = await pool.query(
            'SELECT id, name, email, credits_balance, credits_reserved FROM users WHERE id = $1',
            [req.userId]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }
        
        const user = userResult.rows[0];
        const creditsReserved = user.credits_reserved || 0;
        const creditsAvailable = user.credits_balance - creditsReserved;
        
        console.log('💰 [LEADS-REQUEST] Créditos disponíveis:', creditsAvailable);
        
        // Verificar se tem créditos suficientes
        if (creditsAvailable < credits_requested) {
            return res.status(400).json({ 
                error: 'Créditos insuficientes',
                available: creditsAvailable,
                requested: credits_requested
            });
        }
        
        // Criar solicitação
        const requestResult = await pool.query(`
            INSERT INTO leads_requests 
            (user_id, credits_requested, status, filters, whatsapp_message, created_at, expires_at) 
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + INTERVAL '24 hours') 
            RETURNING *
        `, [user.id, credits_requested, 'pending', JSON.stringify(filters), whatsapp_message]);
        
        const request = requestResult.rows[0];
        
        // Atualizar créditos reservados do usuário
        await pool.query(
            'UPDATE users SET credits_reserved = credits_reserved + $1 WHERE id = $2',
            [credits_requested, user.id]
        );
        
        console.log('✅ [LEADS-REQUEST] Solicitação criada:', request.id);
        console.log('🔒 [LEADS-REQUEST] Créditos reservados:', credits_requested);
        
        res.json({
            success: true,
            request: request,
            credits_remaining: creditsAvailable - credits_requested
        });
        
    } catch (error) {
        console.error('❌ [LEADS-REQUEST] Erro:', error);
        res.status(500).json({ error: 'Erro ao criar solicitação' });
    }
});

// Listar solicitações do usuário
app.get('/api/leads-requests', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM leads_requests 
            WHERE user_id = $1 
            ORDER BY created_at DESC
        `, [req.userId]);
        
        res.json({ requests: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar solicitações:', error);
        res.status(500).json({ error: 'Erro ao buscar solicitações' });
    }
});

// Cancelar solicitação (cliente)
app.post('/api/leads-requests/:id/cancel', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Buscar solicitação
        const requestResult = await pool.query(
            'SELECT * FROM leads_requests WHERE id = $1 AND user_id = $2',
            [id, req.userId]
        );
        
        if (requestResult.rows.length === 0) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        const request = requestResult.rows[0];
        
        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Solicitação já foi processada' });
        }
        
        // Liberar créditos reservados
        await pool.query(
            'UPDATE users SET credits_reserved = credits_reserved - $1 WHERE id = $2',
            [request.credits_requested, req.userId]
        );
        
        // Marcar como cancelada
        await pool.query(
            'UPDATE leads_requests SET status = $1, cancelled_at = NOW() WHERE id = $2',
            ['cancelled', id]
        );
        
        console.log('🚫 [LEADS-REQUEST] Solicitação cancelada:', id);
        
        res.json({ success: true, message: 'Solicitação cancelada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao cancelar solicitação:', error);
        res.status(500).json({ error: 'Erro ao cancelar solicitação' });
    }
});

// ==================== ROTAS ADMIN - GERENCIAR SOLICITAÇÕES ====================

// Listar todas as solicitações (admin)
app.get('/api/admin/leads-requests', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { status } = req.query;
        
        let query = `
            SELECT 
                lr.*,
                u.name as user_name,
                u.email as user_email,
                u.credits_balance
            FROM leads_requests lr
            JOIN users u ON lr.user_id = u.id
        `;
        
        const params = [];
        
        if (status) {
            query += ' WHERE lr.status = $1';
            params.push(status);
        }
        
        query += ' ORDER BY lr.created_at DESC';
        
        const result = await pool.query(query, params);
        
        res.json({ requests: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar solicitações admin:', error);
        res.status(500).json({ error: 'Erro ao buscar solicitações' });
    }
});

// Confirmar entrega (admin)
app.post('/api/admin/leads-requests/:id/confirm', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_notes } = req.body;
        
        // Buscar solicitação
        const requestResult = await pool.query(
            'SELECT * FROM leads_requests WHERE id = $1',
            [id]
        );
        
        if (requestResult.rows.length === 0) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        const request = requestResult.rows[0];
        
        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Solicitação já foi processada' });
        }
        
        // Debitar créditos do usuário
        await pool.query(`
            UPDATE users 
            SET 
                credits_balance = credits_balance - $1,
                credits_reserved = credits_reserved - $1
            WHERE id = $2
        `, [request.credits_requested, request.user_id]);
        
        // Marcar como confirmada
        await pool.query(`
            UPDATE leads_requests 
            SET 
                status = $1, 
                confirmed_at = NOW(),
                admin_notes = $2
            WHERE id = $3
        `, ['confirmed', admin_notes, id]);
        
        console.log('✅ [LEADS-REQUEST-ADMIN] Entrega confirmada:', id);
        console.log('💰 [LEADS-REQUEST-ADMIN] Créditos debitados:', request.credits_requested);
        
        res.json({ success: true, message: 'Entrega confirmada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao confirmar entrega:', error);
        res.status(500).json({ error: 'Erro ao confirmar entrega' });
    }
});

// Cancelar solicitação (admin)
app.post('/api/admin/leads-requests/:id/cancel', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_notes } = req.body;
        
        // Buscar solicitação
        const requestResult = await pool.query(
            'SELECT * FROM leads_requests WHERE id = $1',
            [id]
        );
        
        if (requestResult.rows.length === 0) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        const request = requestResult.rows[0];
        
        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Solicitação já foi processada' });
        }
        
        // Liberar créditos reservados
        await pool.query(
            'UPDATE users SET credits_reserved = credits_reserved - $1 WHERE id = $2',
            [request.credits_requested, request.user_id]
        );
        
        // Marcar como cancelada
        await pool.query(`
            UPDATE leads_requests 
            SET 
                status = $1, 
                cancelled_at = NOW(),
                admin_notes = $2
            WHERE id = $3
        `, ['cancelled', admin_notes, id]);
        
        console.log('🚫 [LEADS-REQUEST-ADMIN] Solicitação cancelada:', id);
        
        res.json({ success: true, message: 'Solicitação cancelada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao cancelar solicitação (admin):', error);
        res.status(500).json({ error: 'Erro ao cancelar solicitação' });
    }
});

// Job para liberar créditos expirados (executar a cada hora)
app.get('/api/cron/expire-requests', async (req, res) => {
    try {
        console.log('⏰ [CRON] Verificando solicitações expiradas...');
        
        // Buscar solicitações pendentes e expiradas
        const expiredResult = await pool.query(`
            SELECT * FROM leads_requests 
            WHERE status = 'pending' 
            AND expires_at < NOW()
        `);
        
        const expired = expiredResult.rows;
        
        if (expired.length === 0) {
            console.log('✅ [CRON] Nenhuma solicitação expirada');
            return res.json({ success: true, expired_count: 0 });
        }
        
        console.log(`⚠️ [CRON] ${expired.length} solicitações expiradas encontradas`);
        
        // Processar cada uma
        for (const request of expired) {
            // Liberar créditos
            await pool.query(
                'UPDATE users SET credits_reserved = credits_reserved - $1 WHERE id = $2',
                [request.credits_requested, request.user_id]
            );
            
            // Marcar como expirada
            await pool.query(
                'UPDATE leads_requests SET status = $1, cancelled_at = NOW() WHERE id = $2',
                ['expired', request.id]
            );
            
            console.log(`🔓 [CRON] Créditos liberados: ${request.credits_requested} (Request ID: ${request.id})`);
        }
        
        console.log(`✅ [CRON] ${expired.length} solicitações expiradas processadas`);
        
        res.json({ 
            success: true, 
            expired_count: expired.length,
            requests: expired.map(r => ({ id: r.id, credits: r.credits_requested }))
        });
    } catch (error) {
        console.error('❌ [CRON] Erro ao processar expirações:', error);
        res.status(500).json({ error: 'Erro ao processar expirações' });
    }
});

// ==================== ROTAS ADMIN ====================

// Dashboard admin
app.get('/api/admin/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        // Total de usuários
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        
        // Total de transações
        const transactionsCount = await pool.query('SELECT COUNT(*) FROM credit_transactions WHERE type = $1', ['credit']);
        
        // Total de créditos vendidos
        const creditsResult = await pool.query('SELECT SUM(amount) FROM credit_transactions WHERE type = $1', ['credit']);
        
        // Total de vendas (14% do valor dos créditos)
        const totalCredits = parseInt(creditsResult.rows[0].sum || 0);
        const totalSales = (totalCredits * 0.14);
        
        // Vendas por dia nos últimos 30 dias
        const salesByDayResult = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                SUM(amount) as credits
            FROM credit_transactions
            WHERE type = 'credit'
            AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);

        const salesByDay = salesByDayResult.rows.map(row => ({
            date: row.date,
            revenue: (parseInt(row.credits) * 0.14)
        }));

        res.json({
            totalUsers: parseInt(usersCount.rows[0].count),
            totalTransactions: parseInt(transactionsCount.rows[0].count),
            totalCreditsSold: totalCredits,
            totalSales: totalSales,
            salesByDay: salesByDay
        });
    } catch (error) {
        console.error('❌ Erro ao buscar dados do dashboard:', error);
        res.status(500).json({ error: 'Erro ao buscar dados do dashboard' });
    }
});

// Listar usuários (admin)
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { search } = req.query;
        
        let query = 'SELECT id, name, email, phone, credits_balance, role, status, created_at FROM users';
        const params = [];
        
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
        res.status(500).json({ error: 'Erro ao buscar usuário' });
    }
});

// Atualizar usuário (admin)
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
        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, name, email, credits_balance, role, status`;
        
        const result = await pool.query(query, values);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }
        
        console.log('✅ Usuário atualizado:', userId);
        res.json({ user: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao atualizar usuário:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário' });
    }
});

// Listar transações (admin)
app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { status } = req.query;
        
        let query = `
            SELECT 
                t.id,
                t.user_id,
                t.package_id,
                t.amount,
                t.status,
                t.payment_method,
                t.credits,
                t.created_at,
                u.name as user_name,
                u.email as user_email
            FROM transactions t
            JOIN users u ON t.user_id = u.id
        `;
        
        const params = [];
        
        if (status) {
            query += ' WHERE t.status = $1';
            params.push(status);
        }
        
        query += ' ORDER BY t.created_at DESC LIMIT 100';
        
        const result = await pool.query(query, params);
        
        res.json({ transactions: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar transações:', error);
        res.status(500).json({ error: 'Erro ao buscar transações' });
    }
});

// Exportar transações (placeholder)
app.get('/api/admin/export/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    res.json({ message: 'Funcionalidade de exportação em desenvolvimento' });
});

// Exportar usuários (placeholder)
app.get('/api/admin/export/users', authMiddleware, adminMiddleware, async (req, res) => {
    res.json({ message: 'Funcionalidade de exportação em desenvolvimento' });
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
    console.log(`║     ✅ Rotas Admin: ATIVAS                           ║`);
    console.log(`║     📚 Histórico de Buscas: ATIVO (banco de dados)  ║`);
    console.log('╚═══════════════════════════════════════════════════════╝\n');
});
