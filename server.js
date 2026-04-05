require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mercadopago = require('mercadopago');
const { Resend } = require('resend');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração do Mercado Pago
mercadopago.configure({
    access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
});

// Configuração do banco de dados PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://leads_db_90v6_user:IjQ1fCYqLscWn6eTRgmm3BKUiXS0x3VZ@dpg-cu06eha3esus73928j3g-a.oregon-postgres.render.com/leads_db_90v6',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Inicializar Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// ==================== PACOTES DE CRÉDITOS ====================
const PACKAGES = {
    '5k': { credits: 5000, price: 700.00, name: '5.000 Créditos' },
    '10k': { credits: 10000, price: 1200.00, name: '10.000 Créditos' },
    '20k': { credits: 20000, price: 2000.00, name: '20.000 Créditos' },
    '50k': { credits: 50000, price: 4500.00, name: '50.000 Créditos' }
};

// ==================== CUPONS DE DESCONTO ====================
const COUPONS = {
    'TESTE99': { discount: 99, type: 'percentage', description: 'Desconto de teste de 99%' },
    'BEMVINDO10': { discount: 10, type: 'percentage', description: 'Desconto de boas-vindas de 10%' }
};

// Função para validar cupom
function validateCoupon(code) {
    const coupon = COUPONS[code.toUpperCase()];
    return coupon ? { valid: true, ...coupon } : { valid: false };
}

// Função para calcular desconto
function calculateDiscount(price, couponCode) {
    const validation = validateCoupon(couponCode);
    if (!validation.valid) return { finalPrice: price, discount: 0 };

    const discount = (price * validation.discount) / 100;
    const finalPrice = price - discount;

    return {
        originalPrice: price,
        discount: discount,
        finalPrice: finalPrice,
        couponApplied: couponCode.toUpperCase()
    };
}

// ==================== MIDDLEWARES ====================
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({
    origin: [
        'https://jkvzqvlk.gensparkspace.com',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    credentials: true
}));
app.use(express.json());

// Middleware de autenticação
const authMiddleware = (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Token não fornecido' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'leads-secret-key-2024');
        req.userId = decoded.userId;
        next();
    } catch (error) {
        console.error('❌ Erro na autenticação:', error);
        return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
};

// Middleware de admin
const adminMiddleware = (req, res, next) => {
    pool.query('SELECT role FROM users WHERE id = $1', [req.userId])
        .then(result => {
            if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
                return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
            }
            next();
        })
        .catch(error => {
            console.error('❌ Erro ao verificar permissão:', error);
            res.status(500).json({ error: 'Erro ao verificar permissão' });
        });
};

