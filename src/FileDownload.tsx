import { useEffect, useState } from 'react'

export function FileDownload({ name, blob }: { name: string; blob: Blob }) {
  const [download, setDownload] = useState<{ blob: Blob; url: string } | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(blob)
    setDownload({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])

  if (download?.blob !== blob) return null
  return <a href={download.url} download={name}>Download {name}</a>
}
