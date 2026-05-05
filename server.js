require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const API_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID   = process.env.CLICKUP_LIST_ID;
const BASE_URL  = 'https://api.clickup.com/api/v2';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Instância axios com autenticação
const api = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: API_TOKEN },
});

// ── Health: verifica se .env está configurado ─────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ configured: !!(API_TOKEN && LIST_ID) });
});

// ── GET tarefas atrasadas da lista ────────────────────────────────────────
app.get('/api/overdue', async (_req, res) => {
  try {
    const now = Date.now();

    const { data } = await api.get(`/list/${LIST_ID}/task`, {
      params: {
        due_date_lt: now,        // apenas tarefas com due_date anterior a agora
        'statuses[]': 'pendente ', // apenas status PENDENTE (com espaço no final conforme listado na API)
        include_closed: false,
        subtasks: true,
        page: 0,
      },
    });

    const tasks = (data.tasks || []).map((t) => ({
      id: t.id,
      name: t.name,
      url: t.url,
      dueDate: t.due_date ? parseInt(t.due_date) : null,
      assignees: (t.assignees || []).map((a) => ({
        id: a.id,
        username: a.username,
        initials: a.initials || a.username?.slice(0, 2).toUpperCase(),
        color: a.color || '#7B61FF',
        profilePicture: a.profilePicture || null,
      })),
      empresa: extractEmpresa(t.custom_fields),
    }));

    // Ordena: mais atrasada primeiro
    tasks.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0));

    res.json(tasks);
  } catch (err) {
    const msg = err.response?.data?.err || err.message;
    console.error('[GET /api/overdue]', msg);
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

// ── PUT arquivar tarefa (status = closed) ─────────────────────────────────
app.put('/api/tasks/:id/archive', async (req, res) => {
  try {
    await api.put(`/task/${req.params.id}`, { status: 'closed' });
    res.json({ ok: true });
  } catch (err) {
    const msg = err.response?.data?.err || err.message;
    console.error('[PUT archive]', msg);
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

// ── PUT reagendar tarefa (atualiza due_date) ──────────────────────────────
app.put('/api/tasks/:id/reschedule', async (req, res) => {
  try {
    const { due_date } = req.body; // timestamp em ms (número)
    if (!due_date) return res.status(400).json({ error: 'due_date é obrigatório' });
    await api.put(`/task/${req.params.id}`, { due_date: String(due_date) });
    res.json({ ok: true });
  } catch (err) {
    const msg = err.response?.data?.err || err.message;
    console.error('[PUT reschedule]', msg);
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

// ── Helper: extrai o campo personalizado "Empresa" (labels ou drop_down) ────────────
function extractEmpresa(customFields) {
  if (!customFields) return null;
  
  // Tenta encontrar o campo 'Empresa' do tipo 'labels' (usado no workspace)
  let field = customFields.find((f) => f.name === 'Empresa' && f.type === 'labels' && f.value != null);
  // Fallback para drop_down
  if (!field) field = customFields.find((f) => f.name === 'Empresa' && f.value != null);
  
  if (!field) return null;

  if (field.type === 'drop_down') {
    const option = field.type_config?.options?.find((o) => o.orderindex === field.value);
    return option ? { name: option.name, color: option.color || '#888' } : null;
  }

  if (field.type === 'labels') {
    const valArray = Array.isArray(field.value) ? field.value : [field.value];
    const option = field.type_config?.options?.find((o) => valArray.includes(o.id));
    return option ? { name: option.label, color: option.color || '#888' } : null;
  }

  return null;
}

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`\n🚀  Servidor rodando em http://localhost:${PORT}`);
    if (!API_TOKEN || !LIST_ID) {
      console.warn('⚠️   Configure CLICKUP_API_TOKEN e CLICKUP_LIST_ID no arquivo .env\n');
    }
  });
}

// Exporta o app para o Vercel (Serverless Functions)
module.exports = app;
