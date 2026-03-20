 1	require('dotenv').config();
     2	const express = require('express');
     3	const cors = require('cors');
     4	const helmet = require('helmet');
     5	const morgan = require('morgan');
     6	const { Pool } = require('pg');
     7	const bcrypt = require('bcryptjs');
     8	const jwt = require('jsonwebtoken');
     9	const mercadopago = require('mercadopago');
    10	
    11	const app = express();
    12	const PORT = process.env.PORT || 10000;
    13	
    14	// Configurar Mercado Pago
    15	mercadopago.configure({
    16	    access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
    17	});
    18	console.log('💳 Mercado Pago configurado');
    19	
    20	// Configuração do banco de dados
    21	const dbConfig = {
    22	  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    23	  ssl: {
    24	    rejectUnauthorized: false
    25	  }
    26	};
    27	
    28	const pool = new Pool(dbConfig);
    29	
    30	// Testar conexão
    31	pool.connect((err, client, release) => {
    32	  if (err) {
    33	    console.error('❌ Erro ao conectar ao PostgreSQL:', err.stack);
    34	  } else {
    35	    console.log('✅ Conectado ao PostgreSQL');
    36	    release();
    37	  }
    38	});
    39	
    40	// Middlewares
    41	app.use(helmet());
    42	app.use(morgan('combined'));
    43	app.use(cors({
    44	  origin: process.env.FRONTEND_URL || '*',
    45	  credentials: true
    46	}));
    47	app.use(express.json());
    48	app.use(express.urlencoded({ extended: true }));
    49	
    50	// ========================================
    51	// ROTAS DE SAÚDE E TESTE
    52	// ========================================
    53	
    54	app.get('/health', (req, res) => {
    55	  res.json({
    56	    status: 'OK',
    57	    timestamp: new Date().toISOString(),
    58	    uptime: process.uptime()
    59	  });
    60	});
    61	
    62	app.get('/api/test-db', async (req, res) => {
    63	  try {
    64	    const result = await pool.query('SELECT NOW()');
    65	    res.json({
    66	      success: true,
    67	      timestamp: result.rows[0].now,
    68	      message: 'Conexão com banco de dados OK!'
    69	    });
    70	  } catch (error) {
    71	    res.status(500).json({
    72	      success: false,
    73	      error: error.message
    74	    });
    75	  }
    76	});
    77	
    78	// ========================================
    79	// MIDDLEWARE DE AUTENTICAÇÃO
    80	// ========================================
    81	
    82	const authMiddleware = async (req, res, next) => {
    83	  try {
    84	    const token = req.headers.authorization?.replace('Bearer ', '');
    85	    
    86	    if (!token) {
    87	      return res.status(401).json({ error: 'Token não fornecido' });
    88	    }
    89	
    90	    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    91	    req.userId = decoded.id;
    92	    next();
    93	  } catch (error) {
    94	    res.status(401).json({ error: 'Token inválido' });
    95	  }
    96	};
    97	
    98	// ========================================
    99	// ROTAS DE AUTENTICAÇÃO
   100	// ========================================
   101	
   102	app.post('/api/auth/register', async (req, res) => {
   103	  try {
   104	    const { name, email, password, phone } = req.body;
   105	
   106	    // Verificar se usuário já existe
   107	    const userExists = await pool.query(
   108	      'SELECT * FROM users WHERE email = $1',
   109	      [email]
   110	    );
   111	
   112	    if (userExists.rows.length > 0) {
   113	      return res.status(400).json({ error: 'Email já cadastrado' });
   114	    }
   115	
   116	    // Criar hash da senha
   117	    const password_hash = await bcrypt.hash(password, 10);
   118	
   119	    // Inserir usuário
   120	    const result = await pool.query(
   121	      `INSERT INTO users (name, email, password_hash, phone, credits_balance, role, status) 
   122	       VALUES ($1, $2, $3, $4, 0, $5, $6) 
   123	       RETURNING id, name, email, phone, credits_balance, role`,
   124	      [name, email, password_hash, phone || null, 'user', 'active']
   125	    );
   126	
   127	    const user = result.rows[0];
   128	
   129	    // Gerar token
   130	    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
   131	      expiresIn: '7d'
   132	    });
   133	
   134	    res.status(201).json({
   135	      user,
   136	      token,
   137	      message: 'Usuário criado com sucesso!'
   138	    });
   139	  } catch (error) {
   140	    console.error('Erro no registro:', error);
   141	    res.status(500).json({
   142	      error: 'Erro ao criar usuário',
   143	      details: error.message
   144	    });
   145	  }
   146	});
   147	
   148	app.post('/api/auth/login', async (req, res) => {
   149	  try {
   150	    const { email, password } = req.body;
   151	
   152	    // Buscar usuário
   153	    const result = await pool.query(
   154	      'SELECT * FROM users WHERE email = $1',
   155	      [email]
   156	    );
   157	
   158	    if (result.rows.length === 0) {
   159	      return res.status(401).json({ error: 'Email ou senha incorretos' });
   160	    }
   161	
   162	    const user = result.rows[0];
   163	
   164	    // Verificar senha
   165	    const validPassword = await bcrypt.compare(password, user.password_hash);
   166	
   167	    if (!validPassword) {
   168	      return res.status(401).json({ error: 'Email ou senha incorretos' });
   169	    }
   170	
   171	    // Atualizar último login
   172	    await pool.query(
   173	      'UPDATE users SET last_login = NOW() WHERE id = $1',
   174	      [user.id]
   175	    );
   176	
   177	    // Gerar token
   178	    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
   179	      expiresIn: '7d'
   180	    });
   181	
   182	    // Remover senha do objeto
   183	    delete user.password_hash;
   184	
   185	    res.json({
   186	      user,
   187	      token,
   188	      message: 'Login realizado com sucesso!'
   189	    });
   190	  } catch (error) {
   191	    console.error('Erro no login:', error);
   192	    res.status(500).json({
   193	      error: 'Erro ao fazer login',
   194	      details: error.message
   195	    });
   196	  }
   197	});
   198	
   199	app.get('/api/auth/profile', authMiddleware, async (req, res) => {
   200	  try {
   201	    const result = await pool.query(
   202	      `SELECT id, name, email, phone, credits_balance, role, status, created_at 
   203	       FROM users WHERE id = $1`,
   204	      [req.userId]
   205	    );
   206	
   207	    if (result.rows.length === 0) {
   208	      return res.status(404).json({ error: 'Usuário não encontrado' });
   209	    }
   210	
   211	    res.json({ user: result.rows[0] });
   212	  } catch (error) {
   213	    console.error('Erro ao buscar perfil:', error);
   214	    res.status(500).json({
   215	      error: 'Erro ao buscar perfil',
   216	      details: error.message
   217	    });
   218	  }
   219	});
   220	
   221	// ========================================
   222	// ROTAS DE PAGAMENTO - MERCADO PAGO
   223	// ========================================
   224	
   225	const PACKAGES = {
   226	  basico: {
   227	    id: 'basico',
   228	    name: '5.000 Créditos',
   229	    credits: 5000,
   230	    price: 700,
   231	    discount: 0
   232	  },
   233	  popular: {
   234	    id: 'popular',
   235	    name: '10.000 Créditos',
   236	    credits: 10000,
   237	    price: 1300,
   238	    discount: 7
   239	  },
   240	  melhor: {
   241	    id: 'melhor',
   242	    name: '20.000 Créditos',
   243	    credits: 20000,
   244	    price: 2400,
   245	    discount: 14
   246	  },
   247	  empresarial: {
   248	    id: 'empresarial',
   249	    name: '50.000 Créditos',
   250	    credits: 50000,
   251	    price: 5500,
   252	    discount: 21
   253	  }
   254	};
   255	
   256	app.post('/api/payment/create-preference', authMiddleware, async (req, res) => {
   257	  try {
   258	    const { package_id } = req.body;
   259	
   260	    // Validar pacote
   261	    const pkg = PACKAGES[package_id];
   262	    if (!pkg) {
   263	      return res.status(400).json({ error: 'Pacote inválido' });
   264	    }
   265	
   266	    // Buscar dados do usuário
   267	    const userResult = await pool.query(
   268	      'SELECT id, name, email FROM users WHERE id = $1',
   269	      [req.userId]
   270	    );
   271	
   272	    if (userResult.rows.length === 0) {
   273	      return res.status(404).json({ error: 'Usuário não encontrado' });
   274	    }
   275	
   276	    const user = userResult.rows[0];
   277	    const finalPrice = pkg.price;
   278	
   279	    // Criar referência externa única
   280	    const external_reference = `LP-${user.id}-${Date.now()}`;
   281	
   282	    // Registrar transação pendente no banco
   283	    await pool.query(
   284	      'INSERT INTO transactions (user_id, external_reference, status, package_id, credits, amount) VALUES ($1, $2, $3, $4, $5, $6)',
   285	      [user.id, external_reference, 'pending', package_id, pkg.credits, finalPrice]
   286	    );
   287	
   288	    // Criar preferência no Mercado Pago - SIMPLIFICADA
   289	    const preference = {
   290	      items: [{
   291	        id: package_id,
   292	        title: pkg.name,
   293	        description: `${pkg.credits.toLocaleString('pt-BR')} créditos para exportar leads`,
   294	        quantity: 1,
   295	        unit_price: finalPrice,
   296	        currency_id: 'BRL',
   297	        picture_url: `${process.env.FRONTEND_URL}/images/logo.png`
   298	      }],
   299	      external_reference: external_reference,
   300	      back_urls: {
   301	        success: `${process.env.FRONTEND_URL}/dashboard.html?payment=success`,
   302	        failure: `${process.env.FRONTEND_URL}/dashboard.html?payment=failure`,
   303	        pending: `${process.env.FRONTEND_URL}/dashboard.html?payment=pending`
   304	      },
   305	      auto_return: 'approved',
   306	      notification_url: `https://leadsparatodos-backend-production.up.railway.app/api/payment/webhook`,
   307	      statement_descriptor: 'LEADSPARATODOS',
   308	      expires: false,
   309	      binary_mode: false
   310	    };
   311	
   312	    console.log('🔧 Criando preferência:', preference);
   313	
   314	    const response = await mercadopago.preferences.create(preference);
   315	
   316	    // Atualizar transação com preference_id
   317	    await pool.query(
   318	      'UPDATE transactions SET preference_id = $1 WHERE external_reference = $2',
   319	      [response.body.id, external_reference]
   320	    );
   321	
   322	    console.log('✅ Preferência criada:', response.body.id);
   323	    console.log('🔗 Init point:', response.body.init_point);
   324	
   325	    res.json({
   326	      preference_id: response.body.id,
   327	      init_point: response.body.init_point,
   328	      sandbox_init_point: response.body.sandbox_init_point,
   329	      external_reference: external_reference
   330	    });
   331	
   332	  } catch (error) {
   333	    console.error('❌ Erro ao criar preferência:', error);
   334	    res.status(500).json({
   335	      error: 'Erro ao criar pagamento',
   336	      details: error.message,
   337	      response: error.response?.body || null
   338	    });
   339	  }
   340	});
   341	
   342	// Webhook para receber notificações do Mercado Pago
   343	app.post('/api/payment/webhook', async (req, res) => {
   344	  try {
   345	    const { type, data } = req.body;
   346	
   347	    console.log('📬 Webhook recebido:', type, data);
   348	
   349	    // Responder imediatamente para o Mercado Pago
   350	    res.sendStatus(200);
   351	
   352	    // Processar notificação de pagamento
   353	    if (type === 'payment') {
   354	      const payment_id = data.id;
   355	
   356	      // Buscar informações do pagamento
   357	      const payment = await mercadopago.payment.findById(payment_id);
   358	      const paymentData = payment.body;
   359	
   360	      console.log('💳 Pagamento:', paymentData.status, paymentData.external_reference);
   361	
   362	      // Se pagamento foi aprovado
   363	      if (paymentData.status === 'approved') {
   364	        const external_reference = paymentData.external_reference;
   365	
   366	        // Buscar transação no banco
   367	        const transResult = await pool.query(
   368	          'SELECT * FROM transactions WHERE external_reference = $1',
   369	          [external_reference]
   370	        );
   371	
   372	        if (transResult.rows.length > 0) {
   373	          const transaction = transResult.rows[0];
   374	
   375	          // Verificar se já foi processado
   376	          if (transaction.status !== 'approved') {
   377	            // Adicionar créditos ao usuário
   378	            await pool.query(
   379	              'UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2',
   380	              [transaction.credits, transaction.user_id]
   381	            );
   382	
   383	            // Atualizar status da transação
   384	            await pool.query(
   385	              `UPDATE transactions 
   386	               SET status = $1, payment_id = $2, payment_method = $3, 
   387	                   payment_type = $4, payer_email = $5, approved_at = NOW(), updated_at = NOW() 
   388	               WHERE id = $6`,
   389	              [
   390	                'approved',
   391	                payment_id,
   392	                paymentData.payment_method_id,
   393	                paymentData.payment_type_id,
   394	                paymentData.payer.email,
   395	                transaction.id
   396	              ]
   397	            );
   398	
   399	            console.log(`✅ Créditos adicionados: ${transaction.credits} para usuário ${transaction.user_id}`);
   400	          } else {
   401	            console.log('⚠️ Transação já foi processada anteriormente');
   402	          }
   403	        }
   404	      }
   405	    }
   406	  } catch (error) {
   407	    console.error('❌ Erro no webhook:', error);
   408	  }
   409	});
   410	
   411	// Consultar status de pagamento
   412	app.get('/api/payment/status/:reference', authMiddleware, async (req, res) => {
   413	  try {
   414	    const { reference } = req.params;
   415	
   416	    const result = await pool.query(
   417	      'SELECT * FROM transactions WHERE external_reference = $1 AND user_id = $2',
   418	      [reference, req.userId]
   419	    );
   420	
   421	    if (result.rows.length === 0) {
   422	      return res.status(404).json({ error: 'Transação não encontrada' });
   423	    }
   424	
   425	    res.json({ transaction: result.rows[0] });
   426	  } catch (error) {
   427	    console.error('❌ Erro ao consultar status:', error);
   428	    res.status(500).json({
   429	      error: 'Erro ao consultar status',
   430	      details: error.message
   431	    });
   432	  }
   433	});
   434	
   435	// Listar transações do usuário
   436	app.get('/api/payment/transactions', authMiddleware, async (req, res) => {
   437	  try {
   438	    const result = await pool.query(
   439	      `SELECT id, external_reference, status, package_id, credits, amount, 
   440	              payment_method, created_at, approved_at 
   441	       FROM transactions 
   442	       WHERE user_id = $1 
   443	       ORDER BY created_at DESC 
   444	       LIMIT 50`,
   445	      [req.userId]
   446	    );
   447	
   448	    res.json({ transactions: result.rows });
   449	  } catch (error) {
   450	    console.error('❌ Erro ao buscar transações:', error);
   451	    res.status(500).json({
   452	      error: 'Erro ao buscar transações',
   453	      details: error.message
   454	    });
   455	  }
   456	});
   457	
   458	// ========================================
   459	// TRATAMENTO DE ERROS
   460	// ========================================
   461	
   462	// Rota não encontrada
   463	app.use((req, res) => {
   464	  res.status(404).json({
   465	    error: 'Rota não encontrada',
   466	    path: req.path,
   467	    method: req.method
   468	  });
   469	});
   470	
   471	// Erro geral
   472	app.use((err, req, res, next) => {
   473	  console.error('Erro não tratado:', err);
   474	  res.status(500).json({
   475	    error: 'Erro interno do servidor',
   476	    details: process.env.NODE_ENV === 'development' ? err.message : undefined
   477	  });
   478	});
   479	
   480	// ========================================
   481	// INICIAR SERVIDOR
   482	// ========================================
   483	
   484	app.listen(PORT, '0.0.0.0', () => {
   485	  console.log(`🚀 Servidor rodando na porta ${PORT}`);
   486	  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
   487	  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'não configurado'}`);
   488	  console.log(`💳 Mercado Pago: ${process.env.MERCADOPAGO_ACCESS_TOKEN ? 'Configurado' : 'NÃO configurado'}`);
   489	});
   490	
