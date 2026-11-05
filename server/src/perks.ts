import { one } from "./db";

/**
 * Perks that come with a server's badge. Verified servers get VERIFIED_PERKS, and Huddle Official servers get everything
 * Verified does (OFFICIAL_PERKS starts as a copy, so anything added to Verified reaches Official automatically).
 * To change a perk, change a number here: the server enforces it and the app reads it from the server's details.
 */
export interface Perks {
  emojis: number; // custom emojis
  stickers: number; // custom stickers
  channels: number;
  roles: number;
  storageMb: number; // total space for uploaded files
  reactions: number; // different reactions on one message
}

const BASE_STORAGE_MB = Number(process.env.SERVER_STORAGE_MB ?? 250);

export const BASE_PERKS: Perks = { emojis: 50, stickers: 20, channels: 50, roles: 25, storageMb: BASE_STORAGE_MB, reactions: 20 };
export const VERIFIED_PERKS: Perks = { emojis: 150, stickers: 60, channels: 100, roles: 50, storageMb: BASE_STORAGE_MB * 4, reactions: 40 };
export const OFFICIAL_PERKS: Perks = { ...VERIFIED_PERKS };

export function perksOf(s: { verified?: boolean | null; official?: boolean | null }): Perks {
  return s.official ? OFFICIAL_PERKS : s.verified ? VERIFIED_PERKS : BASE_PERKS;
}

export async function serverPerks(serverId: string, c?: any): Promise<Perks> {
  const s = await one<{ verified: boolean; official: boolean }>(`select verified, official from servers where id = $1`, [serverId], c);
  return perksOf(s ?? {});
}
