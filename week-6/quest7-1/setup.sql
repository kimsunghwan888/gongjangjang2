-- ========================================
-- 🗄️ Supabase 테이블 만들기 (Supabase > SQL Editor 에 통째로 붙여넣고 Run)
-- 쉽게 말하면: 엑셀 시트 두 개(상품, 주문)를 만드는 작업입니다.
-- ========================================

-- 1) 상품 테이블 (누구나 읽을 수 있음)
create table if not exists products (
  id bigint primary key,
  name text not null,
  price integer not null check (price > 0),
  image_url text not null,
  description text
);
alter table products enable row level security;
create policy "누구나 상품 보기" on products for select using (true);

-- 과제용 가짜 상품 데이터
insert into products (id, name, price, image_url, description) values
  (1, '원목 라운지 체어', 189000, 'https://picsum.photos/seed/chair/600/600', '따뜻한 원목 프레임에 부드러운 쿠션을 더한 라운지 체어입니다.'),
  (2, '북유럽 패브릭 소파', 690000, 'https://picsum.photos/seed/sofa/600/600', '3인용 패브릭 소파. 어떤 거실에도 잘 어울립니다.'),
  (3, '미니멀 원형 테이블', 129000, 'https://picsum.photos/seed/table/600/600', '지름 80cm 원형 테이블. 작은 공간에 알맞습니다.'),
  (4, '감성 조명 스탠드', 58000, 'https://picsum.photos/seed/lamp/600/600', '은은한 빛을 내는 무드등 스탠드입니다.')
on conflict (id) do nothing;

-- 2) 주문 테이블 (정책을 만들지 않음 = 브라우저(anon 키)는 접근 불가, 서버(service_role)만 접근)
create table if not exists orders (
  order_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id bigint references products(id),
  product_name text not null,
  image_url text not null,
  amount integer not null,
  status text not null default '결제대기',
  payment_key text,
  created_at timestamptz not null default now()
);
alter table orders enable row level security;
