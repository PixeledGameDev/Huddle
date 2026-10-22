import { createContext, useContext } from "react";

export interface ServerAssets { emojis: { id: string; name: string }[]; stickers: { id: string; name: string }[] }
/** The current server's custom emoji and stickers, so the picker, composer and messages can all reach them. */
export const ServerAssetsContext = createContext<ServerAssets>({ emojis: [], stickers: [] });
export const useServerAssets = () => useContext(ServerAssetsContext);
