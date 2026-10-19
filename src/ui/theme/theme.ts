import { createContext, useContext } from 'react'
import { DEFAULT_THEME, type Theme } from './themes.js'
import { DEFAULT_LOOK, type Look } from './look.js'

export const ThemeContext = createContext<Theme>(DEFAULT_THEME)
export const LookContext = createContext<Look>(DEFAULT_LOOK)

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

export function useLook(): Look {
  return useContext(LookContext)
}
