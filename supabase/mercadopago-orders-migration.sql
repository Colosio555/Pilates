-- Ejecuta esta migración después de security-hardening-migration.sql.
-- Añade metadatos para Checkout Pro Orders; no cambia pagos anteriores.

alter table public.online_payments
  add column if not exists provider_order_id text,
  add column if not exists checkout_url text,
  add column if not exists plan_classes integer,
  add column if not exists plan_validity_days integer;

create unique index if not exists online_payments_provider_order_id_uidx
  on public.online_payments (provider, provider_order_id)
  where provider_order_id is not null;

create unique index if not exists online_payments_one_active_order_per_client_uidx
  on public.online_payments (client_auth_id)
  where client_auth_id is not null and status in ('pending', 'in_process');

-- Registra un pago acreditado y actualiza el plan del cliente en una sola transacción.
-- Solo puede invocarla el servidor con la llave service_role.
create or replace function public.apply_mercadopago_order(
  target_external_reference text,
  target_provider_order_id text,
  target_paid_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment_row public.online_payments%rowtype;
  clients_payload jsonb;
  updated_clients jsonb;
  payments_payload jsonb;
  payment_entry jsonb;
  paid_at_value timestamptz := coalesce(target_paid_at, pg_catalog.now());
  paid_date date := (coalesce(target_paid_at, pg_catalog.now()) at time zone 'America/Mexico_City')::date;
  updated_count integer;
begin
  select * into payment_row
  from public.online_payments
  where external_reference = target_external_reference
  for update;

  if not found then
    raise exception 'Pago digital no encontrado.';
  end if;

  if payment_row.provider <> 'mercadopago'
     or (payment_row.provider_order_id is not null and payment_row.provider_order_id <> target_provider_order_id)
     or payment_row.client_auth_id is null
     or payment_row.plan_classes is null
     or payment_row.plan_validity_days is null then
    raise exception 'Los datos del pago digital no coinciden.';
  end if;

  if payment_row.status = 'approved' then
    return false;
  end if;

  if payment_row.status not in ('pending', 'in_process') then
    raise exception 'El estado del pago digital no permite aplicarlo.';
  end if;

  update public.online_payments
  set status = 'approved',
      provider_order_id = target_provider_order_id,
      paid_at = paid_at_value,
      updated_at = pg_catalog.now()
  where id = payment_row.id;

  payment_entry := pg_catalog.jsonb_build_object(
    'id', payment_row.id::text,
    'clienteId', payment_row.client_id,
    'clienteNombre', payment_row.client_name,
    'planId', payment_row.plan_id,
    'planNombre', payment_row.plan_name,
    'monto', payment_row.amount,
    'fechaHora', paid_at_value
  );

  select payload into clients_payload
  from public.app_collections
  where key = 'clients'
  for update;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(coalesce(clients_payload, '[]'::jsonb)) as client(value)
    where client.value->>'id' = payment_row.client_id
  ) then
    raise exception 'No se encontró el expediente del cliente.';
  end if;

  select pg_catalog.jsonb_agg(
    case when client.value->>'id' = payment_row.client_id then
      client.value || pg_catalog.jsonb_build_object(
        'planId', payment_row.plan_id,
        'paquete', payment_row.plan_name,
        'clasesContratadas', payment_row.plan_classes,
        'clasesRestantes', payment_row.plan_classes,
        'fechaContratacion', paid_date,
        'fechaVencimiento', paid_date + payment_row.plan_validity_days,
        'pagos', coalesce(client.value->'pagos', '[]'::jsonb) || pg_catalog.jsonb_build_array(payment_entry)
      )
    else client.value end
    order by client.ordinality
  )
  into updated_clients
  from pg_catalog.jsonb_array_elements(coalesce(clients_payload, '[]'::jsonb)) with ordinality as client(value, ordinality);

  update public.app_collections
  set payload = coalesce(updated_clients, '[]'::jsonb), updated_at = pg_catalog.now()
  where key = 'clients';

  select payload into payments_payload
  from public.app_collections
  where key = 'payments'
  for update;

  update public.app_collections
  set payload = coalesce(payments_payload, '[]'::jsonb) || pg_catalog.jsonb_build_array(payment_entry),
      updated_at = pg_catalog.now()
  where key = 'payments';
  get diagnostics updated_count = row_count;

  if updated_count = 0 then
    insert into public.app_collections (key, payload)
    values ('payments', pg_catalog.jsonb_build_array(payment_entry));
  end if;

  return true;
end;
$$;

revoke all on function public.apply_mercadopago_order(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_mercadopago_order(text, text, timestamptz) to service_role;
