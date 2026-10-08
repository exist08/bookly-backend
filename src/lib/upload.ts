import multer from 'multer';
import { ApiError } from './errors.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB — full-res phone photos

/**
 * multipart/form-data parser for a single image field. Keeps the file in memory
 * (it goes straight to Cloudinary, never to disk).
 */
export const imageUpload = (field: string) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (/^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype)) {
        cb(null, true);
      } else {
        cb(ApiError.badRequest('unsupported_image', 'Use a JPG, PNG, WebP or HEIC photo.', field));
      }
    },
  }).single(field);
