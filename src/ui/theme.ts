import { createContext, useContext } from 'react'
import { DEFAULT_THEME, type Theme } from '../themes.js'

export const ThemeContext = createContext<Theme>(DEFAULT_THEME)

export function useTheme(): Theme {
  return useContext(ThemeContext)
}
