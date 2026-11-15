import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { translate } from './i18n'
import type { Language, Message } from './i18n'

const storageKey = 'localdrop.language'

const LanguageContext = createContext<{
  language: Language
  setLanguage: (language: Language) => void
  t: (message: Message) => string
} | null>(null)

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved === 'ja' || saved === 'en') return saved
  } catch {
    // The browser can disable storage for this page.
  }
  return navigator.language.toLowerCase().split('-')[0] === 'ja' ? 'ja' : 'en'
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(initialLanguage)

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  function chooseLanguage(next: Language) {
    setLanguage(next)
    try {
      localStorage.setItem(storageKey, next)
    } catch {
      // The selection still works for the current page.
    }
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage: chooseLanguage, t: (message) => translate(language, message) }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) throw new Error('LanguageProvider is missing.')
  return context
}
