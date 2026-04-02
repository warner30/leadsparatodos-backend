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

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Registro
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

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
            'INSERT INTO users (name, email, password_hash, credits_balance, role, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, credits_balance, role',
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
            selectedPackage = {
                id: 'package_custom',
                name: `${credits.toLocaleString('pt-BR')} Créditos (Personalizado)`,
                credits: credits,
                price: amount || final_price || (credits * 14) // Preço em centavos
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
            selectedPackage = {
                id: 'package_custom',
                name: `${credits.toLocaleString('pt-BR')} Créditos (Personalizado)`,
                credits: credits,
                price: amount || (credits * 14) // Preço em centavos
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

// ==================== ROTAS ADMIN ====================

// Dashboard admin
app.get('/api/admin/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        const transactionsCount = await pool.query('SELECT COUNT(*) FROM transactions');
        const revenue = await pool.query('SELECT SUM(amount) FROM transactions WHERE status = $1', ['approved']);

        res.json({
            users: parseInt(usersCount.rows[0].count),
            transactions: parseInt(transactionsCount.rows[0].count),
            revenue: parseFloat(revenue.rows[0].sum || 0) / 100
        });
    } catch (error) {
        console.error('❌ Erro ao buscar dashboard admin:', error);
        res.status(500).json({ error: 'Erro ao buscar dados do dashboard' });
    }
});

// Listar usuários (admin)
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, credits_balance, role, status, created_at FROM users ORDER BY created_at DESC'
        );

        res.json({ users: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar usuários:', error);
        res.status(500).json({ error: 'Erro ao buscar usuários' });
    }
});

// ==================== INICIAR SERVIDOR ====================
// ==================== DÉBITO MANUAL DE CRÉDITOS (ADMIN) ====================

app.post('/api/admin/debit-credits', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { user_id, amount, reason } = req.body;
        
        console.log('💳 [ADMIN-DEBIT] Nova solicitação:', { user_id, amount, reason });
        
        // Validar dados
        if (!user_id || !amount || !reason) {
            return res.status(400).json({ error: 'Dados incompletos' });
        }
        
        if (amount <= 0) {
            return res.status(400).json({ error: 'Quantidade deve ser maior que zero' });
        }
        
        // Buscar usuário
        const userResult = await pool.query(
            'SELECT id, name, email, credits_balance FROM users WHERE id = $1',
            [user_id]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }
        
        const user = userResult.rows[0];
        
        // Verificar créditos suficientes
        if (user.credits_balance < amount) {
            return res.status(400).json({ 
                error: 'Créditos insuficientes',
                current_balance: user.credits_balance,
                requested: amount
            });
        }
        
        // Debitar créditos
        const newBalance = user.credits_balance - amount;
        
        await pool.query(
            'UPDATE users SET credits_balance = $1 WHERE id = $2',
            [newBalance, user_id]
        );
        
        console.log(`✅ [ADMIN-DEBIT] Débito realizado`);
        console.log(`   Usuário: ${user.name} (${user.email})`);
        console.log(`   Saldo anterior: ${user.credits_balance}`);
        console.log(`   Debitado: ${amount}`);
        console.log(`   Novo saldo: ${newBalance}`);
        console.log(`   Motivo: ${reason}`);
        
        res.json({
            success: true,
            message: 'Créditos debitados com sucesso',
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            },
            previous_balance: user.credits_balance,
            debited_amount: amount,
            new_balance: newBalance,
            reason: reason
        });
        
    } catch (error) {
        console.error('❌ [ADMIN-DEBIT] Erro:', error);
        res.status(500).json({ error: 'Erro ao debitar créditos' });
    }
});

// Registrar solicitação simples (histórico apenas - opcional)
app.post('/api/leads-requests/simple', authMiddleware, async (req, res) => {
    try {
        const { credits_requested, filters, whatsapp_message } = req.body;
        
        console.log('📝 [LEADS-REQUEST-SIMPLE] Registrando histórico:', { 
            userId: req.userId, 
            credits: credits_requested 
        });
        
        // Apenas registrar no histórico, NÃO RESERVAR CRÉDITOS
        const requestResult = await pool.query(`
            INSERT INTO leads_requests 
            (user_id, credits_requested, status, filters, whatsapp_message, created_at) 
            VALUES ($1, $2, 'pending_manual', $3, $4, NOW()) 
            RETURNING *
        `, [req.userId, credits_requested, JSON.stringify(filters), whatsapp_message]);
        
        const request = requestResult.rows[0];
        
        console.log('✅ [LEADS-REQUEST-SIMPLE] Histórico registrado:', request.id);
        
        res.json({
            success: true,
            request: request
        });
        
    } catch (error) {
        console.error('❌ [LEADS-REQUEST-SIMPLE] Erro:', error);
        // Não retorna erro, apenas registra
        res.json({ success: true, request: null });
    }
});


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
