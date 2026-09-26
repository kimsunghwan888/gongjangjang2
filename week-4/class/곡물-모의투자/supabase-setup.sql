-- 곡물 모의투자 · 저장창고 준비 (Supabase 의 SQL Editor 에서 한 번 실행)
-- · 표 이름 앞에 grain_ 을 붙여서 이 프로젝트의 다른 표(wallet, orders, usinvest_ 등)와 겹치지 않는다
-- · 여러 번 실행해도 안전하다 (이미 있으면 그대로 두고, 함수만 새로 덮어쓴다)
-- · 지갑은 하나뿐이고 시작 현금은 $1,000 이다

-- 1) 표 2개: 지갑(현금+가진 곡물 수량), 주문 기록 ------------------------------
create table if not exists grain_wallet (
  id         integer primary key check (id = 1),   -- 지갑은 1번 한 줄만 쓴다
  cash       numeric(20,4) not null default 1000,
  holdings   jsonb not null default '{}',          -- 예: {"wheat": 3, "corn": 10}
  updated_at timestamptz not null default now()
);

create table if not exists grain_orders (
  id         serial primary key,
  created_at timestamptz not null default now(),   -- 시간
  market     text not null,                        -- 어떤 곡물 (rice, wheat, corn, oats, soy)
  side       text not null check (side in ('buy', 'sell')),   -- 매수 / 매도
  qty        integer not null check (qty > 0),     -- 수량
  price      numeric(20,4) not null,               -- 체결가
  amount     numeric(20,4) not null,               -- 체결가 x 수량
  memo       text                                  -- 왜 샀는지(팔았는지) 한 줄
);

create index if not exists grain_orders_time on grain_orders (created_at desc, id desc);

-- 2) 잠금: 표를 직접 열어 보거나 고치지 못하게 막는다 (정책을 하나도 안 만든다 = 모두 거절)
alter table grain_wallet enable row level security;
alter table grain_orders enable row level security;
revoke all on table grain_wallet, grain_orders from anon, authenticated;

-- 3) 함수 4개: 표는 이 함수들을 통해서만 만질 수 있다 ------------------------------

-- 내 지갑 (없으면 현금 $1,000 으로 만든다)
create or replace function grain_get_wallet()
returns json language plpgsql security definer set search_path = public as $$
declare
  w grain_wallet;
begin
  insert into grain_wallet (id) values (1) on conflict (id) do nothing;
  select * into w from grain_wallet where id = 1;
  return json_build_object('cash', w.cash, 'holdings', w.holdings, 'updated_at', w.updated_at);
end $$;

-- 주문 내역 (새 것부터, 최대 200건)
create or replace function grain_list_orders(p_limit integer default 50)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(o order by o.created_at desc, o.id desc), '[]'::json)
  from (
    select id, created_at, market, side, qty, price, amount, memo
    from grain_orders
    order by created_at desc, id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  ) o;
$$;

-- 사기 · 팔기: 현재가로 체결하고, 지갑을 고치고, 주문 한 줄을 남긴다
-- 지갑 줄을 잠그고 한 번에 처리해서 동시에 눌러도 꼬이지 않는다. 돈이나 곡물이 모자라면 거절한다
create or replace function grain_place_order(p_market text, p_side text, p_qty integer, p_price numeric, p_memo text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  w          grain_wallet;
  o          grain_orders;
  held_qty   integer := 0;
  v_amount   numeric;
  v_cash     numeric;
  v_holdings jsonb;
  v_memo     text := nullif(left(btrim(coalesce(p_memo, '')), 200), '');
begin
  if p_side is null or p_side not in ('buy', 'sell') then raise exception '사기는 buy, 팔기는 sell 로 보내 주세요.'; end if;
  if p_qty is null or p_qty < 1 then raise exception '수량은 1 이상의 정수여야 해요.'; end if;
  if p_price is null or p_price <= 0 then raise exception '가격이 올바르지 않아요.'; end if;
  if p_market is null or p_market !~ '^[a-z]{2,20}$' then raise exception '곡물 이름이 올바르지 않아요.'; end if;

  insert into grain_wallet (id) values (1) on conflict (id) do nothing;
  select * into w from grain_wallet where id = 1 for update;

  v_holdings := w.holdings;
  held_qty := coalesce((v_holdings ->> p_market)::integer, 0);
  v_amount := round(p_qty * p_price, 4);

  if p_side = 'buy' then
    if v_amount > w.cash + 0.000001 then
      raise exception '돈이 모자라요. 쓸 수 있는 돈은 $%예요.', to_char(w.cash, 'FM999,999,990.00');
    end if;
    v_cash := round(w.cash - v_amount, 4);
    v_holdings := v_holdings || jsonb_build_object(p_market, held_qty + p_qty);
  else
    if p_qty > held_qty then
      raise exception '가진 곡물이 모자라요. 지금 %개 가지고 있어요.', held_qty;
    end if;
    v_cash := round(w.cash + v_amount, 4);
    v_holdings := v_holdings || jsonb_build_object(p_market, held_qty - p_qty);
  end if;

  insert into grain_orders (market, side, qty, price, amount, memo)
  values (p_market, p_side, p_qty, p_price, v_amount, v_memo)
  returning * into o;

  update grain_wallet set cash = v_cash, holdings = v_holdings, updated_at = now()
  where id = 1 returning * into w;

  return json_build_object(
    'order', json_build_object('id', o.id, 'created_at', o.created_at, 'market', o.market, 'side', o.side,
                               'qty', o.qty, 'price', o.price, 'amount', o.amount, 'memo', o.memo),
    'wallet', json_build_object('cash', w.cash, 'holdings', w.holdings, 'updated_at', w.updated_at));
end $$;

-- 처음부터 다시 (현금 $1,000, 가진 곡물·주문 내역 모두 지움)
create or replace function grain_reset()
returns json language plpgsql security definer set search_path = public as $$
declare
  w grain_wallet;
begin
  insert into grain_wallet (id) values (1) on conflict (id) do nothing;
  delete from grain_orders where true;   -- Supabase 는 조건 없는 delete 를 막는다
  update grain_wallet set cash = 1000, holdings = '{}', updated_at = now()
  where id = 1 returning * into w;
  return json_build_object('cash', w.cash, 'holdings', w.holdings, 'updated_at', w.updated_at);
end $$;

-- 4) 권한: 서버가 쓰는 공개용 열쇠(anon)로 위 함수 4개만 부를 수 있다 ------------------
revoke all on function grain_get_wallet() from public;
revoke all on function grain_list_orders(integer) from public;
revoke all on function grain_place_order(text, text, integer, numeric, text) from public;
revoke all on function grain_reset() from public;
grant execute on function grain_get_wallet() to anon, authenticated;
grant execute on function grain_list_orders(integer) to anon, authenticated;
grant execute on function grain_place_order(text, text, integer, numeric, text) to anon, authenticated;
grant execute on function grain_reset() to anon, authenticated;

-- 5) 방금 만든 함수를 API 가 바로 알아보게 한다
notify pgrst, 'reload schema';