// ==================== TEMPLATES DE EMAIL ====================
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
                .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎉 Bem-vindo ao Leads Para Todos!</h1>
                </div>
                <div class="content">
                    <p>Olá, <strong>${name}</strong>!</p>
                    <p>Sua conta foi criada com sucesso! Agora você tem acesso à melhor plataforma de leads do mercado.</p>
                    <p>Comece agora mesmo a encontrar os leads perfeitos para seu negócio!</p>
                    <center>
                        <a href="https://jkvzqvlk.gensparkspace.com/dashboard.html" class="button">Acessar Plataforma</a>
                    </center>
                    <p>Se você tiver alguma dúvida, nossa equipe está sempre disponível para ajudar.</p>
                </div>
                <div class="footer">
                    <p>© 2024 Leads Para Todos. Todos os direitos reservados.</p>
                </div>
            </div>
        </body>
        </html>
    `,
    
    paymentApproved: (name, credits, packageName) => `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                .credits-box { background: white; padding: 20px; border-left: 4px solid #10b981; margin: 20px 0; border-radius: 5px; }
                .button { display: inline-block; padding: 12px 30px; background: #10b981; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>✅ Pagamento Aprovado!</h1>
                </div>
                <div class="content">
                    <p>Olá, <strong>${name}</strong>!</p>
                    <p>Ótimas notícias! Seu pagamento foi aprovado com sucesso.</p>
                    <div class="credits-box">
                        <h3>📦 Pacote Adquirido: ${packageName}</h3>
                        <h2 style="color: #10b981; margin: 10px 0;">💎 ${credits.toLocaleString('pt-BR')} Créditos</h2>
                        <p>Seus créditos já estão disponíveis em sua conta!</p>
                    </div>
                    <p>Agora você pode começar a buscar e exportar leads ilimitados.</p>
                    <center>
                        <a href="https://jkvzqvlk.gensparkspace.com/dashboard.html" class="button">Começar Agora</a>
                    </center>
                </div>
                <div class="footer">
                    <p>© 2024 Leads Para Todos. Todos os direitos reservados.</p>
                </div>
            </div>
        </body>
        </html>
    `,

    resetPassword: (name, resetUrl) => `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 5px; }
                .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🔐 Recuperação de Senha</h1>
                </div>
                <div class="content">
                    <p>Olá, <strong>${name}</strong>!</p>
                    <p>Recebemos uma solicitação para redefinir sua senha.</p>
                    <p>Clique no botão abaixo para criar uma nova senha:</p>
                    <center>
                        <a href="${resetUrl}" class="button">Redefinir Senha</a>
                    </center>
                    <div class="warning">
                        <p><strong>⚠️ Atenção:</strong></p>
                        <ul>
                            <li>Este link expira em <strong>1 hora</strong></li>
                            <li>Se você não solicitou esta alteração, ignore este email</li>
                            <li>Nunca compartilhe este link com outras pessoas</li>
                        </ul>
                    </div>
                    <p>Se o botão não funcionar, copie e cole este link no navegador:</p>
                    <p style="word-break: break-all; color: #667eea;">${resetUrl}</p>
                </div>
                <div class="footer">
                    <p>© 2024 Leads Para Todos. Todos os direitos reservados.</p>
                </div>
            </div>
        </body>
        </html>
    `
};

// Função auxiliar para enviar emails
async function sendEmail(to, subject, html) {
    try {
        if (!process.env.RESEND_API_KEY) {
            console.log('⚠️ RESEND_API_KEY não configurada - Email não será enviado');
            return { success: false };
        }

        const { data, error } = await resend.emails.send({
            from: 'Leads Para Todos <onboarding@resend.dev>',
            to: [to],
            subject: subject,
            html: html
        });

        if (error) {
            console.error('❌ Erro ao enviar email:', error);
            return { success: false, error };
        }

        console.log('✅ Email enviado com sucesso:', data);
        return { success: true, data };
    } catch (error) {
        console.error('❌ Erro ao enviar email:', error);
        return { success: false, error };
    }
}

// ==================== ROTAS DE SAÚDE ====================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ 
            status: 'Database connected', 
            timestamp: result.rows[0].now 
        });
    } catch (error) {
        console.error('❌ Erro ao conectar ao banco:', error);
        res.status(500).json({ error: 'Database connection failed' });
    }
});

// ==================== ROTAS ADMINISTRATIVAS ====================

// Rota para corrigir estrutura do banco
app.post('/api/admin/fix-database-columns', async (req, res) => {
    try {
        console.log('🔧 Iniciando correção das colunas do banco...');

        await pool.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255),
            ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMP;
        `);

        console.log('✅ Colunas adicionadas/verificadas com sucesso');
        res.json({ message: 'Estrutura do banco corrigida com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao corrigir banco:', error);
        res.status(500).json({ error: error.message });
    }
});

// Rota para criar tabela de solicitações de leads
app.post('/api/admin/setup-leads-requests', async (req, res) => {
    try {
        console.log('🔧 Criando tabela de solicitações de leads...');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS leads_requests (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                request_type VARCHAR(50) NOT NULL,
                search_params JSONB NOT NULL,
                credits_reserved INTEGER NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                result_data JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Tabela leads_requests criada/verificada com sucesso');
        res.json({ message: 'Tabela de solicitações criada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao criar tabela:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Registro de usuário
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;

        console.log('📝 Tentativa de registro:', { name, email, phone });

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
        }

        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email já cadastrado' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            'INSERT INTO users (name, email, password_hash, phone, credits_balance, role, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email, credits_balance',
            [name, email, password_hash, phone || null, 0, 'user', 'active']
        );

        const user = result.rows[0];

        await sendEmail(
            email,
            'Bem-vindo ao Leads Para Todos! 🎉',
            emailTemplates.welcome(name)
        );

        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET || 'leads-secret-key-2024',
            { expiresIn: '7d' }
        );

        console.log('✅ Usuário registrado com sucesso:', user.id);

        res.status(201).json({
            message: 'Usuário registrado com sucesso',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits: user.credits_balance
            }
        });
    } catch (error) {
        console.error('❌ Erro no registro:', error);
        res.status(500).json({ error: 'Erro ao registrar usuário' });
    }
});

