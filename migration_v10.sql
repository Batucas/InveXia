-- ============================================================
--  InveXia · Migración v10
--  Campo "potencial" en ideas + notificación al publicar cursos.
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

-- 1. Potencial de crecimiento / rentabilidad (texto libre) en las ideas
alter table public.posts
  add column if not exists potential text;

-- 2. Notificar a los clientes cuando se publica un curso
create or replace function public.notify_on_course()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.published = true and (tg_op = 'INSERT' or coalesce(old.published,false) = false) then
    insert into public.notifications (user_id, kind, title, body, link)
    select p.id, 'curso', 'Nuevo curso disponible', new.title, '#/cursos'
    from public.profiles p where p.role = 'client';
  end if;
  return new;
end; $$;

drop trigger if exists trg_notify_course on public.courses;
create trigger trg_notify_course
  after insert or update on public.courses
  for each row execute function public.notify_on_course();

-- ============================================================
--  Listo.
-- ============================================================
