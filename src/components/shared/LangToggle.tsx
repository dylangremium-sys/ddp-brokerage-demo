import type { Lang } from '../../types'

export default function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    // aria-pressed, because which language is selected was conveyed only by a
    // CSS class — invisible to a screen reader, which would announce two
    // identical buttons with no way to tell which one is in effect.
    <div className="lang-toggle" role="group" aria-label="Language">
      <button type="button" aria-pressed={lang === 'en'} className={`lang-btn${lang === 'en' ? ' lang-active' : ''}`} onClick={() => setLang('en')}>EN</button>
      <button type="button" aria-pressed={lang === 'th'} className={`lang-btn${lang === 'th' ? ' lang-active' : ''}`} onClick={() => setLang('th')}>ไทย</button>
    </div>
  )
}
