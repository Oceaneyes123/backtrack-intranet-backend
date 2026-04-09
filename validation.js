import { z } from "zod";
import config from "./config.js";

// --- Schemas ---

export const sendMessageSchema = z.object({
  body: z.string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Message body required.").max(config.MAX_MESSAGE_LENGTH, `Message too long (max ${config.MAX_MESSAGE_LENGTH} characters).`)),
  clientMessageId: z.string().uuid().optional().nullable()
});

export const editMessageSchema = z.object({
  body: z.string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Message body required.").max(config.MAX_MESSAGE_LENGTH, `Message too long (max ${config.MAX_MESSAGE_LENGTH} characters).`))
});

export const createDirectSchema = z.object({
  email: z.string().email("Invalid email address.").transform((e) => e.trim().toLowerCase())
});

export const createGroupSchema = z.object({
  name: z.string().transform((s) => s.trim()).pipe(z.string().min(1, "Group name required.").max(100, "Group name too long (max 100 characters).")),
  members: z
    .array(z.string().email("Invalid member email.").transform((e) => e.trim().toLowerCase()))
    .transform((arr) => [...new Set(arr)])
    .pipe(z.array(z.string()).min(2, "At least two unique member emails required."))
});

// --- Middleware helper ---

export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const firstError = result.error.issues[0]?.message || "Validation failed.";
    res.status(400).json({ error: firstError, details: result.error.issues });
    return;
  }
  req.validated = result.data;
  next();
};
