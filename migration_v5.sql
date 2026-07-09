-- ============================================================
--  InveXia · Migración v5
--  Notificaciones, foto de perfil y fecha de nacimiento.
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

-- ---------- 1. Datos personales del cliente ----------
alter table public.profiles
  add column if not exists avatar_url text,
  add column if not exists birth_date date;

-- ---------- 2. Notificaciones ----------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null default 'general',   -- mensaje | evento | cartera | general
  title      text not null,
  body       text,
  link       text,                              -- ruta interna, ej. '#/mensajes'
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx
  on public.notifications(user_id, read, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "notif_select" on public.notifications;
create policy "notif_select" on public.notifications
  for select using (user_id = auth.uid());

drop policy if exists "notif_update" on public.notifications;
create policy "notif_update" on public.notifications
  for update using (user_id = auth.uid());

drop policy if exists "notif_delete" on public.notifications;
create policy "notif_delete" on public.notifications
  for delete using (user_id = auth.uid());

-- ---------- 3. Disparadores ----------

-- 3a. Mensaje nuevo -> notifica a quien lo recibe
create or replace function public.notify_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare sender_name text;
begin
  select coalesce(full_name, email) into sender_name from public.profiles where id = new.sender_id;

  if new.sender_role = 'admin' then
    -- el asesor escribe -> notifica al cliente
    insert into public.notifications (user_id, kind, title, body, link)
    values (new.client_id, 'mensaje', 'Nuevo mensaje de tu asesor',
            left(new.body, 90), '#/mensajes');
  else
    -- el cliente escribe -> notifica a todos los administradores
    insert into public.notifications (user_id, kind, title, body, link)
    select p.id, 'mensaje', 'Mensaje de ' || coalesce(sender_name,'un cliente'),
           left(new.body, 90), '#/mensajes/' || new.client_id
    from public.profiles p where p.role = 'admin';
  end if;
  return new;
end; $$;

drop trigger if exists trg_notify_message on public.messages;
create trigger trg_notify_message
  after insert on public.messages
  for each row execute function public.notify_on_message();

-- 3b. Evento nuevo en el calendario -> notifica a todos los clientes
create or replace function public.notify_on_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, kind, title, body, link)
  select p.id, 'evento', 'Nuevo evento: ' || new.title,
         coalesce(new.description, to_char(new.event_date,'DD/MM/YYYY')), '#/calendario'
  from public.profiles p where p.role = 'client';
  return new;
end; $$;

drop trigger if exists trg_notify_event on public.events;
create trigger trg_notify_event
  after insert on public.events
  for each row execute function public.notify_on_event();

-- 3c. Cartera publicada -> notifica al cliente
create or replace function public.notify_on_portfolio()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'published' and (tg_op = 'INSERT' or coalesce(old.status,'') <> 'published') then
    insert into public.notifications (user_id, kind, title, body, link)
    values (new.user_id, 'cartera', 'Tu cartera está lista',
            'Tu asesor publicó ' || new.name || '.', '#/cartera');
  end if;
  return new;
end; $$;

drop trigger if exists trg_notify_portfolio on public.portfolios;
create trigger trg_notify_portfolio
  after insert or update on public.portfolios
  for each row execute function public.notify_on_portfolio();

-- ---------- 4. Fotos de perfil en el almacén ----------
-- Ruta obligatoria: avatars/<uid>/archivo.jpg
-- Cada usuario solo puede escribir dentro de su propia carpeta.
drop policy if exists "avatar_own_insert" on storage.objects;
create policy "avatar_own_insert" on storage.objects
  for insert with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists "avatar_own_update" on storage.objects;
create policy "avatar_own_update" on storage.objects
  for update using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists "avatar_own_delete" on storage.objects;
create policy "avatar_own_delete" on storage.objects
  for delete using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- ============================================================
--  Listo.
-- ============================================================
