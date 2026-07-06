import type { Context } from "telegraf";
import {
  getBetaAccessUser,
  hasActiveBetaAccess,
  isPrivateBetaEnabled
} from "./accessControl.js";

export function getTelegramUserId(ctx: Context): string | null {
  const id = ctx.from?.id;

  if (!id) return null;

  return String(id);
}

export function isOwner(ctx: Context): boolean {
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  if (!adminId) return false;

  const userId = getTelegramUserId(ctx);

  return userId === adminId;
}

export function isAdmin(ctx: Context): boolean {
  return isOwner(ctx);
}

export async function isAuthorizedBotUser(ctx: Context): Promise<boolean> {
  if (isOwner(ctx)) return true;

  if (!isPrivateBetaEnabled()) return false;

  const userId = getTelegramUserId(ctx);

  return Boolean(userId && (await hasActiveBetaAccess(userId)));
}

export async function requireOwner(ctx: Context): Promise<boolean> {
  if (!process.env.ADMIN_TELEGRAM_ID) {
    await ctx.reply(
      "❌ ADMIN_TELEGRAM_ID is not set. Run /whoami in Telegram, then add that ID to your .env."
    );
    return false;
  }

  if (isOwner(ctx)) return true;

  await ctx.reply("❌ Owner-only command.");
  return false;
}

export async function requireAdmin(ctx: Context): Promise<boolean> {
  if (!process.env.ADMIN_TELEGRAM_ID) {
    await ctx.reply(
      "❌ ADMIN_TELEGRAM_ID is not set. Run /whoami in Telegram, then add that ID to your .env before using sensitive commands."
    );
    return false;
  }

  if (await isAuthorizedBotUser(ctx)) return true;

  const userId = getTelegramUserId(ctx);
  const user = userId ? await getBetaAccessUser(userId) : null;

  if (isPrivateBetaEnabled()) {
    if (user?.status === "revoked") {
      await ctx.reply("❌ Your Fibre access has been revoked.");
      return false;
    }

    await ctx.reply(
      `🔒 Fibre is locked.

Use /start to subscribe or redeem an access code.

Your Telegram ID:
${userId || "unknown"}`
    );
    return false;
  }

  await ctx.reply("❌ You are not authorized to use this bot.");
  return false;
}
