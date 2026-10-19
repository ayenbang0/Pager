/** The app-wide chords a full-screen panel forwards: the app owns what they do. */
export interface Chords {
  onPalette(): void
  onSidebar(): void
  onSwitch(direction: 1 | -1): void
  onHelp(): void
  onQuit(): void
}