// Login de usuário
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        console.log('🔐 Tentativa de login:', email);

        if (!email || !password) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
        }

        const result = await pool.query(
            'SELECT id, name, email, password_hash, role, status FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Email ou senha inválidos' });
        }

        const user = result.rows[0];

        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (!isValidPassword) {
            return res.status(401).json({ error: 'Email ou senha inválidos' });
        }

        if (user.status !== 'active') {
            return res.status(403).json({ error: 'Conta inativa. Entre em contato com o suporte.' });
        }

        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET || 'leads-secret-key-2024',
            { expiresIn: '7d' }
        );

        console.log('✅ Login realizado com sucesso:', user.id);

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email
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

        const resetUrl = `https://jkvzqvlk.gensparkspace.com/reset-password.html?token=${resetToken}`;

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

// ==================== ROTAS DE PAGAMENTO ====================

// Processar pagamento com CARTÃO
app.post('/api/payment/process-card', authMiddleware, async (req, res) => {
    try {
        console.log('💳 [CARTÃO] Recebendo pagamento via CARTÃO...');
        console.log('📦 [CARTÃO] Body completo:', JSON.stringify(req.body, null, 2));

        const { 
            packageId, 
            cardToken, 
            installments = 1,
            couponCode
        } = req.body;

        if (!packageId || !cardToken) {
            return res.status(400).json({ error: 'Dados incompletos para pagamento' });
        }

        const packageData = PACKAGES[packageId];
        if (!packageData) {
            return res.status(400).json({ error: 'Pacote inválido' });
        }

        let finalPrice = packageData.price;
        let discountInfo = null;

        if (couponCode) {
            const discount = calculateDiscount(packageData.price, couponCode);
            if (discount.couponApplied) {
                finalPrice = discount.finalPrice;
                discountInfo = discount;
                console.log('🎟️ [CARTÃO] Cupom aplicado:', discountInfo);
            }
        }

        const userResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [req.userId]);
        const user = userResult.rows[0];

        console.log('💰 [CARTÃO] Criando pagamento no Mercado Pago...');

        const payment = await mercadopago.payment.create({
            transaction_amount: finalPrice,
            token: cardToken,
            description: `${packageData.name} - Leads Para Todos`,
            installments: parseInt(installments),
            payment_method_id: 'visa',
            payer: {
                email: user.email
            }
        });

        console.log('📋 [CARTÃO] Resposta do Mercado Pago:', {
            id: payment.body.id,
            status: payment.body.status,
            status_detail: payment.body.status_detail
        });

        const transactionResult = await pool.query(
            `INSERT INTO credit_transactions 
            (user_id, amount, credits, type, payment_method, payment_id, status, package_id, coupon_code, discount_amount) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
            RETURNING id`,
            [
                req.userId,
                finalPrice,
                packageData.credits,
                'credit',
                'card',
                payment.body.id.toString(),
                payment.body.status,
                packageId,
                discountInfo?.couponApplied || null,
                discountInfo?.discount || 0
            ]
        );

        if (payment.body.status === 'approved') {
            await pool.query(
                'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
                [packageData.credits, req.userId]
            );

            await sendEmail(
                user.email,
                'Pagamento Aprovado - Créditos Liberados! 🎉',
                emailTemplates.paymentApproved(user.name, packageData.credits, packageData.name)
            );

            console.log('✅ [CARTÃO] Pagamento aprovado e créditos adicionados');
        }

        res.json({
            success: true,
            transactionId: transactionResult.rows[0].id,
            paymentId: payment.body.id,
            status: payment.body.status,
            statusDetail: payment.body.status_detail,
            credits: packageData.credits,
            finalPrice: finalPrice,
            discountApplied: discountInfo
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
        console.log('💰 [PIX] Recebendo solicitação de pagamento PIX...');
        console.log('📦 [PIX] Body completo:', JSON.stringify(req.body, null, 2));

        const { packageId, couponCode } = req.body;

        if (!packageId) {
            return res.status(400).json({ error: 'Pacote não especificado' });
        }

        const packageData = PACKAGES[packageId];
        if (!packageData) {
            return res.status(400).json({ error: 'Pacote inválido' });
        }

        let finalPrice = packageData.price;
        let discountInfo = null;

        if (couponCode) {
            const discount = calculateDiscount(packageData.price, couponCode);
            if (discount.couponApplied) {
                finalPrice = discount.finalPrice;
                discountInfo = discount;
                console.log('🎟️ [PIX] Cupom aplicado:', discountInfo);
            }
        }

        const userResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [req.userId]);
        const user = userResult.rows[0];

        console.log('💰 [PIX] Criando pagamento no Mercado Pago...');

        const payment = await mercadopago.payment.create({
            transaction_amount: finalPrice,
            description: `${packageData.name} - Leads Para Todos`,
            payment_method_id: 'pix',
            payer: {
                email: user.email,
                first_name: user.name
            }
        });

        console.log('📋 [PIX] Resposta do Mercado Pago:', {
            id: payment.body.id,
            status: payment.body.status
        });

        const qrCode = payment.body.point_of_interaction?.transaction_data?.qr_code;
        const qrCodeBase64 = payment.body.point_of_interaction?.transaction_data?.qr_code_base64;

        if (!qrCode) {
            throw new Error('QR Code não gerado pelo Mercado Pago');
        }

        const transactionResult = await pool.query(
            `INSERT INTO credit_transactions 
            (user_id, amount, credits, type, payment_method, payment_id, status, package_id, coupon_code, discount_amount) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
            RETURNING id`,
            [
                req.userId,
                finalPrice,
                packageData.credits,
                'credit',
                'pix',
                payment.body.id.toString(),
                'pending',
                packageId,
                discountInfo?.couponApplied || null,
                discountInfo?.discount || 0
            ]
        );

        console.log('✅ [PIX] Transação registrada. Aguardando pagamento...');

        res.json({
            success: true,
            transactionId: transactionResult.rows[0].id,
            paymentId: payment.body.id,
            qrCode: qrCode,
            qrCodeBase64: qrCodeBase64,
            status: 'pending',
            credits: packageData.credits,
            finalPrice: finalPrice,
            discountApplied: discountInfo
        });

    } catch (error) {
        console.error('❌ [PIX] Erro ao gerar PIX:', error);
        res.status(500).json({ 
            error: 'Erro ao gerar código PIX',
            details: error.message 
        });
    }
});

