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

// ✅ Configuração do Mercado Pago com credenciais de PRODUÇÃO
mercadopago.configure({
    access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
});
console.log('✅ Mercado Pago configurado com Access Token de PRODUÇÃO');

// Configuração do banco de dados PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Erro ao conectar ao banco de dados:', err.stack);
    }
    console.log('✅ Conectado ao banco de dados PostgreSQL');
    release();
});

// Middlewares
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ SISTEMA DE CUPONS DE DESCONTO
const COUPONS = {
    'TESTE99': {
        code: 'TESTE99',
        discount: 99, // 99% de desconto
        type: 'percentage',
        active: true,
        description: 'Cupom de teste com 99% de desconto'
    },
    'BEMVINDO10': {
        code: 'BEMVINDO10',
        discount: 10,
        type: 'percentage',
        active: true,
        description: 'Cupom de boas-vindas com 10% de desconto'
    }
};

// Função para validar cupom
function validateCoupon(couponCode) {
    if (!couponCode) return null;
    
    const coupon = COUPONS[couponCode.toUpperCase()];
    
    if (!coupon || !coupon.active) {
        return null;
    }
    
    return coupon;
}

// Função para calcular desconto
function calculateDiscount(originalPrice, coupon) {
    if (!coupon) return 0;
    
    if (coupon.type === 'percentage') {
        return (originalPrice * coupon.discount) / 100;
    }
    
    if (coupon.type === 'fixed') {
        return Math.min(coupon.discount, originalPrice);
    }
    
    return 0;
}

// Função para enviar email via Resend
async function sendEmail(to, subject, html) {
    try {
        if (!process.env.RESEND_API_KEY) {
            console.log('⚠️ RESEND_API_KEY não configurada - Email não enviado:', { to, subject });
            return { success: false, message: 'RESEND_API_KEY não configurada' };
        }

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
            },
            body: JSON.stringify({
                from: 'Leads Para Todos <noreply@leadsparatodos.com>',
                to: [to],
                subject: subject,
                html: html
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('❌ Erro ao enviar email:', data);
            return { success: false, message: data.message };
        }

        console.log('✅ Email enviado com sucesso:', { to, subject, id: data.id });
        return { success: true, id: data.id };
    } catch (error) {
        console.error('❌ Erro ao enviar email:', error);
        return { success: false, message: error.message };
    }
}

// Templates de email
const emailTemplates = {
    welcome: (name, email) => `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 20px;">
                <tr>
                    <td align="center">
                        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                            <tr>
                                <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; text-align: center;">
                                    <h1 style="color: #ffffff; margin: 0; font-size: 28px;">Bem-vindo ao Leads Para Todos!</h1>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 40px;">
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Olá <strong>${name}</strong>,</p>
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Sua conta foi criada com sucesso! Estamos muito felizes em ter você conosco.</p>
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Email cadastrado: <strong>${email}</strong></p>
                                    <div style="text-align: center; margin: 30px 0;">
                                        <a href="${process.env.FRONTEND_URL || 'https://leadsparatodos.com'}/login.html" style="background-color: #667eea; color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">Acessar Dashboard</a>
                                    </div>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 14px; color: #666666;">
                                    <p style="margin: 0;">Leads Para Todos - Leads de qualidade para o seu negócio</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
    `,
    paymentApproved: (name, credits, amount) => `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 20px;">
                <tr>
                    <td align="center">
                        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                            <tr>
                                <td style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 40px; text-align: center;">
                                    <h1 style="color: #ffffff; margin: 0; font-size: 28px;">✅ Pagamento Aprovado!</h1>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 40px;">
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Olá <strong>${name}</strong>,</p>
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Seu pagamento foi aprovado com sucesso!</p>
                                    <div style="background-color: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
                                        <p style="margin: 5px 0; font-size: 16px; color: #333333;"><strong>Créditos adicionados:</strong> ${credits.toLocaleString('pt-BR')}</p>
                                        <p style="margin: 5px 0; font-size: 16px; color: #333333;"><strong>Valor pago:</strong> R$ ${(amount / 100).toFixed(2)}</p>
                                    </div>
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Seus créditos já estão disponíveis na sua conta!</p>
                                    <div style="text-align: center; margin: 30px 0;">
                                        <a href="${process.env.FRONTEND_URL || 'https://leadsparatodos.com'}/dashboard.html" style="background-color: #10b981; color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">Acessar Dashboard</a>
                                    </div>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 14px; color: #666666;">
                                    <p style="margin: 0;">Leads Para Todos - Leads de qualidade para o seu negócio</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
    `,
    passwordReset: (name, resetToken) => `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 20px;">
                <tr>
                    <td align="center">
                        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                            <tr>
                                <td style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px; text-align: center;">
                                    <h1 style="color: #ffffff; margin: 0; font-size: 28px;">Redefinir Senha</h1>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 40px;">
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Olá <strong>${name}</strong>,</p>
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Recebemos uma solicitação para redefinir sua senha.</p>
                                    <p style="font-size: 16px; color: #333333; line-height: 1.6;">Clique no botão abaixo para criar uma nova senha:</p>
                                    <div style="text-align: center; margin: 30px 0;">
                                        <a href="${process.env.FRONTEND_URL || 'https://leadsparatodos.com'}/reset-password.html?token=${resetToken}" style="background-color: #f59e0b; color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">Redefinir Senha</a>
                                    </div>
                                    <p style="font-size: 14px; color: #666666; line-height: 1.6;">Se você não solicitou essa redefinição, ignore este email.</p>
                                    <p style="font-size: 14px; color: #666666; line-height: 1.6;">Este link expira em 1 hora.</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 14px; color: #666666;">
                                    <p style="margin: 0;">Leads Para Todos - Leads de qualidade para o seu negócio</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
    `
};

