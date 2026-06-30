import type { Lang } from '../../types'

export default function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="lang-toggle">
      <button className={`lang-btn${lang === 'en' ? ' lang-active' : ''}`} onClick={() => setLang('en')}>EN</button>
      <button className={`lang-btn${lang === 'th' ? ' lang-active' : ''}`} onClick={() => setLang('th')}>ไทย</button>
    </div>
  )
}