// Webhook do Mercado Pago
app.post('/api/webhook/mercadopago', async (req, res) => {
    try {
        console.log('🔔 Webhook recebido do Mercado Pago');
        console.log('📦 Body:', JSON.stringify(req.body, null, 2));

        const { type, data } = req.body;

        if (type === 'payment') {
            const paymentId = data.id;

            const payment = await mercadopago.payment.get(paymentId);
            console.log('💳 Status do pagamento:', payment.body.status);

            if (payment.body.status === 'approved') {
                const transactionResult = await pool.query(
                    'SELECT * FROM credit_transactions WHERE payment_id = $1',
                    [paymentId.toString()]
                );

                if (transactionResult.rows.length > 0) {
                    const transaction = transactionResult.rows[0];

                    await pool.query(
                        'UPDATE credit_transactions SET status = $1 WHERE id = $2',
                        ['approved', transaction.id]
                    );

                    await pool.query(
                        'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
                        [transaction.credits, transaction.user_id]
                    );

                    const userResult = await pool.query(
                        'SELECT email, name FROM users WHERE id = $1',
                        [transaction.user_id]
                    );
                    const user = userResult.rows[0];

                    const packageData = PACKAGES[transaction.package_id];

                    await sendEmail(
                        user.email,
                        'Pagamento Aprovado - Créditos Liberados! 🎉',
                        emailTemplates.paymentApproved(user.name, transaction.credits, packageData.name)
                    );

                    console.log('✅ Webhook processado: créditos adicionados');
                }
            }
        }

        res.status(200).json({ received: true });
    } catch (error) {
        console.error('❌ Erro ao processar webhook:', error);
        res.status(500).json({ error: 'Erro ao processar webhook' });
    }
});

