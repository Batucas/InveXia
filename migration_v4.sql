-- ============================================================
--  InveXia · Migración v4
--  Imágenes en noticias, ideas y cursos.
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

-- ---------- 1. Columnas de imagen ----------
alter table public.posts   add column if not exists image_url text;
alter table public.courses add column if not exists image_url text;

-- ---------- 2. Almacén de imágenes ----------
-- Bucket público: cualquiera puede VER las imágenes (las necesita el cliente),
-- pero solo un administrador puede subirlas, cambiarlas o borrarlas.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 5242880,
        array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif'];

-- Lectura pública
drop policy if exists "media_public_read" on storage.objects;
create policy "media_public_read" on storage.objects
  for select using (bucket_id = 'media');

-- Escritura solo para administradores
drop policy if exists "media_admin_insert" on storage.objects;
create policy "media_admin_insert" on storage.objects
  for insert with check (bucket_id = 'media' and public.is_admin());

drop policy if exists "media_admin_update" on storage.objects;
create policy "media_admin_update" on storage.objects
  for update using (bucket_id = 'media' and public.is_admin());

drop policy if exists "media_admin_delete" on storage.objects;
create policy "media_admin_delete" on storage.objects
  for delete using (bucket_id = 'media' and public.is_admin());

-- ============================================================
--  Límite: 5 MB por imagen. Formatos: JPG, PNG, WebP, GIF.
-- ============================================================
