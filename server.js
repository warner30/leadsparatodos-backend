<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Painel Admin - Leads para Todos</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: #f8fafc; }
        
        /* Header */
        .admin-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .header-content { max-width: 1400px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; }
        .header-title { font-size: 24px; font-weight: 700; }
        .header-title i { margin-right: 10px; }
        .header-actions { display: flex; gap: 20px; align-items: center; }
        .btn-logout { background: rgba(255,255,255,0.2); color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: 600; transition: all 0.3s; }
        .btn-logout:hover { background: rgba(255,255,255,0.3); }
        
        /* Container */
        .admin-container { max-width: 1400px; margin: 40px auto; padding: 0 40px; }
        
        /* Tabs */
        .tabs { display: flex; gap: 10px; margin-bottom: 30px; border-bottom: 2px solid #e2e8f0; }
        .tab { padding: 15px 30px; background: none; border: none; font-size: 16px; font-weight: 600; color: #64748b; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.3s; }
        .tab.active { color: #7c3aed; border-bottom-color: #7c3aed; }
        .tab:hover { color: #7c3aed; }
        
        /* Tab Content */
        .tab-content { display: none; }
        .tab-content.active { display: block; animation: fadeIn 0.3s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        
        /* Stats Cards */
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; border-radius: 16px; padding: 25px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); border-left: 4px solid; }
        .stat-card.purple { border-left-color: #7c3aed; }
        .stat-card.blue { border-left-color: #3b82f6; }
        .stat-card.green { border-left-color: #10b981; }
        .stat-card.orange { border-left-color: #f97316; }
        .stat-label { font-size: 14px; color: #64748b; margin-bottom: 10px; }
        .stat-value { font-size: 32px; font-weight: 700; color: #1e293b; }
        .stat-icon { float: right; font-size: 24px; opacity: 0.3; }
        
        /* Table */
        .table-container { background: white; border-radius: 16px; padding: 25px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .table-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .table-title { font-size: 20px; font-weight: 700; color: #1e293b; }
        .search-box { display: flex; gap: 10px; }
        .search-box input { padding: 10px 15px; border: 2px solid #e2e8f0; border-radius: 8px; width: 300px; font-size: 14px; }
        .search-box button { padding: 10px 20px; background: #7c3aed; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        .search-box button:hover { background: #6d28d9; }
        
        table { width: 100%; border-collapse: collapse; }
        thead { background: #f8fafc; }
        th { padding: 15px; text-align: left; font-size: 14px; font-weight: 600; color: #64748b; border-bottom: 2px solid #e2e8f0; }
        td { padding: 15px; border-bottom: 1px solid #f1f5f9; }
        tr:hover { background: #fafafa; }
        
        .badge { padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
        .badge.success { background: #d1fae5; color: #065f46; }
        .badge.pending { background: #fef3c7; color: #92400e; }
        .badge.failed { background: #fee2e2; color: #991b1b; }
        .badge.admin { background: #ede9fe; color: #5b21b6; }
        .badge.user { background: #e0f2fe; color: #075985; }
        
        .btn-action { padding: 8px 15px; background: #f1f5f9; color: #64748b; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; margin-right: 5px; }
        .btn-action:hover { background: #e2e8f0; }
        .btn-action.primary { background: #7c3aed; color: white; }
        .btn-action.primary:hover { background: #6d28d9; }
        
        /* Loading */
        .loading { text-align: center; padding: 40px; color: #64748b; }
        .spinner { width: 40px; height: 40px; border: 4px solid #f1f5f9; border-top-color: #7c3aed; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 15px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        
        /* Modal */
        .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 9999; align-items: center; justify-content: center; }
        .modal.show { display: flex; }
        .modal-content { background: white; border-radius: 16px; padding: 30px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .modal-title { font-size: 20px; font-weight: 700; }
        .modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: #64748b; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #1e293b; }
        .form-group input, .form-group select { width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 14px; }
        .btn-submit { width: 100%; padding: 15px; background: #7c3aed; color: white; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; }
        .btn-submit:hover { background: #6d28d9; }
    </style>
</head>
<body>
    <!-- Header -->
    <div class="admin-header">
        <div class="header-content">
            <div class="header-title">
                <i class="fas fa-shield-alt"></i>
                Painel Administrativo
            </div>
            <div class="header-actions">
                <span id="admin-name">Admin</span>
                <button class="btn-logout" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i> Sair
                </button>
            </div>
        </div>
    </div>

    <!-- Container -->
    <div class="admin-container">
        <!-- Tabs -->
        <div class="tabs">
            <button class="tab active" data-tab="dashboard">
                <i class="fas fa-chart-line"></i> Dashboard
            </button>
            <button class="tab" data-tab="users">
                <i class="fas fa-users"></i> Usuários
            </button>
            <button class="tab" data-tab="transactions">
                <i class="fas fa-credit-card"></i> Transações
            </button>
        </div>

        <!-- Tab: Dashboard -->
        <div class="tab-content active" id="tab-dashboard">
            <div class="stats-grid">
                <div class="stat-card purple">
                    <div class="stat-icon"><i class="fas fa-dollar-sign"></i></div>
                    <div class="stat-label">Total de Vendas</div>
                    <div class="stat-value" id="stat-sales">R$ 0,00</div>
                </div>
                <div class="stat-card blue">
                    <div class="stat-icon"><i class="fas fa-users"></i></div>
                    <div class="stat-label">Total de Usuários</div>
                    <div class="stat-value" id="stat-users">0</div>
                </div>
                <div class="stat-card orange">
                    <div class="stat-icon"><i class="fas fa-coins"></i></div>
                    <div class="stat-label">Créditos Vendidos</div>
                    <div class="stat-value" id="stat-credits">0</div>
                </div>
            </div>

            <div class="table-container">
                <div class="table-header">
                    <div class="table-title">📊 Vendas por Dia (Últimos 30 dias)</div>
                </div>
                <div id="sales-chart">
                    <div class="loading">
                        <div class="spinner"></div>
                        Carregando vendas...
                    </div>
                </div>
            </div>
        </div>

        <!-- Tab: Users -->
        <div class="tab-content" id="tab-users">
            <div class="table-container">
                <div class="table-header">
                    <div class="table-title">👥 Gerenciar Usuários</div>
                    <div class="search-box">
                        <input type="text" id="search-users" placeholder="Buscar por nome ou email...">
                        <button onclick="loadUsers(document.getElementById('search-users').value)">
                            <i class="fas fa-search"></i> Buscar
                        </button>
                    </div>
                </div>
                <div id="users-table">
                    <div class="loading">
                        <div class="spinner"></div>
                        Carregando usuários...
                    </div>
                </div>
            </div>
        </div>

        <!-- Tab: Transactions -->
        <div class="tab-content" id="tab-transactions">
            <div class="table-container">
                <div class="table-header">
                    <div class="table-title">💳 Transações</div>
                    <div class="search-box">
                        <select id="filter-status" onchange="loadTransactions(this.value)">
                            <option value="">Todos os status</option>
                            <option value="approved">Aprovadas</option>
                            <option value="pending">Pendentes</option>
                            <option value="failed">Falhas</option>
                        </select>
                    </div>
                </div>
                <div id="transactions-table">
                    <div class="loading">
                        <div class="spinner"></div>
                        Carregando transações...
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Modal: Edit User -->
    <div class="modal" id="edit-user-modal">
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title">✏️ Editar Usuário</div>
                <button class="modal-close" onclick="closeModal('edit-user-modal')">×</button>
            </div>
            <form id="edit-user-form">
                <input type="hidden" id="edit-user-id">
                
                <div class="form-group">
                    <label>Nome</label>
                    <input type="text" id="edit-user-name" readonly>
                </div>
                
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="edit-user-email" readonly>
                </div>
                
                <div class="form-group">
                    <label>Créditos</label>
                    <input type="number" id="edit-user-credits" required>
                </div>
                
                <div class="form-group">
                    <label>Tipo</label>
                    <select id="edit-user-role">
                        <option value="user">Usuário</option>
                        <option value="admin">Admin</option>
                    </select>
                </div>
                
                <div class="form-group">
                    <label>Status</label>
                    <select id="edit-user-status">
                        <option value="active">Ativo</option>
                        <option value="inactive">Inativo</option>
                        <option value="blocked">Bloqueado</option>
                    </select>
                </div>
                
                <button type="submit" class="btn-submit">
                    <i class="fas fa-save"></i> Salvar Alterações
                </button>
            </form>
        </div>
    </div>

    <!-- Scripts -->
    <script src="js/api-config.js"></script>
    <script>
        // Verificar autenticação
        if (!isAuthenticated()) {
            window.location.href = '/login.html';
        }

        // Variáveis globais
        let currentTab = 'dashboard';

        // Carregar dados do admin
        async function loadAdminData() {
            try {
                const response = await fetch(`${API_CONFIG.BASE_URL}/api/auth/profile`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
                });
                const data = await response.json();
                
                if (data.user.role !== 'admin') {
                    alert('Acesso negado! Apenas administradores podem acessar esta página.');
                    window.location.href = '/dashboard.html';
                    return;
                }
                
                document.getElementById('admin-name').textContent = data.user.name;
            } catch (error) {
                console.error('Erro ao carregar dados do admin:', error);
                alert('Erro ao carregar perfil');
            }
        }

        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                
                // Atualizar tabs ativos
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                
                tab.classList.add('active');
                document.getElementById(`tab-${tabName}`).classList.add('active');
                
                currentTab = tabName;
                
                // Carregar dados da tab
                if (tabName === 'dashboard') loadDashboard();
                if (tabName === 'users') loadUsers();
                if (tabName === 'transactions') loadTransactions();
            });
        });

        // Carregar Dashboard
        async function loadDashboard() {
            try {
                const response = await fetch(`${API_CONFIG.BASE_URL}/api/admin/dashboard`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
                });
                
                const data = await response.json();
                
                // Total de Vendas (em reais)
                const totalSales = data.totalSales || 0;
                document.getElementById('stat-sales').textContent = `R$ ${totalSales.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                
                // Total de Usuários
                const totalUsers = data.totalUsers || 0;
                document.getElementById('stat-users').textContent = totalUsers.toLocaleString('pt-BR');
                
                // Total de Créditos Vendidos
                const totalCredits = data.totalCreditsSold || 0;
                document.getElementById('stat-credits').textContent = totalCredits.toLocaleString('pt-BR');
                
                // Vendas por dia (se existir)
                if (data.salesByDay && data.salesByDay.length > 0) {
                    let chartHTML = '<table><thead><tr><th>Data</th><th>Receita</th></tr></thead><tbody>';
                    data.salesByDay.forEach(day => {
                        const date = new Date(day.date).toLocaleDateString('pt-BR');
                        const revenue = day.revenue || 0;
                        chartHTML += `<tr>
                            <td>${date}</td>
                            <td>R$ ${revenue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>`;
                    });
                    chartHTML += '</tbody></table>';
                    document.getElementById('sales-chart').innerHTML = chartHTML;
                }
            } catch (error) {
                console.error('Erro ao carregar dashboard:', error);
                alert('Erro ao carregar dados do dashboard');
            }
        }

        // Carregar Usuários
        async function loadUsers(search = '') {
            try {
                const url = `${API_CONFIG.BASE_URL}/api/admin/users?search=${search}`;
                const response = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
                });
                
                const data = await response.json();
                
                let html = `
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Nome</th>
                                <th>Email</th>
                                <th>Créditos</th>
                                <th>Tipo</th>
                                <th>Status</th>
                                <th>Ações</th>
                            </tr>
                        </thead>
                        <tbody>
                `;
                
                data.users.forEach(user => {
                    const roleClass = user.role === 'admin' ? 'admin' : 'user';
                    html += `<tr>
                        <td>${user.id}</td>
                        <td>${user.name}</td>
                        <td>${user.email}</td>
                        <td>${user.credits_balance.toLocaleString('pt-BR')}</td>
                        <td><span class="badge ${roleClass}">${user.role}</span></td>
                        <td><span class="badge ${user.status === 'active' ? 'success' : 'pending'}">${user.status}</span></td>
                        <td>
                            <button class="btn-action primary" onclick="editUser(${user.id})">
                                <i class="fas fa-edit"></i> Editar
                            </button>
                        </td>
                    </tr>`;
                });
                
                html += '</tbody></table>';
                document.getElementById('users-table').innerHTML = html;
            } catch (error) {
                console.error('Erro:', error);
            }
        }

        // Carregar Transações
        async function loadTransactions(status = '') {
            try {
                const url = `${API_CONFIG.BASE_URL}/api/admin/transactions?status=${status}`;
                const response = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
                });
                
                const data = await response.json();
                
                let html = `
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Usuário</th>
                                <th>Pacote</th>
                                <th>Créditos</th>
                                <th>Valor</th>
                                <th>Método</th>
                                <th>Status</th>
                                <th>Data</th>
                            </tr>
                        </thead>
                        <tbody>
                `;
                
                data.transactions.forEach(transaction => {
                    const statusClass = transaction.status === 'approved' ? 'success' : 
                                       transaction.status === 'pending' ? 'pending' : 'failed';
                    const amount = (transaction.amount / 100).toFixed(2).replace('.', ',');
                    const date = new Date(transaction.created_at).toLocaleDateString('pt-BR');
                    
                    html += `<tr>
                        <td>${transaction.id}</td>
                        <td>${transaction.user_name}</td>
                        <td>${transaction.package_id}</td>
                        <td>${transaction.credits.toLocaleString('pt-BR')}</td>
                        <td>R$ ${amount}</td>
                        <td>${transaction.payment_method}</td>
                        <td><span class="badge ${statusClass}">${transaction.status}</span></td>
                        <td>${date}</td>
                    </tr>`;
                });
                
                html += '</tbody></table>';
                document.getElementById('transactions-table').innerHTML = html;
            } catch (error) {
                console.error('Erro:', error);
            }
        }

        // Editar Usuário
        async function editUser(userId) {
            try {
                const response = await fetch(`${API_CONFIG.BASE_URL}/api/admin/users/${userId}`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
                });
                const data = await response.json();
                
                document.getElementById('edit-user-id').value = data.user.id;
                document.getElementById('edit-user-name').value = data.user.name;
                document.getElementById('edit-user-email').value = data.user.email;
                document.getElementById('edit-user-credits').value = data.user.credits_balance;
                document.getElementById('edit-user-role').value = data.user.role;
                document.getElementById('edit-user-status').value = data.user.status;
                
                document.getElementById('edit-user-modal').classList.add('show');
            } catch (error) {
                console.error('Erro:', error);
                alert('Erro ao carregar dados do usuário');
            }
        }

        // Salvar Edição de Usuário
        document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const userId = document.getElementById('edit-user-id').value;
            const credits_balance = parseInt(document.getElementById('edit-user-credits').value);
            const role = document.getElementById('edit-user-role').value;
            const status = document.getElementById('edit-user-status').value;
            
            try {
                const response = await fetch(`${API_CONFIG.BASE_URL}/api/admin/users/${userId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                    },
                    body: JSON.stringify({ credits_balance, role, status })
                });
                
                if (response.ok) {
                    alert('Usuário atualizado com sucesso!');
                    closeModal('edit-user-modal');
                    loadUsers();
                } else {
                    alert('Erro ao atualizar usuário');
                }
            } catch (error) {
                console.error('Erro:', error);
                alert('Erro ao atualizar usuário');
            }
        });

        // Fechar Modal
        function closeModal(modalId) {
            document.getElementById(modalId).classList.remove('show');
        }

        // Logout
        function logout() {
            localStorage.removeItem('authToken');
            localStorage.removeItem('userData');
            window.location.href = '/login.html';
        }

        // Inicializar
        loadAdminData();
        loadDashboard();
    </script>
</body>
</html>