// Verificar status de pagamento
app.get('/api/payment/status/:paymentId', authMiddleware, async (req, res) => {
    try {
        const { paymentId } = req.params;

        const payment = await mercadopago.payment.get(paymentId);

        res.json({
            status: payment.body.status,
            statusDetail: payment.body.status_detail
        });
    } catch (error) {
        console.error('❌ Erro ao verificar status:', error);
        res.status(500).json({ error: 'Erro ao verificar status do pagamento' });
    }
});

// Listar transações do usuário
app.get('/api/payment/transactions', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, amount, credits, type, payment_method, status, package_id, coupon_code, discount_amount, created_at 
            FROM credit_transactions 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 50`,
            [req.userId]
        );

        res.json({ transactions: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar transações:', error);
        res.status(500).json({ error: 'Erro ao buscar transações' });
    }
});

// ==================== ROTAS DE SOLICITAÇÕES DE LEADS ====================

// Criar solicitação de leads
app.post('/api/leads/request', authMiddleware, async (req, res) => {
    try {
        const { requestType, searchParams, creditsRequired } = req.body;

        const userResult = await pool.query(
            'SELECT credits_balance FROM users WHERE id = $1',
            [req.userId]
        );

        const currentCredits = userResult.rows[0].credits_balance;

        if (currentCredits < creditsRequired) {
            return res.status(400).json({ error: 'Créditos insuficientes' });
        }

        await pool.query(
            'UPDATE users SET credits_balance = credits_balance - $1 WHERE id = $2',
            [creditsRequired, req.userId]
        );

        const requestResult = await pool.query(
            `INSERT INTO leads_requests 
            (user_id, request_type, search_params, credits_reserved, status) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id`,
            [req.userId, requestType, JSON.stringify(searchParams), creditsRequired, 'pending']
        );

        res.json({
            success: true,
            requestId: requestResult.rows[0].id,
            message: 'Solicitação criada com sucesso'
        });
    } catch (error) {
        console.error('❌ Erro ao criar solicitação:', error);
        res.status(500).json({ error: 'Erro ao criar solicitação' });
    }
});

// Listar solicitações do usuário
app.get('/api/leads/requests', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, request_type, search_params, credits_reserved, status, created_at 
            FROM leads_requests 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 50`,
            [req.userId]
        );

        res.json({ requests: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar solicitações:', error);
        res.status(500).json({ error: 'Erro ao buscar solicitações' });
    }
});

// Cancelar solicitação pendente
app.post('/api/leads/request/:id/cancel', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        const requestResult = await pool.query(
            'SELECT credits_reserved, status FROM leads_requests WHERE id = $1 AND user_id = $2',
            [id, req.userId]
        );

        if (requestResult.rows.length === 0) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }

        const request = requestResult.rows[0];

        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Apenas solicitações pendentes podem ser canceladas' });
        }

        await pool.query(
            'UPDATE leads_requests SET status = $1 WHERE id = $2',
            ['cancelled', id]
        );

        await pool.query(
            'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
            [request.credits_reserved, req.userId]
        );

        res.json({ success: true, message: 'Solicitação cancelada e créditos devolvidos' });
    } catch (error) {
        console.error('❌ Erro ao cancelar solicitação:', error);
        res.status(500).json({ error: 'Erro ao cancelar solicitação' });
    }
});

// ==================== ROTAS ADMIN ====================

// Dashboard admin
app.get('/api/admin/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const usersResult = await pool.query('SELECT COUNT(*) as total FROM users');
        const totalUsers = parseInt(usersResult.rows[0].total);

        const creditsResult = await pool.query(`
            SELECT 
                SUM(credits) as total_credits,
                SUM(amount) as total_revenue
            FROM credit_transactions 
            WHERE type = 'credit' AND status = 'approved'
        `);

        const totalCreditsSold = parseInt(creditsResult.rows[0].total_credits) || 0;
        const totalSales = (totalCreditsSold * 0.14);

        const salesByDayResult = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                SUM(amount) as total
            FROM credit_transactions
            WHERE type = 'credit' AND status = 'approved'
            AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);

        res.json({
            totalUsers,
            totalCreditsSold,
            totalSales,
            salesByDay: salesByDayResult.rows
        });
    } catch (error) {
        console.error('❌ Erro ao buscar dashboard:', error);
        res.status(500).json({ error: 'Erro ao buscar dados do dashboard' });
    }
});