// Rota de saúde
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Rota de teste do banco de dados
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({
            success: true,
            message: 'Conexão com banco de dados OK',
            timestamp: result.rows[0].now
        });
    } catch (error) {
        console.error('❌ Erro ao testar banco:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao conectar ao banco de dados',
            error: error.message
        });
    }
});

// Middleware de autenticação
const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Token não fornecido' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'leadsparatodos_secret_2024');
        req.userId = decoded.userId;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

// Middleware de admin
const adminMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Token não fornecido' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'leadsparatodos_secret_2024');
        
        const userResult = await pool.query(
            'SELECT role FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (userResult.rows.length === 0 || userResult.rows[0].role !== 'admin') {
            return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
        }

        req.userId = decoded.userId;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Registro de usuário
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
        }

        const existingUser = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );

        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email já cadastrado' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await pool.query(
            'INSERT INTO users (name, email, password, credits_balance, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, credits_balance, role, created_at',
            [name, email, hashedPassword, 0, 'user']
        );

        const user = result.rows[0];

        await sendEmail(
            email,
            'Bem-vindo ao Leads Para Todos!',
            emailTemplates.welcome(name, email)
        );

        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET || 'leadsparatodos_secret_2024',
            { expiresIn: '7d' }
        );

        res.status(201).json({
            message: 'Usuário registrado com sucesso',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits_balance: user.credits_balance,
                role: user.role,
                created_at: user.created_at
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

        if (!email || !password) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        const user = result.rows[0];

        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET || 'leadsparatodos_secret_2024',
            { expiresIn: '7d' }
        );

        res.json({
            message: 'Login realizado com sucesso',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits_balance: user.credits_balance,
                role: user.role,
                created_at: user.created_at
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
            'SELECT id, name, email, credits_balance, role, created_at FROM users WHERE id = $1',
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

// Recuperação de senha
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email é obrigatório' });
        }

        const result = await pool.query(
            'SELECT id, name FROM users WHERE email = $1',
            [email]
        );

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

        await sendEmail(
            email,
            'Redefinir Senha - Leads Para Todos',
            emailTemplates.passwordReset(user.name, resetToken)
        );

        res.json({ message: 'Email de recuperação enviado com sucesso' });
    } catch (error) {
        console.error('❌ Erro na recuperação de senha:', error);
        res.status(500).json({ error: 'Erro ao processar recuperação de senha' });
    }
});

// Redefinir senha
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token e nova senha são obrigatórios' });
        }

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

        res.json({ message: 'Senha redefinida com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao redefinir senha:', error);
        res.status(500).json({ error: 'Erro ao redefinir senha' });
    }
});

// ==================== ROTAS DE PAGAMENTO ====================

// Pacotes de créditos
const PACKAGES = {
    'package_5k': { id: 'package_5k', name: '5.000 Créditos', credits: 5000, price: 70000 }, // R$ 700
    'package_10k': { id: 'package_10k', name: '10.000 Créditos', credits: 10000, price: 130000 }, // R$ 1.300
    'package_20k': { id: 'package_20k', name: '20.000 Créditos', credits: 20000, price: 240000 }, // R$ 2.400
    'package_50k': { id: 'package_50k', name: '50.000 Créditos', credits: 50000, price: 550000 }, // R$ 5.500
};

