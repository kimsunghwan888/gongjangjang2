-- 미국주식 모의투자 · 저장창고 준비 (Supabase 의 SQL Editor 에서 딱 한 번만 실행)
-- · 표 이름 앞에 usinvest_ 를 붙여서 이 프로젝트의 다른 표(wallet, orders, jpinvest_ 등)와 겹치지 않는다
-- · 여러 번 실행해도 안전하다 (이미 있으면 그대로 두고, 함수만 새로 덮어쓴다)

-- 1) 표 2개: 지갑(현금+보유 수량), 주문 기록 ------------------------------
create table if not exists usinvest_wallet (
  id         serial primary key,
  owner      text unique not null,
  cash       numeric(20,4) not null default 1000,
  holdings   jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists usinvest_orders (
  id         serial primary key,
  owner      text not null,
  symbol     text not null,
  side       text not null check (side in ('buy', 'sell')),
  qty        integer not null check (qty > 0),
  price      numeric(20,4) not null,
  amount     numeric(20,4) not null,
  created_at timestamptz not null default now()
);

create index if not exists usinvest_orders_owner_time on usinvest_orders (owner, created_at desc);

-- 2) 잠금: 표를 직접 열어 보거나 고치지 못하게 막는다 (정책을 하나도 안 만든다 = 모두 거절)
alter table usinvest_wallet enable row level security;
alter table usinvest_orders enable row level security;
revoke all on table usinvest_wallet, usinvest_orders from anon, authenticated;

-- 3) 함수 4개: 공개용 열쇠로는 이 함수들만 부를 수 있다 --------------------

-- 내 지갑 (없으면 현금 $1,000 으로 만든다)
create or replace function usinvest_get_wallet()
returns json language plpgsql security definer set search_path = public as $$
declare w usinvest_wallet;
begin
  insert into usinvest_wallet (owner) values ('me') on conflict (owner) do nothing;
  select * into w from usinvest_wallet where owner = 'me';
  return json_build_object('cash', w.cash, 'holdings', w.holdings, 'updated_at', w.updated_at);
end $$;

-- 주문 내역 (새 것부터, 최대 200건)
create or replace function usinvest_list_orders(p_limit integer default 50)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(o order by o.created_at desc, o.id desc), '[]'::json)
  from (
    select id, symbol, side, qty, price, amount, created_at
    from usinvest_orders
    where owner = 'me'
    order by created_at desc, id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  ) o;
$$;

-- 사기 · 팔기 (지갑 줄을 잠그고 한 번에 처리해서, 동시에 눌러도 꼬이지 않는다)
create or replace function usinvest_trade(p_symbol text, p_side text, p_qty integer, p_price numeric)
returns json language plpgsql security definer set search_path = public as $$
declare
  w          usinvest_wallet;
  o          usinvest_orders;
  held_qty   integer := 0;
  v_amount   numeric;
  v_cash     numeric;
  v_holdings jsonb;
begin
  if p_side is null or p_side not in ('buy', 'sell') then raise exception '사기는 buy, 팔기는 sell 로 보내 주세요.'; end if;
  if p_qty is null or p_qty < 1 then raise exception '주 수는 1 이상의 정수여야 해요.'; end if;
  if p_price is null or p_price <= 0 then raise exception '가격이 올바르지 않아요.'; end if;
  if p_symbol is null or p_symbol !~ '^[A-Z]{1,5}$' then raise exception '종목 코드가 올바르지 않아요.'; end if;

  insert into usinvest_wallet (owner) values ('me') on conflict (owner) do nothing;
  select * into w from usinvest_wallet where owner = 'me' for update;

  v_holdings := w.holdings;
  held_qty := coalesce((v_holdings ->> p_symbol)::integer, 0);
  v_amount := round(p_qty * p_price, 4);

  if p_side = 'buy' then
    if v_amount > w.cash + 0.000001 then
      raise exception '잔액이 모자라요. 쓸 수 있는 돈은 $%예요.', to_char(w.cash, 'FM999,999,990.00');
    end if;
    v_cash := round(w.cash - v_amount, 4);
    v_holdings := v_holdings || jsonb_build_object(p_symbol, held_qty + p_qty);
  else
    if p_qty > held_qty then
      raise exception '가진 주식이 모자라요. 지금 가진 주식은 %주예요.', held_qty;
    end if;
    v_cash := round(w.cash + v_amount, 4);
    v_holdings := v_holdings || jsonb_build_object(p_symbol, held_qty - p_qty);
  end if;

  insert into usinvest_orders (owner, symbol, side, qty, price, amount)
  values ('me', p_symbol, p_side, p_qty, p_price, v_amount)
  returning * into o;

  update usinvest_wallet set cash = v_cash, holdings = v_holdings, updated_at = now()
  where owner = 'me' returning * into w;

  return json_build_object(
    'order', json_build_object('id', o.id, 'symbol', o.symbol, 'side', o.side, 'qty', o.qty,
                               'price', o.price, 'amount', o.amount, 'created_at', o.created_at),
    'wallet', json_build_object('cash', w.cash, 'holdings', w.holdings, 'updated_at', w.updated_at));
end $$;

-- 처음부터 다시 (현금 $1,000, 주식·주문내역 지움)
create or replace function usinvest_reset()
returns json language plpgsql security definer set search_path = public as $$
declare w usinvest_wallet;
begin
  insert into usinvest_wallet (owner) values ('me') on conflict (owner) do nothing;
  delete from usinvest_orders where owner = 'me';
  update usinvest_wallet set cash = 1000, holdings = '{}', updated_at = now()
  where owner = 'me' returning * into w;
  return json_build_object('cash', w.cash, 'holdings', w.holdings, 'updated_at', w.updated_at);
end $$;

-- 4) 권한: 공개용 열쇠(anon)는 위 함수 4개만 부를 수 있다 -------------------
revoke all on function usinvest_get_wallet() from public;
revoke all on function usinvest_list_orders(integer) from public;
revoke all on function usinvest_trade(text, text, integer, numeric) from public;
revoke all on function usinvest_reset() from public;
grant execute on function usinvest_get_wallet() to anon;
grant execute on function usinvest_list_orders(integer) to anon;
grant execute on function usinvest_trade(text, text, integer, numeric) to anon;
grant execute on function usinvest_reset() to anon;

-- 5) 방금 만든 함수를 API 가 바로 알아보게 한다
notify pgrst, 'reload schema';
