import { useEffect, useState } from 'react'
import type { Engine } from '../../app/engine.js'

/** Re-renders on every engine 'change'; returns a version counter. */
export function useEngine(engine: Engine): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = (): void => setVersion((v) => v + 1)
    engine.on('change', bump)
    return () => {
      engine.off('change', bump)
    }
  }, [engine])
  return version
}
