// ============================================================
// 포켓몬 도감 API 서버
// PokeAPI 대신 이 파일 안에 직접 담은 자료를 내려준다.
// 실행: node server.js  →  http://localhost:3000
// ============================================================

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 참고표: 타입 슬러그 → 한국어 이름 ─────────────────────
const TYPE_NAMES = {
  normal: '노말', fighting: '격투', flying: '비행', poison: '독',
  ground: '땅', rock: '바위', bug: '벌레', ghost: '고스트',
  steel: '강철', fire: '불꽃', water: '물', grass: '풀',
  electric: '전기', psychic: '에스퍼', ice: '얼음', dragon: '드래곤',
  dark: '악', fairy: '페어리',
};

// ── 참고표: 종족값 슬러그 → 한국어 라벨 ───────────────────
const STAT_LABELS = {
  hp: 'HP',
  attack: '공격',
  defense: '방어',
  'special-attack': '특수공격',
  'special-defense': '특수방어',
  speed: '스피드',
};
const STAT_ORDER = Object.keys(STAT_LABELS);

// ── 인메모리 저장소: 포켓몬 10마리 ────────────────────────
// 서버를 껐다 켜면 이 원본 상태로 되돌아간다.
let pokedex = [
  {
    id: 1, enName: 'bulbasaur', name: '새싹씨', genus: '씨앗포켓몬',
    types: ['grass', 'poison'],
    abilities: [
      { slug: 'overgrow', name: '심록', hidden: false },
      { slug: 'chlorophyll', name: '엽록소', hidden: true },
    ],
    description: '태어났을 때부터 등에 식물의 씨앗이 있으며 조금씩 크게 자란다.',
    height: 0.7, weight: 6.9,
    stats: { hp: 45, attack: 49, defense: 49, 'special-attack': 65, 'special-defense': 65, speed: 45 },
  },
  {
    id: 4, enName: 'charmander', name: '불꼬리', genus: '도마뱀포켓몬',
    types: ['fire'],
    abilities: [
      { slug: 'blaze', name: '맹화', hidden: false },
      { slug: 'solar-power', name: '선파워', hidden: true },
    ],
    description: '태어날 때부터 꼬리에 불꽃이 타오르고 있다. 불꽃이 꺼지면 목숨을 잃는다고 한다.',
    height: 0.6, weight: 8.5,
    stats: { hp: 39, attack: 52, defense: 43, 'special-attack': 60, 'special-defense': 50, speed: 65 },
  },
  {
    id: 7, enName: 'squirtle', name: '물뿜이', genus: '꼬마거북포켓몬',
    types: ['water'],
    abilities: [
      { slug: 'torrent', name: '급류', hidden: false },
      { slug: 'rain-dish', name: '젖은접시', hidden: true },
    ],
    description: '등의 껍질에 숨어 몸을 지킨다. 반격할 때는 세차게 물을 뿜어낸다.',
    height: 0.5, weight: 9.0,
    stats: { hp: 44, attack: 48, defense: 65, 'special-attack': 50, 'special-defense': 64, speed: 43 },
  },
  {
    id: 25, enName: 'pikachu', name: '찌릿볼', genus: '쥐포켓몬',
    types: ['electric'],
    abilities: [
      { slug: 'static', name: '정전기', hidden: false },
      { slug: 'lightning-rod', name: '피뢰침', hidden: true },
    ],
    description: '볼에 있는 전기주머니에 전기를 모아둔다. 화가 나면 모아둔 전기를 한 번에 방출한다.',
    height: 0.4, weight: 6.0,
    stats: { hp: 35, attack: 55, defense: 40, 'special-attack': 50, 'special-defense': 50, speed: 90 },
  },
  {
    id: 39, enName: 'jigglypuff', name: '자장이', genus: '풍선포켓몬',
    types: ['normal', 'fairy'],
    abilities: [
      { slug: 'cute-charm', name: '매혹의바디', hidden: false },
      { slug: 'competitive', name: '승기', hidden: true },
    ],
    description: '커다란 눈으로 상대를 최면 상태로 만들고 기분 좋은 자장가를 불러 잠들게 한다.',
    height: 0.5, weight: 5.5,
    stats: { hp: 115, attack: 45, defense: 20, 'special-attack': 45, 'special-defense': 25, speed: 20 },
  },
  {
    id: 52, enName: 'meowth', name: '동전냥', genus: '고양이포켓몬',
    types: ['normal'],
    abilities: [
      { slug: 'pickup', name: '픽업', hidden: false },
      { slug: 'technician', name: '테크니션', hidden: false },
      { slug: 'unnerve', name: '긴장감', hidden: true },
    ],
    description: '동전처럼 동그랗고 반짝이는 것을 매우 좋아한다. 낮에는 잠만 자다가 밤이 되면 돌아다닌다.',
    height: 0.4, weight: 4.2,
    stats: { hp: 40, attack: 45, defense: 35, 'special-attack': 40, 'special-defense': 40, speed: 90 },
  },
  {
    id: 94, enName: 'gengar', name: '밤그늘', genus: '섀도포켓몬',
    types: ['ghost', 'poison'],
    abilities: [
      { slug: 'cursed-body', name: '저주받은바디', hidden: false },
    ],
    description: '어두운 밤 자신의 그림자가 앞질러 갔다면 그것은 밤그늘이 흉내 낸 것이다.',
    height: 1.5, weight: 40.5,
    stats: { hp: 60, attack: 65, defense: 60, 'special-attack': 130, 'special-defense': 75, speed: 110 },
  },
  {
    id: 133, enName: 'eevee', name: '여덟꼴', genus: '진화포켓몬',
    types: ['normal'],
    abilities: [
      { slug: 'run-away', name: '도주', hidden: false },
      { slug: 'adaptability', name: '적응력', hidden: false },
      { slug: 'anticipation', name: '위험예지', hidden: true },
    ],
    description: '불규칙한 유전자를 가지고 있어 주변 환경에 맞춰 여러 모습으로 진화한다.',
    height: 0.3, weight: 6.5,
    stats: { hp: 55, attack: 55, defense: 50, 'special-attack': 45, 'special-defense': 65, speed: 55 },
  },
  {
    id: 143, enName: 'snorlax', name: '먹잠보', genus: '잠꾸러기포켓몬',
    types: ['normal'],
    abilities: [
      { slug: 'immunity', name: '면역', hidden: false },
      { slug: 'thick-fat', name: '두꺼운지방', hidden: false },
      { slug: 'gluttony', name: '먹보', hidden: true },
    ],
    description: '하루에 400kg 이상 먹지 않으면 만족하지 못한다. 다 먹고 나면 졸려서 그대로 잠들어버린다.',
    height: 2.1, weight: 460.0,
    stats: { hp: 160, attack: 110, defense: 65, 'special-attack': 65, 'special-defense': 110, speed: 30 },
  },
  {
    id: 150, enName: 'mewtwo', name: '초능왕', genus: '유전포켓몬',
    types: ['psychic'],
    abilities: [
      { slug: 'pressure', name: '프레셔', hidden: false },
      { slug: 'unnerve', name: '긴장감', hidden: true },
    ],
    description: '한 과학자가 오랜 유전자 연구 끝에 만들어낸 포켓몬. 흉악한 마음만을 갖게 되었다.',
    height: 2.0, weight: 122.0,
    stats: { hp: 106, attack: 110, defense: 90, 'special-attack': 154, 'special-defense': 90, speed: 130 },
  },
];

