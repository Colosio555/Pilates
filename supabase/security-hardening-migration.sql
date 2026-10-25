-- Ejecuta este archivo después de schema.sql, client-portal-migration.sql
-- y weekly-agenda-color-migration.sql, desde Supabase > SQL Editor.
-- Refuerza roles y permisos existentes; no modifica ni borra expedientes ni pagos históricos.
-- Antes de cerrar la revisión de roles, compara las cuentas existentes con esta consulta:
-- select p.id, u.email, p.role from public.profiles p
-- join auth.users u on u.id = p.id order by p.role, u.email;

-- Las cuentas nuevas empiezan como clientes. El personal debe recibir su rol
-- mediante un cambio administrativo explícito en public.profiles.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'cliente'::public.user_role)
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'::public.user_role
  )
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role in ('admin'::public.user_role, 'trabajador'::public.user_role)
  )
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_staff() to authenticated, service_role;

-- Elimina cualquier permiso heredado en estas tablas y vuelve a conceder solo
-- las operaciones que usa la aplicación. Las claves secretas siguen del lado servidor.
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

revoke all on table public.app_collections from anon, authenticated;
grant select, insert, update on table public.app_collections to authenticated;
grant all on table public.app_collections to service_role;

do $$
declare policy_row record;
begin
  for policy_row in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'profiles'
  loop
    execute format('drop policy if exists %I on public.profiles', policy_row.policyname);
  end loop;
  for policy_row in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'app_collections'
  loop
    execute format('drop policy if exists %I on public.app_collections', policy_row.policyname);
  end loop;
end;
$$;

alter table public.profiles enable row level security;
alter table public.app_collections enable row level security;

create policy "Usuarios consultan su perfil"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "Personal consulta datos globales"
  on public.app_collections for select to authenticated
  using ((select public.is_staff()));

create policy "Personal inserta datos permitidos"
  on public.app_collections for insert to authenticated
  with check (
    (key = 'plans' and (select public.is_admin()))
    or (key in ('clients', 'payments', 'history') and (select public.is_staff()))
  );

create policy "Personal actualiza datos permitidos"
  on public.app_collections for update to authenticated
  using (
    (key = 'plans' and (select public.is_admin()))
    or (key in ('clients', 'payments', 'history') and (select public.is_staff()))
  )
  with check (
    (key = 'plans' and (select public.is_admin()))
    or (key in ('clients', 'payments', 'history') and (select public.is_staff()))
  );

-- El navegador solo lee horarios y reservas. Las escrituras pasan por el servidor,
-- que comprueba rol, plan, vencimiento y cupo.
revoke all on table public.class_sessions from anon, authenticated;
grant select on table public.class_sessions to authenticated;
grant all on table public.class_sessions to service_role;

revoke all on table public.class_bookings from anon, authenticated;
grant select on table public.class_bookings to authenticated;
grant all on table public.class_bookings to service_role;

do $$
declare policy_row record;
begin
  for policy_row in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'class_sessions'
  loop
    execute format('drop policy if exists %I on public.class_sessions', policy_row.policyname);
  end loop;
  for policy_row in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'class_bookings'
  loop
    execute format('drop policy if exists %I on public.class_bookings', policy_row.policyname);
  end loop;
end;
$$;

alter table public.class_sessions enable row level security;
alter table public.class_bookings enable row level security;

create policy "Usuarios autenticados consultan clases"
  on public.class_sessions for select to authenticated using (true);

create policy "Clientes y personal consultan reservas permitidas"
  on public.class_bookings for select to authenticated
  using (client_auth_id = (select auth.uid()) or (select public.is_staff()));

-- Reserva atómica: bloquea al cliente y al horario para evitar duplicados,
-- sobrecupo o exceder las clases restantes ante dos solicitudes simultáneas.
create or replace function public.book_class_session(
  target_session uuid,
  target_client_auth_id uuid,
  max_future_bookings integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.class_sessions%rowtype;
  active_booking_count integer;
  created_booking_id uuid;
begin
  if target_session is null or target_client_auth_id is null or max_future_bookings is null or max_future_bookings < 0 then
    raise exception 'Solicitud de reserva inválida.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = target_client_auth_id and role = 'cliente'::public.user_role
  ) then
    raise exception 'La cuenta no tiene rol de cliente.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_client_auth_id::text, 0)
  );

  select * into session_row
  from public.class_sessions
  where id = target_session
  for update;

  if not found then
    raise exception 'El horario ya no existe.' using errcode = 'P0001';
  end if;
  if session_row.starts_at <= pg_catalog.now() then
    raise exception 'Este horario ya comenzó o ya pasó.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.class_bookings
    where session_id = target_session and client_auth_id = target_client_auth_id
  ) then
    raise exception 'Ya reservaste este horario.' using errcode = '23505';
  end if;

  select count(*)::integer into active_booking_count
  from public.class_bookings b
  join public.class_sessions s on s.id = b.session_id
  where b.client_auth_id = target_client_auth_id and s.starts_at > pg_catalog.now();

  if active_booking_count >= max_future_bookings then
    raise exception 'Ya no tienes clases disponibles para reservar.' using errcode = 'P0001';
  end if;

  select count(*)::integer into active_booking_count
  from public.class_bookings
  where session_id = target_session;

  if active_booking_count >= session_row.capacity then
    raise exception 'Este horario ya no tiene lugares disponibles.' using errcode = 'P0001';
  end if;

  insert into public.class_bookings (session_id, client_auth_id)
  values (target_session, target_client_auth_id)
  returning id into created_booking_id;

  return created_booking_id;
end;
$$;

revoke all on function public.book_class_session(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.book_class_session(uuid, uuid, integer) to service_role;
drop function if exists public.class_has_space(uuid);

-- Libro separado para cobros digitales. La integración con Mercado Pago se añadirá
-- después; solo el servidor/webhook podrá escribir aquí, nunca el navegador.
create table if not exists public.online_payments (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  client_auth_id uuid references auth.users(id) on delete set null,
  client_name text not null,
  plan_id text not null,
  plan_name text not null,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'MXN' check (currency = 'MXN'),
  status text not null check (status in ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'in_process')),
  provider text not null check (provider in ('mercadopago')),
  provider_payment_id text,
  provider_preference_id text,
  external_reference text not null unique,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create unique index if not exists online_payments_provider_payment_id_uidx
  on public.online_payments (provider, provider_payment_id)
  where provider_payment_id is not null;
create unique index if not exists online_payments_preference_id_uidx
  on public.online_payments (provider, provider_preference_id)
  where provider_preference_id is not null;
create index if not exists online_payments_client_created_at_idx
  on public.online_payments (client_id, created_at desc);

alter table public.online_payments enable row level security;
revoke all on table public.online_payments from anon, authenticated;
grant select on table public.online_payments to authenticated;
grant all on table public.online_payments to service_role;

do $$
declare policy_row record;
begin
  for policy_row in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'online_payments'
  loop
    execute format('drop policy if exists %I on public.online_payments', policy_row.policyname);
  end loop;
end;
$$;

create policy "Personal consulta pagos digitales"
  on public.online_payments for select to authenticated
  using ((select public.is_staff()));

comment on table public.online_payments is
  'Registro reservado para cobros digitales verificados por el servidor; no contiene datos de tarjeta.';
