import { useEffect } from 'react'

export function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    const wakeLock = navigator.wakeLock
    if (!active || !wakeLock) return

    let lock: WakeLockSentinel | undefined
    let stopped = false
    let requesting = false
    let retryWhenVisible = false

    async function acquire() {
      if (stopped || document.visibilityState !== 'visible' || lock?.released === false) return

      requesting = true
      try {
        const acquired = await wakeLock.request('screen')
        if (stopped || document.visibilityState !== 'visible') await acquired.release()
        else lock = acquired
      } catch {
        // Power settings or browser permissions can deny the lock. Transfer can continue.
      } finally {
        requesting = false
        if (retryWhenVisible) {
          retryWhenVisible = false
          void acquire()
        }
      }
    }

    function onVisibilityChange() {
      // The browser releases the lock when the page is hidden.
      if (document.visibilityState !== 'visible') return
      if (requesting) retryWhenVisible = true
      else void acquire()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    void acquire()

    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (lock && !lock.released) void lock.release().catch(() => {})
    }
  }, [active])
}