// ── 저장된 자료를 화면이 쓰는 모양으로 바꿔주는 함수들 ────
function toTypeList(slugs) {
  return slugs.map(slug => ({ slug, name: TYPE_NAMES[slug] || slug }));
}

function toStatList(stats) {
  return STAT_ORDER.map(slug => ({
    slug,
    label: STAT_LABELS[slug],
    value: Number(stats[slug]) || 0,
  }));
}

// 목록용 — 카드에 필요한 만큼만
function toSummary(p) {
  return {
    id: p.id,
    name: p.name,
    enName: p.enName,
    genus: p.genus,
    types: toTypeList(p.types),
    sprite: `/images/${p.id}.png`,
    artwork: `/images/art/${p.id}.png`,
  };
}

// 상세용 — 전부
function toDetail(p) {
  const stats = toStatList(p.stats);
  return {
    ...toSummary(p),
    abilities: p.abilities,
    description: p.description,
    height: p.height,
    weight: p.weight,
    stats,
    total: stats.reduce((sum, s) => sum + s.value, 0),
  };
}

// ── 미들웨어 ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── API: 조회 ─────────────────────────────────────────────

// 도감 목록 (검색어 q, 타입 type 으로 걸러낼 수 있다)
app.get('/api/pokemon', (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const type = String(req.query.type || '').trim().toLowerCase();
    const digits = q.replace(/[^0-9]/g, '').replace(/^0+/, '');

    const list = pokedex
      .filter(p => !type || type === 'all' || p.types.includes(type))
      .filter(p => {
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          p.enName.toLowerCase().includes(q) ||
          (digits && String(p.id).includes(digits))
        );
      })
      .sort((a, b) => a.id - b.id)
      .map(toSummary);

    res.json({ success: true, data: list, total: list.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '도감 목록을 불러오지 못했습니다.' });
  }
});

// 도감에 실제로 들어 있는 타입 목록
app.get('/api/types', (_req, res) => {
  try {
    const used = new Set();
    pokedex.forEach(p => p.types.forEach(t => used.add(t)));
    const data = Object.keys(TYPE_NAMES)
      .filter(slug => used.has(slug))
      .map(slug => ({ slug, name: TYPE_NAMES[slug] }));
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '타입 목록을 불러오지 못했습니다.' });
  }
});

