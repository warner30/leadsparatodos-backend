 1	require('dotenv').config();
     2	const express = require('express');
     3	const cors = require('cors');
     4	const helmet = require('helmet');
     5	const morgan = require('morgan');
     6	const { Pool } = require('pg');
     7	const bcrypt = require('bcryptjs');
     8	const jwt = require('jsonwebtoken');
     9	const mercadopago = require('mercadopago');
    10	const crypto = require('crypto');
    11	const { Resend } = require('resend');
    12	
    13	const app = express();
    14	const PORT = process.env.PORT || 10000;
    15	
    16	// ==================== CONFIGURAÇÕES ====================
    17	
    18	// Mercado Pago
    19	mercadopago.configure({
    20	    access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
    21	});
    22	console.log('✅ Mercado Pago configurado com Access Token de PRODUÇÃO');
    23	
    24	// PostgreSQL
    25	const pool = new Pool({
    26	    connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    27	    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    28	});
    29	
    30	pool.connect()
    31	    .then(() => console.log('✅ PostgreSQL conectado com sucesso'))
    32	    .catch(err => console.error('❌ Erro ao conectar PostgreSQL:', err));
    33	
    34	// Resend Email
    35	const resend = new Resend(process.env.RESEND_API_KEY);
    36	console.log('✅ Email Resend configurado');
    37	
    38	// ==================== DEFINIÇÃO DE PACOTES E CUPONS ====================
    39	
    40	const PACKAGES = {
    41	    package_5k: {
    42	        id: 'package_5k',
    43	        name: '5.000 Créditos',
    44	        credits: 5000,
    45	        price: 70000, // R$ 700,00 em centavos
    46	        pricePerLead: 0.14
    47	    },
    48	    package_10k: {
    49	        id: 'package_10k',
    50	        name: '10.000 Créditos',
    51	        credits: 10000,
    52	        price: 130000, // R$ 1.300,00 em centavos
    53	        pricePerLead: 0.13
    54	    },
    55	    package_20k: {
    56	        id: 'package_20k',
    57	        name: '20.000 Créditos',
    58	        credits: 20000,
    59	        price: 240000, // R$ 2.400,00 em centavos
    60	        pricePerLead: 0.12
    61	    },
    62	    package_50k: {
    63	        id: 'package_50k',
    64	        name: '50.000 Créditos',
    65	        credits: 50000,
    66	        price: 550000, // R$ 5.500,00 em centavos
    67	        pricePerLead: 0.11
    68	    }
    69	};
    70	
    71	// Sistema de cupons
    72	const COUPONS = {
    73	    TESTE99: {
    74	        code: 'TESTE99',
    75	        discount: 99,
    76	        type: 'percentage',
    77	        active: true,
    78	        description: 'Cupom de teste com 99% de desconto'
    79	    },
    80	    BEMVINDO10: {
    81	        code: 'BEMVINDO10',
    82	        discount: 10,
    83	        type: 'percentage',
    84	        active: true,
    85	        description: 'Cupom de boas-vindas com 10% de desconto'
    86	    }
    87	};
    88	
    89	function validateCoupon(code) {
    90	    if (!code) return null;
    91	    const coupon = COUPONS[code.toUpperCase()];
    92	    return (coupon && coupon.active) ? coupon : null;
    93	}
    94	
    95	function calculateDiscount(price, coupon) {
    96	    if (!coupon) return 0;
    97	    if (coupon.type === 'percentage') {
    98	        return Math.round((price * coupon.discount) / 100);
    99	    }
   100	    if (coupon.type === 'fixed') {
   101	        return Math.min(coupon.discount, price);
   102	    }
   103	    return 0;
   104	}
   105	
   106	// ==================== MIDDLEWARES ====================
   107	
   108	app.use(helmet());
   109	app.use(morgan('dev'));
   110	app.use(cors({
   111	    origin: [
   112	        'https://jkvzqvlk.gensparkspace.com',
   113	        'http://localhost:3000',
   114	        'http://localhost:5500'
   115	    ],
   116	    credentials: true
   117	}));
   118	app.use(express.json());
   119	app.use(express.urlencoded({ extended: true }));
   120	
   121	// Middleware de autenticação
   122	const authMiddleware = async (req, res, next) => {
   123	    try {
   124	        const token = req.headers.authorization?.replace('Bearer ', '');
   125	        
   126	        if (!token) {
   127	            return res.status(401).json({ error: 'Token não fornecido' });
   128	        }
   129	
   130	        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-default');
   131	        req.userId = decoded.userId;
   132	        next();
   133	    } catch (error) {
   134	        console.error('❌ Erro na autenticação:', error);
   135	        res.status(401).json({ error: 'Token inválido' });
   136	    }
   137	};
   138	
   139	// Middleware de admin
   140	const adminMiddleware = async (req, res, next) => {
   141	    try {
   142	        const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
   143	        
   144	        if (userResult.rows.length === 0 || userResult.rows[0].role !== 'admin') {
   145	            return res.status(403).json({ error: 'Acesso negado' });
   146	        }
   147	        
   148	        next();
   149	    } catch (error) {
   150	        console.error('❌ Erro no middleware admin:', error);
   151	        res.status(500).json({ error: 'Erro ao verificar permissões' });
   152	    }
   153	};
   154	
   155	// ==================== FUNÇÃO DE ENVIO DE EMAIL ====================
   156	
   157	async function sendEmail(to, subject, htmlContent) {
   158	    try {
   159	        if (!process.env.RESEND_API_KEY) {
   160	            console.log('⚠️ Resend API Key não configurada');
   161	            return { success: false, error: 'API Key não configurada' };
   162	        }
   163	
   164	        const data = await resend.emails.send({
   165	            from: 'Leads Para Todos <noreply@leadsparatodos.com>',
   166	            to: [to],
   167	            subject: subject,
   168	            html: htmlContent
   169	        });
   170	
   171	        console.log('✅ Email enviado com sucesso para:', to);
   172	        return { success: true, data };
   173	    } catch (error) {
   174	        console.error('❌ Erro ao enviar email:', error);
   175	        return { success: false, error: error.message };
   176	    }
   177	}
   178	
   179	// Templates de email
   180	const emailTemplates = {
   181	    welcome: (name) => `
   182	        <!DOCTYPE html>
   183	        <html>
   184	        <head><meta charset="UTF-8"></head>
   185	        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
   186	            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
   187	                <h2 style="color: #1e40af;">Bem-vindo ao Leads Para Todos!</h2>
   188	                <p>Olá <strong>${name}</strong>,</p>
   189	                <p>Sua conta foi criada com sucesso! Agora você pode começar a gerar leads de qualidade para seu negócio.</p>
   190	                <p>Acesse sua conta em: <a href="https://jkvzqvlk.gensparkspace.com/dashboard.html">Dashboard</a></p>
   191	                <p>Se precisar de ajuda, estamos à disposição.</p>
   192	                <p>Atenciosamente,<br>Equipe Leads Para Todos</p>
   193	            </div>
   194	        </body>
   195	        </html>
   196	    `,
   197	    paymentApproved: (name, credits, package_name) => `
   198	        <!DOCTYPE html>
   199	        <html>
   200	        <head><meta charset="UTF-8"></head>
   201	        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
   202	            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
   203	                <h2 style="color: #10b981;">✅ Pagamento Aprovado!</h2>
   204	                <p>Olá <strong>${name}</strong>,</p>
   205	                <p>Seu pagamento foi aprovado com sucesso!</p>
   206	                <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
   207	                    <p><strong>Pacote:</strong> ${package_name}</p>
   208	                    <p><strong>Créditos adicionados:</strong> ${credits.toLocaleString('pt-BR')}</p>
   209	                </div>
   210	                <p>Os créditos já estão disponíveis em sua conta!</p>
   211	                <p><a href="https://jkvzqvlk.gensparkspace.com/dashboard.html" style="background: #1e40af; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Acessar Dashboard</a></p>
   212	                <p>Atenciosamente,<br>Equipe Leads Para Todos</p>
   213	            </div>
   214	        </body>
   215	        </html>
   216	    `,
   217	    resetPassword: (name, resetUrl) => `
   218	        <!DOCTYPE html>
   219	        <html>
   220	        <head><meta charset="UTF-8"></head>
   221	        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
   222	            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
   223	                <h2 style="color: #1e40af;">Recuperação de Senha</h2>
   224	                <p>Olá <strong>${name}</strong>,</p>
   225	                <p>Recebemos uma solicitação para redefinir sua senha.</p>
   226	                <p>Clique no botão abaixo para criar uma nova senha:</p>
   227	                <p><a href="${resetUrl}" style="background: #1e40af; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Redefinir Senha</a></p>
   228	                <p>Este link é válido por 1 hora.</p>
   229	                <p>Se você não solicitou esta alteração, ignore este email.</p>
   230	                <p>Atenciosamente,<br>Equipe Leads Para Todos</p>
   231	            </div>
   232	        </body>
   233	        </html>
   234	    `
   235	};
   236	
   237	// ==================== ROTAS DE SAÚDE ====================
   238	
   239	// ENDPOINT TEMPORÁRIO PARA CORRIGIR BANCO DE DADOS
   240	app.get('/api/admin/fix-database-columns', async (req, res) => {
   241	    try {
   242	        console.log('🔧 Iniciando correção do banco de dados...');
   243	        
   244	        // Verificar se as colunas já existem
   245	        const checkColumns = await pool.query(`
   246	            SELECT column_name 
   247	            FROM information_schema.columns 
   248	            WHERE table_name = 'transactions' 
   249	            AND column_name IN ('coupon_code', 'discount_amount')
   250	        `);
   251	        
   252	        const existingColumns = checkColumns.rows.map(row => row.column_name);
   253	        
   254	        let results = {
   255	            coupon_code: existingColumns.includes('coupon_code') ? 'já existe' : 'criada',
   256	            discount_amount: existingColumns.includes('discount_amount') ? 'já existe' : 'criada'
   257	        };
   258	        
   259	        // Adicionar coluna coupon_code se não existir
   260	        if (!existingColumns.includes('coupon_code')) {
   261	            await pool.query('ALTER TABLE transactions ADD COLUMN coupon_code VARCHAR(50)');
   262	            console.log('✅ Coluna coupon_code adicionada');
   263	        }
   264	        
   265	        // Adicionar coluna discount_amount se não existir
   266	        if (!existingColumns.includes('discount_amount')) {
   267	            await pool.query('ALTER TABLE transactions ADD COLUMN discount_amount INTEGER DEFAULT 0');
   268	            console.log('✅ Coluna discount_amount adicionada');
   269	        }
   270	        
   271	        // Verificar estrutura final
   272	        const finalStructure = await pool.query(`
   273	            SELECT column_name, data_type, character_maximum_length 
   274	            FROM information_schema.columns 
   275	            WHERE table_name = 'transactions' 
   276	            ORDER BY ordinal_position
   277	        `);
   278	        
   279	        console.log('✅ Banco de dados corrigido com sucesso!');
   280	        
   281	        res.json({
   282	            success: true,
   283	            message: 'Banco de dados corrigido com sucesso!',
   284	            results: results,
   285	            table_structure: finalStructure.rows
   286	        });
   287	    } catch (error) {
   288	        console.error('❌ Erro ao corrigir banco de dados:', error);
   289	        res.status(500).json({
   290	            success: false,
   291	            error: error.message,
   292	            details: error.stack
   293	        });
   294	    }
   295	});
   296	
   297	// ENDPOINT PARA CRIAR TABELA DE SOLICITAÇÕES DE LEADS
   298	app.get('/api/admin/setup-leads-requests', async (req, res) => {
   299	    try {
   300	        console.log('🔧 Criando tabela leads_requests...');
   301	        
   302	        // Verificar se a tabela já existe
   303	        const tableExists = await pool.query(`
   304	            SELECT EXISTS (
   305	                SELECT FROM information_schema.tables 
   306	                WHERE table_name = 'leads_requests'
   307	            );
   308	        `);
   309	        
   310	        if (tableExists.rows[0].exists) {
   311	            return res.json({
   312	                success: true,
   313	                message: 'Tabela leads_requests já existe',
   314	                status: 'already_exists'
   315	            });
   316	        }
   317	        
   318	        // Criar tabela leads_requests
   319	        await pool.query(`
   320	            CREATE TABLE leads_requests (
   321	                id SERIAL PRIMARY KEY,
   322	                user_id INTEGER NOT NULL REFERENCES users(id),
   323	                credits_requested INTEGER NOT NULL,
   324	                status VARCHAR(20) DEFAULT 'pending',
   325	                filters JSONB,
   326	                whatsapp_message TEXT,
   327	                created_at TIMESTAMP DEFAULT NOW(),
   328	                confirmed_at TIMESTAMP,
   329	                cancelled_at TIMESTAMP,
   330	                expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
   331	                admin_notes TEXT
   332	            );
   333	        `);
   334	        
   335	        console.log('✅ Tabela leads_requests criada');
   336	        
   337	        // Adicionar coluna credits_reserved na tabela users
   338	        const checkUserColumn = await pool.query(`
   339	            SELECT column_name 
   340	            FROM information_schema.columns 
   341	            WHERE table_name = 'users' AND column_name = 'credits_reserved'
   342	        `);
   343	        
   344	        if (checkUserColumn.rows.length === 0) {
   345	            await pool.query(`
   346	                ALTER TABLE users ADD COLUMN credits_reserved INTEGER DEFAULT 0;
   347	            `);
   348	            console.log('✅ Coluna credits_reserved adicionada na tabela users');
   349	        }
   350	        
   351	        // Criar índices
   352	        await pool.query(`
   353	            CREATE INDEX idx_leads_requests_user_id ON leads_requests(user_id);
   354	            CREATE INDEX idx_leads_requests_status ON leads_requests(status);
   355	            CREATE INDEX idx_leads_requests_expires_at ON leads_requests(expires_at);
   356	        `);
   357	        
   358	        console.log('✅ Índices criados');
   359	        
   360	        res.json({
   361	            success: true,
   362	            message: 'Tabela leads_requests criada com sucesso!',
   363	            status: 'created'
   364	        });
   365	    } catch (error) {
   366	        console.error('❌ Erro ao criar tabela:', error);
   367	        res.status(500).json({
   368	            success: false,
   369	            error: error.message,
   370	            details: error.stack
   371	        });
   372	    }
   373	});
   374	
   375	app.get('/health', (req, res) => {
   376	    res.json({ 
   377	        status: 'OK', 
   378	        timestamp: new Date().toISOString(),
   379	        environment: process.env.NODE_ENV || 'development'
   380	    });
   381	});
   382	
   383	app.get('/api/test-db', async (req, res) => {
   384	    try {
   385	        const result = await pool.query('SELECT NOW()');
   386	        res.json({ 
   387	            success: true, 
   388	            message: 'Conexão com banco de dados OK',
   389	            timestamp: result.rows[0].now 
   390	        });
   391	    } catch (error) {
   392	        console.error('❌ Erro ao testar DB:', error);
   393	        res.status(500).json({ 
   394	            success: false, 
   395	            error: 'Erro ao conectar com banco de dados' 
   396	        });
   397	    }
   398	});
   399	
   400	// ENDPOINT TEMPORÁRIO PARA VERIFICAR CRÉDITOS
   401	app.get('/api/admin/check-credits/:email', async (req, res) => {
   402	    try {
   403	        const { email } = req.params;
   404	        const result = await pool.query(
   405	            'SELECT id, name, email, credits_balance, created_at, updated_at FROM users WHERE email = $1',
   406	            [email]
   407	        );
   408	        
   409	        if (result.rows.length === 0) {
   410	            return res.json({ success: false, message: 'Usuário não encontrado' });
   411	        }
   412	        
   413	        res.json({
   414	            success: true,
   415	            user: result.rows[0]
   416	        });
   417	    } catch (error) {
   418	        console.error('❌ Erro ao verificar créditos:', error);
   419	        res.status(500).json({ 
   420	            success: false, 
   421	            error: error.message 
   422	        });
   423	    }
   424	});
   425	
   426	// ==================== ROTAS DE AUTENTICAÇÃO ====================
   427	
   428	// Registro
   429	app.post('/api/auth/register', async (req, res) => {
   430	    try {
   431	        const { name, email, password } = req.body;
   432	
   433	        console.log('📝 Tentativa de registro:', { name, email });
   434	
   435	        if (!name || !email || !password) {
   436	            return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
   437	        }
   438	
   439	        // Verificar se usuário já existe
   440	        const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
   441	        if (userExists.rows.length > 0) {
   442	            return res.status(400).json({ error: 'Email já cadastrado' });
   443	        }
   444	
   445	        // Hash da senha
   446	        const hashedPassword = await bcrypt.hash(password, 10);
   447	
   448	        // Inserir usuário
   449	        const result = await pool.query(
   450	            'INSERT INTO users (name, email, password, credits_balance, role, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, credits_balance, role',
   451	            [name, email.toLowerCase(), hashedPassword, 0, 'user', 'active']
   452	        );
   453	
   454	        const user = result.rows[0];
   455	
   456	        // Enviar email de boas-vindas
   457	        await sendEmail(
   458	            email,
   459	            'Bem-vindo ao Leads Para Todos!',
   460	            emailTemplates.welcome(name)
   461	        );
   462	
   463	        console.log('✅ Usuário registrado com sucesso:', user.id);
   464	
   465	        res.status(201).json({
   466	            message: 'Usuário criado com sucesso',
   467	            user: {
   468	                id: user.id,
   469	                name: user.name,
   470	                email: user.email,
   471	                credits_balance: user.credits_balance,
   472	                role: user.role
   473	            }
   474	        });
   475	    } catch (error) {
   476	        console.error('❌ Erro no registro:', error);
   477	        res.status(500).json({ error: 'Erro ao registrar usuário' });
   478	    }
   479	});
   480	
   481	// Login
   482	app.post('/api/auth/login', async (req, res) => {
   483	    try {
   484	        const { email, password } = req.body;
   485	
   486	        console.log('🔐 Tentativa de login:', email);
   487	
   488	        if (!email || !password) {
   489	            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
   490	        }
   491	
   492	        // Buscar usuário
   493	        const result = await pool.query(
   494	            'SELECT id, name, email, password, credits_balance, role, status FROM users WHERE email = $1',
   495	            [email.toLowerCase()]
   496	        );
   497	
   498	        if (result.rows.length === 0) {
   499	            return res.status(401).json({ error: 'Email ou senha incorretos' });
   500	        }
   501	
   502	        const user = result.rows[0];
   503	
   504	        // Verificar senha
   505	        const validPassword = await bcrypt.compare(password, user.password);
   506	        if (!validPassword) {
   507	            return res.status(401).json({ error: 'Email ou senha incorretos' });
   508	        }
   509	
   510	        // Verificar status da conta
   511	        if (user.status !== 'active') {
   512	            return res.status(403).json({ error: 'Conta inativa' });
   513	        }
   514	
   515	        // Gerar token JWT
   516	        const token = jwt.sign(
   517	            { userId: user.id, email: user.email },
   518	            process.env.JWT_SECRET || 'secret-key-default',
   519	            { expiresIn: '7d' }
   520	        );
   521	
   522	        console.log('✅ Login realizado com sucesso:', user.id);
   523	
   524	        res.json({
   525	            token,
   526	            user: {
   527	                id: user.id,
   528	                name: user.name,
   529	                email: user.email,
   530	                credits_balance: user.credits_balance,
   531	                role: user.role
   532	            }
   533	        });
   534	    } catch (error) {
   535	        console.error('❌ Erro no login:', error);
   536	        res.status(500).json({ error: 'Erro ao fazer login' });
   537	    }
   538	});
   539	
   540	// Perfil do usuário
   541	app.get('/api/auth/profile', authMiddleware, async (req, res) => {
   542	    try {
   543	        const result = await pool.query(
   544	            'SELECT id, name, email, credits_balance, role, status, created_at FROM users WHERE id = $1',
   545	            [req.userId]
   546	        );
   547	
   548	        if (result.rows.length === 0) {
   549	            return res.status(404).json({ error: 'Usuário não encontrado' });
   550	        }
   551	
   552	        res.json({ user: result.rows[0] });
   553	    } catch (error) {
   554	        console.error('❌ Erro ao buscar perfil:', error);
   555	        res.status(500).json({ error: 'Erro ao buscar perfil' });
   556	    }
   557	});
   558	
   559	// Esqueci minha senha
   560	app.post('/api/auth/forgot-password', async (req, res) => {
   561	    try {
   562	        const { email } = req.body;
   563	
   564	        console.log('🔑 Solicitação de recuperação de senha:', email);
   565	
   566	        const result = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email]);
   567	
   568	        if (result.rows.length === 0) {
   569	            return res.status(404).json({ error: 'Email não encontrado' });
   570	        }
   571	
   572	        const user = result.rows[0];
   573	        const resetToken = crypto.randomBytes(32).toString('hex');
   574	        const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hora
   575	
   576	        await pool.query(
   577	            'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
   578	            [resetToken, resetTokenExpiry, user.id]
   579	        );
   580	
   581	        const resetUrl = `https://jkvzqvlk.gensparkspace.com/reset-password.html?token=${resetToken}`;
   582	
   583	        await sendEmail(
   584	            email,
   585	            'Recuperação de Senha - Leads Para Todos',
   586	            emailTemplates.resetPassword(user.name, resetUrl)
   587	        );
   588	
   589	        console.log('✅ Email de recuperação enviado para:', email);
   590	
   591	        res.json({ message: 'Email de recuperação enviado com sucesso' });
   592	    } catch (error) {
   593	        console.error('❌ Erro na recuperação de senha:', error);
   594	        res.status(500).json({ error: 'Erro ao processar recuperação de senha' });
   595	    }
   596	});
   597	
   598	// Resetar senha
   599	app.post('/api/auth/reset-password', async (req, res) => {
   600	    try {
   601	        const { token, newPassword } = req.body;
   602	
   603	        console.log('🔄 Tentativa de reset de senha');
   604	
   605	        const result = await pool.query(
   606	            'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
   607	            [token]
   608	        );
   609	
   610	        if (result.rows.length === 0) {
   611	            return res.status(400).json({ error: 'Token inválido ou expirado' });
   612	        }
   613	
   614	        const userId = result.rows[0].id;
   615	        const hashedPassword = await bcrypt.hash(newPassword, 10);
   616	
   617	        await pool.query(
   618	            'UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
   619	            [hashedPassword, userId]
   620	        );
   621	
   622	        console.log('✅ Senha resetada com sucesso para usuário:', userId);
   623	
   624	        res.json({ message: 'Senha alterada com sucesso' });
   625	    } catch (error) {
   626	        console.error('❌ Erro ao resetar senha:', error);
   627	        res.status(500).json({ error: 'Erro ao resetar senha' });
   628	    }
   629	});
   630	
   631	// ==================== ROTAS DE PAGAMENTO ====================
   632	
   633	// Processar pagamento com CARTÃO
   634	app.post('/api/payment/process-card', authMiddleware, async (req, res) => {
   635	    try {
   636	        console.log('💳 [CARTÃO] Recebendo pagamento via CARTÃO...');
   637	        console.log('📦 [CARTÃO] Body completo:', JSON.stringify(req.body, null, 2));
   638	
   639	        const { package_id, payment_data, coupon, discount, final_price } = req.body;
   640	
   641	        // Validar dados obrigatórios
   642	        if (!package_id || !payment_data) {
   643	            console.log('❌ [CARTÃO] Dados obrigatórios faltando');
   644	            return res.status(400).json({ error: 'Dados de pagamento incompletos' });
   645	        }
   646	
   647	        // Buscar pacote ou criar pacote personalizado
   648	        let selectedPackage;
   649	        
   650	        if (package_id === 'personalizado' || package_id === 'package_custom') {
   651	            // Pacote personalizado
   652	            const { credits, amount } = req.body;
   653	            if (!credits || credits < 1000) {
   654	                return res.status(400).json({ error: 'Quantidade mínima de créditos é 1.000' });
   655	            }
   656	            
   657	            // O amount do frontend já vem em centavos
   658	            let priceInCents = amount || (credits * 14);
   659	            
   660	            // Se o amount veio como número decimal (reais), converter para centavos
   661	            if (amount && amount < 100 && credits >= 1000) {
   662	                priceInCents = Math.round(amount * 100);
   663	            }
   664	            
   665	            selectedPackage = {
   666	                id: 'package_custom',
   667	                name: `${credits.toLocaleString('pt-BR')} Créditos (Personalizado)`,
   668	                credits: credits,
   669	                price: priceInCents // Preço em centavos
   670	            };
   671	            console.log('✅ [CARTÃO] Pacote PERSONALIZADO criado:', selectedPackage);
   672	        } else {
   673	            // Pacote fixo
   674	            selectedPackage = PACKAGES[package_id];
   675	            if (!selectedPackage) {
   676	                console.log('❌ [CARTÃO] Pacote não encontrado:', package_id);
   677	                return res.status(400).json({ error: 'Pacote inválido' });
   678	            }
   679	            console.log('✅ [CARTÃO] Pacote FIXO encontrado:', selectedPackage);
   680	        }
   681	
   682	        // Buscar dados do usuário
   683	        const userResult = await pool.query(
   684	            'SELECT id, name, email FROM users WHERE id = $1',
   685	            [req.userId]
   686	        );
   687	
   688	        if (userResult.rows.length === 0) {
   689	            console.log('❌ [CARTÃO] Usuário não encontrado:', req.userId);
   690	            return res.status(404).json({ error: 'Usuário não encontrado' });
   691	        }
   692	
   693	        const user = userResult.rows[0];
   694	        console.log('✅ [CARTÃO] Usuário encontrado:', user);
   695	
   696	        // Aplicar cupom se fornecido
   697	        let finalPrice = selectedPackage.price;
   698	        let discountAmount = 0;
   699	        let appliedCoupon = null;
   700	
   701	        if (coupon) {
   702	            appliedCoupon = validateCoupon(coupon);
   703	            if (appliedCoupon) {
   704	                discountAmount = calculateDiscount(selectedPackage.price, appliedCoupon);
   705	                finalPrice = selectedPackage.price - discountAmount;
   706	                console.log(`✅ [CARTÃO] Cupom aplicado: ${coupon} - ${appliedCoupon.discount}%`);
   707	                console.log(`💰 [CARTÃO] Preço original: R$ ${(selectedPackage.price / 100).toFixed(2)}`);
   708	                console.log(`💰 [CARTÃO] Desconto: R$ ${(discountAmount / 100).toFixed(2)}`);
   709	                console.log(`💰 [CARTÃO] Preço final: R$ ${(finalPrice / 100).toFixed(2)}`);
   710	            }
   711	        }
   712	
   713	        // Criar registro de transação
   714	        const transactionResult = await pool.query(
   715	            `INSERT INTO transactions 
   716	            (user_id, package_id, amount, status, payment_method, credits, coupon_code, discount_amount) 
   717	            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
   718	            RETURNING id`,
   719	            [
   720	                user.id,
   721	                selectedPackage.id,
   722	                finalPrice,
   723	                'pending',
   724	                'credit_card',
   725	                selectedPackage.credits,
   726	                appliedCoupon?.code || null,
   727	                discountAmount
   728	            ]
   729	        );
   730	
   731	        const transactionId = transactionResult.rows[0].id;
   732	        console.log('✅ [CARTÃO] Transação criada:', transactionId);
   733	
   734	        // Preparar payload para Mercado Pago
   735	        const paymentPayload = {
   736	            transaction_amount: finalPrice / 100, // Converter centavos para reais
   737	            token: payment_data.token,
   738	            description: selectedPackage.name,
   739	            installments: payment_data.installments || 1,
   740	            payment_method_id: payment_data.payment_method_id,
   741	            payer: {
   742	                email: user.email,
   743	                identification: {
   744	                    type: payment_data.payer?.identification?.type || 'CPF',
   745	                    number: payment_data.payer?.identification?.number || '00000000000'
   746	                }
   747	            },
   748	            notification_url: `${process.env.BACKEND_URL}/api/webhook/mercadopago`,
   749	            external_reference: transactionId.toString()
   750	        };
   751	
   752	        console.log('🚀 [CARTÃO] Enviando pagamento para Mercado Pago...');
   753	        console.log('📤 [CARTÃO] Payload:', JSON.stringify(paymentPayload, null, 2));
   754	
   755	        // Criar pagamento no Mercado Pago
   756	        const payment = await mercadopago.payment.create(paymentPayload);
   757	
   758	        console.log('📥 [CARTÃO] Resposta Mercado Pago:', JSON.stringify(payment.body, null, 2));
   759	
   760	        // Atualizar transação com payment_id
   761	        await pool.query(
   762	            'UPDATE transactions SET payment_id = $1, status = $2 WHERE id = $3',
   763	            [payment.body.id, payment.body.status, transactionId]
   764	        );
   765	
   766	        // Se pagamento aprovado, adicionar créditos
   767	        if (payment.body.status === 'approved') {
   768	            console.log('✅ [CARTÃO] Pagamento APROVADO! Adicionando créditos...');
   769	            
   770	            await pool.query(
   771	                'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
   772	                [selectedPackage.credits, user.id]
   773	            );
   774	
   775	            await pool.query(
   776	                'UPDATE transactions SET status = $1 WHERE id = $2',
   777	                ['approved', transactionId]
   778	            );
   779	
   780	            // Enviar email de confirmação
   781	            await sendEmail(
   782	                user.email,
   783	                'Pagamento Aprovado - Leads Para Todos',
   784	                emailTemplates.paymentApproved(user.name, selectedPackage.credits, selectedPackage.name)
   785	            );
   786	
   787	            console.log(`✅ [CARTÃO] Créditos adicionados! Novo saldo: ${selectedPackage.credits}`);
   788	        }
   789	
   790	        res.json({
   791	            success: true,
   792	            status: payment.body.status,
   793	            payment_id: payment.body.id,
   794	            transaction_id: transactionId
   795	        });
   796	
   797	    } catch (error) {
   798	        console.error('❌ [CARTÃO] Erro ao processar pagamento:', error);
   799	        res.status(500).json({ 
   800	            error: 'Erro ao processar pagamento',
   801	            details: error.message 
   802	        });
   803	    }
   804	});
   805	
   806	// Processar pagamento com PIX
   807	app.post('/api/payment/process-pix', authMiddleware, async (req, res) => {
   808	    try {
   809	        console.log('💳 [PIX] Recebendo pagamento via PIX...');
   810	        console.log('📦 [PIX] Body completo:', JSON.stringify(req.body, null, 2));
   811	
   812	        const { package_id, amount, credits, coupon, discount } = req.body;
   813	
   814	        // Validar dados obrigatórios
   815	        if (!package_id) {
   816	            console.log('❌ [PIX] package_id não fornecido');
   817	            return res.status(400).json({ error: 'Pacote não especificado' });
   818	        }
   819	
   820	        // Buscar pacote ou criar pacote personalizado
   821	        let selectedPackage;
   822	        
   823	        if (package_id === 'personalizado' || package_id === 'package_custom') {
   824	            // Pacote personalizado
   825	            if (!credits || credits < 1000) {
   826	                return res.status(400).json({ error: 'Quantidade mínima de créditos é 1.000' });
   827	            }
   828	            
   829	            // O amount do frontend já vem em centavos
   830	            let priceInCents = amount || (credits * 14);
   831	            
   832	            // Se o amount veio como número decimal (reais), converter para centavos
   833	            if (amount && amount < 100 && credits >= 1000) {
   834	                priceInCents = Math.round(amount * 100);
   835	            }
   836	            
   837	            selectedPackage = {
   838	                id: 'package_custom',
   839	                name: `${credits.toLocaleString('pt-BR')} Créditos (Personalizado)`,
   840	                credits: credits,
   841	                price: priceInCents // Preço em centavos
   842	            };
   843	            console.log('✅ [PIX] Pacote PERSONALIZADO criado:', selectedPackage);
   844	        } else {
   845	            // Pacote fixo
   846	            selectedPackage = PACKAGES[package_id];
   847	            if (!selectedPackage) {
   848	                console.log('❌ [PIX] Pacote não encontrado:', package_id);
   849	                console.log('📋 [PIX] Pacotes disponíveis:', Object.keys(PACKAGES));
   850	                return res.status(400).json({ error: 'Pacote inválido' });
   851	            }
   852	            console.log('✅ [PIX] Pacote FIXO encontrado:', selectedPackage);
   853	        }
   854	
   855	        // Buscar dados do usuário
   856	        const userResult = await pool.query(
   857	            'SELECT id, name, email FROM users WHERE id = $1',
   858	            [req.userId]
   859	        );
   860	
   861	        if (userResult.rows.length === 0) {
   862	            console.log('❌ [PIX] Usuário não encontrado:', req.userId);
   863	            return res.status(404).json({ error: 'Usuário não encontrado' });
   864	        }
   865	
   866	        const user = userResult.rows[0];
   867	        console.log('✅ [PIX] Usuário encontrado:', { id: user.id, name: user.name, email: user.email });
   868	
   869	        // Aplicar cupom se fornecido
   870	        let finalPrice = selectedPackage.price;
   871	        let discountAmount = 0;
   872	        let appliedCoupon = null;
   873	
   874	        if (coupon) {
   875	            appliedCoupon = validateCoupon(coupon);
   876	            if (appliedCoupon) {
   877	                discountAmount = calculateDiscount(selectedPackage.price, appliedCoupon);
   878	                finalPrice = selectedPackage.price - discountAmount;
   879	                console.log(`✅ [PIX] Cupom aplicado: ${coupon} - ${appliedCoupon.discount}%`);
   880	                console.log(`💰 [PIX] Preço original: R$ ${(selectedPackage.price / 100).toFixed(2)}`);
   881	                console.log(`💰 [PIX] Desconto: R$ ${(discountAmount / 100).toFixed(2)}`);
   882	                console.log(`💰 [PIX] Preço final: R$ ${(finalPrice / 100).toFixed(2)}`);
   883	            }
   884	        }
   885	
   886	        // Criar registro de transação
   887	        const transactionResult = await pool.query(
   888	            `INSERT INTO transactions 
   889	            (user_id, package_id, amount, status, payment_method, credits, coupon_code, discount_amount) 
   890	            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
   891	            RETURNING id`,
   892	            [
   893	                user.id,
   894	                selectedPackage.id,
   895	                finalPrice,
   896	                'pending',
   897	                'pix',
   898	                selectedPackage.credits,
   899	                appliedCoupon?.code || null,
   900	                discountAmount
   901	            ]
   902	        );
   903	
   904	        const transactionId = transactionResult.rows[0].id;
   905	        console.log('✅ [PIX] Transação criada:', transactionId);
   906	
   907	        // Preparar payload para Mercado Pago PIX
   908	        const pixPayload = {
   909	            transaction_amount: finalPrice / 100, // Converter centavos para reais
   910	            description: selectedPackage.name,
   911	            payment_method_id: 'pix',
   912	            payer: {
   913	                email: user.email,
   914	                first_name: user.name.split(' ')[0],
   915	                last_name: user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0]
   916	            },
   917	            notification_url: `${process.env.BACKEND_URL}/api/webhook/mercadopago`,
   918	            external_reference: transactionId.toString()
   919	        };
   920	
   921	        console.log('🚀 [PIX] Enviando pagamento PIX para Mercado Pago...');
   922	        console.log('📤 [PIX] Payload:', JSON.stringify(pixPayload, null, 2));
   923	
   924	        // Criar pagamento PIX no Mercado Pago
   925	        const payment = await mercadopago.payment.create(pixPayload);
   926	
   927	        console.log('📥 [PIX] Resposta Mercado Pago:', JSON.stringify(payment.body, null, 2));
   928	
   929	        // Atualizar transação com payment_id
   930	        await pool.query(
   931	            'UPDATE transactions SET payment_id = $1, status = $2 WHERE id = $3',
   932	            [payment.body.id, payment.body.status, transactionId]
   933	        );
   934	
   935	        // Extrair dados do QR Code
   936	        const qrCodeData = payment.body.point_of_interaction?.transaction_data;
   937	        
   938	        if (!qrCodeData || !qrCodeData.qr_code_base64) {
   939	            console.error('❌ [PIX] QR Code não gerado pelo Mercado Pago');
   940	            return res.status(500).json({ error: 'Erro ao gerar QR Code' });
   941	        }
   942	
   943	        console.log('✅ [PIX] QR Code gerado com sucesso');
   944	        console.log('🔍 [PIX] QR Code Base64 length:', qrCodeData.qr_code_base64?.length);
   945	        console.log('🔍 [PIX] QR Code Text length:', qrCodeData.qr_code?.length);
   946	
   947	        res.json({
   948	            success: true,
   949	            payment_id: payment.body.id,
   950	            transaction_id: transactionId,
   951	            qr_code_base64: qrCodeData.qr_code_base64,
   952	            qr_code: qrCodeData.qr_code,
   953	            qr_code_text: qrCodeData.qr_code,
   954	            amount: finalPrice / 100
   955	        });
   956	
   957	    } catch (error) {
   958	        console.error('❌ [PIX] Erro ao processar pagamento:', error);
   959	        res.status(500).json({ 
   960	            error: 'Erro ao processar pagamento PIX',
   961	            details: error.message 
   962	        });
   963	    }
   964	});
   965	
   966	// Webhook do Mercado Pago
   967	app.post('/api/webhook/mercadopago', async (req, res) => {
   968	    try {
   969	        console.log('🔔 [WEBHOOK] Notificação recebida do Mercado Pago');
   970	        console.log('📦 [WEBHOOK] Body:', JSON.stringify(req.body, null, 2));
   971	
   972	        const { type, data } = req.body;
   973	
   974	        // Responder imediatamente ao Mercado Pago
   975	        res.sendStatus(200);
   976	
   977	        if (type === 'payment') {
   978	            const paymentId = data.id;
   979	            console.log('💳 [WEBHOOK] Processando pagamento:', paymentId);
   980	
   981	            // Buscar informações do pagamento no Mercado Pago
   982	            const payment = await mercadopago.payment.get(paymentId);
   983	            console.log('📥 [WEBHOOK] Status do pagamento:', payment.body.status);
   984	
   985	            if (payment.body.status === 'approved') {
   986	                console.log('✅ [WEBHOOK] Pagamento APROVADO! Adicionando créditos...');
   987	
   988	                const externalReference = payment.body.external_reference;
   989	
   990	                // Buscar transação
   991	                const transactionResult = await pool.query(
   992	                    'SELECT t.id, t.user_id, t.credits, t.status, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.id = $1',
   993	                    [externalReference]
   994	                );
   995	
   996	                if (transactionResult.rows.length === 0) {
   997	                    console.error('❌ [WEBHOOK] Transação não encontrada:', externalReference);
   998	                    return;
   999	                }
  1000	
  1001	                const transaction = transactionResult.rows[0];
  1002	
  1003	                // Verificar se já foi processado
  1004	                if (transaction.status === 'approved') {
  1005	                    console.log('⚠️ [WEBHOOK] Pagamento já processado anteriormente');
  1006	                    return;
  1007	                }
  1008	
  1009	                // Adicionar créditos
  1010	                await pool.query(
  1011	                    'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
  1012	                    [transaction.credits, transaction.user_id]
  1013	                );
  1014	
  1015	                // Atualizar status da transação
  1016	                await pool.query(
  1017	                    'UPDATE transactions SET status = $1 WHERE id = $2',
  1018	                    ['approved', transaction.id]
  1019	                );
  1020	
  1021	                // Enviar email de confirmação
  1022	                await sendEmail(
  1023	                    transaction.email,
  1024	                    'Pagamento Aprovado - Leads Para Todos',
  1025	                    emailTemplates.paymentApproved(
  1026	                        transaction.name,
  1027	                        transaction.credits,
  1028	                        `${transaction.credits.toLocaleString('pt-BR')} Créditos`
  1029	                    )
  1030	                );
  1031	
  1032	                console.log(`✅ [WEBHOOK] Créditos adicionados! Usuário: ${transaction.user_id}, Créditos: ${transaction.credits}`);
  1033	            }
  1034	        }
  1035	    } catch (error) {
  1036	        console.error('❌ [WEBHOOK] Erro ao processar webhook:', error);
  1037	    }
  1038	});
  1039	
  1040	// Verificar status de pagamento
  1041	app.get('/api/payment/status/:payment_id', authMiddleware, async (req, res) => {
  1042	    try {
  1043	        const { payment_id } = req.params;
  1044	
  1045	        const payment = await mercadopago.payment.get(payment_id);
  1046	
  1047	        res.json({
  1048	            status: payment.body.status,
  1049	            status_detail: payment.body.status_detail
  1050	        });
  1051	    } catch (error) {
  1052	        console.error('❌ Erro ao verificar status do pagamento:', error);
  1053	        res.status(500).json({ error: 'Erro ao verificar status do pagamento' });
  1054	    }
  1055	});
  1056	
  1057	// Listar transações do usuário
  1058	app.get('/api/transactions', authMiddleware, async (req, res) => {
  1059	    try {
  1060	        const result = await pool.query(
  1061	            'SELECT id, package_id, amount, status, payment_method, credits, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
  1062	            [req.userId]
  1063	        );
  1064	
  1065	        res.json({ transactions: result.rows });
  1066	    } catch (error) {
  1067	        console.error('❌ Erro ao buscar transações:', error);
  1068	        res.status(500).json({ error: 'Erro ao buscar transações' });
  1069	    }
  1070	});
  1071	
  1072	// ==================== ROTAS DE SOLICITAÇÕES DE LEADS ====================
  1073	
  1074	// Criar solicitação de leads (reservar créditos)
  1075	app.post('/api/leads-requests', authMiddleware, async (req, res) => {
  1076	    try {
  1077	        const { credits_requested, filters, whatsapp_message } = req.body;
  1078	        
  1079	        console.log('📝 [LEADS-REQUEST] Nova solicitação:', { userId: req.userId, credits: credits_requested });
  1080	        
  1081	        // Validar créditos solicitados
  1082	        if (!credits_requested || credits_requested < 1000) {
  1083	            return res.status(400).json({ error: 'Quantidade mínima é 1.000 créditos' });
  1084	        }
  1085	        
  1086	        // Buscar dados do usuário
  1087	        const userResult = await pool.query(
  1088	            'SELECT id, name, email, credits_balance, credits_reserved FROM users WHERE id = $1',
  1089	            [req.userId]
  1090	        );
  1091	        
  1092	        if (userResult.rows.length === 0) {
  1093	            return res.status(404).json({ error: 'Usuário não encontrado' });
  1094	        }
  1095	        
  1096	        const user = userResult.rows[0];
  1097	        const creditsReserved = user.credits_reserved || 0;
  1098	        const creditsAvailable = user.credits_balance - creditsReserved;
  1099	        
  1100	        console.log('💰 [LEADS-REQUEST] Créditos disponíveis:', creditsAvailable);
  1101	        
  1102	        // Verificar se tem créditos suficientes
  1103	        if (creditsAvailable < credits_requested) {
  1104	            return res.status(400).json({ 
  1105	                error: 'Créditos insuficientes',
  1106	                available: creditsAvailable,
  1107	                requested: credits_requested
  1108	            });
  1109	        }
  1110	        
  1111	        // Criar solicitação
  1112	        const requestResult = await pool.query(`
  1113	            INSERT INTO leads_requests 
  1114	            (user_id, credits_requested, status, filters, whatsapp_message, created_at, expires_at) 
  1115	            VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + INTERVAL '24 hours') 
  1116	            RETURNING *
  1117	        `, [user.id, credits_requested, 'pending', JSON.stringify(filters), whatsapp_message]);
  1118	        
  1119	        const request = requestResult.rows[0];
  1120	        
  1121	        // Atualizar créditos reservados do usuário
  1122	        await pool.query(
  1123	            'UPDATE users SET credits_reserved = credits_reserved + $1 WHERE id = $2',
  1124	            [credits_requested, user.id]
  1125	        );
  1126	        
  1127	        console.log('✅ [LEADS-REQUEST] Solicitação criada:', request.id);
  1128	        console.log('🔒 [LEADS-REQUEST] Créditos reservados:', credits_requested);
  1129	        
  1130	        res.json({
  1131	            success: true,
  1132	            request: request,
  1133	            credits_remaining: creditsAvailable - credits_requested
  1134	        });
  1135	        
  1136	    } catch (error) {
  1137	        console.error('❌ [LEADS-REQUEST] Erro:', error);
  1138	        res.status(500).json({ error: 'Erro ao criar solicitação' });
  1139	    }
  1140	});
  1141	
  1142	// Listar solicitações do usuário
  1143	app.get('/api/leads-requests', authMiddleware, async (req, res) => {
  1144	    try {
  1145	        const result = await pool.query(`
  1146	            SELECT * FROM leads_requests 
  1147	            WHERE user_id = $1 
  1148	            ORDER BY created_at DESC
  1149	        `, [req.userId]);
  1150	        
  1151	        res.json({ requests: result.rows });
  1152	    } catch (error) {
  1153	        console.error('❌ Erro ao buscar solicitações:', error);
  1154	        res.status(500).json({ error: 'Erro ao buscar solicitações' });
  1155	    }
  1156	});
  1157	
  1158	// Cancelar solicitação (cliente)
  1159	app.post('/api/leads-requests/:id/cancel', authMiddleware, async (req, res) => {
  1160	    try {
  1161	        const { id } = req.params;
  1162	        
  1163	        // Buscar solicitação
  1164	        const requestResult = await pool.query(
  1165	            'SELECT * FROM leads_requests WHERE id = $1 AND user_id = $2',
  1166	            [id, req.userId]
  1167	        );
  1168	        
  1169	        if (requestResult.rows.length === 0) {
  1170	            return res.status(404).json({ error: 'Solicitação não encontrada' });
  1171	        }
  1172	        
  1173	        const request = requestResult.rows[0];
  1174	        
  1175	        if (request.status !== 'pending') {
  1176	            return res.status(400).json({ error: 'Solicitação já foi processada' });
  1177	        }
  1178	        
  1179	        // Liberar créditos reservados
  1180	        await pool.query(
  1181	            'UPDATE users SET credits_reserved = credits_reserved - $1 WHERE id = $2',
  1182	            [request.credits_requested, req.userId]
  1183	        );
  1184	        
  1185	        // Marcar como cancelada
  1186	        await pool.query(
  1187	            'UPDATE leads_requests SET status = $1, cancelled_at = NOW() WHERE id = $2',
  1188	            ['cancelled', id]
  1189	        );
  1190	        
  1191	        console.log('🚫 [LEADS-REQUEST] Solicitação cancelada:', id);
  1192	        
  1193	        res.json({ success: true, message: 'Solicitação cancelada com sucesso' });
  1194	    } catch (error) {
  1195	        console.error('❌ Erro ao cancelar solicitação:', error);
  1196	        res.status(500).json({ error: 'Erro ao cancelar solicitação' });
  1197	    }
  1198	});
  1199	
  1200	// ==================== ROTAS ADMIN - GERENCIAR SOLICITAÇÕES ====================
  1201	
  1202	// Listar todas as solicitações (admin)
  1203	app.get('/api/admin/leads-requests', authMiddleware, adminMiddleware, async (req, res) => {
  1204	    try {
  1205	        const { status } = req.query;
  1206	        
  1207	        let query = `
  1208	            SELECT 
  1209	                lr.*,
  1210	                u.name as user_name,
  1211	                u.email as user_email,
  1212	                u.credits_balance
  1213	            FROM leads_requests lr
  1214	            JOIN users u ON lr.user_id = u.id
  1215	        `;
  1216	        
  1217	        const params = [];
  1218	        
  1219	        if (status) {
  1220	            query += ' WHERE lr.status = $1';
  1221	            params.push(status);
  1222	        }
  1223	        
  1224	        query += ' ORDER BY lr.created_at DESC';
  1225	        
  1226	        const result = await pool.query(query, params);
  1227	        
  1228	        res.json({ requests: result.rows });
  1229	    } catch (error) {
  1230	        console.error('❌ Erro ao buscar solicitações admin:', error);
  1231	        res.status(500).json({ error: 'Erro ao buscar solicitações' });
  1232	    }
  1233	});
  1234	
  1235	// Confirmar entrega (admin)
  1236	app.post('/api/admin/leads-requests/:id/confirm', authMiddleware, adminMiddleware, async (req, res) => {
  1237	    try {
  1238	        const { id } = req.params;
  1239	        const { admin_notes } = req.body;
  1240	        
  1241	        // Buscar solicitação
  1242	        const requestResult = await pool.query(
  1243	            'SELECT * FROM leads_requests WHERE id = $1',
  1244	            [id]
  1245	        );
  1246	        
  1247	        if (requestResult.rows.length === 0) {
  1248	            return res.status(404).json({ error: 'Solicitação não encontrada' });
  1249	        }
  1250	        
  1251	        const request = requestResult.rows[0];
  1252	        
  1253	        if (request.status !== 'pending') {
  1254	            return res.status(400).json({ error: 'Solicitação já foi processada' });
  1255	        }
  1256	        
  1257	        // Debitar créditos do usuário
  1258	        await pool.query(`
  1259	            UPDATE users 
  1260	            SET 
  1261	                credits_balance = credits_balance - $1,
  1262	                credits_reserved = credits_reserved - $1
  1263	            WHERE id = $2
  1264	        `, [request.credits_requested, request.user_id]);
  1265	        
  1266	        // Marcar como confirmada
  1267	        await pool.query(`
  1268	            UPDATE leads_requests 
  1269	            SET 
  1270	                status = $1, 
  1271	                confirmed_at = NOW(),
  1272	                admin_notes = $2
  1273	            WHERE id = $3
  1274	        `, ['confirmed', admin_notes, id]);
  1275	        
  1276	        console.log('✅ [LEADS-REQUEST-ADMIN] Entrega confirmada:', id);
  1277	        console.log('💰 [LEADS-REQUEST-ADMIN] Créditos debitados:', request.credits_requested);
  1278	        
  1279	        res.json({ success: true, message: 'Entrega confirmada com sucesso' });
  1280	    } catch (error) {
  1281	        console.error('❌ Erro ao confirmar entrega:', error);
  1282	        res.status(500).json({ error: 'Erro ao confirmar entrega' });
  1283	    }
  1284	});
  1285	
  1286	// Cancelar solicitação (admin)
  1287	app.post('/api/admin/leads-requests/:id/cancel', authMiddleware, adminMiddleware, async (req, res) => {
  1288	    try {
  1289	        const { id } = req.params;
  1290	        const { admin_notes } = req.body;
  1291	        
  1292	        // Buscar solicitação
  1293	        const requestResult = await pool.query(
  1294	            'SELECT * FROM leads_requests WHERE id = $1',
  1295	            [id]
  1296	        );
  1297	        
  1298	        if (requestResult.rows.length === 0) {
  1299	            return res.status(404).json({ error: 'Solicitação não encontrada' });
  1300	        }
  1301	        
  1302	        const request = requestResult.rows[0];
  1303	        
  1304	        if (request.status !== 'pending') {
  1305	            return res.status(400).json({ error: 'Solicitação já foi processada' });
  1306	        }
  1307	        
  1308	        // Liberar créditos reservados
  1309	        await pool.query(
  1310	            'UPDATE users SET credits_reserved = credits_reserved - $1 WHERE id = $2',
  1311	            [request.credits_requested, request.user_id]
  1312	        );
  1313	        
  1314	        // Marcar como cancelada
  1315	        await pool.query(`
  1316	            UPDATE leads_requests 
  1317	            SET 
  1318	                status = $1, 
  1319	                cancelled_at = NOW(),
  1320	                admin_notes = $2
  1321	            WHERE id = $3
  1322	        `, ['cancelled', admin_notes, id]);
  1323	        
  1324	        console.log('🚫 [LEADS-REQUEST-ADMIN] Solicitação cancelada:', id);
  1325	        
  1326	        res.json({ success: true, message: 'Solicitação cancelada com sucesso' });
  1327	    } catch (error) {
  1328	        console.error('❌ Erro ao cancelar solicitação (admin):', error);
  1329	        res.status(500).json({ error: 'Erro ao cancelar solicitação' });
  1330	    }
  1331	});
  1332	
  1333	// Job para liberar créditos expirados (executar a cada hora)
  1334	app.get('/api/cron/expire-requests', async (req, res) => {
  1335	    try {
  1336	        console.log('⏰ [CRON] Verificando solicitações expiradas...');
  1337	        
  1338	        // Buscar solicitações pendentes e expiradas
  1339	        const expiredResult = await pool.query(`
  1340	            SELECT * FROM leads_requests 
  1341	            WHERE status = 'pending' 
  1342	            AND expires_at < NOW()
  1343	        `);
  1344	        
  1345	        const expired = expiredResult.rows;
  1346	        
  1347	        if (expired.length === 0) {
  1348	            console.log('✅ [CRON] Nenhuma solicitação expirada');
  1349	            return res.json({ success: true, expired_count: 0 });
  1350	        }
  1351	        
  1352	        console.log(`⚠️ [CRON] ${expired.length} solicitações expiradas encontradas`);
  1353	        
  1354	        // Processar cada uma
  1355	        for (const request of expired) {
  1356	            // Liberar créditos
  1357	            await pool.query(
  1358	                'UPDATE users SET credits_reserved = credits_reserved - $1 WHERE id = $2',
  1359	                [request.credits_requested, request.user_id]
  1360	            );
  1361	            
  1362	            // Marcar como expirada
  1363	            await pool.query(
  1364	                'UPDATE leads_requests SET status = $1, cancelled_at = NOW() WHERE id = $2',
  1365	                ['expired', request.id]
  1366	            );
  1367	            
  1368	            console.log(`🔓 [CRON] Créditos liberados: ${request.credits_requested} (Request ID: ${request.id})`);
  1369	        }
  1370	        
  1371	        console.log(`✅ [CRON] ${expired.length} solicitações expiradas processadas`);
  1372	        
  1373	        res.json({ 
  1374	            success: true, 
  1375	            expired_count: expired.length,
  1376	            requests: expired.map(r => ({ id: r.id, credits: r.credits_requested }))
  1377	        });
  1378	    } catch (error) {
  1379	        console.error('❌ [CRON] Erro ao processar expirações:', error);
  1380	        res.status(500).json({ error: 'Erro ao processar expirações' });
  1381	    }
  1382	});
  1383	
  1384	// ==================== ROTAS ADMIN ====================
  1385	
  1386	// Dashboard admin
  1387	app.get('/api/admin/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
  1388	    try {
  1389	        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
  1390	        const transactionsCount = await pool.query('SELECT COUNT(*) FROM transactions');
  1391	        const revenue = await pool.query('SELECT SUM(amount) FROM transactions WHERE status = $1', ['approved']);
  1392	
  1393	        res.json({
  1394	            users: parseInt(usersCount.rows[0].count),
  1395	            transactions: parseInt(transactionsCount.rows[0].count),
  1396	            revenue: parseFloat(revenue.rows[0].sum || 0) / 100
  1397	        });
  1398	    } catch (error) {
  1399	        console.error('❌ Erro ao buscar dashboard admin:', error);
  1400	        res.status(500).json({ error: 'Erro ao buscar dados do dashboard' });
  1401	    }
  1402	});
  1403	
  1404	// Listar usuários (admin)
  1405	app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  1406	    try {
  1407	        const { search = '' } = req.query;
  1408	        
  1409	        let query = 'SELECT id, name, email, phone, credits_balance, role, status, created_at FROM users';
  1410	        let params = [];
  1411	        
  1412	        if (search) {
  1413	            query += ' WHERE name ILIKE $1 OR email ILIKE $1';
  1414	            params.push(`%${search}%`);
  1415	        }
  1416	        
  1417	        query += ' ORDER BY created_at DESC';
  1418	        
  1419	        const result = await pool.query(query, params);
  1420	        res.json({ users: result.rows });
  1421	    } catch (error) {
  1422	        console.error('❌ Erro ao buscar usuários:', error);
  1423	        res.status(500).json({ error: 'Erro ao buscar usuários' });
  1424	    }
  1425	});
  1426	
  1427	app.get('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  1428	    try {
  1429	        const { userId } = req.params;
  1430	        
  1431	        const result = await pool.query(
  1432	            'SELECT id, name, email, phone, credits_balance, role, status, created_at FROM users WHERE id = $1',
  1433	            [userId]
  1434	        );
  1435	        
  1436	        if (result.rows.length === 0) {
  1437	            return res.status(404).json({ error: 'Usuário não encontrado' });
  1438	        }
  1439	        
  1440	        res.json({ user: result.rows[0] });
  1441	    } catch (error) {
  1442	        console.error('❌ Erro ao buscar usuário:', error);
  1443	        res.status(500).json({ error: 'Erro ao buscar detalhes do usuário' });
  1444	    }
  1445	});
  1446	
  1447	app.put('/api/admin/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  1448	    try {
  1449	        const { userId } = req.params;
  1450	        const { credits_balance, role, status } = req.body;
  1451	        
  1452	        const updates = [];
  1453	        const values = [];
  1454	        let paramCount = 1;
  1455	        
  1456	        if (credits_balance !== undefined) {
  1457	            updates.push(`credits_balance = $${paramCount}`);
  1458	            values.push(credits_balance);
  1459	            paramCount++;
  1460	        }
  1461	        
  1462	        if (role !== undefined) {
  1463	            updates.push(`role = $${paramCount}`);
  1464	            values.push(role);
  1465	            paramCount++;
  1466	        }
  1467	        
  1468	        if (status !== undefined) {
  1469	            updates.push(`status = $${paramCount}`);
  1470	            values.push(status);
  1471	            paramCount++;
  1472	        }
  1473	        
  1474	        if (updates.length === 0) {
  1475	            return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  1476	        }
  1477	        
  1478	        values.push(userId);
  1479	        
  1480	        await pool.query(
  1481	            `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount}`,
  1482	            values
  1483	        );
  1484	        
  1485	        res.json({ message: 'Usuário atualizado com sucesso' });
  1486	    } catch (error) {
  1487	        console.error('❌ Erro ao atualizar usuário:', error);
  1488	        res.status(500).json({ error: 'Erro ao atualizar usuário' });
  1489	    }
  1490	});
  1491	
  1492	app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  1493	    try {
  1494	        const { status = '' } = req.query;
  1495	        
  1496	        let query = `
  1497	            SELECT ct.id, ct.type, ct.amount, ct.description, ct.created_at,
  1498	                   u.name as user_name, u.email as user_email
  1499	            FROM credit_transactions ct
  1500	            JOIN users u ON ct.user_id = u.id
  1501	        `;
  1502	        
  1503	        const params = [];
  1504	        
  1505	        if (status) {
  1506	            query += ' WHERE ct.type = $1';
  1507	            params.push(status);
  1508	        }
  1509	        
  1510	        query += ' ORDER BY ct.created_at DESC LIMIT 100';
  1511	        
  1512	        const result = await pool.query(query, params);
  1513	        res.json({ transactions: result.rows });
  1514	    } catch (error) {
  1515	        console.error('❌ Erro ao listar transações:', error);
  1516	        res.status(500).json({ error: 'Erro ao listar transações' });
  1517	    }
  1518	});
  1519	
  1520	app.get('/api/admin/export/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  1521	    res.json({ message: 'Exportação em desenvolvimento' });
  1522	});
  1523	
  1524	app.get('/api/admin/export/users', authMiddleware, adminMiddleware, async (req, res) => {
  1525	    res.json({ message: 'Exportação em desenvolvimento' });
  1526	});
  1527	
  1528	// ==================== ROTA DE EMERGÊNCIA ====================
  1529	
  1530	// ROTA TEMPORÁRIA PARA RESETAR SENHA (REMOVER DEPOIS!)
  1531	app.post('/api/emergency/reset-password', async (req, res) => {
  1532	    try {
  1533	        const { email, newPassword, secretKey } = req.body;
  1534	        
  1535	        // Chave secreta para segurança
  1536	        if (secretKey !== 'LEADS2026EMERGENCY') {
  1537	            return res.status(403).json({ error: 'Chave secreta inválida' });
  1538	        }
  1539	        
  1540	        const hashedPassword = await bcrypt.hash(newPassword, 10);
  1541	        
  1542	        const result = await pool.query(
  1543	            'UPDATE users SET password = $1 WHERE email = $2 RETURNING id, email',
  1544	            [hashedPassword, email.toLowerCase()]
  1545	        );
  1546	        
  1547	        if (result.rows.length === 0) {
  1548	            return res.status(404).json({ error: 'Usuário não encontrado' });
  1549	        }
  1550	        
  1551	        console.log('🔧 Senha resetada via rota de emergência:', email);
  1552	        
  1553	        res.json({ 
  1554	            message: 'Senha resetada com sucesso',
  1555	            user: result.rows[0]
  1556	        });
  1557	    } catch (error) {
  1558	        console.error('❌ Erro ao resetar senha:', error);
  1559	        res.status(500).json({ error: 'Erro ao resetar senha' });
  1560	    }
  1561	});
  1562	
  1563	// ==================== HEALTH CHECK ====================
  1564	
  1565	app.get('/health', (req, res) => {
  1566	    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  1567	});
  1568	
  1569	// ==================== INICIAR SERVIDOR ====================
  1570	
  1571	app.listen(PORT, () => {
  1572	    console.log('\n╔═══════════════════════════════════════════════════════╗');
  1573	    console.log('║     🚀 LEADS PARA TODOS - BACKEND INICIADO          ║');
  1574	    console.log('╠═══════════════════════════════════════════════════════╣');
  1575	    console.log(`║     📡 Porta: ${PORT}                                    ║`);
  1576	    console.log(`║     🌍 Ambiente: ${process.env.NODE_ENV || 'development'}                      ║`);
  1577	    console.log(`║     🎯 Frontend: https://jkvzqvlk.gensparkspace.com  ║`);
  1578	    console.log('╠═══════════════════════════════════════════════════════╣');
  1579	    console.log(`║     💳 Mercado Pago: ${process.env.MERCADOPAGO_ACCESS_TOKEN ? '✅ Configurado' : '❌ Não configurado'}           ║`);
  1580	    console.log(`║     📧 Resend API: ${process.env.RESEND_API_KEY ? '✅ Configurado' : '❌ Não configurado'}             ║`);
  1581	    console.log('╚═══════════════════════════════════════════════════════╝\n');
  1582	});
  1583	