// ✅ ROTA DE PAGAMENTO COM CARTÃO DE CRÉDITO (PRODUÇÃO)
app.post('/api/payment/process-card', authMiddleware, async (req, res) => {
    try {
        console.log('💳 [CARTÃO] Recebendo pagamento via cartão de crédito...');
        console.log('📦 [CARTÃO] Body recebido:', JSON.stringify(req.body, null, 2));
        
        const { package_id, payment_data, coupon, discount, final_price } = req.body;

        // ✅ SUPORTE A PACOTES PERSONALIZADOS
        let selectedPackage;
        
        if (package_id === 'package_custom' || package_id === 'personalizado') {
            // Pacote personalizado - extrair dados do body
            const customCredits = parseInt(req.body.credits) || 0;
            const customPrice = parseFloat(final_price) || 0;
            
            if (customCredits < 1000) {
                console.error('❌ [CARTÃO] Créditos insuficientes:', customCredits);
                return res.status(400).json({ error: 'Mínimo de 1.000 créditos' });
            }
            
            selectedPackage = {
                id: 'package_custom',
                name: `${customCredits.toLocaleString('pt-BR')} Créditos (Personalizado)`,
                credits: customCredits,
                price: Math.round(customPrice * 100) // Converter para centavos
            };
            
            console.log('✅ [CARTÃO] Pacote PERSONALIZADO criado:', selectedPackage);
        } else {
            // Pacote fixo
            selectedPackage = PACKAGES[package_id];
            if (!selectedPackage) {
                console.error('❌ [CARTÃO] Pacote não encontrado:', package_id);
                return res.status(400).json({ error: 'Pacote não encontrado' });
            }
            console.log('✅ [CARTÃO] Pacote FIXO encontrado:', selectedPackage);
        }

        // Buscar usuário
        const userResult = await pool.query(
            'SELECT id, name, email, credits_balance FROM users WHERE id = $1',
            [req.userId]
        );

        if (userResult.rows.length === 0) {
            console.error('❌ [CARTÃO] Usuário não encontrado:', req.userId);
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const user = userResult.rows[0];
        console.log('✅ [CARTÃO] Usuário encontrado:', { id: user.id, name: user.name, email: user.email });

        // Validar cupom se fornecido
        let appliedCoupon = null;
        let discountAmount = 0;
        let transactionAmount = selectedPackage.price;

        if (coupon) {
            appliedCoupon = validateCoupon(coupon);
            if (appliedCoupon) {
                discountAmount = calculateDiscount(selectedPackage.price, appliedCoupon);
                transactionAmount = selectedPackage.price - discountAmount;
                console.log('🎟️ [CARTÃO] Cupom aplicado:', {
                    code: appliedCoupon.code,
                    discount: appliedCoupon.discount,
                    originalPrice: selectedPackage.price / 100,
                    discountAmount: discountAmount / 100,
                    finalPrice: transactionAmount / 100
                });
            } else {
                console.warn('⚠️ [CARTÃO] Cupom inválido:', coupon);
            }
        }

        // Se final_price foi fornecido (compra personalizada), usar ele
        if (final_price !== undefined && package_id === 'package_custom') {
            transactionAmount = Math.round(final_price * 100); // Converter para centavos
            console.log('💰 [CARTÃO] Usando preço personalizado:', transactionAmount / 100);
        }

        // Criar referência externa
        const externalReference = `LP-${user.id}-${Date.now()}`;
        console.log('🔖 [CARTÃO] Referência externa criada:', externalReference);

        // Inserir transação pendente
        const transactionResult = await pool.query(
            `INSERT INTO transactions 
            (user_id, package_id, amount, credits, status, payment_method, external_reference, coupon_code, discount_amount, metadata) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
            RETURNING id`,
            [
                user.id,
                package_id,
                transactionAmount,
                selectedPackage.credits,
                'pending',
                'credit_card',
                externalReference,
                appliedCoupon ? appliedCoupon.code : null,
                discountAmount,
                JSON.stringify({
                    original_price: selectedPackage.price,
                    discount_applied: discountAmount,
                    final_price: transactionAmount
                })
            ]
        );

        const transactionId = transactionResult.rows[0].id;
        console.log('✅ [CARTÃO] Transação criada no banco:', transactionId);

        // ✅ PREPARAR DADOS DO PAGAMENTO PARA MERCADO PAGO (PRODUÇÃO)
        console.log('📤 [CARTÃO] Preparando payload para Mercado Pago...');
        console.log('🔑 [CARTÃO] payment_data recebido:', JSON.stringify(payment_data, null, 2));

        // ✅ O Mercado Pago Bricks envia o token do cartão dentro de payment_data
        const paymentPayload = {
            transaction_amount: transactionAmount / 100, // Converter centavos para reais
            token: payment_data.token, // ✅ Token do cartão de crédito
            description: `${selectedPackage.name} - ${selectedPackage.credits.toLocaleString('pt-BR')} leads`,
            installments: payment_data.installments || 1,
            payment_method_id: payment_data.payment_method_id || 'visa',
            payer: {
                email: payment_data.payer?.email || user.email,
                identification: payment_data.payer?.identification || {
                    type: 'CPF',
                    number: '00000000000'
                }
            },
            external_reference: externalReference,
            notification_url: `${process.env.BACKEND_URL || 'https://leadsparatodos-backend-production.up.railway.app'}/api/payment/webhook`,
            metadata: {
                user_id: user.id,
                user_name: user.name,
                user_email: user.email,
                package_id: package_id,
                credits: selectedPackage.credits,
                transaction_id: transactionId,
                coupon: appliedCoupon ? appliedCoupon.code : null,
                discount: discountAmount / 100
            }
        };

        console.log('📦 [CARTÃO] Payload Mercado Pago:', JSON.stringify(paymentPayload, null, 2));

        // ✅ ENVIAR PAGAMENTO PARA MERCADO PAGO (PRODUÇÃO)
        console.log('🚀 [CARTÃO] Enviando pagamento para Mercado Pago...');
        
        const paymentResponse = await mercadopago.payment.create(paymentPayload);

        console.log('✅ [CARTÃO] Resposta do Mercado Pago:', JSON.stringify(paymentResponse.body, null, 2));

        const paymentId = paymentResponse.body.id;
        const paymentStatus = paymentResponse.body.status;
        const paymentStatusDetail = paymentResponse.body.status_detail;

        // Atualizar transação com payment_id
        await pool.query(
            'UPDATE transactions SET payment_id = $1, status = $2, metadata = metadata || $3::jsonb WHERE id = $4',
            [
                paymentId,
                paymentStatus,
                JSON.stringify({
                    payment_status_detail: paymentStatusDetail,
                    payment_response: paymentResponse.body
                }),
                transactionId
            ]
        );

        console.log('✅ [CARTÃO] Transação atualizada com payment_id:', paymentId);

        // Se pagamento foi aprovado, adicionar créditos
        if (paymentStatus === 'approved') {
            console.log('🎉 [CARTÃO] Pagamento APROVADO! Adicionando créditos...');
            
            const newBalance = user.credits_balance + selectedPackage.credits;
            
            await pool.query(
                'UPDATE users SET credits_balance = $1 WHERE id = $2',
                [newBalance, user.id]
            );

            await pool.query(
                'UPDATE transactions SET status = $1, approved_at = NOW() WHERE id = $2',
                ['approved', transactionId]
            );

            console.log('✅ [CARTÃO] Créditos adicionados:', {
                userId: user.id,
                oldBalance: user.credits_balance,
                newBalance: newBalance,
                creditsAdded: selectedPackage.credits
            });

            // Enviar email de confirmação
            await sendEmail(
                user.email,
                'Pagamento Aprovado - Leads Para Todos',
                emailTemplates.paymentApproved(user.name, selectedPackage.credits, transactionAmount)
            );

            return res.json({
                success: true,
                message: 'Pagamento aprovado! Créditos adicionados com sucesso.',
                payment: {
                    status: paymentStatus,
                    status_detail: paymentStatusDetail,
                    payment_id: paymentId,
                    external_reference: externalReference,
                    credits_added: selectedPackage.credits,
                    new_balance: newBalance
                }
            });
        } else {
            console.log('⏳ [CARTÃO] Pagamento PENDENTE ou REJEITADO:', paymentStatus);
            
            return res.json({
                success: false,
                message: 'Pagamento em análise ou rejeitado.',
                payment: {
                    status: paymentStatus,
                    status_detail: paymentStatusDetail,
                    payment_id: paymentId,
                    external_reference: externalReference
                }
            });
        }

    } catch (error) {
        console.error('❌ [CARTÃO] Erro ao processar pagamento:', error);
        console.error('❌ [CARTÃO] Stack trace:', error.stack);
        console.error('❌ [CARTÃO] Error details:', JSON.stringify(error, null, 2));
        
        res.status(500).json({
            error: 'Erro ao processar pagamento',
            details: error.message,
            cause: error.cause || 'Erro desconhecido'
        });
    }
});

// ✅ ROTA DE PAGAMENTO PIX (PRODUÇÃO)
app.post('/api/payment/process-pix', authMiddleware, async (req, res) => {
    try {
        console.log('💳 [PIX] Recebendo pagamento via PIX...');
        console.log('📦 [PIX] Body recebido:', JSON.stringify(req.body, null, 2));
        
        const { package_id, amount, credits, coupon, discount } = req.body;

        // ✅ SUPORTE A PACOTES PERSONALIZADOS
        let selectedPackage;
        
        if (package_id === 'package_custom' || package_id === 'personalizado') {
            // Pacote personalizado
            const customCredits = parseInt(credits) || 0;
            const customPrice = parseFloat(amount) || 0;
            
            if (customCredits < 1000) {
                console.error('❌ [PIX] Créditos insuficientes:', customCredits);
                return res.status(400).json({ error: 'Mínimo de 1.000 créditos' });
            }
            
            selectedPackage = {
                id: 'package_custom',
                name: `${customCredits.toLocaleString('pt-BR')} Créditos (Personalizado)`,
                credits: customCredits,
                price: Math.round(customPrice * 100) // Converter para centavos
            };
            
            console.log('✅ [PIX] Pacote PERSONALIZADO criado:', selectedPackage);
        } else {
            // Pacote fixo
            selectedPackage = PACKAGES[package_id];
            if (!selectedPackage) {
                console.error('❌ [PIX] Pacote não encontrado:', package_id);
                return res.status(400).json({ error: 'Pacote não encontrado' });
            }
            console.log('✅ [PIX] Pacote FIXO encontrado:', selectedPackage);
        }

        // Buscar usuário
        const userResult = await pool.query(
            'SELECT id, name, email, credits_balance FROM users WHERE id = $1',
            [req.userId]
        );

        if (userResult.rows.length === 0) {
            console.error('❌ [PIX] Usuário não encontrado:', req.userId);
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const user = userResult.rows[0];
        console.log('✅ [PIX] Usuário encontrado:', { id: user.id, name: user.name, email: user.email });

        // Validar cupom se fornecido
        let appliedCoupon = null;
        let discountAmount = 0;
        let transactionAmount = selectedPackage.price;

        if (coupon) {
            appliedCoupon = validateCoupon(coupon);
            if (appliedCoupon) {
                discountAmount = calculateDiscount(selectedPackage.price, appliedCoupon);
                transactionAmount = selectedPackage.price - discountAmount;
                console.log('🎟️ [PIX] Cupom aplicado:', {
                    code: appliedCoupon.code,
                    discount: appliedCoupon.discount,
                    originalPrice: selectedPackage.price / 100,
                    discountAmount: discountAmount / 100,
                    finalPrice: transactionAmount / 100
                });
            } else {
                console.warn('⚠️ [PIX] Cupom inválido:', coupon);
            }
        }

        // Se amount foi fornecido (compra personalizada), usar ele
        if (amount !== undefined && package_id === 'package_custom') {
            transactionAmount = Math.round(amount * 100); // Converter para centavos
            console.log('💰 [PIX] Usando valor personalizado:', transactionAmount / 100);
        }

        // Criar referência externa
        const externalReference = `LP-PIX-${user.id}-${Date.now()}`;
        console.log('🔖 [PIX] Referência externa criada:', externalReference);

        // Inserir transação pendente
        const transactionResult = await pool.query(
            `INSERT INTO transactions 
            (user_id, package_id, amount, credits, status, payment_method, external_reference, coupon_code, discount_amount, metadata) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
            RETURNING id`,
            [
                user.id,
                package_id,
                transactionAmount,
                selectedPackage.credits,
                'pending',
                'pix',
                externalReference,
                appliedCoupon ? appliedCoupon.code : null,
                discountAmount,
                JSON.stringify({
                    original_price: selectedPackage.price,
                    discount_applied: discountAmount,
                    final_price: transactionAmount
                })
            ]
        );

        const transactionId = transactionResult.rows[0].id;
        console.log('✅ [PIX] Transação criada no banco:', transactionId);

        // ✅ PREPARAR DADOS DO PAGAMENTO PIX PARA MERCADO PAGO (PRODUÇÃO)
        console.log('📤 [PIX] Preparando payload PIX para Mercado Pago...');

        const paymentPayload = {
            transaction_amount: transactionAmount / 100, // Converter centavos para reais
            description: `${selectedPackage.name} - ${selectedPackage.credits.toLocaleString('pt-BR')} leads`,
            payment_method_id: 'pix',
            payer: {
                email: user.email,
                first_name: user.name.split(' ')[0],
                last_name: user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0]
            },
            external_reference: externalReference,
            notification_url: `${process.env.BACKEND_URL || 'https://leadsparatodos-backend-production.up.railway.app'}/api/payment/webhook`,
            metadata: {
                user_id: user.id,
                user_name: user.name,
                user_email: user.email,
                package_id: package_id,
                credits: selectedPackage.credits,
                transaction_id: transactionId,
                coupon: appliedCoupon ? appliedCoupon.code : null,
                discount: discountAmount / 100
            }
        };

        console.log('📦 [PIX] Payload Mercado Pago:', JSON.stringify(paymentPayload, null, 2));

        // ✅ ENVIAR PAGAMENTO PIX PARA MERCADO PAGO (PRODUÇÃO)
        console.log('🚀 [PIX] Enviando pagamento PIX para Mercado Pago...');
        
        const paymentResponse = await mercadopago.payment.create(paymentPayload);

        console.log('✅ [PIX] Resposta do Mercado Pago:', JSON.stringify(paymentResponse.body, null, 2));

        const paymentId = paymentResponse.body.id;
        const paymentStatus = paymentResponse.body.status;

        // Atualizar transação com payment_id
        await pool.query(
            'UPDATE transactions SET payment_id = $1, status = $2, metadata = metadata || $3::jsonb WHERE id = $4',
            [
                paymentId,
                paymentStatus,
                JSON.stringify({
                    payment_response: paymentResponse.body
                }),
                transactionId
            ]
        );

        console.log('✅ [PIX] Transação atualizada com payment_id:', paymentId);

        // Extrair dados do PIX
        const pixData = paymentResponse.body.point_of_interaction?.transaction_data;

        if (!pixData || !pixData.qr_code) {
            console.error('❌ [PIX] QR Code não encontrado na resposta');
            return res.status(500).json({ error: 'Erro ao gerar QR Code PIX' });
        }

        console.log('✅ [PIX] QR Code gerado com sucesso');

        res.json({
            success: true,
            message: 'PIX gerado com sucesso',
            payment_id: paymentId,
            external_reference: externalReference,
            qr_code: pixData.qr_code,
            qr_code_base64: pixData.qr_code_base64,
            ticket_url: pixData.ticket_url
        });

    } catch (error) {
        console.error('❌ [PIX] Erro ao processar pagamento:', error);
        console.error('❌ [PIX] Stack trace:', error.stack);
        console.error('❌ [PIX] Error details:', JSON.stringify(error, null, 2));
        
        res.status(500).json({
            error: 'Erro ao processar pagamento PIX',
            details: error.message,
            cause: error.cause || 'Erro desconhecido'
        });
    }
});

// ✅ WEBHOOK DO MERCADO PAGO (PRODUÇÃO)
app.post('/api/payment/webhook', async (req, res) => {
    try {
        console.log('🔔 [WEBHOOK] Notificação recebida do Mercado Pago');
        console.log('📦 [WEBHOOK] Body:', JSON.stringify(req.body, null, 2));
        console.log('📦 [WEBHOOK] Query:', JSON.stringify(req.query, null, 2));

        const { type, data } = req.body;

        // Responder imediatamente para não bloquear
        res.sendStatus(200);

        // Processar apenas notificações de pagamento
        if (type !== 'payment') {
            console.log('ℹ️ [WEBHOOK] Tipo de notificação ignorado:', type);
            return;
        }

        const paymentId = data.id;
        console.log('💰 [WEBHOOK] Payment ID:', paymentId);

        // Buscar detalhes do pagamento
        const payment = await mercadopago.payment.get(paymentId);
        console.log('✅ [WEBHOOK] Pagamento encontrado:', JSON.stringify(payment.body, null, 2));

        const paymentStatus = payment.body.status;
        const externalReference = payment.body.external_reference;
        const metadata = payment.body.metadata;

        console.log('📊 [WEBHOOK] Status:', paymentStatus);
        console.log('🔖 [WEBHOOK] External Reference:', externalReference);
        console.log('📋 [WEBHOOK] Metadata:', metadata);

        // Buscar transação no banco
        const transactionResult = await pool.query(
            'SELECT * FROM transactions WHERE external_reference = $1 OR payment_id = $2',
            [externalReference, paymentId]
        );

        if (transactionResult.rows.length === 0) {
            console.error('❌ [WEBHOOK] Transação não encontrada:', { externalReference, paymentId });
            return;
        }

        const transaction = transactionResult.rows[0];
        console.log('✅ [WEBHOOK] Transação encontrada:', transaction);

        // Se pagamento foi aprovado e transação ainda não foi processada
        if (paymentStatus === 'approved' && transaction.status !== 'approved') {
            console.log('🎉 [WEBHOOK] Pagamento APROVADO! Adicionando créditos...');

            // Buscar usuário
            const userResult = await pool.query(
                'SELECT id, name, email, credits_balance FROM users WHERE id = $1',
                [transaction.user_id]
            );

            if (userResult.rows.length === 0) {
                console.error('❌ [WEBHOOK] Usuário não encontrado:', transaction.user_id);
                return;
            }

            const user = userResult.rows[0];
            const newBalance = user.credits_balance + transaction.credits;

            // Atualizar créditos do usuário
            await pool.query(
                'UPDATE users SET credits_balance = $1 WHERE id = $2',
                [newBalance, user.id]
            );

            // Atualizar status da transação
            await pool.query(
                'UPDATE transactions SET status = $1, approved_at = NOW(), metadata = metadata || $2::jsonb WHERE id = $3',
                [
                    'approved',
                    JSON.stringify({
                        webhook_processed: true,
                        webhook_timestamp: new Date().toISOString(),
                        payment_status: paymentStatus
                    }),
                    transaction.id
                ]
            );

            console.log('✅ [WEBHOOK] Créditos adicionados:', {
                userId: user.id,
                oldBalance: user.credits_balance,
                newBalance: newBalance,
                creditsAdded: transaction.credits
            });

            // Enviar email de confirmação
            await sendEmail(
                user.email,
                'Pagamento Aprovado - Leads Para Todos',
                emailTemplates.paymentApproved(user.name, transaction.credits, transaction.amount)
            );

            console.log('✅ [WEBHOOK] Processamento concluído com sucesso');
        } else {
            console.log('ℹ️ [WEBHOOK] Status não requer ação:', paymentStatus);
            
            // Atualizar status da transação
            await pool.query(
                'UPDATE transactions SET status = $1, metadata = metadata || $2::jsonb WHERE id = $3',
                [
                    paymentStatus,
                    JSON.stringify({
                        webhook_update: true,
                        webhook_timestamp: new Date().toISOString(),
                        payment_status: paymentStatus
                    }),
                    transaction.id
                ]
            );
        }

    } catch (error) {
        console.error('❌ [WEBHOOK] Erro ao processar webhook:', error);
        console.error('❌ [WEBHOOK] Stack trace:', error.stack);
    }
});

// Status de transação
app.get('/api/payment/status/:externalReference', authMiddleware, async (req, res) => {
    try {
        const { externalReference } = req.params;

        const result = await pool.query(
            `SELECT t.*, u.name as user_name, u.email as user_email 
             FROM transactions t 
             JOIN users u ON t.user_id = u.id 
             WHERE t.external_reference = $1 AND t.user_id = $2`,
            [externalReference, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Transação não encontrada' });
        }

        res.json({ transaction: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao buscar status:', error);
        res.status(500).json({ error: 'Erro ao buscar status da transação' });
    }
});

// Listar transações do usuário
app.get('/api/payment/transactions', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM transactions 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [req.userId]
        );

        res.json({ transactions: result.rows });
    } catch (error) {
        console.error('❌ Erro ao listar transações:', error);
        res.status(500).json({ error: 'Erro ao listar transações' });
    }
});

// ==================== ROTAS DE ADMIN ====================

// Dashboard do admin
app.get('/api/admin/dashboard', adminMiddleware, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM users WHERE role = 'admin') as total_admins,
                (SELECT COUNT(*) FROM transactions) as total_transactions,
                (SELECT COUNT(*) FROM transactions WHERE status = 'approved') as approved_transactions,
                (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE status = 'approved') as total_revenue,
                (SELECT COALESCE(SUM(credits_balance), 0) FROM users) as total_credits_distributed
        `);

        res.json({ stats: stats.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao buscar dashboard:', error);
        res.status(500).json({ error: 'Erro ao buscar dados do dashboard' });
    }
});

// Listar todos os usuários (admin)
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, credits_balance, role, created_at FROM users ORDER BY created_at DESC'
        );

        res.json({ users: result.rows });
    } catch (error) {
        console.error('❌ Erro ao listar usuários:', error);
        res.status(500).json({ error: 'Erro ao listar usuários' });
    }
});

// Editar usuário (admin)
app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, credits_balance, role } = req.body;

        const result = await pool.query(
            `UPDATE users 
             SET name = $1, email = $2, credits_balance = $3, role = $4 
             WHERE id = $5 
             RETURNING id, name, email, credits_balance, role, created_at`,
            [name, email, credits_balance, role, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        res.json({ message: 'Usuário atualizado com sucesso', user: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao editar usuário:', error);
        res.status(500).json({ error: 'Erro ao editar usuário' });
    }
});

// Buscar detalhes do usuário + transações (admin)
app.get('/api/admin/users/:id', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        const userResult = await pool.query(
            'SELECT id, name, email, credits_balance, role, created_at FROM users WHERE id = $1',
            [id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const transactionsResult = await pool.query(
            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
            [id]
        );

        res.json({
            user: userResult.rows[0],
            transactions: transactionsResult.rows
        });
    } catch (error) {
        console.error('❌ Erro ao buscar usuário:', error);
        res.status(500).json({ error: 'Erro ao buscar usuário' });
    }
});

// Listar todas as transações (admin)
app.get('/api/admin/transactions', adminMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, u.name as user_name, u.email as user_email 
            FROM transactions t 
            JOIN users u ON t.user_id = u.id 
            ORDER BY t.created_at DESC
        `);

        res.json({ transactions: result.rows });
    } catch (error) {
        console.error('❌ Erro ao listar transações:', error);
        res.status(500).json({ error: 'Erro ao listar transações' });
    }
});