// 포켓몬 한 마리 상세 (번호 또는 영문 이름으로 찾는다)
app.get('/api/pokemon/:key', (req, res) => {
  try {
    const key = String(req.params.key).toLowerCase();
    const found = pokedex.find(p => String(p.id) === key || p.enName === key);
    if (!found) {
      return res.status(404).json({ success: false, message: `${req.params.key} 번 포켓몬을 찾을 수 없습니다.` });
    }
    res.json({ success: true, data: toDetail(found) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '포켓몬 정보를 불러오지 못했습니다.' });
  }
});

// ── API: 추가 ─────────────────────────────────────────────
app.post('/api/pokemon', (req, res) => {
  try {
    const body = req.body || {};
    const { id, name, enName, types } = body;

    if (!id || !Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ success: false, message: 'id 는 1 이상의 숫자여야 합니다.' });
    }
    if (!name || !enName) {
      return res.status(400).json({ success: false, message: 'name(한글 이름) 과 enName(영문 이름) 은 반드시 넣어야 합니다.' });
    }
    if (!Array.isArray(types) || types.length === 0) {
      return res.status(400).json({ success: false, message: 'types 는 최소 한 개가 들어 있는 목록이어야 합니다.' });
    }
    const badType = types.find(t => !TYPE_NAMES[t]);
    if (badType) {
      return res.status(400).json({ success: false, message: `${badType} 는 없는 타입입니다.` });
    }
    if (pokedex.some(p => p.id === Number(id))) {
      return res.status(400).json({ success: false, message: `${id} 번은 이미 도감에 있습니다.` });
    }

    const created = {
      id: Number(id),
      enName: String(enName).toLowerCase(),
      name: String(name),
      genus: String(body.genus || ''),
      types,
      abilities: Array.isArray(body.abilities) ? body.abilities : [],
      description: String(body.description || '설명이 등록되지 않은 포켓몬입니다.'),
      height: Number(body.height) || 0,
      weight: Number(body.weight) || 0,
      stats: { hp: 0, attack: 0, defense: 0, 'special-attack': 0, 'special-defense': 0, speed: 0, ...(body.stats || {}) },
    };

    pokedex.push(created);
    res.status(201).json({ success: true, data: toDetail(created) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '포켓몬을 추가하지 못했습니다.' });
  }
});

// ── API: 수정 ─────────────────────────────────────────────
app.put('/api/pokemon/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const target = pokedex.find(p => p.id === id);
    if (!target) {
      return res.status(404).json({ success: false, message: `${req.params.id} 번 포켓몬을 찾을 수 없습니다.` });
    }

    const body = req.body || {};
    if (body.types !== undefined) {
      if (!Array.isArray(body.types) || body.types.length === 0) {
        return res.status(400).json({ success: false, message: 'types 는 최소 한 개가 들어 있는 목록이어야 합니다.' });
      }
      const badType = body.types.find(t => !TYPE_NAMES[t]);
      if (badType) {
        return res.status(400).json({ success: false, message: `${badType} 는 없는 타입입니다.` });
      }
      target.types = body.types;
    }

    if (body.name !== undefined) target.name = String(body.name);
    if (body.enName !== undefined) target.enName = String(body.enName).toLowerCase();
    if (body.genus !== undefined) target.genus = String(body.genus);
    if (body.description !== undefined) target.description = String(body.description);
    if (body.height !== undefined) target.height = Number(body.height) || 0;
    if (body.weight !== undefined) target.weight = Number(body.weight) || 0;
    if (Array.isArray(body.abilities)) target.abilities = body.abilities;
    if (body.stats) target.stats = { ...target.stats, ...body.stats };

    res.json({ success: true, data: toDetail(target) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '포켓몬을 수정하지 못했습니다.' });
  }
});

// ── API: 삭제 ─────────────────────────────────────────────
app.delete('/api/pokemon/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const index = pokedex.findIndex(p => p.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: `${req.params.id} 번 포켓몬을 찾을 수 없습니다.` });
    }
    const [removed] = pokedex.splice(index, 1);
    res.json({ success: true, data: toSummary(removed), message: `${removed.name} 을(를) 도감에서 지웠습니다.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '포켓몬을 삭제하지 못했습니다.' });
  }
});

// 없는 API 주소로 온 요청은 여기서 JSON 으로 돌려준다
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 주소입니다.' });
});

// ── 나머지 주소는 도감 화면으로 ───────────────────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 처리 ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 안에서 문제가 생겼습니다.' });
});

// 로컬에서는 서버 시작 / Vercel 에서는 app 만 넘겨준다
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`포켓몬 도감 서버가 켜졌습니다 → http://localhost:${PORT}`);
    console.log(`현재 도감에 들어 있는 포켓몬: ${pokedex.length}마리`);
  });
}
module.exports = app;
