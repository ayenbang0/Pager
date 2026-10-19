/**
 * Rows the UI draws. Windows consoles clear the whole screen on every frame that fills the viewport,
 * so the last row stays empty there.
 */
export const frameRows = (rows: number, platform: NodeJS.Platform = process.platform): number => (platform === 'win32' ? rows - 1 : rows)
