// ========================================
// SERVER.JS - Servidor Principal
// ========================================
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar pool do PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Helper para queries
const query = (text, params) => pool.query(text, params);

// Middleware de autenticação
const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Token não fornecido' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const result = await query('SELECT id, name, email, role, credits_balance FROM users WHERE id = $1', [decoded.userId]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Usuário não encontrado' });
        }

        req.user = result.rows[0];
        next();
    } catch (error) {
        res.status(401).json({ error: 'Token inválido' });
    }
};

// Middleware de admin
const adminMiddleware = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
    }
    next();
};

// Middlewares
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:8080',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Rotas existentes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/leads', require('./src/routes/leads'));
app.use('/api/payment', require('./src/routes/payment'));

// ========================================
// ROTAS ADMIN
// ========================================

// [ADMIN] Dashboard com estatísticas gerais
app.get('/api/admin/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        // Buscar estatísticas principais
        const statsResult = await query(`
            SELECT 
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM credit_transactions WHERE type = 'credit') as total_transactions,
                (SELECT COALESCE(SUM(amount), 0) FROM credit_transactions WHERE type = 'credit') as total_credits_sold,
                (SELECT COALESCE(SUM(amount * 0.14), 0) FROM credit_transactions WHERE type = 'credit') as total_sales
        `);

        const stats = statsResult.rows[0];

        // Vendas por dia (últimos 30 dias)
        const salesByDayResult = await query(`
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
            totalSales: parseFloat(stats.total_sales || 0),
            totalUsers: parseInt(stats.total_users || 0),
            totalTransactions: parseInt(stats.total_transactions || 0),
            totalCreditsSold: parseInt(stats.total_credits_sold || 0),
            salesByDay: salesByDayResult.rows
        });
    } catch (error) {
        console.error('❌ Erro ao buscar estatísticas:', error);
        res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
});

// [ADMIN] Listar todos os usuários
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { search = '' } = req.query;
        
        let whereClause = '1=1';
        const params = [];
        
        if (search) {
            whereClause = '(name ILIKE $1 OR email ILIKE $1)';
            params.push(`%${search}%`);
        }

        const usersResult = await query(
            `SELECT id, name, email, phone, credits_balance, role, status, created_at
             FROM users
             WHERE ${whereClause}
             ORDER BY created_at DESC`,
            params
        );

        res.json({ users: usersResult.rows });
    } catch (error) {
        console.error('❌ Erro ao listar usuários:', error);
        res.status(500).json({ error: 'Erro ao listar usuários' });
    }
});

// [ADMIN] Obter detalhes de um usuário
app.get('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;

        const userResult = await query(
            `SELECT id, name, email, phone, credits_balance, role, status, created_at
             FROM users WHERE id = $1`,
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        res.json({ user: userResult.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao buscar usuário:', error);
        res.status(500).json({ error: 'Erro ao buscar detalhes do usuário' });
    }
});

// [ADMIN] Atualizar usuário (incluindo créditos)
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

        await query(
            `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
             WHERE id = $${paramCount}`,
            values
        );

        res.json({ message: 'Usuário atualizado com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao atualizar usuário:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário' });
    }
});

// [ADMIN] Listar transações
app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { status = '' } = req.query;

        let whereClause = '1=1';
        const params = [];

        if (status) {
            whereClause = 'type = $1';
            params.push(status);
        }

        const transactionsResult = await query(
            `SELECT ct.id, ct.type, ct.amount, ct.description, ct.created_at,
                    u.name as user_name, u.email as user_email
             FROM credit_transactions ct
             JOIN users u ON ct.user_id = u.id
             WHERE ${whereClause}
             ORDER BY ct.created_at DESC
             LIMIT 100`,
            params
        );

        res.json({ transactions: transactionsResult.rows });
    } catch (error) {
        console.error('❌ Erro ao listar transações:', error);
        res.status(500).json({ error: 'Erro ao listar transações' });
    }
});

// [ADMIN] Exportar dados (placeholder)
app.get('/api/admin/export/transactions', authMiddleware, adminMiddleware, async (req, res) => {
    res.json({ message: 'Exportação em desenvolvimento' });
});

app.get('/api/admin/export/users', authMiddleware, adminMiddleware, async (req, res) => {
    res.json({ message: 'Exportação em desenvolvimento' });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Erro interno do servidor' });
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Erro ao conectar com PostgreSQL:', err);
    } else {
        console.log('✅ PostgreSQL conectado com sucesso');
    }
});

// Start Server
app.listen(PORT, () => {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║     🚀 LEADS PARA TODOS - BACKEND INICIADO          ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║     📡 Porta: ${PORT}                                    ║`);
    console.log(`║     🌍 Ambiente: ${process.env.NODE_ENV || 'development'}                      ║`);
    console.log(`║     🎯 Frontend: ${process.env.FRONTEND_URL || 'localhost'}  ║`);
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log('║     ✅ Rotas Admin: ATIVAS                           ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');
});

module.exports = app;
