-- ============================================================
--  InveXia · Migración v16
--  Arreglo: el bucket "media" solo permitía imágenes, por eso
--  rechazaba PDFs y archivos de las tareas ("mime type ... not supported").
--  Permitimos todos los tipos y subimos el límite a 15 MB.
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

update storage.buckets
set allowed_mime_types = null,      -- null = se permite cualquier tipo de archivo
    file_size_limit    = 15728640   -- 15 MB (coincide con la validación de la app)
where id = 'media';

-- Verificación (debería devolver allowed_mime_types = null y file_size_limit = 15728640):
-- select id, allowed_mime_types, file_size_limit from storage.buckets where id = 'media';
