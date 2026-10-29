/**
 * Upload / input limits — single source of truth shared by client guards (for
 * instant feedback) and server routes (authoritative). Kept under Vercel's
 * ~4.5 MB serverless request-body cap so oversize uploads fail with a clear
 * message instead of an opaque platform error.
 */
export const MAX_CSV_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAX_CSV_ROWS = 10_000;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_CHAT_MESSAGES = 40;
export const MAX_CHAT_CONTEXT_CHARS = 20_000;
export const MAX_CHAT_BODY_BYTES = 256 * 1024;

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Human-readable size, e.g. 4194304 -> "4 MB". */
export const formatBytes = (n: number): string => `${Math.round(n / 1024 / 1024)} MB`;