// Exportar usuários (CSV)
app.get('/api/admin/users/export/csv', adminMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, credits_balance, role, created_at FROM users ORDER BY created_at DESC'
        );

        let csv = 'ID,Nome,Email,Créditos,Função,Data de Cadastro\n';
        
        result.rows.forEach(user => {
            csv += `${user.id},"${user.name}","${user.email}",${user.credits_balance},${user.role},${user.created_at}\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=usuarios.csv');
        res.send(csv);
    } catch (error) {
        console.error('❌ Erro ao exportar usuários:', error);
        res.status(500).json({ error: 'Erro ao exportar usuários' });
    }
});

// Exportar transações (CSV)
app.get('/api/admin/transactions/export/csv', adminMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, u.name as user_name, u.email as user_email 
            FROM transactions t 
            JOIN users u ON t.user_id = u.id 
            ORDER BY t.created_at DESC
        `);

        let csv = 'ID,Usuário,Email,Pacote,Valor,Créditos,Status,Método,Data\n';
        
        result.rows.forEach(transaction => {
            csv += `${transaction.id},"${transaction.user_name}","${transaction.user_email}",${transaction.package_id},${transaction.amount / 100},${transaction.credits},${transaction.status},${transaction.payment_method},${transaction.created_at}\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=transacoes.csv');
        res.send(csv);
    } catch (error) {
        console.error('❌ Erro ao exportar transações:', error);
        res.status(500).json({ error: 'Erro ao exportar transações' });
    }
});

// ==================== ENDPOINT TEMPORÁRIO PARA CORRIGIR BANCO ====================
// ⚠️ REMOVER APÓS USO!
app.get('/api/admin/fix-database-password-column', async (req, res) => {
    try {
        console.log('🔧 [FIX-DB] Iniciando correção do banco de dados...');
        
        // 1. Verificar se a coluna password existe
        const checkColumn = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'password'
        `);
        
        if (checkColumn.rows.length > 0) {
            console.log('✅ [FIX-DB] Coluna password já existe!');
            return res.json({
                success: true,
                message: 'Coluna password já existe',
                status: 'already_exists'
            });
        }
        
        console.log('⚠️ [FIX-DB] Coluna password NÃO existe. Criando...');
        
        // 2. Adicionar coluna password
        await pool.query(`
            ALTER TABLE users 
            ADD COLUMN password VARCHAR(255)
        `);
        
        console.log('✅ [FIX-DB] Coluna password criada com sucesso!');
        
        // 3. Atualizar usuários existentes com senha padrão (hash de "123456")
        const updateResult = await pool.query(`
            UPDATE users 
            SET password = '$2a$10$N9qo8uLOickgx2ZMRZoMye8RnJVMnMxXRZOvA3FZM/qYu3w5qN5Iu'
            WHERE password IS NULL OR password = ''
        `);
        
        console.log(`✅ [FIX-DB] ${updateResult.rowCount} usuários atualizados com senha padrão`);
        
        // 4. Verificar estrutura final
        const finalStructure = await pool.query(`
            SELECT column_name, data_type, character_maximum_length 
            FROM information_schema.columns 
            WHERE table_name = 'users' 
            ORDER BY ordinal_position
        `);
        
        console.log('✅ [FIX-DB] Estrutura final da tabela users:', finalStructure.rows);
        
        // 5. Listar usuários
        const users = await pool.query(`
            SELECT id, name, email, 
                   CASE WHEN password IS NULL THEN 'NULL' 
                        WHEN password = '' THEN 'VAZIO' 
                        ELSE 'OK' END as senha_status,
                   credits_balance, role, created_at 
            FROM users
        `);
        
        console.log('✅ [FIX-DB] Usuários no banco:', users.rows);
        
        res.json({
            success: true,
            message: 'Banco de dados corrigido com sucesso!',
            users_updated: updateResult.rowCount,
            table_structure: finalStructure.rows,
            users: users.rows
        });
        
    } catch (error) {
        console.error('❌ [FIX-DB] Erro ao corrigir banco:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.stack
        });
    }
});

// ==================== TRATAMENTO DE ERROS ====================

// Rota 404
app.use((req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
});

// Tratamento de erros global
app.use((err, req, res, next) => {
    console.error('❌ Erro não tratado:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
});

// ==================== INICIAR SERVIDOR ====================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║           🚀 SERVIDOR LEADS PARA TODOS 🚀                  ║
║                                                            ║
║  ✅ Servidor rodando em: http://localhost:${PORT}          
║  ✅ Ambiente: ${process.env.NODE_ENV || 'development'}    
║  ✅ Frontend: ${process.env.FRONTEND_URL || 'N/A'}        
║                                                            ║
║  💳 Mercado Pago:                                          ║
║     ✅ Access Token configurado                            ║
║     ✅ Modo PRODUÇÃO ativado                              ║
║                                                            ║
║  📧 Email (Resend):                                        ║
║     ${process.env.RESEND_API_KEY ? '✅' : '❌'} API Key ${process.env.RESEND_API_KEY ? 'configurada' : 'não configurada'}                           
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
});