// Listar usuários (admin)
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { search } = req.query;

        let query = `
            SELECT id, name, email, phone, credits_balance, role, status, created_at 
            FROM users
        `;
        let params = [];

        if (search) {
            query += ` WHERE name ILIKE $1 OR email ILIKE $1`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY created_at DESC LIMIT 100`;

        const result = await pool.query(query, params);

        res.json({ users: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar usuários:', error);
        res.status(500).json({ error: 'Erro ao buscar usuários' });
    }
});

// Detalhes de um usuário (admin)
app.get('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;

        const userResult = await pool.query(
            'SELECT id, name, email, phone, credits_balance, role, status, created_at FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const transactionsResult = await pool.query(
            `SELECT id, amount, credits, type, payment_method, status, created_at 
            FROM credit_transactions 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 50`,
            [userId]
        );

        res.json({
            user: userResult.rows[0],
            transactions: transactionsResult.rows
        });
    } catch (error) {
        console.error('❌ Erro ao buscar detalhes do usuário:', error);
        res.status(500).json({ error: 'Erro ao buscar detalhes do usuário' });
    }
});

// Atualizar usuário (admin)
app.put('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const { creditsBalance, role, status } = req.body;

        const currentUserResult = await pool.query(
            'SELECT credits_balance FROM users WHERE id = $1',
            [userId]
        );

        if (currentUserResult.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const currentCredits = currentUserResult.rows[0].credits_balance;
        const creditDifference = creditsBalance - currentCredits;

        await pool.query(
            'UPDATE users SET credits_balance = $1, role = $2, status = $3 WHERE id = $4',
            [creditsBalance, role, status, userId]
        );

        if (creditDifference !== 0) {
            const transactionType = creditDifference > 0 ? 'credit' : 'debit';
            const transactionAmount = Math.abs(creditDifference);

            await pool.query(
                `INSERT INTO credit_transactions 
                (user_id, amount, credits, type, payment_method, status, package_id) 
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [userId, 0, transactionAmount, transactionType, 'admin_adjustment', 'approved', 'admin']
            );
        }

        res.json({ message: 'Usuário atualizado com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao atualizar usuário:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário' });
    }
});

