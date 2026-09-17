const express = require('express');
const path = require('path');
const { Pool } = require('pg');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // .env가 없어도 서버는 켜지고, API에서 알기 쉬운 안내를 보낸다.
}

const app = express();
const PORT = Number(process.env.PORT) || 3004;
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
});

let dbReady = false;

async function initDB() {
  if (dbReady) return;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is missing');

  await pool.query(`
    create table if not exists memos (
      id         bigserial   primary key,
      title      text        not null,
      content    text        not null,
      created_at timestamptz not null default now()
    )
  `);
  dbReady = true;
}

function toMemo(row) {
  return {
    id: Number(row.id),
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  };
}

function checkMemo(value) {
  const title = String(value?.title ?? '').trim();
  const content = String(value?.content ?? '').trim();

  if (!title) return { error: '제목을 입력해 주세요.' };
  if (title.length > 100) return { error: '제목은 100글자까지 적을 수 있습니다.' };
  if (!content) return { error: '메모 내용을 입력해 주세요.' };
  if (content.length > 5000) return { error: '메모 내용은 5,000글자까지 적을 수 있습니다.' };

  return { title, content };
}

function readId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

app.use(express.json({ limit: '100kb' }));

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (error) {
    console.error('데이터베이스 연결 실패:', error.message);
    res.status(500).json({
      success: false,
      message: '데이터베이스에 연결하지 못했습니다. .env의 DATABASE_URL을 확인해 주세요.',
    });
  }
});

app.get('/api/memos', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const { rows } = await pool.query(
      `select * from memos
       where $1 = '' or title ilike '%' || $1 || '%' or content ilike '%' || $1 || '%'
       order by created_at desc, id desc`,
      [search]
    );
    res.json({ success: true, data: rows.map(toMemo), total: rows.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: '메모 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/memos', async (req, res) => {
  try {
    const { title, content, error } = checkMemo(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const { rows } = await pool.query(
      'insert into memos (title, content) values ($1, $2) returning *',
      [title, content]
    );
    res.status(201).json({ success: true, data: toMemo(rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: '메모를 저장하지 못했습니다.' });
  }
});

app.patch('/api/memos/:id', async (req, res) => {
  try {
    const id = readId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '메모 번호가 올바르지 않습니다.' });

    const { title, content, error } = checkMemo(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const { rows } = await pool.query(
      'update memos set title = $1, content = $2 where id = $3 returning *',
      [title, content, id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: '메모를 찾지 못했습니다.' });

    res.json({ success: true, data: toMemo(rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: '메모를 고치지 못했습니다.' });
  }
});

app.delete('/api/memos/:id', async (req, res) => {
  try {
    const id = readId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '메모 번호가 올바르지 않습니다.' });

    const { rows } = await pool.query('delete from memos where id = $1 returning *', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: '메모를 찾지 못했습니다.' });

    res.json({ success: true, data: toMemo(rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: '메모를 지우지 못했습니다.' });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 주소입니다.' });
});

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '보낸 내용을 읽지 못했습니다.' });
  }
  console.error(error);
  res.status(500).json({ success: false, message: '서버에서 문제가 생겼습니다.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`메모장 앱이 켜졌습니다: http://localhost:${PORT}`);
  });
}

module.exports = app;