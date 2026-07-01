import type { Context } from "telegraf";

export function getTelegramUserId(ctx: Context): string | null {
  const id = ctx.from?.id;

  if (!id) {
    return null;
  }

  return String(id);
}

export function isAdmin(ctx: Context): boolean {
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  if (!adminId) {
    return true;
  }

  const userId = getTelegramUserId(ctx);

  return userId === adminId;
}

export async function requireAdmin(ctx: Context): Promise<boolean> {
  if (isAdmin(ctx)) {
    return true;
  }

  await ctx.reply("❌ You are not authorized to use this bot.");
  return false;
}