// Listar transações (admin)
app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { status, paymentMethod } = req.query;

        let query = `
            SELECT 
                ct.id, ct.user_id, ct.amount, ct.credits, ct.type, 
                ct.payment_method, ct.status, ct.package_id, ct.created_at,
                u.name as user_name, u.email as user_email
            FROM credit_transactions ct
            JOIN users u ON ct.user_id = u.id
            WHERE 1=1
        `;
        let params = [];
        let paramCount = 1;

        if (status) {
            query += ` AND ct.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (paymentMethod) {
            query += ` AND ct.payment_method = $${paramCount}`;
            params.push(paymentMethod);
            paramCount++;
        }

        query += ` ORDER BY ct.created_at DESC LIMIT 100`;

        const result = await pool.query(query, params);

        res.json({ transactions: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar transações:', error);
        res.status(500).json({ error: 'Erro ao buscar transações' });
    }
});

// Exportar transações (admin) - Placeholder
app.get('/api/admin/export/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        res.json({ message: 'Funcionalidade de exportação em desenvolvimento' });
    } catch (error) {
        console.error('❌ Erro:', error);
        res.status(500).json({ error: 'Erro ao exportar' });
    }
});

// Exportar usuários (admin) - Placeholder
app.get('/api/admin/export/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        res.json({ message: 'Funcionalidade de exportação em desenvolvimento' });
    } catch (error) {
        console.error('❌ Erro:', error);
        res.status(500).json({ error: 'Erro ao exportar' });
    }
});

// Listar solicitações de leads (admin)
app.get('/api/admin/leads-requests', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { status } = req.query;

        let query = `
            SELECT 
                lr.id, lr.user_id, lr.request_type, lr.search_params, 
                lr.credits_reserved, lr.status, lr.created_at,
                u.name as user_name, u.email as user_email
            FROM leads_requests lr
            JOIN users u ON lr.user_id = u.id
            WHERE 1=1
        `;
        let params = [];

        if (status) {
            query += ` AND lr.status = $1`;
            params.push(status);
        }

        query += ` ORDER BY lr.created_at DESC LIMIT 100`;

        const result = await pool.query(query, params);

        res.json({ requests: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar solicitações:', error);
        res.status(500).json({ error: 'Erro ao buscar solicitações' });
    }
});

// Confirmar solicitação de leads (admin)
app.post('/api/admin/leads-requests/:id/confirm', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { resultData } = req.body;

        await pool.query(
            'UPDATE leads_requests SET status = $1, result_data = $2, updated_at = NOW() WHERE id = $3',
            ['completed', JSON.stringify(resultData), id]
        );

        res.json({ success: true, message: 'Solicitação confirmada com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao confirmar solicitação:', error);
        res.status(500).json({ error: 'Erro ao confirmar solicitação' });
    }
});

// Cancelar solicitação de leads (admin)
app.post('/api/admin/leads-requests/:id/cancel', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        const requestResult = await pool.query(
            'SELECT user_id, credits_reserved FROM leads_requests WHERE id = $1',
            [id]
        );

        if (requestResult.rows.length === 0) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }

        const request = requestResult.rows[0];

        await pool.query(
            'UPDATE leads_requests SET status = $1 WHERE id = $2',
            ['cancelled', id]
        );

        await pool.query(
            'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
            [request.credits_reserved, request.user_id]
        );

        res.json({ success: true, message: 'Solicitação cancelada e créditos devolvidos' });
    } catch (error) {
        console.error('❌ Erro ao cancelar solicitação:', error);
        res.status(500).json({ error: 'Erro ao cancelar solicitação' });
    }
});

// Cron para expirar solicitações pendentes antigas
app.post('/api/admin/cron/expire-requests', async (req, res) => {
    try {
        const expiredRequests = await pool.query(
            `SELECT id, user_id, credits_reserved 
            FROM leads_requests 
            WHERE status = 'pending' AND created_at < NOW() - INTERVAL '7 days'`
        );

        for (const request of expiredRequests.rows) {
            await pool.query(
                'UPDATE leads_requests SET status = $1 WHERE id = $2',
                ['expired', request.id]
            );

            await pool.query(
                'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
                [request.credits_reserved, request.user_id]
            );
        }

        res.json({ 
            success: true, 
            expired: expiredRequests.rows.length,
            message: `${expiredRequests.rows.length} solicitações expiradas` 
        });
    } catch (error) {
        console.error('❌ Erro ao expirar solicitações:', error);
        res.status(500).json({ error: 'Erro ao expirar solicitações' });
    }
});

// Nova rota para histórico de débitos do usuário
app.get('/api/user/debit-history', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT amount, credits, created_at 
            FROM credit_transactions 
            WHERE user_id = $1 AND type = 'debit' 
            ORDER BY created_at DESC 
            LIMIT 50`,
            [req.userId]
        );

        const totalDebited = result.rows.reduce((sum, row) => sum + parseInt(row.credits || 0), 0);

        res.json({ 
            debits: result.rows,
            totalDebited 
        });
    } catch (error) {
        console.error('❌ Erro ao buscar histórico de débitos:', error);
        res.status(500).json({ error: 'Erro ao buscar histórico de débitos' });
    }
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                                                            ║');
    console.log('║           🚀 LEADS PARA TODOS - API BACKEND 🚀            ║');
    console.log('║                                                            ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`🌍 Servidor rodando na porta: ${PORT}`);
    console.log(`📍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🌐 Frontend URL: https://jkvzqvlk.gensparkspace.com`);
    console.log('');
    console.log('📊 Serviços configurados:');
    console.log(`   ${process.env.MERCADOPAGO_ACCESS_TOKEN ? '✅' : '❌'} Mercado Pago`);
    console.log(`   ${process.env.RESEND_API_KEY ? '✅' : '❌'} Resend Email`);
    console.log(`   ${process.env.DATABASE_URL ? '✅' : '❌'} PostgreSQL Database`);
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  Sistema pronto! Aguardando requisições...               ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
});
