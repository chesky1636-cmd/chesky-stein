// Image processing and storage. Every upload is re-encoded with sharp (EXIF stripped, auto-rotated,
// resized for mobile) and stored in Postgres, so pictures persist across deployments.
import crypto from 'node:crypto';
import sharp from 'sharp';
import { one } from './db.js';

const MAX_DIM = 1600;
const THUMB_DIM = 480;

export class MediaError extends Error {}

export async function storeImage(buffer, source = 'manual') {
  if (!buffer || !buffer.length) throw new MediaError('בילד איז ליידיג');
  let img;
  try {
    img = sharp(buffer, { failOn: 'error', limitInputPixels: 60_000_000 }).rotate();
    const meta = await img.metadata();
    if (!meta.width || !meta.height) throw new Error('no size');
  } catch {
    throw new MediaError('די טעקע איז נישט קיין גילטיגע בילד');
  }
  const main = await img.clone().resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  const thumb = await img.clone().resize(THUMB_DIM, THUMB_DIM, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 74 }).toBuffer();
  const sha = crypto.createHash('sha256').update(main.data).digest('hex');
  const existing = await one('SELECT id FROM media WHERE sha256 = $1 LIMIT 1', [sha]);
  if (existing) return existing.id;
  const row = await one(
    `INSERT INTO media (mime, data, thumb, width, height, bytes, sha256, source)
     VALUES ('image/webp', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [main.data, thumb, main.info.width, main.info.height, main.data.length, sha, source],
  );
  return row.id;
}

// A picture is publicly servable only while something public references it. Removing a picture from
// a record therefore also stops it from being served. Pictures of birth records are never public.
export async function isPublicMedia(id) {
  const r = await one(
    `SELECT EXISTS (SELECT 1 FROM boys WHERE photo_media_id = $1 AND deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM occasion_media om JOIN occasions o ON o.id = om.occasion_id
                    JOIN categories c ON c.id = o.category_id
                    WHERE om.media_id = $1 AND o.deleted_at IS NULL AND o.status = 'published'
                      AND c.enabled AND c.kind NOT IN ('birth_boy'))
         OR EXISTS (SELECT 1 FROM announcements WHERE media_id = $1 AND deleted_at IS NULL AND published)
         OR EXISTS (SELECT 1 FROM settings WHERE key = 'logo_media_id' AND value = to_jsonb($1::bigint))
       AS ok`,
    [id],
  );
  return !!r?.ok;
}
