import { useEffect, useState } from 'react'
import { useLanguage } from './LanguageProvider'

export function FileDownload({ name, blob }: { name: string; blob: Blob }) {
  const { t } = useLanguage()
  const [download, setDownload] = useState<{ blob: Blob; url: string } | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(blob)
    setDownload({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])

  if (download?.blob !== blob) return null
  return <a href={download.url} download={name}>{t({ key: 'download', values: { name } })}</a>
}
