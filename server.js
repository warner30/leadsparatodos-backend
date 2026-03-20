1	// ========================================
     2	// CÓDIGO COMPLETO DO SERVER.JS COM MERCADO PAGO
     3	// ========================================
     4	// Este arquivo substitui o server.js atual
     5	// Adiciona rotas de pagamento mantendo todas as funcionalidades existentes
     6	
     7	require('dotenv').config();
     8	const express = require('express');
     9	const cors = require('cors');
    10	const helmet = require('helmet');
    11	const morgan = require('morgan');
    12	const { Pool } = require('pg');
    13	const bcrypt = require('bcryptjs');
    14	const jwt = require('jsonwebtoken');
    15	const mercadopago = require('mercadopago');
    16	
    17	const app = express();
    18	const PORT = process.env.PORT || 10000;
    19	
    20	// ========================================
    21	// CONFIGURAÇÃO DO MERCADO PAGO
    22	// ========================================
    23	mercadopago.configure({
    24	    access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
    25	});
    26	
    27	console.log('💳 Mercado Pago configurado');
    28	
    29	// ========================================
    30	// DATABASE CONFIGURATION
    31	// ========================================
    32	const dbConfig = {
    33	  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    34	  ssl: { rejectUnauthorized: false }
    35	};
    36	const pool = new Pool(dbConfig);
    37	
    38	pool.connect((err, client, release) => {
    39	  if (err) console.error('❌ Erro ao conectar ao PostgreSQL:', err.stack);
    40	  else { console.log('✅ Conectado ao PostgreSQL'); release(); }
    41	});
    42	
    43	// ========================================
    44	// MIDDLEWARES
    45	// ========================================
    46	app.use(helmet());
    47	app.use(morgan('combined'));
    48	app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
    49	app.use(express.json());
    50	app.use(express.urlencoded({ extended: true }));
    51	
    52	// ========================================
    53	// HEALTH CHECK
    54	// ========================================
    55	app.get('/health', (req, res) => {
    56	  res.json({ status: 'OK', timestamp: new Date().toISOString(), uptime: process.uptime() });
    57	});
    58	
    59	// ========================================
    60	// TEST DB
    61	// ========================================
    62	app.get('/api/test-db', async (req, res) => {
    63	  try {
    64	    const result = await pool.query('SELECT NOW()');
    65	    res.json({ success: true, timestamp: result.rows[0].now, message: 'Conexão com banco de dados OK!' });
    66	  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    67	});
    68	
    69	// ========================================
    70	// AUTH MIDDLEWARE
    71	// ========================================
    72	const authMiddleware = async (req, res, next) => {
    73	  try {
    74	    const token = req.headers.authorization?.replace('Bearer ', '');
    75	    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    76	    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    77	    req.userId = decoded.id;
    78	    next();
    79	  } catch { res.status(401).json({ error: 'Token inválido' }); }
    80	};
    81	
    82	// ========================================
    83	// AUTH ROUTES (EXISTENTES)
    84	// ========================================
    85	
    86	// Register
    87	app.post('/api/auth/register', async (req, res) => {
    88	  try {
    89	    const { name, email, password, phone } = req.body;
    90	    const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    91	    if (userExists.rows.length) return res.status(400).json({ error: 'Email já cadastrado' });
    92	    const password_hash = await bcrypt.hash(password, 10);
    93	    const result = await pool.query(
    94	      'INSERT INTO users (name, email, password_hash, phone, credits_balance, role, status) VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING id,name,email,phone,credits_balance,role',
    95	      [name, email, password_hash, phone || null, 'user', 'active']
    96	    );
    97	    const user = result.rows[0];
    98	    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    99	    res.status(201).json({ user, token, message: 'Usuário criado com sucesso!' });
   100	  } catch (e) { console.error('Erro no registro:', e); res.status(500).json({ error: 'Erro ao criar usuário', details: e.message }); }
   101	});
   102	
   103	// Login
   104	app.post('/api/auth/login', async (req, res) => {
   105	  try {
   106	    const { email, password } = req.body;
   107	    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
   108	    if (!result.rows.length) return res.status(401).json({ error: 'Email ou senha incorretos' });
   109	    const user = result.rows[0];
   110	    const validPassword = await bcrypt.compare(password, user.password_hash);
   111	    if (!validPassword) return res.status(401).json({ error: 'Email ou senha incorretos' });
   112	    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
   113	    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
   114	    delete user.password_hash;
   115	    res.json({ user, token, message: 'Login realizado com sucesso!' });
   116	  } catch (e) { console.error('Erro no login:', e); res.status(500).json({ error: 'Erro ao fazer login', details: e.message }); }
   117	});
   118	
   119	// Profile
   120	app.get('/api/auth/profile', authMiddleware, async (req, res) => {
   121	  try {
   122	    const result = await pool.query('SELECT id,name,email,phone,credits_balance,role,status,created_at FROM users WHERE id = $1', [req.userId]);
   123	    if (!result.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
   124	    res.json({ user: result.rows[0] });
   125	  } catch (e) { console.error('Erro ao buscar perfil:', e); res.status(500).json({ error: 'Erro ao buscar perfil', details: e.message }); }
   126	});
   127	
   128	// ========================================
   129	// PAYMENT ROUTES (NOVAS)
   130	// ========================================
   131	
   132	// Pacotes disponíveis
   133	const PACKAGES = {
   134	  basico: { id: 'basico', name: '5.000 Créditos', credits: 5000, price: 700, discount: 0 },
   135	  popular: { id: 'popular', name: '10.000 Créditos', credits: 10000, price: 1300, discount: 7 },
   136	  melhor: { id: 'melhor', name: '20.000 Créditos', credits: 20000, price: 2400, discount: 14 },
   137	  empresarial: { id: 'empresarial', name: '50.000 Créditos', credits: 50000, price: 5500, discount: 21 }
   138	};
   139	
   140	// Criar preferência de pagamento
   141	app.post('/api/payment/create-preference', authMiddleware, async (req, res) => {
   142	  try {
   143	    const { package_id, coupon_code } = req.body;
   144	    
   145	    // Validar pacote
   146	    const pkg = PACKAGES[package_id];
   147	    if (!pkg) return res.status(400).json({ error: 'Pacote inválido' });
   148	    
   149	    // Buscar usuário
   150	    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.userId]);
   151	    if (!userResult.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
   152	    const user = userResult.rows[0];
   153	    
   154	    // Calcular valor (com cupom se houver)
   155	    let finalPrice = pkg.price;
   156	    let couponDiscount = 0;
   157	    
   158	    if (coupon_code) {
   159	      const couponResult = await pool.query(
   160	        'SELECT * FROM coupons WHERE code = $1 AND active = true AND (valid_until IS NULL OR valid_until > NOW()) AND (max_uses IS NULL OR used_count < max_uses)',
   161	        [coupon_code]
   162	      );
   163	      
   164	      if (couponResult.rows.length) {
   165	        const coupon = couponResult.rows[0];
   166	        if (coupon.discount_type === 'percentage') {
   167	          couponDiscount = (finalPrice * coupon.discount_value) / 100;
   168	        } else {
   169	          couponDiscount = coupon.discount_value;
   170	        }
   171	        finalPrice -= couponDiscount;
   172	      }
   173	    }
   174	    
   175	    // Gerar external_reference único
   176	    const external_reference = `LP-${user.id}-${Date.now()}`;
   177	    
   178	    // Salvar transação como pending
   179	    await pool.query(
   180	      'INSERT INTO transactions (user_id, external_reference, status, package_id, credits, amount) VALUES ($1, $2, $3, $4, $5, $6)',
   181	      [user.id, external_reference, 'pending', package_id, pkg.credits, finalPrice]
   182	    );
   183	    
   184	    // Criar preferência no Mercado Pago
   185	    const preference = {
   186	      items: [{
   187	        id: package_id,
   188	        title: pkg.name,
   189	        description: `${pkg.credits.toLocaleString('pt-BR')} créditos para buscar leads`,
   190	        quantity: 1,
   191	        unit_price: finalPrice,
   192	        currency_id: 'BRL'
   193	      }],
   194	      payer: {
   195	        name: user.name,
   196	        email: user.email
   197	      },
   198	      external_reference: external_reference,
   199	      back_urls: {
   200	        success: `${process.env.FRONTEND_URL}/payment-success.html`,
   201	        failure: `${process.env.FRONTEND_URL}/payment-error.html`,
   202	        pending: `${process.env.FRONTEND_URL}/payment-pending.html`
   203	      },
   204	      auto_return: 'approved',
   205	      notification_url: `${process.env.BACKEND_URL || 'https://leadsparatodos-backend-production.up.railway.app'}/api/payment/webhook`,
   206	      statement_descriptor: 'LEADS PARA TODOS',
   207	      metadata: {
   208	        user_id: user.id,
   209	        credits: pkg.credits,
   210	        package_id: package_id
   211	      }
   212	    };
   213	    
   214	    const response = await mercadopago.preferences.create(preference);
   215	    
   216	    // Atualizar transação com preference_id
   217	    await pool.query(
   218	      'UPDATE transactions SET preference_id = $1 WHERE external_reference = $2',
   219	      [response.body.id, external_reference]
   220	    );
   221	    
   222	    console.log('✅ Preferência criada:', response.body.id);
   223	    
   224	    res.json({
   225	      preference_id: response.body.id,
   226	      init_point: response.body.init_point,
   227	      external_reference: external_reference
   228	    });
   229	    
   230	  } catch (e) {
   231	    console.error('❌ Erro ao criar preferência:', e);
   232	    res.status(500).json({ error: 'Erro ao criar pagamento', details: e.message });
   233	  }
   234	});
   235	
   236	// Webhook do Mercado Pago
   237	app.post('/api/payment/webhook', async (req, res) => {
   238	  try {
   239	    const { type, data } = req.body;
   240	    
   241	    console.log('📬 Webhook recebido:', type, data);
   242	    
   243	    // Responder imediatamente
   244	    res.sendStatus(200);
   245	    
   246	    // Processar apenas notificações de pagamento
   247	    if (type === 'payment') {
   248	      const payment_id = data.id;
   249	      
   250	      // Buscar detalhes do pagamento
   251	      const payment = await mercadopago.payment.findById(payment_id);
   252	      const paymentData = payment.body;
   253	      
   254	      console.log('💳 Pagamento:', paymentData.status, paymentData.external_reference);
   255	      
   256	      if (paymentData.status === 'approved') {
   257	        const external_reference = paymentData.external_reference;
   258	        
   259	        // Buscar transação
   260	        const transResult = await pool.query(
   261	          'SELECT * FROM transactions WHERE external_reference = $1',
   262	          [external_reference]
   263	        );
   264	        
   265	        if (transResult.rows.length && transResult.rows[0].status !== 'approved') {
   266	          const transaction = transResult.rows[0];
   267	          
   268	          // Adicionar créditos ao usuário
   269	          await pool.query(
   270	            'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
   271	            [transaction.credits, transaction.user_id]
   272	          );
   273	          
   274	          // Atualizar transação
   275	          await pool.query(
   276	            'UPDATE transactions SET status = $1, payment_id = $2, payment_method = $3, payment_type = $4, payer_email = $5, approved_at = NOW(), updated_at = NOW() WHERE id = $6',
   277	            ['approved', payment_id, paymentData.payment_method_id, paymentData.payment_type_id, paymentData.payer.email, transaction.id]
   278	          );
   279	          
   280	          // Incrementar uso do cupom se houver
   281	          if (paymentData.coupon_code) {
   282	            await pool.query(
   283	              'UPDATE coupons SET used_count = used_count + 1 WHERE code = $1',
   284	              [paymentData.coupon_code]
   285	            );
   286	          }
   287	          
   288	          console.log(`✅ Créditos adicionados: ${transaction.credits} para usuário ${transaction.user_id}`);
   289	        }
   290	      }
   291	    }
   292	    
   293	  } catch (e) {
   294	    console.error('❌ Erro no webhook:', e);
   295	  }
   296	});
   297	
   298	// Consultar status de pagamento
   299	app.get('/api/payment/status/:reference', authMiddleware, async (req, res) => {
   300	  try {
   301	    const { reference } = req.params;
   302	    
   303	    const result = await pool.query(
   304	      'SELECT * FROM transactions WHERE external_reference = $1 AND user_id = $2',
   305	      [reference, req.userId]
   306	    );
   307	    
   308	    if (!result.rows.length) {
   309	      return res.status(404).json({ error: 'Transação não encontrada' });
   310	    }
   311	    
   312	    res.json({ transaction: result.rows[0] });
   313	    
   314	  } catch (e) {
   315	    console.error('❌ Erro ao consultar status:', e);
   316	    res.status(500).json({ error: 'Erro ao consultar status', details: e.message });
   317	  }
   318	});
   319	
   320	// Histórico de transações
   321	app.get('/api/payment/transactions', authMiddleware, async (req, res) => {
   322	  try {
   323	    const result = await pool.query(
   324	      'SELECT id, external_reference, status, package_id, credits, amount, payment_method, created_at, approved_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
   325	      [req.userId]
   326	    );
   327	    
   328	    res.json({ transactions: result.rows });
   329	    
   330	  } catch (e) {
   331	    console.error('❌ Erro ao buscar transações:', e);
   332	    res.status(500).json({ error: 'Erro ao buscar transações', details: e.message });
   333	  }
   334	});
   335	
   336	// Validar cupom
   337	app.post('/api/payment/validate-coupon', authMiddleware, async (req, res) => {
   338	  try {
   339	    const { code } = req.body;
   340	    
   341	    const result = await pool.query(
   342	      'SELECT * FROM coupons WHERE code = $1 AND active = true AND (valid_until IS NULL OR valid_until > NOW()) AND (max_uses IS NULL OR used_count < max_uses)',
   343	      [code]
   344	    );
   345	    
   346	    if (!result.rows.length) {
   347	      return res.status(404).json({ error: 'Cupom inválido ou expirado' });
   348	    }
   349	    
   350	    res.json({ coupon: result.rows[0] });
   351	    
   352	  } catch (e) {
   353	    console.error('❌ Erro ao validar cupom:', e);
   354	    res.status(500).json({ error: 'Erro ao validar cupom', details: e.message });
   355	  }
   356	});
   357	
   358	// ========================================
   359	// 404 HANDLER
   360	// ========================================
   361	app.use((req, res) => {
   362	  res.status(404).json({ error: 'Rota não encontrada', path: req.path, method: req.method });
   363	});
   364	
   365	// ========================================
   366	// ERROR HANDLER
   367	// ========================================
   368	app.use((err, req, res, next) => {
   369	  console.error('Erro não tratado:', err);
   370	  res.status(500).json({ error: 'Erro interno do servidor', details: process.env.NODE_ENV === 'development' ? err.message : undefined });
   371	});
   372	
   373	// ========================================
   374	// START SERVER
   375	// ========================================
   376	app.listen(PORT, '0.0.0.0', () => {
   377	  console.log(`🚀 Servidor rodando na porta ${PORT}`);
   378	  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
   379	  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'não configurado'}`);
   380	  console.log(`💳 Mercado Pago: ${process.env.MERCADOPAGO_ACCESS_TOKEN ? 'Configurado' : 'NÃO configurado'}`);
   381	});
   382	
