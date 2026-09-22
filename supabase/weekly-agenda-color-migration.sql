-- Ejecuta esta migración una sola vez en Supabase: SQL Editor.
-- Conserva las clases existentes y les asigna azul como color inicial.
alter table public.class_sessions
  add column if not exists color text not null default 'azul';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'class_sessions_color_check'
      and conrelid = 'public.class_sessions'::regclass
  ) then
    alter table public.class_sessions
      add constraint class_sessions_color_check
      check (color in ('azul', 'rojo', 'verde', 'amarillo', 'naranja', 'morado', 'rosa', 'cafe', 'gris'));
  end if;
end $$;
