import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from 'cloudinary';
import { env } from '../config/env.js';
import { ApiError } from './errors.js';

/**
 * Cloudinary — image storage for avatars (and book covers once posts move to the API).
 *
 * Credentials come from .env (Cloudinary Console → Dashboard → API Keys):
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 * The API secret never leaves the server: the app either sends the file to us
 * (avatars) or asks us for a short-lived signature (direct uploads).
 */
export const isCloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function ensureConfigured() {
  if (!isCloudinaryConfigured) {
    throw new ApiError(503, 'uploads_not_configured', 'Photo uploads aren’t available right now.');
  }
}

/** Where each kind of image lives in the Cloudinary media library. */
export const folders = {
  avatars: `${env.CLOUDINARY_FOLDER}/avatars`,
  covers: `${env.CLOUDINARY_FOLDER}/covers`,
} as const;

/** Formats we accept from phones (HEIC is what iPhones shoot). */
export const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

/** Uploads an in-memory file (from multer) and resolves Cloudinary's response. */
export function uploadBuffer(buffer: Buffer, options: UploadApiOptions): Promise<UploadApiResponse> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'image', allowed_formats: ALLOWED_FORMATS, ...options },
      (error, result) => {
        if (error || !result) {
          console.error('[cloudinary] upload failed:', error?.message);
          reject(new ApiError(502, 'upload_failed', 'Couldn’t upload that photo. Please try again.'));
          return;
        }
        resolve(result);
      },
    );
    stream.end(buffer);
  });
}

/**
 * Delivery URL: auto format (WebP/AVIF where supported) and auto quality.
 * Includes the version so a replaced image busts CDN and app caches.
 */
export function deliveryUrl(publicId: string, version: number) {
  return cloudinary.url(publicId, {
    version,
    secure: true,
    transformation: [{ fetch_format: 'auto', quality: 'auto' }],
  });
}

/** Deletes an asset. Never throws — a leftover image shouldn't fail the request. */
export async function destroyImage(publicId: string) {
  if (!isCloudinaryConfigured) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
  } catch (error) {
    console.error('[cloudinary] destroy failed:', publicId, (error as Error).message);
  }
}

/** True for URLs served from this account's Cloudinary cloud. */
export function isOwnCloudinaryUrl(url: string) {
  return isCloudinaryConfigured && url.startsWith(`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`);
}

/**
 * Signed parameters for uploading straight from the app to Cloudinary
 * (POST https://api.cloudinary.com/v1_1/<cloud>/image/upload as multipart form).
 * The signature covers folder + public_id + allowed_formats, so the app can't
 * write anywhere else; it expires after ~1 hour (Cloudinary checks timestamp).
 */
export function signDirectUpload(params: { folder: string; publicId: string }) {
  ensureConfigured();
  const timestamp = Math.round(Date.now() / 1000);
  const toSign = {
    timestamp,
    folder: params.folder,
    public_id: params.publicId,
    allowed_formats: ALLOWED_FORMATS.join(','),
  };
  const signature = cloudinary.utils.api_sign_request(toSign, env.CLOUDINARY_API_SECRET!);
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    fields: { ...toSign, api_key: env.CLOUDINARY_API_KEY!, signature },
  };
}

/**
 * public_id from one of our delivery URLs, e.g.
 * https://res.cloudinary.com/<cloud>/image/upload/f_auto,q_auto/v17…/bookly/covers/<user>/<id>?_a=… → bookly/covers/<user>/<id>
 */
export function publicIdFromUrl(url: string): string | null {
  const path = url.split('?')[0] ?? '';
  const m = path.match(/\/upload\/(?:.*?\/)?v\d+\/(.+?)(?:\.[a-z0-9]+)?$/i);
  return m?.[1] ?? null;
}

/** Deletes every image under a folder prefix (used when an account is deleted). Never throws. */
export async function destroyByPrefix(prefix: string) {
  if (!isCloudinaryConfigured) return;
  try {
    await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'image', invalidate: true });
  } catch (error) {
    console.error('[cloudinary] prefix delete failed:', prefix, (error as Error).message);
  }
}
